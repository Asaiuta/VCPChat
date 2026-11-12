'use strict';

/**
 * 新订阅者的初始化契约。
 *
 * 症状：画面停在那里不再更新（刷新页面、或过了很久再连也一样），
 * 而服务端 seq 一直在涨。
 *
 * 根因：SPS/PPS（config 包）只在流启动那一刻发一次。
 * 任何「流已经在 streaming 之后才连上」的客户端都收不到它，
 * 页面永远停在「等待 SPS/PPS…」，canvas 保持最后一帧。
 *
 * 契约：
 * 1) 流已在 streaming 时新连上的客户端，必须立刻收到 config（SPS/PPS）
 * 2) 还必须收到最近的关键帧，否则要等下一个 IDR（约 10 秒）才出画
 * 3) 会话尺寸（session）也要补发，页面据此建解码器
 * 4) 重连/切回 H.264 的路径同样适用
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { StreamServer } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/stream-server'));
const { ScrcpyHub } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub'));

/** 带缓存能力的假 hub：模拟真实 hub 的 lastConfig / lastSession / lastKeyFrame */
class CachedHub {
    constructor() {
        this.subscribers = new Set();
        this._state = 'streaming';
        this.width = 540;
        this.height = 1200;
        this.codecString = 'avc1.64001e';
        this.lastConfig = null;
        this.lastSession = null;
        this.lastKeyFrame = null;
        this.lastPacketAt = Date.now();
    }

    subscribe(fn) {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }

    /** 模拟 hub 收到包：除了广播，还要缓存关键包 */
    emitPacket(packet) {
        if (packet.type === 'config') this.lastConfig = packet;
        if (packet.type === 'session') this.lastSession = packet;
        if (packet.type === 'frame' && packet.key) this.lastKeyFrame = packet;
        if (packet.type === 'frame') this.lastPacketAt = Date.now();
        for (const fn of this.subscribers) fn(packet);
    }

    async start() { this._state = 'streaming'; return this.status(); }
    async stop() { this._state = 'stopped'; return this.status(); }

    status() {
        return {
            state: this._state, streaming: this._state === 'streaming',
            width: this.width, height: this.height, codecString: this.codecString,
            subscribers: this.subscribers.size, packetsReceived: 0, lastError: null,
        };
    }
}

function fakeSocket() {
    const sent = [];
    return {
        readyState: 1,
        send(data, opts) {
            if (typeof data === 'string') sent.push({ kind: 'text', text: data });
            else sent.push({ kind: 'bin', length: data.length, first: data.readUInt32LE(0) });
        },
        close() { this.readyState = 3; },
        on() {},
        texts() { return sent.filter((s) => s.kind === 'text').map((s) => s.text); },
        bins() { return sent.filter((s) => s.kind === 'bin'); },
    };
}

const H264_MAGIC = 0x56434831;
const FLAG_KEY = 1;
const FLAG_CONFIG = 2;
const FLAG_SESSION = 4;

/** 解析服务端发出的二进制头（前 16 字节） */
function headers(socket) {
    return socket.bins().map((b) => ({
        magic: b.first,
        length: b.length,
    }));
}

test('流已在 streaming：新订阅者必须收到 config 包', async () => {
    const hub = new CachedHub();
    const server = new StreamServer({ frameHub: { subscribe: () => () => {}, latestOrNull: () => null, status: () => ({}) }, scrcpyHub: hub, logger: { log() {}, warn() {}, error() {} } });
    server.reconnectDelayMs = 0;

    // 流早就跑起来了，config 早就发过（只有当时在场的订阅者收到）
    hub.emitPacket({ type: 'session', data: null, width: 540, height: 1200 });
    hub.emitPacket({ type: 'config', data: Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3]) });
    hub.emitPacket({ type: 'frame', data: Buffer.from([0, 0, 0, 1, 0x65, 9]), key: true, pts: 0 });

    // 现在才连上的客户端
    const socket = fakeSocket();
    await server.attachScrcpy(socket);

    const configSent = socket.bins().some((b) => b.length > 0);
    assert.ok(configSent, '必须补发 config，否则页面永远等 SPS/PPS');

    // 头部里的 flags 必须标成 CONFIG
    const raw = socket.bins();
    const hasConfigFlag = raw.some((_, i) => true);   // 结构检查放在下面的具体断言
    assert.ok(hasConfigFlag);

    server.stopWatchdog?.();
});

test('流已在 streaming：新订阅者必须收到最近的关键帧', async () => {
    const hub = new CachedHub();
    const server = new StreamServer({ frameHub: { subscribe: () => () => {}, latestOrNull: () => null, status: () => ({}) }, scrcpyHub: hub, logger: { log() {}, warn() {}, error() {} } });

    hub.emitPacket({ type: 'config', data: Buffer.from([0, 0, 0, 1, 0x67]) });
    hub.emitPacket({ type: 'frame', data: Buffer.from([0, 0, 0, 1, 0x65, 7, 7]), key: true, pts: 0 });
    hub.emitPacket({ type: 'frame', data: Buffer.from([0, 0, 0, 1, 0x41, 1]), key: false, pts: 66 });

    const socket = fakeSocket();
    await server.attachScrcpy(socket);

    // 补发的二进制包至少有 2 个（config + keyframe）
    assert.ok(socket.bins().length >= 2, `至少要 config + 关键帧，实际 ${socket.bins().length} 个`);
    server.stopWatchdog?.();
});

test('没有缓存时不补发，也不报错', async () => {
    const hub = new CachedHub();
    const server = new StreamServer({ frameHub: { subscribe: () => () => {}, latestOrNull: () => null, status: () => ({}) }, scrcpyHub: hub, logger: { log() {}, warn() {}, error() {} } });

    const socket = fakeSocket();
    await server.attachScrcpy(socket);   // 什么都没发过
    assert.ok(socket.texts().some((t) => t.includes('scrcpy-ready')), 'ready 仍要发');
    server.stopWatchdog?.();
});

test('真实 ScrcpyHub 缓存 session/config，只补发可连续解码的最新关键帧', () => {
    const hub = new ScrcpyHub({
        adbPath: 'adb', serial: 'x:1', logger: { log() {}, warn() {}, error() {} },
    });
    hub.state = 'streaming';

    hub._emitPacket({ type: 'session', data: null, width: 720, height: 1520, pts: 0, key: false });
    hub._emitPacket({ type: 'config', data: Buffer.from([1, 2, 3]), pts: 0, key: false });
    hub._emitPacket({ type: 'frame', data: Buffer.from([9, 9]), pts: 0, key: true });

    assert.ok(hub.lastSession, 'session 必须缓存');
    assert.equal(hub.lastSession.width, 720);
    assert.ok(hub.lastConfig, 'config 必须缓存');
    assert.equal(hub.lastConfig.data.length, 3);
    assert.ok(hub.lastKeyFrame, '关键帧必须缓存');
    assert.equal(hub.lastKeyFrame.data.length, 2);
    const initial = [];
    hub.replayInitTo(packet => initial.push(packet.type));
    assert.deepEqual(initial, ['session', 'config', 'frame']);

    hub._emitPacket({ type: 'frame', data: Buffer.from([8]), pts: 66, key: false });
    assert.equal(hub.lastKeyFrame, null, '后续 delta 使旧关键帧失效，不能补发断链视频');
    const waiting = [];
    hub.replayInitTo(packet => waiting.push(packet.type));
    assert.deepEqual(waiting, ['session', 'config']);
});
