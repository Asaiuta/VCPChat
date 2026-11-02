'use strict';

/**
 * 自动连接端到端验证。
 *
 * 验证用户视角的完整路径：打开页面 → 什么都不点 → 进画面。
 *
 * 分两个场景：
 * A) 设备已连接：页面加载后应直接进画面（0 次点击）
 * B) 设备未连接：页面应自己发现并连上（0 次点击）
 */

const path = require('path');
const root = path.resolve(__dirname, '..');
const { execFileSync } = require('child_process');
const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ADB = 'D:\\AI\\tools\\platform-tools\\adb.exe';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}`); pass += 1; }
    else { console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); fail += 1; }
}

function adb(...args) {
    try {
        return execFileSync(ADB, args, { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim();
    } catch (e) {
        return `[adb 失败] ${e.message}`;
    }
}

function currentDevice() {
    const out = adb('devices');
    for (const line of out.split(/\r?\n/)) {
        const m = /^(\S+)\s+device$/.exec(line.trim());
        if (m) return m[1];
    }
    return null;
}

(async () => {
    await svc.initialize({ config: { ADB_PATH: ADB }, logger: quiet });
    const base = svc.getRuntimeStatus().displayUrl;

    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox'],
    });

    async function openAndWait(label, url = base) {
        const page = await browser.newPage();
        await page.setViewport({ width: 900, height: 1000 });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        // 记录用户点击次数 —— 断言的核心
        await page.evaluateOnNewDocument(() => {
            window.__clicks = 0;
            document.addEventListener('click', () => { window.__clicks += 1; }, true);
        });

        await page.goto(url, { waitUntil: 'load' });

        // 完全不操作，等页面自己进画面
        const ok = await page.waitForFunction(
            () => {
                const wiz = document.getElementById('wizard');
                const canvas = document.getElementById('h264');
                const img = document.getElementById('screen');
                const streaming = (canvas && canvas.width > 8 && !canvas.classList.contains('hidden'))
                    || (img && img.naturalWidth > 8 && !img.classList.contains('hidden'));
                return streaming && wiz && wiz.classList.contains('hidden');
            },
            { timeout: 45000, polling: 250 },
        ).then(() => true).catch(() => false);

        // 刚进画面时序号还很小、fps 也还没稳定，等 3 秒再读
        await new Promise((r) => setTimeout(r, 3000));

        const clicks = await page.evaluate(() => window.__clicks);
        const state = await page.evaluate(() => ({
            seq: document.getElementById('seq')?.textContent,
            fps: document.getElementById('fps')?.textContent,
            res: document.getElementById('res')?.textContent,
            scanMsg: document.getElementById('scanMsg')?.textContent,
            connMsg: document.getElementById('connMsg')?.textContent,
        }));

        console.log(`  [${label}] clicks=${clicks} seq=${state.seq} fps=${state.fps} res=${state.res}`);
        return { ok, clicks, state, errors, page };
    }

    // ---- 场景 A：设备已连接 ----
    console.log('\n场景 A：设备已连接，打开就出画面');
    const serial = currentDevice();
    if (!serial) {
        console.log('  跳过（当前无已连接设备）');
    } else {
        console.log(`  当前设备: ${serial}`);
        const a = await openAndWait('已连接');
        check('无需点击即进入画面', a.ok);
        check('点击次数为 0', a.clicks === 0, `实际 ${a.clicks} 次`);
        check('画面在推进', Number(a.state.seq) > 5, `seq=${a.state.seq}`);
        check('无 JS 报错', a.errors.length === 0, a.errors[0] || '');
        await a.page.close();
    }

    // ---- 场景 B：设备未连接，页面自己连 ----
    console.log('\n场景 B：先断开设备，页面应自己连上');
    if (!serial) {
        console.log('  跳过（当前无已连接设备）');
    } else {
        adb('disconnect', serial);
        await new Promise((r) => setTimeout(r, 1200));
        // 清掉服务端的当前设备选择，模拟冷启动
        await svc.cleanup();
        await svc.initialize({ config: { ADB_PATH: ADB }, logger: quiet });
        // 端口可能漂移，必须重读
        const base2 = svc.getRuntimeStatus().displayUrl;
        console.log(`  重启后显示屏: ${base2}`);
        await new Promise((r) => setTimeout(r, 500));

        const b = await openAndWait('未连接→自动', base2);
        check('断开后仍能自动连上并出画面', b.ok, b.state.scanMsg || '');
        check('点击次数为 0', b.clicks === 0, `实际 ${b.clicks} 次`);
        check('无 JS 报错', b.errors.length === 0, b.errors[0] || '');
        await b.page.close();

        const now = currentDevice();
        console.log(`  重连结果: ${now || '无'}`);
        check('设备已恢复连接', Boolean(now));
    }

    await browser.close();
    await svc.cleanup();

    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
