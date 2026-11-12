'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamParser } = require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
const { FrameHub } = require('../VCPDistributedServer/Plugin/AndroidController/lib/frame-hub');
const logger = { log() {}, warn() {} };
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

test('parser drains every complete packet in a coalesced TCP read', () => {
    let frames = 0;
    const parser = new StreamParser({ onFrame() { frames++; } });
    parser.push(Buffer.alloc(69));
    const packet = Buffer.alloc(13);
    packet.writeUInt32BE(1, 8);
    for (let i = 0; i < 4; i++) parser.push(Buffer.concat(Array(2000).fill(packet)));
    assert.equal(frames, 8000);
    assert.equal(parser.buffer.length, 0);
});

test('parallel display starts both resolve to the bound port', async t => {
    const server = new StreamServer({ port: 0, logger });
    t.after(() => server.stop());
    const ports = await Promise.all([server.start(), server.start()]);
    assert.ok(ports[0] > 0);
    assert.equal(ports[1], ports[0]);
});

test('display restart waits for pending stop and keeps replacement listening', async t => {
    const gate = deferred();
    const server = new StreamServer({ port: 0, logger, scrcpyHub: { stop: () => gate.promise } });
    t.after(() => server.stop());
    await server.start();
    const old = server.server;
    const stop = server.stop();
    let restarted = false;
    const restart = server.start().then(port => { restarted = true; return port; });
    await new Promise(resolve => setImmediate(resolve));
    const premature = restarted;
    gate.resolve();
    await stop;
    const port = await restart;
    assert.equal(premature, false);
    assert.ok(port > 0);
    assert.notEqual(server.server, old);
    assert.equal(server.server.listening, true);
});

function jpegFixture() {
    const sinks = new Set();
    const server = new StreamServer({ logger, frameHub: {
        latestOrNull() { return null; }, status() { return {}; },
        subscribe(sink) { sinks.add(sink); return () => sinks.delete(sink); },
    } });
    const socket = { readyState: 1, send() {}, close() {} };
    return { server, socket, sinks };
}

test('failed initial JPEG status send cannot resurrect a disposed subscription', () => {
    const { server, socket, sinks } = jpegFixture();
    socket.send = () => { throw new Error('write failed'); };
    server.attachFrames(socket);
    assert.equal(server.disposedSockets.has(socket), true);
    assert.equal(sinks.size, 0);
    assert.equal(server.unsubscribers.size, 0);
});

test('JPEG frame send failure releases subscription without waiting for close', () => {
    const { server, socket, sinks } = jpegFixture();
    server.attachFrames(socket);
    socket.send = () => { throw new Error('write failed'); };
    for (const sink of sinks) sink({ seq: 1, capturedAt: 1, buffer: Buffer.alloc(64) });
    assert.equal(sinks.size, 0);
    assert.equal(server.unsubscribers.size, 0);
});

test('stopped FrameHub rejects new captures without calling ADB', async () => {
    let calls = 0;
    const hub = new FrameHub({ captureMode: 'png', adb: { execOutBinary() { calls++; throw new Error('ADB called'); } } });
    hub.stop();
    await assert.rejects(hub.capture(), /停止/);
    await assert.rejects(hub.captureOneShot(), /停止/);
    assert.equal(calls, 0);
});

for (const kind of ['capture', 'captureOneShot']) test(`FrameHub stop drains ${kind} and prevents late retry/fallback`, async () => {
    const gate = deferred(); let calls = 0;
    const hub = new FrameHub({ logger, adb: { execOutBinary() { calls++; return gate.promise; } } });
    const work = hub[kind]().catch(error => error);
    hub.invalidateSelection(); // invalidation must not lose ownership of the old capture
    let stopped = false;
    const stopping = hub.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    gate.resolve(Buffer.alloc(0));
    await work; await stopping;
    assert.equal(calls, 1);
    assert.equal(hub.latest, null);
});



test('stop during initial bind drains startup and allows a fresh start', async t => {
    const server = new StreamServer({ port: 0, logger });
    t.after(() => server.stop());
    const starting = server.start();
    const stopping = server.stop();
    assert.equal(server.stop(), stopping, 'concurrent stops share ownership');
    await Promise.all([starting, stopping]);
    assert.equal(server.server, null);
    assert.equal(server.wss, null);
    assert.equal(server.actualPort, null);
    assert.ok(await server.start() > 0);
    assert.equal(server.server.listening, true);
});

test('failed bind releases server and WebSocket resources before retry', async t => {
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    let attempts = 0;
    t.mock.method(http.Server.prototype, 'listen', function (...args) {
        if (++attempts === 1) {
            queueMicrotask(() => this.emit('error', Object.assign(new Error('bind denied'), { code: 'EACCES' })));
            return this;
        }
        return listen.apply(this, args);
    });
    const server = new StreamServer({ port: 0, logger });
    t.after(() => server.stop());
    const first = server.start();
    assert.equal(server.start(), first);
    await assert.rejects(first, /bind denied/);
    assert.equal(server.server, null);
    assert.equal(server.wss, null);
    assert.equal(server.sessionToken, null);
    assert.ok(await server.start() > 0);
});
