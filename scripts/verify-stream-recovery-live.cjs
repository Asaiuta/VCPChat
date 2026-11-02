'use strict';

/**
 * 真机断流恢复验证。
 *
 * 用两种真实的断流方式：
 *   A) adb forward --remove —— 强制掐断 TCP，模拟网络抖动
 *   B) kill 设备侧 scrcpy server —— 模拟被系统回收
 *
 * 判据：断流后画面必须自己回来，不需要刷新页面。
 */

const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const sharp = require(path.join(root, 'node_modules/sharp'));
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ADB = 'D:\\AI\\tools\\platform-tools\\adb.exe';
const OUT = path.join(root, 'AppData/stream-recovery-live.png');
const quiet = { log: () => {}, warn: (m) => console.log(`  [warn] ${m}`), error: () => {} };

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}`); pass += 1; }
    else { console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); fail += 1; failures.push(name); }
}

function adb(...args) {
    return execFileSync(ADB, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
}

/** 掐断所有 scrcpy 的 TCP 转发 */
function breakForward() {
    try {
        const list = adb('forward', '--list');
        const removed = [];
        for (const line of list.split(/\r?\n/)) {
            if (!/localabstract:scrcpy/.test(line)) continue;
            const spec = line.split(/\s+/)[1];   // tcp:30659
            if (!spec) continue;
            try { adb('forward', '--remove', spec); removed.push(spec); } catch { /* 忽略 */ }
        }
        return removed;
    } catch {
        return [];
    }
}

function killServer() {
    // scrcpy server 以 app_process 运行，参数里带 com.genymobile.scrcpy
    try {
        const out = adb('shell', 'ps', '-A', '-o', 'PID,ARGS');
        const pids = out.split(/\r?\n/)
            .filter((l) => /genymobile|scrcpy/i.test(l))
            .map((l) => l.trim().split(/\s+/)[0])
            .filter((p) => /^\d+$/.test(p));
        for (const pid of pids) {
            try { adb('shell', 'kill', '-9', pid); } catch { /* 忽略 */ }
        }
        return pids;
    } catch {
        return [];
    }
}

(async () => {
    await svc.initialize({ config: { ADB_PATH: ADB }, logger: quiet });
    const base = svc.getRuntimeStatus().displayUrl;
    console.log(`显示屏: ${base}\n`);

    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 900 });
    const errors = [];
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
        let ink = 0;
        try {
            if (canvas && canvas.width > 0) {
                const d = canvas.getContext('2d')
                    .getImageData(0, 0, Math.min(120, canvas.width), Math.min(120, canvas.height)).data;
                let n = 0;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i] > 12 || d[i + 1] > 12 || d[i + 2] > 12) n += 1;
                }
                ink = n / (d.length / 4);
            }
        } catch { /* 忽略 */ }
        return {
            canvasVisible: canvas ? !canvas.classList.contains('hidden') : false,
            canvasW: canvas?.width || 0,
            ink,
            imgVisible: img ? !img.classList.contains('hidden') : false,
            imgW: img?.naturalWidth || 0,
            seq: document.getElementById('seq')?.textContent,
            conn: document.getElementById('conn')?.textContent,
            err: document.getElementById('error-box')?.textContent,
        };
    });

    /** 等到画面恢复（任一通道有内容且尺寸正常） */
    async function waitForPicture(timeoutMs, label) {
        const deadline = Date.now() + timeoutMs;
        let last = null;
        while (Date.now() < deadline) {
            last = await snapshot();
            const hasPicture = (last.canvasVisible && last.canvasW > 8 && last.ink > 0.2)
                || (last.imgVisible && last.imgW > 8);
            if (hasPicture) return { ok: true, state: last, waitedMs: timeoutMs - (deadline - Date.now()) };
            await new Promise((r) => setTimeout(r, 400));
        }
        return { ok: false, state: last, waitedMs: timeoutMs };
    }

    // ---- 基线 ----
    console.log('基线：等首帧');
    const baseline = await waitForPicture(30000, 'baseline');
    check('首帧到达', baseline.ok, `canvasW=${baseline.state?.canvasW} ink=${baseline.state?.ink?.toFixed(2)}`);
    if (!baseline.ok) {
        await browser.close();
        await svc.cleanup();
        process.exit(1);
    }
    console.log(`  canvas ${baseline.state.canvasW}px  ink=${(baseline.state.ink * 100).toFixed(0)}%  seq=${baseline.state.seq}\n`);

    // ---- A) 掐断 TCP 转发 ----
    console.log('A) 掐断 adb forward（模拟网络中断）');
    const removed = breakForward();
    console.log(`   已移除转发: ${removed.length ? removed.join(', ') : '(没找到，可能已被清理)'}`);

    await new Promise((r) => setTimeout(r, 1000));
    let recovered = await waitForPicture(45000, 'after-forward-break');
    check('断转发后画面自己回来', recovered.ok,
        `等 ${(recovered.waitedMs / 1000).toFixed(1)}s，canvasW=${recovered.state?.canvasW} imgW=${recovered.state?.imgW} conn=${recovered.state?.conn}`);
    console.log(`   恢复耗时 ${(recovered.waitedMs / 1000).toFixed(1)}s，seq=${recovered.state?.seq} 状态=${recovered.state?.conn}`);

    // ---- B) 杀设备端 server ----
    console.log('\nB) kill 设备端 scrcpy server');
    const killed = killServer();
    console.log(`   杀掉 PID: ${killed.length ? killed.join(', ') : '(未找到进程，跳过) '}`);

    if (killed.length) {
        await new Promise((r) => setTimeout(r, 1000));
        recovered = await waitForPicture(45000, 'after-kill');
        check('杀掉 server 后画面自己回来', recovered.ok,
            `等 ${(recovered.waitedMs / 1000).toFixed(1)}s，canvasW=${recovered.state?.canvasW} imgW=${recovered.state?.imgW}`);
        console.log(`   恢复耗时 ${(recovered.waitedMs / 1000).toFixed(1)}s，seq=${recovered.state?.seq}`);
    } else {
        console.log('   跳过（找不到 server 进程）');
    }

    // ---- 最终画面 ----
    const final = await snapshot();
    check('最终仍在出画', (final.canvasVisible && final.canvasW > 8) || (final.imgVisible && final.imgW > 8),
        `canvas=${final.canvasVisible}/${final.canvasW} img=${final.imgVisible}/${final.imgW}`);
    check('最终没有卡在错误提示', !/兼容模式/.test(final.err || '') || final.imgW > 0, final.err);

    if (final.canvasVisible) {
        const canvasEl = await page.$('#h264');
        if (canvasEl) {
            await canvasEl.screenshot({ path: OUT });
            const stats = await sharp(OUT).stats();
            check('恢复后截图非纯色', stats.channels[0].stdev > 10, `stdev=${stats.channels[0].stdev.toFixed(1)}`);
        }
    }

    check('无 JS 报错', errors.length === 0, errors[0] || '');

    await browser.close();
    await svc.cleanup();

    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('中断:', e.message); process.exit(1); });
