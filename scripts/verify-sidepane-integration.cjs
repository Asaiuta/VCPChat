'use strict';

/**
 * 侧栏集成验证。
 *
 * 不启动完整 VCPChat，而是复刻 VCPDistributedServer 的注入方式
 * （VCPDistributedServer.js:161 `services.loomManager`），用假的 sideBrowser
 * 验证 StartDisplay(open:true) 真的会调过侧栏，且降级路径也正确。
 *
 * 运行：node scripts/verify-sidepane-integration.cjs
 */

const path = require('path');

const root = path.resolve(__dirname, '..');
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ✓ ${label}`);
    else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
    console.log('侧栏集成验证\n');

    const opened = [];
    const fakeLoomManager = {
        sideBrowser: {
            open: async ({ url }) => {
                opened.push(url);
                return { targetId: 'browser:42', title: 'Android 显示屏', url };
            },
        },
    };

    const baseConfig = {
        ADB_PATH: 'D:\\AI\\tools\\platform-tools\\adb.exe',
        DISPLAY_PORT: '0',
        STREAM_FORMAT: 'jpeg',
    };

    // --- 1) 有 loomManager：应当真的打开侧栏 ---
    console.log('注入 loomManager（正常路径）：');
    await svc.initialize({ config: baseConfig, logger: quiet, services: { loomManager: fakeLoomManager } });

    const result = await svc.processToolCall({ command: 'Manage', operation: 'startDisplay', open: true });
    const text = result.content[0].text;

    check('调用了 sideBrowser.open 一次', opened.length === 1, `调用 ${opened.length} 次`);
    check('打开的地址是显示屏 URL', opened[0] === result.details.url, `${opened[0]} vs ${result.details.url}`);
    check('地址为 loopback', /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(opened[0] || ''), opened[0]);
    check('返回值带 sidePane 信息', Boolean(result.details.sidePane?.targetId), JSON.stringify(result.details.sidePane));
    check('提示文案说明已开进侧栏', text.includes('侧栏'), text.slice(0, 80));
    check('没有 sidePaneError', !result.details.sidePaneError);
    await svc.cleanup();

    // --- 2) 无 loomManager：应降级而不是抛错 ---
    console.log('\n未注入 loomManager（降级路径）：');
    opened.length = 0;
    await svc.initialize({ config: baseConfig, logger: quiet });
    const degraded = await svc.processToolCall({ command: 'Manage', operation: 'startDisplay', open: true });
    const degradedText = degraded.content[0].text;

    check('没有调用 sideBrowser', opened.length === 0);
    check('仍返回可用 URL', /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(degraded.details.url || ''), degraded.details.url);
    check('记录了 sidePaneError', Boolean(degraded.details.sidePaneError), degraded.details.sidePaneError);
    check('提示用户手动输入地址', degradedText.includes('地址栏'), degradedText.slice(0, 100));
    await svc.cleanup();

    // --- 3) open=false：不应碰侧栏 ---
    console.log('\nopen 缺省（不碰侧栏）：');
    opened.length = 0;
    await svc.initialize({ config: baseConfig, logger: quiet, services: { loomManager: fakeLoomManager } });
    const passive = await svc.processToolCall({ command: 'Manage', operation: 'startDisplay' });
    check('没有调用 sideBrowser', opened.length === 0);
    check('未返回 sidePane', !passive.details.sidePane);
    await svc.cleanup();

    // --- 4) sideBrowser.open 抛错：不应让 StartDisplay 整体失败 ---
    console.log('\n侧栏打开抛错（容错）：');
    const throwingLoom = {
        sideBrowser: { open: async () => { throw new Error('BROWSER_HOST_TIMEOUT 主窗口未就绪'); } },
    };
    await svc.initialize({ config: baseConfig, logger: quiet, services: { loomManager: throwingLoom } });
    let threw = false;
    let response = null;
    try {
        response = await svc.processToolCall({ command: 'Manage', operation: 'startDisplay', open: true });
    } catch {
        threw = true;
    }
    check('StartDisplay 未因侧栏失败而抛错', !threw);
    check('记录了失败原因', Boolean(response?.details.sidePaneError), response?.details.sidePaneError);
    check('显示屏 URL 仍可用', Boolean(response?.details.url));
    await svc.cleanup();

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('验证失败：', error);
    process.exit(1);
});
