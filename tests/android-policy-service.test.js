'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, xml } = require('./helpers/android-service-harness.cjs');
const run = (h, action, extra = {}) => h.service.processToolCall({ command: 'ExecuteStep', action, ...extra });
const writes = h => h.calls.filter(c => c[0] === 'rpc' || (c[0] === 'adb' && c[1].includes('input')));

test('denyPackages blocks UI and pixels before either carrier or camera is read', async () => {
    let captures = 0;
    const h = await harness({ config: { INTERACTION_POLICY: { denyPackages: ['com.example'] } }, frames: { async captureOneShot() { captures++; return {}; } } });
    for (const mode of ['ui', 'image']) await assert.rejects(h.service.processToolCall({ command: 'Observe', mode }), { code: 'POLICY_DENIED' });
    assert.equal(h.dumpCount, 0); assert.equal(h.uiServer.started, 0); assert.equal(captures, 0);
});
test('read-only allows Observe but no coordinates, keys, ASCII, Unicode or semantic dispatch', async () => {
    const h = await harness({ config: { INTERACTION_POLICY: { readOnlyPackages: ['com.example'] } } });
    const observed = await h.service.processToolCall({ command: 'Observe' });
    assert.equal(observed.details.controls.length, 1);
    for (const action of [{ command: 'Tap', x: 10, y: 10 }, { command: 'Tap', id: 'com.example:id/go' },
        { command: 'KeyEvent', key: 'home' }, { command: 'InputText', text: 'abc' }, { command: 'InputText', text: '中文' }]) {
        if (action.x !== undefined) action.frameId = (await h.service.processToolCall({ command: 'Observe', mode: 'image' })).details.frameId;
        await assert.rejects(run(h, action), { code: 'POLICY_DENIED' });
    }
    assert.equal(writes(h).length, 0);
});
test('sensitive exact target and unscoped input share the observation risk vocabulary', async () => {
    const h = await harness({ dump: () => xml('Pay') });
    const observed = await h.service.processToolCall({ command: 'Observe', textLength: 16 });
    assert.equal(observed.details.controls[0].risk.sensitive, true);
    for (const action of [{ command: 'Tap', id: 'com.example:id/go' }, { command: 'Tap', x: 10, y: 10 }, { command: 'KeyEvent', key: 'enter' }]) {
        if (action.x !== undefined) action.frameId = (await h.service.processToolCall({ command: 'Observe', mode: 'image' })).details.frameId;
        await assert.rejects(run(h, action), error => error.code === 'POLICY_CONFIRMATION_REQUIRED' && error.needsConfirmation === true && error.details.policy.needsConfirmation === true);
    }
    assert.equal(writes(h).length, 0);
});
test('policy revocation during carrier readiness stops before any attempt', async () => {
    const policy = {};
    const h = await harness({ config: { INTERACTION_POLICY: policy }, uiServer: { ok: true,
        start() { policy.confirmEveryWrite = true; return { ok: true }; } } });
    const frameId = (await h.service.processToolCall({ command: 'Observe', mode: 'image' })).details.frameId;
    await assert.rejects(run(h, { command: 'Tap', x: 10, y: 10, frameId }), { code: 'POLICY_CONFIRMATION_REQUIRED' });
    assert.equal(writes(h).length, 0);
});
test('stale attaches one new read-only snapshot and never replays input', async () => {
    const h = await harness(); const first = await h.service.processToolCall({ command: 'Observe' });
    await assert.rejects(run(h, { command: 'Tap', index: 0, snapshotId: 'old' }), error => {
        assert.equal(error.code, 'STALE_SNAPSHOT'); assert.equal(error.details.screenReason, 'OBSERVED');
        assert.notEqual(error.details.screen.snapshotId, first.details.snapshotId); return true;
    });
    assert.equal(writes(h).length, 0);
});
test('deny policy after snapshot leaves stale screen null and never wakes', async () => {
    const policy = {}; const h = await harness({ config: { INTERACTION_POLICY: policy } });
    await h.service.processToolCall({ command: 'Observe' });
    policy.denyPackages = ['com.example']; const dumps = h.dumpCount;
    await assert.rejects(run(h, { command: 'Tap', index: 0, snapshotId: 'old' }), error => {
        assert.equal(error.code, 'STALE_SNAPSHOT'); assert.equal(error.details.screen, null);
        assert.equal(error.details.screenReason, 'POLICY_DENIED'); return true;
    });
    assert.equal(h.dumpCount, dumps); assert.equal(writes(h).length, 0);
});
test('Observe rejects malformed display budgets before acquisition and canonical evidence remains full', async () => {
    const h = await harness({ dump: () => xml('A'.repeat(200)) });
    for (const textLength of [0, 15, 4097, '120']) await assert.rejects(h.service.processToolCall({ command: 'Observe', textLength }), { code: 'INVALID_ARGUMENT' });
    assert.equal(h.dumpCount, 0);
    const result = await h.service.processToolCall({ command: 'Observe', textLength: 16 });
    assert.ok(result.details.controls[0].label.length < 30);
    assert.equal(result.details.controls[0].x, undefined);
    assert.equal(h.service._internals.lastObserve.get('A').graph.controls[0].text.length, 200);
    assert.equal(result.details.identity.code.complete, true);
    assert.equal(result.details.identity.performance.complete, false);
    assert.equal(result.details.identity.authorization, false);
});

test('performance identity records the stable sampling actually requested', async () => {
    const h = await harness();
    const observe = extra => h.service.processToolCall({ command: 'Observe', ...extra });
    const implicit = await observe({});
    const unsampled = await observe({ stable: false });
    const sampled = await observe({ stable: true });
    assert.equal(implicit.details.stability, 'not-sampled');
    assert.equal(sampled.details.stability, 'stable');
    assert.equal(implicit.details.identity.performance.digest, unsampled.details.identity.performance.digest);
    assert.notEqual(implicit.details.identity.performance.digests.workload, sampled.details.identity.performance.digests.workload);
});
