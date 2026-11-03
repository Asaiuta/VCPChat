'use strict';
/**
 * 真机性能基线采集（一次性，raw 落地）。
 *
 * 覆盖撤线后无法复现的四类数据：
 *   A 单订阅 H.264 持续吞吐 + 主机/设备端随采曲线
 *   B 三订阅并发背压
 *   C StopDisplay 后资源归零
 *   D 编码器被杀后的断流恢复耗时
 *
 * 输出 artifacts/android-perf-raw/<timestamp>/{cases.json,host-samples.jsonl,device-samples.jsonl}
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const WebSocket = require(path.resolve(__dirname, '../node_modules/ws'));

const ENTRY = path.resolve(__dirname,
    '../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
const ADB = 'D:\\AI\\tools\\platform-tools\\adb.exe';
const SERIAL = require('./lib/resolve-serial.cjs')
    .resolveSerial({ adbPath: ADB, execFileSync, envSerial: process.env.PERF_SERIAL });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(__dirname, `../artifacts/android-perf-raw/${STAMP}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let svc = null;
const hostSamples = [];
const deviceSamples = [];
const cases = [];

function record(list, entry) {
    list.push(entry);
    fs.appendFileSync(path.join(OUT, `${list === hostSamples ? 'host' : 'device'}-samples.jsonl`),
        `${JSON.stringify(entry)}\n`);
}

/** 不经插件的独立 adb 调用，避免污染被测队列。 */
function adb(args) {
    try {
        return execFileSync(ADB, ['-s', SERIAL, ...args], {
            encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024,
        });
    } catch (error) {
        return null;
    }
}

function hostSample(tag) {
    const mem = process.memoryUsage();
    let status = null;
    try { status = svc.getRuntimeStatus(); } catch { /* 未初始化 */ }
    return {
        at: Date.now(), tag,
        rssKb: Math.round(mem.rss / 1024),
        heapUsedKb: Math.round(mem.heapUsed / 1024),
        externalKb: Math.round(mem.external / 1024),
        arrayBuffersKb: Math.round(mem.arrayBuffers / 1024),
        scrcpy: status?.scrcpy ? {
            state: status.scrcpy.state, fps: status.scrcpy.effectiveFps,
            packets: status.scrcpy.packetsReceived, bytes: status.scrcpy.bytesReceived,
            subscribers: status.scrcpy.subscribers,
        } : null,
        display: status?.display || null,
        adbQueue: status?.adbQueue || null,
        frame: status?.frame ? {
            streaming: status.frame.streaming, subscribers: status.frame.subscribers,
            fallbackCount: status.frame.fallbackCount,
            consecutiveFailures: status.frame.consecutiveFailures,
        } : null,
    };
}

function deviceSample(tag) {
    const raw = adb(['shell', 'echo @@STAT; cat /proc/stat; echo @@MEM; cat /proc/meminfo; echo @@BATT; dumpsys battery;'
        + ' echo @@PS; ps -A -o PID,PPID,NAME,RSS; echo @@THERM; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null; echo @@END']);
    if (!raw) return null;
    const section = (name, next) => {
        const start = raw.indexOf(`@@${name}`);
        if (start < 0) return null;
        const from = raw.indexOf('\n', start) + 1;
        const end = next ? raw.indexOf(`@@${next}`) : raw.length;
        return raw.slice(from, end < 0 ? raw.length : end);
    };
    const statText = section('STAT', 'MEM');
    const battText = section('BATT', 'PS');
    const psText = section('PS', 'THERM');
    const thermText = section('THERM', 'END');
    const parse = (re, text) => { const hit = new RegExp(re).exec(text || ''); return hit ? Number(hit[1]) : null; };

    let total = null; let busy = null;
    if (statText) {
        const line = /^cpu\s+(.+)$/m.exec(statText);
        if (line) {
            const cols = line[1].trim().split(/\s+/).map(Number).slice(0, 8);
            total = cols.reduce((a, b) => a + b, 0);
            busy = total - cols[3] - cols[4];
        }
    }
    const mem = section('MEM', 'BATT');
    let scrcpyRssKb = null;
    let scrcpyPid = null;
    if (psText) {
        const hit = /^\s*(\d+)\s+\d+\s+(\S*(?:scrcpy|app_process)\S*)\s+(\d+)\s*$/im.exec(psText);
        if (hit) { scrcpyPid = Number(hit[1]); scrcpyRssKb = Number(hit[3]); }
    }
    return {
        at: Date.now(), tag,
        cpuTotalTicks: total, cpuBusyTicks: busy,
        memAvailableKb: parse('MemAvailable:\\s+(\\d+)', mem),
        memFreeKb: parse('MemFree:\\s+(\\d+)', mem),
        batteryLevel: parse('\\blevel:\\s+(\\d+)', battText),
        batteryTempC: (() => { const v = parse('\\btemperature:\\s+(\\d+)', battText); return v === null ? null : v / 10; })(),
        chargeCounterUah: parse('Charge counter:\\s+(\\d+)', battText),
        // 充电时 Charge counter 会停在满值不动（实测 4422000 连续 222 秒不变），
        // 不记这个标志就会把「差值为 0」误读成「零耗电」。
        acPowered: /AC powered:\s*true/i.test(battText || ''),
        usbPowered: /USB powered:\s*true/i.test(battText || ''),
        scrrenThermalC: (() => { const v = Number((thermText || '').trim()); return Number.isFinite(v) ? v / 1000 : null; })(),
        scrcpyPid, scrcpyRssKb,
    };
}

function get(url, headers) {
    return new Promise((resolve) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers,
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', (error) => resolve({ status: 'ERR', headers: {}, body: error.message }));
        req.setTimeout(5000, () => req.destroy());
        req.end();
    });
}

async function openViewer(url) {
    const origin = new URL(url).origin;
    const page = await get(`${url}/`, {
        Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate',
    });
    const cookie = ([].concat(page.headers['set-cookie'] || [])[0] || '').split(';')[0];
    if (!cookie) throw new Error('viewer cookie 获取失败');
    const ws = new WebSocket(`${url.replace('http', 'ws')}/stream`, { headers: { Origin: origin, Cookie: cookie } });
    const accounting = { frames: 0, bytes: 0, closed: null, closeCode: null, firstFrameAt: null };
    ws.on('message', (data, binary) => {
        if (!binary) return;
        if (accounting.firstFrameAt === null) accounting.firstFrameAt = Date.now();
        accounting.frames += 1;
        accounting.bytes += data.length;
    });
    ws.on('close', (code) => { accounting.closed = Date.now(); accounting.closeCode = code; });
    ws.on('error', () => {});
    return { ws, accounting, origin, cookie };
}

/** 保持一个采样节拍：主机 + 设备端同步采。 */
function startSampler(tag, intervalMs) {
    let stopped = false;
    let ticks = 0;
    const loop = async () => {
        while (!stopped) {
            record(hostSamples, hostSample(tag));
            ticks += 1;
            if (ticks % 2 === 1) {
                const sample = deviceSample(tag);
                if (sample) record(deviceSamples, sample);
            }
            await sleep(intervalMs);
        }
    };
    const done = loop();
    return { stop: async () => { stopped = true; await done; } };
}

async function waitStreaming(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await svc.getRuntimeStatus();
        if (status.scrcpy?.state === 'streaming') return status;
        await sleep(250);
    }
    return svc.getRuntimeStatus();
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'host-samples.jsonl'), '');
    fs.writeFileSync(path.join(OUT, 'device-samples.jsonl'), '');

    const version = {
        capturedAt: new Date().toISOString(),
        adbVersion: (() => {
            const text = adb(['version']) || '';
            const hit = /version (\d+\.\d+\.\d+)/.exec(text);
            return hit ? hit[1] : null;
        })(),
        device: {
            serialTag: SERIAL.replace(/:\d+$/, ''),
            model: (adb(['shell', 'getprop', 'ro.product.model']) || '').trim(),
            manufacturer: (adb(['shell', 'getprop', 'ro.product.manufacturer']) || '').trim(),
            androidRelease: (adb(['shell', 'getprop', 'ro.build.version.release']) || '').trim(),
            sdk: (adb(['shell', 'getprop', 'ro.build.version.sdk']) || '').trim(),
        },
        host: { platform: process.platform, arch: process.arch, node: process.version },
    };
    fs.writeFileSync(path.join(OUT, 'version.json'), `${JSON.stringify(version, null, 2)}\n`);
    console.log(`== ${OUT} ==`);

    svc = require(ENTRY);
    await svc.initialize({
        config: { ADB_PATH: ADB, DEVICE_SERIAL: SERIAL, ADB_TIMEOUT_MS: '20000', DISPLAY_PORT: '0' },
        logger: { log() {}, warn() {}, error() {} },
    });

    // ---------------- A: 单订阅 H.264 60s ----------------
    console.log('== A 单订阅 H.264 60s ==');
    const started = await svc.processToolCall({ command: 'Manage', operation: 'startDisplay' }, {});
    const url = started.details.url;
    const viewer = await openViewer(url);
    const streaming = await waitStreaming();
    console.log(`  streaming=${streaming.scrcpy?.state} fps=${streaming.scrcpy?.effectiveFps}`);

    const samplerA = startSampler('A-single-60s', 5000);
    const aStart = Date.now();
    const aBase = { frames: viewer.accounting.frames, bytes: viewer.accounting.bytes };
    await sleep(60000);
    await samplerA.stop();
    const aStatus = await svc.getRuntimeStatus();
    cases.push({
        name: 'A-single-h264-60s',
        durationMs: Date.now() - aStart,
        wsFrames: viewer.accounting.frames - aBase.frames,
        wsBytes: viewer.accounting.bytes - aBase.bytes,
        wsSeconds: (Date.now() - aStart) / 1000,
        effectiveFps: aStatus.scrcpy?.effectiveFps ?? null,
        packetsReceived: aStatus.scrcpy?.packetsReceived ?? null,
        bytesReceived: aStatus.scrcpy?.bytesReceived ?? null,
        display: aStatus.display,
        resolution: { width: aStatus.scrcpy?.width, height: aStatus.scrcpy?.height },
        // 窗口累计吞吐：整段帧数 / 整段秒数，不是 60 包滑动窗口的瞬时值
        cumulativeFps: Number(((viewer.accounting.frames - aBase.frames)
            / ((Date.now() - aStart) / 1000)).toFixed(2)),
    });
    console.log(`  cumulative=${cases.at(-1).cumulativeFps} fps, ws=${cases.at(-1).wsFrames} 帧`);

    // ---------------- B: 三订阅并发 90s ----------------
    console.log('== B 三订阅并发 90s ==');
    const extra = [await openViewer(url), await openViewer(url)];
    await waitStreaming(8000);
    const samplerB = startSampler('B-three-90s', 5000);
    const bStart = Date.now();
    const bBase = [viewer, ...extra].map((v) => ({ frames: v.accounting.frames, bytes: v.accounting.bytes }));
    await sleep(90000);
    await samplerB.stop();
    const bStatus = await svc.getRuntimeStatus();
    cases.push({
        name: 'B-three-viewers-90s',
        durationMs: Date.now() - bStart,
        viewers: [viewer, ...extra].map((v, index) => ({
            index,
            frames: v.accounting.frames - bBase[index].frames,
            bytes: v.accounting.bytes - bBase[index].bytes,
            closeCode: v.accounting.closeCode,
        })),
        display: bStatus.display,
        scrcpySubscribers: bStatus.scrcpy?.subscribers ?? null,
    });
    console.log(`  viewers=${JSON.stringify(cases.at(-1).viewers.map((v) => v.frames))}`);
    extra.forEach((v) => { try { v.ws.close(); } catch { /* 已关 */ } });
    await sleep(1500);

    // ---------------- D: 断流恢复 x3（先于 C，需要观众存活）----------------
    console.log('== D 断流恢复 x3 ==');
    const recoveries = [];
    for (let i = 0; i < 3; i += 1) {
        const pid = /^\s*(\d+)\s+\d+\s+\S*(?:scrcpy|app_process)/im.exec(
            adb(['shell', 'ps', '-A', '-o', 'PID,PPID,NAME,RSS']) || '');
        if (!pid) { recoveries.push({ index: i, error: 'no scrcpy pid' }); break; }
        const killAt = Date.now();
        const before = viewer.accounting.frames;
        adb(['shell', 'kill', '-9', pid[1]]);
        let recoveredAt = null;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            const status = await svc.getRuntimeStatus();
            if (status.scrcpy?.state === 'streaming' && viewer.accounting.frames > before) {
                recoveredAt = Date.now();
                break;
            }
            await sleep(200);
        }
        const after = await svc.getRuntimeStatus();
        recoveries.push({
            index: i,
            killToFirstFrameMs: recoveredAt ? recoveredAt - killAt : null,
            timedOut: recoveredAt === null,
            stateAfter: after.scrcpy?.state ?? null,
            failures: after.display?.consecutiveFailures ?? null,
            recoveryAttempts: after.display?.recoveryAttempts ?? null,
            closeCode: viewer.accounting.closeCode,
        });
        console.log(`  #${i} 恢复 ${recoveries.at(-1).killToFirstFrameMs}ms`);
        await sleep(2000);
    }
    cases.push({ name: 'D-recovery-x3', recoveries });

    // ---------------- C: StopDisplay 后归零 ----------------
    console.log('== C StopDisplay 归零 ==');
    try { viewer.ws.close(); } catch { /* 已关 */ }
    await sleep(1000);
    const beforeStop = hostSample('C-before-stop');
    record(hostSamples, beforeStop);
    try { await svc.processToolCall({ command: 'Manage', operation: 'stopDisplay' }, {}); } catch { /* 已停 */ }
    const stopAt = Date.now();
    const samplerC = startSampler('C-after-stop-60s', 5000);
    await sleep(60000);
    await samplerC.stop();
    const afterStop = await svc.getRuntimeStatus();
    const psAfter = adb(['shell', 'ps', '-A', '-o', 'PID,PPID,NAME,RSS']) || '';
    cases.push({
        name: 'C-stop-display-cleanup',
        durationMs: Date.now() - stopAt,
        rssBeforeKb: beforeStop.rssKb,
        rssAfterKb: hostSample('C-final').rssKb,
        scrcpyState: afterStop.scrcpy?.state ?? null,
        scrcpySubscribers: afterStop.scrcpy?.subscribers ?? null,
        displayUrl: afterStop.displayUrl,
        display: afterStop.display,
        frameSubscribers: afterStop.frame?.subscribers ?? null,
        adbQueue: afterStop.adbQueue,
        deviceScrcpyResidual: /(?:scrcpy|app_process)/i.test(psAfter),
        deviceResidualLine: (/^.*(?:scrcpy|app_process).*$/im.exec(psAfter) || ['(none)'])[0].trim(),
    });
    console.log(`  residual=${cases.at(-1).deviceScrcpyResidual} rss ${beforeStop.rssKb} → ${cases.at(-1).rssAfterKb} KB`);

    fs.writeFileSync(path.join(OUT, 'cases.json'), `${JSON.stringify(cases, null, 2)}\n`);
    try { await svc.cleanup(); } catch { /* 忽略 */ }
    console.log('== done ==');
    process.exit(0);
})().catch((error) => {
    console.error('FATAL', error.stack);
    try { fs.writeFileSync(path.join(OUT, 'error.txt'), `${error.stack}\n`); } catch { /* 忽略 */ }
    process.exit(1);
});
