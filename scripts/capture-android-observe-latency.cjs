'use strict';
/**
 * Observe 延迟采样（真机）。
 *
 * 契约第 2 条原定 500 次；单次约 2.5s，满量需 20 分钟。这里按实际可跑的
 * 次数采样并在产物里写明 sampleCount —— 样本量不足时判定必须是 incomplete，
 * 不能因为 p95「看起来还行」就判 pass。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENTRY = path.resolve(__dirname,
    '../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
const ADB = 'D:\\AI\\tools\\platform-tools\\adb.exe';
const SERIAL = require('./lib/resolve-serial.cjs')
    .resolveSerial({ adbPath: ADB, execFileSync, envSerial: process.env.PERF_SERIAL });
const COUNT = Number(process.env.PERF_OBSERVE_COUNT || 60);
const OUT_DIR = process.argv[2];
if (!OUT_DIR) { console.error('usage: node capture-observe-latency.cjs <rawDir>'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(args) {
    try {
        return execFileSync(ADB, ['-s', SERIAL, ...args], {
            encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024,
        });
    } catch { return null; }
}

const nearestRank = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
    return sorted[Math.max(0, index)];
};

(async () => {
    const svc = require(ENTRY);
    await svc.initialize({
        config: { ADB_PATH: ADB, DEVICE_SERIAL: SERIAL, ADB_TIMEOUT_MS: '20000', DISPLAY_PORT: '0' },
        logger: { log() {}, warn() {}, error() {} },
    });

    const durations = [];
    const failures = [];
    const hostRss = [];
    const started = Date.now();

    for (let i = 0; i < COUNT; i += 1) {
        const at = Date.now();
        try {
            await svc.processToolCall({ command: 'Observe' }, {});
            durations.push(Date.now() - at);
        } catch (error) {
            failures.push({ index: i, code: error?.code || 'UNKNOWN', message: String(error?.message || '').slice(0, 200) });
        }
        if (i % 10 === 0) hostRss.push(Math.round(process.memoryUsage().rss / 1024));
    }

    const status = await svc.getRuntimeStatus();
    const result = {
        name: 'E-observe-latency',
        sampledAt: new Date().toISOString(),
        requestedCount: COUNT,
        sampleCount: durations.length,
        failureCount: failures.length,
        failures: failures.slice(0, 10),
        durationMs: Date.now() - started,
        // 原始逐次耗时。只存分位数会让「为什么 p95 突然变慢」无法归因，
        // 也无法把样本按清醒/息屏分档 —— 上一轮就是因此只能靠 adb 调用数反推。
        rawDurationsMs: durations,
        p50Ms: nearestRank(durations, 0.50),
        p95Ms: nearestRank(durations, 0.95),
        maxMs: durations.length ? Math.max(...durations) : null,
        minMs: durations.length ? Math.min(...durations) : null,
        meanMs: durations.length
            ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)) : null,
        hostRssKbSeries: hostRss,
        adbQueue: status.adbQueue,
        device: {
            memAvailableKb: (() => {
                const text = adb(['shell', 'cat', '/proc/meminfo']) || '';
                const hit = /MemAvailable:\s+(\d+)/.exec(text);
                return hit ? Number(hit[1]) : null;
            })(),
        },
    };

    fs.writeFileSync(path.join(OUT_DIR, 'observe-latency.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Observe ${result.sampleCount}/${COUNT} 成功，失败 ${result.failureCount}；`
        + `p50=${result.p50Ms}ms p95=${result.p95Ms}ms max=${result.maxMs}ms`);
    try { await svc.cleanup(); } catch { /* 忽略 */ }
    process.exit(0);
})().catch((error) => { console.error('FATAL', error.stack); process.exit(1); });
