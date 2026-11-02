'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const key = (expect = { type: 'visible', selector: 'text=Go' }) => ({ action: { command: 'KeyEvent', key: 'back' }, ...(expect ? { expect } : {}) });
const run = (h, steps, extra = {}, context = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', steps, ...extra }, context);
const inputs = h => h.calls.filter(([kind, args]) => kind === 'adb' && args[1] === 'input');

test('sequence runs ordered steps, verifies intermediate state and returns only final observation', async () => {
    const h = await harness();
    const result = await run(h, JSON.stringify([key(), key(null)]), { afterObserve: true });
    assert.equal(inputs(h).length, 2);
    assert.equal(result.details.sequence.steps.length, 2);
    assert.equal(result.details.sequence.steps[0].outcome, 'verified');
    assert.equal(result.details.sequence.steps[1].outcome, 'dispatched');
    assert.equal(result.details.sequence.status, 'completed');
    assert.equal(result.details.execution.outcome, 'dispatched', 'earlier verification must not leak into last step');
    assert.equal(result.details.observation.status, 'observed');
    assert.match(JSON.stringify(result.content), /sequence/);
});

for (const steps of [[], Array.from({ length: 9 }, () => key()), [key(null), key()], [key(), { action: { command: 'Manage' } }], [key(), { action: { command: 'System', operation: 'read' } }], [key(), { ...key(), serial: 'B' }], [key(), { ...key(), timeoutMs: 1 }], [key(), { ...key(), expect: { type: 'nonsense' } }], [key(), { action: { command: 'Tap', serial: 'B' } }], [key(), { ...key(), afterObserve: true }]]) {
    test(`sequence rejects invalid structure before first input: ${JSON.stringify(steps).slice(0, 120)}`, async () => {
        const h = await harness();
        await assert.rejects(run(h, steps), { code: 'INVALID_ARGUMENT' });
        assert.equal(inputs(h).length, 0);
    });
}

for (const extra of [{ action: { command: 'KeyEvent', key: 'home' } }, { expect: { type: 'foreground', package: 'com.example' } }, { waitTimeoutMs: 50 }]) test('sequence refuses ambiguous outer single-step fields', async () => {
    const h = await harness();
    await assert.rejects(run(h, [key()], extra), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
});

test('sequence stops on unknown verification without dispatching remaining action', async () => {
    const h = await harness();
    const result = await run(h, [{ ...key({ type: 'visible', selector: 'text=missing' }), waitTimeoutMs: 1 }, key()]);
    assert.equal(inputs(h).length, 1);
    assert.equal(result.details.sequence.status, 'stopped');
    assert.equal(result.details.sequence.steps.length, 1);
    assert.equal(result.details.sequence.steps[0].outcome, 'unknown');
    assert.equal(result.details.execution.outcome, 'unknown');
});

test('sequence keeps completed progress in model-visible error and never replays failed action', async () => {
    let count = 0;
    const h = await harness({ run: args => { if (args[1] === 'input' && ++count === 2) throw Object.assign(new Error('private backend'), { code: 'ADB_FAILED' }); } });
    await assert.rejects(run(h, [key(), key(), key()]), error => {
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(error.execution.sequence.steps[0].outcome, 'verified');
        assert.equal(error.execution.sequence.steps[1].outcome, 'unknown');
        assert.equal(error.execution.sequence.status, 'stopped');
        assert.match(error.message, /sequence/);
        return true;
    });
    assert.equal(inputs(h).length, 2);
});

test('sequence uses one lease and trusted cancellation preserves progress while pending input drains', async () => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const h = await harness({ run: async args => { if (args[1] === 'input') { entered(); await gate; } } });
    const work = run(h, [key(), key()], {}, { signal: controller.signal });
    await ready;
    controller.abort();
    try {
        await assert.rejects(work, error => error.code === 'STEP_ABORTED' && error.execution.sequence.steps[0].outcome === 'unknown');
        await assert.rejects(run(h, [key()]), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    await new Promise(resolve => setTimeout(resolve, 0));
});

test('sequence checks invalid final afterObserve before any action', async () => {
    const h = await harness();
    await assert.rejects(run(h, [key()], { afterObserve: { serial: 'B' } }), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
});


test('sequence rejects future pixel or index credentials before first action', async () => {
    const h = await harness();
    await assert.rejects(run(h, [key(), { action: { command: 'Tap', index: 0, snapshotId: 'old' } }]), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
});

test('sequence total deadline returns in-flight progress and keeps lease until drained', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ run: async args => { if (args[1] === 'input') await gate; } });
    try {
        await assert.rejects(run(h, [key(), key()], { timeoutMs: 20 }), error => error.code === 'STEP_DEADLINE' && error.execution.sequence.steps[0].outcome === 'unknown');
        await assert.rejects(run(h, [key()]), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    await new Promise(resolve => setTimeout(resolve, 0));
});

test('sequence invalid action parameters stop without replaying prior verified steps', async () => {
    const h = await harness();
    await assert.rejects(run(h, [key(), { action: { command: 'KeyEvent', key: ';bad' } }]), error => {
        assert.equal(error.execution.sequence.steps[0].outcome, 'verified');
        assert.equal(error.execution.sequence.steps[1].outcome, 'failed');
        assert.equal(error.execution.outcome, 'unknown');
        return true;
    });
    assert.equal(inputs(h).length, 1);
});
