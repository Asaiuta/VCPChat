'use strict';

/**
 * AndroidController 全量离线验证。
 *
 * 一条命令跑完所有「不需要真机」的检查，输出统一摘要。
 * 需要真机的部分（Observe / 点击 / 滑动 / 启动 / 输入）不在这里：
 *   scripts/live-android-check.cjs   基础连通与感知
 *   scripts/verify-android-actions.cjs  操作生效验证（用计算器 1+2=3 做客观判据）
 *
 * 运行：node scripts/verify-android-all.cjs
 */

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

const STEPS = [
    {
        name: '契约测试',
        detail: 'UIA 压缩 / adb 解析 / 单飞 / 引号转义 / 端口退让 / scrcpy 流解析 / 自动连接 / 启动校验 / 断流恢复 / 设备重连',
        command: process.execPath,
        args: [
            '--test',
            'tests/android-controller.test.js',
            'tests/scrcpy-parser.test.js',
            'tests/auto-connect.test.js',
            'tests/auto-connect-perf.test.js',
            'tests/launch-app.test.js',
            'tests/stream-recovery.test.js',
            'tests/device-reconnect.test.js',
            'tests/subscriber-init.test.js',
            'tests/android-display-security.test.js',
            'tests/android-stream-lifecycle.test.js',
            'tests/scrcpy-lifecycle.test.js',
            'tests/frame-hub-contract.test.js',
            'tests/focus-parse.test.js',
        ],
        timeout: 300000,
    },
    {
        name: '插件装载',
        detail: '复刻 PluginManager 的 initialize 签名并真实调用工具',
        command: process.execPath,
        args: ['scripts/verify-plugin-load.cjs'],
        timeout: 120000,
    },
    {
        name: '侧栏集成',
        detail: '正常打开 / 未注入降级 / 缺省不触发 / 抛错容错',
        command: process.execPath,
        args: ['scripts/verify-sidepane-integration.cjs'],
        timeout: 120000,
    },
    {
        name: 'H.264 解码',
        detail: 'fixture 回放：Annex-B→AVCC 转换 / avcC 构造 / WebCodecs 出图',
        command: process.execPath,
        args: ['scripts/verify-h264-fixture.cjs'],
        timeout: 180000,
    },
    {
        name: '静止不空转',
        detail: 'fixture 回放：静止不重建解码器 / 恢复后继续出帧',
        command: process.execPath,
        args: ['scripts/verify-static-idle.cjs'],
        timeout: 180000,
    },
    {
        name: '断流恢复',
        detail: 'fixture 回放：断流不切 img / 真回退有帧 / 恢复重建解码器',
        command: process.execPath,
        args: ['scripts/verify-stream-recovery.cjs'],
        timeout: 180000,
    },
    {
        name: '端口漂移自愈',
        detail: '5977 被占时 Loom 清单自动指向真实地址',
        command: process.execPath,
        args: ['scripts/verify-loom-url-sync.cjs'],
        timeout: 120000,
    },
    {
        name: '页面视觉',
        detail: 'Edge 实际渲染 + 像素采样（无浏览器时自动跳过）',
        command: process.execPath,
        args: ['scripts/verify-android-viewer.cjs'],
        timeout: 200000,
    },
    {
        name: '连接向导',
        detail: '模拟真人点击：填地址 → 配对 → 连接 → 自动出画面',
        command: process.execPath,
        args: ['scripts/verify-viewer-wizard.cjs'],
        timeout: 200000,
    },
];

function run(step) {
    const started = Date.now();
    const result = spawnSync(step.command, step.args, {
        cwd: root,
        encoding: 'utf8',
        timeout: step.timeout,
        windowsHide: true,
    });
    const duration = Date.now() - started;

    if (result.error?.code === 'ETIMEDOUT') {
        return { ok: false, duration, note: `超时 ${step.timeout}ms`, output: result.stdout || '' };
    }
    if (result.error) {
        return { ok: false, duration, note: result.error.message, output: '' };
    }

    const output = `${result.stdout || ''}${result.stderr || ''}`;

    // verify-android-viewer 在找不到浏览器时以 0 退出并打印跳过提示
    const skipped = /跳过视觉验证/.test(output);
    return {
        ok: result.status === 0,
        skipped,
        duration,
        note: skipped ? '已跳过（无 Chromium 内核）' : '',
        output,
    };
}

function tail(output, lines = 3) {
    const rows = String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);
    return rows.slice(-lines);
}

function main() {
    console.log('AndroidController 全量离线验证');
    console.log('='.repeat(56));
    console.log('（真机相关项不在此列，见 scripts/live-android-check.cjs）\n');

    const results = [];
    for (const step of STEPS) {
        process.stdout.write(`▶ ${step.name} … `);
        const outcome = run(step);
        results.push({ step, outcome });
        const mark = outcome.skipped ? '跳过' : outcome.ok ? '通过' : '失败';
        console.log(`${mark} (${outcome.duration}ms)`);
        if (!outcome.ok && !outcome.skipped) {
            for (const line of tail(outcome.output, 8)) console.log(`    ${line}`);
            if (outcome.note) console.log(`    ${outcome.note}`);
        }
    }

    console.log(`\n${'='.repeat(56)}`);
    const failed = results.filter((r) => !r.outcome.ok);
    const skipped = results.filter((r) => r.outcome.skipped);
    const passed = results.length - failed.length - skipped.length;

    console.log(`通过 ${passed} / 跳过 ${skipped.length} / 失败 ${failed.length}`);
    if (failed.length) {
        console.log('\n失败项：');
        for (const { step } of failed) console.log(`  ✗ ${step.name}`);
    }
    console.log(`\n${failed.length === 0 ? '离线部分全部通过。' : '存在失败项，见上。'}`);

    // 顺带报告环境就绪度，方便判断下一步
    console.log('\n环境就绪度：');

    // 优先用 config.env 里的绝对路径；只靠 PATH 会因为宿主进程环境快照而误报
    const adbPath = resolveAdbPath();
    const adb = spawnSync(adbPath, ['version'], { encoding: 'utf8', timeout: 10000 });
    const adbOk = adb.status === 0;
    console.log(`  adb          ${adbOk ? `✓ ${String(adb.stdout).split('\n')[0]}` : `✗ 未找到（${adbPath}）`}`);

    if (adbOk) {
        const devices = spawnSync(adbPath, ['devices'], { encoding: 'utf8', timeout: 15000 });
        const rows = String(devices.stdout || '').split(/\r?\n/)
            .filter((line) => line.trim() && !/^List of devices/i.test(line.trim()));
        const ready = rows.filter((line) => /\bdevice\s*$/.test(line.trim()));
        const unauthorized = rows.filter((line) => /unauthorized/.test(line));
        console.log(`  设备         ${ready.length ? `✓ ${ready.length} 台已授权` : '✗ 无已授权设备'}`);
        if (unauthorized.length) console.log(`                ⚠ ${unauthorized.length} 台未授权（需在手机上点"允许 USB 调试"）`);
    }

    // 5977 的状态有三种，含义完全不同，不能一概说成「被占用」
    reportDisplayService();
}

/**
 * 读取 config.env 里的 ADB_PATH，回退到 PATH 中的 adb。
 */
function resolveAdbPath() {
    if (process.env.VCP_ADB_PATH) return process.env.VCP_ADB_PATH;
    try {
        const fs = require('fs');
        const dotenv = require('dotenv');
        const envPath = path.join(root, 'VCPDistributedServer/Plugin/AndroidController/config.env');
        const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
        if (parsed.ADB_PATH) return parsed.ADB_PATH;
    } catch { /* 忽略，走回退 */ }
    return 'adb';
}

/**
 * 探测显示屏服务。注意：5977 被占用可能是好事 —— 那说明插件已经在跑。
 */
function reportDisplayService() {
    const http = require('http');

    const probe = (port) => new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ reachable: true, body }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ reachable: false }); });
        req.on('error', () => resolve({ reachable: false }));
    });

    probe(5977).then((result) => {
        if (result.reachable && /"ok"\s*:\s*true/.test(result.body)) {
            console.log('  显示屏服务   ✓ 已在运行（http://127.0.0.1:5977）');
        } else {
            console.log('  显示屏服务   ✗ 未运行（重启 VCPChat 后插件会自动拉起）');
        }
    });
}

main();
