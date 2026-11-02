'use strict';

/**
 * 真机验证：画面是否真的跟随手机变化。
 *
 * 用户的核心抱怨是「手机在操作，画面不更新」。
 * 所以判据不能是「有画面」，必须是「画面随操作改变」。
 *
 * 手段：打开计算器，点 1，再点 2，抓两次 canvas。
 * 两次像素必须不同 —— 相同就说明画面冻住了。
 */

const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const sharp = require(path.join(root, 'node_modules/sharp'));
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ADB = 'D:\\AI\\tools\\platform-tools\\adb.exe';
const quiet = { log: () => {}, warn: (m) => console.log(`  [warn] ${m}`), error: () => {} };

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}`); pass += 1; }
    else { console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); fail += 1; failures.push(name); }
}

const SERIAL = (() => {
    // 不硬编码：无线调试端口每次都会变
    try {
        const out = execFileSync(ADB, ['devices'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
        const line = out.split(/\r?\n/).find((l) => /\sdevice$/.test(l.trim()));
        return line ? line.trim().split(/\s+/)[0] : null;
    } catch {
        return null;
    }
})();
if (!SERIAL) { console.error('没有可用设备'); process.exit(1); }
function adb(...args) {
    return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 25000, windowsHide: true });
}

async function call(args) {
    const result = await svc.processToolCall(args);
    const outcome = result.details?.execution?.outcome;
    if (outcome && !['observed', 'dispatched', 'verified'].includes(outcome)) {
        throw new Error(`Step ${outcome}; inspect receipt before retry: ${JSON.stringify(result.details.execution)}`);
    }
    return result;
}

/** 抓 canvas 的像素指纹：用来判断画面有没有变 */
async function canvasFingerprint(page, tag) {
    const el = await page.$('#h264');
    if (!el) return null;
    const file = path.join(root, `AppData/fp-${tag}.png`);
    await el.screenshot({ path: file });
    const stats = await sharp(file).stats();
    // 通道均值 + 标准差构成一个够用的指纹
    return {
        file,
        sig: stats.channels.map((c) => Math.round(c.mean)).join(',') + '|'
            + stats.channels.map((c) => Math.round(c.stdev)).join(','),
        stdev: stats.channels[0].stdev,
    };
}

async function snapshot(page) {
    return page.evaluate(() => {
        const c = document.getElementById('h264');
        return {
            canvasVisible: c ? !c.classList.contains('hidden') : false,
            canvasW: c?.width || 0,
            uiSeq: document.getElementById('seq')?.textContent,
            conn: document.getElementById('conn')?.textContent,
        };
    });
}

(async () => {
    await svc.initialize({ config: { ADB_PATH: ADB, DISPLAY_PORT: 0 }, logger: quiet });
    const base = svc.getRuntimeStatus().displayUrl;
    console.log(`显示屏: ${base}\n`);

    // 解锁 + 回桌面
    try { adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 800));
    try { adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 1200));

    const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#reconnect', { timeout: 6000 });
    await page.evaluate(() => {
        document.getElementById('wizard')?.classList.add('hidden');
        document.getElementById('screen')?.classList.remove('hidden');
        document.getElementById('reconnect')?.click();
    });

    // 等首帧
    let ok = false;
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
        const s = await snapshot(page);
        if (s.canvasVisible && s.canvasW > 8) { ok = true; break; }
        await new Promise((r) => setTimeout(r, 400));
    }
    check('画面出现', ok);
    if (!ok) { await browser.close(); await svc.cleanup(); process.exit(1); }

    // ---- 用界面工具打开计算器（走真实命令路径）----
    console.log('\n1) 打开计算器');
    const launched = await call({ command: 'ExecuteStep', serial: SERIAL, action: { command: 'LaunchApp', package: 'com.coloros.calculator', stop: true }, expect: { type: 'foreground', package: 'com.coloros.calculator' } });
    check('计算器已启动', launched.details?.execution?.outcome === 'verified', launched.content?.[0]?.text?.slice(0, 80));
    await new Promise((r) => setTimeout(r, 2500));

    const fp1 = await canvasFingerprint(page, 'a');
    check('画面有内容', fp1 && fp1.stdev > 5, `stdev=${fp1?.stdev?.toFixed(1)}`);

    // ---- 点一个数字，画面必须变 ----
    console.log('\n2) 点击数字 7，画面必须跟着变');
    let tapped = false;
    let fp2 = null;
    let fp3 = null;
    try {
        const obs = await call({ command: 'Observe', serial: SERIAL });
        const nodes = obs.details?.controls || [];
        const key7 = nodes.find((n) => /^(7|seven)$/i.test(String(n.label || n.text || '')));
        if (key7) {
            await call({ command: 'ExecuteStep', serial: SERIAL, action: { command: 'Tap', index: key7.index, snapshotId: obs.details.snapshotId } });
            tapped = true;
        } else if (nodes.length) {
            console.log(`   节点样例: ${nodes.slice(0, 6).map((n) => n.label || n.text).join(' | ')}`);
        }
    } catch (e) { console.log(`   点击失败: ${e.message}`); }

    if (tapped) {
        await new Promise((r) => setTimeout(r, 1800));
        fp2 = await canvasFingerprint(page, 'b');
        check('画面随点击变化', Boolean(fp1 && fp2 && fp1.sig !== fp2.sig),
            `指纹 ${fp1?.sig} → ${fp2?.sig}`);

        // ---- 再点一次，确认是持续更新而不是偶然 ----
        console.log('\n3) 再点 8，画面必须再变');
        try {
            const obs2 = await call({ command: 'Observe', serial: SERIAL });
            const nodes2 = obs2.details?.controls || [];
            const key8 = nodes2.find((n) => /^(8|eight)$/i.test(String(n.label || n.text || '')));
            if (key8) await call({ command: 'ExecuteStep', serial: SERIAL, action: { command: 'Tap', index: key8.index, snapshotId: obs2.details.snapshotId } });
        } catch { /* 忽略 */ }
        await new Promise((r) => setTimeout(r, 1800));
        fp3 = await canvasFingerprint(page, 'c');
        check('画面再次变化', Boolean(fp2 && fp3 && fp2.sig !== fp3.sig),
            `指纹 ${fp2?.sig} → ${fp3?.sig}`);
    } else {
        check('找到数字键', false, '没能点到数字键');
    }

    // ---- 静止一段时间后，画面仍能更新（关键：不能一次卡死就永久冻住）----
    console.log('\n4) 静置 8 秒后再次操作，画面必须还能更新');
    await new Promise((r) => setTimeout(r, 8000));
    try { adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 2000));
    const fp4 = await canvasFingerprint(page, 'd');
    const prevFp = fp3 || fp2 || fp1;
    check('静置后画面仍会更新', Boolean(prevFp && fp4 && prevFp.sig !== fp4.sig),
        `指纹 ${prevFp?.sig} → ${fp4?.sig}`);

    const final = await snapshot(page);
    check('最终仍显示画面', final.canvasVisible && final.canvasW > 8, `canvasW=${final.canvasW}`);
    check('无 JS 报错', errors.length === 0, errors[0] || '');

    console.log(`\n截图: AppData/fp-a.png  AppData/fp-b.png  AppData/fp-c.png`);
    await browser.close();
    await svc.cleanup();
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    if (failures.length) console.log(`失败项: ${failures.join(' | ')}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('中断:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
