'use strict';

/**
 * scrcpy 流解析与 H.264 参数集解析的契约测试。
 *
 * 这些用例锁住三个曾经真出过错的地方：
 * 1) 会话包的宽度被读成 2147483648（把 height 的字节当成了 width）
 * 2) config 包被误判成普通帧（标志位在 pts 最高字节，用 readUInt32BE 后与 0x40 相与恒为 0）
 * 3) 普通帧的 pts 低位污染标志位，把 delta 帧当成关键帧
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
    StreamParser,
    codecStringFromSps,
    findSps,
} = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub'));

const FLAG_CONFIG = 0x40;
const FLAG_KEYFRAME = 0x20;
const FLAG_SESSION = 0x80;

function sessionPacket(width, height) {
    const b = Buffer.alloc(12);
    b[0] = FLAG_SESSION;
    b.writeUInt32BE(width, 4);
    b.writeUInt32BE(height, 8);
    return b;
}

function mediaPacket(flagByte, ptsLow, payload) {
    const b = Buffer.alloc(12 + payload.length);
    b[0] = flagByte;
    b.writeUInt32BE(ptsLow >>> 0, 4);
    b.writeUInt32BE(payload.length, 8);
    payload.copy(b, 12);
    return b;
}

function handshake(name = 'PJZ110', codec = 'h264') {
    const b = Buffer.alloc(1 + 64 + 4);
    b[0] = 0x00;
    Buffer.from(name, 'utf8').copy(b, 1);
    b.write(codec, 65, 'ascii');
    return b;
}

function collect() {
    const events = [];
    const parser = new StreamParser({
        onHandshake: (info) => events.push({ type: 'handshake', info }),
        onSession: (w, h) => events.push({ type: 'session', w, h }),
        onConfig: (payload) => events.push({ type: 'config', size: payload.length }),
        onFrame: (payload, pts, key) => events.push({ type: 'frame', size: payload.length, key, pts }),
    });
    return { parser, events };
}

// 真实抓包片段（PJZ110 / Android 17）
const SPS_PAYLOAD = Buffer.from('000000016764001eacd940a034243e9c0b0b0808080a0', 'hex');
const IDR_PAYLOAD = Buffer.from('0000000165b8415f', 'hex');
const P_PAYLOAD = Buffer.from('0000000141e223bf', 'hex');

test('握手：dummy + 设备名 + codec 被正确跳过', () => {
    const { parser, events } = collect();
    parser.push(handshake());
    assert.equal(events.length, 0, '握手阶段不应产生帧事件');
    parser.push(sessionPacket(244, 540));
    const ev = events.find((e) => e.type === 'handshake');
    assert.ok(ev, '应产生 handshake 事件');
    assert.equal(ev.info.width, 244);
    assert.equal(ev.info.height, 540);
    assert.equal(ev.info.codec, '0x68323634');
});

test('会话包：宽高解析正确（回归：曾经读成 2147483648×244）', () => {
    const { parser, events } = collect();
    parser.push(Buffer.concat([handshake(), sessionPacket(244, 540)]));
    const s = events.find((e) => e.type === 'session');
    assert.ok(s);
    assert.deepEqual([s.w, s.h], [244, 540]);
});

test('config 包被识别为配置而非帧（回归：标志位取错字节）', () => {
    const { parser, events } = collect();
    parser.push(Buffer.concat([
        handshake(),
        sessionPacket(244, 540),
        mediaPacket(FLAG_CONFIG, 0, SPS_PAYLOAD),
    ]));
    assert.equal(events.filter((e) => e.type === 'config').length, 1);
    assert.equal(events.filter((e) => e.type === 'frame').length, 0);
});

test('关键帧标记为 key', () => {
    const { parser, events } = collect();
    parser.push(Buffer.concat([
        handshake(),
        sessionPacket(244, 540),
        mediaPacket(FLAG_KEYFRAME, 0x33, IDR_PAYLOAD),
    ]));
    const frames = events.filter((e) => e.type === 'frame');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].key, true);
});

test('普通帧的 pts 低位不影响标志判断（回归：delta 帧被当关键帧）', () => {
    for (const pts of [0x33, 0x40, 0x20, 0x60, 0xff]) {
        const { parser, events } = collect();
        parser.push(Buffer.concat([
            handshake(),
            sessionPacket(244, 540),
            mediaPacket(0x00, pts, P_PAYLOAD),
        ]));
        const frames = events.filter((e) => e.type === 'frame');
        assert.equal(frames.length, 1, `pts=${pts.toString(16)}`);
        assert.equal(frames[0].key, false, `pts=0x${pts.toString(16)} 被误判为关键帧`);
        assert.equal(events.filter((e) => e.type === 'config').length, 0,
            `pts=0x${pts.toString(16)} 被误判为 config`);
    }
});

test('任意切分点都能正确解析（网络分片）', () => {
    const stream = Buffer.concat([
        handshake(),
        sessionPacket(244, 540),
        mediaPacket(FLAG_CONFIG, 0, SPS_PAYLOAD),
        mediaPacket(FLAG_KEYFRAME, 0, IDR_PAYLOAD),
        mediaPacket(0x00, 0x33, P_PAYLOAD),
    ]);

    for (let split = 1; split < stream.length; split += 5) {
        const { parser, events } = collect();
        parser.push(stream.subarray(0, split));
        parser.push(stream.subarray(split));
        assert.equal(events.filter((e) => e.type === 'config').length, 1, `切分点 ${split}`);
        assert.equal(events.filter((e) => e.type === 'frame').length, 2, `切分点 ${split}`);
    }
});

test('字节级投递：逐字节喂入也能解析', () => {
    const stream = Buffer.concat([
        handshake(),
        sessionPacket(244, 540),
        mediaPacket(FLAG_CONFIG, 0, SPS_PAYLOAD),
        mediaPacket(FLAG_KEYFRAME, 0, IDR_PAYLOAD),
    ]);
    const { parser, events } = collect();
    for (let i = 0; i < stream.length; i += 1) {
        parser.push(stream.subarray(i, i + 1));
    }
    assert.equal(events.filter((e) => e.type === 'config').length, 1);
    assert.equal(events.filter((e) => e.type === 'frame').length, 1);
});

test('旋转：第二个会话包触发尺寸变更', () => {
    const { parser, events } = collect();
    parser.push(Buffer.concat([
        handshake(),
        sessionPacket(244, 540),
        mediaPacket(FLAG_CONFIG, 0, SPS_PAYLOAD),
        sessionPacket(540, 244),
        mediaPacket(FLAG_KEYFRAME, 0, IDR_PAYLOAD),
    ]));
    const sessions = events.filter((e) => e.type === 'session');
    assert.equal(sessions.length, 2);
    assert.deepEqual([sessions[1].w, sessions[1].h], [540, 244]);
});

test('异常包尺寸会抛出而不是静默吞掉', () => {
    const { parser } = collect();
    const bad = Buffer.alloc(12);
    bad[0] = 0x00;
    bad.writeUInt32BE(0x7fffffff, 8);   // 声称 2GB
    const stream = Buffer.concat([handshake(), sessionPacket(244, 540), bad]);
    assert.throws(() => parser.push(stream), /包尺寸异常/);
});

test('codecStringFromSps：真实 SPS → avc1.64001e', () => {
    const sps = findSps(SPS_PAYLOAD);
    assert.ok(sps, '应能找到 SPS');
    assert.equal(codecStringFromSps(sps), 'avc1.64001e');
});

test('codecStringFromSps：baseline profile', () => {
    assert.equal(codecStringFromSps(Buffer.from([0x42, 0xe0, 0x1e])), 'avc1.42e01e');
});

test('findSps：三字节起始码可识别', () => {
    const sps = findSps(Buffer.from('0000016742e01e', 'hex'));
    assert.ok(sps);
    assert.equal(sps[0], 0x42);
});

test('findSps：没有 SPS 时返回 null', () => {
    assert.equal(findSps(Buffer.from('0000000141e2', 'hex')), null);
    assert.equal(findSps(Buffer.alloc(0)), null);
});

test('codecStringFromSps：数据不足时返回 null 而不是崩', () => {
    assert.equal(codecStringFromSps(null), null);
    assert.equal(codecStringFromSps(Buffer.from([0x64])), null);
});
