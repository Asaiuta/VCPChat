'use strict';

/**
 * 页面 H.264 解码验证（fixture 回放，不需要真机）。
 *
 * 做法：起一个假服务端，把 fixture 里的帧按 scrcpy 协议封装成
 * VCH1 二进制包推给页面，检查 canvas 是否真的解码出画面。
 *
 * 这样即使手机不在线也能验证前端解码链路的正确性。
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const root = path.resolve(__dirname, '..');

const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const sharp = require(path.join(root, 'node_modules/sharp'));
const { WebSocketServer } = require(path.join(root, 'node_modules/ws'));

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/sample-nals.json'), 'utf8'));
const VIEWER = path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/viewer.html');
const OUT = path.join(root, 'AppData/h264-fixture.png');

const H264_MAGIC = 0x56434831;
const FLAG_KEY = 1;
const FLAG_CONFIG = 2;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}`); pass += 1; }
    else { console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); fail += 1; }
}

function startCode() { return Buffer.from([0, 0, 0, 1]); }

/** 组装 Annex-B 负载 */
function annexB(nalsB64) {
    const parts = [];
    for (const b64 of nalsB64) {
        parts.push(startCode());
        parts.push(Buffer.from(b64, 'base64'));
    }
    return Buffer.concat(parts);
}

/** 构造 VCH1 包 */
function vch1(seq, pts, flags, payload) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(H264_MAGIC, 0);
    header.writeUInt32LE(seq >>> 0, 4);
    header.writeUInt32LE(Math.max(0, Math.round(pts)) >>> 0, 8);
    header.writeUInt32LE(flags >>> 0, 12);
    return Buffer.concat([header, payload]);
}

(async () => {
    const json = (res, data) => {
        const body = JSON.stringify(data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };

    const server = http.createServer((req, res) => {
        if (req.url === '/favicon.ico') {
            res.writeHead(204);
            res.end();
            return;
        }
        // 页面加载后会调这些接口；假服务端给空数据，避免 404 噪音
        if (req.url === '/api/devices') {
            json(res, { ok: true, devices: [], current: null });
            return;
        }
        if (req.url === '/api/adb') {
            json(res, { ok: true, available: true, version: 'fake', devices: [] });
            return;
        }
        if (req.url.startsWith('/api/')) {
            json(res, { ok: true });
            return;
        }
        if (req.url === '/viewer' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            // 注入一个极简外壳：复用真实 viewer.html 但去掉连接向导
            res.end(fs.readFileSync(VIEWER, 'utf8'));
            return;
        }
        res.writeHead(404); res.end();
    });

    const wss = new WebSocketServer({ server, path: '/stream' });

    wss.on('connection', (socket) => {
        console.log('  页面已连接，开始推流…');

        // scrcpy-ready：故意让 codecString 为 null，模拟服务端解析慢——
        // 页面必须能自己从 SPS 推导
        socket.send(JSON.stringify({
            type: 'scrcpy-ready',
            codec: '0x68323634',
            codecString: null,
            width: FIXTURE.width,
            height: FIXTURE.height,
            maxSize: 540,
            maxFps: 30,
        }));

        let seq = 0;
        let sent = 0;

        // config 包（SPS + PPS）
        const configPayload = annexB([FIXTURE.sps, FIXTURE.pps]);
        socket.send(vch1(seq++, 0, FLAG_CONFIG, configPayload), { binary: true });

        // 按 15fps 的节奏回放
        const timer = setInterval(() => {
            if (sent >= FIXTURE.frames.length || socket.readyState !== 1) {
                clearInterval(timer);
                return;
            }
            const frame = FIXTURE.frames[sent];
            const payload = annexB(frame.nals);
            const flags = frame.key ? FLAG_KEY : 0;
            socket.send(vch1(seq++, (sent / 15) * 1000, flags, payload), { binary: true });
            sent += 1;
        }, 66);

        socket.on('close', () => clearInterval(timer));
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    console.log(`假服务端: ${base}\n`);

    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 900 });

    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(base, { waitUntil: 'load' });

    // 页面默认显示连接向导，先手动进入流模式（等同于用户点了连接后的状态）
    await page.evaluate(() => {
        const wizard = document.getElementById('wizard');
        if (wizard) wizard.classList.add('hidden');
        const screen = document.getElementById('screen');
        if (screen) screen.classList.remove('hidden');
    });

    // 触发连接：真实页面在 startStreaming 里调 connect()
    await page.evaluate(() => {
        // connect 是闭包内函数，通过点击「重新连接」按钮触发
        const btn = document.getElementById('reconnect');
        if (btn) btn.click();
    });

    console.log('等待解码…');
    const gotCanvas = await page.waitForFunction(
        () => {
            const c = document.getElementById('h264');
            return c && c.width > 8 && c.height > 8 && !c.classList.contains('hidden');
        },
        { timeout: 15000 },
    ).then(() => true).catch(() => false);
    check('canvas 建立并显示', gotCanvas);

    // 等回放完
    await new Promise((r) => setTimeout(r, 3500));

    const info = await page.evaluate(() => {
        const c = document.getElementById('h264');
        if (!c) return null;
        const ctx = c.getContext('2d');
        let data;
        try {
            data = ctx.getImageData(0, 0, c.width, c.height).data;
        } catch (e) {
            return { error: e.message };
        }
        // 计算非黑像素比例和颜色多样性
        let nonBlack = 0;
        const colors = new Set();
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (r > 12 || g > 12 || b > 12) nonBlack += 1;
            if (i % 400 === 0) colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
        }
        return {
            width: c.width,
            height: c.height,
            nonBlackRatio: nonBlack / (data.length / 4),
            colorVariety: colors.size,
            seq: document.getElementById('seq')?.textContent,
            fps: document.getElementById('fps')?.textContent,
            res: document.getElementById('res')?.textContent,
        };
    });

    console.log(`  canvas ${info?.width}×${info?.height}`);
    console.log(`  非黑像素占比 ${(info?.nonBlackRatio * 100).toFixed(1)}%`);
    console.log(`  颜色多样性 ${info?.colorVariety}`);
    console.log(`  页面显示 seq=${info?.seq} fps=${info?.fps} res=${info?.res}`);

    check('canvas 尺寸正确', info?.width === FIXTURE.width && info?.height === FIXTURE.height,
        `${info?.width}×${info?.height}，期望 ${FIXTURE.width}×${FIXTURE.height}`);
    check('画面有实际内容（非黑屏）', (info?.nonBlackRatio || 0) > 0.3, `${((info?.nonBlackRatio || 0) * 100).toFixed(1)}%`);
    check('画面有颜色变化（真的解码了）', (info?.colorVariety || 0) > 5, `${info?.colorVariety} 种`);
    check('帧序号在推进', Number(info?.seq) > 10, `seq=${info?.seq}`);

    const canvasEl = await page.$('#h264');
    if (canvasEl) {
        await canvasEl.screenshot({ path: OUT });
        const stats = await sharp(OUT).stats();
        console.log(`  截图标准差 ${stats.channels[0].stdev.toFixed(1)}`);
        check('截图非纯色', stats.channels[0].stdev > 10, `stdev=${stats.channels[0].stdev.toFixed(1)}`);
    }

    check('无控制台报错', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    await new Promise((r) => wss.close(r));
    server.close();

    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
