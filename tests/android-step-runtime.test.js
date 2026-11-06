'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const history = require('../VCPDistributedServer/Plugin/AndroidController/lib/action-history');
const result = (details = {}) => ({ details, content: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('hard deadline returns while an uncancellable dependency hangs, keeping its device leased until drained', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let cancelled = false;
    const client = { withContext(options, fn) { options.signal.addEventListener('abort', () => { cancelled = true; }, { once: true }); return fn(); } };
    // Allow setup under full-suite contention; the gate still outlives the hard deadline.
    const work = runtime.run({ serial: 'hard-budget', timeoutMs: 250, client }, async () => { await gate; runtime.check(); return { details: {} }; });
    let watchdog;
    const bounded = await Promise.race([work.then(() => 'success', error => error),
        new Promise(resolve => { watchdog = setTimeout(() => resolve('not-bounded'), 2000); })]);
    clearTimeout(watchdog);
    try {
        assert.equal(bounded.code, 'STEP_DEADLINE');
        assert.equal(cancelled, true);
        await assert.rejects(runtime.run({ serial: 'hard-budget' }, async () => ({ details: {} })), (error) => error.code === 'DEVICE_BUSY');
    } finally { release(); }
    await sleep(0);
    const recovered = await runtime.run({ serial: 'hard-budget' }, async () => ({ details: {} }));
    assert.equal(recovered.details.execution.outcome, 'dispatched');
});

test('trusted cancellation aborts an active pause promptly and releases its lease', async () => {
    const controller = new AbortController();
    const work = runtime.run({ serial: 'cancel-budget', timeoutMs: 1000, signal: controller.signal }, async () => { await runtime.pause(500); return { details: {} }; });
    controller.abort();
    await assert.rejects(work, (error) => error.code === 'STEP_ABORTED');
    await sleep(0);
    await runtime.run({ serial: 'cancel-budget' }, async () => ({ details: {} }));
});



test('a management transaction blocks new steps until drained and permits nested management', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const management = runtime.runManagement(async () => {
        await runtime.runManagement(async () => {});
        entered();
        await gate;
    });
    await ready;
    try {
        await assert.rejects(runtime.run({ serial: 'management' }, async () => ({ details: {} })), (error) => error.code === 'DEVICE_BUSY');
        await assert.rejects(runtime.runManagement(async () => {}), (error) => error.code === 'DEVICE_BUSY');
    } finally { release(); }
    await management;
    await runtime.run({ serial: 'management' }, async () => ({ details: {} }));
});


test('owned execution rejects missing, wrong, switched and expired owners without acquiring a lease', async () => {
    await assert.rejects(runtime.runOwned({ serial: 'owned-validation' }, async () => result()), { code: 'INVALID_ARGUMENT' });
    let late;
    await runtime.run({ serial: 'owned-validation' }, async () => {
        await assert.rejects(runtime.runOwned({ serial: 'owned-other' }, async () => result()), { code: 'INVALID_ARGUMENT' });
        runtime.bindDevice('owned-active');
        await assert.rejects(runtime.runOwned({ serial: 'owned-validation' }, async () => result()), { code: 'INVALID_ARGUMENT' });
        await runtime.runOwned({ serial: 'owned-active' }, async () => {
            assert.throws(() => runtime.bindDevice('owned-other'), { code: 'INVALID_ARGUMENT' });
            return result();
        });
        const gate = deferred();
        late = { release: gate.resolve, work: gate.promise.then(() => runtime.runOwned({ serial: 'owned-active' }, async () => result())) };
        return result();
    });
    late.release();
    await assert.rejects(late.work, { code: 'INVALID_ARGUMENT' });
    await runtime.run({ serial: 'owned-other' }, async () => result());
});

test('owned actions isolate IDs, timing, verification, dispatch, attempts and sequence history', async () => {
    const serial = 'owned-receipts';
    const children = [];
    let outerId;
    let outerSignal;
    let contextCalls = 0;
    const client = { withContext(options, task) { contextCalls++; outerSignal = options.signal; return task(); } };
    const outer = await runtime.run({ serial, client, outcome: 'observed' }, async () => {
        outerId = runtime.requestId();
        runtime.inputReceipt({ parentOnly: true });
        children.push(await runtime.runOwned({ serial, actionCommand: 'Tap' }, async () => {
            assert.notEqual(runtime.requestId(), outerId);
            assert.equal(runtime.executionSignal(), outerSignal);
            const attempts = [{ channel: 'rpc', method: 'click', status: 'dispatched' }];
            runtime.inputReceipt({ attempts });
            runtime.markDispatched();
            await runtime.stage('actionMs', () => runtime.pause(5));
            runtime.verified(true, { marker: 'first' });
            return result({ attempts });
        }));
        assert.equal(runtime.requestId(), outerId);
        assert.deepEqual(runtime.dispatchState(), { dispatched: true, itemDispatched: false });
        children.push(await runtime.runOwned({ serial, actionCommand: 'Wait', outcome: 'observed' }, async () => {
            assert.deepEqual(runtime.dispatchState(), { dispatched: false, itemDispatched: false });
            return result();
        }));
        children.push(await runtime.runOwned({ serial }, async () => {
            runtime.beginSequence(2);
            runtime.beginItem('Fill');
            runtime.markDispatched(); runtime.verified(true, {}); runtime.finishItem(true);
            runtime.beginItem('KeyEvent');
            runtime.markDispatched(); runtime.finishItem();
            return result();
        }));
        return result();
    });
    assert.equal(contextCalls, 1, 'children must keep the original client context');
    const [first, second, sequence] = children.map(child => child.details.execution);
    assert.equal(new Set([outerId, first.requestId, second.requestId, sequence.requestId]).size, 4);
    assert.equal(first.outcome, 'verified');
    assert.equal(second.outcome, 'observed');
    assert.equal(second.verification, null);
    assert.equal(second.timings.actionMs, 0);
    assert.ok(first.timings.actionMs > 0);
    assert.equal(outer.details.execution.timings.actionMs, 0);
    assert.equal(outer.details.execution.verification, null);
    assert.equal(outer.details.execution.outcome, 'dispatched');
    assert.equal(sequence.sequence.steps.length, 2);
    for (const child of children) {
        assert.deepEqual(JSON.parse(child.content.at(-1).text).execution, child.details.execution);
        assert.equal(child.details.parentOnly, undefined);
    }
    const rows = history.query({ serial }).entries.reverse();
    assert.deepEqual(rows.map(row => row.command), ['tap', 'wait', 'fill', 'keyevent']);
    assert.deepEqual(rows.map(row => row.requestId), [first.requestId, second.requestId, sequence.requestId, sequence.requestId]);
    assert.equal(rows[0].method, 'click');
    assert.equal(rows[1].method, undefined);
});

test('owned scopes serialize siblings and recursion while the outer lease survives child failure and waits', async () => {
    const serial = 'owned-competition';
    const childReady = deferred(), childGate = deferred(), waiting = deferred(), finish = deferred();
    const outer = runtime.run({ serial }, async () => {
        const child = runtime.runOwned({ serial, actionCommand: 'Tap' }, async () => {
            await assert.rejects(runtime.runOwned({ serial }, async () => result()), { code: 'DEVICE_BUSY' });
            childReady.resolve(); await childGate.promise;
            throw runtime.failure('INPUT_FAILED', 'test failure');
        });
        await childReady.promise;
        await assert.rejects(runtime.runOwned({ serial }, async () => result()), { code: 'DEVICE_BUSY' });
        childGate.resolve();
        await assert.rejects(child, error => error.code === 'INPUT_FAILED' && error.execution.outcome === 'failed');
        await runtime.runOwned({ serial, actionCommand: 'Wait' }, async () => result());
        waiting.resolve(); await finish.promise;
        return result();
    });
    await childReady.promise;
    await assert.rejects(runtime.run({ serial }, async () => result()), { code: 'DEVICE_BUSY' });
    await assert.rejects(runtime.runManagement(async () => {}), { code: 'DEVICE_BUSY' });
    await waiting.promise;
    try {
        await assert.rejects(runtime.run({ serial }, async () => result()), { code: 'DEVICE_BUSY' });
    } finally { finish.resolve(); childGate.resolve(); }
    await outer;
    await runtime.run({ serial }, async () => result());
});

for (const mode of ['abort', 'deadline']) test(`owned ${mode} returns unknown receipts promptly but retains the lease until dependency drain`, async () => {
    const serial = `owned-drain-${mode}`;
    const ready = deferred(), gate = deferred(), childSettled = deferred();
    const controller = new AbortController();
    let childError, outerError;
    const outer = runtime.run({ serial, signal: controller.signal, timeoutMs: mode === 'deadline' ? 100 : 1000 }, async () => {
        try {
            await runtime.runOwned({ serial, actionCommand: 'Tap' }, async () => {
                runtime.markDispatched();
                runtime.inputReceipt({ attempts: [{ channel: 'rpc', method: 'click', status: 'unknown' }] });
                ready.resolve(); await gate.promise;
                return result();
            });
        } catch (error) { childError = error; childSettled.resolve(); }
        return result();
    });
    const rejected = assert.rejects(outer, error => {
        outerError = error;
        assert.equal(error.code, mode === 'deadline' ? 'STEP_DEADLINE' : 'STEP_ABORTED');
        assert.equal(error.execution.outcome, 'unknown');
        return true;
    });
    await ready.promise;
    if (mode === 'abort') controller.abort();
    await rejected;
    await childSettled.promise;
    try {
        assert.equal(childError.code, mode === 'deadline' ? 'STEP_DEADLINE' : 'STEP_ABORTED');
        assert.equal(childError.execution.outcome, 'unknown');
        assert.notEqual(childError.execution.requestId, outerError.execution.requestId);
        assert.notEqual(childError, outerError);
        assert.equal(childError.details.attempts[0].method, 'click');
        const snapshot = history.query({ serial }).entries;
        assert.equal(snapshot.length, 1);
        assert.equal(snapshot[0].outcome, 'unknown');
        await assert.rejects(runtime.run({ serial }, async () => result()), { code: 'DEVICE_BUSY' });
        gate.resolve(); await tick();
        assert.deepEqual(history.query({ serial }).entries, snapshot);
    } finally { gate.resolve(); }
    await tick();
    await runtime.run({ serial }, async () => result());
});

test('owned actions consume the original total deadline without resetting it', async () => {
    const serial = 'owned-total-budget';
    let secondBudget;
    const outer = runtime.run({ serial, timeoutMs: 150 }, async () => {
        await runtime.runOwned({ serial, actionCommand: 'Wait' }, async () => { await runtime.pause(90); return result(); });
        return runtime.runOwned({ serial, actionCommand: 'Wait' }, async () => {
            secondBudget = runtime.remainingTaskMs();
            await runtime.pause(1000);
            return result();
        });
    });
    await assert.rejects(outer, { code: 'STEP_DEADLINE' });
    assert.ok(secondBudget > 0 && secondBudget < 100, `remaining budget was ${secondBudget}`);
    await tick();
});

test('owned unknown is sticky across caught failures and later parent verification', async () => {
    for (const failParent of [false, true]) {
        const serial = `owned-unknown-${failParent}`;
        const work = runtime.run({ serial, actionCommand: 'Wait' }, async () => {
            await assert.rejects(runtime.runOwned({ serial, actionCommand: 'Tap' }, async () => {
                runtime.verified(false, { matched: false });
                throw runtime.failure('INPUT_FAILED', 'unconfirmed');
            }), error => error.execution.outcome === 'unknown');
            await runtime.runOwned({ serial, actionCommand: 'Wait' }, async () => result());
            runtime.verified(true, {});
            if (failParent) throw runtime.failure('INPUT_FAILED', 'later failure');
            return result();
        });
        if (failParent) await assert.rejects(work, error => error.execution.outcome === 'unknown');
        else assert.equal((await work).details.execution.outcome, 'unknown');
    }
});

test('owned dispatch survives later unstarted child failure without leaking attempts or verification', async () => {
    const serial = 'owned-dispatch-memory';
    let firstId;
    await assert.rejects(runtime.run({ serial }, async () => {
        const first = await runtime.runOwned({ serial, actionCommand: 'Tap' }, async () => {
            runtime.markDispatched(); runtime.verified(true, {});
            return result();
        });
        firstId = first.details.execution.requestId;
        await assert.rejects(runtime.runOwned({ serial, actionCommand: 'Fill' }, async () => {
            throw runtime.failure('INVALID_ARGUMENT', 'invalid');
        }), error => {
            assert.notEqual(error.execution.requestId, firstId);
            assert.equal(error.execution.outcome, 'failed');
            assert.equal(error.execution.verification, null);
            assert.equal(error.details, undefined);
            return true;
        });
        throw runtime.failure('INPUT_FAILED', 'parent failure');
    }), error => error.execution.outcome === 'unknown');
    assert.deepEqual(history.query({ serial }).entries.map(row => row.outcome), ['failed', 'verified']);
});

test('owned proven not-dispatched rollback does not contaminate the parent outcome', async () => {
    const serial = 'owned-rollback';
    await assert.rejects(runtime.run({ serial }, async () => {
        await assert.rejects(runtime.runOwned({ serial }, async () => {
            const saved = runtime.dispatchState();
            runtime.markDispatched(); runtime.restoreDispatch(saved);
            throw runtime.failure('INPUT_FAILED', 'not dispatched');
        }), error => error.execution.outcome === 'failed');
        throw runtime.failure('INPUT_FAILED', 'parent failure');
    }), error => error.execution.outcome === 'failed');
});


test('outer completion waits for an unawaited owned operation before releasing the device', async () => {
    const serial = 'owned-unawaited';
    const entered = deferred(), gate = deferred();
    let child;
    let settled = false;
    const outer = runtime.run({ serial }, async () => {
        child = runtime.runOwned({ serial, actionCommand: 'Tap' }, async () => {
            entered.resolve(); await gate.promise;
            runtime.markDispatched();
            return result();
        });
        return result();
    }).then(value => { settled = true; return value; });
    await entered.promise; await tick();
    try {
        assert.equal(settled, false);
        await assert.rejects(runtime.run({ serial }, async () => result()), { code: 'DEVICE_BUSY' });
    } finally { gate.resolve(); }
    await child;
    assert.equal((await outer).details.execution.outcome, 'dispatched');
    await runtime.run({ serial }, async () => result());
});

test('successful but unverified owned action keeps the parent unknown', async () => {
    const serial = 'owned-unverified';
    const outer = await runtime.run({ serial, outcome: 'observed' }, async () => {
        const child = await runtime.runOwned({ serial, actionCommand: 'Wait' }, async () => {
            runtime.verified(false, {});
            return result();
        });
        assert.equal(child.details.execution.outcome, 'unknown');
        return result();
    });
    assert.equal(outer.details.execution.outcome, 'unknown');
});