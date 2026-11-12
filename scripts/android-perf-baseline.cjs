'use strict';

/**
 * Android 控制器性能/内存基线入口。
 *
 *   node scripts/android-perf-baseline.cjs --update   从 raw 采集产物生成本机基线
 *   node scripts/android-perf-baseline.cjs --check    用现有基线判定当前结果
 *   node scripts/android-perf-baseline.cjs --list     列出已有基线
 *
 * 没有基线时 --check 必须输出 no_baseline 且退出码非零。绝不内置默认阈值。
 *
 * 基线文件路径：artifacts/android-baseline/<fingerprint>.json
 * 指纹由主机 + 设备 + adb + node 版本构成，换机器/换 ROM 就是新文件，
 * 禁止原地改阈值把红改绿。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
    buildFingerprint, loadBaseline, saveBaseline, compare, formatCheck,
} = require('../VCPDistributedServer/Plugin/AndroidController/lib/perf-baseline');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_DIR = path.join(ROOT, 'artifacts', 'android-baseline');
const RAW_ROOT = path.join(ROOT, 'artifacts', 'android-perf-raw');
const ADB = process.env.ADB_PATH || 'D:\\AI\\tools\\platform-tools\\adb.exe';
// 设备序列号按需解析：不再回退到某次热点会话的历史地址（那会让所有 adb 调用静默落空）。
// 延迟到真正需要时才查，`--update` / `--check` 在读已落地产物时不必强制有设备在线。
const { tryResolveSerial } = require('./lib/resolve-serial.cjs');
let serialCache;
function serial() {
    if (serialCache === undefined) {
        serialCache = tryResolveSerial({ adbPath: ADB, execFileSync, envSerial: process.env.PERF_SERIAL });
    }
    return serialCache;
}

// ---------------------------------------------------------------- 采集

function tryAdb(args) {
    // 先取选择器再拼命令：`-s` 里的 serial() 若为空，直接省掉这段而不是传 "null"。
    const device = serial();
    const selector = device ? ['-s', device] : [];
    try {
        return execFileSync(ADB, [...selector, ...args], {
            encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024,
        }).trim();
    } catch { return null; }
}

function hostTag() {
    const host = require('node:os').hostname().toLowerCase().replace(/[^a-z0-9]/g, '');
    return host || 'unknownhost';
}

/**
 * 采集设备身份。设备不在线时返回 null —— 此时 --update 会拒绝写入，
 * 而不是编一个「未知设备」的基线文件出来。
 */
function readDeviceIdentity() {
    // 序列号解析不到 = 设备身份不可确定，直接返回 null 让 --update 拒绝写入，
    // 不编一个「未知设备」的基线文件，也不回退到任何历史地址。
    const device = serial();
    if (!device) return null;
    const probe = tryAdb(['shell', 'getprop', 'ro.product.model']);
    if (!probe) return null;
    return {
        adbVersion: (() => {
            try {
                const text = execFileSync(ADB, ['version'], { encoding: 'utf8', timeout: 10000 });
                return (/version (\d+\.\d+\.\d+)/.exec(text) || [])[1] || null;
            } catch { return null; }
        })(),        manufacturer: tryAdb(['shell', 'getprop', 'ro.product.manufacturer']),
        model: probe,
        androidRelease: tryAdb(['shell', 'getprop', 'ro.build.version.release']),
        sdk: tryAdb(['shell', 'getprop', 'ro.build.version.sdk']),
        // 序列号只留主机段，端口与完整地址不入指纹
        serialTag: device.replace(/:\d+$/, ''),
    };
}

/** 从已落地的 raw 产物读取，避免每次都要求真机在线。 */
function readRawProbe() {
    const versionPath = path.join(RAW_ROOT, 'version.json');
    if (fs.existsSync(versionPath)) {
        try { return JSON.parse(fs.readFileSync(versionPath, 'utf8')); } catch { /* 继续找 */ }
    }
    const dirs = fs.existsSync(RAW_ROOT)
        ? fs.readdirSync(RAW_ROOT).map((name) => path.join(RAW_ROOT, name))
            .filter((dir) => fs.existsSync(path.join(dir, 'version.json')))
            .sort()
        : [];
    if (!dirs.length) return null;
    try { return JSON.parse(fs.readFileSync(path.join(dirs.at(-1), 'version.json'), 'utf8')); } catch { return null; }
}

/**
 * adb 版本归一化。
 *
 * 早期采集脚本把 `adb version` 整行写进了 version.json，直接拿去建指纹会
 * 得到 `android.debug.bridge.version.1.0.41` 这种把产品名混进版本段的结果，
 * 既超长又易变。这里统一抽出 1.0.41 形态的版本号；已经是版本号的原样返回。
 */
function sanitizeAdbVersion(value) {
    if (!value) return null;
    const text = String(value);
    const hit = /(\d+\.\d+\.\d+)/.exec(text);
    return hit ? hit[1] : null;
}

function resolveIdentity() {
    const live = readDeviceIdentity();
    if (live) return live;
    const raw = readRawProbe();
    if (!raw?.device) return null;
    return {
        adbVersion: sanitizeAdbVersion(raw.adbVersion),
        manufacturer: raw.device.manufacturer,
        model: raw.device.model,
        androidRelease: raw.device.androidRelease,
        sdk: raw.device.sdk,
        serialTag: raw.device.serialTag,
    };
}

function fingerprintFor(identity) {
    return buildFingerprint({
        hostTag: hostTag(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        adbVersion: identity.adbVersion,
        manufacturer: identity.manufacturer,
        model: identity.model,
        androidRelease: identity.androidRelease,
        sdk: identity.sdk,
        serialTag: identity.serialTag,
    });
}

// ---------------------------------------------------------------- 归一化

/**
 * 把 raw cases 归约成判定用的扁平指标。
 *
 * 吞吐一律用「整段帧数 ÷ 整段秒数」的累计口径，不用 hub 的滑动窗口
 * effectiveFps —— 后者会把「画面静止不出帧」读成帧率翻倍。
 */
function normalize(cases, observe) {
    const byName = Object.fromEntries(cases.map((item) => [item.name, item]));
    const single = byName['A-single-h264-60s'];
    const three = byName['B-three-viewers-90s'];
    const recovery = byName['D-recovery-x3'];
    const cleanup = byName['C-stop-display-cleanup'];

    const recoveryTimes = (recovery?.recoveries || [])
        .map((entry) => entry.killToFirstFrameMs)
        .filter((value) => Number.isFinite(value));

    const viewerFrames = (three?.viewers || []).map((viewer) => viewer.frames);
    const hostSamples = readJsonl(path.join(RAW_ROOT, latestRawDir(), 'host-samples.jsonl'));
    const rssSeries = hostSamples.map((sample) => sample.rssKb).filter(Number.isFinite);

    return {
        capturedAt: new Date().toISOString(),
        throughput: {
            singleCumulativeFps: single?.cumulativeFps ?? null,
            singleWsFrames: single?.wsFrames ?? null,
            singleWsBytes: single?.wsBytes ?? null,
            threeViewerMinFrames: viewerFrames.length ? Math.min(...viewerFrames) : null,
            threeViewerMaxFrames: viewerFrames.length ? Math.max(...viewerFrames) : null,
            threeViewerSpread: viewerFrames.length
                ? Number((Math.max(...viewerFrames) - Math.min(...viewerFrames)).toFixed(2)) : null,
        },
        backpressure: {
            jpegDropped: single?.display?.jpegDroppedByBackpressure ?? null,
            textDropped: single?.display?.textDroppedByBackpressure ?? null,
            slowSubscribersClosed: single?.display?.slowSubscribersClosed ?? null,
        },
        recovery: {
            sampleCount: recoveryTimes.length,
            maxMs: recoveryTimes.length ? Math.max(...recoveryTimes) : null,
            meanMs: recoveryTimes.length
                ? Number((recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length).toFixed(1)) : null,
        },
        cleanup: {
            rssDeltaKb: Number.isFinite(cleanup?.rssAfterKb) && Number.isFinite(cleanup?.rssBeforeKb)
                ? cleanup.rssAfterKb - cleanup.rssBeforeKb : null,
            scrcpyState: cleanup?.scrcpyState ?? null,
            scrcpySubscribers: cleanup?.scrcpySubscribers ?? null,
            deviceResidual: cleanup?.deviceScrcpyResidual ?? null,
            // compare() 只接受有限数，布尔会落成 missing。残留与否数值化：0=干净 1=有残留。
            // 契约本身不变（布尔设备残留仍原样保留在上面供人读），这里只给判定层一个可比的数。
            deviceResidualFlag: typeof cleanup?.deviceScrcpyResidual === 'boolean'
                ? Number(cleanup.deviceScrcpyResidual) : null,
        },
        latency: {
            sampleCount: observe?.sampleCount ?? 0,
            failureCount: observe?.failureCount ?? null,
            p50Ms: observe?.p50Ms ?? null,
            p95Ms: observe?.p95Ms ?? null,
            maxMs: observe?.maxMs ?? null,
        },
        queue: {
            peakDepth: observe?.adbQueue?.peakDepth ?? null,
            rejectedQueueFull: observe?.adbQueue?.rejected?.ADB_QUEUE_FULL ?? null,
            failed: observe?.adbQueue?.failed ?? null,
        },
        host: {
            rssMinKb: rssSeries.length ? Math.min(...rssSeries) : null,
            rssMaxKb: rssSeries.length ? Math.max(...rssSeries) : null,
            sampleCount: rssSeries.length,
        },
        soak: {
            // 未采集时长由构造决定：这里恒 null，判定层会把它压成 incomplete。
            rssSlopeKbPerMin: null,
            durationMin: null,
        },
    };
}

function latestRawDir() {
    if (!fs.existsSync(RAW_ROOT)) return null;
    const dirs = fs.readdirSync(RAW_ROOT)
        .filter((name) => fs.existsSync(path.join(RAW_ROOT, name, 'cases.json')))
        .sort();
    return dirs.at(-1) || null;
}

function readJsonl(file) {
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

// ---------------------------------------------------------------- 判定规则

/**
 * 规则只描述「当前实测相对基线的允许比例」，不描述绝对值。
 * soak 的 when 谓词恒 false 当基线未采集时长 —— 于是判 incomplete 而不是 pass。
 */
const RULES = [
    { name: '单订阅累计吞吐不低于基线 80%', path: 'throughput.singleCumulativeFps', op: 'gteFactor', factor: 0.8 },
    { name: '三订阅最小帧数不低于基线 80%', path: 'throughput.threeViewerMinFrames', op: 'gteFactor', factor: 0.8 },
    { name: 'Observe p95 不超过基线 1.2 倍', path: 'latency.p95Ms', op: 'lteFactor', factor: 1.2 },
    { name: 'Observe 失败数为 0', path: 'latency.failureCount', op: 'eq', value: 0 },
    { name: 'adb 队列零满拒', path: 'queue.rejectedQueueFull', op: 'eq', value: 0 },
    // 1.3 倍而不是 1.5 倍：旧实现的 1800ms 盲等恢复耗时实测 2926ms，
    // 而优化后基线 2109ms × 1.5 = 3163ms —— 装不下，等于守不住。
    // 2109 × 1.3 = 2742ms，正常波动（实测 1483–2109）远低于此，
    // 但把固定睡眠加回来就会越线。静态规则（禁止 >600ms 匿名睡眠）
    // 是第一道锁，这条是第二道。
    { name: '断流恢复不慢于基线 1.3 倍', path: 'recovery.maxMs', op: 'lteFactor', factor: 1.3 },
    { name: 'StopDisplay 后 RSS 回落到基线 +20MB 内', path: 'cleanup.rssDeltaKb', op: 'ltePlus', delta: 20 * 1024 },
    { name: 'StopDisplay 后设备端无 scrcpy 残留', path: 'cleanup.deviceResidualFlag', op: 'eq', value: 0 },
    { name: '背压丢帧为零', path: 'backpressure.jpegDropped', op: 'eq', value: 0 },
    // soak 未采集时基线与样本都是 null -> missing -> incomplete。
    // 这一条的存在就是为了让「没跑长时稳定性」不能算通过。
    { name: '长时 soak RSS 斜率不超基线（未采集则 incomplete）', path: 'soak.rssSlopeKbPerMin', op: 'ltePlus', delta: 0 },
];

// ---------------------------------------------------------------- CLI

function cmdUpdate() {
    const identity = resolveIdentity();
    if (!identity) {
        console.error('拒绝写入基线：设备不在线且没有可用的 raw version.json。');
        console.error('基线必须绑定真实设备身份，不能凭空生成。');
        return 2;
    }
    const rawDir = latestRawDir();
    if (!rawDir) { console.error('拒绝写入基线：artifacts/android-perf-raw 下没有 cases.json。'); return 2; }

    const dir = path.join(RAW_ROOT, rawDir);
    const cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
    const observePath = path.join(dir, 'observe-latency.json');
    const observe = fs.existsSync(observePath)
        ? JSON.parse(fs.readFileSync(observePath, 'utf8')) : null;

    const fingerprint = fingerprintFor(identity);
    const payload = {
        fingerprint: fingerprint.key,
        resolvedAt: new Date().toISOString(),
        source: { rawDir, device: identity, host: { node: process.version, platform: process.platform, arch: process.arch } },
        cases: normalize(cases, observe),
    };

    const written = saveBaseline(BASELINE_DIR, fingerprint.key, payload);
    console.log(`已写入基线：${path.relative(ROOT, written.path)}`);
    console.log(JSON.stringify(payload.cases, null, 2));
    return 0;
}

function cmdCheck() {
    const identity = resolveIdentity();
    if (!identity) { console.error('无法确定设备身份，判定为 no_baseline。'); return 1; }
    const key = fingerprintFor(identity).key;
    const loaded = loadBaseline(BASELINE_DIR, key);
    if (!loaded.ok) {
        console.error(`没有可用基线（${loaded.reason}）：${key}`);
        console.error('这是 no_baseline，不是通过。先跑 --update 采集基线。');
        return 1;
    }

    const rawDir = latestRawDir();
    if (!rawDir) { console.error('没有 raw 产物可比对。'); return 1; }
    const dir = path.join(RAW_ROOT, rawDir);
    const cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
    const observePath = path.join(dir, 'observe-latency.json');
    const observe = fs.existsSync(observePath) ? JSON.parse(fs.readFileSync(observePath, 'utf8')) : null;
    const sample = normalize(cases, observe);

    const result = compare(sample, loaded.baseline.cases, RULES);
    for (const check of result.checks) console.log(formatCheck(check));
    console.log(`\n判定：${result.verdict}`);
    if (result.verdict !== 'pass') return 1;
    return 0;
}

function cmdList() {
    if (!fs.existsSync(BASELINE_DIR)) { console.log('（暂无基线目录）'); return 0; }
    const files = fs.readdirSync(BASELINE_DIR).filter((name) => name.endsWith('.json'));
    if (!files.length) { console.log('（暂无基线）'); return 0; }
    for (const name of files) {
        let meta = '';
        try {
            const data = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, name), 'utf8'));
            meta = `${data.source?.device?.model || '?'} / Android ${data.source?.device?.androidRelease || '?'}`;
        } catch { meta = '（损坏）'; }
        console.log(`${name}  ${meta}`);
    }
    return 0;
}

const arg = process.argv[2] || '--check';
const code = arg === '--update' ? cmdUpdate()
    : arg === '--list' ? cmdList()
        : arg === '--check' ? cmdCheck()
            : (console.error('用法：--update | --check | --list'), 2);
process.exit(code);
