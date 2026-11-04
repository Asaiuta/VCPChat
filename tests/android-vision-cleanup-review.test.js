'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vision = require('../VCPDistributedServer/Plugin/AndroidController/lib/vision');
const { createElementShot } = require('../VCPDistributedServer/Plugin/AndroidController/lib/element-shot');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');

const screen = { width: 100, height: 200 };

for (const value of [Infinity, -Infinity, NaN, 1.5, '10px', '', ' ', true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    test(`crop rejects malformed geometry ${String(value)} rather than defaulting or truncating`, () => {
        for (const key of ['left', 'top', 'width', 'height']) {
            assert.throws(() => vision.normalizeRegion({ width: 20, height: 30, [key]: value }, screen), /裁剪区域无效/);
        }
    });
}

test('crop rejects non-rectangle inputs and non-integer screen dimensions', () => {
    for (const region of [false, 1, 'rectangle', []]) {
        assert.throws(() => vision.normalizeRegion(region, screen), /裁剪区域无效/);
    }
    for (const value of [Infinity, NaN, 100.5, '100', 0, -1]) {
        for (const key of ['width', 'height']) {
            assert.throws(() => vision.normalizeRegion(null, { ...screen, [key]: value }), /屏幕尺寸/);
        }
    }
});

test('crop retains numeric strings, aliases, defaults and endpoint clipping', () => {
    assert.deepEqual(vision.normalizeRegion({ x: '-10', y: '20', width: '30', height: '40' }, screen),
        { left: 0, top: 20, width: 20, height: 40 });
    assert.deepEqual(vision.normalizeRegion({ left: -10, top: 20 }, screen),
        { left: 0, top: 20, width: 100, height: 180 });
    assert.deepEqual(vision.normalizeRegion(undefined, screen), { left: 0, top: 0, ...screen });
});

for (const target of ['id', 'selector', 'index']) {
    test(`element ${target} computes whole-layout evidence only for indexed targeting`, async () => {
        const graph = parseUiGraph('<hierarchy rotation="0"><node class="android.widget.Button" package="com.example" resource-id="com.example:id/icon" text="Icon" clickable="true" enabled="true" bounds="[10,20][60,70]"/></hierarchy>',
            { screen, rpcTarget: true });
        const node = graph.controls[0];
        let layoutCalls = 0;
        let layout = 'initial';
        const shot = createElementShot({
            runtime: { failure: (code, message) => Object.assign(new Error(message), { code }), remainingMs: () => 1000, check() {} },
            vision, prepareTarget: async () => ({ node }), getRecord: () => ({ graph, limit: 40 }),
            captureGraph: async () => graph, resolveSelector: () => node,
            intOf: Number, validateSelector() {}, graphLayout() { layoutCalls++; return layout; },
        });
        const client = { async probeScreen() { return { wakefulness: 'Awake', focus: { package: 'com.example', component: 'com.example/.Main' } }; },
            async screenSize() { return { ...screen }; } };
        const args = { target: 'element', ...(target === 'index' ? { index: 0, snapshotId: 'snapshot' }
            : target === 'id' ? { id: node.id } : { selector: { id: node.id } }) };
        const request = { client, serial: 'A', size: screen, args };
        const baseline = await shot.prepare(request);
        assert.equal(baseline.rotation, '0');
        assert.deepEqual(baseline.element.elementBounds, node.bounds);
        await shot.verify({ ...request, baseline });
        assert.equal(layoutCalls, target === 'index' ? 2 : 0);
        layout = 'changed';
        if (target === 'index') {
            await assert.rejects(shot.verify({ ...request, baseline }), { code: 'ELEMENT_TARGET_CHANGED' });
        } else {
            await shot.verify({ ...request, baseline });
            assert.equal(layoutCalls, 0);
        }
    });
}
