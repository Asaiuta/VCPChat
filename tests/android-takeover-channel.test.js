'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
const { attachTakeoverChannel } = require('../VCPDistributedServer/Plugin/AndroidController/lib/takeover-channel');
const { createViewerTakeover } = require('../VCPDistributedServer/Plugin/AndroidController/lib/viewer-takeover');
const { harness } = require('./helpers/android-service-harness.cjs');
const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; }
    close() { this.readyState = 3; this.emit('close'); }
}
function channel(api, send = () => true) {
    const socket = new Socket(), replies = [];
    attachTakeoverChannel({ socket, api, send: data => { replies.push(JSON.parse(data)); return send(data); } });
    const request = data => socket.emit('message', Buffer.from(JSON.stringify(data)), false);
    return { socket, replies, request };
}

test('channel rejects replay, overlapping start, invalid identifiers and binary before API', async () => {
    const gate = deferred(); const calls = [];
    const c = channel({ async start(body) { calls.push(body); await gate.promise; return { token: 't' }; },
        touch() { calls.push('touch'); }, async close() {} });
    c.request({ type: 'takeover-start', requestId: 'one', serial: 'A' });
    c.request({ type: 'takeover-start', requestId: 'one', serial: 'A' });
    c.request({ type: 'takeover-start', requestId: 'two', serial: 'A' });
    c.request({ type: 'takeover-end', requestId: '<bad>' });
    c.socket.emit('message', Buffer.from('{"type":"takeover-touch","action":"down"}'), true);
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(c.replies.map(x => x.code), ['TAKEOVER_REPLAY_REJECTED', 'DEVICE_BUSY']);
    gate.resolve(); await tick(); c.socket.close();
});

test('live touch is applied in order without receipts; failures are pushed as input errors', async () => {
    const seen = [];
    const c = channel({ touch(body, { owner }) {
        assert.ok(owner);
        if (body.action === 'bad') throw Object.assign(new Error('nope\ndetail'), { code: 'POLICY_DENIED' });
        seen.push(body.action);
    }, key(body) { seen.push(`key:${body.key}`); }, async close() {} });
    for (const action of ['down', 'move', 'move', 'up']) c.request({ type: 'takeover-touch', action });
    c.request({ type: 'takeover-key', key: 'back' });
    assert.deepEqual(seen, ['down', 'move', 'move', 'up', 'key:back']);
    assert.equal(c.replies.length, 0);
    c.request({ type: 'takeover-touch', action: 'bad' });
    assert.deepEqual(c.replies, [{ type: 'takeover-input-error', code: 'POLICY_DENIED', error: 'nope' }]);
    c.socket.close();
});

test('receipt backpressure closes and revokes instead of silently dropping write results', async () => {
    let closed = 0;
    const c = channel({ async start() { return { token: 't' }; }, async close() { closed++; } }, () => false);
    c.request({ type: 'takeover-start', requestId: 'one', serial: 'A' }); await tick();
    assert.equal(closed, 1); assert.equal(c.socket.readyState, 3);
});

test('socket close aborts pending start and never publishes a late capability', async () => {
    const gate = deferred(); let signal; let closed = 0;
    const c = channel({ async start(_body, context) { signal = context.signal; await gate.promise; return { token: 'late' }; }, async close() { closed++; } });
    c.request({ type: 'takeover-start', requestId: 'one', serial: 'A' });
    c.socket.close(); gate.resolve(); await tick();
    assert.equal(signal.aborted, true); assert.equal(closed, 1); assert.equal(c.replies.length, 0);
});

async function live(t, options = {}) {
    const hub = { sent: [], serial: 'A', width: 100, height: 200, controlReady: () => true,
        injectTouch(event) { this.sent.push(event); }, injectKeycode(...args) { this.sent.push(args); } };
    const h = await harness({ hub, services: { humanInteraction: { async request() { return true; } } } });
    h.hub = hub;
    const server = new StreamServer({ frameHub: { adb: h.client, status() { return {}; }, latestOrNull() { return null; },
        subscribe() { return () => {}; } }, port: 0, deviceApi: { ...h.api, ...options.deviceApi }, takeoverApi: h.takeoverApi, logger: { log() {}, warn() {} } });
    await server.start();
    const origin = new URL(server.url()).origin, url = `${origin}/`;
    const response = await fetch(url);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    await response.text();
    const sockets = [];
    t.after(async () => { for (const socket of sockets) socket.terminate(); await server.stop(); await h.service.cleanup(); });
    async function connect(headers = { Cookie: cookie }, source = origin) {
        const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/stream`, { headers, origin: source });
        sockets.push(socket);
        const messages = [], waiters = new Map();
        socket.on('message', (raw, binary) => {
            if (binary) return;
            const value = JSON.parse(String(raw)); messages.push(value);
            const pending = waiters.get(value.requestId ?? value.type); if (pending) { waiters.delete(value.requestId ?? value.type); pending.resolve(value); }
        });
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        let sequence = 0;
        const request = (type, body = {}, id = `req_${++sequence}`) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => { waiters.delete(id); reject(new Error('WS test timeout')); }, 3000);
            waiters.set(id, { resolve(value) { clearTimeout(timer); resolve(value); } });
            socket.send(JSON.stringify({ type, requestId: id, ...body }));
        });
        const waitFor = type => new Promise((resolve, reject) => {
            const timer = setTimeout(() => { waiters.delete(type); reject(new Error('WS test timeout')); }, 3000);
            waiters.set(type, { resolve(value) { clearTimeout(timer); resolve(value); } });
        });
        return { socket, messages, request, waitFor };
    }
    return { h, server, url, origin, cookie, connect };
}

test('real HTTP/WS requires same-origin read cookie; read permission alone cannot send input', async t => {
    const { h, url, cookie, connect } = await live(t);
    assert.equal((await fetch(`${url}status`)).status, 403);
    const status = await (await fetch(`${url}status`, { headers: { Cookie: cookie } })).json();
    assert.equal(status.display.serial, 'A'); assert.equal(status.takeover.available, true);
    await assert.rejects(connect({}, 'http://evil.example'), /403/);
    await assert.rejects(connect({}), /403/);
    const c = await connect();
    const pending = c.waitFor('takeover-input-error');
    c.socket.send(JSON.stringify({ type: 'takeover-touch', token: 'forged', epoch: 1, action: 'down', x: 0, y: 0, width: 100, height: 200 }));
    const result = await pending;
    assert.equal(result.type, 'takeover-input-error');
    assert.equal(result.code, 'TAKEOVER_SESSION_REQUIRED');
    assert.equal(h.hub.sent.length, 0);
});

test('real WS session binds to initiating socket; management is blocked and termination drains ownership', async t => {
    const { h, url, cookie, origin, connect } = await live(t);
    const a = await connect(), b = await connect();
    const session = await a.request('takeover-start', { serial: 'A' }); assert.equal(session.ok, true);
    const body = { token: session.token, epoch: session.epoch };
    const waiting = b.waitFor('takeover-input-error');
    b.socket.send(JSON.stringify({ type: 'takeover-key', ...body, key: 'home' }));
    const stolen = await waiting;
    assert.equal(stolen.code, 'TAKEOVER_SESSION_REQUIRED'); assert.equal(h.hub.sent.length, 0);
    const config = await (await fetch(`${url}api/scrcpy/stop`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).json();
    assert.equal(config.code, 'DEVICE_BUSY');
    a.socket.terminate();
    for (let n = 0; n < 20 && h.takeoverApi.status().state !== 'idle'; n++) await tick();
    // Network close event is asynchronous: await it explicitly before the assertion.
    if (h.takeoverApi.status().state !== 'idle') await new Promise(resolve => a.socket.once('close', resolve));
    await tick();
    assert.equal(h.takeoverApi.status().state, 'idle'); assert.equal(runtime.takeoverStatus().active, false);
    assert.throws(() => h.takeoverApi.key({ ...body, key: 'home' }, { owner: {} }), { code: 'TAKEOVER_SESSION_REQUIRED' });
});

test('bounded session expiry revokes ownership and sends one ended event without auto-resume', async t => {
    const events = [];
    const hub = { width: 1, height: 1, controlReady: () => true, injectTouch() { throw Error('must not execute'); } };
    const api = createViewerTakeover({ runtime, selectedSerial: () => 'A', authorize: async () => true,
        control: () => hub, checkPolicy: async () => 'com.example',
        invalidate() {}, assertCertain() {}, quarantine() {}, sessionMs: 40 });
    t.after(() => api.stop());
    const ended = deferred();
    await api.start({ serial: 'A' }, { owner: {}, signal: new AbortController().signal,
        notify(event) { events.push(event); ended.resolve(); } });
    await ended.promise;
    assert.equal(events.length, 1); assert.equal(events[0].code, 'TAKEOVER_EXPIRED');
    assert.equal(api.status().state, 'idle'); assert.equal(runtime.takeoverStatus().active, false);
});

test('HTTP connection management already in flight prevents takeover until the actual selection settles', async t => {
    const entered = deferred(), gate = deferred();
    const { url, cookie, origin, connect } = await live(t, { deviceApi: { async connect() {
        entered.resolve(); await gate.promise; return { ok: true };
    } } });
    const pending = fetch(`${url}api/connect`, { method: 'POST', headers: { Cookie: cookie, Origin: origin,
        'Content-Type': 'application/json' }, body: '{}' });
    await entered.promise;
    const c = await connect();
    const rejected = await c.request('takeover-start', { serial: 'A' });
    assert.equal(rejected.ok, false); assert.equal(rejected.code, 'DEVICE_BUSY');
    gate.resolve(); assert.equal((await (await pending).json()).ok, true);
    const accepted = await c.request('takeover-start', { serial: 'A' });
    assert.equal(accepted.ok, true);
    await c.request('takeover-end', { token: accepted.token, epoch: accepted.epoch });
});
