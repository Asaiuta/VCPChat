'use strict';

/**
 * 生成 H.264 测试流 fixture（Annex-B）。
 *
 * 用途：页面解码逻辑不依赖真机在线。用 ffmpeg 编码一段合成视频，
 * 拆成 NAL 单元存成 JSON，供测试回放。
 *
 * 只跑一次，产物提交到 tests/fixtures/。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const FFMPEG = 'D:\\AI\\so-vits-svc\\ffmpeg\\bin\\ffmpeg.exe';
const OUT_DIR = path.join(__dirname, '..', 'tests', 'fixtures');
const RAW = path.join(OUT_DIR, 'sample.h264');
const JSON_OUT = path.join(OUT_DIR, 'sample-nals.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

// 244×540 与实测的手机横屏尺寸一致；内容用动态测试图案，能看出帧间差异
console.log('用 ffmpeg 生成 H.264…');
execFileSync(FFMPEG, [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=244x540:rate=15:duration=2',
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-level', '3.1',
    '-pix_fmt', 'yuv420p',
    '-g', '15',              // 每秒一个关键帧
    '-bsf:v', 'h264_mp4toannexb',
    '-f', 'h264',
    RAW,
], { stdio: 'pipe', timeout: 60000 });

const raw = fs.readFileSync(RAW);
console.log(`原始流: ${(raw.length / 1024).toFixed(0)}KB`);

/** 按起始码切 NAL */
function splitNals(buffer) {
    const nals = [];
    let start = -1;
    let i = 0;
    while (i + 2 < buffer.length) {
        if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) {
            if (start >= 0) nals.push(buffer.subarray(start, i));
            i += 3;
            start = i;
        } else if (i + 3 < buffer.length && buffer[i] === 0 && buffer[i + 1] === 0
            && buffer[i + 2] === 0 && buffer[i + 3] === 1) {
            if (start >= 0) nals.push(buffer.subarray(start, i));
            i += 4;
            start = i;
        } else {
            i += 1;
        }
    }
    if (start >= 0 && start < buffer.length) nals.push(buffer.subarray(start));
    return nals;
}

const nals = splitNals(raw);
console.log(`NAL 单元: ${nals.length} 个`);

const sps = nals.find((n) => (n[0] & 0x1f) === 7);
const pps = nals.find((n) => (n[0] & 0x1f) === 8);
if (!sps || !pps) throw new Error('未找到 SPS/PPS');

const hex = (b) => b.toString(16).padStart(2, '0');
const codecString = `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
console.log(`SPS profile/level → ${codecString}`);

// 把 NAL 分组成 access unit（简化：每个 VCL NAL 自成一帧，SPS/PPS/SEI 归入前一帧）
const frames = [];
let pendingMeta = [];
for (const nal of nals) {
    const type = nal[0] & 0x1f;
    if (type === 7 || type === 8 || type === 6) {
        pendingMeta.push(nal.toString('base64'));
        continue;
    }
    frames.push({
        key: type === 5,
        nals: [...pendingMeta, nal.toString('base64')],
    });
    pendingMeta = [];
}

console.log(`帧: ${frames.length}（关键帧 ${frames.filter((f) => f.key).length}）`);
console.log(`每帧体积: ${frames.map((f) => f.nals.reduce((a, n) => a + Buffer.from(n, 'base64').length, 0)).join(', ')}`);

const fixture = {
    width: 244,
    height: 540,
    codecString,
    sps: sps.toString('base64'),
    pps: pps.toString('base64'),
    frames,
};

fs.writeFileSync(JSON_OUT, JSON.stringify(fixture));
fs.unlinkSync(RAW);
console.log(`\n已保存: ${JSON_OUT}（${(fs.statSync(JSON_OUT).size / 1024).toFixed(0)}KB）`);
