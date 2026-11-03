'use strict';

/**
 * Android 控制器性能基线 —— 真机数据面 golden 测试。
 *
 * 数据来源：PJZ110（Android 17 / API 37）真机落盘样本。
 * - tests/fixtures/android-device/            单条 adb 命令的原始输出（离线可复现）
 * - artifacts/android-perf-raw/<会话>/        一次真实采集会话的产物（只读，测试不得写入）
 *
 * 这些 fixture 是"撤线后无法复现"的证据，本文件只做一件事：把解析口径钉死。
 * 任何一条断言变红，先判断是解析口径被改了（[口径] 前缀）还是 fixture 被换了（[fixture] 前缀）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    splitSections,
    parseSample,
    parseProcStat,
    cpuDelta,
    parseBattery,
    parseThermalMilliC,
    parsePs,
    selectProcesses,
} = require('../VCPDistributedServer/Plugin/AndroidController/lib/device-metrics.js');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'android-device');
const SESSION_DIR = path.join(ROOT, 'artifacts', 'android-perf-raw', '2026-11-02T09-19-27-391Z');

/** 读取真机 fixture 原文；缺失时直接点名文件，便于区分"样本被删"与"解析坏了"。 */
function readFixture(name) {
    const file = path.join(FIXTURE_DIR, name);
    if (!fs.existsSync(file)) throw new Error(`[fixture] 真机样本缺失：${file}`);
    return fs.readFileSync(file, 'utf8');
}

/** 读取会话产物 JSON（只读）。 */
function readArtifact(name) {
    const file = path.join(SESSION_DIR, name);
    if (!fs.existsSync(file)) throw new Error(`[fixture] 会话产物缺失：${file}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 按 name 取 case，避免依赖数组下标顺序。 */
function findCase(cases, name) {
    const found = cases.find((item) => item && item.name === name);
    if (!found) throw new Error(`[fixture] cases.json 中没有用例 ${name}，基线产物被替换过`);
    return found;
}

/**
 * 把 /proc/stat 的 tick 数值整体乘以 factor，模拟"时间推进后的第二次采样"。
 * 只放大数值、不改列结构，让 parseProcStat 仍然走真实文本解析路径。
 */
function scaleProcStatTicks(text, factor) {
    return text
        .split(/\r\n|\r|\n/)
        .map((line) => {
            const match = /^(cpu\d*)\s+(.*)$/.exec(line.trim());
            if (!match) return line;
            const fields = match[2]
                .trim()
                .split(/\s+/)
                .map((field) => {
                    const value = Number(field);
                    return Number.isFinite(value) ? String(value * factor) : field;
                });
            return `${match[1]} ${fields.join(' ')}`;
        })
        .join('\n');
}

// ------------------------------------------------------------ 1. streaming 样本

test('streaming 组合样本：分节齐全且内存/电量/温度可解析', () => {
    const raw = readFixture('combined-sample-streaming.txt');

    const sections = splitSections(raw);
    for (const name of ['STAT', 'MEM', 'BATT', 'PS', 'THERM']) {
        assert.notEqual(sections[name], null, `[口径] 分节 ${name} 未被识别，@@ 标记切分被改坏了`);
    }

    const sample = parseSample(raw);

    assert.notEqual(sample.mem, null, '[口径] MEM 节解析为 null，MemTotal 提取失效');
    assert.ok(
        Number.isInteger(sample.mem.memAvailableKb) && sample.mem.memAvailableKb > 0,
        `[口径] MemAvailable 必须是正整数 KB，实际为 ${sample.mem.memAvailableKb}`,
    );
    assert.equal(sample.mem.memAvailableKb, 2385848, '[fixture] MemAvailable 真机值变了，先核对样本再改断言');

    assert.notEqual(sample.battery, null, '[口径] BATT 节解析为 null，dumpsys 字段提取失效');
    assert.ok(
        sample.battery.level >= 0 && sample.battery.level <= 100,
        `[口径] battery.level 必须落在 0..100，实际为 ${sample.battery.level}`,
    );
    assert.equal(sample.battery.level, 100, '[fixture] 电量真机值变了');

    assert.ok(
        Number.isFinite(sample.thermalC),
        `[口径] thermalC 必须是有限数，实际为 ${sample.thermalC}`,
    );
    // THERM 节内容就是裸毫摄氏度（cat 输出 39700），÷1000 得 39.7。
    assert.equal(sample.thermalC, 39.7, '[口径] 毫摄氏度换算被改动：39700 应为 39.7');

    assert.ok(sample.processes.length > 0, '[口径] PS 节被解析成 0 条进程');
});

// --------------------------------------------------------- 2. scrcpy 进程识别

test('真机运行中的 app_process 恰好命中一条，PID/RSS 锁定', () => {
    const list = parsePs(readFixture('ps-A-streaming.txt'));
    assert.ok(list.length > 900, `[口径] ps -A 至少应解析出上千条进程，实际 ${list.length} 条`);

    const matched = selectProcesses(list, 'scrcpy|app_process');
    assert.equal(
        matched.length,
        1,
        `[口径] 'scrcpy|app_process' 必须恰好命中 1 条（多命中说明正则或列切分被放宽），实际命中 ${matched.length} 条：${JSON.stringify(matched)}`,
    );

    const [proc] = matched;
    assert.equal(proc.pid, 4473, '[fixture] app_process 的 PID 真机值变了');
    assert.equal(proc.rssKb, 204424, '[口径] RSS 列被错切（NAME 含空格的行最容易错位）');

    // 交叉验证：另一份只取命中行的 fixture 必须给出同一对数值。
    const crossCheck = selectProcesses(parsePs(readFixture('ps-scrcpy-lines.txt')), 'scrcpy|app_process');
    assert.equal(crossCheck.length, 1, '[fixture] ps-scrcpy-lines.txt 应只含一条命中行');
    assert.equal(crossCheck[0].pid, proc.pid, '[fixture] 两份样本的 PID 不一致');
    assert.equal(crossCheck[0].rssKb, proc.rssKb, '[fixture] 两份样本的 RSS 不一致');
});

// ------------------------------------------------------------ 3. 停流后无残留

test('停流后 ps 输出为 (none)：命中结果为空数组而非 null', () => {
    const raw = readFixture('ps-scrcpy-after-stop.txt');
    assert.equal(raw.trim(), '(none)', '[fixture] 停流后样本内容变了');

    const list = parsePs(raw);
    const matched = selectProcesses(list, 'scrcpy|app_process');
    assert.ok(Array.isArray(list), '[口径] parsePs 必须恒返回数组');
    assert.ok(Array.isArray(matched), '[口径] selectProcesses 必须恒返回数组');
    assert.deepEqual(matched, [], '[口径] 停流后不应命中任何进程，残留检测口径被放宽了');
});

// -------------------------------------------------------------- 4. 电量字段口径

test('dumpsys battery 取标准块：32.8°C / 4422000µAh / 100%', () => {
    const raw = readFixture('dumpsys-battery-streaming.txt');
    // 陷阱：OPLUS 自定义块里的 PhoneTemp: 330（33.0°C）不是答案，标准块的 temperature: 328 才是。
    assert.match(raw, /PhoneTemp: 330/, '[fixture] OPLUS 自定义块缺失，本测试的防混淆前提不成立了');

    const battery = parseBattery(raw);
    assert.notEqual(battery, null, '[口径] 标准 Battery Service 块解析失败');
    assert.equal(
        battery.temperatureC,
        32.8,
        `[口径] temperature 是十分之一摄氏度：328 必须为 32.8，实际为 ${battery.temperatureC}`,
    );
    assert.equal(battery.chargeCounterUah, 4422000, '[口径] Charge counter 单位是 µAh，取值被改');
    assert.equal(battery.level, 100, '[fixture] 电量真机值变了');
});

// -------------------------------------------------------- 5. thermal 毫摄氏度换算

test('thermal_zone 毫摄氏度 ÷1000：39700 → 39.7', () => {
    const raw = readFixture('thermal-all-zones-streaming.txt');
    const firstLine = raw.split(/\r\n|\r|\n/)[0];
    assert.match(
        firstLine,
        /^\/sys\/class\/thermal\/thermal_zone0\/temp=39700$/,
        `[fixture] 首行 thermal_zone0 真机值变了：${firstLine}`,
    );

    // 注意：不能把整行喂给 parseThermalMilliC —— firstInt 会先吃到 "thermal_zone0" 里的 0，
    // 得到 0°C。生产路径里 THERM 节是 cat 的裸值，所以这里同样只取 '=' 之后的部分。
    const milliC = firstLine.slice(firstLine.indexOf('=') + 1);
    assert.equal(parseThermalMilliC(milliC), 39.7, '[口径] 换算必须是 ÷1000，÷100 会得到 397');

    assert.equal(parseThermalMilliC('35500'), 35.5, '[口径] 换算规则被改：35500 必须为 35.5');
});

// ------------------------------------------------------------- 6. CPU 差分口径

test('cpuDelta：时间推进后 busyPct 落在 0..100，tick 不增长时返回 null', () => {
    const raw = readFixture('proc-stat.txt');
    const prev = parseProcStat(raw);
    assert.notEqual(prev, null, '[fixture] /proc/stat 样本不可解析');
    assert.equal(prev.cores.length, 8, '[fixture] 样本应是 8 核');

    const next = parseProcStat(scaleProcStatTicks(raw, 2));
    assert.notEqual(next, null, '[口径] 放大后的样本不可解析');
    assert.ok(next.totalTicks > prev.totalTicks, '[fixture] 构造的第二次采样 tick 总量未增长');

    const delta = cpuDelta(prev, next);
    assert.notEqual(delta, null, '[口径] tick 总量增长时 cpuDelta 不应返回 null');
    assert.ok(
        Number.isFinite(delta.busyPct) && delta.busyPct >= 0 && delta.busyPct <= 100,
        `[口径] busyPct 必须落在 0..100，实际为 ${delta.busyPct}`,
    );
    assert.equal(delta.perCore.length, 8, '[口径] perCore 应逐核给出增量');
    for (const core of delta.perCore) {
        assert.ok(
            core.busyPct >= 0 && core.busyPct <= 100,
            `[口径] ${core.name} 的 busyPct 越界：${core.busyPct}`,
        );
    }

    // 同一份快照（总 tick 增量为 0）必须返回 null，不能输出 NaN/Infinity。
    assert.equal(cpuDelta(prev, prev), null, '[口径] 总 tick 未增长时必须返回 null');
    assert.equal(cpuDelta(prev, parseProcStat(raw)), null, '[口径] 重复解析同一份快照必须返回 null');
});

// -------------------------------------------------------- 7. 基线已知值锁定

test('A-single-h264-60s：累计帧率与滑动窗口帧率是两个口径，不得混用', () => {
    const cases = readArtifact('cases.json');
    const single = findCase(cases, 'A-single-h264-60s');

    assert.equal(single.wsFrames, 270, '[fixture] 该 case 的 wsFrames 真机值变了');
    assert.equal(single.cumulativeFps, 4.45, '[口径] cumulativeFps 应等于 wsFrames/wsSeconds');

    // cumulativeFps 的定义必须是「累计帧数 / 总时长」，用 fixture 现场复算锁死。
    const recomputed = Math.round((single.wsFrames / single.wsSeconds) * 100) / 100;
    assert.equal(
        single.cumulativeFps,
        recomputed,
        `[口径] cumulativeFps 口径被改：270/60.708 应得 4.45，实际字段为 ${single.cumulativeFps}`,
    );

    // 真机产物把滑动窗口口径写在 case 顶层 effectiveFps（display 块里只有计数器），
    // 这里优先取 display.effectiveFps，回落到顶层，两种落盘形态都覆盖。
    const slidingFps = typeof single.display?.effectiveFps === 'number'
        ? single.display.effectiveFps
        : single.effectiveFps;
    assert.ok(
        Number.isFinite(slidingFps),
        `[fixture] 找不到滑动窗口口径的 effectiveFps 字段：${JSON.stringify(Object.keys(single))}`,
    );

    // 这条断言的意义：滑动窗口把"画面静止不出帧"的空窗剔掉后再算分母，
    // 于是同一段采集里它会接近累计口径的两倍（9.61 vs 4.45）。
    // 两个口径一旦被后人合并/互相替代，基线就会凭空翻倍，所以这里显式要求它们不相等。
    assert.notEqual(
        slidingFps,
        single.cumulativeFps,
        '[口径] 滑动窗口 effectiveFps 与累计 cumulativeFps 被混用了，两者的分母语义不同，不能相等',
    );
    assert.ok(
        slidingFps > single.cumulativeFps,
        `[口径] 滑动窗口口径应大于累计口径（静止不出帧被剔除），实际 ${slidingFps} <= ${single.cumulativeFps}`,
    );
});

// ------------------------------------------------------------ 8. 恢复耗时锁定

test('D-recovery-x3：三次 kill→首帧 都在 0..10000ms 且未超时', () => {
    const cases = readArtifact('cases.json');
    const recovery = findCase(cases, 'D-recovery-x3');

    assert.ok(Array.isArray(recovery.recoveries), '[fixture] recoveries 字段缺失');
    assert.equal(recovery.recoveries.length, 3, '[fixture] 该 case 应记录 3 次恢复');

    for (const entry of recovery.recoveries) {
        // 不断言精确毫秒值（机器相关），只锁量级。
        assert.ok(
            Number.isFinite(entry.killToFirstFrameMs) && entry.killToFirstFrameMs > 0,
            `[口径] 第 ${entry.index} 次 killToFirstFrameMs 必须是正数，实际 ${entry.killToFirstFrameMs}`,
        );
        assert.ok(
            entry.killToFirstFrameMs < 10000,
            `[口径] 第 ${entry.index} 次杀进程恢复耗时越界（应 <10000ms），实际 ${entry.killToFirstFrameMs}ms`,
        );
        assert.equal(entry.timedOut, false, `[fixture] 第 ${entry.index} 次恢复被标记为超时`);
    }
});

// -------------------------------------------------------------- 9. 归零契约

test('C-stop-display-cleanup：停流后状态归零且宿主内存无泄漏', () => {
    const cases = readArtifact('cases.json');
    const cleanup = findCase(cases, 'C-stop-display-cleanup');

    assert.equal(cleanup.scrcpyState, 'stopped', '[口径] 停流后 scrcpyState 必须是 stopped');
    assert.equal(cleanup.scrcpySubscribers, 0, '[口径] 停流后订阅者必须清零');
    assert.equal(cleanup.deviceScrcpyResidual, false, '[口径] 设备端残留检测必须为 false');
    assert.equal(cleanup.deviceResidualLine, '(none)', '[fixture] 设备端残留行不是 (none)');
    assert.equal(cleanup.displayUrl, null, '[口径] 停流后 displayUrl 必须为 null');

    const rssGrowthKb = cleanup.rssAfterKb - cleanup.rssBeforeKb;
    assert.ok(
        Number.isFinite(rssGrowthKb),
        `[fixture] RSS 字段缺失：before=${cleanup.rssBeforeKb} after=${cleanup.rssAfterKb}`,
    );
    assert.ok(
        rssGrowthKb < 20 * 1024,
        `[口径] 停流前后宿主 RSS 增长超过 20MB 上限：${rssGrowthKb}KB（before=${cleanup.rssBeforeKb} after=${cleanup.rssAfterKb}）`,
    );

    // 交叉验证：同一时刻抓的运行时快照（落盘在 fixture 目录）必须给出同样的结论。
    const statusAfterStop = JSON.parse(readFixture('runtime-status-after-stop.json'));
    assert.equal(
        statusAfterStop.scrcpy.state,
        'stopped',
        '[口径] runtime-status-after-stop.json 里 scrcpy.state 不是 stopped',
    );
    assert.equal(statusAfterStop.scrcpy.subscribers, 0, '[口径] 运行时快照里 scrcpy 订阅者未清零');
    assert.equal(statusAfterStop.displayUrl, null, '[口径] 运行时快照里 displayUrl 未清空');
});

// ---------------------------------------------------------- 10. Observe 延迟量级

test('observe-latency：60 次采样零失败，分位数单调', () => {
    const latency = readArtifact('observe-latency.json');

    assert.equal(latency.sampleCount, 60, '[fixture] 采样次数真机值变了');
    assert.equal(latency.failureCount, 0, '[口径] 失败计数必须与 failures 数组一致');
    assert.ok(Array.isArray(latency.failures), '[fixture] failures 字段缺失');
    assert.equal(latency.failures.length, 0, '[fixture] failures 非空但 failureCount 为 0，计数失真');
    assert.equal(
        latency.sampleCount,
        latency.requestedCount,
        '[口径] 请求次数与成功采样次数不一致，丢样本没被计入失败',
    );

    // 只锁量级与单调性，不断言精确毫秒值（机器相关）。
    assert.ok(latency.p50Ms > 0, `[口径] p50Ms 必须为正数，实际 ${latency.p50Ms}`);
    assert.ok(
        latency.p95Ms >= latency.p50Ms,
        `[口径] 分位数必须单调不减：p95=${latency.p95Ms} < p50=${latency.p50Ms}，最近秩算法被改坏`,
    );
    assert.ok(
        latency.maxMs >= latency.p95Ms,
        `[口径] max 必须不小于 p95：max=${latency.maxMs} < p95=${latency.p95Ms}`,
    );
    assert.ok(
        Number.isFinite(latency.minMs) && latency.minMs > 0 && latency.minMs <= latency.p50Ms,
        `[口径] minMs 应落在 (0, p50] 区间，实际 min=${latency.minMs}`,
    );
});
