'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    send(data) { this.sent.push(data); }
    close(code) { this.closeCode = code; this.readyState = 3; this.emit('close'); }
}
function fixture(t, gate) {
    const packets = new Set(), frames = new Set();
    const hub = {
        seq: 1,
        lastSession: { type: 'session', width: 720, height: 1600 },
        lastConfig: { type: 'config', data: Buffer.from([1, 2, 3]) },
        lastKeyFrame: { type: 'frame', key: true, seq: 1, pts: 0, data: Buffer.alloc(32) },
        state: gate ? 'starting' : 'streaming', stopCalls: 0, lastPacketAt: 1, startedAt: Date.now(),
        subscribe(fn) { packets.add(fn); return () => packets.delete(fn); },
        status() { return { state: this.state, width: 720, height: 1600, codecString: 'avc1.64001e' }; },
        async start() { if (gate) await gate.promise; this.state = 'streaming'; },
        async stop() { this.stopCalls++; this.state = 'stopped'; },
    };
    const frameHub = {
        subscribe(fn) { frames.add(fn); return () => frames.delete(fn); },
        latestOrNull() { return null; }, status() { return {}; },
    };
    const server = new StreamServer({ scrcpyHub: hub, frameHub, logger: { warn() {}, log() {} } });
    t.after(() => { server.stopWatchdog(); server.cancelScrcpyProbe(); });
    return { server, hub, packets, frames, socket: new Socket() };
}
const jpeg = { seq: 1, capturedAt: 1, buffer: Buffer.alloc(32) };
const delta = { type: 'frame', seq: 2, pts: 1, key: false, data: Buffer.alloc(32) };

test('close during failed asynchronous start must not resurrect JPEG subscriptions', async (t) => {
    const gate = deferred();
    const { server, socket, packets, frames } = fixture(t, gate);
    server.handleSocket(socket);
    socket.close();
    gate.reject(new Error('cancelled'));
    await tick();
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 0);
    assert.equal(server.watchdogTimer, null);
});

test('close during handshake must not restart watchdog or send ready', async (t) => {
    const { server, socket, hub } = fixture(t);
    const gate = deferred();
    server.waitForHandshake = () => gate.promise;
    server.handleSocket(socket);
    socket.close();
    gate.resolve(true);
    await tick();
    assert.equal(server.watchdogTimer, null);
    assert.equal(socket.sent.length, 0);
    assert.equal(hub.stopCalls, 1);
});

test('last viewer closing cancels a pending hub start', async (t) => {
    const gate = deferred();
    const { server, socket, hub } = fixture(t, gate);
    server.handleSocket(socket);
    socket.close();
    assert.equal(hub.stopCalls, 1);
    gate.resolve();
    await tick();
});

test('request-jpeg detaches H264, remains JPEG during automatic recovery and ignores keyframe requests', async (t) => {
    const { server, socket, packets, frames } = fixture(t);
    server.handleSocket(socket);
    await tick();
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 1);
    await server.reattachScrcpy();
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 1);
    let replayCalls = 0;
    server.replayInit = () => { replayCalls++; return 1; };
    socket.emit('message', JSON.stringify({ type: 'request-keyframe' }));
    assert.equal(replayCalls, 0);
});

test('request-jpeg during pending start cancels attach continuation', async (t) => {
    const gate = deferred();
    const { server, socket, packets, frames } = fixture(t, gate);
    server.handleSocket(socket);
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    socket.sent.length = 0;
    gate.resolve();
    await tick();
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 1);
    assert.equal(socket.sent.filter((data) => typeof data === 'string' && data.includes('scrcpy-ready')).length, 0);
});

test('JPEG drops only overflowing frame and resumes when queue drains, including exact boundary', (t) => {
    const { server, socket } = fixture(t);
    server.maxBufferedBytes = 64;
    socket.bufferedAmount = 17;
    server.sendFrame(socket, jpeg);
    assert.equal(socket.sent.length, 0);
    assert.equal(socket.readyState, 1);
    socket.bufferedAmount = 16;
    server.sendFrame(socket, jpeg);
    assert.equal(socket.sent.length, 1);
});

test('H264 never silently drops delta: overflow closes and detaches the slow subscriber', async (t) => {
    const { server, socket, packets } = fixture(t);
    server.handleSocket(socket);
    await tick();
    socket.sent.length = 0;
    server.maxBufferedBytes = 64;
    socket.bufferedAmount = 16;
    server.sendScrcpyPacket(socket, delta);
    assert.equal(socket.sent.length, 1);
    socket.bufferedAmount = 17;
    server.sendScrcpyPacket(socket, { ...delta, seq: 3 });
    assert.equal(socket.closeCode, 1013);
    assert.equal(packets.size, 0);
    assert.equal(socket.sent.length, 1);
});

test('session wire packet carries the dimensions expected by viewer', (t) => {
    const { server, socket } = fixture(t);
    server.sendScrcpyPacket(socket, { type: 'session', width: 1600, height: 720 });
    const data = socket.sent[0];
    assert.equal(data.readUInt32LE(12), 4);
    assert.equal(data.length, 28);
    assert.equal(data.readUInt32BE(20), 1600);
    assert.equal(data.readUInt32BE(24), 720);
});

test('replay overflow closes without reviving watchdog after initialization', async (t) => {
    const { server, socket, hub, packets } = fixture(t);
    hub.lastKeyFrame = { ...delta, key: true, data: Buffer.alloc(1024) };
    hub.seq = hub.lastKeyFrame.seq;
    server.maxBufferedBytes = 512;
    await server.attachScrcpy(socket);
    assert.equal(socket.closeCode, 1013);
    assert.equal(packets.size, 0);
    assert.equal(server.watchdogTimer, null);
});

test('text replies obey queue limit while JPEG drops oversized replies without closing', async (t) => {
    const { server, socket } = fixture(t);
    server.handleSocket(socket);
    await tick();
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    socket.sent.length = 0;
    server.maxBufferedBytes = 64;
    socket.bufferedAmount = 64;
    socket.emit('message', JSON.stringify({ type: 'ping' }));
    assert.equal(socket.sent.length, 0);
    assert.equal(socket.readyState, 1);
});

test('disposing a socket with open readyState is terminal and does not stop a sibling', async (t) => {
    const { server, socket, hub, packets, frames } = fixture(t);
    const sibling = new Socket();
    await server.attachScrcpy(socket);
    await server.attachScrcpy(sibling);
    server.disposeSocket(socket);
    server.attachFrames(socket);
    assert.equal(await server.attachScrcpy(socket), false);
    assert.equal(packets.size, 1);
    assert.equal(frames.size, 0);
    assert.equal(hub.stopCalls, 0);
});


test('last viewer closing during recovery delay prevents a new hub start', async (t) => {
    const { server, socket, hub } = fixture(t);
    let starts = 0;
    hub.start = async () => { starts++; hub.state = 'streaming'; };
    await server.attachScrcpy(socket);
    server.reconnectDelayMs = 10;
    const recovery = server.handleScrcpyLoss('test');
    server.disposeSocket(socket);
    await recovery;
    assert.equal(starts, 0);
    assert.equal(server.watchdogTimer, null);
});


function viewer() {
    const html = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/viewer.html'), 'utf8');
    const source = html.slice(html.indexOf('    function setupH264('), html.indexOf('    function handleBinary('));
    const element = () => ({ classList: { add() {}, remove() {} }, textContent: '' });
    const paints = new Map(), timers = new Map(); let paintId = 0, timerId = 0;
    const context = vm.createContext({ Uint8Array, DataView, ArrayBuffer,
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); }, timers, streamNoticeTimer: null,
        now: 10000, Date: class extends Date { static now() { return context.now; } },
        requestAnimationFrame(fn) { paints.set(++paintId, fn); return paintId; },
        cancelAnimationFrame(id) { paints.delete(id); }, paints,
        $: () => ({ dataset: { streamState: 'ready' } }),
        HEADER_BYTES: 16, H264_MAGIC: 0x56434831, H264_FLAG_SESSION: 4, H264_FLAG_CONFIG: 2, H264_FLAG_KEY: 1,
        window: { VideoDecoder: true }, els: { screen: element(), h264: element(), errorBox: element() },
        setDot() {}, sendToServer(message) { context.requests.push(message); }, decoded: [], requests: [], instances: [],
        VideoDecoder: class {
            constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; context.instances.push(this); }
            configure(info) { this.info = info; this.state = 'configured'; }
            close() { this.state = 'closed'; }
            decode(chunk) { context.decoded.push(chunk); }
        }, EncodedVideoChunk: class { constructor(info) { Object.assign(this, info); } },
    });
    vm.runInContext(`let useH264 = true, h264Interrupted = false, h264Info = {width:720,height:1600,codecString:'avc1.64001e'}, h264Pending = null, h264ConfigBytes = null, h264Seq = 99, decodedSeq = -1, decoder = null, frameTimes = [], pendingPts = 0, streamNoticeTimer = null;\n${source}`, context);
    return context;
}
function wire(flags, seq, bytes) {
    const data = Buffer.alloc(16 + bytes.length);
    data.writeUInt32LE(0x56434831); data.writeUInt32LE(seq, 4); data.writeUInt32LE(flags, 12);
    bytes.copy(data, 16);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
}
const config = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x1e, 0, 0, 0, 1, 0x68, 1]);
test('viewer session rebuild clears sequence so replayed cached IDR is decoded with new dimensions', () => {
    const context = viewer();
    const session = Buffer.alloc(12); session.writeUInt32BE(1600, 4); session.writeUInt32BE(720, 8);
    context.packet = wire(4, 0, session);
    vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(2, 0, config);
    vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(1, 5, Buffer.from([0, 0, 1, 0x65, 1]));
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(context.decoded.length, 1);
    assert.equal(vm.runInContext('decoder.info.codedWidth', context), 1600);
    assert.equal(vm.runInContext('decoder.info.codedHeight', context), 720);
});
test('viewer ignores late H264 session/config after explicit JPEG fallback', () => {
    const context = viewer();
    vm.runInContext("fallbackToJpeg('test')", context);
    context.packet = wire(2, 0, config);
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(vm.runInContext('useH264', context), false);
    assert.equal(vm.runInContext('decoder', context), null);
});

test('viewer sustained decode backlog requests one resync and retains codec configuration', () => {
    const context = viewer();
    context.packet = wire(2, 0, config);
    vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(1, 1, Buffer.from([0, 0, 1, 0x65, 1]));
    vm.runInContext('handleH264Packet(packet); decoder.decodeQueueSize = 60;', context);
    context.packet = wire(0, 2, Buffer.from([0, 0, 1, 0x41, 1]));
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(context.instances[0].state, 'closed');
    assert.equal(vm.runInContext('decoder.state', context), 'configured');
    assert.ok(vm.runInContext('h264ConfigBytes', context));
    assert.equal(vm.runInContext('h264Seq', context), -1);
    assert.equal(context.requests[0]?.type, 'request-keyframe');
    vm.runInContext('handleH264Packet(packet); resetDecoderForResync()', context);
    assert.equal(context.requests.length, 1);
    assert.equal(context.decoded.length, 1, 'no dependent delta submitted after reset');
});

test('viewer drains a short contiguous burst without resetting the decoder', () => {
    const context = viewer();
    context.packet = wire(2, 0, config); vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(1, 1, Buffer.from([0,0,1,0x65,1]));
    vm.runInContext('handleH264Packet(packet); decoder.decodeQueueSize = 9', context);
    for (let seq = 2; seq <= 12; seq++) {
        context.packet = wire(0, seq, Buffer.from([0,0,1,0x41,1]));
        vm.runInContext('handleH264Packet(packet)', context);
    }
    assert.equal(context.requests.length, 0);
    assert.equal(context.instances.length, 1);
    assert.equal(context.decoded.length, 12);
    vm.runInContext('decoder.decodeQueueSize = 0', context);
    context.packet = wire(0, 13, Buffer.from([0,0,1,0x41,1]));
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(vm.runInContext('playback.backlogAt', context), null);
});

test('viewer uses an arriving IDR immediately even when the old decoder is overloaded', () => {
    const context = viewer();
    context.packet = wire(2, 0, config); vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(1, 1, Buffer.from([0,0,1,0x65,1]));
    vm.runInContext('handleH264Packet(packet); decoder.decodeQueueSize = 60', context);
    context.packet = wire(1, 600, Buffer.from([0,0,1,0x65,2]));
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(context.instances[0].state, 'closed');
    assert.equal(context.decoded.length, 2);
    assert.equal(context.decoded.at(-1).type, 'key');
    assert.equal(context.requests.length, 0);
    assert.equal(vm.runInContext('h264Seq', context), 600);
});

test('a low but persistent decoder backlog reaches the elapsed-time bound', () => {
    const context = viewer();
    context.packet = wire(2, 0, config); vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(1, 1, Buffer.from([0,0,1,0x65,1]));
    vm.runInContext('handleH264Packet(packet); decoder.decodeQueueSize = 9', context);
    context.packet = wire(0, 2, Buffer.from([0,0,1,0x41,1]));
    vm.runInContext('handleH264Packet(packet)', context);
    context.now += 250;
    context.packet = wire(0, 3, Buffer.from([0,0,1,0x41,1]));
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(context.requests.length, 1);
    assert.equal(context.decoded.length, 2);
    assert.equal(context.instances[0].state, 'closed');
});

test('a synchronous decode rejection does not advance reference sequence or become permanent JPEG', () => {
    const context = viewer();
    context.packet = wire(2, 0, config); vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(1, 1, Buffer.from([0,0,1,0x65,1]));
    vm.runInContext('handleH264Packet(packet); decoder.decode = () => { throw new Error("rejected"); }', context);
    context.packet = wire(0, 2, Buffer.from([0,0,1,0x41,1]));
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(vm.runInContext('h264Seq', context), -1);
    assert.equal(context.requests.at(-1).type, 'request-keyframe');
    assert.equal(vm.runInContext('useH264', context), true);
});

test('decoder errors retry H264, ignore retired callbacks and stop after three consecutive failures', () => {
    const context = viewer();
    context.packet = wire(2, 0, config); vm.runInContext('handleH264Packet(packet)', context);
    const old = context.instances[0];
    old.callbacks.error(new Error('transient decode failure'));
    assert.equal(context.requests[0].type, 'request-keyframe');
    assert.equal(vm.runInContext('useH264', context), true);
    old.callbacks.error(new Error('late callback'));
    assert.equal(context.requests.length, 1);
    context.instances.at(-1).callbacks.error(new Error('second failure'));
    assert.equal(context.requests.at(-1).type, 'request-keyframe');
    context.instances.at(-1).callbacks.error(new Error('third failure'));
    assert.equal(context.requests.at(-1).type, 'request-jpeg');
    assert.equal(vm.runInContext('useH264', context), false);
});

test('decoded bursts paint only the latest frame and release all frames on replacement or close', () => {
    const context = viewer();
    context.packet = wire(2, 0, config); vm.runInContext('handleH264Packet(packet)', context);
    context.rendered = [];
    vm.runInContext('renderFrame = frame => rendered.push(frame.id)', context);
    const frames = [1,2,3].map(id => ({ id, closes: 0, close() { this.closes++; } }));
    const instance = context.instances.at(-1);
    frames.forEach(frame => instance.callbacks.output(frame));
    assert.equal(context.paints.size, 1);
    assert.deepEqual(frames.map(frame => frame.closes), [1,1,0]);
    const paint = [...context.paints.values()][0]; context.paints.clear(); paint();
    assert.deepEqual(context.rendered, [3]);
    assert.deepEqual(frames.map(frame => frame.closes), [1,1,1]);
    const pending = { closes: 0, close() { this.closes++; } };
    instance.callbacks.output(pending);
    vm.runInContext('closeDecoder()', context);
    assert.equal(pending.closes, 1);
    assert.equal(context.paints.size, 0);
    assert.equal(context.timers.size, 0);
    const late = { closes: 0, close() { this.closes++; } };
    instance.callbacks.output(late);
    assert.equal(late.closes, 1);
    assert.equal(context.paints.size, 0);
});

test('a throttled animation callback cannot hold a decoded frame beyond its timer deadline', () => {
    const context = viewer();
    context.packet = wire(2, 0, config); vm.runInContext('handleH264Packet(packet)', context);
    context.rendered = [];
    vm.runInContext('renderFrame = frame => rendered.push(frame.id)', context);
    const frame = {id: 1, closes: 0, close() {this.closes++;}};
    context.instances[0].callbacks.output(frame);
    const delayedRaf = [...context.paints.values()][0];
    [...context.timers.values()][0]();
    assert.deepEqual(context.rendered, [1]);
    assert.equal(frame.closes, 1);
    assert.equal(context.paints.size, 0);
    assert.equal(context.timers.size, 0);
    delayedRaf();
    assert.deepEqual(context.rendered, [1], 'late callback cannot draw a released frame');
    assert.equal(frame.closes, 1);
});

test('60 and 120 fps streams update the rolling fps display', () => {
    const html = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/viewer.html'), 'utf8');
    const source = html.slice(html.indexOf('    function recordFrame('), html.indexOf('    function startStaleWatch('));
    for (const rate of [60, 120]) {
        const context = vm.createContext({ publishViewerStatus() {}, statusPublishedAt: 0,
            els: { fps: { textContent: '-- fps' }, interval: {}, lat: {} } });
        vm.runInContext(`let lastFrameAt=0, lastStatsAt=0, frameTimes=[], latencySamples=[];\n${source}`, context);
        for (let i=1; i<=rate*2; i++) vm.runInContext(`recordFrame(${10000+i*1000/rate})`, context);
        assert.equal(context.els.fps.textContent, `${rate.toFixed(1)} fps`);
    }
});

test('viewer rejects a delta before IDR and detects missing frame references after IDR', () => {
    const context = viewer();
    context.packet = wire(2, 0, config);
    vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(0, 3, Buffer.from([0, 0, 1, 0x41, 1]));
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(context.decoded.length, 0);
    context.packet = wire(1, 5, Buffer.from([0, 0, 1, 0x65, 1]));
    vm.runInContext('handleH264Packet(packet)', context);
    context.packet = wire(0, 101, Buffer.from([0, 0, 1, 0x41, 1]));
    vm.runInContext('handleH264Packet(packet)', context);
    assert.equal(context.decoded.length, 1);
    assert.equal(context.requests[0]?.type, 'request-keyframe');
});

test('pending ensureDevice cannot restart hub after server stop', async (t) => {
    const { server, socket, hub } = fixture(t);
    await server.attachScrcpy(socket);
    const gate = deferred();
    let starts = 0;
    hub.start = async () => { starts++; throw new Error('offline'); };
    server.ensureDevice = () => gate.promise;
    server.reconnectDelayMs = 0;
    const recovery = server.handleScrcpyLoss();
    await tick();
    await server.stop();
    gate.resolve({ ok: true });
    await recovery;
    assert.equal(starts, 1);
    assert.equal(server.recoveryTimer, null);
});

test('device change stops old hub before selecting and restarts existing H264 viewers', async (t) => {
    const { server, socket, hub } = fixture(t);
    await server.attachScrcpy(socket);
    const events = [];
    hub.stop = async () => { events.push('stop'); hub.state = 'stopped'; };
    hub.start = async () => { events.push('start'); hub.state = 'streaming'; };
    const result = await server.changeDevice(async () => { events.push('select'); return 'chosen'; });
    assert.equal(result, 'chosen');
    assert.deepEqual(events, ['stop', 'select', 'start']);
    assert.equal(server.scrcpyStreamers.size, 1);
});

test('stop while selection is pending prevents device transaction restarting', async (t) => {
    const { server, socket, hub } = fixture(t);
    await server.attachScrcpy(socket);
    const gate = deferred();
    let starts = 0;
    hub.start = async () => { starts++; };
    const changing = server.changeDevice(() => gate.promise);
    await tick();
    await server.stop();
    gate.resolve('selected');
    await changing;
    assert.equal(starts, 0);
    assert.equal(server.watchdogTimer, null);
});

test('device selection with no viewers or explicit JPEG viewers does not start H264', async (t) => {
    const { server, socket, hub } = fixture(t);
    let starts = 0;
    hub.start = async () => { starts++; };
    await server.changeDevice(async () => {});
    server.handleSocket(socket);
    await tick();
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    starts = 0;
    await server.changeDevice(async () => {});
    assert.equal(starts, 0);
    assert.equal(server.unsubscribers.size, 1);
});

test('probe with no H264 intent must not start hub', async (t) => {
    const { server, hub } = fixture(t);
    hub.state = 'stopped';
    let starts = 0;
    hub.start = async () => { starts++; };
    assert.equal(await server.tryRecoverScrcpy(), false);
    assert.equal(starts, 0);
});


test('HTTP capture from previous device is rejected after frame generation changes', async (t) => {
    const { server } = fixture(t);
    const gate = deferred();
    server.frameHub.generation = 1;
    server.frameHub.capture = () => gate.promise;
    let status, body;
    const response = { writeHead(code) { status = code; }, end(data) { body = data; } };
    const request = server.serveFrame({ method: 'GET' }, response);
    server.frameHub.generation++;
    gate.resolve({ ...jpeg, mime: 'image/jpeg' });
    await request;
    assert.equal(status, 503);
    assert.match(String(body), /设备已切换/);
});

test('probe waiting on start cannot reattach after stop', async (t) => {
    const { server, socket, hub } = fixture(t);
    server.attachFrames(socket);
    hub.state = 'stopped';
    const gate = deferred();
    hub.start = () => gate.promise;
    let reattached = 0;
    server.reattachScrcpy = async () => { reattached++; };
    const recovering = server.tryRecoverScrcpy();
    await server.stop();
    gate.resolve();
    assert.equal(await recovering, false);
    assert.equal(reattached, 0);
});

test('new socket during selection waits until selection completes', async (t) => {
    const { server, socket, hub, packets } = fixture(t);
    const gate = deferred();
    const changing = server.changeDevice(() => gate.promise);
    await tick();
    server.handleSocket(socket);
    assert.equal(packets.size, 0);
    gate.resolve();
    await changing;
    await tick();
    assert.equal(packets.size, 1);
    assert.equal(hub.state, 'streaming');
});


test('old handshake completion cannot publish ready while another device is being selected', async (t) => {
    const { server, socket } = fixture(t);
    const handshake = deferred(), selection = deferred();
    server.waitForHandshake = () => handshake.promise;
    const attaching = server.attachScrcpy(socket);
    const changing = server.changeDevice(() => selection.promise);
    await tick();
    socket.sent.length = 0;
    handshake.resolve(true);
    await attaching;
    assert.equal(socket.sent.length, 0);
    selection.resolve();
    await changing;
});

test('disconnect selection pauses H264 even with viewers and probes until an explicit selection resumes', async (t) => {
    const { server, socket, hub } = fixture(t);
    await server.attachScrcpy(socket);
    let starts = 0;
    hub.start = async () => { starts++; hub.state = 'streaming'; };
    await server.changeDevice(async () => {}, { resume: false });
    assert.equal(starts, 0);
    assert.equal(await server.tryRecoverScrcpy(), false);
    assert.equal(starts, 0);
    await server.changeDevice(async () => {}, { resume: true });
    assert.equal(starts, 1);
});


test('successful selection returns its result when H264 start fails and falls back to JPEG', async (t) => {
    const { server, socket, hub, frames } = fixture(t);
    await server.attachScrcpy(socket);
    hub.start = async () => { throw new Error('encoder unavailable'); };
    assert.equal(await server.changeDevice(async () => 'selected'), 'selected');
    assert.equal(frames.size, 1);
    assert.ok(server.recoveryTimer);
});

test('selection callback failure is not hidden as stream fallback', async (t) => {
    const { server } = fixture(t);
    await assert.rejects(server.changeDevice(async () => { throw new Error('selection failed'); }), /selection failed/);
});


for (const boundary of ['handshake', 'first-frame']) {
    test(`${boundary} timeout refuses ready and falls back to JPEG`, async (t) => {
        const { server, socket, frames, packets } = fixture(t);
        if (boundary === 'handshake') server.waitForHandshake = async () => false;
        else server.waitForFirstFrame = async () => false;
        server.handleSocket(socket);
        await tick();
        assert.equal(frames.size, 1);
        assert.equal(packets.size, 0);
        assert.equal(socket.sent.some(v => typeof v === 'string' && v.includes('scrcpy-ready')), false);
        assert.equal(server.watchdogTimer, null);
    });
}

test('no-first-frame watchdog recovers even with an alive socket; successful static screen stays legal', async (t) => {
    const { server, hub, socket } = fixture(t);
    await server.attachScrcpy(socket);
    hub.isSocketAlive = () => true;
    hub.lastPacketAt = 0;
    hub.startedAt = Date.now() - 100000;
    let losses = 0;
    server.handleScrcpyLoss = async () => { losses++; };
    assert.equal(await server.checkLiveness(), true);
    assert.equal(losses, 1);
    hub.lastPacketAt = 1;
    assert.equal(await server.checkLiveness(), false);
    assert.equal(losses, 1);
});

test('recovery does not announce success when handshake fails', async (t) => {
    const { server, hub, socket, frames } = fixture(t);
    await server.attachScrcpy(socket);
    server.waitForHandshake = async () => false;
    server.reconnectDelayMs = 0;
    server.maxRecoveryAttempts = 1;
    let stops = 0;
    hub.stop = async () => { stops++; hub.state = 'stopped'; };
    socket.sent.length = 0;
    await server.handleScrcpyLoss();
    assert.equal(frames.size, 1);
    assert.equal(socket.sent.some(v => typeof v === 'string' && v.includes('scrcpy-ready')), false);
    assert.ok(stops > 0);
});

test('readiness predicates require height and an actual frame, not merely SPS/config packets', async (t) => {
    const { server, hub } = fixture(t);
    hub.status = () => ({ state: hub.state, width: 720, height: 0, codecString: 'avc1.64001e' });
    assert.equal(await server.waitForHandshake(hub, 0), false);
    hub.lastPacketAt = 0;
    hub.packetsReceived = 20;
    hub.lastConfig = { data: Buffer.from([1]) };
    assert.equal(await server.waitForFirstFrame(hub, 0), false);
    hub.lastPacketAt = 1;
    assert.equal(await server.waitForFirstFrame(hub, 0), true);
    hub.state = 'error';
    assert.equal(await server.waitForFirstFrame(hub, 0), false);
});

test('stale generation handshake timeout never stops a replacement generation', async (t) => {
    const { server, hub } = fixture(t);
    hub._generation = 1;
    const gate = deferred();
    server.waitForHandshake = () => gate.promise;
    const ready = server.requireScrcpyReady(hub, server.lifecycle);
    hub._generation = 2;
    gate.resolve(false);
    await assert.rejects(ready, /取消/);
    assert.equal(hub.stopCalls, 0);
});

for (const entries of [['switchToScrcpy', 'switchToScrcpy'], ['switchToScrcpy', 'attachScrcpy'], ['attachScrcpy', 'switchToScrcpy'], ['attachScrcpy', 'attachScrcpy']]) {
    test(`concurrent ${entries.join('/')} shares readiness and leaves no subscription after dispose`, async (t) => {
        const { server, socket, packets, frames } = fixture(t);
        server.attachFrames(socket);
        const gate = deferred();
        server.waitForHandshake = () => gate.promise;
        let completed = 0;
        const first = server[entries[0]](socket).then(value => { completed++; return value; });
        const second = server[entries[1]](socket).then(value => { completed++; return value; });
        await tick();
        assert.equal(completed, 0, 'both callers must wait for readiness');
        gate.resolve(true);
        assert.deepEqual(await Promise.all([first, second]), [true, true]);
        assert.equal(packets.size, 1, 'one socket owns one H264 subscription');
        assert.equal(frames.size, 0);
        assert.equal(socket.sent.filter(v => typeof v === 'string' && v.includes('scrcpy-ready')).length, 1);
        server.disposeSocket(socket);
        assert.equal(packets.size, 0, 'dispose must release every subscription');
    });
}

test('overlapping periodic probes share one start and one reattach', async (t) => {
    const { server, socket, hub } = fixture(t);
    server.attachFrames(socket);
    hub.state = 'stopped';
    const gate = deferred();
    let starts = 0, reattached = 0;
    hub.start = async () => { starts++; await gate.promise; hub.state = 'streaming'; };
    const reattach = server.reattachScrcpy.bind(server);
    server.reattachScrcpy = async () => { reattached++; await reattach(); };
    const first = server.tryRecoverScrcpy(), second = server.tryRecoverScrcpy();
    gate.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(starts, 1);
    assert.equal(reattached, 1);
});

test('last H264 intent choosing JPEG releases hub, watchdog and probe but keeps JPEG alive', async (t) => {
    const { server, socket, hub, frames } = fixture(t);
    server.handleSocket(socket);
    await tick();
    server.scheduleScrcpyProbe();
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    await tick();
    assert.equal(hub.stopCalls, 1);
    assert.equal(server.watchdogTimer, null);
    assert.equal(server.recoveryTimer, null);
    assert.equal(frames.size, 1);
    socket.sent.length = 0;
    for (const listener of frames) listener(jpeg);
    assert.equal(socket.sent.length, 1, 'JPEG still delivers frames');
});

test('explicit JPEG does not stop a sibling H264 viewer or fallback H264 intent', async (t) => {
    const { server, socket, hub } = fixture(t);
    server.handleSocket(socket);
    await tick();
    const sibling = new Socket();
    server.attachFrames(sibling);
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    assert.equal(hub.stopCalls, 0);
    assert.equal(await server.tryRecoverScrcpy(), true);
    assert.equal(server.scrcpyStreamers.has(sibling), true);
    assert.equal(hub.stopCalls, 0);
});

test('explicit JPEG cancels pending startup and cannot resurrect hub after completion', async (t) => {
    const gate = deferred();
    const { server, socket, hub, packets, frames } = fixture(t, gate);
    server.handleSocket(socket);
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    assert.equal(hub.stopCalls, 1, 'cancel startup immediately');
    gate.resolve();
    await tick();
    assert.equal(hub.state, 'stopped');
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 1);
    assert.equal(server.watchdogTimer, null);
});

test('a new H264 viewer waits for asynchronous idle stop before starting', async (t) => {
    const { server, socket, hub, frames } = fixture(t);
    server.handleSocket(socket);
    await tick();
    const stopping = deferred();
    hub.stop = async () => { hub.stopCalls++; await stopping.promise; hub.state = 'stopped'; };
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    const sibling = new Socket();
    let starts = 0;
    hub.start = async () => { starts++; hub.state = 'streaming'; };
    const attaching = server.attachScrcpy(sibling);
    await tick();
    assert.equal(starts, 0, 'old stop must finish before new start');
    stopping.resolve();
    assert.equal(await attaching, true);
    assert.equal(starts, 1);
    assert.equal(hub.state, 'streaming');
    assert.equal(frames.size, 1);
    assert.ok(server.watchdogTimer);
});

test('explicit JPEG cancels a pending probe start without resurrecting H264', async (t) => {
    const { server, socket, hub, frames, packets } = fixture(t);
    server.handleSocket(socket);
    await tick();
    server.fallbackAllToJpeg();
    hub.state = 'stopped';
    const gate = deferred();
    hub.start = async () => { await gate.promise; hub.state = 'streaming'; };
    const recovering = server.tryRecoverScrcpy();
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    gate.resolve();
    assert.equal(await recovering, false);
    await tick();
    assert.equal(hub.state, 'stopped');
    assert.equal(frames.size, 1);
    assert.equal(packets.size, 0);
    assert.equal(server.watchdogTimer, null);
    assert.equal(server.recoveryTimer, null);
});

test('one viewer choosing JPEG preserves a streaming H264 sibling until it closes', async (t) => {
    const { server, socket, hub, frames, packets } = fixture(t);
    server.handleSocket(socket);
    const sibling = new Socket();
    server.handleSocket(sibling);
    await tick();
    socket.emit('message', JSON.stringify({ type: 'request-jpeg' }));
    assert.equal(hub.stopCalls, 0);
    assert.equal(packets.size, 1);
    assert.ok(server.watchdogTimer);
    sibling.close();
    await tick();
    assert.equal(hub.stopCalls, 1);
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 1);
    assert.equal(server.watchdogTimer, null);
});

test('loss recovery cannot overlap an in-flight periodic probe', async (t) => {
    const { server, socket, hub } = fixture(t);
    server.attachFrames(socket);
    hub.state = 'stopped';
    const gate = deferred();
    let starts = 0, reattached = 0;
    hub.start = async () => { starts++; await gate.promise; hub.state = 'streaming'; };
    const reattach = server.reattachScrcpy.bind(server);
    server.reattachScrcpy = async () => { reattached++; await reattach(); };
    server.reconnectDelayMs = 0;
    const probe = server.tryRecoverScrcpy();
    const loss = server.handleScrcpyLoss('overlapping close');
    gate.resolve();
    await Promise.all([probe, loss]);
    assert.equal(starts, 1);
    assert.equal(reattached, 1);
});

async function completes(promise) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('device switch did not complete')), 250); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

for (const withNewViewer of [false, true]) {
    test(`automatic JPEG fallback resumes after selection${withNewViewer ? ' with a new viewer' : ''}`, async (t) => {
        const { server, socket, hub, packets, frames } = fixture(t);
        await server.attachScrcpy(socket);
        server.fallbackAllToJpeg();
        const selection = deferred();
        let device = 'old';
        const subscriptions = [];
        const subscribe = hub.subscribe.bind(hub);
        hub.subscribe = fn => { subscriptions.push(device); return subscribe(fn); };
        const changing = server.changeDevice(async () => { await selection.promise; device = 'new'; return 'chosen'; });
        await tick();
        const sibling = new Socket();
        if (withNewViewer) server.handleSocket(sibling);
        assert.deepEqual(subscriptions, [], 'selection must isolate the old device');
        selection.resolve();
        assert.equal(await completes(changing), 'chosen');
        await tick();
        assert.deepEqual(subscriptions, withNewViewer ? ['new', 'new'] : ['new']);
        assert.equal(packets.size, withNewViewer ? 2 : 1);
        assert.equal(frames.size, 0);
        assert.equal(server.pendingScrcpyAttachments.size, 0);
    });
}

test('new viewer cannot subscribe or start old device while old hub stop is pending', async (t) => {
    const { server, socket, hub, packets } = fixture(t);
    const stopping = deferred();
    let selected = false, starts = 0;
    hub.stop = async () => { await stopping.promise; hub.state = 'stopped'; };
    hub.start = async () => { assert.equal(selected, true); starts++; hub.state = 'streaming'; };
    const changing = server.changeDevice(async () => { selected = true; });
    server.handleSocket(socket);
    await tick();
    assert.equal(packets.size, 0);
    assert.equal(starts, 0);
    stopping.resolve();
    await completes(changing);
    await tick();
    assert.equal(packets.size, 1);
    assert.equal(starts, 1);
});

test('overlapping selections during fallback reattach do not form a second wait cycle', async (t) => {
    const { server, socket, hub, packets, frames } = fixture(t);
    await server.attachScrcpy(socket);
    server.fallbackAllToJpeg();
    const handshake = deferred();
    let waits = 0;
    server.waitForHandshake = async () => { if (++waits === 2) await handshake.promise; return true; };
    const selections = [];
    const first = server.changeDevice(async () => { selections.push('first'); return 'first'; });
    await tick();
    const second = server.changeDevice(async () => { selections.push('second'); return 'second'; });
    handshake.resolve();
    assert.deepEqual(await completes(Promise.all([first, second])), ['first', 'second']);
    assert.deepEqual(selections, ['first', 'second']);
    assert.equal(hub.state, 'streaming');
    assert.equal(packets.size, 1);
    assert.equal(frames.size, 0);
});

test('queued selection supersedes pending selection without publishing its old stream', async (t) => {
    const { server, socket, hub } = fixture(t);
    server.attachFrames(socket);
    const selection = deferred();
    const events = [];
    hub.start = async () => { events.push('start'); hub.state = 'streaming'; };
    const first = server.changeDevice(async () => { events.push('first'); await selection.promise; return 'first'; });
    await tick();
    const second = server.changeDevice(async () => { events.push('second'); return 'second'; });
    server.handleSocket(new Socket());
    selection.resolve();
    assert.deepEqual(await completes(Promise.all([first, second])), ['first', 'second']);
    assert.deepEqual(events, ['first', 'second', 'start']);
    assert.equal(server.scrcpyStreamers.size, 2);
});

test('stop cancels fallback and new viewer attachments waiting for device selection', async (t) => {
    const { server, socket, packets, frames } = fixture(t);
    server.attachFrames(socket);
    const selection = deferred();
    const changing = server.changeDevice(() => selection.promise);
    const sibling = new Socket();
    server.handleSocket(sibling);
    await tick();
    await server.stop();
    selection.resolve('chosen');
    assert.equal(await completes(changing), 'chosen');
    await tick();
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 0);
    assert.equal(server.watchdogTimer, null);
    assert.equal(server.pendingScrcpyAttachments.size, 0);
});


test('selection rejection reaches waiting attach and a later fallback selection still completes', async (t) => {
    const { server, socket, packets, frames } = fixture(t);
    server.attachFrames(socket);
    const selection = deferred();
    const changing = server.changeDevice(() => selection.promise);
    await tick();
    const sibling = new Socket();
    const attaching = server.attachScrcpy(sibling);
    const failedChange = assert.rejects(changing, /selection failed/);
    const failedAttach = assert.rejects(attaching, /selection failed/);
    selection.reject(new Error('selection failed'));
    await completes(Promise.all([failedChange, failedAttach]));
    assert.equal(packets.size, 0);
    assert.equal(frames.size, 1);
    assert.equal(server.selectionBarrier, null);
    assert.equal(server.pendingScrcpyAttachments.size, 0);
    assert.equal(await completes(server.changeDevice(async () => 'recovered')), 'recovered');
    assert.equal(packets.size, 1);
    assert.equal(frames.size, 0);
});

test('sequential switches repeatedly restore automatic fallback without retaining a barrier', async (t) => {
    const { server, socket, packets, frames } = fixture(t);
    await server.attachScrcpy(socket);
    for (const device of ['first', 'second', 'third']) {
        server.fallbackAllToJpeg();
        assert.equal(await completes(server.changeDevice(async () => device)), device);
        assert.equal(packets.size, 1);
        assert.equal(frames.size, 0);
        assert.equal(server.selectionBarrier, null);
        assert.equal(server.changingDevice, null);
    }
});

test('viewer waiting on one selection follows a queued replacement before subscribing', async (t) => {
    const { server, socket, hub, packets } = fixture(t);
    const firstGate = deferred(), secondGate = deferred();
    let device = 'old';
    const subscribed = [];
    const subscribe = hub.subscribe.bind(hub);
    hub.subscribe = fn => { subscribed.push(device); return subscribe(fn); };
    const first = server.changeDevice(async () => { await firstGate.promise; device = 'first'; });
    await tick();
    server.handleSocket(socket);
    const second = server.changeDevice(async () => { await secondGate.promise; device = 'second'; });
    firstGate.resolve();
    await tick();
    assert.equal(packets.size, 0);
    assert.deepEqual(subscribed, []);
    secondGate.resolve();
    await completes(Promise.all([first, second]));
    await tick();
    assert.deepEqual(subscribed, ['second']);
    assert.equal(packets.size, 1);
});


test('reattach makes only one new attempt when fallback startup genuinely fails', async (t) => {
    const { server, socket, hub, frames, packets } = fixture(t);
    server.attachFrames(socket);
    hub.state = 'stopped';
    let starts = 0;
    hub.start = async () => { starts++; throw new Error('encoder unavailable'); };
    await completes(server.reattachScrcpy());
    assert.equal(starts, 1);
    assert.equal(frames.size, 1);
    assert.equal(packets.size, 0);
    assert.equal(server.pendingScrcpyAttachments.size, 0);
});
