'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, xml } = require('./helpers/android-service-harness.cjs');
const manifest = require('../VCPDistributedServer/Plugin/AndroidController/plugin-manifest.json');
const text = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const receipt = result => JSON.parse(result.content.find(part => part.type === 'text' && part.text.startsWith('{"execution":')).text).execution;
const inputs = calls => calls.filter(([kind, args]) => kind === 'adb' && args[1] === 'input');

test('manifest exposes atomic entries plus the explicit experimental host task entry', () => {
    assert.deepEqual(manifest.capabilities.invocationCommands.map(item => item.command), ['Describe', 'Observe', 'ExecuteStep', 'RunTask', 'Manage']);
});

test('Describe defaults to a model-visible catalog without contacting a device', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'Describe' });
    assert.equal(h.calls.length, 0);
    assert.ok(result.details.catalog.actions.some(item => item.command === 'Tap'));
    assert.ok(result.details.catalog.actions.some(item => item.command === 'System'));
    assert.match(text(result), /afterObserve|snapshotId/);
    assert.match(text(result), /devices|packages|system|api/);
});

test('Describe reuses device, package and system capability discovery', async () => {
    const h = await harness();
    const devices = await h.service.processToolCall({ command: 'Describe', topic: 'devices' });
    assert.equal(devices.details.devices.length, 2);
    const packages = await h.service.processToolCall({ command: 'Describe', topic: 'packages', serial: 'B', filter: 'example' });
    assert.equal(packages.details.serial, 'B');
    assert.match(text(packages), /com.example/);
    const system = await h.service.processToolCall({ command: 'Describe', topic: 'system' });
    assert.equal(system.details.support, 'declared-only');
    assert.ok(system.details.capabilities.some(item => item.id === 'batteryLevel'));
    await assert.rejects(h.service.processToolCall({ command: 'Describe', topic: 'unknown' }), { code: 'INVALID_ARGUMENT' });
});

test('Observe image mode bypasses unavailable UI semantics and returns an actual image', async () => {
    const h = await harness({ dump: () => { throw new Error('UI unavailable'); } });
    const result = await h.service.processToolCall({ command: 'Observe', mode: 'image', serial: 'A' });
    assert.equal(h.dumpCount, 0);
    assert.ok(result.content.some(part => part.type === 'image_url'));
    assert.match(text(result), new RegExp(result.details.frameId));
});

test('Observe arbitration mode reuses snapshot-bound advisory without dispatching input', async () => {
    const h = await harness();
    const observed = await h.service.processToolCall({ command: 'Observe' });
    const result = await h.service.processToolCall({ command: 'Observe', mode: 'arbitrate', arbitration: { mode: 'target', goal: 'Go', candidates: [0], snapshotId: observed.details.snapshotId } });
    assert.equal(result.details.arbitration.advisory, true);
    assert.equal(result.details.arbitration.target.index, 0);
    assert.equal(inputs(h.calls).length, 0);
    await assert.rejects(h.service.processToolCall({ command: 'Observe', mode: 'unknown' }), { code: 'INVALID_ARGUMENT' });
});

test('Manage routes display diagnostics and validates operation before touching a device', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'Manage', operation: 'displayStatus' });
    assert.match(text(result), /显示屏/);
    await assert.rejects(h.service.processToolCall({ command: 'Manage', operation: 'shell' }), { code: 'INVALID_ARGUMENT' });
    assert.equal(h.calls.length, 0);
});

test('successful step publishes its verification and device identity in model content', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'KeyEvent', key: 'back' }, expect: { type: 'visible', selector: 'text=Go' } });
    const execution = receipt(result);
    assert.equal(execution.outcome, 'verified');
    assert.equal(execution.serial, 'A');
    assert.equal(execution.verification.matched, true);
    assert.equal(execution.requestId, result.details.execution.requestId);
    assert.equal(execution.retryable, false);
});

test('mismatched verification is visible as unknown with no automatic retry', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, waitTimeoutMs: 1, expect: { type: 'visible', selector: 'text=missing' } });
    assert.equal(receipt(result).outcome, 'unknown');
    assert.equal(receipt(result).retryable, false);
    assert.equal(inputs(h.calls).length, 1);
});

test('afterObserve reuses the last successful UI verification sample and yields a usable snapshot', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'KeyEvent', key: 'back' }, expect: { type: 'visible', selector: 'text=Go' }, afterObserve: true });
    // One pre-dispatch safety sample is independent from the one verification/returned observation sample.
    assert.equal(h.dumpCount, 2, 'mandatory policy evidence plus one reused post-action verification sample');
    const inputAt = h.calls.findIndex(([kind, args]) => kind === 'adb' && args[1] === 'input');
    const dumpAt = h.calls.flatMap(([kind, args], index) => kind === 'adb' && args.includes('uiautomator') ? [index] : []);
    assert.equal(dumpAt.length, 2);
    assert.ok(dumpAt[0] < inputAt && inputAt < dumpAt[1], 'safety evidence precedes input, verification follows it');
    const observation = result.details.observation;
    assert.equal(observation.status, 'observed');
    assert.equal(observation.controls[0].label, 'Go');
    assert.match(text(result), new RegExp(observation.snapshotId));
    await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', index: 0, snapshotId: observation.snapshotId } });
    assert.equal(inputs(h.calls).length, 2);
});

test('afterObserve does not reuse a failed or stale verification sample', async () => {
    const h = await harness({ dump: n => n === 0 ? xml('Old') : xml('New') });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, waitTimeoutMs: 1, expect: { type: 'visible', selector: 'text=missing' }, afterObserve: true });
    assert.ok(h.dumpCount >= 2);
    assert.equal(receipt(result).outcome, 'unknown');
    assert.equal(result.details.observation.controls[0].label, 'New');
});

test('afterObserve failure preserves dispatched action and does not leak backend text', async () => {
    // The required pre-dispatch policy evidence must succeed; only the post-action observation fails.
    const h = await harness({ dump: index => index === 0 ? xml() : new Error('private backend payload') });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve: true });
    assert.equal(receipt(result).outcome, 'dispatched');
    assert.equal(result.details.observation.status, 'failed');
    assert.equal(result.details.observation.code, 'UI_ACQUISITION_FAILED');
    assert.doesNotMatch(text(result), /private backend payload/);
    assert.equal(inputs(h.calls).length, 1);
});

test('afterObserve options validate before input and default adds no post-action sample beyond policy evidence', async () => {
    const h = await harness();
    for (const afterObserve of [42, 'garbage', { serial: 'B' }, { limit: 0 }, { stable: true }]) {
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve }), { code: 'INVALID_ARGUMENT' });
    }
    assert.equal(inputs(h.calls).length, 0);
    assert.equal(h.dumpCount, 0, 'invalid afterObserve never reaches policy evidence acquisition');
    await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' } });
    assert.equal(h.dumpCount, 1, 'default still performs its required pre-dispatch safety sample');
    const inputAt = h.calls.findIndex(([kind, args]) => kind === 'adb' && args[1] === 'input');
    assert.ok(inputAt >= 0);
    assert.equal(h.calls.slice(inputAt + 1).some(([kind, args]) => kind === 'adb' && args.includes('uiautomator')), false,
        'omitted afterObserve must not add a post-input UI request');
});

test('Observe wake=never never dispatches wakeup', async () => {
    const h = await harness();
    h.client.probeScreen = async () => ({ focus: {}, size: { width: 100, height: 200 }, wakefulness: 'Asleep' });
    await h.service.processToolCall({ command: 'Observe', wake: 'never' });
    assert.equal(inputs(h.calls).length, 0);
    await assert.rejects(h.service.processToolCall({ command: 'Observe', wake: 'anything' }), { code: 'INVALID_ARGUMENT' });
});

test('System inside ExecuteStep requires outer explicit serial and trusted authorization', async () => {
    const h = await harness();
    const action = { command: 'System', operation: 'read', capability: 'batteryLevel' };
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action }), { code: 'SYSTEM_NOT_AUTHORIZED' });
    const permitted = await harness({ services: { systemAuthorization: { async assertAllowed() {} } }, run: args => args.includes('get-current-user') ? '0' : args.some(token => token.includes('battery')) ? '46' : undefined });
    const result = await permitted.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action });
    assert.equal(result.details.system.value, 46);
    assert.equal(receipt(result).outcome, 'observed');
    assert.equal(permitted.dumpCount, 0);
});

test('step errors keep machine fields and a minimal model-visible receipt without input text', async () => {
    const h = await harness({ run: args => { if (args[1] === 'input') throw Object.assign(new Error('backend failed'), { code: 'INPUT_FAILED' }); } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'InputText', text: 'private-input' } }), error => {
        assert.equal(error.execution.outcome, 'unknown');
        assert.match(error.message, /unknown/);
        assert.match(error.message, /INPUT_FAILED/);
        assert.match(error.message, /requestId/);
        assert.doesNotMatch(error.message, /private-input/);
        return true;
    });
});

test('Manage cannot bypass the device lease', async () => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ run: async args => { if (args[1] === 'input') { entered(); await gate; } } });
    const work = h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' } });
    await ready;
    try {
        await assert.rejects(h.service.processToolCall({ command: 'Manage', operation: 'disconnect', serial: 'A' }), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    await work;
});


for (const name of ['constructor', 'toString', '__proto__']) {
    test(`routing rejects inherited operation ${name}`, async () => {
        const h = await harness();
        await assert.rejects(h.service.processToolCall({ command: 'Manage', operation: name }), { code: 'INVALID_ARGUMENT' });
        await assert.rejects(h.service.processToolCall({ command: name }), /不支持/);
        assert.equal(h.calls.length, 0);
    });
}

test('afterObserve image adds no UI beyond required pre-dispatch policy evidence', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve: '{"mode":"image","maxWidth":300}' });
    assert.equal(h.dumpCount, 1, 'only the keyboard action safety gate acquires UI');
    const inputAt = h.calls.findIndex(([kind, args]) => kind === 'adb' && args[1] === 'input');
    assert.ok(inputAt >= 0);
    assert.equal(h.calls.slice(inputAt + 1).some(([kind, args]) => kind === 'adb' && args.includes('uiautomator')), false,
        'the image observation itself must not acquire semantic UI');
    assert.ok(result.content.some(part => part.type === 'image_url'));
    assert.equal(typeof result.details.observation.frameId, 'string');
    assert.match(text(result), new RegExp(result.details.observation.frameId));
});

test('a frontend-only observation limit still produces a valid next-action index', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, expect: { type: 'visible', selector: 'text=Go' }, afterObserve: { limit: 1 } });
    const observed = result.details.observation;
    await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', index: 0, snapshotId: observed.snapshotId } });
    assert.equal(inputs(h.calls).length, 2);
});

test('input backend failure cannot echo private input through error.message', async () => {
    const h = await harness({ run: args => { if (args[1] === 'input') throw Object.assign(new Error('failed command: private-input'), { code: 'INPUT_FAILED' }); } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'InputText', text: 'private-input' } }), error => {
        assert.equal(error.execution.outcome, 'unknown');
        assert.match(error.message, /INPUT_FAILED/);
        assert.doesNotMatch(error.message, /private-input/);
        return true;
    });
});

test('afterObserve cannot hide a trusted cancellation or release the lease early', async () => {
    const controller = new AbortController();
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ run: async args => { if (args[1] === 'input') { entered(); await gate; } } });
    const work = h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve: true }, { signal: controller.signal });
    await ready;
    assert.equal(inputs(h.calls).length, 1, 'abort is triggered only after the real input backend is entered');
    assert.equal(h.dumpCount, 1, 'pre-dispatch policy sample completed before cancellation');
    controller.abort();
    try {
        await assert.rejects(work, error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'unknown');
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' } }), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    await new Promise(resolve => setTimeout(resolve, 0));
});


test('cancellation during policy evidence is explicitly not dispatched and retains lease until drain', async () => {
    const controller = new AbortController();
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ dump: async () => { entered(); await gate; return xml(); } });
    const work = h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve: true }, { signal: controller.signal });
    await ready;
    assert.equal(inputs(h.calls).length, 0, 'policy sampling has not dispatched input');
    controller.abort();
    try {
        await assert.rejects(work, error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'failed');
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' } }), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(inputs(h.calls).length, 0, 'late evidence cannot dispatch after cancellation');
});

test('post-action observation cancellation cannot erase dispatch evidence or release lease early', async () => {
    const controller = new AbortController();
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ dump: async index => { if (index === 0) return xml(); entered(); await gate; return xml(); } });
    const work = h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve: true }, { signal: controller.signal });
    await ready;
    assert.equal(inputs(h.calls).length, 1, 'post-action observation begins only after input');
    controller.abort();
    try {
        await assert.rejects(work, error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'unknown');
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' } }), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(inputs(h.calls).length, 1, 'cancellation never replays input');
});

test('policy evidence failure is not dispatched and does not leak raw backend text', async () => {
    const h = await harness({ dump: () => new Error('private backend payload') });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve: true }), error => {
        assert.equal(error.code, 'UI_ACQUISITION_FAILED');
        assert.equal(error.execution.outcome, 'failed');
        assert.doesNotMatch(error.message, /private backend payload/);
        return true;
    });
    assert.equal(inputs(h.calls).length, 0);
});

test('pure observations report observed rather than dispatched', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'Observe' });
    assert.equal(receipt(result).outcome, 'observed');
    const packages = await h.service.processToolCall({ command: 'Describe', topic: ' PACKAGES ' });
    assert.equal(receipt(packages).outcome, 'observed');
});

test('Observe API forwards trusted pre-aborted signal without requiring a device', async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.service.processToolCall({ command: 'Observe', mode: ' API ', capability: 'github-public-issue', params: { owner: 'nodejs', repo: 'node', number: 1 } }, { signal: controller.signal });
    assert.equal(result.details.api.failure.code, 'aborted');
    assert.equal(h.calls.length, 0);
});


test('outer expectation overrides the inner System outcome', async () => {
    const h = await harness({ services: { systemAuthorization: { async assertAllowed() {} } }, run: args => args.includes('get-current-user') ? '0' : args.some(token => token.includes('battery')) ? '46' : undefined });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'read', capability: 'batteryLevel' }, expect: { type: 'visible', selector: 'text=missing' }, waitTimeoutMs: 1 });
    assert.equal(result.details.system.outcome, 'observed');
    assert.equal(receipt(result).verification.matched, false);
    assert.equal(receipt(result).outcome, 'unknown');
});