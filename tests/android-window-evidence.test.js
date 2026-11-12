'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowEvidence } = require('../VCPDistributedServer/Plugin/AndroidController/lib/window-evidence');
const { harness } = require('./helpers/android-service-harness.cjs');
const roots = '<hierarchy rotation="0"><node class="View" package="com.example" text="secret-a" bounds="[0,0][100,200]" display-id="0"><node class="Button" package="com.example" text="secret-b" bounds="[1,1][10,10]"/></node><node class="View" package="com.other" text="secret-other" bounds="[0,0][100,200]"/></hierarchy>';
const probe = { focus: { package: 'com.example' }, wakefulness: 'Awake', size: { width: 100, height: 200 } };

test('diagnostic exposes root counts and bounds, not page text or invented WindowInfo', () => {
    const result = windowEvidence(roots, probe);
    assert.equal(result.rootCount, 2); assert.equal(result.totalNodes, 3);
    assert.equal(result.roots[0].nodeCount, 2); assert.equal(result.roots[0].displayId, 0);
    assert.equal(result.roots[1].displayId, null);
    assert.equal(result.roots[0].windowId, null); assert.equal(result.roots[0].layer, null);
    assert.equal(result.nullRootCount, null); assert.equal(result.occlusion, 'unknown');
    assert.equal(result.actionable, false); assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('com.other'), false);
});
test('empty tree diagnoses asleep/locked/unknown without treating absence as proof', () => {
    const xml = '<hierarchy rotation="0"/>';
    assert.equal(windowEvidence(xml, { ...probe, wakefulness: 'Asleep' }).state, 'SCREEN_ASLEEP');
    assert.equal(windowEvidence(xml, { ...probe, keyguard: { showing: true } }).state, 'DEVICE_LOCKED');
    assert.equal(windowEvidence(xml, { ...probe, focus: null }).state, 'CONTEXT_UNKNOWN');
    assert.equal(windowEvidence(xml, probe).state, 'ROOT_UNAVAILABLE');
});
test('all root packages, including nested noncontrols, must satisfy read policy', () => {
    let count = 0;
    assert.throws(() => windowEvidence(roots, probe, pkg => { count++; if (pkg === 'com.other') throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' }); }), { code: 'POLICY_DENIED' });
    assert.equal(count, 3);
});
test('Observe windows uses explicit rootInActive:false only for read-only diagnostics', async () => {
    const h = await harness({ uiServer: { ok: true } });
    const result = await h.service.processToolCall({ command: 'Observe', windows: true });
    assert.equal(result.details.windows.rootCount, 1);
    assert.equal(result.details.windows.actionable, false);
    assert.equal(h.uiServer.dumped, 2);
    assert.equal(h.calls.some(c => c[0] === 'rpc' || (c[0] === 'adb' && c[1].includes('input'))), false);
    assert.equal(h.service._internals.lastObserve.get('A').graph.controls.length, 1);
});
