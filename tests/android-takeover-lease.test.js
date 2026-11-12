'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
const history = require('../VCPDistributedServer/Plugin/AndroidController/lib/action-history');
const result = () => ({ details: {}, content: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const rejection = promise => promise.then(() => assert.fail('expected rejection'), error => error);
const busy = promise => assert.rejects(promise, { code: 'DEVICE_BUSY' });

async function assertGlobalGate() {
    await busy(runtime.run({ serial: 'A' }, async () => result()));
    await busy(runtime.run({ serial: 'other-usb-or-wifi-alias' }, async () => result()));
    await busy(runtime.run({ serial: '__auto__' }, async () => result()));
    await busy(runtime.runManagement(async () => assert.fail('management entered')));
    assert.throws(() => runtime.assertManagementIdle(), { code: 'DEVICE_BUSY' });
    assert.throws(() => runtime.assertTakeoverIdle(), { code: 'DEVICE_BUSY' });
    assert.throws(() => runtime.bindDevice('other'), { code: 'DEVICE_BUSY' });
}

test('takeover accepts only an explicit safe serial and refuses active management without cancelling it', async () => {
    for (const serial of ['', '__auto__', ' A', 'A\n', '-s', 'A;input tap', null, {}, 'A'.repeat(161)]) {
        await assert.rejects(runtime.acquireTakeover({ serial }), { code: 'INVALID_ARGUMENT' });
    }
    for (const timeoutMs of [0, -1, Infinity, NaN]) {
        await assert.rejects(runtime.acquireTakeover({ serial: 'A', timeoutMs }), { code: 'INVALID_ARGUMENT' });
    }
    const gate = deferred();
    const management = runtime.runManagement(async () => {
        await runtime.runManagement(async () => {});
        await gate.promise;
    });
    try {
        await busy(runtime.acquireTakeover({ serial: 'A' }));
        assert.equal(runtime.takeoverStatus().phase, 'idle');
        await busy(runtime.run({ serial: 'A' }, async () => result()));
    } finally { gate.resolve(); await management; }
});

test('acquire reserves its global gate synchronously, cancels every run and waits for actual settle', async () => {
    const a = deferred(), b = deferred();
    let cancelled = 0, executions = 0;
    const start = (serial, gate) => rejection(runtime.run({ serial }, async () => {
        executions++;
        runtime.executionSignal().addEventListener('abort', () => {
            cancelled++;
            assert.equal(runtime.takeoverStatus().phase, 'acquiring');
            assert.throws(() => runtime.bindDevice('alias'), { code: 'DEVICE_BUSY' });
        }, { once: true });
        await gate.promise;
        return result();
    }));
    const first = start('__auto__', a), second = start('different-device', b);
    let acquired = false;
    const acquisition = runtime.acquireTakeover({ serial: 'A' }).then(handle => { acquired = true; return handle; });
    assert.equal(runtime.takeoverStatus().phase, 'acquiring');
    assert.equal(cancelled, 2);
    try {
        assert.equal((await first).code, 'STEP_ABORTED');
        assert.equal((await second).code, 'STEP_ABORTED');
        await assertGlobalGate();
        a.resolve(); await tick();
        assert.equal(acquired, false, 'a cancellation receipt is not an operation drain');
        b.resolve();
        const handle = await acquisition;
        await assertGlobalGate();
        await runtime.releaseTakeover(handle);
        assert.equal(executions, 2, 'release must not resume cancelled work');
        await tick();
        assert.equal(executions, 2);
        await runtime.run({ serial: 'A' }, async () => result());
    } finally { a.resolve(); b.resolve(); await runtime.releaseTakeover(await acquisition); }
});

test('M5 parent cancellation drains both the uncooperative parent and its owned operation', async () => {
    const childGate = deferred(), parentGate = deferred(), childStarted = deferred(), childCancelled = deferred();
    let childError;
    const parent = rejection(runtime.run({ serial: '__auto__', actionCommand: 'RunTask' }, async () => {
        runtime.bindDevice('A');
        try {
            await runtime.runOwned({ serial: 'A', actionCommand: 'Wait', outcome: 'observed' }, async () => {
                childStarted.resolve(); await childGate.promise; return result();
            });
        } catch (error) { childError = error; childCancelled.resolve(); }
        await parentGate.promise;
        return result();
    }));
    await childStarted.promise;
    let granted = false;
    const acquisition = runtime.acquireTakeover({ serial: 'A' }).then(handle => { granted = true; return handle; });
    try {
        assert.equal((await parent).code, 'STEP_ABORTED');
        await childCancelled.promise;
        assert.equal(childError.execution.outcome, 'failed', 'no input was dispatched');
        parentGate.resolve(); await tick();
        assert.equal(granted, false, 'parent task return cannot release an owned dependency');
        await assertGlobalGate();
        childGate.resolve();
        const handle = await acquisition;
        assert.equal(runtime.takeoverStatus().inFlight, 0);
        await runtime.releaseTakeover(handle);
    } finally { childGate.resolve(); parentGate.resolve(); await runtime.releaseTakeover(await acquisition); }
});

test('acquire also drains a run whose deadline receipt already returned before acquisition', async () => {
    const gate = deferred();
    const work = runtime.run({ serial: 'expired-run', timeoutMs: 25 }, async () => { await gate.promise; return result(); });
    await assert.rejects(work, { code: 'STEP_DEADLINE' });
    let granted = false;
    const acquisition = runtime.acquireTakeover({ serial: 'A' }).then(handle => { granted = true; return handle; });
    try {
        await tick();
        assert.equal(granted, false);
        assert.equal(runtime.takeoverStatus().inFlight, 1);
        await assertGlobalGate();
    } finally { gate.resolve(); await runtime.releaseTakeover(await acquisition); }
});

test('timed-out acquisition exposes a private drain fence that settles only after the actual operation', async () => {
    const gate = deferred();
    const work = rejection(runtime.run({ serial: 'private-drain' }, async () => { await gate.promise; return result(); }));
    const error = await rejection(runtime.acquireTakeover({ serial: 'private-drain', timeoutMs: 25 }));
    let drained = false;
    try {
        assert.equal(error.code, 'TAKEOVER_TIMEOUT');
        assert.ok(error.takeoverDrain instanceof Promise);
        error.takeoverDrain.then(() => { drained = true; });
        assert.equal((await work).code, 'STEP_ABORTED');
        await tick();
        assert.equal(drained, false, 'session cleanup must not use the already returned cancellation receipt');
        assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(error)), 'takeoverDrain'), false);
        assert.equal(Object.hasOwn(runtime.takeoverStatus(), 'takeoverDrain'), false);
        await assertGlobalGate();
    } finally { gate.resolve(); await error.takeoverDrain; }
    assert.equal(drained, true);
    assert.equal(runtime.takeoverStatus().phase, 'idle');
});

for (const mode of ['timeout', 'abort']) test(`acquisition ${mode} rejects promptly but leaves the global gate until all real work drains`, async () => {
    const gate = deferred();
    const work = rejection(runtime.run({ serial: 'A' }, async () => { await gate.promise; return result(); }));
    const controller = new AbortController();
    const pending = rejection(runtime.acquireTakeover({ serial: 'A', signal: controller.signal, timeoutMs: mode === 'timeout' ? 25 : 1000 }));
    if (mode === 'abort') controller.abort();
    try {
        assert.equal((await pending).code, mode === 'timeout' ? 'TAKEOVER_TIMEOUT' : 'TAKEOVER_ABORTED');
        assert.equal((await work).code, 'STEP_ABORTED');
        assert.equal(runtime.takeoverStatus().phase, 'draining');
        await assertGlobalGate();
        await busy(runtime.acquireTakeover({ serial: 'B' }));
    } finally { gate.resolve(); await tick(); }
    assert.equal(runtime.takeoverStatus().phase, 'idle');
    const handle = await runtime.acquireTakeover({ serial: 'B' });
    await runtime.releaseTakeover(handle);
});

for (const mode of ['dispatched', 'owned-dispatched', 'handoff-unknown', 'late-dispatched']) test(`cancelled ${mode} cannot be granted a human lease even after actual drain`, async () => {
    const gate = deferred();
    const work = rejection(runtime.run({ serial: 'A' }, async () => {
        const action = async () => {
            if (mode.includes('dispatched') && mode !== 'late-dispatched') runtime.markDispatched();
            if (mode === 'handoff-unknown') runtime.verified(false, { condition: { type: 'humanResume' } });
            await gate.promise;
            if (mode === 'late-dispatched') runtime.markDispatched();
            return result();
        };
        return mode === 'owned-dispatched' ? runtime.runOwned({ serial: 'A' }, action) : action();
    }));
    const acquisition = rejection(runtime.acquireTakeover({ serial: 'A' }));
    try {
        await work;
        await assertGlobalGate();
        gate.resolve();
        assert.equal((await acquisition).code, 'DEVICE_STATE_UNCERTAIN');
        await tick();
        assert.equal(runtime.takeoverStatus().phase, 'idle');
    } finally { gate.resolve(); await acquisition; await tick(); }
});

test('global cancellation reports every unknown device once, including an auto-selected owned binding', async () => {
    const gate = deferred();
    const first = rejection(runtime.run({ serial: 'A' }, async () => {
        runtime.bindDevice('A');
        runtime.markDispatched();
        await gate.promise;
        return result();
    }));
    const second = rejection(runtime.run({ serial: '__auto__' }, async () => {
        runtime.bindDevice('B');
        return runtime.runOwned({ serial: 'B' }, async () => {
            runtime.markDispatched();
            await gate.promise;
            return result();
        });
    }));
    const acquisition = rejection(runtime.acquireTakeover({ serial: 'A' }));
    try {
        await first; await second;
        assert.equal(runtime.takeoverStatus().uncertainSerials, undefined, 'error metadata is not a status credential');
        await assertGlobalGate();
        gate.resolve();
        const error = await acquisition;
        assert.equal(error.code, 'DEVICE_STATE_UNCERTAIN');
        assert.deepEqual([...error.uncertainSerials].sort(), ['A', 'B']);
        assert.equal(Object.isFrozen(error.uncertainSerials), true);
        assert.equal(error.uncertainSerials.includes('__auto__'), false);
    } finally { gate.resolve(); await acquisition; await tick(); }
});

test('opaque identity rejects double takeover, forged handles and serial changes; management cannot bypass from inside human context', async () => {
    const handle = await runtime.acquireTakeover({ serial: '192.168.1.2:5555' });
    try {
        assert.equal(Object.isFrozen(handle), true);
        assert.deepEqual(Object.keys(handle), []);
        assert.throws(() => { handle.serial = 'B'; }, TypeError);
        assert.equal(Object.isFrozen(runtime.takeoverStatus()), true);
        assert.deepEqual(Object.keys(runtime.takeoverStatus()).sort(), ['active', 'inFlight', 'phase', 'serial']);
        await busy(runtime.acquireTakeover({ serial: 'B' }));
        for (const forged of [{}, { serial: '192.168.1.2:5555' }, { handle }, Object.create(handle), null, 'token']) {
            await assert.rejects(runtime.runTakeover(forged, {}, async () => result()), { code: 'INVALID_TAKEOVER_HANDLE' });
            await assert.rejects(runtime.releaseTakeover(forged), { code: 'INVALID_TAKEOVER_HANDLE' });
        }
        await assert.rejects(runtime.runTakeover(handle, { serial: 'B' }, async () => result()), { code: 'INVALID_ARGUMENT' });
        const response = await runtime.runTakeover(handle, { outcome: 'observed' }, async () => {
            runtime.bindDevice('192.168.1.2:5555');
            assert.equal(runtime.activeDevice(), '192.168.1.2:5555');
            assert.throws(() => runtime.bindDevice('B'), { code: 'INVALID_ARGUMENT' });
            assert.throws(() => runtime.assertManagementIdle(), { code: 'DEVICE_BUSY' });
            await busy(runtime.runManagement(async () => {}));
            await busy(runtime.run({ serial: '192.168.1.2:5555', handle }, async () => result()));
            return runtime.runOwned({ serial: '192.168.1.2:5555', outcome: 'observed' }, async () => result());
        });
        assert.equal(response.details.execution.serial, '192.168.1.2:5555');
        assert.equal(response.details.execution.outcome, 'observed');
    } finally { await runtime.releaseTakeover(handle); }
});

test('release cancels an in-flight human run despite its external signal, rejects new operations immediately and waits for drain', async () => {
    const handle = await runtime.acquireTakeover({ serial: 'human-release' });
    const gate = deferred(), controller = new AbortController();
    let operationSignal;
    const work = rejection(runtime.runTakeover(handle, { signal: controller.signal }, async () => {
        operationSignal = runtime.executionSignal();
        runtime.markDispatched();
        await gate.promise;
        return result();
    }));
    let released = false;
    const release = runtime.releaseTakeover(handle);
    release.then(() => { released = true; });
    try {
        assert.equal(runtime.releaseTakeover(handle), release, 'release is idempotent');
        assert.equal(operationSignal.aborted, true);
        assert.equal(controller.signal.aborted, false, 'caller signal is not mutated');
        const error = await work;
        assert.equal(error.code, 'STEP_ABORTED');
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(runtime.takeoverStatus().phase, 'releasing');
        await assert.rejects(runtime.runTakeover(handle, {}, async () => result()), { code: 'INVALID_TAKEOVER_HANDLE' });
        await assertGlobalGate();
        await tick(); assert.equal(released, false);
    } finally { gate.resolve(); await release; }
    const next = await runtime.acquireTakeover({ serial: 'next-human' });
    try {
        await runtime.releaseTakeover(handle);
        assert.equal(runtime.takeoverStatus().serial, 'next-human', 'old release must not affect a new session');
        await assert.rejects(runtime.runTakeover(handle, {}, async () => result()), { code: 'INVALID_TAKEOVER_HANDLE' });
        await runtime.runTakeover(next, {}, async () => result());
    } finally { await runtime.releaseTakeover(next); }
});

test('release waits for an unawaited human owned operation after the parent receipt has cancelled', async () => {
    const handle = await runtime.acquireTakeover({ serial: 'human-owned-release' });
    const gate = deferred();
    let child;
    const parent = rejection(runtime.runTakeover(handle, {}, async () => {
        child = rejection(runtime.runOwned({ serial: 'human-owned-release' }, async () => { await gate.promise; return result(); }));
        return result();
    }));
    const release = runtime.releaseTakeover(handle);
    let released = false;
    release.then(() => { released = true; });
    try {
        assert.equal((await parent).code, 'STEP_ABORTED');
        assert.equal((await child).code, 'STEP_ABORTED');
        await tick(); assert.equal(released, false);
        await assertGlobalGate();
    } finally { gate.resolve(); await release; }
});

test('acquisition signal owns the whole handle lifecycle, including already-aborted acquisition', async () => {
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(runtime.acquireTakeover({ serial: 'A', signal: stopped.signal }), { code: 'TAKEOVER_ABORTED' });
    await tick();
    const controller = new AbortController();
    const handle = await runtime.acquireTakeover({ serial: 'lifecycle', signal: controller.signal });
    const gate = deferred();
    const work = rejection(runtime.runTakeover(handle, {}, async () => { await gate.promise; return result(); }));
    controller.abort();
    try {
        assert.equal((await work).code, 'STEP_ABORTED');
        await assertGlobalGate();
        await assert.rejects(runtime.runTakeover(handle, {}, async () => result()), { code: 'INVALID_TAKEOVER_HANDLE' });
    } finally { gate.resolve(); await runtime.releaseTakeover(handle); }
    assert.equal(runtime.takeoverStatus().phase, 'idle');
});

test('runTakeover reuses client context, original total deadline, external cancellation, execution receipts and action history', async () => {
    const serial = 'human-budget';
    const handle = await runtime.acquireTakeover({ serial });
    let clientCalls = 0, childReceipt;
    const client = { withContext(options, task) {
        clientCalls++;
        assert.ok(options.deadlineMs > Date.now());
        assert.equal(options.signal.aborted, false);
        return task();
    } };
    try {
        const response = await runtime.runTakeover(handle, { client, outcome: 'observed', actionCommand: 'Wait', timeoutMs: 1000 }, async () => {
            childReceipt = await runtime.runOwned({ serial, actionCommand: 'Tap' }, async () => {
                runtime.markDispatched(); runtime.verified(true, { matched: true }); return result();
            });
            return result();
        });
        assert.equal(clientCalls, 1);
        assert.notEqual(response.details.execution.requestId, childReceipt.details.execution.requestId);
        assert.deepEqual(JSON.parse(response.content.at(-1).text).execution, response.details.execution);
        assert.deepEqual(history.query({ serial }).entries.map(entry => entry.command), ['wait', 'tap']);
        await assert.rejects(runtime.runTakeover(handle, { timeoutMs: 25 }, async () => {
            await runtime.runOwned({ serial }, async () => { await runtime.pause(1000); return result(); });
            return result();
        }), { code: 'STEP_DEADLINE' });
        await tick();
        const external = new AbortController();
        const work = rejection(runtime.runTakeover(handle, { signal: external.signal }, async () => {
            await runtime.pause(1000); return result();
        }));
        external.abort();
        assert.equal((await work).code, 'STEP_ABORTED');
        await tick();
        assert.equal(runtime.takeoverStatus().phase, 'active', 'one operation cancellation does not revoke the handle');
        await runtime.runTakeover(handle, { outcome: 'observed' }, async () => result());
    } finally { await runtime.releaseTakeover(handle); }
});

for (const mode of ['timeout', 'abort']) test(`${mode} acquisition quarantines late unknown work before unlocking`, async () => {
    const gate = deferred(), controller = new AbortController(), events = [];
    const task = rejection(runtime.run({ serial: 'unknown-device' }, async () => {
        runtime.markDispatched(); await gate.promise; return result();
    }));
    const pending = runtime.acquireTakeover({ serial: 'viewer-device', timeoutMs: 10, signal: controller.signal,
        onUncertain(serials) { events.push({ serials: [...serials], locked: runtime.takeoverStatus().active }); } });
    if (mode === 'abort') controller.abort();
    const error = await rejection(pending);
    assert.equal(error.code, mode === 'abort' ? 'TAKEOVER_ABORTED' : 'TAKEOVER_TIMEOUT');
    assert.deepEqual(events, []); assert.equal(runtime.takeoverStatus().active, true);
    gate.resolve(); await error.takeoverDrain; await task;
    assert.deepEqual(events, [{ serials: ['unknown-device'], locked: true }]);
    assert.equal(runtime.takeoverStatus().active, false);
});

test('release quarantines a cancelled dispatched human operation before its gate unlocks', async () => {
    const gate = deferred(), events = [];
    const handle = await runtime.acquireTakeover({ serial: 'A', onUncertain(serials) {
        events.push({ serials: [...serials], locked: runtime.takeoverStatus().active });
    } });
    const task = rejection(runtime.runTakeover(handle, {}, async () => {
        runtime.markDispatched(); await gate.promise; return result();
    }));
    const closing = runtime.releaseTakeover(handle);
    await task; assert.deepEqual(events, []);
    gate.resolve(); await closing;
    assert.deepEqual(events, [{ serials: ['A'], locked: true }]);
    assert.equal(runtime.takeoverStatus().active, false);
});
