'use strict';

/**
 * 真机联调脚本。
 * 用真实 adb 跑 AndroidController 的完整命令链，验证设备接入与各层能力。
 *
 * 运行：node scripts/live-android-check.cjs
 */

const path = require('path');

const root = path.resolve(__dirname, '..');
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const quietLogger = {
    log: () => {},
    warn: (message) => console.log(`[warn] ${message}`),
    error: (message) => console.log(`[error] ${message}`),
};

async function main() {
    const config = {
        ADB_PATH: process.env.VCP_ADB_PATH || 'D:\\AI\\tools\\platform-tools\\adb.exe',
        DISPLAY_PORT: '0',
        STREAM_FORMAT: 'jpeg',
        STREAM_QUALITY: '70',
        STREAM_INTERVAL_MS: '400',
        STREAM_MAX_WIDTH: '540',
    };

    console.log('AndroidController 真机联调\n');
    await svc.initialize({ config, logger: quietLogger });

    const status = svc.getRuntimeStatus();
    console.log(`adb      : ${status.adbPath}`);
    console.log(`显示屏   : ${status.displayUrl}\n`);

    console.log('=== ListDevices ===');
    const devices = await svc.processToolCall({ command: 'Describe', topic: 'devices' });
    console.log(devices.content[0].text);
    console.log();

    const ready = (devices.details.devices || []).filter((d) => d.state === 'device');
    if (ready.length === 0) {
        console.log('没有处于 device 状态的设备，后续联调跳过。');
        await svc.cleanup();
        return;
    }

    const serial = ready[0].serial;
    console.log(`=== 选定设备 ${serial} ===\n`);

    console.log('=== Observe ===');
    const observed = await svc.processToolCall({ command: 'Observe', serial, limit: 25 });
    const text = observed.content[0].text;
    console.log(text.split('\n').slice(0, 30).join('\n'));
    console.log(`\n(节点数: ${observed.details.controls.length}, 截断: ${observed.details.truncated})\n`);

    console.log('=== StartDisplay + 采帧 ===');
    const display = await svc.processToolCall({ command: 'Manage', operation: 'startDisplay', serial });
    console.log(display.content[0].text.split('\n')[0]);
    const frameStatus = svc.getRuntimeStatus().frame;
    console.log(`已出帧: ${frameStatus.seq}, 单帧: ${frameStatus.lastDurationMs}ms, 体积: ${frameStatus.byteLength ? Math.round(frameStatus.byteLength / 1024) + 'KB' : '无'}`);
    if (frameStatus.lastError) console.log(`最近错误: ${frameStatus.lastError.message}`);
    console.log();

    console.log('=== ScreenSize / 前台应用 ===');
    console.log(`前台: ${observed.details.focus?.package || '(未知)'}`);
    console.log(`分辨率: ${observed.details.screen ? `${observed.details.screen.width}x${observed.details.screen.height}` : '(未知)'}`);
    console.log();

    console.log('=== ListPackages (filter=com.android.settings) ===');
    const packages = await svc.processToolCall({ command: 'Describe', topic: 'packages', serial, filter: 'com.android' });
    console.log(packages.content[0].text.split('\n').slice(0, 6).join('\n'));
    console.log();

    console.log('=== KeyEvent home ===');
    const keyResult = await svc.processToolCall({ command: 'ExecuteStep', serial, action: { command: 'KeyEvent', key: 'home' } });
    console.log(keyResult.content[0].text);

    await svc.cleanup();
    console.log('\n联调完成，已清理。');
}

main().catch((error) => {
    console.error('\n联调失败：', error.message);
    if (error.code) console.error('错误码：', error.code);
    process.exit(1);
});
