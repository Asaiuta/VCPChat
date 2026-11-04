'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const history = require('../VCPDistributedServer/Plugin/AndroidController/lib/action-history');
const inputs = h => h.calls.filter(call => call[0] === 'rpc' || (call[0] === 'adb' && call[1][1] === 'input'));

for (const target of [
    { id: 'com.example:id/end', index: 0, snapshotId: 'old' },
    { id: 'com.example:id/end', snapshotId: 'old' },
    { id: 'com.example:id/end', serial: 'B' },
    { id: 'com.example:id/end', frameId: 'old' },
]) test(`M1.5 sequence预检拒绝嵌套Drag目标凭据或设备覆盖 ${JSON.stringify(target)}`, async () => {
    const h = await harness();
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', steps: [
        { action: { command: 'Tap', id: 'com.example:id/go' }, expect: { type: 'visible', selector: 'text=Go' } },
        { action: { command: 'Drag', id: 'com.example:id/go', target } },
    ] }), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
    assert.equal(h.dumpCount, 0);
});

test('M1.5 Describe公开新动作但不扩张公共入口；离线历史不调度也不派发', async () => {
    const h = await harness();
    const described = await h.service.processToolCall({ command: 'Describe' });
    const text = JSON.stringify(described);
    for (const command of ['ScrollUntil', 'Drag', 'Pinch', 'ImeAction', 'EraseText', 'KeyCombo', 'actionHistory']) assert.ok(text.includes(command), command);
    assert.equal(h.calls.length, 0);
    for (const command of ['ScrollUntil', 'Drag', 'Pinch', 'ImeAction', 'EraseText', 'KeyCombo', 'actionHistory']) {
        await assert.rejects(h.service.processToolCall({ command }));
    }
    const result = await h.service.processToolCall({ command: 'Manage', operation: 'actionHistory', serial: 'offline-M15', limit: 10 });
    assert.equal(result.details.serial, 'offline-M15');
    assert.deepEqual(Array.from(result.details.entries), []);
    assert.equal(h.calls.length, 0);
});

test('M1.5 sequence历史记录新增键盘逐步终态，不存参数/expect/键值', async () => {
    history.clear();
    const h = await harness({ uiServer: { ok: true } });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'B', steps: [
        { action: { command: 'KeyCombo', keyCode: 29, metaState: 4096 }, expect: { type: 'visible', selector: 'text=Go' } },
        { action: { command: 'ImeAction', imeAction: 'search' } },
    ] });
    const rows = history.query({ serial: 'B' }).entries.reverse();
    assert.deepEqual(rows.map(row => [row.command, row.outcome, row.stepIndex]), [['keycombo', 'verified', 0], ['imeaction', 'dispatched', 1]]);
    for (const row of rows) {
        assert.equal(row.requestId, result.details.execution.requestId);
        assert.equal(row.method, 'pressKeyCode');
        assert.equal(row.channel, 'rpc');
        for (const key of ['keyCode', 'metaState', 'imeAction', 'selector', 'expect', 'verification', 'message', 'params']) assert.equal(row[key], undefined);
    }
    assert.equal(JSON.stringify(rows).includes('text=Go'), false);
});
