'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close'); }
}
async function fixture(t) {
    const events = [], packets = new Set(), frames = new Set();
    const hub = {
        state: 'stopped', _generation: 0, lastPacketAt: 0, lastError: null,
        maxSize: 540, maxFps: 30, bitRate: 2000000, serial: 'A',
        subscribe(fn) { packets.add(fn); return () => packets.delete(fn); },
        status() {
            return { state: this.state, serial: this.serial, width: 720, height: 1600,
                codecString: 'avc1.64001e', maxSize: this.maxSize, maxFps: this.maxFps,
                bitRate: this.bitRate, lastError: this.lastError };
        },
        configure(config) { events.push(['configure', { ...config }, this.serial]); Object.assign(this, config); },
        async start() {
            const generation = ++this._generation;
            this.state = 'starting'; this.lastPacketAt = 0;
            events.push(['start', this.maxFps, this.bitRate, this.maxSize, this.serial]);
            try {
                if (this.onStart) await this.onStart();
                if (generation !== this._generation) throw new Error('cancelled generation');
                this.state = 'streaming'; this.lastPacketAt = Date.now();
                return this.status();
            } catch (error) {
                if (generation === this._generation) {
                    this.state = 'error'; this.lastError = { message: error.message };
                }
                throw error;
            }
        },
        async stop() {
            ++this._generation;
            events.push(['stop']); this.state = 'stopped'; this.lastPacketAt = 0;
            if (this.onStop) await this.onStop();
        },
    };
    const frameHub = {
        subscribe(fn) { frames.add(fn); return () => frames.delete(fn); },
        latestOrNull() { return null; }, status() { return {}; },
    };
    const server = new StreamServer({ port: 0, scrcpyHub: hub, frameHub, deviceApi: {}, logger: {},
        handshakeTimeoutMs: 10, firstFrameTimeoutMs: 10 });
    await server.start();
    t.after(() => server.stop());
    const origin = server.url();
    function request(route, { method = 'POST', body, raw, headers = {} } = {}) {
        const payload = raw === undefined ? (body === undefined ? '' : JSON.stringify(body)) : raw;
        return new Promise((resolve, reject) => {
            const req = http.request(`${origin}${route}`, { method, agent: false, headers: {
                Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers,
            } }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString();
                    resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
                });
                res.on('error', reject);
            });
            req.setTimeout(2000, () => req.destroy(new Error('HTTP test timeout')));
            req.on('error', reject);
            req.end(payload);
        });
    }
    let cookie = '';
    // Bootstrap the real HttpOnly session exactly as the viewer does.
    const bootstrap = await new Promise((resolve, reject) => {
        http.get(origin, { agent: false }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
    });
    cookie = bootstrap.headers['set-cookie'][0].split(';')[0];
    const post = body => request('/api/scrcpy/config', { body });
    async function viewer({ jpeg = false, fallback = false } = {}) {
        const socket = new Socket();
        server.handleSocket(socket);
        while (server.pendingScrcpyAttachments.has(socket)) await tick();
        if (jpeg) socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
        else if (fallback) server.fallbackAllToJpeg();
        if (server.idleScrcpyStop) await server.idleScrcpyStop;
        return socket;
    }
    return { server, hub, events, packets, frames, request, post, viewer };
}

const invalidBodies = [
    null, [], [30], '30', 30, true, {},
    { maxFps: '30' }, { maxFps: 1.5 }, { maxFps: 0 }, { maxFps: 121 },
    { bitRate: 99999 }, { bitRate: 50000001 }, { maxSize: 179 }, { maxSize: 2161 },
    { maxFps: Number.MAX_SAFE_INTEGER + 1 }, { bitRate: null },
    { maxFps: 60, maxSize: 720, bitRate: '4000000' },
    { maxFps: 60, serial: 'B' }, { maxFps: 60, unexpected: 1 },
    JSON.parse('{"maxFps":60,"__proto__":{}}'),
];
test('strict HTTP validation rejects every invalid field atomically before lifecycle mutation', async t => {
    const { post, request, hub, events, viewer } = await fixture(t);
    await viewer();
    events.length = 0;
    for (const body of invalidBodies) {
        const response = await post(body);
        assert.equal(response.status, 200);
        assert.equal(response.body.ok, false, JSON.stringify(body));
        assert.equal(response.body.code, 'INVALID_SCRCPY_CONFIG');
        assert.equal(response.body.applied, null);
        assert.deepEqual([hub.maxFps, hub.bitRate, hub.maxSize], [30, 2000000, 540]);
        assert.deepEqual(events, [], 'validation must not stop or partially configure the hub');
    }
    for (const raw of ['{"maxFps":1e999}', '{"maxFps":NaN}', '', '{']) {
        const response = await request('/api/scrcpy/config', { raw });
        assert.equal(response.body.ok, false);
        assert.deepEqual(events, []);
    }
});

test('boundary values and partial updates persist for next start without touching the device', async t => {
    const { post, request, events, hub } = await fixture(t);
    for (const body of [{ maxFps: 1, bitRate: 100000, maxSize: 180 },
        { maxFps: 120, bitRate: 50000000, maxSize: 2160 }, { maxFps: 60 }]) {
        const response = await post(body);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.applied, 'next-start');
        for (const [key, value] of Object.entries(body)) assert.equal(response.body.status[key], value);
    }
    assert.ok(events.every(event => event[0] === 'configure'));
    assert.deepEqual([hub.maxFps, hub.bitRate, hub.maxSize], [60, 50000000, 2160]);
    const status = await request('/api/scrcpy', { method: 'GET' });
    assert.deepEqual([status.body.status.maxFps, status.body.status.bitRate, status.body.status.maxSize], [60, 50000000, 2160]);
});

test('H264 viewers restart through changeDevice and receive ready only with the new configuration', async t => {
    const { post, viewer, server, events, packets } = await fixture(t);
    const socket = await viewer();
    events.length = 0; socket.sent.length = 0;
    const original = server.changeDevice.bind(server);
    let transactions = 0;
    server.changeDevice = (...args) => { transactions++; return original(...args); };
    const response = await post({ maxFps: 60, bitRate: 4000000, maxSize: 1080 });
    assert.equal(response.body.ok, true);
    assert.equal(response.body.applied, 'active-stream');
    assert.equal(transactions, 1);
    assert.deepEqual(events.map(event => event[0]), ['stop', 'configure', 'start']);
    assert.deepEqual(events.at(-1).slice(1, 4), [60, 4000000, 1080]);
    assert.equal(packets.size, 1);
    const ready = socket.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value))
        .find(value => value.type === 'scrcpy-ready');
    assert.equal(ready.maxFps, 60);
    assert.equal(ready.maxSize, 1080);
});

test('explicit JPEG viewers stay JPEG while automatic fallback H264 intent is restored', async t => {
    const { post, viewer, server, packets, frames, events } = await fixture(t);
    const jpeg = await viewer({ jpeg: true });
    events.length = 0;
    assert.equal((await post({ maxSize: 720 })).body.applied, 'next-start');
    assert.ok(events.every(event => event[0] === 'configure'));
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 1);
    const h264 = await viewer({ fallback: true });
    assert.equal(frames.size, 2);
    const response = await post({ maxFps: 45 });
    assert.equal(response.body.applied, 'active-stream');
    assert.equal(server.scrcpyStreamers.has(jpeg), false);
    assert.equal(server.unsubscribers.has(jpeg), true);
    assert.equal(server.scrcpyStreamers.has(h264), true);
    assert.equal(packets.size, 1);
    assert.equal(frames.size, 1);
});

test('encoding failure reports real error and fallback while preserving saved configuration', async t => {
    const { post, viewer, hub, events, frames, server } = await fixture(t);
    await viewer();
    const failure = Object.assign(new Error('encoder unavailable'), { code: 'ENCODER_FAILED' });
    hub.onStart = async () => { throw failure; };
    events.length = 0;
    const response = await post({ bitRate: 5000000 });
    assert.equal(response.body.ok, false);
    assert.equal(response.body.applied, 'fallback');
    assert.equal(response.body.error, failure.message);
    assert.equal(response.body.code, failure.code);
    assert.equal(response.body.status.lastError.message, failure.message);
    assert.equal(response.body.status.bitRate, 5000000);
    assert.equal(frames.size, 1);
    assert.equal(events.filter(event => event[0] === 'configure').length, 1);
    assert.equal(events.filter(event => event[0] === 'start').length, 1);
    server.cancelScrcpyProbe();
});

test('concurrent HTTP configurations serialize full restarts without overwriting either request', async t => {
    const { post, viewer, hub, server, events } = await fixture(t);
    await viewer();
    const entered = deferred(), release = deferred(), admitted = deferred();
    hub.onStart = async () => { entered.resolve(); await release.promise; };
    events.length = 0;
    const first = post({ maxFps: 40 });
    await entered.promise;
    const configure = server.configureScrcpy.bind(server);
    server.configureScrcpy = body => { const operation = configure(body); admitted.resolve(); return operation; };
    const second = post({ maxFps: 80, bitRate: 8000000 });
    await admitted.promise;
    assert.deepEqual(events.map(event => event[0]), ['stop', 'configure', 'start']);
    release.resolve();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.body.applied, 'active-stream');
    assert.equal(two.body.applied, 'active-stream');
    assert.equal(one.body.status.maxFps, 40);
    assert.equal(two.body.status.maxFps, 80);
    assert.equal(two.body.status.bitRate, 8000000);
    assert.deepEqual(events.map(event => event[0]), ['stop', 'configure', 'start', 'stop', 'configure', 'start']);
});

test('configuration waits for an existing device transaction before writing or restoring viewers', async t => {
    const { post, viewer, server, hub, events } = await fixture(t);
    await viewer();
    const selection = deferred(), entered = deferred(), admitted = deferred();
    const changing = server.changeDevice(async () => { entered.resolve(); await selection.promise; hub.serial = 'B'; });
    await entered.promise;
    const configure = server.configureScrcpy.bind(server);
    server.configureScrcpy = body => { const operation = configure(body); admitted.resolve(); return operation; };
    events.length = 0;
    const configuring = post({ maxFps: 75 });
    await admitted.promise;
    assert.equal(events.some(event => event[0] === 'configure'), false);
    selection.resolve();
    await changing;
    const response = await configuring;
    assert.equal(response.body.applied, 'active-stream');
    assert.equal(response.body.status.serial, 'B');
    assert.equal(events.find(event => event[0] === 'configure')[2], 'B');
});

test('later device selection cancels in-flight and queued configurations without replaying writes', async t => {
    const { post, viewer, server, hub, events } = await fixture(t);
    await viewer();
    const entered = deferred(), release = deferred();
    hub.onStart = async () => { entered.resolve(); await release.promise; };
    events.length = 0;
    const first = post({ maxFps: 40 });
    await entered.promise;
    const admitted = deferred();
    const configure = server.configureScrcpy.bind(server);
    server.configureScrcpy = body => { const operation = configure(body); admitted.resolve(); return operation; };
    const queued = post({ maxFps: 80 });
    await admitted.promise;
    hub.onStart = null;
    const changing = server.changeDevice(() => { hub.serial = 'B'; });
    release.resolve();
    await changing;
    const [one, two] = await Promise.all([first, queued]);
    assert.equal(one.body.ok, false);
    assert.equal(one.body.code, 'SCRCPY_CONFIG_CANCELLED');
    assert.equal(one.body.applied, 'next-start');
    assert.equal(two.body.ok, false);
    assert.equal(two.body.code, 'SCRCPY_CONFIG_CANCELLED');
    assert.equal(two.body.applied, null);
    assert.deepEqual(events.filter(event => event[0] === 'configure').map(event => event[1]), [{ maxFps: 40 }]);
    assert.equal(hub.serial, 'B');
});

test('HTTP stop cancels pending configuration before mutation and never restarts the paused stream', async t => {
    const { post, request, viewer, hub, server, events } = await fixture(t);
    await viewer();
    const entered = deferred(), release = deferred();
    hub.onStop = async () => { entered.resolve(); await release.promise; };
    events.length = 0;
    const configuring = post({ maxFps: 90 });
    await entered.promise;
    const stopping = request('/api/scrcpy/stop');
    while (!server.h264Paused) await tick();
    release.resolve();
    const [config, stop] = await Promise.all([configuring, stopping]);
    assert.equal(config.body.ok, false);
    assert.equal(config.body.code, 'SCRCPY_CONFIG_CANCELLED');
    assert.equal(config.body.applied, null);
    assert.equal(stop.body.ok, true);
    assert.equal(hub.state, 'stopped');
    assert.equal(hub.maxFps, 30);
    assert.equal(events.some(event => event[0] === 'start' || event[0] === 'configure'), false);
    assert.equal(await server.tryRecoverScrcpy(), false);
    const saved = await post({ maxFps: 55 });
    assert.equal(saved.body.applied, 'next-start');
    assert.equal(events.some(event => event[0] === 'start'), false);
});

test('server stop invalidates queued HTTP configuration even across a later server restart', async t => {
    const { post, viewer, hub, server, events } = await fixture(t);
    await viewer();
    const entered = deferred(), release = deferred();
    hub.onStop = async () => { entered.resolve(); await release.promise; };
    events.length = 0;
    const configuring = post({ maxFps: 90 }).catch(error => ({ transportError: error }));
    await entered.promise;
    const pending = server.configQueue;
    const stopping = server.stop();
    release.resolve();
    await stopping;
    await server.start();
    await assert.rejects(pending, { code: 'SCRCPY_CONFIG_CANCELLED' });
    await configuring;
    assert.equal(hub.state, 'stopped');
    assert.equal(hub.maxFps, 30);
    assert.equal(events.some(event => event[0] === 'start' || event[0] === 'configure'), false);
    assert.equal(server.watchdogTimer, null);
    assert.equal(server.recoveryTimer, null);
});

test('configuration retains existing exact Origin and session Cookie requirements', async t => {
    const { request, events } = await fixture(t);
    for (const headers of [{ Origin: 'http://example.com' }, { Origin: '' }, { Cookie: '' }]) {
        const response = await request('/api/scrcpy/config', { body: { maxFps: 60 }, headers });
        assert.equal(response.status, 403);
    }
    assert.deepEqual(events, []);
});

for (const stage of ['handshake', 'first-frame']) {
    test(`configuration restart reports ${stage} failure rather than configured success`, async t => {
        const { post, viewer, server, hub, events, frames } = await fixture(t);
        await viewer();
        if (stage === 'handshake') server.waitForHandshake = async () => false;
        else server.waitForFirstFrame = async () => false;
        events.length = 0;
        const response = await post({ maxSize: 900 });
        assert.equal(response.body.ok, false);
        assert.equal(response.body.applied, 'fallback');
        assert.match(response.body.error, stage === 'handshake' ? /握手超时/ : /首帧超时/);
        assert.equal(response.body.status.maxSize, 900);
        assert.equal(hub.state, 'stopped');
        assert.equal(frames.size, 1);
        assert.equal(events.filter(event => event[0] === 'configure').length, 1);
        assert.equal(events.filter(event => event[0] === 'start').length, 1);
        server.cancelScrcpyProbe();
    });
}

test('configuration waiting for a failed device selection preserves its error without writing', async t => {
    const { post, viewer, server, events } = await fixture(t);
    await viewer();
    const selection = deferred(), entered = deferred(), admitted = deferred();
    const changing = server.changeDevice(async () => { entered.resolve(); await selection.promise; });
    const rejected = assert.rejects(changing, /device selection failed/);
    await entered.promise;
    const configure = server.configureScrcpy.bind(server);
    server.configureScrcpy = body => { const operation = configure(body); admitted.resolve(); return operation; };
    events.length = 0;
    const configuring = post({ maxFps: 75 });
    await admitted.promise;
    selection.reject(Object.assign(new Error('device selection failed'), { code: 'DEVICE_SELECTION_FAILED' }));
    await rejected;
    const response = await configuring;
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error, 'device selection failed');
    assert.equal(response.body.code, 'DEVICE_SELECTION_FAILED');
    assert.equal(response.body.applied, null);
    assert.deepEqual(events, []);
});

test('existing explicit start resumes a stopped stream with the saved quality and subscriptions', async t => {
    const { post, request, viewer, hub, server, events, packets } = await fixture(t);
    await viewer();
    await request('/api/scrcpy/stop');
    assert.equal((await post({ maxFps: 50, bitRate: 6000000 })).body.applied, 'next-start');
    events.length = 0;
    const response = await request('/api/scrcpy/start');
    assert.equal(response.body.ok, true);
    assert.equal(response.body.status.maxFps, 50);
    assert.equal(response.body.status.bitRate, 6000000);
    assert.equal(hub.state, 'streaming');
    assert.equal(server.h264Paused, false);
    assert.equal(packets.size, 1);
    assert.deepEqual(events.map(event => event[0]), ['stop', 'start']);
});

