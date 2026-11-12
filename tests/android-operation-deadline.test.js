'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { performance } = require('node:perf_hooks');
const { withOperationDeadline } = require('../VCPDistributedServer/Plugin/AndroidController/lib/operation-deadline');

const tick = () => new Promise(resolve => setImmediate(resolve));

test('pre-cancelled and exhausted operations never invoke the dependency', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const task = () => { calls++; };
    await assert.rejects(withOperationDeadline(100, controller.signal, task), { code: 'ABORTED' });
    await assert.rejects(withOperationDeadline(0, undefined, task), { code: 'TIMEOUT' });
    assert.equal(calls, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const finish of ['resolve', 'reject']) for (const boundary of ['cancel', 'deadline']) {
    test(`${boundary} signals the dependency but waits for its late ${finish}`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const controller = new AbortController();
        let resolve, reject, child, settled = false;
        const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
        const operation = withOperationDeadline(100, controller.signal, ({ signal }) => {
            child = signal;
            return pending;
        }).finally(() => { settled = true; });
        const checked = assert.rejects(operation, { code: boundary === 'cancel' ? 'ABORTED' : 'TIMEOUT' });
        if (boundary === 'cancel') controller.abort();
        else t.mock.timers.tick(100);
        await tick();
        assert.equal(child.aborted, true);
        assert.equal(settled, false);
        if (finish === 'resolve') resolve(true);
        else reject(Error('late dependency failure'));
        await checked;
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
}

test('parent cancellation wins over a local timeout while draining', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let resolve;
    const operation = withOperationDeadline(100, controller.signal, () => new Promise(yes => { resolve = yes; }));
    const checked = assert.rejects(operation, { code: 'ABORTED' });
    t.mock.timers.tick(100);
    controller.abort();
    resolve(true);
    await checked;
});

test('elapsed deadline overrides a dependency rejection even when the timer cannot run', async t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    await assert.rejects(withOperationDeadline(100, undefined, async () => {
        now = 100;
        throw Error('dependency failed after the deadline');
    }), { code: 'TIMEOUT' });
});

test('nested work receives only the remaining window', async t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const result = await withOperationDeadline(100, undefined, async ({ signal, remainingMs }) => {
        now = 75;
        assert.equal(remainingMs(), 25);
        return withOperationDeadline(remainingMs(), signal, async () => { now = 99; return 'done'; });
    });
    assert.equal(result, 'done');
});

test('settled operations remove parent listeners and stop their signals on success and failure', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const original = Error('dependency failure');
    let child;
    assert.equal(await withOperationDeadline(100, controller.signal, ({ signal }) => {
        child = signal;
        return 'done';
    }), 'done');
    assert.equal(child.aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(withOperationDeadline(100, controller.signal, ({ signal }) => {
        child = signal;
        throw original;
    }), error => error === original);
    assert.equal(child.aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    t.mock.timers.tick(1000);
});
