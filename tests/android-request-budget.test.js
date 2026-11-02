'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { withBudget } = require('../VCPDistributedServer/Plugin/AndroidController/lib/request-budget');

test('synchronous work cannot return success after delaying the deadline timer', async () => {
    let signal;
    await assert.rejects(withBudget(5, undefined, current => {
        signal = current;
        const end = performance.now() + 20;
        while (performance.now() < end) {}
        return 'late success';
    }), error => error.code === 'TIMEOUT');
    assert.equal(signal.aborted, true);
});
test('late asynchronous rejection stays handled after timeout', async () => {
    let reject;
    await assert.rejects(withBudget(5, undefined, () => new Promise((_, fail) => { reject = fail; })), error => error.code === 'TIMEOUT');
    reject(new Error('late failure'));
    await new Promise(resolve => setImmediate(resolve));
});
test('normal completion and external cancellation keep their own outcome', async () => {
    assert.equal(await withBudget(1000, undefined, () => 42), 42);
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    await assert.rejects(withBudget(1000, controller.signal, () => { invoked = true; }), error => error.code === 'ABORTED');
    assert.equal(invoked, false);
});
