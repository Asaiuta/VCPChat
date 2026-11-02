'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const hubModule = require('../VCPDistributedServer/Plugin/AndroidController/lib/frame-hub');
const { FrameHub } = hubModule;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function rawFrame({ short = false, format = 1 } = {}) {
    const buffer = Buffer.alloc(short ? 19 : 20);
    buffer.writeUInt32LE(1, 0);
    buffer.writeUInt32LE(1, 4);
    buffer.writeUInt32LE(format, 8);
    return buffer;
}

function fakeSharp() {
    return {
        removeAlpha() { return this; },
        resize() { return this; },
        jpeg() { return this; },
        png() { return this; },
        async metadata() { return { width: 1000, height: 2000 }; },
        async toBuffer() { return Buffer.alloc(80); },
    };
}

function makeHub(execOutBinary = async () => rawFrame(), options = {}) {
    return new FrameHub({ adb: { execOutBinary }, sharp: fakeSharp, logger: { warn() {} }, ...options });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('poolSize and active are removed, including exports, configure and status', () => {
    const hub = makeHub(undefined, { poolSize: 8 });
    hub.configure({ poolSize: 4 });
    for (const key of ['poolSize', 'active']) {
        assert.equal(Object.hasOwn(hub, key), false, key);
        assert.equal(Object.hasOwn(hub.status(), key), false, `status.${key}`);
    }
    assert.equal(Object.hasOwn(hubModule, 'DEFAULT_POOL_SIZE'), false);
});

test('capture shares one promise and repeated loop pumps never overlap ADB', async (t) => {
    const pending = deferred();
    let calls = 0;
    const hub = makeHub(() => { calls += 1; return pending.promise; });
    t.after(() => hub.stop());
    let deliveries = 0;
    hub.subscribe(() => { deliveries += 1; });
    const first = hub.capture();
    assert.equal(hub.capture(), first);
    for (let i = 0; i < 10; i += 1) hub._pump();
    assert.equal(calls, 1);
    pending.resolve(rawFrame());
    await first;
    await flush();
    assert.equal(deliveries, 1);
});

test('effective FPS uses published timestamps including idle gaps, not capture durations', async (t) => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const hub = makeHub();
    t.after(() => hub.stop());
    assert.equal(hub.effectiveFps(), 0);
    await hub.capture();
    assert.equal(hub.effectiveFps(), 0);
    now = 1500;
    await hub.capture();
    assert.equal(hub.effectiveFps(), 2);
    now = 3000;
    await hub.capture();
    assert.equal(hub.effectiveFps(), 1);
    now = 3200;
    await hub.captureOneShot({ serial: 'one-shot' });
    assert.equal(hub.effectiveFps(), 1);
});

for (const mode of ['raw', 'png']) {
    test(`${mode} one-shot preserves requested serial, dimensions and format without publishing`, async () => {
        const calls = [];
        const hub = makeHub(async (args, options) => {
            calls.push({ args, options });
            return mode === 'raw' ? rawFrame() : Buffer.alloc(80);
        }, { captureMode: mode });
        let published = 0;
        hub.on('frame', () => { published += 1; });
        const frame = await hub.captureOneShot({ serial: 'requested-device', maxWidth: 200, format: 'png' });
        assert.equal(calls[0].options.serial, 'requested-device');
        assert.equal(frame.mime, 'image/png');
        assert.equal(frame.width, mode === 'raw' ? 1 : 200);
        assert.equal(hub.latestOrNull(), null);
        assert.equal(published, 0);
        assert.equal(hub.effectiveFps(), 0);
    });
}

test('raw short-read retries retain serial and raw pixel path avoids sharp', async () => {
    const serials = [];
    const hub = makeHub(async (_args, options) => {
        serials.push(options.serial);
        return rawFrame({ short: serials.length < 3 });
    }, { sharp: () => { throw new Error('raw pixels must not encode'); } });
    const frame = await hub.captureOneShot({ serial: 'retry-device', raw: true });
    assert.deepEqual(serials, ['retry-device', 'retry-device', 'retry-device']);
    assert.equal(frame.source, 'raw-pixels');
    assert.equal(frame.raw.data.length, 4);
    assert.equal(hub.lastReadRetries, 2);
});

test('auto raw failure falls back to PNG on the same requested device', async () => {
    const calls = [];
    const hub = makeHub(async (args, options) => {
        calls.push({ args, serial: options.serial });
        return calls.length === 1 ? rawFrame({ format: 2 }) : Buffer.alloc(80);
    });
    const frame = await hub.captureOneShot({ serial: 'fallback-device' });
    assert.deepEqual(calls.map((call) => call.serial), ['fallback-device', 'fallback-device']);
    assert.deepEqual(calls[1].args, ['exec-out', 'screencap', '-p']);
    assert.equal(frame.source, 'png');
    assert.equal(hub.latestOrNull(), null);
});

for (const mode of ['raw', 'png']) {
    test(`stop blocks old ${mode} inflight publication, events and sink delivery`, async () => {
        const pending = deferred();
        const hub = makeHub(() => pending.promise, { captureMode: mode });
        let events = 0;
        let sinks = 0;
        hub.on('frame', () => { events += 1; });
        hub.subscribe(() => { sinks += 1; });
        const flight = hub.capture();
        hub.stop();
        pending.resolve(mode === 'raw' ? rawFrame() : Buffer.alloc(80));
        await flight;
        await flush();
        assert.equal(hub.latestOrNull(), null);
        assert.equal(events, 0);
        assert.equal(sinks, 0);
        assert.equal(hub.timer, null);
        assert.equal(hub.effectiveFps(), 0);
    });
}

test('stop blocks old failure events and prevents scheduling retry after inflight rejection', async (t) => {
    let retries = 0;
    t.mock.method(global, 'setTimeout', () => { retries += 1; return { unref() {} }; });
    const pending = deferred();
    const hub = makeHub(() => pending.promise, { captureMode: 'png' });
    hub.consecutiveFailures = 4;
    let errors = 0;
    hub.on('frame-error', () => { errors += 1; });
    hub.subscribe(() => {});
    const flight = hub.capture();
    hub.stop();
    pending.reject(new Error('fake ADB failure'));
    await assert.rejects(flight, /fake ADB failure/);
    await flush();
    assert.equal(errors, 0);
    assert.equal(retries, 0);
});

test('stop clears an already scheduled failure retry', async (t) => {
    const retry = { unref() {} };
    const cleared = [];
    t.mock.method(global, 'setTimeout', () => retry);
    t.mock.method(global, 'clearTimeout', (timer) => { cleared.push(timer); });
    const hub = makeHub(async () => { throw new Error('fake ADB failure'); }, { captureMode: 'png' });
    hub.consecutiveFailures = 4;
    hub.subscribe(() => {});
    await flush();
    hub.stop();
    assert.deepEqual(cleared, [retry]);
    assert.equal(hub.timer, null);
});

for (const releaseOldFirst of [false, true]) {
    test(`selection invalidation isolates old flight (old finishes first: ${releaseOldFirst})`, async () => {
        const old = deferred();
        const fresh = deferred();
        const calls = [];
        const hub = makeHub((_args, options) => {
            calls.push(options.serial);
            return options.serial === 'A' ? old.promise : fresh.promise;
        }, { captureMode: 'png' });
        hub.adb.serial = 'A';
        const events = [];
        hub.on('frame', (frame) => events.push(frame));
        const a = hub.capture();
        hub.adb.serial = 'B';
        hub.invalidateSelection();
        assert.equal(hub.latestOrNull(), null);
        const b = hub.capture();
        assert.notEqual(a, b);
        assert.deepEqual(calls, ['A', 'B']);
        if (releaseOldFirst) {
            old.resolve(Buffer.alloc(80));
            await a;
            assert.equal(hub.capture(), b, 'old finally must not clear new flight');
            assert.equal(events.length, 0);
        }
        fresh.resolve(Buffer.alloc(80));
        const bFrame = await b;
        if (!releaseOldFirst) {
            old.resolve(Buffer.alloc(80));
            await a;
        }
        assert.equal(hub.latestOrNull(), bFrame);
        assert.deepEqual(events, [bFrame]);
        assert.equal(hub.effectiveFps(), 0);
        hub.stop();
    });
}

test('selection invalidation clears cached frames, FPS and device-specific fallback', async () => {
    const hub = makeHub(async (args) => args.includes('-p') ? Buffer.alloc(80) : rawFrame({ format: 2 }));
    await hub.capture();
    assert.equal(hub.effectiveMode, 'png');
    hub.invalidateSelection();
    assert.equal(hub.latestOrNull(), null);
    assert.equal(hub.effectiveFps(), 0);
    assert.equal(hub.effectiveMode, 'raw');
    assert.equal(hub.fallbackCount, 0);
});

test('default capture serial is snapshotted through short read and PNG fallback', async () => {
    const calls = [];
    const hub = makeHub(async (args, options) => {
        calls.push(options.serial);
        hub.adb.serial = 'B';
        if (args.includes('-p')) return Buffer.alloc(80);
        return rawFrame({ short: true });
    });
    hub.adb.serial = 'A';
    await hub.capture();
    assert.deepEqual(calls, ['A', 'A', 'A', 'A']);
});
