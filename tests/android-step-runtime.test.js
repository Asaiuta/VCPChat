'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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