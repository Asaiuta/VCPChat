'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, xml } = require('./helpers/android-service-harness.cjs');
const visible = { type: 'visible', selector: 'text=Go' };
const wait = (h, extra = {}, context = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Wait' }, expect: visible, ...extra }, context);
const inputs = h => h.calls.filter(([kind, args]) => kind === 'adb' && args[1] === 'input');

test('Wait verifies visible condition without input and reuses sample for final observation', async () => {
    const h = await harness();
    const result = await wait(h, { afterObserve: true });
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(result.details.observation.status, 'observed');
    assert.equal(h.dumpCount, 1);
    assert.equal(inputs(h).length, 0);
});

test('Wait polls changing semantics until condition matches without waking device', async () => {
    const h = await harness({ dump: n => xml(n === 0 ? 'Loading' : 'Go') });
    h.client.probeScreen = async () => ({ wakefulness: 'Asleep', focus: {}, size: { width: 100, height: 200 } });
    const result = await wait(h, { waitTimeoutMs: 1000 });
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(h.dumpCount, 2);
    assert.equal(inputs(h).length, 0);
});

for (const expect of [undefined, null, { type: 'invalid' }]) test('Wait rejects missing or invalid condition before acquiring semantics', async () => {
    const h = await harness();
    await assert.rejects(wait(h, { expect }), { code: 'INVALID_ARGUMENT' });
    assert.equal(h.dumpCount, 0);
    assert.equal(inputs(h).length, 0);
});

for (const action of [{ command: 'Wait', duration: 100 }, { command: 'Wait', key: 'back' }, { command: 'Wait', serial: 'A' }]) test('Wait refuses unused action fields rather than ignoring them', async () => {
    const h = await harness();
    await assert.rejects(wait(h, { action }), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
});

test('Wait foreground is read-only and does not sample UI', async () => {
    const h = await harness();
    const result = await wait(h, { expect: { type: 'foreground', package: 'com.example' } });
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(h.dumpCount, 0);
    assert.equal(inputs(h).length, 0);
});

test('Wait timeout stops a sequence before its next action', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'ExecuteStep', steps: [
        { action: { command: 'Wait' }, expect: { type: 'visible', selector: 'text=missing' }, waitTimeoutMs: 1 },
        { action: { command: 'KeyEvent', key: 'back' } },
    ] });
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.sequence.status, 'stopped');
    assert.equal(inputs(h).length, 0);
});

test('invalid final Wait is detected before earlier sequence input', async () => {
    const h = await harness();
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', steps: [
        { action: { command: 'KeyEvent', key: 'back' }, expect: visible },
        { action: { command: 'Wait' } },
    ] }), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
});

test('Wait absence cannot be proven by lockscreen semantics', async () => {
    const h = await harness({ dump: () => '<hierarchy><node class="android.widget.TextView" package="com.android.systemui" text="Locked" bounds="[0,0][100,200]" /></hierarchy>' });
    const result = await wait(h, { expect: { type: 'absent', selector: 'text=Go' }, waitTimeoutMs: 1 });
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(inputs(h).length, 0);
});

test('Wait cancellation returns failed with no dispatched action and holds lease until read drains', async () => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ dump: async () => { entered(); await gate; return xml(); } });
    const controller = new AbortController();
    const work = wait(h, {}, { signal: controller.signal });
    await ready;
    controller.abort();
    try {
        await assert.rejects(work, error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'failed');
        await assert.rejects(wait(h), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(inputs(h).length, 0);
});



test('verified Wait allows exactly one subsequent GUI action on explicit B', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'B', steps: [
        { action: { command: 'Wait' }, expect: visible },
        { action: { command: 'KeyEvent', key: 'back' } },
    ] });
    assert.equal(result.details.sequence.steps[0].outcome, 'verified');
    assert.equal(result.details.sequence.steps[1].outcome, 'dispatched');
    assert.equal(inputs(h).length, 1);
    assert.equal(inputs(h)[0][2].serial, 'B');
    assert.equal(h.client.serial, 'A');
});

test('Wait total budget overrides a longer condition budget without dispatching input', async () => {
    const h = await harness({ dump: () => xml('Loading') });
    await assert.rejects(wait(h, { timeoutMs: 20, waitTimeoutMs: 1000 }), error => error.code === 'STEP_DEADLINE' && error.execution.outcome === 'failed');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(inputs(h).length, 0);
});