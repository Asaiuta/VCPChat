'use strict';

/**
 * 全端口扫描指定主机，找出 adb 无线调试监听端口。
 *
 * 背景：Android 11+ 的「无线调试」不使用固定的 5555 端口，
 * 而是每次开启动时随机分配（常见 30000-50000，但不保证）。
 * mDNS 是官方发现方式，但依赖 UDP 5353 组播，容易被防火墙或端口占用搞挂。
 * 直接扫 TCP 端口是更可靠的后路。
 *
 * 用法：node scripts/scan-ports.cjs 192.168.137.178
 *      node scripts/scan-ports.cjs 192.168.137.178 30000-50000
 */

const net = require('net');

const CONCURRENCY = 512;
const TIMEOUT_MS = 180;

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
        socket.once('error', (error) => finish(error.code || 'ERROR'));
        socket.connect(port, host);
    });
}

async function mapLimit(items, limit, worker) {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            await worker(items[index++]);
        }
    });
    await Promise.all(runners);
}

function parseRange(text) {
    if (!text) return { from: 1, to: 65535 };
    const match = /^(\d+)-(\d+)$/.exec(text);
    if (!match) throw new Error('范围格式应为 30000-50000');
    return { from: Number(match[1]), to: Number(match[2]) };
}

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('用法: node scripts/scan-ports.cjs <IP> [起始-结束]');
        process.exit(1);
    }
    const { from, to } = parseRange(process.argv[3]);
    const total = to - from + 1;

    console.log(`扫描 ${host} 端口 ${from}-${to}（共 ${total} 个）\n`);

    const started = Date.now();
    const open = [];
    let done = 0;

    await mapLimit(Array.from({ length: total }, (_, i) => from + i), CONCURRENCY, async (port) => {
        const state = await probe(host, port);
        if (state === 'OPEN') {
            open.push(port);
            process.stdout.write(`\r  ✓ ${host}:${port}                \n`);
        }
        done += 1;
        if (done % 2048 === 0) {
            process.stdout.write(`\r  进度 ${done}/${total} (${((Date.now() - started) / 1000).toFixed(1)}s)   `);
        }
    });

    process.stdout.write('\r'.padEnd(50) + '\r');
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`完成，耗时 ${elapsed}s\n`);

    if (!open.length) {
        console.log('没有发现开放端口。');
        console.log('\n可能原因：');
        console.log('  · 手机上的「无线调试」已经自动关闭（息屏会关）');
        console.log('  · 手机防火墙拦截了入站');
        console.log('  · 这个 IP 不是手机');
        console.log('\n最可靠的做法：手机「无线调试」页面会直接显示「IP 地址和端口」，照抄那个。');
        return;
    }

    console.log('开放端口：');
    for (const port of open) console.log(`  ${host}:${port}`);
    console.log('\n尝试连接：');
    for (const port of open) console.log(`  adb connect ${host}:${port}`);
}

main().catch((error) => {
    console.error('扫描失败：', error.message);
    process.exit(1);
});
