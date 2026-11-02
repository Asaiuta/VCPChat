'use strict';

/**
 * 页面断流恢复验证（fixture 回放，不需要真机）。
 *
 * 复现用户报的问题：H.264 流断开后，页面提示「回退兼容模式」，
 * 但之后再也没有画面。
 *
 * 关键区分：
 *   scrcpy-closed   → 服务端正在抢救，页面只提示「重连中」，不切 img
 *   scrcpy-fallback → 服务端确认已推 JPEG，页面切 img，且必须真的收到帧
 *   scrcpy-ready    → 重连成功，重建解码器，画面恢复
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
const OUT = path.join(root, 'AppData/stream-recovery.png');

const H264_MAGIC = 0x56434831;
const FRAME_MAGIC = 0x56434d31;
const FLAG_KEY = 1;
const FLAG_CONFIG = 2;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}`); pass += 1; }
    else { console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); fail += 1; }
}

const startCode = () => Buffer.from([0, 0, 0, 1]);
function annexB(nalsB64) {
    const parts = [];
    for (const b64 of nalsB64) { parts.push(startCode()); parts.push(Buffer.from(b64, 'base64')); }
    return Buffer.concat(parts);
}
function vch1(seq, pts, flags, payload) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(H264_MAGIC, 0);
    header.writeUInt32LE(seq >>> 0, 4);
    header.writeUInt32LE(Math.max(0, Math.round(pts)) >>> 0, 8);
    header.writeUInt32LE(flags >>> 0, 12);
    return Buffer.concat([header, payload]);
}
function vcm1(seq, capturedAt, jpeg) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(FRAME_MAGIC, 0);
    header.writeUInt32LE(seq >>> 0, 4);
    header.writeBigUInt64LE(BigInt(capturedAt), 8);
    return Buffer.concat([header, jpeg]);
}

/** 一张真实的 JPEG，用作回退帧 */
let JPEG_FRAME = null;
async function makeJpeg() {
    if (JPEG_FRAME) return JPEG_FRAME;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="244" height="540">
      <rect width="244" height="540" fill="#123"/>
      <rect y="0" width="244" height="60" fill="#0af"/>
      <text x="12" y="40" font-size="22" fill="#fff">兼容模式</text>
    </svg>`;
    JPEG_FRAME = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
    return JPEG_FRAME;
}

/**
 * 持续推帧。
 *
 * 真实 scrcpy 在画面有变化时会一直出帧；页面有停滞自愈
 * （4 秒没新帧就重建解码器），所以 fixture 也必须持续推，
 * 否则测的就不是「断流恢复」而是「停滞自愈」了。
 */
function pushH264(socket, counter, frames = FIXTURE.frames) {
    socket.send(vch1(counter.value++, 0, FLAG_CONFIG, annexB([FIXTURE.sps, FIXTURE.pps])), { binary: true });
    let i = 0;
    const timer = setInterval(() => {
        if (socket.readyState !== 1) { clearInterval(timer); return; }
        const frame = frames[i % frames.length];
        i += 1;
        socket.send(vch1(counter.value++, (counter.value / 15) * 1000, frame.key ? FLAG_KEY : 0,
            annexB(frame.nals)), { binary: true });
    }, 66);   // ~15fps，远快于 4 秒停滞阈值
    return timer;
}

(async () => {
    const jpeg = await makeJpeg();

    const json = (res, data) => {
        const body = JSON.stringify(data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };

    const server = http.createServer((req, res) => {
        if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        // 驱动接口：测试通过 HTTP 触发阶段切换。
        // 不能用 page.evaluate 去调 Node 端的对象 —— 那是两个不同的 JS 上下文。
        if (req.url.startsWith('/drive/')) {
            const action = req.url.slice('/drive/'.length).replace(/\?.*$/, '');
            const driver = drivers[0];
            if (!driver) { json(res, { ok: false, error: '没有活跃连接' }); return; }
            try {
                driver[action]?.();
                json(res, { ok: true, phase: driver.phase() });
            } catch (error) {
                json(res, { ok: false, error: error.message });
            }
            return;
        }
        if (req.url.startsWith('/api/')) { json(res, { ok: true, devices: [] }); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(VIEWER, 'utf8'));
    });

    const drivers = [];
    const wss = new WebSocketServer({ server, path: '/stream' });

    wss.on('connection', async (socket) => {
        const counter = { value: 0 };
        const phase = { name: 'h264' };
        let frameTimer = null;
        let h264Timer = null;

        const sendReady = () => socket.send(JSON.stringify({
            type: 'scrcpy-ready', codec: 'h264', codecString: FIXTURE.codecString,
            width: FIXTURE.width, height: FIXTURE.height, maxSize: 540, maxFps: 30,
        }));

        // 阶段 1：正常 H.264
        sendReady();
        h264Timer = pushH264(socket, counter);

        const startJpeg = () => {
            if (frameTimer) return;
            let jseq = 0;
            frameTimer = setInterval(() => {
                if (socket.readyState !== 1) { clearInterval(frameTimer); frameTimer = null; return; }
                jseq += 1;
                socket.send(vcm1(jseq, Date.now(), jpeg), { binary: true });
            }, 100);
        };

        const driver = {
            /** 断流：只发 closed，不发 fallback —— 服务端在抢救 */
            closed() {
                phase.name = 'closed';
                // 真实的流断了就不会再有帧
                if (h264Timer) { clearInterval(h264Timer); h264Timer = null; }
                socket.send(JSON.stringify({ type: 'scrcpy-closed', reason: 'stream closed' }));
            },
            /** 彻底回退：服务端已开始推 JPEG */
            fallback() {
                phase.name = 'fallback';
                if (h264Timer) { clearInterval(h264Timer); h264Timer = null; }
                socket.send(JSON.stringify({ type: 'scrcpy-fallback', reason: 'H.264 通道不可用' }));
                startJpeg();
            },
            /** 恢复：重新握手并推 H.264 */
            recovered() {
                phase.name = 'recovered';
                if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
                if (h264Timer) { clearInterval(h264Timer); h264Timer = null; }
                // 注意：不能把 counter 归零。页面用 seq 单调递增来丢重复帧，
                // 序号一旦回退，新帧会被当成旧的丢掉 —— 画面就再也不更新了。
                sendReady();
                setTimeout(() => { h264Timer = pushH264(socket, counter); }, 120);
            },
            phase: () => phase.name,
        };

        drivers.length = 0;
        drivers.push(driver);

        socket.on('close', () => {
            if (frameTimer) clearInterval(frameTimer);
            if (h264Timer) clearInterval(h264Timer);
            const idx = drivers.indexOf(driver);
            if (idx >= 0) drivers.splice(idx, 1);
        });
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 900 });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#reconnect', { timeout: 5000 });
    await page.evaluate(() => {
        document.getElementById('wizard')?.classList.add('hidden');
        document.getElementById('screen')?.classList.remove('hidden');
        document.getElementById('reconnect')?.click();
    });

    const snapshot = () => page.evaluate(() => {
        const canvas = document.getElementById('h264');
        const img = document.getElementById('screen');
        let canvasInk = 0;
        let canvasVariety = 0;
        try {
            const c = canvas;
            if (c && c.width > 0) {
                const data = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 200), Math.min(c.height, 200)).data;
                let nonBlack = 0;
                const colors = new Set();
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) nonBlack += 1;
                    if (i % 400 === 0) colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
                }
                canvasInk = nonBlack / (data.length / 4);
                canvasVariety = colors.size;
            }
        } catch { /* 忽略 */ }
        return {
            canvasVisible: canvas ? !canvas.classList.contains('hidden') : false,
            canvasW: canvas?.width || 0,
            canvasInk,
            canvasVariety,
            imgVisible: img ? !img.classList.contains('hidden') : false,
            imgW: img?.naturalWidth || 0,
            seq: document.getElementById('seq')?.textContent,
            fps: document.getElementById('fps')?.textContent,
            conn: document.getElementById('conn')?.textContent,
            err: document.getElementById('error-box')?.textContent,
            errVisible: !document.getElementById('error-box')?.classList.contains('hidden'),
        };
    });

    const drive = async (action) => {
        const result = await fetch(`${base}/drive/${action}`).then((r) => r.json());
        if (!result.ok) throw new Error(`驱动 ${action} 失败：${result.error}`);
        return result.phase;
    };

    // ---- 阶段 1：正常出画 ----
    console.log('阶段 1：H.264 正常播放');
    await new Promise((r) => setTimeout(r, 2500));
    let s = await snapshot();
    check('canvas 可见且有内容', s.canvasVisible && s.canvasInk > 0.3, `ink=${s.canvasInk?.toFixed(2)}`);
    check('画面有颜色变化', s.canvasVariety > 5, `${s.canvasVariety} 种`);
    check('序号在推进', Number(s.seq) > 3, `seq=${s.seq}`);

    // ---- 阶段 2：断流（服务端抢救中）----
    console.log('\n阶段 2：断流 —— 页面不该自己切 img 干等');
    await drive('closed');
    await new Promise((r) => setTimeout(r, 1200));
    s = await snapshot();
    check('仍显示 canvas（没盲目切 img）', s.canvasVisible, `canvasVisible=${s.canvasVisible} imgVisible=${s.imgVisible}`);
    check('没有切到 img', !s.imgVisible, `imgVisible=${s.imgVisible}`);
    check('状态显示重连中', /重连/.test(s.conn || ''), s.conn);
    check('没有出现假"回退"提示', !/兼容模式/.test(s.err || ''), s.err);
    // 关键：此刻不该有「已回退但没有画面」的状态
    check('没有陷入无画面状态', s.canvasVisible || s.imgW > 0);

    // ---- 阶段 3：服务端确认回退 → 必须真的有 JPEG 帧 ----
    console.log('\n阶段 3：真回退 —— 切 img 后必须有帧');
    await drive('fallback');
    await new Promise((r) => setTimeout(r, 1500));
    s = await snapshot();
    check('切换到 img', s.imgVisible && !s.canvasVisible, `imgVisible=${s.imgVisible} canvasVisible=${s.canvasVisible}`);
    check('img 真的有画面（自然尺寸 > 0）', s.imgW > 0, `naturalWidth=${s.imgW}`);
    check('提示说明了已切兼容模式', /兼容模式/.test(s.err || ''), s.err);

    const imgPixels = await page.evaluate(() => {
        const img = document.getElementById('screen');
        if (!img || !img.naturalWidth) return 0;
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const data = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 100)).data;
        let nonBlack = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) nonBlack += 1;
        }
        return nonBlack / (data.length / 4);
    });
    check('img 内容非黑', imgPixels > 0.3, `非黑占比 ${(imgPixels * 100).toFixed(0)}%`);

    // ---- 阶段 4：scrcpy 恢复 → 切回 H.264 ----
    console.log('\n阶段 4：H.264 恢复 —— 不刷新页面就切回来');
    await drive('recovered');
    await new Promise((r) => setTimeout(r, 2500));
    s = await snapshot();
    check('切回 canvas', s.canvasVisible && !s.imgVisible, `canvasVisible=${s.canvasVisible} imgVisible=${s.imgVisible}`);
    check('canvas 重新有内容', s.canvasInk > 0.3, `ink=${s.canvasInk?.toFixed(2)}`);
    check('解码器已重建（有颜色）', s.canvasVariety > 5, `${s.canvasVariety} 种`);
    check('序号重新推进', Number(s.seq) > 3, `seq=${s.seq}`);

    const canvasEl = await page.$('#h264');
    if (canvasEl) {
        await canvasEl.screenshot({ path: OUT });
        const stats = await sharp(OUT).stats();
        check('恢复后截图非纯色', stats.channels[0].stdev > 10, `stdev=${stats.channels[0].stdev.toFixed(1)}`);
    }

    check('无控制台报错', errors.length === 0, errors.slice(0, 2).join(' | '));

    await browser.close();
    await new Promise((r) => wss.close(r));
    server.close();

    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
