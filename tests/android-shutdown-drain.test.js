'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('cleanup cancels discovery, drains it, and closes tool/display/management admission', async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness({ uiServer: { ok: true }, client: {
        async devices() { entered.resolve(); await gate.promise; return [{ serial: 'A', state: 'device' }]; },
    } });
    const work = h.service.processToolCall({ command: 'Observe', serial: 'A' }).catch(error => error);
    await entered.promise;
    let cleaned = false;
    const cleanup = h.service.cleanup().then(() => { cleaned = true; });
    try {
        await tick();
        assert.equal(cleaned, false, 'discovery must drain before cleanup completes');
        await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'B' }), { code: 'SERVICE_STOPPED' });
        await assert.rejects(h.service.ensureDisplayUrl(), { code: 'SERVICE_STOPPED' });
        await assert.rejects(h.api.disconnect({ address: 'A' }), { code: 'SERVICE_STOPPED' });
    } finally { gate.resolve(); await work; await cleanup; }
    assert.equal((await work).code, 'STEP_ABORTED');
    assert.equal(h.uiServer.started, 0);
    assert.equal(h.service._internals.lastObserve.size, 0);
    assert.equal(runtime.takeoverStatus().inFlight, 0);
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'SERVICE_STOPPED' });
    await h.service.initialize({ config: { DEVICE_SERIAL: 'A' }, logger: { log() {}, warn() {} } });
    try { await h.service.processToolCall({ command: 'Observe', serial: 'A' }); }
    finally { await h.service.cleanup(); }
});

test('cleanup waits for cancelled RPC drain before releasing its owner', async () => {
    const entered = deferred(), gate = deferred(), order = [];
    const h = await harness({ uiServer: { ok: true,
        async invoke(method) { if (method === 'click') { entered.resolve(); await gate.promise; order.push('drained'); } return true; },
        stop() { order.push('owner-stop'); return { status: 'released' }; },
    } });
    const controller = new AbortController();
    const work = h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
        action: { command: 'Tap', id: 'com.example:id/go' } }, { signal: controller.signal }).catch(error => error);
    await entered.promise;
    controller.abort();
    assert.equal((await work).execution.outcome, 'unknown');
    let cleaned = false;
    const cleanup = h.service.cleanup().then(() => { cleaned = true; });
    try { await tick(); assert.equal(cleaned, false); assert.deepEqual(order, []); }
    finally { gate.resolve(); await cleanup; }
    assert.deepEqual(order, ['drained', 'owner-stop']);
    assert.equal(runtime.takeoverStatus().inFlight, 0);
});

test('cleanup drains an admitted management transaction before disposal', async () => {
    const entered = deferred(), gate = deferred();
    const h = await harness({ client: { async enqueue() { entered.resolve(); await gate.promise; return { stdout: '' }; } } });
    const work = h.api.disconnect({ address: 'A' });
    await entered.promise;
    let cleaned = false;
    const cleanup = h.service.cleanup().then(() => { cleaned = true; });
    try { await tick(); assert.equal(cleaned, false); }
    finally { gate.resolve(); await work; await cleanup; }
});
