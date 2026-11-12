'use strict';

/**
 * 性能基线仪表本身的契约。
 *
 * 这一层不测产品行为，只测「计数器是否说真话」。仪表错了，后面所有基线
 * 数字都是精心维护的谎言，所以这里对每条计数都要正例 + 反例 + 副作用检查。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    send(data) { this.sent.push(data); }
    close(code) { this.closeCode = code; this.readyState = 3; this.emit('close'); }
}

function serverFixture(t, options = {}) {
    const hub = {
        state: 'streaming', lastPacketAt: 1, startedAt: Date.now(),
        subscribe() { return () => {}; },
        status() { return { state: 'streaming', width: 720, height: 1600, codecString: 'avc1.64001e' }; },
        async start() { this.state = 'streaming'; },
        async stop() { this.state = 'stopped'; },
    };
    const frameHub = {
        subscribe() { return () => {}; },
        latestOrNull() { return null; }, status() { return {}; },
    };
    const server = new StreamServer({ scrcpyHub: hub, frameHub, ...options, logger: { warn() {}, log() {} } });
    t.after(() => { server.stopWatchdog(); server.cancelScrcpyProbe(); });
    const socket = new Socket();
    server.sendScrcpyPacket(socket, { type: 'session', width: 720, height: 1600 });
    server.sendScrcpyPacket(socket, { type: 'config', data: Buffer.from([1, 2]) });
    server.sendScrcpyPacket(socket, { type: 'frame', key: true, seq: 1, data: Buffer.from([3]) });
    server.resetMetrics();
    socket.sent.length = 0;
    return { server, hub, socket };
}

const jpegFrame = (bytes = 32) => ({ seq: 1, capturedAt: 1, buffer: Buffer.alloc(bytes) });
const deltaPacket = (bytes = 32, seq = 2) => ({ type: 'frame', seq, pts: seq, key: false, data: Buffer.alloc(bytes) });

// ---------------------------------------------------------------- adb 队列

test('adb 队列计数默认全为零，且 query 不产生副作用', () => {
    const client = new AdbClient({ adbPath: 'fake' });
    const first = client.queueStats();
    assert.deepEqual(first, {
        depth: 0, pending: 0, running: false, maxQueueSize: 64,
        peakDepth: 0, completed: 0, failed: 0,
        rejected: { ADB_QUEUE_FULL: 0, ADB_TIMEOUT: 0, ADB_ABORTED: 0 },
        failedByCode: {},
        keyNamespace: 'adb-selector', exclusiveRunning: false, pendingExclusive: 0,
        activeKeys: [], pendingByKey: {},
    });
    // 连读两次必须完全等价：观测不得推进任何状态。
    assert.deepEqual(client.queueStats(), first);
    assert.equal(client.queue.depth, 0);
});

test('peakDepth 记录历史峰值而不是当前深度', async () => {
    const client = new AdbClient({ adbPath: 'fake', maxQueueSize: 8 });
    const gate = deferred();
    const tasks = [
        client.queue.push(() => gate.promise),
        client.queue.push(() => gate.promise),
        client.queue.push(() => gate.promise),
    ];
    assert.equal(client.queueStats().depth, 3);
    assert.equal(client.queueStats().peakDepth, 3);

    gate.resolve();
    await Promise.all(tasks);
    // 排空后深度归零，但峰值必须留着 —— 否则基线看不到历史压力。
    assert.equal(client.queueStats().depth, 0);
    assert.equal(client.queueStats().peakDepth, 3);
    assert.equal(client.queueStats().completed, 3);
});

test('completed 与 failed 分开计数，且执行失败不计入队列拒绝', async () => {
    const client = new AdbClient({ adbPath: 'fake' });
    await client.queue.push(async () => 'ok');
    const boom = Object.assign(new Error('设备离线'), { code: 'ADB_FAILED' });
    await client.queue.push(async () => { throw boom; }).catch(() => {});

    const stats = client.queueStats();
    assert.equal(stats.completed, 1);
    assert.equal(stats.failed, 1);
    // ADB_FAILED 是执行期错误，不是入口压力；混进 rejected 会让队列看起来被挤爆。
    assert.equal(stats.rejected.ADB_QUEUE_FULL, 0);
    assert.equal(stats.rejected.ADB_TIMEOUT, 0);
    assert.equal(stats.rejected.ADB_ABORTED, 0);
    assert.equal(stats.failedByCode.ADB_FAILED, 1);
});

test('队列满拒绝进 rejected.ADB_QUEUE_FULL，且不增加 depth', async () => {
    const client = new AdbClient({ adbPath: 'fake', maxQueueSize: 1 });
    const gate = deferred();
    const head = client.queue.push(() => gate.promise);
    const overflow = await client.queue.push(async () => 'x').catch((error) => error);
    assert.equal(overflow?.code, 'ADB_QUEUE_FULL');

    const stats = client.queueStats();
    assert.equal(stats.rejected.ADB_QUEUE_FULL, 1);
    assert.equal(stats.depth, 1, '拒绝不得留下幽灵占位');
    // 入口拒绝与执行失败刻意不重叠：满拒发生在 push()，任务从未入队，
    // 因此只进 rejected，不进 failed。否则同一个失败会被数两次，
    // 基线就无法区分「入口压力」和「设备故障」。
    assert.equal(stats.failed, 0, '入口拒绝不计入执行失败');
    assert.deepEqual(stats.failedByCode, {}, '入口拒绝不得污染失败分类');

    gate.resolve();
    await head;
});

test('排队期已超时的任务计入 rejected.ADB_TIMEOUT', async () => {
    const client = new AdbClient({ adbPath: 'fake' });
    const error = await client.queue.push(async () => 'x', Date.now() - 1).catch((caught) => caught);
    assert.equal(error?.code, 'ADB_TIMEOUT');
    assert.equal(client.queueStats().rejected.ADB_TIMEOUT, 1);
});

test('resetQueueStats 清零全部计数但不动队列本体', async () => {
    const client = new AdbClient({ adbPath: 'fake' });
    await client.queue.push(async () => 'ok');
    assert.equal(client.queueStats().completed, 1);

    client.resetQueueStats();
    const stats = client.queueStats();
    assert.equal(stats.completed, 0);
    assert.equal(stats.peakDepth, 0);
    assert.deepEqual(stats.failedByCode, {});
    assert.equal(stats.maxQueueSize, 64, '配置不属于统计，不得被重置');
});

// ---------------------------------------------------------------- 显示链路

test('H.264 发送计数按包与字节累加', (t) => {
    const { server, socket } = serverFixture(t);
    assert.equal(server.metrics().h264PacketsSent, 0);

    server.sendScrcpyPacket(socket, deltaPacket(100));
    server.sendScrcpyPacket(socket, deltaPacket(50, 3));

    const metrics = server.metrics();
    assert.equal(metrics.h264PacketsSent, 2);
    assert.equal(metrics.h264BytesSent, 150);
});

test('metrics 是只读快照：连续两次读取等价，且不改变队列状态', (t) => {
    const { server, socket } = serverFixture(t);
    server.sendScrcpyPacket(socket, deltaPacket(40));
    const first = server.metrics();
    const second = server.metrics();
    assert.deepEqual(second, first);
    assert.equal(server.metrics().h264PacketsSent, 1, '读两次不能变成 2');
});

test('JPEG 背压：恰好等于上限仍发送，超出 1 字节即丢弃并计数', (t) => {
    const max = 4 * 1024;
    const { server, socket } = serverFixture(t, { maxBufferedBytes: max });
    const frame = jpegFrame(100);

    // bufferedAmount + 16 + 100 === max -> 不超限，允许发送
    socket.bufferedAmount = max - 16 - 100;
    server.sendFrame(socket, frame);
    assert.equal(server.metrics().jpegFramesSent, 1);
    assert.equal(server.metrics().jpegDroppedByBackpressure, 0);

    // 再多 1 字节 -> 超限，丢帧但不许断连（JPEG 通道语义就是丢帧继续）
    socket.bufferedAmount = max - 16 - 100 + 1;
    server.sendFrame(socket, frame);
    assert.equal(server.metrics().jpegFramesSent, 1, '丢弃不得计为已发送');
    assert.equal(server.metrics().jpegDroppedByBackpressure, 1);
    assert.equal(socket.readyState, 1, 'JPEG 通道溢出只丢帧，不断连');
});

test('H.264 背压：溢出断开慢订阅者并计入 slowSubscribersClosed', (t) => {
    const max = 4 * 1024;
    const { server, socket } = serverFixture(t, { maxBufferedBytes: max });
    socket.bufferedAmount = max;

    server.sendScrcpyPacket(socket, deltaPacket(32));

    const metrics = server.metrics();
    assert.equal(metrics.slowSubscribersClosed, 1);
    assert.equal(metrics.h264PacketsSent, 0, '被断的包不算发送成功');
    assert.equal(socket.closeCode, 1013);
    assert.equal(socket.readyState, 3);
});

test('两条背压路径分开计数，不共用同一个数字', (t) => {
    const max = 1024;
    const { server, socket } = serverFixture(t, { maxBufferedBytes: max });

    socket.bufferedAmount = max;
    server.sendFrame(socket, jpegFrame(64));          // JPEG 溢出 -> 丢帧
    assert.equal(server.metrics().jpegDroppedByBackpressure, 1);

    socket.bufferedAmount = max;
    server.sendText(socket, 'x'.repeat(64));          // 无 H264 订阅关系 -> 文本丢弃
    assert.equal(server.metrics().textDroppedByBackpressure, 1);

    const metrics = server.metrics();
    assert.equal(metrics.slowSubscribersClosed, 0, '普通 socket 溢出不得伪装成慢订阅者断开');
    assert.equal(metrics.jpegDroppedByBackpressure, 1);
});

test('resetMetrics 只清计数，不改 maxBufferedBytes 与背压语义', (t) => {
    const { server, socket } = serverFixture(t, { maxBufferedBytes: 1024 });
    server.sendScrcpyPacket(socket, deltaPacket(10));
    assert.equal(server.metrics().h264PacketsSent, 1);

    server.resetMetrics();
    const metrics = server.metrics();
    assert.equal(metrics.h264PacketsSent, 0);
    assert.equal(metrics.maxBufferedBytes, 1024);

    // 重置后仍按原阈值工作
    socket.bufferedAmount = 1024;
    server.sendFrame(socket, jpegFrame(64));
    assert.equal(server.metrics().jpegDroppedByBackpressure, 1);
});

test('metrics 暴露观众与看门狗状态，供生命周期验收对账', (t) => {
    const { server, socket } = serverFixture(t);
    server.scrcpyStreamers.set(socket, () => {});
    server.unsubscribers.set(new Socket(), () => {});
    const metrics = server.metrics();
    assert.equal(metrics.h264Viewers, 1);
    assert.equal(metrics.jpegViewers, 1);
    assert.equal(typeof metrics.bufferedBytes, 'number');
    assert.equal(metrics.watchdogRunning, false);
});
