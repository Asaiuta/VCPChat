'use strict';

/**
 * 局域网 adb 设备扫描（不依赖 mDNS）。
 *
 * 为什么需要这个：mDNS 依赖 UDP 5353 组播，很容易被防火墙、
 * AP 隔离、或者 Steam/Bonjour 之类的进程抢端口搞挂。
 * 但 adb 的 TCP 端口是普通直连，防火墙对此宽松得多。
 *
 * 用法：
 *   node scripts/scan-lan.cjs              # 扫默认网段
 *   node scripts/scan-lan.cjs 192.168.1    # 指定前三段
 */

const net = require('net');
const os = require('os');

const COMMON_PORTS = [5555, 5037];
const TIMEOUT_MS = 350;
const CONCURRENCY = 128;

function probe(host, port, timeoutMs = TIMEOUT_MS) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (kind) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(kind);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish('OPEN'));
        socket.once('timeout', () => finish('TIMEOUT'));
        socket.once('error', () => finish('CLOSED'));
        socket.connect(port, host);
    });
}

async function mapLimit(items, limit, worker) {
    const results = [];
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = index++;
            results[current] = await worker(items[current], current);
        }
    });
    await Promise.all(runners);
    return results;
}

async function main() {
    const arg = process.argv[2];
    const prefixes = arg ? [arg] : detectPrefixes();

    console.log('局域网 adb 扫描\n');
    console.log(`网段: ${prefixes.map((p) => `${p}.0/24`).join(', ')}`);
    console.log(`端口: ${COMMON_PORTS.join(', ')}  (超时 ${TIMEOUT_MS}ms)\n`);

    const hosts = [];
    for (const prefix of prefixes) {
        for (let i = 1; i <= 254; i += 1) hosts.push(`${prefix}.${i}`);
    }
    console.log(`扫描 ${hosts.length} 个地址…`);

    const started = Date.now();
    let done = 0;

    const found = [];
    await mapLimit(hosts, CONCURRENCY, async (host) => {
        for (const port of COMMON_PORTS) {
            const state = await probe(host, port);
            if (state === 'OPEN') {
                found.push({ host, port });
                console.log(`  ✓ ${host}:${port} 开放`);
            }
        }
        done += 1;
        if (done % 64 === 0) process.stdout.write(`\r  进度 ${done}/${hosts.length}   `);
    });

    process.stdout.write('\r'.padEnd(30) + '\r');
    console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

    if (!found.length) {
        console.log('没有找到开放的 adb 端口。');
        console.log('\n可能原因：');
        console.log('  1. 手机「无线调试」没开，或已自动关闭（息屏一段时间会关）');
        console.log('  2. 手机连的不是这个网段（看手机 WLAN 详情里的 IP）');
        console.log('  3. 路由器开了 AP 隔离 / 访客网络');
        console.log('  4. Windows 防火墙拦截（当前网络类别为 Public 时默认阻止入站）');
        console.log('  5. 手机休眠了，WiFi 断电');
        return;
    }

    console.log('可用地址：');
    for (const item of found) {
        console.log(`  adb connect ${item.host}:${item.port}`);
    }
}

function detectPrefixes() {
    const prefixes = new Set();
    for (const list of Object.values(os.networkInterfaces() || {})) {
        for (const net_ of list || []) {
            if (net_.family !== 'IPv4' || net_.internal) continue;
            if (net_.address.startsWith('169.254.')) continue;
            prefixes.add(net_.address.split('.').slice(0, 3).join('.'));
        }
    }
    return [...prefixes];
}

main().catch((error) => {
    console.error('扫描失败：', error);
    process.exit(1);
});
