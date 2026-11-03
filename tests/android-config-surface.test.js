'use strict';

/**
 * 配置面闭环契约（M0）。
 *
 * 背景：`VCPDistributedServer/Plugin.js:73` 只把 configSchema 里声明过的键拼进
 * plugin config，没声明 = 该键永远到不了 runtime.config，设置界面也不可见，
 * 用户只能手工改 config.env。因此「代码读了但没声明」不是小瑕疵，是配置失效。
 *
 * 四条契约：
 * 1. 代码读的每个键都声明了；声明的每个键都有人读（不留空头支票）。
 * 2. 声明过的键都出现在 config.env.example，装完就能照着改。
 * 3. schema 的 default 与代码里的回退字面量一致，不允许两处各说各话。
 * 4. UI_SERVER 的语义可观测：默认走常驻 RPC；关掉时连启动都不尝试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness } = require('./helpers/android-service-harness.cjs');

const ROOT = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController');
const manifest = require('../VCPDistributedServer/Plugin/AndroidController/plugin-manifest.json');
const schema = manifest.configSchema;

function serviceSource() {
    return fs.readFileSync(path.join(ROOT, 'AndroidControllerService.js'), 'utf8');
}

function allSources() {
    const files = [path.join(ROOT, 'AndroidControllerService.js')];
    const libDir = path.join(ROOT, 'lib');
    for (const name of fs.readdirSync(libDir)) {
        if (name.endsWith('.js')) files.push(path.join(libDir, name));
    }
    return files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
}

/** `runtime.config ?. KEY` / `config.KEY`，只认全大写常量名，避开 config.env 之类的字符串。 */
function consumedKeys() {
    const keys = new Set();
    for (const match of allSources().matchAll(/config\??\.([A-Z][A-Z0-9_]{2,})/g)) keys.add(match[1]);
    return keys;
}

test('代码读取的配置键与 configSchema 声明完全一致', () => {
    const declared = new Set(Object.keys(schema));
    const used = consumedKeys();
    const undeclared = [...used].filter(key => !declared.has(key)).sort();
    const unused = [...declared].filter(key => !used.has(key)).sort();

    assert.deepEqual(undeclared, [],
        `这些键被代码读取但没声明，Plugin.js 不会注入它们：${undeclared.join(', ')}`);
    assert.deepEqual(unused, [],
        `这些键声明了但没人读，设置界面会给出无效开关：${unused.join(', ')}`);
});

test('config.env.example 列出全部声明键', () => {
    const example = fs.readFileSync(path.join(ROOT, 'config.env.example'), 'utf8');
    const missing = Object.keys(schema)
        .filter(key => !new RegExp(`^${key}=`, 'm').test(example))
        .sort();
    assert.deepEqual(missing, [], `模板缺少这些键，装完无从修改：${missing.join(', ')}`);
});

test('schema 默认值与代码回退字面量一致', () => {
    const table = [
        ['UI_SERVER', true, /config\?\.UI_SERVER[^\n]*'true'/],
        ['AUTO_WAKE', true, /config\?\.AUTO_WAKE[^\n]*'true'/],
        ['LOOM_APP_ID', 'android-mirror', /config\.LOOM_APP_ID[^\n]*'android-mirror'/],
        ['STREAM_CAPTURE_MODE', 'auto', /config\.STREAM_CAPTURE_MODE[^\n]*'auto'/],
    ];
    const source = serviceSource();
    for (const [key, expected, pattern] of table) {
        assert.ok(schema[key], `${key} 未声明`);
        assert.deepEqual(schema[key].default, expected, `${key} 的 default 与代码回退不一致`);
        assert.equal(schema[key].type, typeof expected === 'boolean' ? 'boolean' : 'string',
            `${key} 的 type 与 default 类型不匹配`);
        assert.match(source, pattern, `${key} 的代码回退字面量与 schema 默认值不符`);
    }
});

test('UI_SERVER 默认开启：控件树走常驻 RPC，不跑 CLI dump', async () => {
    const h = await harness({ uiServer: { ok: true } });
    await h.service.processToolCall({ command: 'Observe', serial: 'A' });

    assert.equal(h.uiServer.started, 1, '默认应尝试常驻服务');
    assert.equal(h.uiServer.dumped, 1, '控件树应由常驻服务提供');
    const cliDumps = h.calls.filter(([, args]) => Array.isArray(args) && args.includes('uiautomator'));
    assert.equal(cliDumps.length, 0, 'RPC 可用时不应再跑 CLI dump');
});

test('UI_SERVER 关闭：连启动都不尝试，直接回退 CLI', async () => {
    for (const off of ['false', false, 'off', '0']) {
        const h = await harness({ config: { UI_SERVER: off }, uiServer: { ok: true } });
        await h.service.processToolCall({ command: 'Observe', serial: 'A' });

        assert.equal(h.uiServer.started, 0, `UI_SERVER=${JSON.stringify(off)} 时不应启动常驻服务`);
        assert.equal(h.uiServer.dumped, 0);
        const cliDumps = h.calls.filter(([, args]) => Array.isArray(args) && args.includes('uiautomator'));
        assert.equal(cliDumps.length, 1, `UI_SERVER=${JSON.stringify(off)} 时应走 CLI dump`);
    }
});
