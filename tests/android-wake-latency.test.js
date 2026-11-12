'use strict';

/**
 * 息屏自动点亮路径的契约。
 *
 * 背景（真机实测，PJZ110，2026-11-02，4 轮）：
 *   keyevent WAKEUP 之后，第一次 probeScreen 返回时 wakefulness 已经是 Awake、
 *   focus 也已是前台应用。典型 160–241ms，冷启动最差 927ms。
 *
 * 旧实现：keyevent -> pause(700) -> wakefulness() -> currentFocus()
 *   = 1 次 keyevent + 700ms 固定睡 + 2 次串行 adb ≈ 1135ms
 *
 * 新契约：keyevent -> 轮询 probeScreen（一次往返拿齐三项）直到「已唤醒且焦点可用」
 *   典型成本 ≈ 240ms，且不得再产生独立的 wakefulness / currentFocus 往返。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const observe = (h, extra = {}) => h.service.processToolCall({ command: 'Observe', serial: 'A', ...extra });

/** 给 client 的独立探针挂间谍，统计是否还在走旧的两段式路径。 */
function spySeparateProbes(h) {
    const counts = { wakefulness: 0, currentFocus: 0 };
    const originalWake = h.client.wakefulness?.bind(h.client);
    const originalFocus = h.client.currentFocus?.bind(h.client);
    h.client.wakefulness = async (...args) => {
        counts.wakefulness += 1;
        return originalWake ? originalWake(...args) : 'Awake';
    };
    h.client.currentFocus = async (...args) => {
        counts.currentFocus += 1;
        return originalFocus ? originalFocus(...args) : { package: 'com.example', component: null, window: null };
    };
    return counts;
}

const inputs = (h) => h.calls.filter(([kind, args]) => kind === 'adb' && args[1] === 'input');

test('已唤醒时不点亮、不额外轮询', async () => {
    const h = await harness();
    const counts = spySeparateProbes(h);
    const probesBefore = h.calls.filter(([kind]) => kind === 'probe').length;
    await observe(h);
    const probes = h.calls.filter(([kind]) => kind === 'probe').length - probesBefore;
    assert.equal(inputs(h).length, 0, '已唤醒不得派发 input');
    assert.equal(probes, 3, 'initial reused as dump-before + dump-after + read-return; no wake polling');
    assert.deepEqual(counts, { wakefulness: 0, currentFocus: 0 }, '不得走独立的两段式探针');
});

test('息屏时点亮后复用 probeScreen，不再产生独立的 wakefulness/currentFocus 往返', async () => {
    const h = await harness();
    const counts = spySeparateProbes(h);
    // 第一次 probe 报息屏，之后报已唤醒且焦点是前台应用
    let probeCount = 0;
    h.client.probeScreen = async () => {
        probeCount += 1;
        if (probeCount === 1) {
            return { focus: { package: 'com.android.systemui', component: null, window: null },
                size: { width: 100, height: 200 }, wakefulness: 'Asleep' };
        }
        return { focus: { package: 'com.example', component: '.Main', window: null },
            size: { width: 100, height: 200 }, wakefulness: 'Awake' };
    };
    const result = await observe(h);
    assert.equal(inputs(h).length, 1, '应恰好派发一次 KEYCODE_WAKEUP');
    assert.deepEqual(counts, { wakefulness: 0, currentFocus: 0 },
        '点亮后必须复用 probeScreen 的结果，不得再单独往返两次');
    assert.equal(result.details.focus.package, 'com.example', '观察结果应反映点亮后的新焦点');
});

test('点亮轮询有上限：设备一直报息屏时不会挂死', async () => {
    const h = await harness();
    h.client.probeScreen = async () => ({
        focus: { package: 'com.android.systemui', component: null, window: null },
        size: { width: 100, height: 200 }, wakefulness: 'Asleep',
    });
    const at = Date.now();
    const result = await observe(h, { wakeTimeoutMs: 300 });
    const elapsed = Date.now() - at;
    assert.ok(elapsed < 8000, `不得挂死，实际 ${elapsed}ms`);
    assert.equal(inputs(h).length, 1, '仍只派发一次点亮');
    // 点亮失败也要给出观察结果，而不是抛错让模型面对空白
    assert.ok(result.details, '必须返回观察结果');
});

test('wake=never 时即使息屏也不点亮、不轮询', async () => {
    const h = await harness();
    h.client.probeScreen = async () => ({
        focus: {}, size: { width: 100, height: 200 }, wakefulness: 'Asleep',
    });
    await observe(h, { wake: 'never' });
    assert.equal(inputs(h).length, 0, 'wake=never 不得派发点亮');
});

test('实现不得再用 700ms 固定睡眠等待点亮', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
    const text = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    const literals = [...text.matchAll(/pause\(\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
    const big = literals.filter((ms) => ms >= 500);
    assert.deepEqual(big, [], `不得存在 >=500ms 的盲等 pause，实际发现 ${JSON.stringify(big)}`);
});
