'use strict';

/**
 * LaunchApp 的前台校验契约。
 *
 * 背景：`monkey` 在 ColorOS 上会打印 `Events injected: 1` 却什么都不启动。
 * 旧实现只看输出文本里有没有 "Error"，于是把这种情况报成「已请求启动」——
 * 调用方以为打开了，实际还在原界面。
 *
 * 现在的规则：必须读到前台真的变成目标包，才算成功。
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');
const { harness } = require('./helpers/android-service-harness.cjs');

const root = path.resolve(__dirname, '..');
const service = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));
const { waitForForeground, launchApp } = service._internals;

/** 造一个按序列返回前台的假 adb 客户端 */
function focusClient(sequence, { onRunText } = {}) {
    let index = 0;
    const client = {
        serial: 'test:5555',
        runText: async (args) => {
            if (onRunText) {
                const handled = onRunText(args);
                if (handled !== undefined) return handled;
            }
            // 包存在性检查
            if (args[0] === 'shell' && args[1] === 'pm' && args[2] === 'list') {
                return `package:${args[4] || 'com.test.app'}`;
            }
            return '';
        },
        async currentFocus() {
            const pkg = sequence[Math.min(index, sequence.length - 1)];
            index += 1;
            return { package: pkg, component: pkg ? `${pkg}/.Main` : null, window: null };
        },
    };
    return client;
}

test('waitForForeground：第一次就对上前台时立刻返回', async () => {
    const client = focusClient(['com.test.app']);
    const started = Date.now();
    const result = await waitForForeground(client, 'com.test.app', 3000);
    assert.equal(result.package, 'com.test.app');
    assert.ok(Date.now() - started < 500, '不该白等');
});

test('waitForForeground：慢启动时轮询到出现为止', async () => {
    // 模拟冷启动：前几次还在原界面
    const client = focusClient(['com.launcher', 'com.launcher', 'com.test.app']);
    const result = await waitForForeground(client, 'com.test.app', 5000);
    assert.equal(result.package, 'com.test.app');
});

test('waitForForeground：超时返回最后观察到的前台，不谎报', async () => {
    const client = focusClient(['com.launcher']);
    const result = await waitForForeground(client, 'com.test.app', 800);
    assert.equal(result.package, 'com.launcher', '超时后必须如实返回原前台');
});

test('waitForForeground：currentFocus 抛错时不崩', async () => {
    let calls = 0;
    const client = {
        async currentFocus() {
            calls += 1;
            if (calls < 2) throw new Error('adb 抽风');
            return { package: 'com.test.app', component: 'com.test.app/.Main' };
        },
    };
    // 第一次抛错应被吞掉继续重试
    const result = await waitForForeground(client, 'com.test.app', 2000);
    assert.equal(result.package, 'com.test.app');
});

test('launchApp：包不存在时抛 APP_NOT_FOUND，且信息可读', async () => {
    const client = {
        serial: '',
        runText: async (args) => {
            if (args[2] === 'list') return '';   // 空 = 没这个包
            throw new Error('不该走到这里');
        },
        async currentFocus() { return { package: null, component: null }; },
    };
    // launchApp 内部走 requireAdb()，测试通过 context.client 注入
    await assert.rejects(
        () => launchApp({ package: 'com.nonexistent.fake.app' }, { client }),
        (error) => {
            assert.equal(error.code, 'APP_NOT_FOUND');
            assert.match(error.message, /设备上没有/);
            assert.ok(!/^\s*args:/.test(error.message), '不能把 adb 原始输出抛给调用方');
            return true;
        },
    );
});

test('launchApp：processToolCall 传空上下文时不会把 {} 当成 client', async () => {
    // 回归：曾经写成 clientOverride || requireAdb()，而 executionContext 恒为 {},
    // 于是 truthy 命中，运行时报 client.runText is not a function
    await assert.rejects(
        () => launchApp({ package: 'com.test.whatever' }, {}),
        (error) => {
            // 没初始化 adb 时应得到「adb 未初始化」这类错误，
            // 绝不能是 client.runText is not a function
            assert.ok(!/runText is not a function/.test(error.message), error.message);
            return true;
        },
    );
});

test('launchApp：查询包失败时不能谎报 APP_NOT_FOUND', async () => {
    // 真机踩到：设备有两条记录（真实地址 + mDNS 名），pm list 报 multi-device，
    // 旧逻辑把「查不到」当成「包不存在」，直接拒绝启动一个明明装着的应用。
    const calls = [];
    const client = {
        serial: 'x:1',
        async runText(args) {
            calls.push(args.join(' '));
            if (args[2] === 'list') throw new Error('error: more than one device/emulator');
            if (args.includes('resolve-activity')) return 'com.test.app/.Main';
            return '';
        },
        async currentFocus() { return { package: 'com.test.app', component: 'com.test.app/.Main' }; },
    };
    const h = await harness({ client: { ...client, serial: 'A' } });
    try {
        const result = await h.service.processToolCall({ command: 'ExecuteStep',
            action: { command: 'LaunchApp', package: 'com.test.app' } });
        assert.equal(result.details.ok, true, '查询失败不该阻止启动');
        assert.ok(calls.some((c) => c.includes('resolve-activity')), '应该继续尝试启动');
    } finally { await h.service.cleanup(); }
});
