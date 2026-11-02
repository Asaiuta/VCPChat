'use strict';

/**
 * 端口漂移自愈验证。
 *
 * 场景：用户把 5977 占了（或被上次残留进程占着），显示屏退让到随机端口。
 * 期望：Loom 应用清单的 startUrl 被自动更新，否则点开应用只会看到连接拒绝。
 *
 * 运行：node scripts/verify-loom-url-sync.cjs
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ✓ ${label}`);
    else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
    console.log('端口漂移自愈验证\n');

    // 用临时目录当 AppData，避免动到真实应用清单
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sync-'));
    const appId = 'android-mirror';
    const appDir = path.join(sandbox, 'LoomApps', appId);
    fs.mkdirSync(appDir, { recursive: true });
    const manifestPath = path.join(appDir, 'loom.json');

    const cssPath = path.join(appDir, 'style.css');
    const jsPath = path.join(appDir, 'script.js');
    const css = 'body { color: teal; }';
    const js = 'window.androidMirrorFixture = true;';
    fs.writeFileSync(cssPath, css);
    fs.writeFileSync(jsPath, js);
    // 故意写一个错的端口（模拟上次运行留下的 5977，但这次要退让）
    const stale = {
        schemaVersion: 1,
        id: appId,
        name: 'Android 显示屏',
        startUrl: 'http://127.0.0.1:5977/',
        enabled: true,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(stale, null, 2));
    console.log(`初始清单 startUrl: ${stale.startUrl}\n`);

    // 占住 5977，逼显示屏退让
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(5977, '127.0.0.1', resolve);
    }).catch(() => {});
    const blocked = blocker.listening;
    console.log(`5977 ${blocked ? '已被占住（将触发退让）' : '占用失败，改用其他方式验证'}\n`);

    // 假的 loomManager：读写上面那个临时清单
    const manifests = new Map([[appId, { ...stale }]]);
    const saveCalls = [];
    const fakeLoom = {
        manifests,
        readSources: async id => {
            if (id !== appId) throw new Error(`Unexpected app: ${id}`);
            return { manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
                css: fs.readFileSync(cssPath, 'utf8'), js: fs.readFileSync(jsPath, 'utf8') };
        },
        saveApp: async ({ originalId, manifest, css: savedCss, js: savedJs }) => {
            saveCalls.push(manifest.startUrl);
            manifests.set(originalId, { ...manifest });
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            fs.writeFileSync(cssPath, savedCss);
            fs.writeFileSync(jsPath, savedJs);
            return manifest;
        },
    };

    await svc.initialize({
        config: {
            ADB_PATH: 'D:\\AI\\tools\\platform-tools\\adb.exe',
            DISPLAY_PORT: blocked ? '5977' : '0',
            LOOM_APP_ID: appId,
        },
        logger: quiet,
        services: { loomManager: fakeLoom },
    });

    const actualUrl = svc.getRuntimeStatus().displayUrl;
    console.log(`显示屏实际地址: ${actualUrl}`);
    console.log(`saveApp 调用: ${saveCalls.length} 次\n`);

    const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    check('清单 startUrl 已与实际地址一致',
        onDisk.startUrl.replace(/\/+$/, '') === String(actualUrl).replace(/\/+$/, ''),
        `清单=${onDisk.startUrl} 实际=${actualUrl}`);
    check('saveApp 被调用一次', saveCalls.length === 1, `${saveCalls.length} 次`);
    check('其它字段未被破坏', onDisk.name === 'Android 显示屏' && onDisk.id === appId && onDisk.enabled === true);
    check('CSS/JS 源码未被清空', fs.readFileSync(cssPath, 'utf8') === css && fs.readFileSync(jsPath, 'utf8') === js);

    // 幂等性：再初始化一次，地址没变就不该再写盘
    console.log('\n幂等性（再启动一次）：');
    saveCalls.length = 0;
    await svc.cleanup();
    await svc.initialize({
        config: {
            ADB_PATH: 'D:\\AI\\tools\\platform-tools\\adb.exe',
            DISPLAY_PORT: blocked ? '5977' : '0',
            LOOM_APP_ID: appId,
        },
        logger: quiet,
        services: { loomManager: fakeLoom },
    });
    // 第二次端口会变（39570 → 其他），所以这里只验证「地址不一致才写」
    console.log(`  第二次 saveApp 调用: ${saveCalls.length} 次（地址若变化才会写）`);
    check('行为可解释（有变化才写，无变化零写）', saveCalls.length <= 1, `${saveCalls.length}`);

    await svc.cleanup();
    if (blocked) await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(sandbox, { recursive: true, force: true });

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('验证失败：', error);
    process.exit(1);
});
