'use strict';

/**
 * 设备端占用采集：CPU / 内存 / 电池 / 温度 / 进程 RSS。
 *
 * 设计约束：
 * - 纯函数解析层：不做 IO、不 spawn 进程，adb 由调用方注入。
 * - 一次 adb 往返取全部指标，采样本身不能成为被测链路的噪声源。
 * - 任何一节缺失或格式异常都降级为 null / 空数组，绝不抛异常。
 */

/** 分节标记前缀，真实输出形如 `@@STAT`。 */
const SECTION_MARKER = '@@';

/** 采集命令里出现的分节名，顺序即设备端执行顺序。 */
const SECTION_NAMES = ['STAT', 'MEM', 'BATT', 'PS', 'THERM'];

/**
 * thermal_zone* 的值是毫摄氏度（35500 → 35.5°C）。
 * dumpsys battery 的 temperature 是十分之一摄氏度（327 → 32.7°C），两者不要混用。
 */
const THERMAL_MILLI_PER_DEGREE = 1000;
const BATTERY_TENTHS_PER_DEGREE = 10;

/** 电荷计数单位是 µAh（微安时），1 mAh = 1000 µAh。 */
const UAH_PER_MAH = 1000;

/**
 * 构造一次批量采集命令，供 `adb shell` 使用（单参数形式，设备端由 sh -c 解释）。
 * 各节之间用 `;` 连接：任一子命令失败不影响后续节，缺失节解析后为 null。
 * thermal_zone0 在部分设备上不存在，因此重定向 stderr，让该节为空而不是污染输出。
 */
function buildSampleCommand() {
    const parts = [
        `echo ${SECTION_MARKER}STAT`,
        'cat /proc/stat',
        `echo ${SECTION_MARKER}MEM`,
        'cat /proc/meminfo',
        `echo ${SECTION_MARKER}BATT`,
        'dumpsys battery',
        `echo ${SECTION_MARKER}PS`,
        'ps -A -o PID,PPID,NAME,RSS',
        `echo ${SECTION_MARKER}THERM`,
        'cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null',
        `echo ${SECTION_MARKER}END`,
    ];
    return `sh -c '${parts.join('; ')}'`;
}

/**
 * 按 `@@NAME` 行切分批量输出。
 * 返回 { STAT, MEM, BATT, PS, THERM }，未出现的节为 null；
 * 出现了标记但内容为空时返回空字符串（用于区分"没采"和"采到空"）。
 * `@@END` 之后的内容全部丢弃。
 */
function splitSections(text) {
    const sections = { STAT: null, MEM: null, BATT: null, PS: null, THERM: null };
    const source = String(text ?? '');
    if (!source.includes(SECTION_MARKER)) return sections;

    let current = null;
    for (const line of source.split(/\r\n|\r|\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith(SECTION_MARKER)) {
            if (trimmed.slice(SECTION_MARKER.length).toUpperCase().startsWith('END')) {
                current = null;
                break;
            }
            const name = trimmed.slice(SECTION_MARKER.length).trim().split(/\s+/)[0].toUpperCase();
            current = SECTION_NAMES.includes(name) ? name : null;
            // 标记出现过但内容为空：置空串，与"整节未出现"的 null 区分。
            if (current && sections[current] === null) sections[current] = '';
            continue;
        }
        if (current) {
            sections[current] = sections[current] === null ? line : `${sections[current]}\n${line}`;
        }
    }

    // 去掉首尾空行，中间内容原样保留（ps 的列对齐依赖空白）。
    for (const name of SECTION_NAMES) {
        if (sections[name] !== null) sections[name] = sections[name].replace(/^\n+/, '').replace(/\n+$/, '');
    }
    return sections;
}

/** 从一段文本里取第一个整数，取不到返回 null。 */
function firstInt(text) {
    const match = /-?\d+/.exec(String(text ?? ''));
    if (!match) return null;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
}

/**
 * 解析 thermal 节点输出。
 *
 * 采到的可能是裸值（生产路径 cat 的是值文件），也可能是 `路径=值` 形态
 * （人工/诊断脚本遍历时带 echo -n "$z=" 前缀）。后者把整行直接交给
 * firstInt 会咬到 `thermal_zone0` 里的那个 0，静默返回 0°C —— 比报错更糟。
 * 因此先按行取最后一个整数：`路径=值` 的行最后一个整数就是值本身。
 * 单位是毫摄氏度，÷1000 得摄氏度。
 */
function parseThermalMilliC(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) return null;
    // 逐行取最后一个整数；遇到第一行能取到值即返回（zone0 优先）。
    for (const line of raw.split(/\r\n|\r|\n/)) {
        if (!line.trim()) continue;
        const hits = /-?\d+/g;
        let last = null;
        let match;
        while ((match = hits.exec(line)) !== null) last = match[0];
        if (last === null) continue;
        const value = Number(last);
        if (!Number.isFinite(value)) continue;
        return value / THERMAL_MILLI_PER_DEGREE;
    }
    return null;
}

/** 行首固定缩进的字段提取；`indent` 为空则不限缩进。 */
function fieldInt(text, label, indent = '  ') {
    const pattern = new RegExp(`^${indent}${label}:[ \\t]*(-?\\d+)`, 'm');
    const match = pattern.exec(text);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}

function clampPercent(value) {
    if (!Number.isFinite(value)) return null;
    return Math.min(100, Math.max(0, value));
}

/**
 * 解析 /proc/stat。
 * 列顺序：user nice system idle iowait irq softirq steal guest guest_nice。
 * total 只累加前 8 列：guest / guest_nice 已包含在 user / nice 内，重复累加会虚增分母。
 * idleTicks = idle + iowait，busyTicks = totalTicks - idleTicks。
 * 没有 `cpu` / `cpuN` 行时返回 null。
 */
function parseProcStat(text) {
    const source = String(text ?? '');
    if (!source) return null;

    const cores = [];
    let aggregate = null;

    for (const line of source.split(/\r\n|\r|\n/)) {
        const match = /^(cpu\d*)\s+(.*)$/.exec(line.trim());
        if (!match) continue;
        const name = match[1];
        const fields = match[2].trim().split(/\s+/).map(Number);
        if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) continue;

        const cpu = fields.slice(0, 8);
        while (cpu.length < 8) cpu.push(0);
        const totalTicks = cpu.reduce((sum, value) => sum + value, 0);
        const idleTicks = cpu[3] + cpu[4];
        const entry = { name, totalTicks, busyTicks: totalTicks - idleTicks, idleTicks };
        if (name === 'cpu') aggregate = entry;
        else cores.push(entry);
    }

    if (!aggregate && cores.length === 0) return null;
    const base = aggregate || {
        name: 'cpu',
        totalTicks: cores.reduce((sum, core) => sum + core.totalTicks, 0),
        busyTicks: cores.reduce((sum, core) => sum + core.busyTicks, 0),
        idleTicks: cores.reduce((sum, core) => sum + core.idleTicks, 0),
    };
    return { ...base, cores };
}

/**
 * 两次 /proc/stat 采样求增量占用率。
 * 总 tick 增量 <= 0（同一份快照、计数重启、时钟回退）时返回 null，避免 NaN / Infinity。
 * perCore 只保留两次都出现且增量 > 0 的核。
 */
function cpuDelta(prev, next) {
    if (!prev || !next) return null;
    const totalDelta = next.totalTicks - prev.totalTicks;
    if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
    const busyPct = clampPercent(((next.busyTicks - prev.busyTicks) * 100) / totalDelta);
    if (busyPct === null) return null;

    const prevByName = new Map((prev.cores || []).map((core) => [core.name, core]));
    const perCore = [];
    for (const core of next.cores || []) {
        const before = prevByName.get(core.name);
        if (!before) continue;
        const coreTotalDelta = core.totalTicks - before.totalTicks;
        if (!Number.isFinite(coreTotalDelta) || coreTotalDelta <= 0) continue;
        const corePct = clampPercent(((core.busyTicks - before.busyTicks) * 100) / coreTotalDelta);
        if (corePct === null) continue;
        perCore.push({ name: core.name, busyPct: corePct });
    }
    return { busyPct, perCore };
}

/**
 * 解析 /proc/meminfo，单位统一为 KB。
 * MemTotal 缺失视为整节无效（返回 null）；其余字段缺失为 null。
 * 注意 Android 上 MemAvailable 才接近"可用"，MemFree 偏低。
 */
function parseProcMeminfo(text) {
    const source = String(text ?? '');
    if (!source) return null;
    const pick = (label) => fieldInt(source, label, '');
    const memTotalKb = pick('MemTotal');
    const memFreeKb = pick('MemFree');
    const memAvailableKb = pick('MemAvailable');
    if (memTotalKb === null) return null;
    return { memTotalKb, memFreeKb, memAvailableKb };
}

/**
 * 只取标准 Battery Service 块。
 * OPLUS 定制块（`Current OPLUS Battery Service state:`）里有自己的 `PhoneTemp: 320`，
 * 单位与含义都不同，必须先切到标准块再按下标提取，否则读到的温度是错的。
 */
function standardBatteryBlock(text) {
    const source = String(text ?? '');
    const index = source.search(/^Current Battery Service state:/m);
    return index >= 0 ? source.slice(index) : source;
}

/**
 * 解析 dumpsys battery 标准块。
 * temperature 是十分之一摄氏度（327 → 32.7），Charge counter 单位 µAh。
 * 一个字段都没匹配到返回 null（用于区分"没采"和"全零"）。
 */
function parseBattery(text) {
    const block = standardBatteryBlock(text);
    if (!block.trim()) return null;

    const level = fieldInt(block, 'level');
    const temperatureTenths = fieldInt(block, 'temperature');
    const chargeCounterUah = fieldInt(block, 'Charge counter');
    const status = fieldInt(block, 'status');
    const acMatch = /^ {2}AC powered:[ \t]*(true|false)/im.exec(block);

    const temperatureC = temperatureTenths === null ? null : temperatureTenths / BATTERY_TENTHS_PER_DEGREE;
    const acPowered = acMatch ? acMatch[1].toLowerCase() === 'true' : null;

    if (level === null && temperatureC === null && chargeCounterUah === null && status === null && acPowered === null) {
        return null;
    }
    return { level, temperatureC, chargeCounterUah, status, acPowered };
}

/**
 * 解析 `ps -A -o PID,PPID,NAME,RSS`（RSS 单位 KB）。
 * 坑位：
 * - PID/PPID 右对齐带前导空格，NAME 列宽固定但会被长包名顶破；
 * - NAME 可能含空格（如 `[irq/287-q6v5 wdog]`、`[Surge kthread]`），
 *   因此按"行尾最后一组数字是 RSS、中间整段是 NAME"的惰性匹配切分；
 * - 内核线程带方括号，原样保留。
 * 无法识别的行（含表头）直接跳过。
 */
function parsePs(text) {
    const source = String(text ?? '');
    const processes = [];
    if (!source) return processes;
    for (const line of source.split(/\r\n|\r|\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\d+)\s*$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const rssKb = Number(match[4]);
        const name = match[3].trim();
        if (!Number.isFinite(pid) || !Number.isFinite(rssKb) || !name) continue;
        processes.push({ pid, ppid: Number.isFinite(ppid) ? ppid : null, name, rssKb });
    }
    return processes;
}

/** 按正则（大小写不敏感）筛选进程名，无命中返回空数组。 */
function selectProcesses(list, pattern) {
    if (!Array.isArray(list)) return [];
    if (pattern === null || pattern === undefined || pattern === '') return [];
    let regex;
    try {
        regex = new RegExp(pattern, 'i');
    } catch {
        return [];
    }
    return list.filter((item) => item && typeof item.name === 'string' && regex.test(item.name));
}

/**
 * 电荷计数差换算成 mAh 的绝对值。
 * 参数必须是有限数值，否则返回 null（宁可缺数据，也不要把 NaN 写进基线）。
 */
function batteryMah(chargeCounterBeforeUah, chargeCounterAfterUah) {
    if (!Number.isFinite(chargeCounterBeforeUah) || !Number.isFinite(chargeCounterAfterUah)) return null;
    return Math.abs(chargeCounterAfterUah - chargeCounterBeforeUah) / UAH_PER_MAH;
}

/** 解析失败的统一兜底，解析层唯一允许吞异常的地方。 */
function attempt(parse, fallback) {
    try {
        const value = parse();
        return value === undefined ? fallback : value;
    } catch {
        return fallback;
    }
}

/**
 * 把一次批量采集输出解析成完整样本。
 * 任一节缺失或解析失败，对应字段为 null；processes 恒为数组（缺节时为空）。
 * 本函数不抛异常。
 */
function parseSample(text) {
    const sections = attempt(() => splitSections(text), {
        STAT: null, MEM: null, BATT: null, PS: null, THERM: null,
    });
    return {
        stat: sections.STAT === null ? null : attempt(() => parseProcStat(sections.STAT), null),
        mem: sections.MEM === null ? null : attempt(() => parseProcMeminfo(sections.MEM), null),
        battery: sections.BATT === null ? null : attempt(() => parseBattery(sections.BATT), null),
        thermalC: sections.THERM === null ? null : attempt(() => parseThermalMilliC(sections.THERM), null),
        processes: sections.PS === null ? [] : attempt(() => parsePs(sections.PS), []),
    };
}

/**
 * 执行一次批量采集（一次 adb 往返）。
 *
 * 重要：调用方必须传入独立的 adb 客户端实例（独立 SerialQueue）。
 * 采样命令一旦进入被测链路的队列，就会把自己的排队延时时长算进延迟测量里，
 * 基线数据当场失真 —— 这里不做任何隔离，隔离责任在调用方。
 *
 * @param {object} options
 * @param {{ runText: (args: string[], options?: object) => Promise<string> }} options.adb
 * @param {string} [options.serial] 目标设备序列号
 * @param {string} [options.processPattern] 可选，命中的子集额外放入 matched，省一次 adb 往返
 * @returns {Promise<{ sampledAt: string, raw: string, matched: object[]|null, stat, mem, battery, thermalC, processes }>}
 * adb 抛错时向上抛出：采不到就该让调用方看见，而不是返回一个静默的空样本污染基线。
 */
async function collect({ adb, serial, processPattern } = {}) {
    if (!adb || typeof adb.runText !== 'function') throw new TypeError('collect 需要注入具备 runText 的 adb 客户端');

    const args = ['shell', buildSampleCommand()];
    const raw = await adb.runText(args, serial ? { serial } : {});
    const text = String(raw ?? '');
    const sample = parseSample(text);
    return {
        sampledAt: new Date().toISOString(),
        raw: text,
        ...sample,
        matched: processPattern ? selectProcesses(sample.processes, processPattern) : null,
    };
}

module.exports = {
    SECTION_MARKER,
    buildSampleCommand,
    splitSections,
    parseProcStat,
    cpuDelta,
    parseProcMeminfo,
    parseBattery,
    parseThermalMilliC,
    parsePs,
    selectProcesses,
    batteryMah,
    parseSample,
    collect,
};
