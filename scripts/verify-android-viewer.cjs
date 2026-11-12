'use strict';

/**
 * 显示屏页面视觉验证。
 *
 * 用假 adb 持续产出真实 PNG 帧，驱动 StreamServer，再用 puppeteer 打开
 * viewer.html 截图，确认：画面出图、状态栏统计正确、无控制台报错。
 *
 * 运行：node scripts/verify-android-viewer.cjs
 * 产物：AppData/android-viewer-check.png
 */

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const { FrameHub } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/frame-hub'));
const { StreamServer } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/stream-server'));
const sharp = require(path.join(root, 'node_modules/sharp'));
const puppeteer = require(path.join(root, 'node_modules/puppeteer'));

const OUT = path.join(root, 'AppData/android-viewer-check.png');

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ✓ ${label}`);
    else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function makeFakeScreen(tick) {
    // 画一张像手机界面的图：顶栏 + 标题 + 按钮，颜色随 tick 变化以便确认画面在刷新
    const hue = (tick * 12) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="2400">
      <rect width="1080" height="2400" fill="#10141a"/>
      <rect width="1080" height="180" fill="hsl(${hue},45%,32%)"/>
      <text x="60" y="115" font-family="sans-serif" font-size="52" fill="#fff">Android 显示屏</text>
      <rect x="80" y="300" width="920" height="420" rx="28" fill="#1d2530"/>
      <text x="120" y="420" font-family="sans-serif" font-size="46" fill="#7dd3fc">帧序号 ${tick}</text>
      <text x="120" y="500" font-family="sans-serif" font-size="34" fill="#94a3b8">这是模拟的手机画面</text>
      <rect x="80" y="820" width="920" height="140" rx="20" fill="#2a3644"/>
      <text x="120" y="910" font-family="sans-serif" font-size="40" fill="#e2e8f0">搜索</text>
      <rect x="80" y="1020" width="440" height="150" rx="20" fill="#2563eb"/>
      <text x="180" y="1115" font-family="sans-serif" font-size="44" fill="#fff">登录</text>
      <rect x="560" y="1020" width="440" height="150" rx="20" fill="#334155"/>
      <text x="650" y="1115" font-family="sans-serif" font-size="44" fill="#cbd5e1">注册</text>
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * 找一个可用的 Chromium 内核。
 * 优先用 puppeteer 自带 Chrome；没有就退回系统 Edge/Chrome —— 本机常见的是
 * 已装 Browser 但没有跑过 `npx puppeteer browsers install` 的环境。
 */
function findBrowser() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

async function main() {
    console.log('显示屏页面视觉验证\n');

    let tick = 0;
    const hub = new FrameHub({
        adb: { execOutBinary: async () => makeFakeScreen(++tick) },
        format: 'jpeg',
        quality: 70,
        maxWidth: 540,
        intervalMs: 250,
    });
    // 页面启动时会探测 /api/adb，这里给一份可用的桩，否则会拿 503
    const stubDeviceApi = {
        async adbStatus() {
            return { ok: true, available: true, version: 'Android Debug Bridge version 1.0.41', addresses: ['192.168.1.10'] };
        },
        async listDevices() {
            return {
                ok: true, ready: 1, streaming: true, error: null,
                devices: [{ serial: '192.168.1.20:5555', state: 'device', model: 'Pixel 7' }],
            };
        },
        async pair() { return { ok: true, message: '配对成功' }; },
        async connect() { return { ok: true, state: 'device', message: '已连接' }; },
        async disconnect() { return { ok: true, message: '已断开' }; },
        async discover() {
            return {
                ok: true, attempts: 1, mdns: true, canPair: false, canConnect: false,
                pairing: [], connect: [],
            };
        },
    };
    const server = new StreamServer({ frameHub: hub, port: 0, deviceApi: stubDeviceApi });
    const port = await server.start();
    const url = server.url();
    console.log(`服务: ${url}\n`);

    // 先订阅，让采集循环跑起来
    const unsubscribe = hub.subscribe(() => {});
    await hub.capture();
    await new Promise((resolve) => setTimeout(resolve, 600));

    const executablePath = findBrowser();
    if (!executablePath) {
        console.log('  ! 未找到可用 Chromium 内核，跳过视觉验证（逻辑测试仍有效）');
        unsubscribe();
        await server.stop();
        hub.stop();
        process.exit(0);
    }
    console.log(`内核: ${executablePath}\n`);

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 760 });

    const consoleErrors = [];
    const failedRequests = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('requestfailed', (req) => failedRequests.push(req.url()));
    page.on('response', (res) => {
        if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

    // 新版首屏是连接向导：没有设备时不会自动出画面。
    // 这里模拟「已连接设备」后点「看画面」，覆盖从向导切到画面的真实路径。
    await new Promise((resolve) => setTimeout(resolve, 400));
    const wizardShown = await page.$eval('#wizard', (el) => !el.classList.contains('hidden')).catch(() => false);
    if (wizardShown) {
        console.log('首屏为连接向导，模拟设备上线后进入画面…');
        // 注入一台假设备并触发刷新（走页面自己的渲染逻辑，不绕过 UI）
        await page.evaluate(() => {
            const original = window.fetch;
            window.fetch = async (input, init) => {
                const target = typeof input === 'string' ? input : input.url;
                if (target.includes('/api/devices')) {
                    return new Response(JSON.stringify({
                        ok: true, ready: 1, streaming: true, error: null,
                        devices: [{ serial: '192.168.1.20:5555', state: 'device', model: 'Pixel 7' }],
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                return original(input, init);
            };
            document.getElementById('refresh')?.click();
        });
    }

    await new Promise((resolve) => setTimeout(resolve, 1800));

    console.log('页面状态：');
    const state = await page.evaluate(() => {
        const img = document.getElementById('screen');
        return {
            imgVisible: img && !img.classList.contains('hidden'),
            naturalWidth: img?.naturalWidth || 0,
            naturalHeight: img?.naturalHeight || 0,
            hasSrc: Boolean(img?.src?.startsWith('blob:')),
            // 新版没有 placeholder，改用 wizard 是否收起作为等价判断
            placeholderHidden: document.getElementById('wizard')?.classList.contains('hidden') ?? true,
            conn: document.getElementById('conn').textContent,
            res: document.getElementById('res').textContent,
            fps: document.getElementById('fps').textContent,
            seq: document.getElementById('seq').textContent,
            dotClass: document.getElementById('dot').className,
        };
    });

    check('画面元素可见', state.imgVisible, JSON.stringify(state));
    check('已加载实际图像', state.naturalWidth > 0 && state.naturalHeight > 0, `${state.naturalWidth}x${state.naturalHeight}`);
    check('图像来自 blob URL（非占位）', state.hasSrc);
    check('向导已收起', state.placeholderHidden);
    check('连接状态为已连接', state.conn.includes('已连接'), state.conn);
    check('分辨率已回填', /\d+×\d+/.test(state.res), state.res);
    check('帧序号已递增', Number(state.seq) >= 1, state.seq);
    check('状态灯为在线色', state.dotClass.includes('online'), state.dotClass);
    check('通道里在出帧', hub.status().seq >= 2, `seq=${hub.status().seq}`);

    // 等一会儿确认画面确实在推进（帧序号增长）
    const seqBefore = Number(state.seq);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const seqAfter = Number(await page.evaluate(() => document.getElementById('seq').textContent));
    check('画面持续刷新', seqAfter > seqBefore, `${seqBefore} -> ${seqAfter}`);

    // 浏览器会自动请求 /favicon.ico，页面没提供不算缺陷；其余 404 才是真问题
    const realErrors = consoleErrors.filter((text) => !/favicon\.ico|404/i.test(text));
    const realFailed = failedRequests.filter((entry) => !/favicon\.ico/.test(entry));
    check('无页面脚本错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
    check('无失败的资源请求（favicon 除外）', realFailed.length === 0, realFailed.slice(0, 3).join(' | '));
    if (failedRequests.length) console.log(`    (忽略: ${failedRequests.join(', ')})`);

    await page.screenshot({ path: OUT, fullPage: false });
    console.log(`\n截图已保存: ${path.relative(root, OUT)}`);

    // 用 sharp 采样截图，确认画面区域确实有非背景色像素（即真的画出了手机屏幕）
    const shot = await sharp(OUT).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = shot;
    const colors = new Set();
    for (let i = 0; i < data.length; i += info.channels * 997) {
        colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    check('截图包含多种颜色（画面非纯色）', colors.size > 20, `采样到 ${colors.size} 种颜色`);
    check('截图尺寸合理', info.width > 400 && info.height > 400, `${info.width}x${info.height}`);

    await browser.close();
    unsubscribe();
    await server.stop();
    hub.stop();

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('验证失败：', error);
    process.exit(1);
});
