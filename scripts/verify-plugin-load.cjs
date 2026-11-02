'use strict';

/**
 * 插件装载验证。
 * 复刻 VCPDistributedServer/Plugin.js 的 discoverPlugins + initializeServicePlugins 流程，
 * 确认 AndroidController 能被真实 PluginManager 装载、初始化、并响应工具调用。
 *
 * 运行：node scripts/verify-plugin-load.cjs
 */

const path = require('path');
const express = require('express');

const root = path.resolve(__dirname, '..');
const serviceScript = path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
const manifestPath = path.join(root, 'VCPDistributedServer/Plugin/AndroidController/plugin-manifest.json');

const manifest = require(manifestPath);

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ✓ ${label}`);
    else { failures += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
    console.log('插件装载验证\n');

    // 1) 清单合法性（Plugin.js:125-131 的校验条件）
    console.log('清单：');
    check('name 非空', Boolean(manifest.name));
    check('pluginType 受支持', ['service', 'hybridservice', 'static', 'asynchronous'].includes(manifest.pluginType));
    check('entryPoint 存在', Boolean(manifest.entryPoint));
    check('direct 协议', manifest.communication?.protocol === 'direct');

    // 2) 模块可 require 且导出必需接口（Plugin.js:332-346）
    console.log('\n模块接口：');
    const module_ = require(serviceScript);
    check('导出 initialize', typeof module_.initialize === 'function');
    check('导出 processToolCall', typeof module_.processToolCall === 'function');
    check('导出 cleanup', typeof module_.cleanup === 'function');

    // 3) 模拟 PluginManager 的 initialize 调用签名（Plugin.js:338-345）
    console.log('\n初始化（复刻 PluginManager 调用签名）：');
    const app = express();
    const config = {
        ADB_PATH: 'D:\\AI\\tools\\platform-tools\\adb.exe',
        DEVICE_SERIAL: '',
        ADB_TIMEOUT_MS: 20000,
        DISPLAY_PORT: 0,
        STREAM_FORMAT: 'jpeg',
        STREAM_QUALITY: 70,
        STREAM_INTERVAL_MS: 400,
        STREAM_MAX_WIDTH: 540,
    };

    const originalLog = console.log;
    try {
        await module_.initialize({
            app,
            adminApiRouter: null,
            projectBasePath: root,
            config,
            services: {},
            logger: { log: () => {}, warn: () => {}, error: (m) => originalLog(`    [plugin-error] ${m}`) },
        });
        check('initialize 未抛异常', true);
    } catch (error) {
        check('initialize 未抛异常', false, error.message);
        process.exit(1);
    }

    const status = module_.getRuntimeStatus();
    check('adb 路径已生效', status.adbPath === config.ADB_PATH, status.adbPath);
    check('显示屏已拉起', Boolean(status.displayUrl), String(status.displayUrl));

    // 4) 真实工具调用
    console.log('\n工具调用：');
    const described = await module_.processToolCall({ command: 'Describe', topic: 'overview' });
    check('Describe 返回 content 数组', Array.isArray(described.content) && described.content[0].type === 'text');
    check('Describe 返回 details', typeof described.details === 'object');
    check('清单只发布四正式入口', JSON.stringify(manifest.capabilities.invocationCommands.map(entry => entry.command))
        === JSON.stringify(['Describe', 'Observe', 'ExecuteStep', 'Manage']));

    const displayStatus = await module_.processToolCall({ command: 'Manage', operation: 'displayStatus' });
    check('Manage displayStatus 正常返回', displayStatus.content[0].text.includes('显示屏'));

    // 5) HTTP 服务可达
    console.log('\n显示屏服务：');
    const url = status.displayUrl;
    const health = await fetch(`${url}/health`);
    check('/health 200', health.status === 200);
    const viewer = await fetch(`${url}/`);
    const html = await viewer.text();
    check('/ 返回查看器页面', viewer.status === 200 && html.includes('Android 显示屏'));

    // 6) 清理
    console.log('\n清理：');
    await module_.cleanup();
    check('cleanup 未抛异常', true);
    const afterHealth = await fetch(`${url}/health`).then(() => 'still-up').catch(() => 'down');
    check('cleanup 后服务已关闭', afterHealth === 'down', afterHealth);

    console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('验证失败：', error);
    process.exit(1);
});
