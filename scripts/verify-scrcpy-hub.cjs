'use strict';

/**
 * ScrcpyHub 真机验证。
 *
 * 验证：能开流、能收到 config、能收到帧、码率合理、stop 后清理干净。
 */

const path = require('path');
const root = path.resolve(__dirname, '..');
const { ScrcpyHub } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub'));
const { AdbClient } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/adb'));

const ADB_PATH = path.join('D:', 'AI', 'tools', 'platform-tools', 'adb.exe');
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

(async () => {
    const adb = new AdbClient({ adbPath: ADB_PATH, logger: quiet });
    const devices = await adb.devices();
    const device = devices.find((d) => d.state === 'device');
    if (!device) throw new Error('没有已连接的设备');

    console.log(`设备: ${device.serial} (${device.model})\n`);

    const hub = new ScrcpyHub({
        adbPath: ADB_PATH,
        serial: device.serial,
        logger: { log: (m) => console.log(`  ${m}`), warn: (m) => console.log(`  ! ${m}`) },
        maxSize: 540,
        bitRate: 2000000,
        maxFps: 30,
    });

    let configs = 0;
    let frames = 0;
    let keyframes = 0;
    let bytes = 0;
    let firstFrameAt = null;
    let codecInfo = null;

    const started = Date.now();
    const unsubscribe = hub.subscribe((packet) => {
        if (packet.type === 'config') {
            configs += 1;
            codecInfo = { codecString: hub.codecString, sps: hub.sps ? hub.sps.toString('hex') : null };
        } else if (packet.type === 'frame') {
            frames += 1;
            if (packet.key) keyframes += 1;
            bytes += packet.data.length;
            if (firstFrameAt === null) firstFrameAt = Date.now();
        }
    });

    console.log('=== 启动 ===');
    const status = await hub.start();
    console.log(`state=${status.state} codec=${status.codec} 尺寸=${status.width}×${status.height}`);
    console.log(`codecString=${status.codecString}\n`);

    // 制造画面变化，逼编码器出帧
    console.log('=== 制造画面变化（滑动） ===');
    for (let i = 0; i < 4; i += 1) {
        await adb.runText(['shell', 'input', 'swipe', '720', '1600', '720', '900', '120'], { serial: device.serial, timeoutMs: 10000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 700));
    }
    await new Promise((r) => setTimeout(r, 2000));

    unsubscribe();
    const final = hub.status();
    await hub.stop();
    const elapsed = Date.now() - started;

    console.log('\n=== 结果 ===');
    console.log(`运行时长: ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`config 包: ${configs}`);
    console.log(`帧数: ${frames}（关键帧 ${keyframes}）`);
    console.log(`负载: ${(bytes / 1024).toFixed(0)}KB`);
    console.log(`实测 fps: ${final.effectiveFps}`);
    console.log(`首帧延迟: ${firstFrameAt ? `${firstFrameAt - started}ms` : '未收到'}`);
    console.log(`codecString: ${codecInfo?.codecString || final.codecString}`);
    console.log(`SPS: ${codecInfo?.sps || '(未提取)'}`);

    // stop 后确认转发已清理
    const checkFwd = await new Promise((resolve) => {
        require('child_process').execFile(ADB_PATH, ['-s', device.serial, 'forward', '--list'], (e, out) => resolve(out || ''));
    });
    console.log(`\n残留转发: ${checkFwd.trim() || '(无)'}`);
    console.log(`最终 state: ${hub.status().state}`);

    const ok = frames > 5 && configs >= 1 && Boolean(final.codecString);
    console.log(`\n${ok ? '通过' : '未达标'}`);
    process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
