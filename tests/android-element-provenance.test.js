'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const vision = require('../VCPDistributedServer/Plugin/AndroidController/lib/vision');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { elementEvidence, layoutEvidence } = require('../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence');
const { waitForIdle } = require('../VCPDistributedServer/Plugin/AndroidController/lib/idle-wait');
const { harness } = require('./helpers/android-service-harness.cjs');

const screen = { width: 100, height: 200 };
const bounds = '[10,20][90,80]';
const foldedScene = `<hierarchy><node class="android.widget.FrameLayout" package="com.example" resource-id="com.example:id/go" text="Go" clickable="true" enabled="true" bounds="${bounds}"><node class="android.widget.Button" package="com.example" clickable="true" enabled="true" bounds="${bounds}"/></node></hierarchy>`;
const graphOf = xml => parseUiGraph(xml, { screen, rpcTarget: true });

async function serviceFor(xml) {
    let captures = 0;
    const h = await harness({ dump: () => xml, vision,
        client: { async probeScreen() { return { wakefulness: 'Awake', focus: { package: 'com.example', component: 'com.example/.Main' }, size: { ...screen } }; } },
        frames: { requireSharp: () => sharp, async captureOneShot() {
            captures++;
            return { raw: { data: Buffer.alloc(screen.width * screen.height * 4, 100), ...screen, channels: 4 } };
        } },
    });
    return { ...h, captures: () => captures };
}

const shot = (h, target) => h.service.processToolCall({ command: 'Observe', serial: 'A', mode: 'image', target: 'element', ...target, grid: false, format: 'png' });

test('production element screenshot accepts inherited wrapper id and label with exact inner provenance', async () => {
    const h = await serviceFor(foldedScene);
    try {
        const view = await h.service.processToolCall({ command: 'Observe', serial: 'A', mode: 'ui' });
        assert.equal(view.details.controls.length, 1);
        assert.equal(view.details.controls[0].id, 'com.example:id/go');
        assert.equal(view.details.controls[0].label, 'Go');
        assert.equal(view.details.controls[0].cls, 'Button');
        const result = await shot(h, { id: 'com.example:id/go' });
        assert.deepEqual(JSON.parse(JSON.stringify(result.details.element.visibleBounds)), { left: 10, top: 20, right: 90, bottom: 80 });
        assert.equal(h.captures(), 1);
        assert.equal(h.calls.some(call => call[0] === 'rpc' || (call[0] === 'adb' && call[1].includes('input'))), false);
    } finally { await h.service.cleanup(); }
});

test('folded same-bounds duplicate raw tuples are distinguished by exact raw identity', () => {
    const xml = `<hierarchy><node class="android.widget.Button" package="com.example" resource-id="com.example:id/go" text="Go" clickable="true" enabled="true" bounds="${bounds}"><node class="android.widget.Button" package="com.example" resource-id="com.example:id/go" text="Go" clickable="true" enabled="true" bounds="${bounds}"/></node></hierarchy>`;
    const graph = graphOf(xml);
    assert.equal(graph.controls.length, 1);
    assert.equal(graph.controls[0].rawNode, graph.rawRoot.children[0].children[0]);
    assert.ok(elementEvidence(graph, graph.controls[0], screen));
});

test('element evidence rejects missing and foreign provenance even with identical field tuples', () => {
    const scene = `<hierarchy><node class="android.widget.Button" package="com.example" resource-id="com.example:id/go" text="Go" clickable="true" enabled="true" bounds="${bounds}"/></hierarchy>`;
    const graph = graphOf(scene);
    const other = graphOf(scene);
    const node = graph.controls[0];
    assert.equal(elementEvidence(graph, { ...node }, screen), null);
    assert.equal(elementEvidence(graph, { ...node, rawNode: other.controls[0].rawNode }, screen), null);
});

test('element evidence still rejects changed bounds, package, class and disabled controls', () => {
    const graph = graphOf(foldedScene);
    const node = graph.controls[0];
    for (const change of [{ bounds: { ...node.bounds, right: 89 } }, { package: 'com.other' }, { cls: 'TextView' }, { enabled: false }]) {
        assert.equal(elementEvidence(graph, { ...node, rawNode: node.rawNode, ...change }, screen), null);
    }
    node.rawNode.attrs.enabled = 'false';
    assert.equal(elementEvidence(graph, node, screen), null);
});

for (const state of ['visible-to-user="false"', 'displayed="false"', 'enabled="false"']) {
    test(`raw ${state} still prevents element evidence`, () => {
        const graph = graphOf(`<hierarchy><node class="android.widget.Button" package="com.example" resource-id="com.example:id/go" text="Go" clickable="true" ${state} bounds="${bounds}"/></hierarchy>`);
        const rawNode = graph.rawRoot.children[0];
        assert.equal(elementEvidence(graph, { rawNode, bounds: { left: 10, top: 20, right: 90, bottom: 80 }, package: 'com.example', cls: 'Button', id: 'com.example:id/go', enabled: true }, screen), null);
    });
}

const probe = { wakefulness: 'Awake', focus: { package: 'com.example', component: 'com.example/.Main' }, size: screen };
const hiddenParentScene = (right, parentBounds = '[0,20][100,200]') => `<hierarchy><node class="android.widget.FrameLayout" package="com.example" bounds="[0,0][100,200]"><node class="android.widget.Button" package="com.example" resource-id="stable" text="Stable" clickable="true" bounds="[0,0][20,20]"/><node class="android.widget.FrameLayout" package="com.example" visible-to-user="false" bounds="${parentBounds}"><node class="android.widget.Button" package="com.example" resource-id="moving" text="Moving" clickable="true" visible-to-user="true" bounds="[0,30][${right},60]"/></node></node></hierarchy>`;

test('visible children of hidden parents remain complete layout and element evidence', () => {
    const graph = graphOf(hiddenParentScene(30));
    const moved = graphOf(hiddenParentScene(70));
    const node = graph.controls.find(control => control.id === 'moving');
    assert.ok(node);
    const before = layoutEvidence(graph, probe);
    const after = layoutEvidence(moved, probe);
    assert.equal(before.complete, true);
    assert.equal(after.complete, true);
    assert.notEqual(before.digest, after.digest);
    assert.deepEqual(elementEvidence(graph, node, screen).visibleBounds, node.bounds);
});

test('hidden nodes themselves are excluded from layout evidence without hiding visible children', () => {
    const before = layoutEvidence(graphOf(hiddenParentScene(30)), probe);
    const after = layoutEvidence(graphOf(hiddenParentScene(30, '[5,25][90,190]')), probe);
    assert.equal(before.complete, true);
    assert.equal(after.complete, true);
    assert.equal(before.digest, after.digest);
});

test('idle wait cannot declare continuously moving visible descendants of hidden parents stable', async () => {
    const frames = [30, 70].map(right => layoutEvidence(graphOf(hiddenParentScene(right)), probe));
    let time = 0;
    let samples = 0;
    const runtime = { now: () => time, check() {}, remainingMs: () => 1000 - time, async pause(ms) { time += ms; } };
    const result = await waitForIdle({ runtime, timeoutMs: 700, sample: async () => frames[samples++ % frames.length] });
    assert.deepEqual(result, { matched: false, idleMode: null, error: 'IDLE_TIMEOUT' });
    assert.equal(samples, 4);
});

test('hidden scroll ancestor still clips visible descendants geometrically', () => {
    const graph = graphOf(`<hierarchy><node class="android.widget.FrameLayout" package="com.example" visible-to-user="false" scrollable="true" bounds="[0,20][80,100]"><node class="android.widget.Button" package="com.example" resource-id="moving" text="Moving" clickable="true" visible-to-user="true" bounds="[10,10][90,70]"/></node></hierarchy>`);
    const node = graph.controls.find(control => control.id === 'moving');
    assert.ok(node);
    assert.deepEqual(elementEvidence(graph, node, screen).visibleBounds, { left: 10, top: 20, right: 80, bottom: 70 });
});
