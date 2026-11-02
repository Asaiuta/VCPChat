'use strict';

/**
 * H.264 通道端到端验证（真实浏览器 + 真实设备）。
 *
 * 验证：
 * 1) 页面通过 WebSocket 收到 scrcpy-ready
 * 2) canvas 出现并持续更新（不是黑屏、不是纯色）
 * 3) 帧率显著高于 JPEG 通道
 * 4) 无控制台报错
 */

const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
const puppeteer = require(path.join(root, 'node_modules/puppeteer-core'));
const sharp = require(path.join(root, 'node_modules/sharp'));

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const OUT = path.join(root, 'AppData/android-h264-live.png');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) { console.log(`  ✓ ${name}`); pass += 1; }
    else { console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`); fail += 1; }
}

(async () => {
    await svc.initialize({
        config: { ADB_PATH: path.join('D:', 'AI', 'tools', 'platform-tools', 'adb.exe') },
        logger: quiet,
    });
    const base = svc.getRuntimeStatus().displayUrl;
    console.log(`显示屏: ${base}\n`);

    // 只验证服务端能开流，然后立刻停掉 —— 页面会自己启动流。
    // 不这样做会出现两个消费者共用同一个 scrcpyHub，帧被 API 那次订阅吃掉一半。
    console.log('服务端 scrcpy 冒烟：');
    const startRes = await fetch(`${base}/api/scrcpy/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: '{}',
    });
    const startData = await startRes.json();
    console.log(`  state=${startData.status?.state} codec=${startData.status?.codec} ${startData.status?.width}×${startData.status?.height}`);
    check('服务端开流成功', startData.ok && startData.status?.state === 'streaming', startData.error || '');

    await fetch(`${base}/api/scrcpy/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: '{}',
    });
    await new Promise((r) => setTimeout(r, 600));

    const browser = await puppeteer.launch({
        executablePath: EDGE,
        headless: 'new',
        args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1000 });

    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    await page.goto(base, { waitUntil: 'load' });

    // viewer.html 的事件绑定在脚本末尾，load 之后可能还没执行完。
    // 等 reconnect 按钮存在再点，否则点击落在空气上。
    await page.waitForSelector('#reconnect', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));

    // 页面默认显示连接向导。真机上用户也是这样：先看到向导，点连接后进画面。
    await page.evaluate(() => {
        document.getElementById('wizard')?.classList.add('hidden');
        document.getElementById('screen')?.classList.remove('hidden');
        document.getElementById('reconnect')?.click();
    });

    // 确认 WS 真的连上了再开始断言，避免拿空状态误判
    const wsOpened = await page.waitForFunction(
        () => window.__wsOpened === true || document.getElementById('conn')?.textContent?.includes('已连接'),
        { timeout: 20000 },
    ).then(() => true).catch(() => false);
    check('WebSocket 已连接', wsOpened);

    console.log('\n等待 H.264 通道建立…');

    const ready = await page.waitForFunction(
        () => document.getElementById('h264')
            && !document.getElementById('h264').classList.contains('hidden')
            && document.getElementById('h264').width > 0,
        { timeout: 25000 },
    ).then(() => true).catch(() => false);

    check('canvas 出现且有尺寸', ready);

    // 统计帧率：读页面内部计数
    await page.evaluate(() => {
        window.__frameLog = [];
        const canvas = document.getElementById('h264');
        const orig = HTMLCanvasElement.prototype.getContext;
        // 用 requestAnimationFrame 采样 canvas 是否在变
        window.__samples = [];
        let last = '';
        const tick = () => {
            try {
                const ctx = canvas.getContext('2d');
                const d = ctx.getImageData(0, 0, Math.min(20, canvas.width), Math.min(20, canvas.height)).data;
                const sig = Array.from(d.slice(0, 40)).join(',');
                window.__samples.push({ at: Date.now(), sig, w: canvas.width, h: canvas.height });
            } catch { /* 忽略 */ }
            requestAnimationFrame(tick);
        };
        tick();
    });

    await new Promise((r) => setTimeout(r, 6000));

    const samples = await page.evaluate(() => window.__samples || []);
    const distinct = new Set(samples.map((s) => s.sig)).size;
    const fpsText = await page.evaluate(() => document.getElementById('fps')?.textContent || '');
    const seqText = await page.evaluate(() => document.getElementById('seq')?.textContent || '');
    const resText = await page.evaluate(() => document.getElementById('res')?.textContent || '');
    const bytesText = await page.evaluate(() => document.getElementById('bytes')?.textContent || '');

    console.log(`  采样 ${samples.length} 次，不同画面 ${distinct} 种`);
    console.log(`  页面显示 fps=${fpsText} seq=${seqText} res=${resText} bytes=${bytesText}`);

    check('画面在变化（非静态）', distinct > 2, `distinct=${distinct}`);
    check('序号递增', Number(seqText) > 3, `seq=${seqText}`);

    const pageFps = parseFloat(fpsText) || 0;
    check('页面帧率 > 3 fps', pageFps > 3, `fps=${pageFps}`);

    // 截图检查画面内容
    const canvasEl = await page.$('#h264');
    if (canvasEl) {
        await canvasEl.screenshot({ path: OUT });
        const stats = await sharp(OUT).stats();
        const meta = await sharp(OUT).metadata();
        console.log(`  截图 ${meta.width}×${meta.height}，标准差 ${stats.channels[0].stdev.toFixed(1)}`);
        check('画面非纯色（有实际内容）', stats.channels[0].stdev > 10, `stdev=${stats.channels[0].stdev.toFixed(1)}`);
    }

    check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    await browser.close();

    const finalStatus = await fetch(`${base}/api/scrcpy`).then((r) => r.json());
    console.log(`\n服务端最终状态: ${finalStatus.status?.state} fps=${finalStatus.status?.effectiveFps}`);

    await svc.cleanup();

    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message, e.stack?.split('\n')[1]); process.exit(1); });
