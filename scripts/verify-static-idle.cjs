'use strict';

/**
 * 静止画面的处理契约（fixture 回放，不碰真机）。
 *
 * 真机实测：手机停在静态界面时，scrcpy 最长 34 秒不发任何帧，流本身是好的。
 * 所以页面必须区分两件事：
 *   完全没有包进来  → 静止画面，不许重建解码器（否则每几秒重建一次，空转）
 *   有包但不出画    → 解码器失步，才该重建
 *
 * 这个脚本验证前者：静止期间解码器创建次数不得增加，恢复推帧后画面必须更新。
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
const OUT = path.join(root, 'AppData/static-fixture');

const H264_MAGIC = 0x56434831;
const FLAG_KEY = 1;
const FLAG_CONFIG = 2;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}`); pass += 1; }
    else { console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); fail += 1; failures.push(name); }
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

(async () => {
    const json = (res, data) => {
        const body = JSON.stringify(data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };

    const drivers = [];
    const server = http.createServer((req, res) => {
        if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (req.url.startsWith('/drive/')) {
            const action = req.url.slice('/drive/'.length).replace(/\?.*$/, '');
            const driver = drivers[0];
            if (!driver) { json(res, { ok: false }); return; }
            driver[action]?.();
            json(res, { ok: true });
            return;
        }
        if (req.url.startsWith('/api/')) { json(res, { ok: true, devices: [] }); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(VIEWER, 'utf8'));
    });

    const wss = new WebSocketServer({ server, path: '/stream' });
    wss.on('connection', (socket) => {
        const counter = { value: 0 };
        let timer = null;

        socket.send(JSON.stringify({
            type: 'scrcpy-ready', codec: 'h264', codecString: FIXTURE.codecString,
            width: FIXTURE.width, height: FIXTURE.height, maxSize: 540, maxFps: 30,
        }));

        const start = () => {
            if (timer) return;
            socket.send(vch1(counter.value++, 0, FLAG_CONFIG, annexB([FIXTURE.sps, FIXTURE.pps])), { binary: true });
            let i = 0;
            timer = setInterval(() => {
                if (socket.readyState !== 1) { clearInterval(timer); timer = null; return; }
                const frame = FIXTURE.frames[i % FIXTURE.frames.length];
                i += 1;
                socket.send(vch1(counter.value++, (counter.value / 15) * 1000, frame.key ? FLAG_KEY : 0,
                    annexB(frame.nals)), { binary: true });
            }, 66);
        };
        const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

        start();

        drivers.length = 0;
        drivers.push({
            /** 模拟手机静止：完全不再发包 */
            freeze() { stop(); },
            /** 恢复出帧 */
            resume() { start(); },
        });

        socket.on('close', () => { stop(); drivers.length = 0; });
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // 埋点：数解码器创建次数与渲染次数
    await page.evaluateOnNewDocument(() => {
        window.__d = { decoderCreated: 0, renders: 0, resyncRequests: 0 };
        const OrigVD = window.VideoDecoder;
        if (OrigVD) {
            window.VideoDecoder = class extends OrigVD {
                constructor(init) {
                    super({ ...init, output: (f) => { window.__d.renders += 1; return init.output(f); } });
                    window.__d.decoderCreated += 1;
                }
            };
        }
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
            try {
                const t = typeof data === 'string' ? data : '';
                if (t.includes('request-keyframe')) window.__d.resyncRequests += 1;
            } catch { /* 忽略 */ }
            return origSend.apply(this, [data]);
        };
    });

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#reconnect', { timeout: 6000 });
    await page.evaluate(() => {
        document.getElementById('wizard')?.classList.add('hidden');
        document.getElementById('screen')?.classList.remove('hidden');
        document.getElementById('reconnect')?.click();
    });

    const drive = (a) => fetch(`${base}/drive/${a}`).then((r) => r.json());
    const snap = () => page.evaluate(() => ({ ...window.__d }));
    const inkOf = async (tag) => {
        const el = await page.$('#h264');
        if (!el) return null;
        const file = `${OUT}-${tag}.png`;
        await el.screenshot({ path: file });
        const stats = await sharp(file).stats();
        return { sig: stats.channels.map((c) => Math.round(c.mean)).join(','), stdev: stats.channels[0].stdev };
    };

    // ---- 阶段 1：正常出画 ----
    console.log('阶段 1：正常播放');
    await new Promise((r) => setTimeout(r, 2500));
    const s1 = await snap();
    const fp1 = await inkOf('a');
    check('有渲染输出', s1.renders > 3, `渲染 ${s1.renders} 帧`);
    check('画面非纯色', fp1 && fp1.stdev > 5, `stdev=${fp1?.stdev?.toFixed(1)}`);
    console.log(`   解码器创建 ${s1.decoderCreated} 次，渲染 ${s1.renders} 帧`);

    // ---- 阶段 2：静止 12 秒（超过 STALE_MS 的 3 倍）----
    console.log('\n阶段 2：模拟手机静止 12 秒（真机最长观测 34 秒无帧）');
    await drive('freeze');
    // 先让解码队列里的在途帧排完，再开始计窗口内的新帧
    await new Promise((r) => setTimeout(r, 1200));
    const sDrained = await snap();
    await new Promise((r) => setTimeout(r, 10800));
    const s2 = await snap();
    const framesDuringFreeze = s2.renders - sDrained.renders;

    check('静止期间没有重建解码器', s2.decoderCreated === s1.decoderCreated,
        `${s1.decoderCreated} → ${s2.decoderCreated}`);
    check('静止期间没有反复请求重同步', s2.resyncRequests === 0, `${s2.resyncRequests} 次`);
    check('静止期间不再产生新帧', framesDuringFreeze === 0, `${framesDuringFreeze} 帧`);

    // 画面必须原地保留（不是黑屏）
    const fp2 = await inkOf('b');
    check('静止时画面保持在最后一帧', fp2 && fp2.stdev > 5, `stdev=${fp2?.stdev?.toFixed(1)}`);

    // ---- 阶段 3：恢复出帧 ----
    console.log('\n阶段 3：恢复出帧，画面必须继续更新');
    await drive('resume');
    await new Promise((r) => setTimeout(r, 2500));
    const s3 = await snap();
    const fp3 = await inkOf('c');
    check('恢复后渲染帧数增长', s3.renders > s2.renders, `${s2.renders} → ${s3.renders}`);
    check('恢复后仍有内容', fp3 && fp3.stdev > 5, `stdev=${fp3?.stdev?.toFixed(1)}`);
    check('恢复不需要重建解码器', s3.decoderCreated <= s2.decoderCreated + 1,
        `${s2.decoderCreated} → ${s3.decoderCreated}`);

    check('无页面报错', errors.length === 0, errors[0] || '');

    console.log(`\n截图: ${OUT}-a.png / -b.png / -c.png`);
    await browser.close();
    await new Promise((r) => wss.close(r));
    server.close();

    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('中断:', e.message); process.exit(1); });
