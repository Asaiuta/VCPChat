'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');

async function fixture(t) {
    const calls = { frames: 0, captures: 0, h264: 0, starts: 0, api: 0, logs: [] };
    const frameHub = { generation: 0, latestOrNull: () => null, status: () => ({}),
        capture: async () => { calls.captures++; return { seq: 1, mime: 'image/jpeg', buffer: Buffer.from([255, 216, 255, 217]) }; },
        subscribe: () => { calls.frames++; return () => {}; } };
    const scrcpyHub = {
        _generation: 0, state: 'stopped', startedAt: 0, lastPacketAt: 0,
        width: null, height: null, codecString: null, packetsReceived: 0,
        subscribers: new Set(),
        completeHandshake() {
            this._generation++;
            this.startedAt = Date.now();
            this.lastPacketAt = 0;
            this.packetsReceived = 0;
            this.state = 'starting';
            this.width = 720;
            this.height = 1600;
            this.codecString = 'avc1.64001e';
            this.state = 'streaming';
            this.emitPacket({ type: 'config', data: Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x1e]), pts: 0, key: false });
            this.emitPacket({ type: 'frame', data: Buffer.from([0, 0, 0, 1, 0x65, 1]), pts: 0, key: true });
        },
        emitPacket(packet) {
            if (packet.type === 'frame') this.lastPacketAt = Date.now();
            if (packet.type === 'config' || packet.type === 'frame') this.packetsReceived++;
            for (const fn of this.subscribers) fn(packet);
        },
        status() {
            return { state: this.state, width: this.width, height: this.height,
                codecString: this.codecString, packetsReceived: this.packetsReceived };
        },
        subscribe(fn) { calls.h264++; this.subscribers.add(fn); return () => this.subscribers.delete(fn); },
        async start() {
            calls.starts++;
            if (this.state !== 'streaming') this.completeHandshake();
            return this.status();
        },
        async stop() { this._generation++; this.state = 'stopped'; return this.status(); },
    };
    scrcpyHub.completeHandshake();
    const server = new StreamServer({ port: 0, frameHub, scrcpyHub,
        logger: { log: (s) => calls.logs.push(s), warn: (s) => calls.logs.push(s) },
        deviceApi: { adbStatus: async () => { calls.api++; return { ok: true }; },
            listDevices: async () => ({ ok: true, devices: [] }), pair: async () => ({ ok: true }) } });
    await server.start();
    t.after(() => server.stop());
    return { server, calls, base: server.url() };
}
function request(base, target, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(base + target, { headers, method }, (res) => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        }); req.on('error', reject); req.end();
    });
}
async function session(base) {
    const page = await request(base, '/', { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' });
    assert.equal(page.status, 200);
    const cookie = page.headers['set-cookie']?.[0];
    assert.ok(cookie, 'viewer navigation must issue a session cookie');
    assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i); assert.match(cookie, /Path=\//i);
    assert.doesNotMatch(cookie, /Domain=/i);
    const credential = cookie.split(';')[0];
    assert.ok(!page.body.includes(credential.split('=')[1]), 'credential must not enter HTML');
    return credential;
}
async function handshake(base, headers) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(base.replace('http:', 'ws:') + '/stream', { headers, handshakeTimeout: 1500 });
        socket.once('open', () => resolve({ status: 101, socket }));
        socket.once('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve({ status: res.statusCode }); });
        socket.on('error', (error) => { if (!/closed before the connection/.test(error.message)) reject(error); });
    });
}
for (const [label, origin] of [['foreign', 'http://evil.example'], ['missing', undefined], ['null', 'null'], ['wrong-scheme', 'https:'], ['alias', 'http://localhost']]) {
    test(`WS rejects ${label} Origin before subscribing or starting capture`, async (t) => {
        const { base, calls } = await fixture(t);
        const cookie = await session(base);
        const value = origin === 'https:' ? base.replace('http:', 'https:') : origin === 'http://localhost' ? base.replace('127.0.0.1', 'localhost') : origin;
        const result = await handshake(base, { Cookie: cookie, ...(value ? { Origin: value } : {}) });
        if (result.socket) result.socket.terminate();
        assert.equal(result.status, 403);
        assert.equal(calls.frames + calls.h264 + calls.starts + calls.captures, 0);
    });
}
for (const cookie of [undefined, 'android_display=invalid']) {
    test(`WS rejects ${cookie ? 'invalid' : 'missing'} credential before capture`, async (t) => {
        const { base, calls } = await fixture(t);
        const result = await handshake(base, { Origin: base, ...(cookie ? { Cookie: cookie } : {}) });
        if (result.socket) result.socket.terminate();
        assert.equal(result.status, 403); assert.equal(calls.frames + calls.h264 + calls.starts, 0);
    });
}
test('tampered, duplicate and malformed session cookies are rejected before any subscription', async (t) => {
    const { base, calls } = await fixture(t); const cookie = await session(base);
    const [name, token] = cookie.split('=');
    for (const value of [`${name}=${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`, `${cookie}; ${cookie}`, `${name}=%00`, `${name}=${'f'.repeat(1000)}`]) {
        assert.equal((await handshake(base, { Origin: base, Cookie: value })).status, 403);
    }
    assert.equal(calls.frames + calls.h264 + calls.starts + calls.captures, 0);
});
test('stopping and restarting the same server invalidates the previous in-memory credential', async (t) => {
    const { base, server } = await fixture(t); const cookie = await session(base);
    const token = cookie.split('=')[1];
    await server.stop(); await server.start();
    const next = server.url();
    const stale = `android_display_${server.actualPort}=${token}`;
    assert.equal((await handshake(next, { Origin: next, Cookie: stale })).status, 403);
    const fresh = await session(next);
    const good = await handshake(next, { Origin: next, Cookie: fresh });
    assert.equal(good.status, 101); good.socket.terminate();
});
test('same-origin viewer cookie connects and is not logged; server instances do not share sessions', async (t) => {
    const a = await fixture(t); const b = await fixture(t);
    const cookie = await session(a.base);
    const good = await handshake(a.base, { Origin: a.base, Cookie: cookie });
    assert.equal(good.status, 101); t.after(() => good.socket.terminate());
    assert.equal(a.calls.h264, 1);
    assert.ok(a.calls.logs.every(s => !s.includes(cookie.split('=')[1])));
    const wrong = await handshake(b.base, { Origin: b.base, Cookie: cookie });
    if (wrong.socket) wrong.socket.terminate(); assert.equal(wrong.status, 403);
});
test('sensitive HTTP requires session and rejects cross-site requests even with a cookie', async (t) => {
    const { base, calls } = await fixture(t); const cookie = await session(base);
    for (const route of ['/frame', '/status', '/api/adb', '/api/scrcpy']) {
        assert.equal((await request(base, route)).status, 403, route);
        assert.equal((await request(base, route, { Cookie: cookie, Origin: 'http://evil.example' })).status, 403, route);
        assert.equal((await request(base, route, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403, route);
        assert.equal((await request(base, route, { Cookie: cookie })).status, 200, route);
    }
    assert.equal(calls.captures, 1); assert.equal(calls.api, 1);
});
test('bootstrap rejects rebinding Host, cross-site fetch and iframe without issuing credentials', async (t) => {
    const { base } = await fixture(t);
    for (const headers of [{ Host: 'evil.example' }, { Origin: 'http://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Dest': 'iframe' }]) {
        const res = await request(base, '/', headers); assert.equal(res.status, 403); assert.equal(res.headers['set-cookie'], undefined);
    }
    const health = await request(base, '/health'); assert.equal(health.status, 200);
    const head = await request(base, '/', {}, 'HEAD'); assert.equal(head.headers['set-cookie'], undefined);
});
test('listener rejects LAN/wildcard hosts instead of treating loopback as identity', () => {
    for (const host of ['0.0.0.0', '192.168.1.2', 'evil.example', '::']) assert.throws(() => new StreamServer({ host }), /loopback|回环/i);
});
test('API requires cookie plus exact Origin for writes and session for device reads', async (t) => {
    const { base } = await fixture(t); const cookie = await session(base);
    assert.equal((await request(base, '/api/pair', { Origin: base, 'Content-Type': 'application/json' }, 'POST')).status, 403);
    assert.equal((await request(base, '/api/pair', { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, 'POST')).status, 200);
    assert.equal((await request(base, '/api/devices')).status, 403);
    assert.equal((await request(base, '/api/devices', { Cookie: cookie })).status, 200);
    assert.equal((await request(base, '/api/pair', { Cookie: cookie, Origin: base.replace('http:', 'https:') }, 'POST')).status, 403);
    assert.equal((await request(base, '/api/pair', { Cookie: cookie }, 'POST')).status, 403);
    assert.equal((await request(base, '/api/pair', { Cookie: cookie }, 'OPTIONS')).status, 403);
});

function viewer(socket) {
    const html = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/viewer.html'), 'utf8');
    const source = html.slice(html.indexOf('    function handleText('), html.indexOf('    function handleBinary('));
    const element = () => ({ classList: { add() {}, remove() {} }, textContent: '' });
    const context = vm.createContext({ Uint8Array, DataView, ArrayBuffer, setTimeout() {}, window: { VideoDecoder: true },
        els: { screen: element(), h264: element(), errorBox: element() }, setDot() {},
        sendToServer(payload) { socket.send(JSON.stringify(payload)); } });
    vm.runInContext(`let useH264 = true, h264Interrupted = false, h264Info = null, h264Pending = null, h264ConfigBytes = null, h264Seq = -1, decodedSeq = -1, decoder = null, frameTimes = [];\n${source}`, context);
    return context;
}
test('complete fallback round trip: temporary server JPEG does not become explicit JPEG intent', async (t) => {
    const { base, server } = await fixture(t); const cookie = await session(base);
    const { socket } = await handshake(base, { Origin: base, Cookie: cookie }); t.after(() => socket.terminate());
    const context = viewer(socket); const replies = [];
    const serverSocket = [...server.wss.clients][0]; serverSocket.on('message', raw => replies.push(JSON.parse(String(raw))));
    socket.on('message', (raw, binary) => { if (!binary) { context.raw = String(raw); vm.runInContext('handleText(raw)', context); } });
    const fallback = once(socket, 'message'); server.fallbackAllToJpeg(); await fallback;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.filter(p => p.type === 'request-jpeg').length, 0, 'server fallback must not echo permanent intent');
    assert.equal(server.jpegOnlySockets.has(serverSocket), false);
    const ready = once(socket, 'message');
    assert.equal(await server.tryRecoverScrcpy(), true);
    const [readyRaw] = await ready;
    assert.equal(JSON.parse(String(readyRaw)).type, 'scrcpy-ready');
    assert.equal(vm.runInContext('useH264', context), true);
    assert.equal(server.scrcpyStreamers.has(serverSocket), true);
    const explicit = once(serverSocket, 'message'); vm.runInContext("fallbackToJpeg('explicit decoder failure')", context); await explicit;
    assert.equal(server.jpegOnlySockets.has(serverSocket), true);
    assert.equal(server.unsubscribers.has(serverSocket), true);
    assert.equal(await server.tryRecoverScrcpy(), false);
    assert.equal(server.scrcpyStreamers.has(serverSocket), false);
});
