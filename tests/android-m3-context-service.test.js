'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const p = () => ({ displayId: 0, rotation: 0, size: { width: 100, height: 200 }, wakefulness: 'Awake',
    keyguard: { showing: false, inputRestricted: false }, focus: { package: 'com.example', component: 'com.example/.Main', window: 'Main' } });
const tree = (label = 'Go', tail = 20, rotation = 0) => `<hierarchy rotation="${rotation}"><node package="com.example" class="android.widget.FrameLayout" bounds="[0,0][100,200]">${Array.from({ length: 70 }, (_, index) => `<node package="com.example" class="android.widget.Button" resource-id="com.example:id/n${index}" text="${label}${index}" enabled="true" clickable="true" bounds="[0,${index * 2}][${index === 69 ? tail : 20},${index * 2 + 2}]"/>`).join('')}</node></hierarchy>`;
const plain = value => JSON.parse(JSON.stringify(value));
async function setup(options = {}) {
    const current = p(), requests = [];
    const h = await harness({ config: { INTERACTION_POLICY: '{}', ...(options.config || {}) },
        client: { async probeScreen(serial, request) { requests.push(request); return options.probe ? options.probe(current, request) : plain(current); },
            async screenSize() { assert.fail('new context paths must not use cached screen dimensions'); } },
        ...(options.dump ? { dump: options.dump } : { dump: () => tree() }),
        ...(options.uiServer ? { uiServer: options.uiServer } : {}),
    });
    return { ...h, current, requests, get dumpCount() { return h.dumpCount; } };
}
const observe = (h, extra = {}) => h.service.processToolCall({ command: 'Observe', serial: 'A', ...extra });
const execute = (h, action, extra = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action, ...extra });
const writes = h => h.calls.filter(call => call[0] === 'rpc' && !['waitForIdle'].includes(call[1]) || call[0] === 'adb' && call[1].includes('input'));

test('Observe stable ignores dynamic text and samples complete raw layout at least 200ms apart', async () => {
    const times = [];
    const h = await setup({ dump(index) { times.push(Date.now()); return tree(`Clock${index}-`); } });
    try {
        const result = await observe(h, { stable: true, limit: 1 });
        assert.equal(result.details.stability, 'stable'); assert.equal(result.details.settled, true);
        assert.equal(result.details.actionable, true);
        assert.equal(result.details.controls.length, 1); assert.equal(times.length, 2);
        assert.ok(times[1] - times[0] >= 190);
        for (const request of h.requests) { assert.equal(request.fresh, true); assert.ok(request.timeoutMs > 0); }
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('Observe stable sees geometry changes beyond public output limit', async () => {
    const h = await setup({ dump: index => tree('Go', index ? 40 : 20) });
    try {
        const result = await observe(h, { stable: true, limit: 1 });
        assert.equal(result.details.stability, 'changing'); assert.equal(result.details.settled, false);
        assert.equal(result.details.actionable, false);
        for (const action of [{ command: 'Tap' }, { command: 'Drag', target: { id: 'com.example:id/n1' } }]) {
            await assert.rejects(execute(h, { ...action, index: 0, snapshotId: result.details.snapshotId }), { code: 'STALE_SNAPSHOT' });
        }
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('Observe stable cannot wash a changed foreground window green', async () => {
    let reads = 0;
    const h = await setup({ probe(current) { if (++reads >= 3) current.focus.window = 'Dialog'; return plain(current); } });
    try {
        const result = await observe(h, { stable: true });
        assert.notEqual(result.details.stability, 'stable'); assert.notEqual(result.details.settled, true);
    } finally { await h.service.cleanup(); }
});

for (const [name, change] of Object.entries({ activity: q => { q.focus.component = 'com.example/.Other'; },
    window: q => { q.focus.window = 'Dialog'; }, rotation: q => { q.rotation = 2; },
    size: q => { q.size.width = 200; }, display: q => { q.displayId = 1; }, unknownUnlock: q => { delete q.keyguard.inputRestricted; } })) {
    test(`indexed old snapshot refuses ${name} with unchanged tree and no input`, async () => {
        const h = await setup();
        try {
            const first = await observe(h); change(h.current);
            await assert.rejects(execute(h, { command: 'Tap', index: 0, snapshotId: first.details.snapshotId }), { code: 'STALE_SNAPSHOT' });
            assert.equal(writes(h).length, 0);
        } finally { await h.service.cleanup(); }
    });
}

for (const [name, change] of Object.entries({ display: q => { delete q.displayId; }, rotation: q => { delete q.rotation; },
    window: q => { delete q.focus.window; }, unlock: q => { delete q.keyguard; }, asleep: q => { q.wakefulness = 'Asleep'; } })) {
    test(`semantic target fails closed on missing fresh ${name}; legacy focus/size cannot authorize`, async () => {
        const h = await setup();
        try {
            change(h.current);
            await assert.rejects(execute(h, { command: 'Tap', id: 'com.example:id/n0' }), { code: 'CONTEXT_UNPROVEN' });
            assert.equal(writes(h).length, 0); assert.equal(h.dumpCount, 0);
        } finally { await h.service.cleanup(); }
    });
}

test('semantic acquisition rechecks foreground after dump and never dispatches stale content', async () => {
    let h;
    h = await setup({ dump() { h.current.focus.window = 'Dialog'; return tree(); } });
    try {
        await assert.rejects(execute(h, { command: 'Tap', id: 'com.example:id/n0' }), { code: 'UI_CONTEXT_CHANGED' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('unproven Observe snapshot never turns into an indexed action after context recovers', async () => {
    const h = await setup();
    try {
        delete h.current.keyguard;
        const first = await observe(h);
        assert.equal(first.details.actionable, false);
        h.current.keyguard = { showing: false, inputRestricted: false };
        await assert.rejects(execute(h, { command: 'Tap', index: 0, snapshotId: first.details.snapshotId }), { code: 'STALE_SNAPSHOT' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('observing context loss revokes both semantic and pixel credentials even after recovery', async () => {
    const h = await setup();
    try {
        const first = await observe(h);
        const image = await observe(h, { mode: 'image' });
        assert.equal(typeof image.details.frameId, 'string');
        delete h.current.keyguard;
        await observe(h);
        h.current.keyguard = { showing: false, inputRestricted: false };
        await assert.rejects(execute(h, { command: 'Tap', x: 10, y: 20, frameId: image.details.frameId }), { code: 'STALE_FRAME' });
        await assert.rejects(execute(h, { command: 'Tap', index: 0, snapshotId: first.details.snapshotId }), { code: 'STALE_SNAPSHOT' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('Wait idle matches Observe stable text-insensitive complete raw-layout strength', async () => {
    const h = await setup({ dump: index => tree(`Tick${index}-`) });
    try {
        const result = await execute(h, { command: 'Wait', mode: 'idle' }, { waitTimeoutMs: 1000 });
        assert.equal(result.details.execution.outcome, 'verified'); assert.equal(result.details.idleMode, 'layout_stable');
        assert.equal(h.dumpCount, 2); assert.equal(writes(h).length, 0);
        assert.ok(h.requests.every(request => request.fresh === true && request.timeoutMs <= 1000));
    } finally { await h.service.cleanup(); }
});

test('Wait idle refuses unknown explicit unlock without dump or wake', async () => {
    const h = await setup();
    try {
        delete h.current.keyguard.inputRestricted;
        const result = await execute(h, { command: 'Wait', mode: 'idle' }, { waitTimeoutMs: 1000 });
        assert.equal(result.details.execution.outcome, 'unknown'); assert.equal(result.details.idleMode, null);
        assert.equal(h.dumpCount, 0); assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

for (const command of ['Tap', 'Drag']) test(`${command} rejects context change between prepared semantic target and final write gate`, async () => {
    let dumps = 0, afterDumpReads = 0;
    const h = await setup({ dump() { dumps++; return tree(); }, probe(current) {
        if (dumps === 1 && ++afterDumpReads > 1) current.focus.window = 'Dialog';
        return plain(current);
    }, uiServer: { ok: true, xml() { dumps++; return tree(); } } });
    try {
        const action = command === 'Tap' ? { command, id: 'com.example:id/n0' }
            : { command, id: 'com.example:id/n0', target: { id: 'com.example:id/n1' } };
        await assert.rejects(execute(h, action), { code: 'POLICY_CONTEXT_CHANGED' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('pixel input cannot dispatch when final policy layout sampling changes the frame context', async () => {
    let h, change = false;
    h = await setup({ uiServer: { ok: true, xml() {
        if (change) h.current.focus.window = 'Dialog';
        return tree();
    } } });
    try {
        const image = await observe(h, { mode: 'image' });
        change = true;
        await assert.rejects(execute(h, { command: 'Tap', x: 10, y: 20, frameId: image.details.frameId }), { code: 'POLICY_CONTEXT_CHANGED' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('a transient window observed inside element preparation revokes the indexed snapshot on context recovery', async () => {
    let imagePhase = false, imageReads = 0;
    const h = await setup({ probe(current) {
        const next = plain(current);
        if (imagePhase && ++imageReads === 2) next.focus.window = 'Transient';
        return next;
    } });
    try {
        const first = await observe(h);
        imagePhase = true;
        await assert.rejects(observe(h, { mode: 'image', target: 'element', index: 0, snapshotId: first.details.snapshotId }), { code: 'STALE_SNAPSHOT' });
        imagePhase = false;
        await assert.rejects(execute(h, { command: 'Tap', index: 0, snapshotId: first.details.snapshotId }), { code: 'STALE_SNAPSHOT' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('element tracker probe transport errors propagate unchanged and revoke the old snapshot', async () => {
    let imagePhase = false, imageReads = 0;
    const failure = Object.assign(new Error('drained probe failure'), { code: 'ADB_TIMEOUT' });
    const h = await setup({ probe(current) {
        if (imagePhase && ++imageReads === 2) throw failure;
        return plain(current);
    } });
    try {
        const first = await observe(h);
        imagePhase = true;
        await assert.rejects(observe(h, { mode: 'image', target: 'element', index: 0, snapshotId: first.details.snapshotId }), error => error === failure && error.code === 'ADB_TIMEOUT');
        imagePhase = false;
        await assert.rejects(execute(h, { command: 'Tap', index: 0, snapshotId: first.details.snapshotId }), { code: 'STALE_SNAPSHOT' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});
