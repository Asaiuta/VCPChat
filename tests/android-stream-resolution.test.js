'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');

const filename = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub.js');
const source = fs.readFileSync(filename, 'utf8');
const productionRequire = createRequire(filename);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function streamBytes() {
    const handshake = Buffer.alloc(69);
    handshake.writeUInt32BE(0x68323634, 65);
    const session = Buffer.alloc(12);
    session[0] = 0x80;
    session.writeUInt32BE(720, 4);
    session.writeUInt32BE(1600, 8);
    const packet = (flag, bytes) => {
        const header = Buffer.alloc(12);
        header[0] = flag;
        header.writeUInt32BE(bytes.length, 8);
        return Buffer.concat([header, bytes]);
    };
    return Buffer.concat([handshake, session,
        packet(0x40, Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x1e])),
        packet(0x20, Buffer.from([0x65]))]);
}

// Stub only external I/O; resolution, startup, parsing and config lifecycle remain production code.
function setup(options = {}) {
    const calls = [];
    const childProcess = {
        execFile(_adb, args, _opts, callback) {
            calls.push(['adb', ...args]);
            if (args[0] === 'devices') {
                queueMicrotask(() => callback(null, 'List of devices attached\nA device\nB device\n', ''));
            } else if (args.slice(-3).join(' ') === 'shell wm size') {
                Promise.resolve().then(() => options.readSize ? options.readSize(args[1])
                    : { ok: true, stdout: options.wm ?? 'Physical size: 1080x2400\n' })
                    .then(result => callback(result.ok ? null : new Error('wm failed'), result.stdout || '', result.stderr || ''),
                        error => callback(error, '', error.message));
            } else queueMicrotask(() => callback(null, 'PRESENT', ''));
        },
        spawn(_adb, args) {
            calls.push(['spawn', ...args]);
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.kill = () => {};
            return proc;
        },
    };
    const net = {
        createConnection() {
            calls.push(['connect']);
            const socket = new EventEmitter();
            socket.setNoDelay = () => {};
            socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
            queueMicrotask(() => { socket.emit('connect'); socket.emit('data', streamBytes()); });
            return socket;
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        require(name) { return name === 'child_process' ? childProcess : name === 'net' ? net : productionRequire(name); },
        module, exports: module.exports, __dirname: path.dirname(filename), Buffer, console, setTimeout, clearTimeout,
    }, { filename });
    const { ScrcpyHub } = module.exports;
    ScrcpyHub.findFreePort = async () => 12345;
    const hub = new ScrcpyHub({ adbPath: 'stub-adb', serial: 'A', logger: {}, readyDeadlineMs: 0, ...options.hub });
    const commands = () => calls.filter(call => call[0] === 'spawn').map(call => call.at(-1));
    const reads = () => calls.filter(call => call.slice(-3).join(' ') === 'shell wm size');
    return { hub, calls, commands, reads, ScrcpyHub };
}

for (const [name, width, height, short, expected] of [
    ['540p portrait', 1080, 2400, 540, 1200],
    ['720p portrait', 1080, 2400, 720, 1600],
    ['1080p portrait', 1080, 2400, 1080, 2400],
    ['1440p does not upscale', 1080, 2400, 1440, 2400],
    ['2160p does not upscale', 1080, 2400, 2160, 2400],
    ['720p landscape', 2400, 1080, 720, 1600],
    ['540p landscape', 2400, 1080, 540, 1200],
    ['1440p high resolution', 2160, 3840, 1440, 2560],
    ['2160p high resolution', 4320, 7680, 2160, 3840],
    ['square', 1440, 1440, 720, 720],
    ['minimum', 1080, 2400, 180, 400],
    ['alignment belongs to scrcpy', 1000, 2222, 540, 1199],
    ['exact rational scaling avoids float ratio underflow', 264, 286, 180, 195],
    ['original', 1440, 3120, 0, 0],
]) {
    test(`${name}: actual max_size preserves aspect ratio and source size`, async t => {
        const { hub, commands, reads, calls } = setup({ wm: `Physical size: ${width}x${height}\r\n`, hub: { maxShortEdge: short } });
        t.after(() => hub.stop());
        const status = await hub.start();
        assert.equal(status.maxShortEdge, short);
        assert.equal(status.maxSize, 540, 'legacy limit is retained separately');
        assert.equal(status.sourceWidth, width);
        assert.equal(status.sourceHeight, height);
        assert.equal(status.effectiveMaxSize, expected);
        assert.match(commands()[0], new RegExp(` max_size=${expected} `));
        assert.equal(reads().length, 1);
        assert.equal(reads()[0][2], 'A');
        assert.equal(calls.some(call => call.some(arg => /crop=|wm size \d|wm density/.test(String(arg)))), false);
    });
}

for (const wm of [
    'Physical size: 1080x2400\nOverride size: 800x1280\n',
    'Override size: 800x1280\r\nPhysical size: 1080x2400\r\n',
    'Override size: 800x1280\n',
]) {
    test(`wm Override wins independent of output order: ${JSON.stringify(wm)}`, async t => {
        const { hub, commands } = setup({ wm, hub: { maxShortEdge: 540 } });
        t.after(() => hub.stop());
        const status = await hub.start();
        assert.equal(status.sourceWidth, 800);
        assert.equal(status.sourceHeight, 1280);
        assert.equal(status.effectiveMaxSize, 864);
        assert.match(commands()[0], / max_size=864 /);
    });
}

for (const [name, readSize] of [
    ['empty output', () => ({ ok: true, stdout: '' })],
    ['malformed output', () => ({ ok: true, stdout: 'PRESENT' })],
    ['zero dimension', () => ({ ok: true, stdout: 'Physical size: 0x2400' })],
    ['overflow dimension', () => ({ ok: true, stdout: 'Physical size: 999999999999999999999x2400' })],
    ['malformed active Override', () => ({ ok: true, stdout: 'Physical size: 1080x2400\nOverride size: invalid' })],
    ['zero active Override', () => ({ ok: true, stdout: 'Physical size: 1080x2400\nOverride size: 0x1600' })],
    ['adb failure', () => ({ ok: false, stdout: 'Physical size: 1080x2400' })],
    ['rejected I/O', () => { throw new Error('adb unavailable'); }],
]) {
    test(`short edge explicitly fails on ${name}; native and legacy still work`, async t => {
        for (const hubOptions of [{ maxShortEdge: 720 }, { maxShortEdge: 0 }, { maxSize: 900 }]) {
            const { hub, calls, commands } = setup({ readSize, hub: hubOptions });
            t.after(() => hub.stop());
            if (hubOptions.maxShortEdge === 720) {
                await assert.rejects(hub.start(), { code: 'SCRCPY_SOURCE_SIZE_UNAVAILABLE' });
                assert.equal(hub.status().state, 'error');
                assert.match(hub.status().lastError.message, /源屏幕尺寸/);
                assert.equal(hub.status().effectiveMaxSize, null);
                assert.equal(calls.some(call => call.includes('forward') || call[0] === 'spawn'), false);
            } else {
                const status = await hub.start();
                const expected = hubOptions.maxShortEdge === 0 ? 0 : 900;
                assert.equal(status.effectiveMaxSize, expected);
                assert.match(commands()[0], new RegExp(` max_size=${expected} `));
            }
            assert.equal(hub.status().sourceWidth, null);
            assert.equal(hub.status().sourceHeight, null);
        }
    });
}

test('legacy environment/constructor values remain clamped and preserve legacy mode', async t => {
    const { hub, commands, ScrcpyHub } = setup({ hub: { maxSize: '1080', bitRate: '4000000', maxFps: '60' } });
    t.after(() => hub.stop());
    assert.equal(hub.status().maxShortEdge, null);
    assert.equal(hub.status().sourceWidth, null);
    assert.equal(hub.status().sourceHeight, null);
    assert.equal(hub.status().effectiveMaxSize, null);
    await hub.start();
    assert.match(commands()[0], / max_size=1080 video_bit_rate=4000000 max_fps=60 /);
    assert.match(commands()[0], / video_codec_options=i-frame-interval=1(?: |$)/);
    assert.equal(new ScrcpyHub({ maxSize: 0 }).maxSize, 180);
    assert.equal(new ScrcpyHub({ maxSize: 9999 }).maxSize, 2160);
});

test('every real start rereads the selected device; legacy requests leave short-edge mode', async t => {
    const { hub, reads, commands } = setup({
        readSize: serial => ({ ok: true, stdout: serial === 'A' ? 'Physical size: 1080x2400' : 'Physical size: 1600x2560' }),
        hub: { maxShortEdge: 720, maxFps: 30 },
    });
    t.after(() => hub.stop());
    await hub.start();
    await hub.start();
    assert.equal(reads().length, 1, 'already-streaming start is idempotent');
    await hub.stop();
    assert.equal(hub.status().sourceWidth, null);
    assert.equal(hub.status().effectiveMaxSize, null);
    hub.configure({ serial: 'B', maxFps: 60 });
    assert.equal(hub.status().maxShortEdge, 720, 'partial updates preserve mode');
    await hub.start();
    assert.equal(hub.status().sourceWidth, 1600);
    assert.equal(hub.status().effectiveMaxSize, 1152);
    assert.deepEqual(reads().map(call => call[2]), ['A', 'B']);
    await hub.stop();
    hub.configure({ maxShortEdge: 0 });
    await hub.start();
    assert.equal(hub.status().effectiveMaxSize, 0);
    await hub.stop();
    hub.configure({ maxSize: 900 });
    assert.equal(hub.status().maxShortEdge, null);
    await hub.start();
    assert.equal(hub.status().effectiveMaxSize, 900);
    assert.deepEqual(commands().map(command => Number(/ max_size=(\d+) /.exec(command)[1])), [1600, 1152, 0, 900]);
});

for (const rejectRead of [false, true]) {
    test(`stop cancels pending wm read without stale metadata (${rejectRead ? 'rejection' : 'success'})`, async t => {
        const entered = deferred(), release = deferred();
        let first = true;
        const { hub, calls } = setup({ hub: { maxShortEdge: 720 }, readSize: () => {
            if (first) { first = false; entered.resolve(); return release.promise; }
            return { ok: true, stdout: 'Physical size: 800x1280' };
        } });
        t.after(() => hub.stop());
        const starting = hub.start();
        const rejected = assert.rejects(starting, /启动已取消/);
        await entered.promise;
        const stopping = hub.stop();
        if (rejectRead) release.reject(new Error('old adb failed'));
        else release.resolve({ ok: true, stdout: 'Physical size: 1080x2400' });
        await rejected;
        await stopping;
        assert.equal(hub.state, 'stopped');
        assert.equal(hub.status().sourceWidth, null);
        assert.equal(hub.status().sourceHeight, null);
        assert.equal(hub.status().effectiveMaxSize, null);
        assert.equal(calls.some(call => call[0] === 'spawn' || call.includes('forward')), false);
        hub.configure({ serial: 'B' });
        await hub.start();
        assert.equal(hub.status().serial, 'B');
        assert.equal(hub.status().sourceWidth, 800);
        assert.equal(hub.status().effectiveMaxSize, 1152);
    });
}

test('direct hub new resolution validation is atomic, including serial and encoding changes', () => {
    const { hub, ScrcpyHub } = setup();
    for (const body of [{ maxShortEdge: 720, maxSize: 540 }, ...[-1, 1, 179, 2161, 720.5, '720', null, NaN, Infinity]
        .map(maxShortEdge => ({ maxShortEdge }))]) {
        assert.throws(() => hub.configure({ serial: 'B', maxFps: 60, ...body }), { code: 'INVALID_SCRCPY_CONFIG' });
        assert.equal(hub.maxShortEdge, null);
        assert.equal(hub.maxSize, 540);
        assert.equal(hub.maxFps, 30);
        assert.equal(hub._requestedSerial, 'A');
    }
    assert.throws(() => new ScrcpyHub({ maxShortEdge: 0, maxSize: 540 }), { code: 'INVALID_SCRCPY_CONFIG' });
});

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close'); }
    messages() { return this.sent.filter(data => typeof data === 'string').map(data => JSON.parse(data)); }
}
async function serverFixture(t, options = {}) {
    const env = setup(options);
    const frames = new Set();
    const server = new StreamServer({ port: 0, scrcpyHub: env.hub, logger: {}, deviceApi: {},
        frameHub: { latestOrNull() { return null; }, status() { return {}; },
            subscribe(fn) { frames.add(fn); return () => frames.delete(fn); } },
        handshakeTimeoutMs: 20, firstFrameTimeoutMs: 20 });
    await server.start();
    t.after(() => server.stop());
    const origin = server.url();
    const cookie = await new Promise((resolve, reject) => {
        http.get(origin, { agent: false }, res => { res.resume(); res.on('end', () => resolve(res.headers['set-cookie'][0].split(';')[0])); })
            .on('error', reject);
    });
    const post = body => new Promise((resolve, reject) => {
        const req = http.request(`${origin}/api/scrcpy/config`, { method: 'POST', agent: false,
            headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
            res.on('error', reject);
        });
        req.setTimeout(2000, () => req.destroy(new Error('HTTP test timeout')));
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
    const viewer = async () => {
        const socket = new Socket();
        server.handleSocket(socket);
        while (server.pendingScrcpyAttachments.has(socket)) await tick();
        return socket;
    };
    return { ...env, server, post, viewer, frames };
}

test('HTTP short-edge configuration validates atomically and saves all presets for next start', async t => {
    const { post, hub, calls } = await serverFixture(t);
    for (const maxShortEdge of [null, '720', true, -1, 1, 179, 2161, 720.5, Number.MAX_SAFE_INTEGER + 1]) {
        const response = await post({ maxFps: 60, bitRate: 4000000, maxShortEdge });
        assert.equal(response.status, 200);
        assert.equal(response.body.code, 'INVALID_SCRCPY_CONFIG');
        assert.equal(response.body.applied, null);
        assert.equal(hub.maxFps, 30);
        assert.equal(hub.maxShortEdge, null);
    }
    for (const maxShortEdge of [0, 720]) {
        const response = await post({ maxShortEdge, maxSize: 540 });
        assert.equal(response.body.code, 'INVALID_SCRCPY_CONFIG');
    }
    for (const maxShortEdge of [0, 180, 540, 720, 1080, 1440, 2160]) {
        const response = await post({ maxFps: 60, bitRate: 4000000, maxShortEdge });
        assert.equal(response.body.ok, true);
        assert.equal(response.body.applied, 'next-start');
        assert.equal(response.body.status.maxShortEdge, maxShortEdge);
        assert.equal(response.body.status.maxSize, 540);
        assert.equal(response.body.status.effectiveMaxSize, null);
    }
    assert.equal((await post({ maxSize: 900 })).body.status.maxShortEdge, null);
    assert.equal(calls.length, 0, 'saving next-start configuration performs no device I/O');
});

test('HTTP active short-edge restart publishes actual metadata and reports source read failure honestly', async t => {
    let failed = false;
    const { post, viewer, hub, server, frames } = await serverFixture(t, {
        readSize: () => ({ ok: !failed, stdout: 'Physical size: 1080x2400' }),
    });
    const socket = await viewer();
    socket.sent.length = 0;
    const active = await post({ maxFps: 60, bitRate: 4000000, maxShortEdge: 720 });
    assert.equal(active.body.ok, true);
    assert.equal(active.body.applied, 'active-stream');
    assert.equal(active.body.status.effectiveMaxSize, 1600);
    const ready = socket.messages().find(message => message.type === 'scrcpy-ready');
    assert.deepEqual([ready.maxSize, ready.maxShortEdge, ready.sourceWidth, ready.sourceHeight, ready.effectiveMaxSize],
        [540, 720, 1080, 2400, 1600]);
    failed = true;
    socket.sent.length = 0;
    const fallback = await post({ maxShortEdge: 1080 });
    assert.equal(fallback.body.ok, false);
    assert.equal(fallback.body.applied, 'fallback');
    assert.equal(fallback.body.code, 'SCRCPY_SOURCE_SIZE_UNAVAILABLE');
    assert.equal(fallback.body.status.maxShortEdge, 1080);
    assert.equal(fallback.body.status.sourceWidth, null);
    assert.equal(fallback.body.status.effectiveMaxSize, null);
    assert.equal(socket.messages().some(message => message.type === 'scrcpy-ready'), false);
    assert.equal(frames.size, 1);
    server.cancelScrcpyProbe();
    const native = await post({ maxShortEdge: 0 });
    assert.equal(native.body.applied, 'active-stream');
    assert.equal(native.body.status.effectiveMaxSize, 0);
    assert.equal(native.body.status.sourceWidth, null);
    assert.equal(hub.state, 'streaming');
    assert.equal(frames.size, 0);
});

test('short-edge and legacy HTTP requests retain FIFO restarts while wm read is pending', async t => {
    const entered = deferred(), release = deferred(), admitted = deferred();
    let count = 0;
    const { post, viewer, server, commands, reads } = await serverFixture(t, { readSize: () => {
        if (++count === 2) { entered.resolve(); return release.promise; }
        return { ok: true, stdout: 'Physical size: 1080x2400' };
    } });
    await viewer();
    const first = post({ maxShortEdge: 720 });
    await entered.promise;
    const configure = server.configureScrcpy.bind(server);
    server.configureScrcpy = body => { const pending = configure(body); admitted.resolve(); return pending; };
    const second = post({ maxSize: 900 });
    await admitted.promise;
    assert.equal(commands().length, 1);
    release.resolve({ ok: true, stdout: 'Physical size: 1080x2400' });
    const [short, legacy] = await Promise.all([first, second]);
    assert.equal(short.body.applied, 'active-stream');
    assert.equal(short.body.status.maxShortEdge, 720);
    assert.equal(short.body.status.effectiveMaxSize, 1600);
    assert.equal(legacy.body.applied, 'active-stream');
    assert.equal(legacy.body.status.maxShortEdge, null);
    assert.equal(legacy.body.status.maxSize, 900);
    assert.equal(legacy.body.status.effectiveMaxSize, 900);
    assert.deepEqual(commands().map(command => Number(/ max_size=(\d+) /.exec(command)[1])), [540, 1600, 900]);
    assert.equal(reads().length, 3);
});
