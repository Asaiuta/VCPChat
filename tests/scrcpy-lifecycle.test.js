'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const filename = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub.js');
const source = fs.readFileSync(filename, 'utf8');
const productionRequire = createRequire(filename);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function setup(options = {}) {
    const calls = [];
    const sockets = [];
    const processes = [];
    const timers = [];
    const module = { exports: {} };
    const childProcess = {
        execFile(_adb, args, _opts, callback) {
            calls.push(['adb', ...args]);
            // 就绪轮询查询：固定返回「已出现」。这些用例各自验证生命周期主题，
            // 不应被 4 秒就绪预算拖慢，也不该混入就绪语义。
            if (args.join(' ').includes('/proc/net/unix')) {
                queueMicrotask(() => callback(null, '1\n', ''));
                return;
            }
            queueMicrotask(() => callback(null, args[0] === 'devices'
                ? 'List of devices attached\nUSB123 device\n10.0.0.2:5555 device\n'
                : 'PRESENT', ''));
        },
        spawn(_adb, args) {
            calls.push(['spawn', ...args]);
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.kill = () => { proc.killed = true; };
            processes.push(proc);
            return proc;
        },
    };
    const net = {
        createConnection() {
            calls.push(['connect']);
            const socket = new EventEmitter();
            socket.setNoDelay = () => {};
            socket.destroy = () => {
                socket.destroyed = true;
                socket.emit('close');
            };
            sockets.push(socket);
            if (!options.holdConnect) queueMicrotask(() => socket.emit('connect'));
            return socket;
        },
    };
    vm.runInNewContext(source, {
        require(name) { return name === 'child_process' ? childProcess : name === 'net' ? net : productionRequire(name); },
        module, exports: module.exports, __dirname: path.dirname(filename), Buffer, console,
        setTimeout,
        clearTimeout,
    }, { filename });
    const { ScrcpyHub } = module.exports;
    ScrcpyHub.findFreePort = async () => 12345;
    const hub = new ScrcpyHub({ adbPath: 'stub-adb', serial: options.serial, logger: {} });
    return { hub, calls, sockets, processes, timers, ScrcpyHub };
}

for (const serial of ['USB123', '10.0.0.2:5555']) {
    test(`explicit online serial is preserved: ${serial}`, async () => {
        const { hub } = setup({ serial });
        assert.equal(await hub._resolveSerial(), serial);
        assert.equal(hub.serial, serial);
    });
}

test('configure serial switches the next start from explicit A to explicit B', async () => {
    const { hub, calls } = setup({ serial: 'USB123' });
    assert.equal((await hub.start()).serial, 'USB123');
    await hub.stop();
    hub.configure({ serial: '10.0.0.2:5555' });
    const before = calls.length;
    assert.equal((await hub.start()).serial, '10.0.0.2:5555');
    const commands = calls.slice(before).filter((call) => call[0] === 'adb' && call[1] === '-s');
    assert.ok(commands.length > 0);
    assert.ok(commands.every((call) => call[2] === '10.0.0.2:5555'));
    await hub.stop();
});

test('configure serial is next-start only and can clear the explicit target', async () => {
    const { hub } = setup({ serial: '10.0.0.2:5555' });
    await hub.start();
    hub.configure({ serial: undefined });
    assert.equal(hub.serial, '10.0.0.2:5555');
    assert.equal(hub.state, 'streaming');
    await hub.stop();
    assert.equal((await hub.start()).serial, 'USB123');
    await hub.stop();
});

function seedSession(hub) {
    hub.codec = '0x68323634';
    hub.width = 540;
    hub.height = 1200;
    hub.codecString = 'avc1.64001e';
    hub.sps = Buffer.from([0x64, 0, 0x1e]);
    hub.bytesReceived = 100;
    hub._emitPacket({ type: 'session', width: 540, height: 1200, data: null });
    hub._emitPacket({ type: 'config', data: Buffer.from([1, 2, 3]) });
    hub._emitPacket({ type: 'frame', key: true, data: Buffer.from([4, 5, 6]) });
}

function assertEmptySession(hub) {
    for (const field of ['codec', 'width', 'height', 'codecString', 'sps',
        'lastSession', 'lastConfig', 'lastKeyFrame']) {
        assert.equal(hub[field], null, `${field} must not outlive its generation`);
    }
    for (const field of ['seq', 'packetsReceived', 'bytesReceived', 'lastPacketAt']) {
        assert.equal(hub[field], 0, `${field} must reset for a fresh session`);
    }
    assert.equal(hub.frameTimes.length, 0);
    assert.equal(hub.replayInitTo(() => assert.fail('old session replayed')), 0);
}

test('stop clears A metadata and replay caches before starting B without new packets', async () => {
    const { hub } = setup({ serial: 'USB123' });
    await hub.start();
    seedSession(hub);
    assert.equal(hub.replayInitTo(() => {}), 3);
    await hub.stop();
    assertEmptySession(hub);
    hub.configure({ serial: '10.0.0.2:5555' });
    const result = await hub.start();
    assert.equal(result.serial, '10.0.0.2:5555');
    assert.ok(hub._parser);
    assertEmptySession(hub);
    assert.equal(result.width, null);
    assert.equal(result.height, null);
    assert.equal(result.codecString, null);
    assert.equal(result.lastPacketAgeMs, null);
    await hub.stop();
});

test('new generation clears previous session before its first asynchronous step', async () => {
    const { hub } = setup();
    seedSession(hub);
    hub.state = 'error';
    const gate = deferred();
    hub._resolveSerial = () => gate.promise;
    const started = hub.start();
    assertEmptySession(hub);
    gate.resolve();
    await started;
    await hub.stop();
});

for (const state of ['offline', 'unauthorized', 'missing']) {
    test(`explicit unavailable device rejects without fallback: ${state}`, async () => {
        const { hub, calls } = setup({ serial: 'USB123' });
        hub._adbListDevices = async () => [
            ...(state === 'missing' ? [] : [{ serial: 'USB123', state }]),
            { serial: 'other:5555', state: 'device' },
        ];
        await assert.rejects(hub.start(), /USB123/);
        assert.equal(hub.serial, 'USB123');
        assert.equal(calls.some((call) => call[0] === 'spawn'), false);
        assert.equal(calls.some((call) => call.includes('forward')), false);
    });
}

test('implicit target uses first authorized device and can reselect on next resolution', async () => {
    const { hub } = setup();
    assert.equal(await hub._resolveSerial(), 'USB123');
    hub._adbListDevices = async () => [{ serial: 'replacement', state: 'device' }];
    assert.equal(await hub._resolveSerial(), 'replacement');
});

test('implicit target rejects when no authorized device exists', async () => {
    const { hub } = setup();
    hub._adbListDevices = async () => [{ serial: 'locked', state: 'unauthorized' }];
    await assert.rejects(hub.start(), /设备/);
});

test('concurrent starts share the completed result, not a starting snapshot', async () => {
    const { hub, calls } = setup();
    const gate = deferred();
    hub._ensureJar = () => gate.promise;
    const first = hub.start();
    const second = hub.start();
    assert.strictEqual(first, second);
    gate.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].state, 'streaming');
    assert.strictEqual(results[0], results[1]);
    assert.equal(calls.filter((call) => call[0] === 'spawn').length, 1);
    await hub.stop();
});

test('concurrent starts share the same failure and cleanup once', async () => {
    const { hub } = setup();
    let cleanups = 0;
    const cleanup = hub._cleanup.bind(hub);
    hub._cleanup = async () => { cleanups += 1; await cleanup(); };
    const gate = deferred();
    hub._ensureJar = () => gate.promise;
    const starts = [hub.start(), hub.start()];
    const failed = Promise.allSettled(starts);
    const error = new Error('jar failed');
    gate.reject(error);
    const results = await failed;
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    assert.strictEqual(results[0].reason, error);
    assert.strictEqual(results[1].reason, error);
    assert.equal(hub.state, 'error');
    assert.equal(cleanups, 1);
});

for (const phase of ['resolve', 'jar', 'port', 'forward', 'ready', 'connect']) {
    test(`stop during ${phase} drains startup and prevents resurrection`, async () => {
        const env = setup({ holdConnect: phase === 'connect' });
        const { hub, calls, ScrcpyHub } = env;
        const gate = deferred();
        const entered = deferred();
        const hold = () => { entered.resolve(); return gate.promise; };
        if (phase === 'resolve') hub._resolveSerial = hold;
        if (phase === 'jar') hub._ensureJar = hold;
        if (phase === 'port') ScrcpyHub.findFreePort = hold;
        // 旧实现里这里是 1800ms 盲等。盲等已删除，改用设备端 socket 轮询；
        // 这条用例的意图（启动期取消不留残骸）原样保留，只是钩住新阶段。
        if (phase === 'ready') hub._waitForRemoteSocket = hold;
        if (phase === 'forward') {
            const adb = hub._adb.bind(hub);
            hub._adb = (args, ...rest) => args[0] === 'forward' && args[1] !== '--remove'
                ? hold() : adb(args, ...rest);
        }
        const startResult = hub.start().then((value) => ({ value }), (error) => ({ error }));
        if (phase === 'connect') {
            while (!env.sockets.length) await tick();
        } else await entered.promise;
        let stopped = false;
        const stop = hub.stop().then(() => { stopped = true; });
        await tick();
        const returnedBeforeRelease = stopped;
        gate.resolve(phase === 'forward' ? { ok: true } : phase === 'port' ? 12345 : undefined);
        for (const callback of env.timers) callback();
        if (phase === 'connect') env.sockets[0].emit('connect');
        const result = await startResult;
        await stop;
        assert.equal(returnedBeforeRelease, false, 'stop must wait for the pending start');
        assert.ok(result.error, 'cancelled start must reject');
        assert.equal(hub.state, 'stopped');
        assert.equal(hub.socket, null);
        assert.equal(hub.serverProc, null);
        assert.equal(hub.localPort, null);
        const count = calls.length;
        await tick();
        assert.equal(calls.length, count, 'no delayed adb/spawn/connect after stop');
        if (['resolve', 'jar', 'port', 'forward'].includes(phase)) {
            assert.equal(calls.some((call) => call[0] === 'spawn'), false);
            assert.equal(calls.some((call) => call[0] === 'connect'), false);
        }
    });
}

test('start during failed-start cleanup waits; stale events cannot damage new resources', async () => {
    const { hub, processes, sockets } = setup();
    const cleanup = deferred();
    const entered = deferred();
    const adb = hub._adb.bind(hub);
    let held = false;
    hub._adb = (args, ...rest) => {
        if (!held && args[0] === 'shell' && args[1].includes('pkill')) {
            held = true;
            entered.resolve();
            return cleanup.promise;
        }
        return adb(args, ...rest);
    };
    const connect = hub._connect.bind(hub);
    hub._connect = async () => { await connect(); throw new Error('first connect fails'); };
    const old = hub.start().catch((error) => error);
    await entered.promise;
    const stop = hub.stop();
    hub._connect = connect;
    const next = hub.start();
    cleanup.resolve({ ok: true });
    await old;
    await stop;
    assert.equal((await next).state, 'streaming');
    const socket = hub.socket;
    const proc = hub.serverProc;
    sockets[0].emit('close');
    sockets[0].emit('data', Buffer.from([0]));
    processes[0].emit('exit', 1);
    assert.equal(hub.state, 'streaming');
    assert.strictEqual(hub.socket, socket);
    assert.strictEqual(hub.serverProc, proc);
    assert.equal(socket.destroyed, undefined);
    await hub.stop();
});

test('session scid binds spawn, forward and exact remote cleanup; restart never reuses it', async () => {
    const { hub, calls } = setup({ serial: 'USB123' });
    const ids = [];
    for (let i = 0; i < 2; i++) {
        await hub.start();
        const command = calls.filter(c => c[0] === 'spawn').at(-1).at(-1);
        const id = / scid=([0-7][a-f0-9]{7})(?: |$)/.exec(command)?.[1];
        assert.ok(id, 'server must receive a valid unique scid');
        ids.push(id);
        assert.ok(calls.some(c => c.includes(`localabstract:scrcpy_${id}`)));
        await hub.stop();
        const cleanup = calls.filter(c => c[0] === 'adb' && c.some(v => typeof v === 'string' && v.includes('pkill'))).at(-1);
        assert.ok(cleanup);
        assert.equal(cleanup[2], 'USB123');
        assert.ok(cleanup.at(-1).includes(`scid=${id}( |$)`));
        assert.ok(!cleanup.at(-1).includes('pkill -f com.genymobile.scrcpy.Server '));
    }
    assert.notEqual(ids[0], ids[1]);
});

test('unstarted cleanup never kills remote servers and stale generation cleanup is a no-op', async () => {
    const { hub, calls } = setup();
    await hub.stop();
    assert.equal(calls.length, 0);
    await hub.start();
    const socket = hub.socket;
    const count = calls.length;
    await hub._cleanup(hub._generation - 1);
    assert.strictEqual(hub.socket, socket);
    assert.equal(calls.length, count);
    await hub.stop();
});

test('failed readiness cleanup blocks replacement start until targeted cleanup drains', async () => {
    const { hub, calls } = setup();
    await hub.start();
    const gate = deferred(), entered = deferred();
    const adb = hub._adb.bind(hub);
    hub._adb = (args, ...rest) => {
        if (args[0] === 'shell' && args[1].includes('pkill')) {
            entered.resolve();
            return gate.promise;
        }
        return adb(args, ...rest);
    };
    const failing = hub.failStartup(new Error('first frame timeout'));
    await entered.promise;
    const restarting = hub.start();
    await tick();
    const before = calls.filter(c => c[0] === 'spawn').length;
    gate.resolve({ ok: true });
    await failing;
    await restarting;
    assert.equal(before, 1);
    await hub.stop();
});
