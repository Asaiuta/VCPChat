'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { DisplayPreferences, DEFAULTS, FILE_NAME, resolvePreferencesFile } = require('../VCPDistributedServer/Plugin/AndroidController/lib/display-preferences');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
const { ScrcpyHub } = require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub');
const service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'android-preferences-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
async function request(base, route, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(base + route, { method, agent: false, headers: {
            Origin: base, 'Content-Type': 'application/json', ...headers,
        } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                resolve({ status: res.statusCode, headers: res.headers, text,
                    body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
            });
        });
        req.setTimeout(3000, () => req.destroy(new Error('HTTP test timeout')));
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}
async function windowSession(base) {
    const page = await request(base, '/');
    const Cookie = page.headers['set-cookie'][0].split(';')[0];
    return (route, options = {}) => request(base, route, { ...options, headers: { Cookie, ...options.headers } });
}
const post = (api, route, body) => api(route, { method: 'POST', body });

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; }
    send() {}
    close() { this.readyState = 3; this.emit('close'); }
}
async function backend(t, { store, active = false } = {}) {
    const hub = new ScrcpyHub({ serial: 'A', logger: {} });
    let starts = 0, stops = 0;
    hub.start = async () => {
        starts++;
        if (hub.onStart) await hub.onStart();
        hub.state = 'streaming'; hub.width = 720; hub.height = 1600;
        hub.codecString = 'avc1.64001e'; hub.lastPacketAt = Date.now();
        return hub.status();
    };
    hub.stop = async () => {
        stops++; hub.state = 'stopped'; hub.lastPacketAt = 0;
        if (hub.onStop) await hub.onStop();
    };
    const server = new StreamServer({ port: 0, logger: {}, scrcpyHub: hub, displayPreferences: store,
        frameHub: { subscribe: () => () => {}, latestOrNull: () => null, status: () => ({}) },
        deviceApi: {}, handshakeTimeoutMs: 20, firstFrameTimeoutMs: 20 });
    await server.start();
    t.after(() => server.stop());
    if (active) {
        const socket = new Socket();
        server.handleSocket(socket);
        while (server.pendingScrcpyAttachments.has(socket)) await tick();
        assert.equal(server.scrcpyStreamers.size, 1);
    }
    return { hub, server, api: await windowSession(server.url()), counts: () => ({ starts, stops }) };
}

test('production data directory resolution reuses injected AppData and host project base rather than cwd', () => {
    const root = path.join(os.tmpdir(), 'android-data-resolution');
    assert.equal(resolvePreferencesFile({ dataDir: root }), path.join(root, FILE_NAME));
    assert.equal(resolvePreferencesFile({ appDataRoot: root }), path.join(root, FILE_NAME));
    assert.equal(resolvePreferencesFile({ services: { loomManager: { appDataRoot: root } } }), path.join(root, FILE_NAME));
    assert.equal(resolvePreferencesFile({ projectBasePath: path.join(root, 'VCPDistributedServer') }), path.join(root, 'AppData', FILE_NAME));
    assert.equal(resolvePreferencesFile(), path.resolve(__dirname, '../AppData', FILE_NAME));
});

test('display reset atomically restores quality and fit mode, rejects foreign writes and retains defaults on encoder failure', async t => {
    const file = path.join(await temporary(t), FILE_NAME);
    const store = new DisplayPreferences({ file, logger: {} });
    await store.updateScrcpy({ maxFps: 60, maxShortEdge: 1080 });
    await store.updateFitWidth({ fitWidth: true });
    const f = await backend(t, { store, active: true });
    const before = await fs.readFile(file, 'utf8');
    const foreign = await f.api('/api/display/reset', { method: 'POST', body: {}, headers: { Origin: 'http://evil.invalid' } });
    assert.equal(foreign.status, 403);
    assert.equal((await request(f.server.url(), '/api/display/reset', { method: 'POST', body: {} })).status, 403);
    assert.equal((await post(f.api, '/api/display/reset', { AUTO_WAKE: true })).body.ok, false);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    f.hub.onStart = async () => { throw new Error('encoder unavailable'); };
    const result = (await post(f.api, '/api/display/reset', {})).body;
    assert.equal(result.ok, false);
    assert.equal(result.saved, true);
    assert.equal(result.applied, 'fallback');
    assert.equal(result.fitWidth, false);
    assert.deepEqual(await new DisplayPreferences({ file }).load(), DEFAULTS);
    assert.equal(f.hub.status().maxShortEdge, null);
    assert.equal(f.hub.status().maxFps, 30);
});

test('real service and fresh windows restore quality and fitWidth from the real AppData file across reconstruction', async t => {
    const root = await temporary(t);
    let starts = 0;
    t.mock.method(ScrcpyHub.prototype, 'start', async () => { starts++; throw new Error('must not start without a viewer'); });
    t.after(() => service.cleanup());
    const boot = async (config = {}) => {
        await service.initialize({ projectBasePath: path.join(root, 'VCPDistributedServer'),
            config: { DISPLAY_PORT: 0, ADB_PATH: path.join(root, 'missing-adb'), ...config }, logger: {} });
        return windowSession(service.getRuntimeStatus().displayUrl);
    };
    let api = await boot();
    assert.deepEqual((await api('/api/display/preferences')).body, { ok: true, fitWidth: false });
    const saved = await post(api, '/api/scrcpy/config', { maxFps: 60, bitRate: 4000000, maxShortEdge: 720 });
    assert.deepEqual([saved.body.ok, saved.body.saved, saved.body.applied], [true, true, 'next-start']);
    assert.deepEqual((await post(api, '/api/display/preferences', { fitWidth: true })).body, { ok: true, fitWidth: true });
    const file = path.join(root, 'AppData', FILE_NAME);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { maxFps: 60, bitRate: 4000000, maxShortEdge: 720, fitWidth: true });
    const secondWindow = await windowSession(service.getRuntimeStatus().displayUrl);
    assert.equal((await secondWindow('/api/scrcpy')).body.status.maxShortEdge, 720);
    assert.equal((await secondWindow('/api/display/preferences')).body.fitWidth, true);
    await service.cleanup();
    api = await boot({ SCRCPY_MAX_FPS: 5, SCRCPY_BIT_RATE: 100000, SCRCPY_MAX_SIZE: 180 });
    let status = (await api('/api/scrcpy')).body.status;
    assert.deepEqual([status.maxFps, status.bitRate, status.maxShortEdge], [60, 4000000, 720]);
    assert.equal(status.sourceWidth, null);
    assert.equal(status.sourceHeight, null);
    assert.equal(status.serial, '');
    await post(api, '/api/scrcpy/config', { maxFps: 48 });
    await post(api, '/api/scrcpy/config', { maxSize: 900 });
    await service.cleanup();
    api = await boot();
    status = (await api('/api/scrcpy')).body.status;
    assert.deepEqual([status.maxFps, status.bitRate, status.maxSize, status.maxShortEdge], [48, 4000000, 900, null]);
    await post(api, '/api/scrcpy/config', { maxShortEdge: 0 });
    await service.cleanup();
    api = await boot();
    assert.equal((await api('/api/scrcpy')).body.status.maxShortEdge, 0);
    assert.equal((await api('/api/display/preferences')).body.fitWidth, true);
    assert.equal(starts, 0, 'loading/saving preferences must never start a stream or access an absent device');
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).sort(), ['bitRate', 'fitWidth', 'maxFps', 'maxShortEdge']);
});

test('corrupt, oversized and invalid files warn and leave safe defaults without preventing later saves', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME), warnings = [];
    const invalidFiles = ['{', '[]', 'null', JSON.stringify({ ...DEFAULTS, serial: 'secret' }),
        JSON.stringify({ ...DEFAULTS, maxShortEdge: 720 }), JSON.stringify({ ...DEFAULTS, maxFps: '60' }),
        JSON.stringify({ maxFps: 60, bitRate: 4000000, fitWidth: false }),
        JSON.stringify({ ...DEFAULTS, fitWidth: 1 }), JSON.stringify({ ...DEFAULTS, maxFps: 121 }), ' '.repeat(4097)];
    for (const bytes of invalidFiles) {
        await fs.writeFile(file, bytes);
        const store = new DisplayPreferences({ file, logger: { warn: message => warnings.push(message) } });
        assert.deepEqual(await store.load(), DEFAULTS);
    }
    assert.equal(warnings.length, invalidFiles.length);
    assert.ok(warnings.every(message => message.includes(file) && /安全默认值/.test(message)));
    const store = new DisplayPreferences({ file, logger: {} });
    await store.updateScrcpy({ maxShortEdge: 0 });
    assert.deepEqual(await new DisplayPreferences({ file }).load(), { maxFps: 30, bitRate: 2000000, maxShortEdge: 0, fitWidth: false });
});

test('shared write queue merges concurrent quality, mode and fitWidth updates without persisting transient data', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME);
    const store = new DisplayPreferences({ file, logger: {} });
    const one = store.updateScrcpy({ maxShortEdge: 720, maxFps: 60 });
    const two = store.updateFitWidth({ fitWidth: true });
    const three = store.updateScrcpy({ bitRate: 8000000 });
    const four = store.updateScrcpy({ maxSize: 1080 });
    await Promise.all([one, two, three, four]);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { maxFps: 60, bitRate: 8000000, maxSize: 1080, fitWidth: true });
    await store.updateScrcpy({ maxShortEdge: 0 });
    assert.deepEqual(await new DisplayPreferences({ file }).load(), { maxFps: 60, bitRate: 8000000, maxShortEdge: 0, fitWidth: true });
    for (const body of [{ sourceWidth: 1080 }, { serial: 'secret' }, { token: 'secret' }, { maxSize: 720, maxShortEdge: 720 }, { fitWidth: true }]) {
        assert.throws(() => store.updateScrcpy(body), { code: 'INVALID_SCRCPY_CONFIG' });
    }
    for (const body of [{}, { fitWidth: 'true' }, { fitWidth: true, maxFps: 60 }, [], null]) {
        assert.throws(() => store.updateFitWidth(body), { code: 'INVALID_DISPLAY_PREFERENCES' });
    }
    assert.deepEqual(await fs.readdir(root), [FILE_NAME], 'atomic replacement leaves no temporary siblings');
});

test('atomic rename failure preserves previous file and memory, reports error, and does not poison the queue', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME);
    const store = new DisplayPreferences({ file });
    await store.updateScrcpy({ maxFps: 40 });
    const before = await fs.readFile(file, 'utf8');
    const rename = fs.rename;
    const stub = t.mock.method(fs, 'rename', async (temporary, target) => {
        if (target !== file) return rename(temporary, target);
        assert.equal(await fs.readFile(file, 'utf8'), before);
        assert.equal(JSON.parse(await fs.readFile(temporary, 'utf8')).maxFps, 80);
        throw Object.assign(new Error('disk I/O failure'), { code: 'EIO' });
    });
    await assert.rejects(store.updateScrcpy({ maxFps: 80 }), { code: 'DISPLAY_PREFERENCES_WRITE_FAILED', saved: false });
    assert.equal(store.snapshot().maxFps, 40);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.deepEqual(await fs.readdir(root), [FILE_NAME]);
    stub.mock.restore();
    await store.updateFitWidth({ fitWidth: true });
    assert.deepEqual(await new DisplayPreferences({ file }).load(), { ...DEFAULTS, maxFps: 40, fitWidth: true });
});

test('real production store write failure returns ok:false without applying or pretending to save', async t => {
    const root = await temporary(t), blocked = path.join(root, 'not-a-directory');
    await fs.writeFile(blocked, 'occupied');
    t.after(() => service.cleanup());
    await service.initialize({ dataDir: blocked, config: { DISPLAY_PORT: 0 }, logger: {} });
    const api = await windowSession(service.getRuntimeStatus().displayUrl);
    const quality = await post(api, '/api/scrcpy/config', { maxFps: 90 });
    assert.deepEqual([quality.body.ok, quality.body.saved, quality.body.code, quality.body.applied],
        [false, false, 'DISPLAY_PREFERENCES_WRITE_FAILED', null]);
    assert.equal(quality.body.status.maxFps, 30);
    const fit = await post(api, '/api/display/preferences', { fitWidth: true });
    assert.equal(fit.body.ok, false);
    assert.equal(fit.body.code, 'DISPLAY_PREFERENCES_WRITE_FAILED');
    assert.equal((await api('/api/display/preferences')).body.fitWidth, false);
    assert.equal((await api('/health')).body.ok, true);
});

test('active restart failure keeps committed preferences for a reconstructed store', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME);
    const store = new DisplayPreferences({ file });
    const { api, hub, server } = await backend(t, { store, active: true });
    hub.onStart = async () => { throw Object.assign(new Error('encoder unavailable'), { code: 'ENCODER_FAILED' }); };
    const response = await post(api, '/api/scrcpy/config', { maxShortEdge: 1080, maxFps: 60 });
    assert.deepEqual([response.body.ok, response.body.saved, response.body.applied, response.body.code],
        [false, true, 'fallback', 'ENCODER_FAILED']);
    assert.equal((await new DisplayPreferences({ file }).load()).maxShortEdge, 1080);
    server.cancelScrcpyProbe();
});

test('active persistence failure resumes the old stream and never configures unsaved quality', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME);
    const store = new DisplayPreferences({ file });
    await store.updateScrcpy({ maxFps: 30 });
    const { api, hub } = await backend(t, { store, active: true });
    t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('disk I/O failure'), { code: 'EIO' }); });
    const response = await post(api, '/api/scrcpy/config', { maxFps: 90 });
    assert.equal(response.body.ok, false);
    assert.equal(response.body.saved, false);
    assert.equal(response.body.code, 'DISPLAY_PREFERENCES_WRITE_FAILED');
    assert.equal(hub.maxFps, 30);
    assert.equal(hub.state, 'streaming');
    assert.equal((await new DisplayPreferences({ file }).load()).maxFps, 30);
});

test('stop cancels active selection and queued config before either reaches the file store', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME);
    const store = new DisplayPreferences({ file });
    const { hub, server } = await backend(t, { store, active: true });
    const entered = deferred(), release = deferred();
    hub.onStop = async () => { entered.resolve(); await release.promise; };
    const first = server.configureScrcpy({ maxFps: 60 });
    const firstRejected = assert.rejects(first, { code: 'SCRCPY_CONFIG_CANCELLED', saved: false });
    await entered.promise;
    const second = server.configureScrcpy({ maxShortEdge: 720 });
    const secondRejected = assert.rejects(second, { code: 'SCRCPY_CONFIG_CANCELLED', saved: false });
    const stopping = server.changeDevice(() => {}, { resume: false });
    release.resolve();
    await Promise.all([firstRejected, secondRejected, stopping]);
    assert.equal(hub.maxFps, 30);
    assert.equal(hub.maxShortEdge, null);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('fitWidth uses session and exact Origin, remains device-independent, and never restarts active video', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME);
    const store = new DisplayPreferences({ file });
    const { api, server, counts } = await backend(t, { store, active: true });
    server.deviceApi = null;
    const before = counts();
    for (const headers of [{ Origin: '' }, { Origin: server.url().replace('127.0.0.1', 'localhost') }, { Cookie: '' }]) {
        assert.equal((await api('/api/display/preferences', { method: 'POST', body: { fitWidth: true }, headers })).status, 403);
    }
    assert.equal((await request(server.url(), '/api/display/preferences')).status, 403);
    for (const body of [{ fitWidth: 'true' }, { fitWidth: true, maxFps: 60 }, {}]) {
        assert.equal((await post(api, '/api/display/preferences', body)).body.code, 'INVALID_DISPLAY_PREFERENCES');
    }
    assert.deepEqual((await post(api, '/api/display/preferences', { fitWidth: true })).body, { ok: true, fitWidth: true });
    assert.deepEqual(counts(), before);
    assert.equal((await api('/api/display/preferences')).body.fitWidth, true);
    server.displayPreferences = null;
    assert.deepEqual((await api('/api/display/preferences')).body, { ok: true, fitWidth: false });
    assert.equal((await post(api, '/api/display/preferences', { fitWidth: true })).body.code, 'DISPLAY_PREFERENCES_UNAVAILABLE');
});


test('settings bootstrap serves only GET/HEAD with identical viewer session and embedding guards', async t => {
    const { server, counts } = await backend(t);
    const base = server.url(), before = counts();
    for (const section of ['display', 'connection', 'status']) {
        const response = await request(base, `/settings?section=${section}`);
        assert.equal(response.status, 200);
        assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
        assert.equal(response.headers['x-frame-options'], 'DENY');
        assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
        assert.match(response.text, /<!doctype html>/i);
    }
    const head = await request(base, '/settings?section=display', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['set-cookie'], undefined);
    assert.equal((await request(base, '/settings', { method: 'POST', body: {} })).status, 405);
    for (const headers of [{ Origin: 'http://evil.example' }, { Host: 'evil.example' }, { 'Sec-Fetch-Dest': 'iframe' }]) {
        const response = await request(base, '/settings', { headers });
        assert.equal(response.status, 403);
        assert.equal(response.headers['set-cookie'], undefined);
    }
    assert.deepEqual(counts(), before);
});

test('quality cancelled while waiting for shared fitWidth write is never committed or configured', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME);
    const store = new DisplayPreferences({ file });
    await store.load();
    const { server, hub } = await backend(t, { store });
    const entered = deferred(), release = deferred(), rename = fs.rename;
    const stub = t.mock.method(fs, 'rename', async (temporary, target) => {
        entered.resolve();
        await release.promise;
        return rename(temporary, target);
    });
    const fit = store.updateFitWidth({ fitWidth: true });
    await entered.promise;
    const quality = server.configureScrcpy({ maxFps: 90 });
    const rejected = assert.rejects(quality, { code: 'SCRCPY_CONFIG_CANCELLED', saved: false });
    await server.changeDevice(() => {}, { resume: false });
    release.resolve();
    await Promise.all([fit, rejected]);
    stub.mock.restore();
    assert.equal(hub.maxFps, 30);
    assert.deepEqual(await new DisplayPreferences({ file }).load(), { ...DEFAULTS, fitWidth: true });
});



test('shutdown drains an in-flight atomic commit and cancelled response honestly retains its saved next-start value', async t => {
    const root = await temporary(t), file = path.join(root, FILE_NAME);
    const store = new DisplayPreferences({ file });
    await store.load();
    const { server, hub } = await backend(t, { store });
    const entered = deferred(), release = deferred(), rename = fs.rename;
    const stub = t.mock.method(fs, 'rename', async (temporary, target) => {
        entered.resolve();
        await release.promise;
        return rename(temporary, target);
    });
    const quality = server.configureScrcpy({ maxFps: 90 });
    const rejected = assert.rejects(quality, { code: 'SCRCPY_CONFIG_CANCELLED', saved: true, applied: 'next-start' });
    await entered.promise;
    let stopped = false;
    const stopping = server.stop().then(() => { stopped = true; });
    await tick();
    assert.equal(stopped, false, 'a reconstructed service must not overtake an old in-flight file commit');
    release.resolve();
    await Promise.all([stopping, rejected]);
    stub.mock.restore();
    assert.equal(hub.maxFps, 90);
    assert.equal((await new DisplayPreferences({ file }).load()).maxFps, 90);
});
