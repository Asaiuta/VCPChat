'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, xml } = require('./helpers/android-service-harness.cjs');
const actions = (calls) => calls.filter(([kind, args]) => kind === 'adb' && args[0] === 'shell' && args[1] === 'input');

for (const key of ['KEYCODE_HOME;id', 'KEYCODE_HOME $(id)', 'KEYCODE_HOME\nREBOOT']) {
    test(`KeyEvent rejects unsafe device-shell argument ${JSON.stringify(key)}`, async () => {
        const { service, calls } = await harness();
        await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key } }), /按键|key|参数/);
        assert.equal(actions(calls).length, 0);
    });
}
for (const command of ['LaunchApp', 'KillApp']) {
    test(`${command} rejects an unsafe package before any adb`, async () => {
        const { service, calls } = await harness();
        await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command, package: 'com.example;id' } }), /包名|package/);
        assert.equal(calls.filter(([kind]) => kind === 'adb').length, 0);
    });
}
test('LaunchApp rejects unsafe activity before stop or package query', async () => {
    const { service, calls } = await harness();
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'LaunchApp', package: 'com.example', activity: '.Main;id', stop: true } }), /activity|组件/);
    assert.equal(calls.filter(([kind]) => kind === 'adb').length, 0);
});

test('Observe emits a unique snapshot and does not claim stability without sampling', async () => {
    const { service } = await harness();
    const first = await service.processToolCall({ command: 'Observe' });
    const second = await service.processToolCall({ command: 'Observe' });
    assert.equal(typeof first.details.snapshotId, 'string');
    assert.notEqual(first.details.snapshotId, second.details.snapshotId);
    assert.equal(first.details.settled, null);
    assert.equal(first.details.stability, 'not-sampled');
});

test('index requires the exact Observe snapshot, then is consumed by a successful action', async () => {
    const { service, calls } = await harness();
    const observed = await service.processToolCall({ command: 'Observe' });
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', index: 0 } }), /snapshotId/);
    let freshSnapshot;
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', index: 0, snapshotId: 'wrong' } }), error => {
        assert.equal(error.code, 'STALE_SNAPSHOT');
        assert.equal(error.details.screenReason, 'OBSERVED');
        freshSnapshot = error.details.screen.snapshotId;
        assert.notEqual(freshSnapshot, observed.details.snapshotId);
        return true;
    });
    assert.equal(actions(calls).length, 0);
    const result = await service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', index: 0, snapshotId: freshSnapshot } });
    assert.equal(result.details.execution.outcome, 'dispatched');
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', index: 0, snapshotId: observed.details.snapshotId } }), /快照|Observe/);
    assert.equal(actions(calls).length, 1);
});

test('index refuses a page whose geometry changed even if its semantic signature did not', async () => {
    const { service, calls } = await harness({ dump: (n) => xml('Go', n ? 100 : 0) });
    const observed = await service.processToolCall({ command: 'Observe' });
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', index: 0, snapshotId: observed.details.snapshotId } }), /快照|页面|布局/);
    assert.equal(actions(calls).length, 0);
});

test('expired index snapshot is rejected before any input', async () => {
    const { service, calls } = await harness();
    const observed = await service.processToolCall({ command: 'Observe' });
    service._internals.lastObserve.get('A').at -= 16000;
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', index: 0, snapshotId: observed.details.snapshotId } }), /过期|快照/);
    assert.equal(actions(calls).length, 0);
});

test('selector rebinds against a new tree before dispatching coordinates', async () => {
    const h = await harness({ dump: (n) => xml('Go', n ? 100 : 0) });
    await h.service.processToolCall({ command: 'Observe' });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', id: 'com.example:id/go' } });
    assert.equal(result.details.y, 120);
    assert.ok(h.dumpCount >= 2);
});

test('selector can acquire a current tree without a cached Observe', async () => {
    const { service } = await harness();
    const result = await service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', id: 'com.example:id/go' } });
    assert.equal(result.details.y, 20);
});

test('failed stability resampling is unknown, never stable', async () => {
    const { service } = await harness({ dump: (n) => n === 0 ? xml() : Object.assign(new Error('sample unavailable'), { code: 'UI_ACQUISITION_FAILED' }) });
    const observed = await service.processToolCall({ command: 'Observe', stable: true });
    assert.equal(observed.details.settled, null);
    assert.equal(observed.details.stability, 'unknown');
    assert.match(observed.content[0].text, /稳定性未知/);
});

for (const broken of ['not XML', '<hierarchy><node text="partial" />', '<hierarchy><node></hierarchy>']) {
    test(`invalid dump is an acquisition error: ${broken}`, async () => {
        const { service } = await harness({ dump: () => broken });
        await assert.rejects(service.processToolCall({ command: 'Observe' }), /XML|控件树|采集/);
    });
}
test('a valid empty hierarchy is not an acquisition error', async () => {
    const { service } = await harness({ dump: () => '<hierarchy rotation="0"></hierarchy>' });
    const observed = await service.processToolCall({ command: 'Observe' });
    assert.equal(observed.details.total, 0);
});

test('ExecuteStep validates a visible target after one action and records stage timings', async () => {
    const { service, calls } = await harness();
    const result = await service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', id: 'com.example:id/go' }, expect: { type: 'visible', selector: 'id=com.example:id/go' } });
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(result.details.execution.verification.matched, true);
    for (const field of ['prepareMs', 'actionMs', 'verificationMs', 'totalMs']) assert.ok(result.details.execution.timings[field] >= 0, field);
    assert.equal(actions(calls).length, 1);
});

test('ExecuteStep mismatch returns unknown, never replays the action', async () => {
    const { service, calls } = await harness();
    const result = await service.processToolCall({ command: 'ExecuteStep', timeoutMs: 1000, waitTimeoutMs: 25, action: { command: 'Tap', id: 'com.example:id/go' }, expect: { type: 'visible', selector: 'text=missing' } });
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.execution.verification.matched, false);
    assert.equal(actions(calls).length, 1);
});

test('ExecuteStep invalid expectations and recursive actions fail before input', async () => {
    const { service, calls } = await harness();
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', x: 1, y: 2 }, expect: { type: 'arbitrary-script' } }), /expect|后置条件/);
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'ExecuteStep' } }), /action|动作/);
    assert.equal(actions(calls).length, 0);
});

test('a device lease prevents a sibling action interleaving a multi-command input', async () => {
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const { service, calls } = await harness({ run: async (args) => {
        if (args[1] === 'input' && args[2] === 'text') { entered(); await gate; }
    } });
    const first = service.processToolCall({ command: 'ExecuteStep', action: { command: 'InputText', text: 'hello', enter: true } });
    await started;
    try {
        await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'home' } }), (error) => error.code === 'DEVICE_BUSY');
    } finally { release(); }
    await first;
    assert.deepEqual(actions(calls).map(([, args]) => args[2]), ['text', 'keyevent']);
});

test('trusted cancellation is checked before dispatch and records a structured failure', async () => {
    const { service, calls } = await harness();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', x: 1, y: 2 } }, { signal: controller.signal }), (error) => error.code === 'STEP_ABORTED');
    assert.equal(actions(calls).length, 0);
});

test('coordinates outside current screen fail before input', async () => {
    const { service, calls } = await harness();
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', x: 100, y: 200 } }), /坐标|屏幕/);
    assert.equal(actions(calls).length, 0);
});


test('pixel tap requires a fresh frameId and consumes it exactly once', async () => {
    const { service, calls } = await harness();
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', x: 10, y: 20 } }), /frameId/);
    const shot = await service.processToolCall({ command: 'Observe', mode: 'image' });
    assert.equal(typeof shot.details.image.frameId, 'string');
    const frameId = shot.details.image.frameId;
    const tapped = await service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', x: 10, y: 20, frameId } });
    assert.equal(tapped.details.execution.outcome, 'dispatched');
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', x: 10, y: 20, frameId } }), /截图|frameId/);
    assert.equal(actions(calls).length, 1);
});

test('a frame from another device cannot authorize pixel coordinates', async () => {
    const { service, calls } = await harness();
    const shot = await service.processToolCall({ command: 'Observe', mode: 'image', serial: 'A' });
    await assert.rejects(service.processToolCall({ command: 'ExecuteStep', serial: 'B', action: { command: 'Tap', x: 10, y: 20, frameId: shot.details.image.frameId } }), /截图|frameId/);
    assert.equal(actions(calls).length, 0);
});


for (const selector of ['garbage', 'text=', 'id=foo#0']) {
    test(`invalid expectation selector fails before dispatch: ${selector}`, async () => {
        const { service, calls } = await harness();
        await assert.rejects(service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, expect: { type: 'absent', selector } }), /selector|后置条件/);
        assert.equal(actions(calls).length, 0);
    });
}

test('device management through both tool and viewer cannot interrupt an active step', async () => {
    let release, entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const { service, api, calls } = await harness({ run: async (args) => {
        if (args[1] === 'input' && args[2] === 'text') { entered(); await gate; }
    } });
    const first = service.processToolCall({ command: 'ExecuteStep', action: { command: 'InputText', text: 'hello', enter: true } });
    await started;
    try {
        await assert.rejects(service.processToolCall({ command: 'Manage', operation: 'disconnect', serial: 'A' }), (error) => error.code === 'DEVICE_BUSY');
        await assert.rejects(api.disconnect({ address: 'A' }), (error) => error.code === 'DEVICE_BUSY');
    } finally { release(); }
    await first;
    assert.equal(calls.some(([kind, args]) => kind === 'adb' && args[0] === 'disconnect'), false);
});


for (const broken of ['<hierarchy><node text=broken /></hierarchy>', '<hierarchy><node text="A & B" /></hierarchy>', '<hierarchy><node text="A" text="B" /></hierarchy>']) {
    test(`malformed XML attributes cannot become an empty observation: ${broken}`, async () => {
        const { service } = await harness({ dump: () => broken });
        await assert.rejects(service.processToolCall({ command: 'Observe' }), /XML|采集/);
    });
}

test('absence cannot be verified using a truncated control list', async () => {
    const nodes = Array.from({ length: 501 }, (_, n) => `<node class="android.widget.Button" package="com.example" resource-id="com.example:id/b${n}" text="b${n}" clickable="true" bounds="[0,0][100,40]" />`).join('');
    const { service } = await harness({ dump: () => `<hierarchy rotation="0">${nodes}</hierarchy>` });
    const result = await service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'home' }, waitTimeoutMs: 1, expect: { type: 'absent', selector: 'id=com.example:id/b500' } });
    assert.equal(result.details.execution.outcome, 'unknown');
});

test('literal text containing hash and percent is not mistaken for selector ordinal', async () => {
    const { service } = await harness({ dump: () => xml('Item#1%') });
    const result = await service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', text: 'Item#1%' } });
    assert.equal(result.details.y, 20);
});
