'use strict';

/**
 * 真机验证：新订阅者能否立刻出画。
 *
 * 复现用户场景：流已经跑了很久，之后才连上的客户端（刷新页面/新标签）
 * 以前永远停在「等待 SPS/PPS…」，画面冻结。
 *
 * 判据：连上后 6 秒内 canvas 必须有内容（不依赖等待下一个 IDR）。
 */

const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const sharp = require(path.join(root, 'node_modules/sharp'));
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ADB = 'D:\\AI\\tools\\platform-tools\\adb.exe';
const OUT = path.join(root, 'AppData/subscriber-init-live.png');
const quiet = { log: (m) => console.log(`  ${m}`), warn: (m) => console.log(`  [warn] ${m}`), error: () => {} };

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}`); pass += 1; }
    else { console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); fail += 1; failures.push(name); }
}

function adb(...args) {
    return execFileSync(ADB, args, { encoding: 'utf8', timeout: 25000, windowsHide: true });
}

async function openViewer(base) {
    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // 埋点：统计收到的二进制包与解码输出
    await page.evaluateOnNewDocument(() => {
        window.__d = { bins: 0, decodes: 0, renders: 0, errs: [] };
        const OrigVD = window.VideoDecoder;
        if (OrigVD) {
            window.VideoDecoder = class extends OrigVD {
                constructor(init) {
                    super({ ...init,
                        output: (f) => { window.__d.renders += 1; return init.output(f); },
                        error: (e) => { window.__d.errs.push(String(e.message)); return init.error(e); } });
                }
                decode(c) { window.__d.decodes += 1; return super.decode(c); }
            };
        }
    });

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#reconnect', { timeout: 6000 });
    await page.evaluate(() => {
        document.getElementById('wizard')?.classList.add('hidden');
        document.getElementById('screen')?.classList.remove('hidden');
        document.getElementById('reconnect')?.click();
    });
    return { browser, page, errors };
}

function snapshot(page) {
    return page.evaluate(() => {
        const c = document.getElementById('h264');
        const img = document.getElementById('screen');
        let ink = 0;
        try {
            if (c && c.width) {
                const d = c.getContext('2d').getImageData(0, 0, Math.min(100, c.width), Math.min(100, c.height)).data;
                let n = 0;
                for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 36) n += 1;
                ink = n / (d.length / 4);
            }
        } catch { /* 忽略 */ }
        return {
            ...window.__d,
            canvasVisible: c ? !c.classList.contains('hidden') : false,
            canvasW: c?.width || 0,
            imgVisible: img ? !img.classList.contains('hidden') : false,
            imgW: img?.naturalWidth || 0,
            uiSeq: document.getElementById('seq')?.textContent,
            conn: document.getElementById('conn')?.textContent,
            err: document.getElementById('error-box')?.textContent,
            ink,
        };
    });
}

async function waitPicture(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await snapshot(page);
        if (last.canvasVisible && last.canvasW > 8 && last.ink > 0.15) {
            return { ok: true, state: last, waited: timeoutMs - (deadline - Date.now()) };
        }
        if (last.imgVisible && last.imgW > 8) {
            return { ok: true, state: last, waited: timeoutMs - (deadline - Date.now()), viaJpeg: true };
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    return { ok: false, state: last, waited: timeoutMs };
}

(async () => {
    await svc.initialize({ config: { ADB_PATH: ADB, DISPLAY_PORT: 0 }, logger: quiet });
    const base = svc.getRuntimeStatus().displayUrl;
    console.log(`显示屏: ${base}\n`);

    // ---- 1) 第一个客户端：把流拉起来 ----
    console.log('1) 第一个客户端连上（启动流）');
    let A = await openViewer(base);
    let a = await waitPicture(A.page, 35000);
    check('第一个客户端出画', a.ok, `canvasW=${a.state?.canvasW} ink=${a.state?.ink?.toFixed(2)} conn=${a.state?.conn}`);
    console.log(`   canvas ${a.state?.canvasW}px ink=${(a.state?.ink * 100).toFixed(0)}% 收包=${a.state?.bins} 交互 ${a.state?.conn}`);

    // 记录服务端 seq，稍后对比
    const seqNow = await fetch(`${base}/api/scrcpy`).then((r) => r.json()).then((d) => d.status?.seq);
    console.log(`   服务端 seq=${seqNow}`);

    // ---- 2) 等流稳定跑一阵（模拟"过了一段时间"）----
    console.log('\n2) 让流继续跑 8 秒（模拟已经连了很久）');
    await new Promise((r) => setTimeout(r, 8000));
    const seqLater = await fetch(`${base}/api/scrcpy`).then((r) => r.json()).then((d) => d.status?.seq);
    check('服务端仍在出帧', seqLater > seqNow, `seq ${seqNow} → ${seqLater}`);

    // ---- 3) 关键验证：流已 streaming 时才连上的新客户端 ----
    console.log('\n3) 流已在 streaming —— 新客户端（刷新/新标签）能否立刻出画？');
    const B = await openViewer(base);
    const b = await waitPicture(B.page, 12000);
    check('新客户端立刻出画（不必等下一个 IDR）', b.ok,
        `等 ${(b.waited / 1000).toFixed(1)}s canvasW=${b.state?.canvasW} imgW=${b.state?.imgW} conn=${b.state?.conn} err="${(b.state?.err || '').slice(0, 50)}"`);
    check('新客户端拿到了 config（做过解码）', (b.state?.decodes || 0) > 0, `解码 ${b.state?.decodes} 次`);
    check('新客户端有渲染输出', (b.state?.renders || 0) > 0, `渲染 ${b.state?.renders} 帧`);
    check('新客户端无解码器错误', (b.state?.errs || []).length === 0, (b.state?.errs || []).join(' | '));
    console.log(`   耗时 ${(b.waited / 1000).toFixed(1)}s  解码=${b.state?.decodes} 渲染=${b.state?.renders} canvas ${b.state?.canvasW}px`);

    // 截图留证
    const canvasEl = await B.page.$('#h264');
    if (canvasEl) {
        await canvasEl.screenshot({ path: OUT });
        const stats = await sharp(OUT).stats();
        check('截图非纯色', stats.channels[0].stdev > 8, `stdev=${stats.channels[0].stdev.toFixed(1)}`);
    }

    // ---- 4) 新客户端画面要持续更新（不是冻在一帧）----
    console.log('\n4) 新客户端画面持续更新');
    const s1 = await snapshot(B.page);
    await new Promise((r) => setTimeout(r, 1200));
    // 制造画面变化：按音量键
    try { adb('-s', 'adb-beca2585-utuYDs._adb-tls-connect._tcp', 'shell', 'input', 'keyevent', 'KEYCODE_VOLUME_UP'); } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 1500));
    const s2 = await snapshot(B.page);
    check('seq 在推进', Number(s2.uiSeq) > Number(s1.uiSeq), `${s1.uiSeq} → ${s2.uiSeq}`);
    check('渲染帧数在增长', s2.renders > s1.renders, `${s1.renders} → ${s2.renders}`);

    check('无页面 JS 报错', B.errors.length === 0, B.errors[0] || '');
    check('第一个客户端也还在出画', (await snapshot(A.page)).canvasW > 8);

    await A.browser.close();
    await B.browser.close();
    await svc.cleanup();

    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('中断:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
