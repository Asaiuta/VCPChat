'use strict';

/**
 * 断流恢复契约。
 *
 * 背景：scrcpy 流断开时，服务端只给页面发一条 `scrcpy-closed` 文本，
 * 自己什么都不做；页面收到后切到 <img>「兼容模式」等 JPEG 帧，
 * 但服务端从未订阅 FrameHub —— 于是永远黑屏。
 *
 * 契约：
 * 1) 流断开 → 服务端自动重启 scrcpy（带退避），页面收到新的 ready
 * 2) 重启连续失败 N 次 → 真的切到 JPEG 推流，页面必须能收到帧
 * 3) JPEG 回退期间 scrcpy 恢复 → 切回 H.264,不必刷新页面
 * 4) 主动 stop 时不该触发自动重启
 * 5) 断流事件本身仍要通知页面（用于 UI 提示）
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
const { StreamServer } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/stream-server'));

/**
 * 可控的假 ScrcpyHub。
 *
 * start 的行为由 `failStartTimes` 决定：前 N 次抛错，之后成功。
 */
class FakeScrcpyHub extends EventEmitter {
    constructor({ failStartTimes = 0, streaming = false } = {}) {
        super();
        this.serial = 'test:5555';
        this.subscribers = new Set();
        this.failStartTimes = failStartTimes;
        this.startCalls = 0;
        this.stopCalls = 0;
        this._state = streaming ? 'streaming' : 'stopped';
        this._generation = streaming ? 1 : 0;
        this.startedAt = streaming ? Date.now() : 0;
        this.lastPacketAt = 0;
        this.packetsReceived = 0;
        this.width = null;
        this.height = null;
        this.codecString = null;
        if (streaming) this.completeHandshake();
    }

    subscribe(fn) {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }

    completeHandshake() {
        this.width = 540;
        this.height = 1200;
        this.codecString = 'avc1.64001e';
        this.emitPacket({ type: 'config', data: Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x1e]), pts: 0, key: false });
        this.emitPacket({ type: 'frame', data: Buffer.from([0, 0, 0, 1, 0x65, 1]), pts: 0, key: true });
    }

    emitPacket(packet) {
        // 与真实 ScrcpyHub 一致：配置包不算首帧，只有视频帧推进 lastPacketAt。
        if (packet.type === 'frame') this.lastPacketAt = Date.now();
        if (packet.type === 'frame' || packet.type === 'config') this.packetsReceived += 1;
        if (packet.type === 'closed' && !this.stopping) this._state = 'error';
        for (const fn of this.subscribers) {
            try { fn(packet); } catch { /* 忽略 */ }
        }
    }

    async start() {
        this.startCalls += 1;
        this._generation += 1;
        this.startedAt = Date.now();
        this.lastPacketAt = 0;
        this.packetsReceived = 0;
        this.width = null;
        this.height = null;
        this.codecString = null;
        this.stopping = false;
        this._state = 'starting';
        if (this.startCalls <= this.failStartTimes) {
            this._state = 'error';
            throw new Error(`模拟启动失败 #${this.startCalls}`);
        }
        await new Promise((r) => setTimeout(r, 5));
        this._state = 'streaming';
        this.completeHandshake();
        return this.status();
    }

    async stop() {
        this.stopCalls += 1;
        this._generation += 1;
        this.stopping = true;
        this._state = 'stopped';
        return this.status();
    }

    status() {
        return {
            state: this._state,
            streaming: this._state === 'streaming',
            subscribers: this.subscribers.size,
            width: this.width,
            height: this.height,
            codecString: this.codecString,
            codec: 'h264',
            maxSize: 540,
            maxFps: 30,
            serial: this.serial,
            packetsReceived: this.packetsReceived,
            lastError: null,
        };
    }
}

/** 只记录发送内容的假 socket */
function fakeSocket() {
    const sent = [];
    const socket = {
        readyState: 1,
        sent,
        send(data, opts) {
            if (typeof data === 'string') sent.push({ kind: 'text', text: data });
            else sent.push({ kind: 'binary', length: data.length, opts });
        },
        close() { socket.readyState = 3; },
        on() {},
        texts() { return sent.filter((s) => s.kind === 'text').map((s) => s.text); },
        types() {
            return socket.texts()
                .map((t) => { try { return JSON.parse(t).type; } catch { return null; } })
                .filter(Boolean);
        },
        binaryCount() { return sent.filter((s) => s.kind === 'binary').length; },
        clear() { sent.length = 0; },
    };
    return socket;
}

function fakeFrameHub() {
    const subscribers = new Set();
    return {
        subscribers,
        subscribe(fn) {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
        latestOrNull() { return null; },
        status() {
            return { streaming: subscribers.size > 0, subscribers: subscribers.size, seq: 0 };
        },
        pushFrame(seq) {
            const frame = {
                seq,
                buffer: Buffer.alloc(64, 0xff),
                mime: 'image/jpeg',
                width: 540,
                height: 1200,
                capturedAt: Date.now(),
            };
            for (const fn of subscribers) fn(frame);
        },
    };
}

function makeServer({ hub, frames } = {}) {
    const server = new StreamServer({
        frameHub: frames || fakeFrameHub(),
        scrcpyHub: hub || new FakeScrcpyHub(),
        port: 0,
        host: '127.0.0.1',
        logger: { log() {}, warn() {}, error() {} },
    });
    // 关掉退避等待，测试里不要真等几秒
    server.reconnectDelayMs = 0;
    return server;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

test('断流：通知页面，并自动重启 scrcpy', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    const socket = fakeSocket();

    await server.attachScrcpy(socket);
    assert.equal(hub.startCalls, 0, '已在 streaming 不该重复 start');
    socket.clear();

    // 模拟设备侧断开
    hub.emitPacket({ type: 'closed', data: null, pts: 0, key: false });
    await sleep(120);

    assert.ok(socket.texts().some((t) => t.includes('scrcpy-closed')), '页面必须收到断流通知');
    assert.ok(hub.startCalls >= 1, '服务端必须尝试重启');
});

test('断流：重启成功后页面重新收到 scrcpy-ready', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    const socket = fakeSocket();

    await server.attachScrcpy(socket);
    socket.clear();

    hub.emitPacket({ type: 'closed', data: null, pts: 0, key: false });
    await sleep(300);

    const ready = socket.texts().filter((t) => t.includes('scrcpy-ready'));
    assert.ok(ready.length >= 1, `重启后必须补发 ready，实际收到 ${ready.length}`);
    const parsed = JSON.parse(ready[ready.length - 1]);
    assert.equal(parsed.width, 540);
    assert.equal(parsed.codecString, 'avc1.64001e');
});

test('断流：连续重启失败后真的切到 JPEG，页面能收到帧', async () => {
    // 前 3 次启动都失败
    const hub = new FakeScrcpyHub({ streaming: true, failStartTimes: 3 });
    // 让第一次就失败：先 stop 掉
    hub._state = 'streaming';
    const frames = fakeFrameHub();
    const server = makeServer({ hub, frames });
    const socket = fakeSocket();

    await server.attachScrcpy(socket);
    socket.clear();
    hub.failStartTimes = 99;   // 之后全部失败

    hub.emitPacket({ type: 'closed', data: null, pts: 0, key: false });
    // 等重试耗尽（delay 已被置 0，很快）
    await sleep(600);

    assert.equal(frames.subscribers.size, 1, 'JPEG 回退必须真的订阅 FrameHub');

    frames.pushFrame(1);
    assert.ok(socket.binaryCount() >= 1, '回退后页面必须收到实际帧');
});

test('断流：JPEG 回退期间 scrcpy 恢复会切回 H.264', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const frames = fakeFrameHub();
    const server = makeServer({ hub, frames });
    const socket = fakeSocket();

    await server.attachScrcpy(socket);
    hub.failStartTimes = 99;
    socket.clear();

    hub.emitPacket({ type: 'closed', data: null, pts: 0, key: false });
    await sleep(600);
    assert.equal(frames.subscribers.size, 1, '应已回退到 JPEG');

    // 让重启重新变可行，并触发一次恢复检查
    hub.failStartTimes = 0;
    await server.tryRecoverScrcpy();
    await sleep(300);

    assert.ok(socket.texts().some((t) => t.includes('scrcpy-ready')), '恢复后应补发 ready');
    assert.equal(frames.subscribers.size, 0, '切回 H.264 后应退订 JPEG，避免双路推流');
});

test('主动 stop 不该触发自动重启', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    const socket = fakeSocket();

    await server.attachScrcpy(socket);
    const before = hub.startCalls;

    // 用户主动停流：hub 置 stopping，随后发 closed
    hub.stopping = true;
    hub.emitPacket({ type: 'closed', data: null, pts: 0, key: false });
    await sleep(200);

    assert.equal(hub.startCalls, before, '主动 stop 后不该自动重启');
});

test('单个 socket 断流不影响其他 socket 的 H.264 通道', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    const a = fakeSocket();
    const b = fakeSocket();

    await server.attachScrcpy(a);
    await server.attachScrcpy(b);
    assert.equal(hub.subscribers.size, 2);

    server.disposeSocket(a);
    assert.equal(hub.subscribers.size, 1, '关掉一个不该影响另一个');
    assert.ok(server.scrcpyStreamers.has(b));
});

// ---- 沉默断流（socket 还开着，但设备不再出帧）----
// 这是「一段时间后自动失效」最隐蔽的一种：无线调试半开、手机息屏、
// 编码器卡死，TCP 都不 close，于是 closed 事件永远不来。

test('看门狗：帧超时且链路已死，才触发恢复', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    hub.socket = null;               // 链路死了
    const server = makeServer({ hub });
    server.stallTimeoutMs = 150;     // 测试用短超时
    const socket = fakeSocket();

    await server.attachScrcpy(socket);
    // 喂一帧让 lastPacketAt 前进
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });
    assert.equal(server.framesStalled(), false, '刚出过帧不该判为不动');

    // 什么都不再发，等超时
    await sleep(250);
    assert.equal(server.framesStalled(), true, '超时后必须判定为不动');

    socket.clear();
    const recovered = await server.checkLiveness();
    assert.equal(recovered, true, '链路死了应主动发起恢复');
    await sleep(200);
    assert.ok(socket.texts().some((t) => t.includes('scrcpy-closed') || t.includes('scrcpy-ready')),
        '恢复流程应产生事件');
});

test('看门狗：帧超时但链路活着 = 静止画面，不重启', async () => {
    // 真机实测：用户在看一页不动的内容时 scrcpy 确实不发帧。
    // 把这种「超时」当故障重启，会让 CPU 白烧、画面反复闪。
    const hub = new FakeScrcpyHub({ streaming: true });
    hub.socket = { destroyed: false, readableEnded: false };
    const server = makeServer({ hub });
    server.stallTimeoutMs = 120;
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });

    await sleep(200);
    assert.equal(server.framesStalled(), true, '前提：确实超时了');

    const before = hub.startCalls;
    const recovered = await server.checkLiveness();
    assert.equal(recovered, false, '静止画面不该触发重启');
    assert.equal(hub.startCalls, before, '不能重启编码器');
});

test('看门狗：帧持续到达时不误判', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    server.stallTimeoutMs = 200;
    const socket = fakeSocket();
    await server.attachScrcpy(socket);

    for (let i = 0; i < 6; i += 1) {
        hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: i * 66, key: true });
        await sleep(60);   // 间隔 < 超时
    }
    assert.equal(server.framesStalled(), false, '持续出帧不该被判为不动');
});

test('看门狗：没有观众时不折腾设备', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    server.stallTimeoutMs = 100;

    // 没接任何 socket
    hub.lastPacketAt = Date.now() - 5000;
    const recovered = await server.checkLiveness();
    assert.equal(recovered, false, '没人看的时候不该重启编码器');
});

test('看门狗：hub 根本没启动过时不做诊断', async () => {
    const hub = new FakeScrcpyHub({ streaming: false });
    hub._state = 'stopped';
    const server = makeServer({ hub });
    const socket = fakeSocket();
    await server.attachScrcpy(socket).catch(() => {});

    const recovered = await server.checkLiveness();
    assert.equal(recovered, false, 'stopped 状态没有帧是正常的');
});

// ---- 设备级重连 ----
// 无线调试端口会变，光重启 scrcpy 是救不回来的。

test('恢复流程：scrcpy 启动失败时会先把设备连回来', async () => {
    // 前 2 次 start 失败（模拟设备掉线），之后成功（设备已重连）
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    let deviceReconnectCalls = 0;
    server.deviceApi = {
        async reconnect() {
            deviceReconnectCalls += 1;
            hub.failStartTimes = 0;      // 连上之后就能起来了
            return { ok: true, action: 'rediscovered', serial: '192.168.1.5:41999', message: '已重新连上' };
        },
    };
    hub.failStartTimes = 99;
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    socket.clear();

    hub.emitPacket({ type: 'closed', data: null, pts: 0, key: false });
    await sleep(600);

    assert.ok(deviceReconnectCalls >= 1, '必须尝试重连设备');
    assert.ok(socket.texts().some((t) => t.includes('scrcpy-ready')), '设备回来后应恢复画面');
});

test('恢复流程：设备重连并发调用只跑一次', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    server.deviceApi = {
        async reconnect() {
            calls += 1;
            await gate;
            return { ok: false, action: 'failed', message: '连不上' };
        },
    };

    // 同时发起 3 次（多个 socket 各自触发）
    const p1 = server.ensureDevice();
    const p2 = server.ensureDevice();
    const p3 = server.ensureDevice();
    release();
    await Promise.all([p1, p2, p3]);
    assert.equal(calls, 1, '不能并发扫描网络，必须单飞');
});

test('恢复流程：没有 deviceApi 时不崩', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    server.deviceApi = null;
    const result = await server.ensureDevice();
    assert.equal(result.ok, false);
    assert.equal(result.action, 'unavailable');
});

test('从 JPEG 切回 H.264 后，看门狗必须重新盯着', async () => {
    // 回归：switchToScrcpy 曾经忘了 startWatchdog，
    // 于是从兼容模式切回来之后，再来一次静默失效就没人管了。
    const hub = new FakeScrcpyHub({ streaming: true });
    const frames = fakeFrameHub();
    const server = makeServer({ hub, frames });
    const socket = fakeSocket();

    await server.attachScrcpy(socket);
    // 强行制造回退：把他从 H.264 摘掉，接上 JPEG
    const unsub = server.scrcpyStreamers.get(socket);
    if (unsub) unsub();
    server.scrcpyStreamers.delete(socket);
    server.attachFrames(socket);
    server.stopWatchdog();
    assert.equal(server.watchdogTimer, null, '前提：看门狗已停');

    // 切回 H.264
    await server.switchToScrcpy(socket);
    assert.ok(server.watchdogTimer, '切回 H.264 后看门狗必须重新启动');

    server.stopWatchdog();
});

// ---- 分级判断：设备掉线 vs 画面静止 ----

test('存活检查：设备掉线时立即恢复，不必等帧超时', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    server.stallTimeoutMs = 60000;   // 帧完全没超时
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });
    socket.clear();

    // 设备从 adb 里消失了
    server.deviceApi = {
        async listDevices() { return { ok: true, devices: [], ready: 0 }; },
    };

    const recovered = await server.checkLiveness();
    assert.equal(recovered, true, '设备没了就该立刻恢复，不该等帧超时');
});

test('存活检查：设备还在、画面静止时不误判', async () => {
    // 用户在看一页静止内容，scrcpy 可能确实不出帧 —— 不能因此重连
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    server.stallTimeoutMs = 60000;   // 没到阈值
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });

    server.deviceApi = {
        async listDevices() { return { ok: true, devices: [{ serial: hub.serial, state: 'device' }], ready: 1 }; },
    };

    const recovered = await server.checkLiveness();
    assert.equal(recovered, false, '设备在、帧没超时，不该恢复');
});

test('存活检查：查不清设备状态时不乱重启', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    server.stallTimeoutMs = 60000;
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });

    server.deviceApi = {
        async listDevices() { throw new Error('adb 抽风'); },
    };

    const recovered = await server.checkLiveness();
    assert.equal(recovered, false, '查询失败时保守处理，别把好好的流掐了');
});

test('存活检查：offline 状态的设备也算掉线', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    const server = makeServer({ hub });
    server.stallTimeoutMs = 60000;
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });

    server.deviceApi = {
        async listDevices() {
            return { ok: true, devices: [{ serial: hub.serial, state: 'offline' }], ready: 0 };
        },
    };

    const recovered = await server.checkLiveness();
    assert.equal(recovered, true, 'offline 也是掉线');
});

// ---- 静止画面 vs 解码器卡死 ----
// 真机实测：手机停在静态界面时，scrcpy 最长 34 秒不发任何帧，但流是好的。
// 所以「多久没帧」不能作为故障判据，必须看底层链路。

test('真机实测值：34 秒无帧但链路活着，不重启', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    hub.socket = { destroyed: false, readableEnded: false };
    const server = makeServer({ hub });
    server.stallTimeoutMs = 20000;
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });

    // 把上一帧时间推到 34 秒前（真机观测到的最长静止时长）
    hub.lastPacketAt = Date.now() - 34000;
    server.deviceApi = {
        async listDevices() { return { ok: true, devices: [{ serial: hub.serial, state: 'device' }], ready: 1 }; },
    };

    const before = hub.startCalls;
    const recovered = await server.checkLiveness();
    assert.equal(recovered, false, '34 秒静止画面不该被当成故障');
    assert.equal(hub.startCalls, before, '不能重启编码器');
});

test('停滞日志只报一次，不刷屏', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    hub.socket = { destroyed: false, readableEnded: false };
    const logs = [];
    const server = makeServer({ hub });
    server.logger = { log: (m) => logs.push(m), warn: () => {}, error: () => {} };
    server.stallTimeoutMs = 50;
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });
    await sleep(120);

    for (let i = 0; i < 5; i += 1) await server.checkLiveness();
    const stallLogs = logs.filter((m) => /静止画面/.test(m));
    assert.equal(stallLogs.length, 1, `应只报一次，实际 ${stallLogs.length} 次`);

    // 帧恢复后再停滞，可以再报一次
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });
    await server.checkLiveness();   // 这一轮未停滞，重置标记
    hub.lastPacketAt = Date.now() - 500;
    await server.checkLiveness();
    assert.ok(logs.filter((m) => /静止画面/.test(m)).length >= 1);
});

test('链路死了才重启：socket 已销毁', async () => {
    const hub = new FakeScrcpyHub({ streaming: true });
    hub.socket = { destroyed: true, readableEnded: false };
    const server = makeServer({ hub });
    server.stallTimeoutMs = 50;
    const socket = fakeSocket();
    await server.attachScrcpy(socket);
    hub.emitPacket({ type: 'frame', data: Buffer.alloc(8, 1), pts: 0, key: true });
    await sleep(120);

    server.deviceApi = {
        async listDevices() { return { ok: true, devices: [{ serial: hub.serial, state: 'device' }], ready: 1 }; },
    };
    const recovered = await server.checkLiveness();
    assert.equal(recovered, true, 'socket 都没了当然要重启');
});
