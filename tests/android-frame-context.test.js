'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const context = () => ({ focus: { package: 'com.example', component: 'com.example/.Main', window: 'Window{abc u0 com.example/.Main}' },
    size: { width: 100, height: 200 }, rotation: 0, displayId: 0,
    keyguard: { showing: false, inputRestricted: false }, wakefulness: 'Awake' });
async function setup(options = {}) {
    let probe = context();
    let reads = 0;
    const h = await harness({ client: { async probeScreen(serial, request) { reads++; return options.probe ? options.probe(probe, request) : structuredClone(probe); } },
        frames: { async captureOneShot() { if (options.capture) options.capture(probe); return { width: 100, height: 200 }; } },
        vision: { DEFAULT_MAX_WIDTH: 1080, describeMapping() { return ''; }, async buildVisionFrame({ screen }) {
            if (options.build) options.build(probe);
            return { sourceWidth: options.sourceWidth ?? screen.width, sourceHeight: screen.height, width: 100, height: 200,
                byteLength: 1, dataUrl: 'data:image/jpeg;base64,AA==', mapping: { region: {}, screen } };
        } }, uiServer: { ok: true, ...(options.uiServer || {}) } });
    return { ...h, probe, get reads() { return reads; } };
}
const shot = h => h.service.processToolCall({ command: 'Observe', mode: 'image', serial: 'A' });
const input = (h, frameId, command = 'Tap') => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
    action: { command, x: 10, y: 20, ...(command === 'Swipe' ? { x1: 10, y1: 20 } : {}), x2: 30, y2: 40, frameId } });
const mutations = h => h.calls.filter(call => call[0] === 'rpc' || (call[0] === 'adb' && call[1].includes('input')));
const changes = {
    package: p => { p.focus.package = 'other.app'; },
    activity: p => { p.focus.component = 'com.example/.Other'; },
    window: p => { p.focus.window = 'Window{different}'; },
    rotation180: p => { p.rotation = 2; },
    size: p => { p.size.width = 200; },
    asleep: p => { p.wakefulness = 'Asleep'; },
    locked: p => { p.keyguard.showing = true; },
    restricted: p => { p.keyguard.inputRestricted = true; },
    display: p => { p.displayId = 1; },
    unknownRotation: p => { p.rotation = null; },
    unknownKeyguard: p => { p.keyguard = null; },
    unknownFocus: p => { p.focus = null; },
};
for (const [name, change] of Object.entries(changes)) test(`frame consumption refuses ${name} without dispatch`, async () => {
    const h = await setup();
    try {
        const frameId = (await shot(h)).details.frameId;
        assert.equal(typeof frameId, 'string');
        change(h.probe);
        await assert.rejects(input(h, frameId), { code: 'STALE_FRAME' });
        assert.equal(mutations(h).length, 0);
        Object.assign(h.probe, context());
        await assert.rejects(input(h, frameId), { code: 'STALE_FRAME' });
    } finally { await h.service.cleanup(); }
});
// Tap is covered above by rotation180, including rejection after context recovery.
for (const command of ['LongPress', 'DoubleTap', 'Swipe', 'Drag']) test(`${command} rejects same-size rotation before any input`, async () => {
    const h = await setup();
    try {
        const frameId = (await shot(h)).details.frameId;
        h.probe.rotation = 2;
        await assert.rejects(input(h, frameId, command), { code: 'STALE_FRAME' });
        assert.equal(mutations(h).length, 0);
    } finally { await h.service.cleanup(); }
});
for (const phase of ['capture', 'build']) test(`context changes during ${phase}: image remains viewable but credential withheld`, async () => {
    const h = await setup({ [phase]: changes.rotation180 });
    try {
        const result = await shot(h);
        assert.equal(result.details.frameId, null);
        assert.ok(result.content.some(item => item.type === 'image_url'));
    } finally { await h.service.cleanup(); }
});
test('source size mismatch cannot issue a coordinate credential', async () => {
    const h = await setup({ sourceWidth: 200 });
    try { assert.equal((await shot(h)).details.frameId, null); }
    finally { await h.service.cleanup(); }
});
test('missing context preserves screenshot visibility without credential', async () => {
    const h = await setup({ probe: () => ({ size: { width: 100, height: 200 } }) });
    try { assert.equal((await shot(h)).details.frameId, null); }
    finally { await h.service.cleanup(); }
});
test('stable context supports exactly one pixel action', async () => {
    const h = await setup();
    try {
        const frameId = (await shot(h)).details.frameId;
        assert.equal((await input(h, frameId)).details.execution.outcome, 'dispatched');
        await assert.rejects(input(h, frameId), { code: 'STALE_FRAME' });
        assert.equal(mutations(h).length, 1);
    } finally { await h.service.cleanup(); }
});
test('fresh logical dimensions permit landscape coordinates despite stale wm cache', async () => {
    const h = await setup();
    try {
        h.probe.rotation = 1; h.probe.size = { width: 200, height: 100 };
        const frameId = (await shot(h)).details.frameId;
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', x: 150, y: 50, frameId } });
        assert.equal(result.details.execution.outcome, 'dispatched');
    } finally { await h.service.cleanup(); }
});


test('failed replacement capture revokes the previously issued frame', async () => {
    let fail = false;
    const h = await setup({ capture() { if (fail) throw new Error('capture failed'); } });
    try {
        const frameId = (await shot(h)).details.frameId;
        fail = true;
        await assert.rejects(shot(h), /capture failed/);
        await assert.rejects(input(h, frameId), { code: 'STALE_FRAME' });
        assert.equal(mutations(h).length, 0);
    } finally { await h.service.cleanup(); }
});
test('image-only replacement revokes old permission even after context recovers', async () => {
    const h = await setup();
    try {
        const frameId = (await shot(h)).details.frameId;
        h.probe.rotation = null;
        assert.equal((await shot(h)).details.frameId, null);
        h.probe.rotation = 0;
        await assert.rejects(input(h, frameId), { code: 'STALE_FRAME' });
    } finally { await h.service.cleanup(); }
});
test('Observe screenshot uses the same context-bound credential pipeline', async () => {
    const h = await setup();
    try {
        const observed = await h.service.processToolCall({ command: 'Observe', serial: 'A', screenshot: true });
        const frameId = observed.details.image.frameId;
        assert.equal(typeof frameId, 'string');
        h.probe.focus.component = 'com.example/.Other';
        await assert.rejects(input(h, frameId), { code: 'STALE_FRAME' });
        assert.equal(mutations(h).length, 0);
    } finally { await h.service.cleanup(); }
});
test('mixed semantic source and pixel destination Drag rechecks frame context', async () => {
    const h = await setup();
    try {
        const frameId = (await shot(h)).details.frameId;
        h.probe.rotation = 2;
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
            action: { command: 'Drag', id: 'com.example:id/go', x2: 30, y2: 40, frameId } }), { code: 'STALE_FRAME' });
        assert.equal(mutations(h).length, 0);
    } finally { await h.service.cleanup(); }
});


for (const [rotation, pkg] of [[2, 'com.example'], [0, 'other.app']]) test(`mixed Drag rejects conflicting tree rotation=${rotation} package=${pkg}`, async () => {
    const h = await setup({ uiServer: { xml: `<hierarchy rotation="${rotation}"><node class="android.widget.Button" package="${pkg}" resource-id="com.example:id/go" text="Go" clickable="true" enabled="true" bounds="[0,0][80,40]"/></hierarchy>` } });
    try {
        const frameId = (await shot(h)).details.frameId;
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
            action: { command: 'Drag', id: 'com.example:id/go', x2: 30, y2: 40, frameId } }), { code: 'STALE_FRAME' });
        assert.equal(mutations(h).length, 0);
    } finally { await h.service.cleanup(); }
});
test('expired pixel credential fails before device discovery or fresh probe', async t => {
    const h = await setup();
    try {
        const frameId = (await shot(h)).details.frameId;
        let discoveries = 0;
        h.client.devices = async () => { discoveries++; return [{ serial: 'A', state: 'device' }]; };
        const beforeReads = h.reads;
        const now = Date.now();
        t.mock.method(Date, 'now', () => now + 16000);
        await assert.rejects(input(h, frameId), { code: 'STALE_FRAME' });
        assert.equal(discoveries, 0);
        assert.equal(h.reads, beforeReads);
        assert.equal(mutations(h).length, 0);
    } finally { await h.service.cleanup(); }
});


test('credential expiring during fresh probe cannot dispatch', async t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let consume = false;
    const h = await setup({ probe(p) { if (consume) now += 16000; return structuredClone(p); } });
    try {
        const frameId = (await shot(h)).details.frameId;
        consume = true;
        await assert.rejects(input(h, frameId), { code: 'STALE_FRAME' });
        assert.equal(mutations(h).length, 0);
    } finally { await h.service.cleanup(); }
});
test('trusted abort during fresh frame check never dispatches', async () => {
    const controller = new AbortController();
    let consume = false;
    const h = await setup({ probe(p, request) {
        if (consume) { assert.ok(request.signal); controller.abort(); }
        return structuredClone(p);
    } });
    try {
        const frameId = (await shot(h)).details.frameId;
        consume = true;
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', x: 10, y: 20, frameId } }, { signal: controller.signal }), { code: 'STEP_ABORTED' });
        assert.equal(mutations(h).length, 0);
    } finally { await h.service.cleanup(); }
});
test('unknown display and wm size use image dimensions only for viewing', async () => {
    const h = await setup({ probe: () => ({}) });
    h.client.screenSize = async () => null;
    try {
        const result = await shot(h);
        assert.equal(result.details.frameId, null);
        assert.deepEqual(JSON.parse(JSON.stringify(result.details.screen)), { width: 100, height: 200 });
        assert.equal(result.details.image.actionable, false);
        assert.equal(result.details.image.reason, 'CONTEXT_UNKNOWN');
    } finally { await h.service.cleanup(); }
});
