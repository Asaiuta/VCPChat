'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { StreamParser, ScrcpyHub } = require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');

function seeded() {
    const hub = new ScrcpyHub({});
    hub._emitPacket({ type: 'session', width: 720, height: 1600 });
    hub._emitPacket({ type: 'config', data: Buffer.from('config') });
    hub._emitPacket({ type: 'frame', key: true, data: Buffer.from('IDR') });
    return hub;
}
test('replay does not offer an old IDR across a missing delta chain', () => {
    const hub = seeded();
    hub._emitPacket({ type: 'frame', key: false, data: Buffer.from('delta') });
    const sent = []; hub.replayInitTo(packet => sent.push(packet));
    assert.deepEqual(sent.map(packet => packet.type), ['session', 'config']);
    hub._emitPacket({ type: 'frame', key: true, data: Buffer.from('fresh IDR') });
    const ready = []; hub.replayInitTo(packet => ready.push(packet));
    assert.equal(ready.at(-1).seq, hub.seq);
});
test('rotation and reconfiguration invalidate cached codec dependencies', () => {
    const hub = seeded();
    hub._emitPacket({ type: 'session', width: 1600, height: 720 });
    const sent = []; hub.replayInitTo(packet => sent.push(packet));
    assert.deepEqual(sent.map(packet => packet.type), ['session']);
    assert.equal(hub.lastConfig, null); assert.equal(hub.lastKeyFrame, null);
    hub._emitPacket({ type: 'config', data: Buffer.from('landscape') });
    hub._emitPacket({ type: 'frame', key: true, data: Buffer.from('landscape IDR') });
    hub._emitPacket({ type: 'config', data: Buffer.from('replacement config') });
    assert.equal(hub.lastKeyFrame, null);
});
test('fragmented packet assembly copies at most linearly and releases consumed buffers', t => {
    const size = 4 * 1024 * 1024;
    const wire = Buffer.alloc(size + 12, 19); wire[0] = 0; wire.writeUInt32BE(size, 8);
    let delivered;
    const parser = new StreamParser({ onFrame(payload) { delivered = payload; } });
    parser.push(Buffer.alloc(69));
    let copied = 0;
    const concat = Buffer.concat, copy = Buffer.prototype.copy;
    t.mock.method(Buffer, 'concat', function (parts, ...args) {
        copied += parts.reduce((n, part) => n + part.length, 0); return concat.call(this, parts, ...args);
    });
    t.mock.method(Buffer.prototype, 'copy', function (...args) {
        const size = copy.apply(this, args); copied += size; return size;
    });
    for (let i = 0; i < wire.length; i += 65536) parser.push(wire.subarray(i, i + 65536));
    assert.deepEqual(delivered, wire.subarray(12));
    assert.ok(copied <= 2 * wire.length, `copied ${copied} bytes for ${wire.length} input bytes`);
    assert.equal(parser.buffer.length, 0);
    assert.equal(parser.buffer.buffer.byteLength, 0);
});
test('cached small payload cannot pin an unrelated coalesced large packet', () => {
    const small = Buffer.alloc(16); small[0] = 0x40; small.writeUInt32BE(4, 8);
    const large = Buffer.alloc(1024 * 1024 + 12); large.writeUInt32BE(1024 * 1024, 8);
    let config;
    const parser = new StreamParser({ onConfig(payload) { config = payload; } });
    parser.push(Buffer.concat([Buffer.alloc(69), small, large]));
    assert.equal(config.length, 4);
    assert.ok(config.buffer.byteLength <= 8192);
    assert.equal(parser.buffer.buffer.byteLength, 0);
});

function viewers(t) {
    const hub = seeded();
    Object.assign(hub, { state: 'streaming', width: 720, height: 1600, codecString: 'avc1.64001e' });
    const jpegSinks = new Set();
    const server = new StreamServer({ scrcpyHub: hub, logger: {}, firstFrameTimeoutMs: 50,
        frameHub: { latestOrNull: () => null, status: () => ({}), subscribe(sink) {
            jpegSinks.add(sink); return () => jpegSinks.delete(sink);
        } } });
    t.after(() => server.stop());
    const socket = () => ({ readyState: 1, sent: [], send(data) { this.sent.push(data); }, close() { this.readyState = 3; } });
    const frames = client => client.sent.filter(Buffer.isBuffer).filter(data => (data.readUInt32LE(12) & 6) === 0)
        .map(data => data.readUInt32LE(4));
    const emit = key => hub._emitPacket({ type: 'frame', key, pts: hub.seq + 1, data: Buffer.from([0, 0, 1, key ? 0x65 : 0x41, 1]) });
    return { server, hub, socket, frames, emit, jpegSinks };
}

test('late viewer and resync wait for a new IDR without interrupting an established viewer', async t => {
    const { server, hub, socket, frames, emit } = viewers(t);
    const healthy = socket(), late = socket();
    await server.attachScrcpy(healthy);
    emit(false); // frame 2 is no longer replayable from cached IDR 1
    await server.attachScrcpy(late);
    emit(false);
    assert.deepEqual(frames(healthy), [1, 2, 3]);
    assert.deepEqual(frames(late), []);
    emit(true); emit(false);
    assert.deepEqual(frames(late), [4, 5]);
    server.replayInit(late);
    emit(false);
    assert.deepEqual(frames(late), [4, 5]);
    emit(true);
    assert.deepEqual(frames(late), [4, 5, 7]);
    assert.deepEqual(frames(healthy), [1, 2, 3, 4, 5, 6, 7]);
    hub._emitPacket({ type: 'session', width: 1600, height: 720 });
    emit(true); // no configuration for the new encoder yet
    assert.deepEqual(frames(late), [4, 5, 7]);
    hub._emitPacket({ type: 'config', data: Buffer.from([1, 2]) });
    emit(false); emit(true);
    assert.equal(frames(late).at(-1), 10);
});

test('a static stream supplies JPEG while awaiting IDR, then resumes configured H264', async t => {
    const { server, socket, frames, emit, jpegSinks } = viewers(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    emit(false);
    const client = socket();
    await server.attachScrcpy(client);
    t.mock.timers.tick(51);
    assert.equal(jpegSinks.size, 1);
    assert.equal(server.scrcpyStreamers.size, 1, 'keep listening for a fresh IDR');
    assert.ok(client.sent.some(value => typeof value === 'string' && value.includes('scrcpy-fallback')));
    emit(false);
    assert.deepEqual(frames(client), []);
    emit(true);
    assert.equal(jpegSinks.size, 0);
    assert.deepEqual(frames(client), [4]);
    const binary = client.sent.filter(Buffer.isBuffer);
    assert.deepEqual(binary.slice(-3).map(value => value.readUInt32LE(12)), [4, 2, 1]);
    server.replayInit(client);
    emit(false);
    server.disposeSocket(client);
    t.mock.timers.tick(51);
    assert.equal(jpegSinks.size, 0, 'closed viewers cannot be resurrected by the wait timer');
});

test('repeated resync requests cannot postpone JPEG preview or disturb a healthy sibling', async t => {
    const { server, hub, socket, frames, emit, jpegSinks } = viewers(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const healthy = socket();
    await server.attachScrcpy(healthy);
    emit(false);
    const client = Object.assign(new EventEmitter(), socket());
    server.handleSocket(client);
    await server.pendingScrcpyAttachments.get(client);
    const initial = client.sent.length;
    t.mock.timers.tick(40);
    client.emit('message', JSON.stringify({ type: 'request-keyframe' }));
    client.emit('message', JSON.stringify({ type: 'request-keyframe' }));
    assert.equal(client.sent.length, initial, 'initialization is already on the ordered socket');
    t.mock.timers.tick(11);
    assert.equal(jpegSinks.size, 1, 'original deadline remains in force');
    emit(true); emit(false);
    assert.equal(jpegSinks.size, 0);
    assert.equal(frames(client).at(-1), hub.seq);
    assert.deepEqual(frames(healthy), [1,2,3,4]);
});

test('replaying during JPEG preview releases its subscription and bounds the next wait', async t => {
    const { server, socket, emit, frames, jpegSinks } = viewers(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    emit(false);
    const client = socket();
    await server.attachScrcpy(client);
    t.mock.timers.tick(51);
    assert.equal(jpegSinks.size, 1);
    client.bufferedAmount = 123;
    assert.equal(server.metrics().bufferedBytes, 123, 'one transport shared by both subscriptions');
    client.sent.length = 0;
    server.replayInit(client);
    assert.equal(jpegSinks.size, 0);
    assert.ok(JSON.parse(client.sent[0]).type === 'scrcpy-ready', 'viewer must leave JPEG before replay');
    emit(false);
    assert.deepEqual(frames(client), []);
    t.mock.timers.tick(51);
    assert.equal(jpegSinks.size, 1);
    await server.reattachScrcpy();
    assert.equal(jpegSinks.size, 0, 'recovery also retires the temporary preview');
    emit(true);
    assert.deepEqual(frames(client), [4]);
    t.mock.timers.tick(51);
    assert.equal(jpegSinks.size, 0, 'retired timers cannot restart JPEG after IDR');
});

test('empty configuration cannot authorize a keyframe after rotation', async t => {
    const { server, hub, socket, emit, frames } = viewers(t);
    const client = socket();
    await server.attachScrcpy(client);
    hub._emitPacket({ type: 'session', width: 1600, height: 720 });
    hub._emitPacket({ type: 'config', data: Buffer.alloc(0) });
    emit(true);
    assert.deepEqual(frames(client), [1]);
});

test('a send failure while leaving preview disposes both subscriptions without sending the key', async t => {
    const { server, socket, emit, jpegSinks } = viewers(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    emit(false);
    const client = socket();
    await server.attachScrcpy(client);
    t.mock.timers.tick(51);
    let attempts = 0;
    client.send = () => { attempts++; throw new Error('closed transport'); };
    emit(true);
    assert.equal(attempts, 1);
    assert.equal(jpegSinks.size, 0);
    assert.equal(server.scrcpyStreamers.size, 0);
    t.mock.timers.tick(51);
    assert.equal(jpegSinks.size, 0);
});
