'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const inputs = h => h.calls.filter(([kind, args]) => kind === 'adb' && args[1] === 'input');

test('unchanged display URL does not save application sources', async () => {
    let reads = 0;
    await harness({ displayUrl: 'http://127.0.0.1:9999', services: { loomManager: {
        manifests: new Map([['android-mirror', { startUrl: 'http://127.0.0.1:9999/' }]]),
        async readSources() { reads++; },
        async saveApp() { assert.fail('unchanged URL must not save'); },
    } } });
    assert.equal(reads, 0);
});

test('unreadable application sources do not get overwritten by empty defaults', async () => {
    let saves = 0;
    await harness({ displayUrl: 'http://127.0.0.1:9999', services: { loomManager: {
        manifests: new Map([['android-mirror', { startUrl: 'http://127.0.0.1:1' }]]),
        async readSources() { throw new Error('read failed'); },
        async saveApp() { saves++; },
    } } });
    assert.equal(saves, 0);
});

for (const command of ['Tap', 'Click', 'Swipe', 'Scroll', 'LongPress', 'InputText', 'Type', 'KeyEvent', 'PressKey', 'LaunchApp', 'KillApp', 'System', 'ListDevices', 'Devices', 'ListPackages', 'Screenshot', 'Capture', 'Connect', 'Disconnect', 'StartDisplay', 'StopDisplay', 'DisplayStatus', 'Arbitrate', 'ApiQuery', 'ApiCapabilities', 'SystemCapabilities']) {
    test(`only the four public entry points are accepted: reject ${command}`, async () => {
        const h = await harness();
        await assert.rejects(h.service.processToolCall({ command }), /不支持的 command/);
        assert.equal(h.calls.length, 0);
    });
}

for (const value of [true, false, 1.6, '1.6', [], {}, '0x10', '1e1', NaN, Infinity]) {
    test(`pixel coordinates reject non-integers without consuming a frame: ${String(value)}`, async () => {
        const h = await harness();
        const shot = await h.service.processToolCall({ command: 'Observe', mode: 'image' });
        const frameId = shot.details.frameId;
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', x: value, y: 2, frameId } }), { code: 'INVALID_ARGUMENT' });
        assert.equal(inputs(h).length, 0);
        await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', x: '1', y: '2', frameId } });
        assert.equal(inputs(h).length, 1);
    });
}

for (const command of ['LongPress', 'Swipe']) {
    test(`${command} rejects invalid duration and coordinates before input`, async () => {
        const h = await harness();
        const shot = await h.service.processToolCall({ command: 'Observe', mode: 'image' });
        const action = { command, x: 1, y: 2, x1: 1, y1: 2, x2: 3, y2: 4, frameId: shot.details.frameId };
        for (const duration of [true, 1.5, 0, 10001]) {
            await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { ...action, duration } }), { code: 'INVALID_ARGUMENT' });
            assert.equal(inputs(h).length, 0);
        }
    });
}

for (const [command, duration] of [['Swipe', 1], ['Swipe', 10000], ['LongPress', 300], ['LongPress', 10000]]) {
    test(`${command} accepts duration boundary ${duration}`, async () => {
        const h = await harness();
        const shot = await h.service.processToolCall({ command: 'Observe', mode: 'image' });
        await h.service.processToolCall({ command: 'ExecuteStep', action: { command, duration, x: 1, y: 2, x1: 1, y1: 2, x2: 3, y2: 4, frameId: shot.details.frameId } });
        assert.equal(inputs(h).length, 1);
        assert.equal(inputs(h)[0][1].at(-1), String(duration));
    });
}

for (const command of ['Click', 'Type', 'PressKey']) {
    test(`removed action alias ${command} does not dispatch`, async () => {
        const h = await harness();
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command } }), { code: 'INVALID_ARGUMENT' });
        assert.equal(inputs(h).length, 0);
    });
}

test('public package reads and display management cannot interrupt a leased action', async () => {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ run: async args => { if (args[1] === 'input') { entered(); await gate; } } });
    const pending = h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' } });
    await started;
    try {
        await assert.rejects(h.service.processToolCall({ command: 'Describe', topic: 'packages' }), { code: 'DEVICE_BUSY' });
        for (const operation of ['startDisplay', 'stopDisplay', 'disconnect']) {
            await assert.rejects(h.service.processToolCall({ command: 'Manage', operation }), { code: 'DEVICE_BUSY' });
        }
    } finally { release(); }
    await pending;
});

for (const [key, values] of [
    ['limit', [true, false, [1], '0x10', '1e1', '', null, 1.5, 0, 501]],
    ['maxWidth', [[100], '0x100', '1e2', 63, 4097]],
    ['quality', [[82], '0x52', '8.2e1', 9, 96]],
]) {
    for (const value of values) test(`afterObserve rejects ${key}=${JSON.stringify(value)} before input`, async () => {
        const h = await harness();
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve: { [key]: value } }), { code: 'INVALID_ARGUMENT' });
        assert.equal(inputs(h).length, 0);
    });
}

for (const value of [1, '1', 500, '500']) test(`afterObserve accepts decimal integer limit ${JSON.stringify(value)}`, async () => {
    const h = await harness();
    const afterObserve = Object.freeze({ limit: value, maxWidth: '1080', quality: '82' });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' }, afterObserve });
    assert.equal(inputs(h).length, 1);
    assert.equal(result.details.observation.status, 'observed');
    assert.equal(afterObserve.limit, value);
});

test('invalid final afterObserve integer rejects the entire sequence before input', async () => {
    const h = await harness();
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', steps: [{ action: { command: 'KeyEvent', key: 'back' } }], afterObserve: { limit: true } }), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
});

function rotatingDisplay({ failInitial = false } = {}) {
    let attempts = 0;
    return {
        server: null, actualPort: null,
        async start() {
            attempts++;
            if (failInitial && attempts === 1) throw new Error('bind failed');
            this.server = {};
            this.actualPort = 32000 + attempts;
        },
        async stop() { this.server = null; this.actualPort = null; },
        url() { return this.server ? `http://127.0.0.1:${this.actualPort}` : null; },
    };
}

function loomSources() {
    const source = { manifest: { id: 'android-mirror', startUrl: 'http://127.0.0.1:1', name: 'Custom' }, css: '.custom{}', js: 'window.custom=true;' };
    const saved = [];
    const manager = {
        manifests: new Map([['android-mirror', source.manifest]]),
        async readSources() { return { ...source, manifest: manager.manifests.get('android-mirror') }; },
        async saveApp(payload) { saved.push(payload); manager.manifests.set('android-mirror', payload.manifest); },
    };
    return { source, saved, manager };
}

test('display restart syncs the new URL preserving current application sources, running start is a no-op', async () => {
    const streamServer = rotatingDisplay();
    const { source, saved, manager } = loomSources();
    const h = await harness({ streamServer, services: { loomManager: manager } });
    assert.equal(saved.length, 1);
    await h.service.processToolCall({ command: 'Manage', operation: 'startDisplay' });
    assert.equal(saved.length, 1);
    await h.service.processToolCall({ command: 'Manage', operation: 'stopDisplay' });
    await h.service.processToolCall({ command: 'Manage', operation: 'startDisplay' });
    assert.equal(saved.length, 2);
    assert.equal(saved[1].manifest.startUrl, streamServer.url());
    assert.notEqual(saved[1].manifest.startUrl, saved[0].manifest.startUrl);
    assert.equal(saved[1].manifest.name, 'Custom');
    assert.equal(saved[1].css, source.css);
    assert.equal(saved[1].js, source.js);
});

test('display retry after initial bind failure syncs only the successful URL', async () => {
    const streamServer = rotatingDisplay({ failInitial: true });
    const { saved, manager } = loomSources();
    const h = await harness({ streamServer, services: { loomManager: manager } });
    assert.equal(saved.length, 0);
    await h.service.processToolCall({ command: 'Manage', operation: 'startDisplay' });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].manifest.startUrl, streamServer.url());
});


test('failed display restart never writes a URL to the application manifest', async () => {
    const streamServer = rotatingDisplay();
    const { saved, manager } = loomSources();
    const h = await harness({ streamServer, services: { loomManager: manager } });
    await h.service.processToolCall({ command: 'Manage', operation: 'stopDisplay' });
    streamServer.start = async () => { throw new Error('bind failed'); };
    await assert.rejects(h.service.processToolCall({ command: 'Manage', operation: 'startDisplay' }), /bind failed/);
    assert.equal(saved.length, 1);
});

test('unreadable sources on display restart never overwrite sources or fail the display', async () => {
    const streamServer = rotatingDisplay();
    const { saved, manager } = loomSources();
    const h = await harness({ streamServer, services: { loomManager: manager } });
    await h.service.processToolCall({ command: 'Manage', operation: 'stopDisplay' });
    manager.readSources = async () => { throw new Error('sources unavailable'); };
    const result = await h.service.processToolCall({ command: 'Manage', operation: 'startDisplay' });
    assert.equal(result.details.url, streamServer.url());
    assert.equal(saved.length, 1);
});


test('real loopback display restart updates Loom when the previous port is occupied', async t => {
    const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
    const net = require('node:net');
    const streamServer = new StreamServer({ port: 0, logger: { log() {}, warn() {} } });
    t.after(() => streamServer.stop());
    const { saved, manager } = loomSources();
    const h = await harness({ streamServer, services: { loomManager: manager } });
    const oldPort = streamServer.actualPort;
    const oldUrl = streamServer.url();
    await h.service.processToolCall({ command: 'Manage', operation: 'stopDisplay' });
    const blocker = net.createServer();
    t.after(() => new Promise(resolve => blocker.listening ? blocker.close(resolve) : resolve()));
    await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(oldPort, '127.0.0.1', resolve); });
    const result = await h.service.processToolCall({ command: 'Manage', operation: 'startDisplay' });
    assert.notEqual(result.details.url, oldUrl);
    assert.equal(saved.length, 2);
    assert.equal(manager.manifests.get('android-mirror').startUrl, result.details.url);
    assert.equal(result.details.url, streamServer.url());
});
