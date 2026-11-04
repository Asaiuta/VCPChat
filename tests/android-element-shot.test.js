'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const vision = require('../VCPDistributedServer/Plugin/AndroidController/lib/vision');
const { harness } = require('./helpers/android-service-harness.cjs');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { layoutEvidence } = require('../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence');

const focus = { package: 'com.example', component: 'com.example/.Main', window: 'Main' };
const probe = { focus, size: { width: 100, height: 200 }, wakefulness: 'Awake' };
const scene = (left = 10, label = 'Icon') => `<hierarchy rotation="0"><node class="android.widget.ScrollView" package="com.example" resource-id="com.example:id/list" scrollable="true" bounds="[0,20][100,180]"><node class="android.widget.Button" package="com.example" resource-id="com.example:id/icon" text="${label}" clickable="true" enabled="true" bounds="[${left},10][60,70]"/></node></hierarchy>`;
async function setup(options = {}) {
    let count = 0;
    const h = await harness({ client: { async probeScreen() { return structuredClone(probe); } },
        dump: () => scene(), ...options, vision,
        frames: { requireSharp: () => sharp, async captureOneShot() {
            count++;
            if (options.capture) await options.capture();
            return { raw: { data: Buffer.alloc(100 * 200 * 4, 100), width: 100, height: 200, channels: 4 } };
        } },
    });
    return { ...h, captures: () => count };
}
const shot = h => h.service.processToolCall({ command: 'Observe', mode: 'image', target: 'element', serial: 'A', id: 'com.example:id/icon', padding: 8, grid: false, format: 'png' });

test('element public Observe clips scroll viewport then pads, preserves anchor and device mapping', async () => {
    const h = await setup();
    try {
        const result = await shot(h);
        assert.equal(h.captures(), 1);
        assert.deepEqual(JSON.parse(JSON.stringify(result.details.element)), {
            elementBounds: { left: 10, top: 10, right: 60, bottom: 70 },
            visibleBounds: { left: 10, top: 20, right: 60, bottom: 70 }, padding: 8,
            region: { left: 2, top: 12, width: 66, height: 66 }, center: { x: 35, y: 40 },
            occlusion: 'unknown', warnings: ['OCCLUSION_NOT_PROVEN'],
        });
        const mapping = result.details.mapping;
        assert.deepEqual(vision.imagePointToDevice(mapping, 0, 0), { x: 2, y: 12 });
        assert.deepEqual(vision.imagePointToDevice(mapping, mapping.imageWidth, mapping.imageHeight), { x: 68, y: 78 });
        const metadata = await sharp(Buffer.from(result.details.image.dataUrl.split(',')[1], 'base64')).metadata();
        assert.equal(metadata.width, result.details.image.width);
        assert.equal(result.details.execution.outcome, 'observed');
        assert.ok(result.content.some(part => part.type === 'text' && part.text.includes('OCCLUSION_NOT_PROVEN')));
        assert.equal(h.calls.some(call => call[0] === 'rpc' || (call[0] === 'adb' && call[1].includes('input'))), false);
    } finally { await h.service.cleanup(); }
});

test('element fresh semantic selector can observe without cached snapshot; default padding zero', async () => {
    const h = await setup();
    try {
        const result = await h.service.processToolCall({ command: 'Observe', serial: 'A', mode: 'image', target: 'element', selector: { id: 'com.example:id/icon', class: 'Button' }, grid: false });
        assert.equal(result.details.element.padding, 0);
        assert.equal(result.details.region.top, 20);
    } finally { await h.service.cleanup(); }
});

for (const invalid of [{ padding: -1 }, { padding: '8' }, { padding: 129 }, { region: { left: 0, top: 0, width: 5, height: 5 } }, { selector: 'text=Icon' }, { index: 0 }, { x: 1, y: 1 }]) {
    test(`element rejects mixed or invalid input before capture ${JSON.stringify(invalid)}`, async () => {
        const h = await setup();
        try { await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A', mode: 'image', target: 'element', id: 'com.example:id/icon', ...invalid }), { code: 'INVALID_ARGUMENT' }); assert.equal(h.captures(), 0); }
        finally { await h.service.cleanup(); }
    });
}

test('element changed after pixels acquired is rejected without replacing previous frame credential', async () => {
    let moved = false;
    const h = await setup({ dump: () => scene(moved ? 20 : 10), capture: () => { moved = true; } });
    try { await assert.rejects(shot(h), { code: 'ELEMENT_TARGET_CHANGED' }); }
    finally { await h.service.cleanup(); }
});

test('element image afterObserve uses same pipeline without overwriting action outcome', async () => {
    const h = await setup({ uiServer: { ok: true, xml: scene() } });
    try {
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', id: 'com.example:id/icon' },
            afterObserve: { mode: 'image', target: 'element', id: 'com.example:id/icon', padding: 4, grid: false } });
        assert.equal(result.details.execution.outcome, 'dispatched');
        assert.equal(result.details.observation.status, 'observed');
        assert.equal(result.details.observation.element.padding, 4);
    } finally { await h.service.cleanup(); }
});

test('elementRegion clamps screen and padding never moves original center', () => {
    const result = vision.elementRegion({ bounds: { left: 0, top: 0, right: 20, bottom: 20 }, visibleBounds: { left: 0, top: 0, right: 20, bottom: 20 }, screen: probe.size, padding: 128 });
    assert.deepEqual(result.region, { left: 0, top: 0, width: 100, height: 148 });
    assert.deepEqual(result.center, { x: 10, y: 10 });
});

test('layout evidence covers >40 raw visible nodes and ignores changing labels, not bounds/state', () => {
    const xml = (label, tail = 1, checked = false) => `<hierarchy><node class="android.widget.LinearLayout" package="com.example" bounds="[0,0][100,200]">${Array.from({ length: 70 }, (_, i) => `<node class="android.widget.Button" package="com.example" resource-id="com.example:id/n${i}" text="${label}" clickable="true" checked="${checked}" bounds="[0,${i}][${i === 69 ? tail : 10},${i + 1}]"/>`).join('')}</node></hierarchy>`;
    const digest = text => layoutEvidence(parseUiGraph(text, { limit: 1, screen: probe.size, rpcTarget: true }), probe).digest;
    assert.equal(digest(xml('one')), digest(xml('two')));
    assert.notEqual(digest(xml('one')), digest(xml('one', 2)));
    assert.notEqual(digest(xml('one')), digest(xml('one', 1, true)));
});

for (const change of ['foreground', 'size']) test(`element rejects ${change} changed during final dump without replacing credential`, async () => {
    let current = structuredClone(probe);
    const h = await setup({ client: { async probeScreen() { return structuredClone(current); }, async screenSize() { return current.size; } },
        dump: i => { if (i === 1) { if (change === 'foreground') current.focus.package = 'com.other'; else current.size.width = 200; } return scene(); } });
    try {
        await assert.rejects(shot(h), { code: 'ELEMENT_CONTEXT_CHANGED' });
        assert.equal(h.captures(), 1);
    } finally { await h.service.cleanup(); }
});

test('element RPC transport unknown never falls back to CLI and quarantines later access', async () => {
    const h = await setup({ uiServer: { ok: true, xml() { throw Object.assign(new Error('in flight'), { code: 'UI_SERVER_TIMEOUT', dispatched: true }); } } });
    try {
        await assert.rejects(shot(h), { code: 'UI_SERVER_TIMEOUT' });
        assert.equal(h.uiServer.dumped, 1);
        assert.equal(h.dumpCount, 0);
        assert.equal(h.captures(), 0);
        await assert.rejects(shot(h), { code: 'DEVICE_STATE_UNCERTAIN' });
        assert.equal(h.uiServer.dumped, 1);
    } finally { await h.service.cleanup(); }
});

test('raw layout rotation changes invalidate stable layout context', () => {
    const a = layoutEvidence(parseUiGraph(scene(), { screen: probe.size, rpcTarget: true }), probe);
    const b = layoutEvidence(parseUiGraph(scene().replace('rotation="0"', 'rotation="1"'), { screen: probe.size, rpcTarget: true }), probe);
    assert.equal(a.complete, true); assert.equal(b.complete, true); assert.notEqual(a.context, b.context);
});

