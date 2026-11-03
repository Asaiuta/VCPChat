'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const metrics = require('../VCPDistributedServer/Plugin/AndroidController/lib/device-metrics');

const {
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
} = metrics;

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'android-device');
const fixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

const combinedText = fixture('combined-sample.txt');
const procStatText = fixture('proc-stat.txt');
const procMeminfoText = fixture('proc-meminfo.txt');
const dumpsysBatteryText = fixture('dumpsys-battery.txt');
const psAText = fixture('ps-A.txt');
const thermalZoneText = fixture('thermal-zone0.txt');

/** 递归断言对象里没有 NaN / Infinity。 */
function assertNoNaN(value, trail = 'root') {
    if (typeof value === 'number') {
        assert.ok(!Number.isNaN(value), `${trail} 不应为 NaN`);
        assert.ok(Number.isFinite(value), `${trail} 应为有限数`);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertNoNaN(item, `${trail}[${index}]`));
        return;
    }
    if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) assertNoNaN(item, `${trail}.${key}`);
    }
}

/** 把 /proc/stat 里每个 cpu 行的计数值放大，模拟后一次采样（核名不动）。 */
function amplifyProcStat(text, factor) {
    return text
        .split(/\r\n|\r|\n/)
        .map((line) => {
            const match = /^(cpu\d*)(\s+)(.*)$/.exec(line);
            if (!match) return line;
            const scaled = match[3].replace(/\d+/g, (digits) => String(Number(digits) * factor));
            return `${match[1]}${match[2]}${scaled}`;
        })
        .join('\n');
}

test('buildSampleCommand：单条命令包含全部分节标记，且以 @@END 收尾', () => {
    const command = buildSampleCommand();
    assert.equal(typeof command, 'string');
    for (const name of ['STAT', 'MEM', 'BATT', 'PS', 'THERM']) {
        assert.ok(command.includes(`${SECTION_MARKER}${name}`), `缺少分节 ${name}`);
    }
    assert.ok(command.includes(`${SECTION_MARKER}END`));
    assert.ok(command.includes('dumpsys battery'));
    assert.ok(command.includes('ps -A -o PID,PPID,NAME,RSS'));
    assert.ok(command.includes('/proc/stat'));
    assert.ok(command.includes('/proc/meminfo'));
    assert.ok(command.includes('/sys/class/thermal/thermal_zone0/temp'));
    assert.ok(!command.includes('\n'), '必须是一条单行命令');
});

test('真实 combined-sample.txt：全量解析', () => {
    const sample = parseSample(combinedText);
    assertNoNaN(sample);

    // stat
    assert.ok(sample.stat, 'stat 不应为 null');
    assert.ok(sample.stat.totalTicks > 0);
    assert.ok(sample.stat.busyTicks >= 0);
    assert.ok(sample.stat.busyTicks < sample.stat.totalTicks);
    assert.equal(sample.stat.cores.length, 8);
    assert.equal(sample.stat.cores[0].name, 'cpu0');

    // mem
    assert.ok(sample.mem, 'mem 不应为 null');
    assert.ok(sample.mem.memTotalKb > 0);
    assert.ok(sample.mem.memAvailableKb > 0);

    // battery
    assert.ok(sample.battery, 'battery 不应为 null');
    assert.ok(sample.battery.level >= 0 && sample.battery.level <= 100);
    assert.equal(sample.battery.level, 100);
    assert.ok(Math.abs(sample.battery.temperatureC - 32.7) < 1e-9);
    assert.equal(sample.battery.chargeCounterUah, 4422000);
    assert.equal(sample.battery.status, 5);
    assert.equal(sample.battery.acPowered, true);

    // thermal：真实 fixture 的 THERM 节是 37400 毫摄氏度
    assert.ok(Math.abs(sample.thermalC - 37.4) < 1e-9);

    // ps
    assert.ok(sample.processes.length > 500, `进程数 ${sample.processes.length} 应大于 500`);
    assert.ok(sample.processes.every((item) => Number.isFinite(item.pid) && Number.isFinite(item.rssKb)));
    assert.ok(sample.processes.some((item) => item.name === 'system_server'));
});

test('parseBattery 取标准块，不取 OPLUS 的 PhoneTemp', () => {
    const battery = parseBattery(dumpsysBatteryText);
    assert.ok(battery);
    assert.equal(battery.temperatureC, 32.7, '必须取标准块 temperature: 327，而不是 PhoneTemp: 320');
    assert.notEqual(battery.temperatureC, 32.0);
    assert.equal(battery.level, 100);
    assert.equal(battery.chargeCounterUah, 4422000);
    assert.equal(battery.status, 5);
    assert.equal(battery.acPowered, true);

    // 只有 OPLUS 块时不应把 PhoneTemp 当成温度
    const oplusOnly = dumpsysBatteryText.split('Current Battery Service state:')[0];
    const onlyCustom = parseBattery(oplusOnly);
    assert.equal(onlyCustom, null);
});

test('parseThermalMilliC：毫摄氏度换算', () => {
    assert.equal(parseThermalMilliC('35500'), 35.5);
    assert.equal(parseThermalMilliC(`${thermalZoneText.trim()}\n`), 38.6);
    assert.equal(parseThermalMilliC('35500\n'), 35.5);
    assert.equal(parseThermalMilliC('garbage'), null);
    assert.equal(parseThermalMilliC(''), null);
});

test('parseProcMeminfo：真实 /proc/meminfo', () => {
    const mem = parseProcMeminfo(procMeminfoText);
    assert.ok(mem);
    assert.equal(mem.memTotalKb, 15477908);
    assert.equal(mem.memFreeKb, 241692);
    assert.equal(mem.memAvailableKb, 2488820);
});

test('cpuDelta：真实 /proc/stat 造两个快照，占用率落在 0..100', () => {
    const prevText = procStatText;
    const nextText = amplifyProcStat(procStatText, 2);
    const prev = parseProcStat(prevText);
    const next = parseProcStat(nextText);
    assert.ok(prev && next);
    assert.ok(next.totalTicks > prev.totalTicks);

    const delta = cpuDelta(prev, next);
    assert.ok(delta, 'delta 不应为 null');
    assert.ok(delta.busyPct >= 0 && delta.busyPct <= 100);
    assert.ok(delta.busyPct > 0 && delta.busyPct < 100);
    assert.equal(delta.perCore.length, 8);
    for (const core of delta.perCore) {
        assert.equal(typeof core.name, 'string');
        assert.ok(core.busyPct >= 0 && core.busyPct <= 100, `${core.name} 越界: ${core.busyPct}`);
    }
    assertNoNaN(delta);

    // 空闲占比更大的快照作为前一次采样，busy 更高的作为后一次 → 占用率应上升
    const idleHeavy = parseProcStat(
        procStatText.replace(/^cpu\s+.*$/m, 'cpu  1000000 1000 1000000 90000000 1000 1000 1000 1000 0 0'),
    );
    const busyHeavy = parseProcStat(
        procStatText.replace(/^cpu\s+.*$/m, 'cpu  60000000 1000 1000000 96000000 1000 1000 1000 1000 0 0'),
    );
    assert.ok(busyHeavy.totalTicks > idleHeavy.totalTicks, '后一次采样的总 tick 必须更大');
    const heavyDelta = cpuDelta(idleHeavy, busyHeavy);
    assert.ok(heavyDelta, 'heavyDelta 不应为 null');
    assert.ok(heavyDelta.busyPct > delta.busyPct);
    assert.ok(heavyDelta.busyPct <= 100);
});

test('cpuDelta：退化输入返回 null，不产生 NaN/Infinity', () => {
    const stat = parseProcStat(procStatText);
    assert.equal(cpuDelta(stat, stat), null);

    const sameTicks = { ...stat, cores: stat.cores.map((core) => ({ ...core })) };
    assert.equal(cpuDelta(stat, sameTicks), null);

    const backwards = { ...stat, totalTicks: stat.totalTicks - 1000, busyTicks: stat.busyTicks - 10 };
    assert.equal(cpuDelta(stat, backwards), null);

    assert.equal(cpuDelta(null, stat), null);
    assert.equal(cpuDelta(stat, null), null);
    assert.equal(cpuDelta(undefined, undefined), null);
});

test('畸形/空输入：各解析器降级不抛异常', () => {
    const inputs = ['', '   ', 'garbage', '@@STAT', '\n\n'];

    for (const input of inputs) {
        assert.equal(parseProcStat(input), null, `parseProcStat(${JSON.stringify(input)})`);
        assert.equal(parseProcMeminfo(input), null, `parseProcMeminfo(${JSON.stringify(input)})`);
        assert.equal(parseBattery(input), null, `parseBattery(${JSON.stringify(input)})`);
        assert.equal(parseThermalMilliC(input), null, `parseThermalMilliC(${JSON.stringify(input)})`);
        assert.deepEqual(parsePs(input), [], `parsePs(${JSON.stringify(input)})`);
        assert.deepEqual(selectProcesses(parsePs(input), 'x'), []);
        assert.equal(batteryMah(input, input), null);
        const sections = splitSections(input);
        assert.deepEqual(Object.keys(sections).sort(), ['BATT', 'MEM', 'PS', 'STAT', 'THERM']);
        if (!input.includes('@@')) {
            assert.deepEqual(sections, { STAT: null, MEM: null, BATT: null, PS: null, THERM: null });
        } else {
            // 只有标记没有内容：STAT 为空串，其余节仍为 null
            assert.equal(sections.STAT, '');
            assert.equal(sections.MEM, null);
        }
    }

    // 半截文本：只有 @@STAT，其余节缺失
    const half = `@@STAT\ncpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0`;
    const partial = parseSample(half);
    assertNoNaN(partial);
    assert.ok(partial.stat);
    assert.ok(partial.stat.totalTicks > 0);
    assert.equal(partial.stat.cores.length, 1);
    assert.equal(partial.mem, null);
    assert.equal(partial.battery, null);
    assert.equal(partial.thermalC, null);
    assert.deepEqual(partial.processes, []);

    // 完全垃圾输入
    const garbageSample = parseSample('garbage');
    assertNoNaN(garbageSample);
    assert.equal(garbageSample.stat, null);
    assert.equal(garbageSample.mem, null);
    assert.equal(garbageSample.battery, null);
    assert.equal(garbageSample.thermalC, null);
    assert.deepEqual(garbageSample.processes, []);

    // parseSample 对 null / undefined 也不炸
    assert.equal(parseSample(null).stat, null);
    assert.equal(parseSample(undefined).mem, null);

    // 缺 RSS 列、非法数字的 ps 行被跳过
    assert.deepEqual(parsePs('  PID  PPID NAME     RSS\n  1 0 init 7008\n  2 0 broken\n  x 0 nope 12'), [
        { pid: 1, ppid: 0, name: 'init', rssKb: 7008 },
    ]);
});

test('splitSections：分节定位与缺节 null', () => {
    const sections = splitSections(combinedText);
    assert.deepEqual(Object.keys(sections).sort(), ['BATT', 'MEM', 'PS', 'STAT', 'THERM']);
    assert.ok(sections.STAT.startsWith('cpu '));
    assert.ok(sections.MEM.includes('MemTotal:'));
    assert.ok(sections.BATT.includes('Current Battery Service state:'));
    assert.ok(sections.PS.includes('PID'), 'ps 表头应保留在 PS 节内');
    assert.equal(sections.THERM.trim(), '37400');
    assert.ok(!sections.STAT.includes(SECTION_MARKER), '分节标记不应混入内容');

    // @@END 之后的内容必须丢弃
    const truncated = splitSections('@@STAT\ncpu 1 2 3 4 5 6 7 8 9 10\n@@END\n@@MEM\nMemTotal: 1 kB\n');
    assert.ok(truncated.STAT.startsWith('cpu'));
    assert.equal(truncated.MEM, null);

    // 无标记文本
    assert.deepEqual(splitSections('cpu 1 2 3'), { STAT: null, MEM: null, BATT: null, PS: null, THERM: null });

    // 出现标记但内容为空 → 空字符串，而非 null
    const emptySection = splitSections('@@STAT\n@@MEM\nMemTotal: 8 kB\n');
    assert.equal(emptySection.STAT, '');
});

test('batteryMah：电荷计数差分换算（µAh → mAh，1 mAh = 1000 µAh）', () => {
    // 4422000 µAh → 4423000 µAh 差 1000 µAh = 1 mAh
    assert.ok(Math.abs(batteryMah(4422000, 4423000) - 1) < 1e-9);
    // 差 10000 µAh = 10 mAh
    assert.ok(Math.abs(batteryMah(4422000, 4432000) - 10) < 1e-9);
    assert.ok(Math.abs(batteryMah(4432000, 4422000) - 10) < 1e-9, '必须取绝对值');
    assert.equal(batteryMah(4422000, 4422000), 0);
    assert.equal(batteryMah(null, 4422000), null);
    assert.equal(batteryMah(4422000, undefined), null);
    assert.equal(batteryMah('4422000', 4432000), null);
    assert.equal(batteryMah(NaN, 4432000), null);
    assert.equal(batteryMah(Infinity, 4432000), null);
});

test('selectProcesses：真实 ps 输出匹配与无命中', () => {
    const processes = parsePs(psAText);
    assert.ok(processes.length > 500, `进程数 ${processes.length} 应大于 500`);

    const scrcpy = selectProcesses(processes, 'scrcpy');
    assert.ok(Array.isArray(scrcpy), '无命中必须是空数组');
    assert.equal(scrcpy.length, 0);

    const appProcess = selectProcesses(processes, 'app_process');
    assert.ok(Array.isArray(appProcess));
    assert.equal(appProcess.length, 0);

    const systems = selectProcesses(processes, 'system_server');
    assert.ok(systems.length >= 1);
    assert.ok(systems.every((item) => /system_server/i.test(item.name)));

    // 大小写不敏感
    assert.equal(selectProcesses(processes, 'SYSTEM_SERVER').length, systems.length);

    // NAME 含空格 / 方括号的内核线程要能完整取到
    const kthreads = processes.filter((item) => item.name.includes(' '));
    assert.ok(kthreads.length >= 1, 'fixture 里存在含空格的进程名');
    assert.ok(kthreads.every((item) => item.name.startsWith('[') && item.name.endsWith(']')));

    // 非法 pattern / 非数组 → 空数组
    assert.deepEqual(selectProcesses(processes, '['), []);
    assert.deepEqual(selectProcesses(null, 'x'), []);
    assert.deepEqual(selectProcesses(processes, ''), []);
});

test('collect：一次 adb 往返，结构完整且 raw 为原文', async () => {
    const calls = [];
    const fakeAdb = {
        async runText(args, options) {
            calls.push({ args, options });
            return combinedText;
        },
    };

    const sample = await collect({ adb: fakeAdb, serial: 'PJZ110', processPattern: 'system_server' });

    assert.equal(calls.length, 1, '批量采集只能有一次 adb 往返');
    assert.equal(calls[0].args[0], 'shell');
    assert.ok(calls[0].args[1].includes(`${SECTION_MARKER}STAT`));
    assert.deepEqual(calls[0].options, { serial: 'PJZ110' });

    assert.equal(typeof sample.sampledAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(sample.sampledAt)));
    assert.equal(sample.raw, combinedText);
    assert.ok(sample.stat.totalTicks > 0);
    assert.ok(sample.mem.memTotalKb > 0);
    assert.equal(sample.battery.temperatureC, 32.7);
    assert.ok(Math.abs(sample.thermalC - 37.4) < 1e-9);
    assert.ok(sample.processes.length > 500);
    assert.ok(sample.matched.length >= 1);
    assert.ok(sample.matched.every((item) => /system_server/i.test(item.name)));

    // 不传 serial / pattern 时的默认路径
    const bare = await collect({ adb: fakeAdb });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].options, {});
    assert.equal(bare.matched, null);
    assert.equal(bare.battery.level, 100);

    // adb 抛错必须向上抛，不能吞成空样本
    const failing = { async runText() { throw new Error('adb offline'); } };
    await assert.rejects(() => collect({ adb: failing }), /adb offline/);
    await assert.rejects(() => collect({}), TypeError);
});

// 回归：thermal 节点可能以 `路径=值` 形态出现（诊断脚本遍历时带 echo -n "$z="）。
// 早期实现用 firstInt 取第一个整数，会咬到 thermal_zone0 里的 0，静默返回 0°C。
// 0°C 不会报错、不会缺字段，只会让温度基线凭空变低 —— 比抛异常危险得多。
test('thermal 带路径的行取最后一个整数，不得静默返回 0', () => {
    const { parseThermalMilliC } = require('../VCPDistributedServer/Plugin/AndroidController/lib/device-metrics');
    assert.equal(parseThermalMilliC('/sys/class/thermal/thermal_zone0/temp=39700'), 39.7);
    // 多行时 zone0 优先
    assert.equal(
        parseThermalMilliC('/sys/class/thermal/thermal_zone0/temp=39700\n/sys/class/thermal/thermal_zone1/temp=47500\n'),
        39.7,
    );
    // 生产路径仍是裸值
    assert.equal(parseThermalMilliC('35500'), 35.5);
    assert.equal(parseThermalMilliC('35500\r\n'), 35.5);
    // 明确断言：不得出现把 zone 编号当温度的结果
    assert.notEqual(parseThermalMilliC('/sys/class/thermal/thermal_zone0/temp=39700'), 0);
});

test('thermal 只有一份实现，导出的就是被 parseSample 使用的那一份', () => {
    const source = fs.readFileSync(path.resolve(__dirname,
        '../VCPDistributedServer/Plugin/AndroidController/lib/device-metrics.js'), 'utf8');
    const definitions = source.match(/function parseThermalMilliC/g) || [];
    // 重复定义会让后一份静默覆盖前一份，修了等于没修。
    assert.equal(definitions.length, 1, 'parseThermalMilliC 不得重复定义');
});
