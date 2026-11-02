'use strict';

/**
 * 无线调试连接诊断。
 *
 * 不依赖 VCPChat 是否重启、也不需要打开界面 —— 直接在命令行跑，
 * 把「连不上」拆成具体原因。
 *
 * 用法：
 *   node scripts/diagnose-adb.cjs                 # 只看当前状态
 *   node scripts/diagnose-adb.cjs 192.168.1.20    # 探测指定手机
 */

const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const svc = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const ADB = 'D:\\AI\\tools\\platform-tools\\adb.exe';

function line(char = '─') { return console.log(char.repeat(58)); }
function ok(text) { console.log(`  ✓ ${text}`); }
function bad(text) { console.log(`  ✗ ${text}`); }
function info(text) { console.log(`  · ${text}`); }
function hint(text) { console.log(`    → ${text}`); }

async function main() {
    const target = process.argv[2];

    console.log('无线调试连接诊断\n');
    line('═');

    // --- 1) adb 本身 ---
    console.log('\n[1] adb 可执行文件');
    const ver = spawnSync(ADB, ['version'], { encoding: 'utf8', timeout: 10000 });
    if (ver.status === 0) {
        ok(String(ver.stdout).split('\n')[0]);
    } else {
        bad(`无法执行 ${ADB}`);
        hint('检查路径是否存在，或修改插件 config.env 的 ADB_PATH');
        return;
    }

    // --- 2) 本机地址 ---
    console.log('\n[2] 本机可用于手机连接的地址');
    const addrs = svc._internals.localAddresses();
    if (!addrs.length) {
        bad('没有找到可用的局域网地址');
        hint('电脑可能没连 WiFi/网线，或者只有虚拟网卡');
    } else {
        for (const item of addrs) console.log(`  ✓ ${item.address}  (${item.interface})`);
        const others = require('os').networkInterfaces();
        const excluded = [];
        for (const [name, list] of Object.entries(others)) {
            for (const entry of list || []) {
                if (entry.family === 'IPv4' && !entry.internal && !addrs.some((a) => a.address === entry.address)) {
                    excluded.push(`${entry.address} (${name})`);
                }
            }
        }
        if (excluded.length) info(`已忽略 ${excluded.length} 个虚拟/保留地址：${excluded.join('、')}`);
        hint(`手机和电脑要在同一网段。手机 IP 通常形如 ${addrs[0].address.split('.').slice(0, 3).join('.')}.xxx`);
    }

    // --- 3) 当前设备 ---
    console.log('\n[3] 当前已连接设备');
    const devices = spawnSync(ADB, ['devices', '-l'], { encoding: 'utf8', timeout: 15000 });
    const rows = String(devices.stdout || '').split(/\r?\n/)
        .filter((l) => l.trim() && !/^List of devices/i.test(l.trim()));
    if (!rows.length) {
        bad('没有任何设备');
        hint('如果手机已经配对过，需要执行 connect（界面上点「连接手机」）');
    } else {
        for (const row of rows) console.log(`  · ${row.trim()}`);
    }

    // --- 4) 指定目标探测 ---
    if (target) {
        const host = /:\d+$/.test(target) ? target.split(':')[0] : target;
        const port = /:\d+$/.test(target) ? Number(target.split(':')[1]) : 5555;

        console.log(`\n[4] 探测 ${host}:${port}`);

        // 先 ping 一下，判断网络层可达性
        const ping = spawnSync('ping', ['-n', '2', '-w', '1500', host], { encoding: 'utf8', timeout: 8000 });
        const pingOk = ping.status === 0 && !/100% loss|丢失 = 100%/.test(ping.stdout || '');
        if (pingOk) ok('网络层可达（能 ping 通）');
        else {
            bad('ping 不通');
            hint('手机可能休眠，或不在同一网络，或被防火墙拦了。部分手机默认不回 ping，继续看端口探测。');
        }

        // 端口探测
        const probe = await svc._internals.probePort(host, port, 3000);
        console.log(`\n[5] 端口探测 → ${probe.kind} (${probe.elapsedMs}ms)`);

        if (probe.kind === 'OPEN') {
            ok(`端口 ${port} 开放，手机上的 adb 在监听`);
            hint('网络没问题。如果 adb 仍连不上，就是配对失效 —— 重新走一遍配对。');
        } else if (probe.kind === 'ECONNREFUSED') {
            bad(`能找到手机，但 ${port} 端口没有监听`);
            hint('无线调试关了，或手机重启过。去「开发者选项 → 无线调试」重新打开。');
            hint('注意：5555 是连接端口，配对用的是另一个随机端口，别混淆。');
        } else {
            bad(`完全连不上（${probe.kind}）`);
            hint('网络层不通。优先核对手机实际 IP（设置 → WLAN → 当前网络详情）。');
            if (addrs[0]) hint(`电脑是 ${addrs[0].address}，手机要在同一网段。`);
        }

        // 如果探测通了，再看 adb 能不能连
        if (probe.kind === 'OPEN' && !rows.some((r) => r.includes(host))) {
            console.log('\n[6] 端口通但 adb 未连接，尝试 connect');
            const conn = spawnSync(ADB, ['connect', `${host}:${port}`], { encoding: 'utf8', timeout: 20000 });
            console.log(`  ${(conn.stdout || conn.stderr || '').trim()}`);
        }
    } else {
        console.log('\n[4] 指定手机 IP 可获得更精确的诊断：');
        console.log('  node scripts/diagnose-adb.cjs 192.168.1.20');
    }

    line('═');
    console.log(`\n本机地址汇总：${addrs.map((a) => a.address).join(' / ') || '无'}`);
}

main().catch((error) => {
    console.error('诊断失败：', error);
    process.exit(1);
});
