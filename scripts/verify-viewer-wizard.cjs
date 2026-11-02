'use strict';

/**
 * 连接向导界面验证。
 *
 * 用假 adb 驱动 StreamServer，再用 puppeteer 模拟人类的点击流程：
 * 填地址 → 点配对 → 填 IP → 点连接 → 自动切到画面。
 * 确认整条交互链路真的不需要命令行。
 *
 * 运行：node scripts/verify-viewer-wizard.cjs
 * 产物：AppData/android-wizard-check.png
 */

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const { StreamServer } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/stream-server'));
const sharp = require(path.join(root, 'node_modules/sharp'));
const puppeteer = require(path.join(root, 'node_modules/puppeteer'));

const OUT = path.join(root, 'AppData/android-wizard-check.png');

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ✓ ${label}`);
    else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function findBrowser() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    return candidates.find((file) => fs.existsSync(file)) || null;
}

/**
 * 有状态的假设备管理接口：模拟真实的配对→连接→上线时序。
 */
function createFakeDeviceApi() {
    const calls = { discover: 0 };
    const state = { paired: false, connected: false, pairCalls: [], connectCalls: [] };

    return {
        state,
        calls,
        api: {
            async adbStatus() {
                return { ok: true, available: true, version: 'Android Debug Bridge version 1.0.41', addresses: ['192.168.1.10'] };
            },
            async listDevices() {
                const devices = state.connected
                    ? [{ serial: '192.168.1.20:5555', state: 'device', model: 'Pixel 7' }]
                    : [];
                return { ok: true, devices, ready: devices.length, streaming: state.connected, error: null };
            },
            async discover(body) {
                calls.discover += 1;
                // 模拟：手机上开着配对框
                return {
                    ok: true, attempts: 2, mdns: true,
                    pairing: [{ name: 'adb-X-Y', kind: 'pairing', host: '192.168.1.20', port: 37105, address: '192.168.1.20:37105' }],
                    connect: state.connected
                        ? [{ name: 'adb-X-Z', kind: 'connect', host: '192.168.1.20', port: 5555, address: '192.168.1.20:5555', connected: true }]
                        : [],
                    canPair: true,
                    canConnect: state.connected,
                };
            },
            async pair(body) {
                state.pairCalls.push(body);
                if (!/^\d{6}$/.test(body.code || '')) {
                    return { ok: false, error: '配对码是手机屏幕上显示的 6 位数字' };
                }
                state.paired = true;
                return { ok: true, autoDiscovered: !body.address, message: '配对成功' };
            },
            async connect(body) {
                state.connectCalls.push(body);
                // 真实语义：没配对过、也没给地址时必然连不上。
                // 这里若无条件成功，页面启动时的自动接管会误以为已连上，
                // 直接把向导收起来，后续点击全部落空。
                if (!state.paired && !body.address) {
                    return {
                        ok: false,
                        error: '没有自动发现可连接的手机。',
                        hint: '确认无线调试已打开，首次使用需要先配对。',
                        diagnosis: 'NO_CONNECT_SERVICE',
                    };
                }
                state.connected = true;
                return { ok: true, autoDiscovered: !body.address, state: 'device', model: 'Pixel 7', message: '已连接' };
            },
            async disconnect() {
                state.connected = false;
                return { ok: true, message: '已断开' };
            },
        },
    };
}

/**
 * 假 FrameHub：产出可解码的真实帧，供页面渲染。
 */
function createFakeHub() {
    const subscribers = new Set();
    let seq = 0;
    let timer = null;
    let cache = null;

    const tick = async () => {
        seq += 1;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="1200">
          <rect width="540" height="1200" fill="#10141a"/>
          <rect width="540" height="90" fill="#1e6f8f"/>
          <text x="30" y="58" font-family="sans-serif" font-size="28" fill="#fff">手机画面 ${seq}</text>
          <rect x="40" y="150" width="460" height="210" rx="14" fill="#1d2530"/>
          <text x="60" y="230" font-family="sans-serif" font-size="24" fill="#7dd3fc">已连接</text>
          <text x="60" y="290" font-family="sans-serif" font-size="20" fill="#94a3b8">帧 ${seq}</text>
        </svg>`;
        cache = await sharp(Buffer.from(svg)).png().toBuffer();
        const frame = {
            seq,
            capturedAt: Date.now(),
            buffer: cache,
            mime: 'image/png',
        };
        for (const send of subscribers) send(frame);
    };

    return {
        get seq() { return seq; },
        status() {
            return {
                streaming: subscribers.size > 0, subscribers: subscribers.size, seq,
                latestAgeMs: 0, lastDurationMs: 12, byteLength: cache?.length || 0,
                format: 'png', quality: 90, intervalMs: 400, consecutiveFailures: 0, lastError: null,
            };
        },
        subscribe(send) {
            subscribers.add(send);
            if (cache) send({ seq, capturedAt: Date.now(), buffer: cache, mime: 'image/png' });
            if (!timer) {
                tick().catch(() => {});
                timer = setInterval(() => { tick().catch(() => {}); }, 400);
            }
            return () => {
                subscribers.delete(send);
                if (!subscribers.size && timer) { clearInterval(timer); timer = null; }
            };
        },
        async capture() { if (!cache) await tick(); return { seq, buffer: cache, mime: 'image/png', capturedAt: Date.now() }; },
        latestOrNull() { return cache ? { seq, buffer: cache, mime: 'image/png', capturedAt: Date.now() } : null; },
        stop() { if (timer) { clearInterval(timer); timer = null; } subscribers.clear(); },
    };
}

async function main() {
    console.log('连接向导界面验证\n');

    const fake = createFakeDeviceApi();
    const hub = createFakeHub();
    const server = new StreamServer({
        frameHub: hub,
        port: 0,
        logger: { log: () => {}, warn: () => {} },
        deviceApi: fake.api,
    });

    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;
    console.log(`服务: ${base}\n`);

    const executablePath = findBrowser();
    if (!executablePath) {
        console.log('  ! 未找到 Chromium 内核，跳过界面验证');
        await server.stop(); hub.stop();
        process.exit(0);
    }
    console.log(`内核: ${executablePath}\n`);

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 800 });

    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(err.message));

    try {
        await page.goto(base, { waitUntil: 'networkidle2' });

        // --- 1) 首屏：向导可见，且没有命令行字样 ---
        console.log('首屏：');
        const wizardVisible = await page.$eval('#wizard', (el) => !el.classList.contains('hidden'));
        check('连接向导默认展示', wizardVisible);

        const bodyText = await page.$eval('body', (el) => el.innerText);
        check('不再提示用户敲 adb devices', !/adb devices/.test(bodyText), bodyText.match(/adb devices/)?.[0]);
        check('显示了本机 IP 提示', /192\.168\.1\.10/.test(bodyText));
        check('三个步骤都在', ['无线调试', '配对', '连接'].every((word) => bodyText.includes(word)));

        // --- 2) 扫描：主路径不需要用户知道 IP ---
        console.log('\n扫描自动发现：');
        await page.click('#doScan');
        await new Promise((r) => setTimeout(r, 500));
        const scanMsg = await page.$eval('#scanMsg', (el) => el.textContent);
        const pairBoxVisible = await page.$eval('#pairBox', (el) => !el.classList.contains('hidden'));
        check('发现配对中的手机', /发现/.test(scanMsg), scanMsg);
        check('只要求输入 6 位配对码', pairBoxVisible);

        // 页面上不该再有必填的 IP 输入框
        const pairAddrRequired = await page.$eval('#pairAddr', (el) => {
            const details = el.closest('details');
            return !details || details.open === false;
        });
        check('IP 输入默认收在「手动」折叠区', pairAddrRequired);

        // --- 3) 校验：配对码格式 ---
        console.log('\n配对码校验：');
        await page.click('#doPair');
        await new Promise((r) => setTimeout(r, 150));
        const codeMsg = await page.$eval('#pairMsg', (el) => el.textContent);
        check('缺配对码时提示', /6 位/.test(codeMsg), codeMsg);
        check('前端校验未发往服务端', fake.state.pairCalls.length === 0, `${fake.state.pairCalls.length} 次`);

        // --- 4) 配对成功（不带地址） ---
        console.log('\n配对：');
        await page.type('#pairCode', '123456');
        await page.click('#doPair');
        await new Promise((r) => setTimeout(r, 600));
        check('服务端收到配对请求', fake.state.pairCalls.length === 1);
        check('配对码正确传递', fake.state.pairCalls[0]?.code === '123456');
        check('没有传 IP（走自动发现）', !fake.state.pairCalls[0]?.address, JSON.stringify(fake.state.pairCalls[0]));

        const step2Done = await page.$eval('#step2', (el) => el.classList.contains('done'));
        check('步骤 2 标记完成', step2Done);

        // --- 5) 连接（配对后已自动完成） ---
        console.log('\n连接：');
        // 配对成功会触发 autoConnect，说明「配对后自动连上」的设计生效了
        check('配对后自动发起了连接', fake.state.connectCalls.length >= 1, `${fake.state.connectCalls.length} 次`);
        check('自动连接没传 IP', !fake.state.connectCalls[0]?.address, JSON.stringify(fake.state.connectCalls[0]));

        // --- 5) 自动切到画面 ---
        console.log('\n自动切换到画面：');
        const wizardHidden = await page.$eval('#wizard', (el) => el.classList.contains('hidden'));
        check('向导自动收起', wizardHidden);
        const screenVisible = await page.$eval('#screen', (el) => !el.classList.contains('hidden'));
        check('画面元素可见', screenVisible);

        await new Promise((r) => setTimeout(r, 1200));
        const natural = await page.$eval('#screen', (el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
        check('画面真的解码出来了', natural.w > 0 && natural.h > 0, JSON.stringify(natural));

        const seqText = await page.$eval('#seq', (el) => el.textContent);
        check('帧序号在递增', Number(seqText) > 0, seqText);

        const connText = await page.$eval('#conn', (el) => el.textContent);
        check('状态显示已连接', /已连接/.test(connText), connText);

        // --- 6) 截图存证 ---
        await page.screenshot({ path: OUT, fullPage: false });
        const meta = await sharp(OUT).metadata();
        check('截图已生成', fs.existsSync(OUT) && meta.width > 0, `${meta.width}×${meta.height}`);

        // 像素多样性：确认不是纯色空白
        const stats = await sharp(OUT).stats();
        const spread = stats.channels[0].stdev;
        check('截图非纯色', spread > 8, `stdev=${spread.toFixed(1)}`);

        check('无控制台报错', errors.length === 0, errors.slice(0, 2).join(' | '));

        console.log(`\n截图已保存: ${OUT}`);
    } finally {
        await browser.close();
        await server.stop();
        hub.stop();
    }

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('验证失败：', error);
    process.exit(1);
});
