'use strict';

/**
 * 真机计算器验证：node scripts/verify-android-actions.cjs [SERIAL] [PACKAGE]
 * 仅手工运行；逐次采集新snapshotId，像素动作使用新frameId，禁止未知结果重试。
 * 参数、过期凭据及输入法错误边界由tests中的隔离契约测试负责。
 */
const path = require('node:path');
const service = require(path.resolve(__dirname, '..', 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));
const quiet = { log() {}, warn() {}, error() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let serial;

async function call(args) {
    const result = await service.processToolCall({ serial, ...args });
    const execution = result.details?.execution;
    if (execution && !['observed', 'dispatched', 'verified'].includes(execution.outcome)) {
        throw new Error(`Step ${execution.outcome}; do not retry blindly: ${JSON.stringify(execution)}`);
    }
    return result;
}
const observe = async () => (await call({ command: 'Observe', mode: 'ui', limit: 200 })).details;
const label = node => String(node.value || node.label || '').trim();
const find = (shot, predicate) => shot.controls.find(node => predicate(node, label(node)));
const clear = (node, text) => /(?:clr|clear)$/.test(node.id || '') || /^(AC|C|清除)$/i.test(text);
async function tap(predicate, name) {
    const shot = await observe();
    const node = find(shot, predicate);
    if (!node) throw new Error(`Missing calculator control: ${name}`);
    await call({ command: 'ExecuteStep', action: { command: 'Tap', index: node.index, snapshotId: shot.snapshotId } });
    await sleep(350);
}

async function main() {
    await service.initialize({ config: { ADB_PATH: process.env.ADB_PATH || 'adb', DISPLAY_PORT: 0 }, logger: quiet });
    try {
        const devices = (await call({ command: 'Describe', topic: 'devices' })).details.devices;
        const online = devices.filter(device => device.state === 'device');
        serial = process.argv[2] || (online.length === 1 ? online[0].serial : null);
        if (!serial || !online.some(device => device.serial === serial)) throw new Error('Specify one authorized online SERIAL');
        const pkg = process.argv[3] || 'com.coloros.calculator';
        await call({ command: 'ExecuteStep', action: { command: 'LaunchApp', package: pkg, stop: true },
            expect: { type: 'foreground', package: pkg }, waitTimeoutMs: 5000 });
        await tap(clear, 'clear');
        for (const symbol of ['1', '+', '2', '=']) {
            await tap((node, text) => text === symbol || ({ '1': /digit_1$/, '2': /digit_2$/, '+': /(?:plus|add)$/, '=': /(?:eq|equal)$/ }[symbol]).test(node.id || ''), symbol);
        }
        await sleep(700);
        const result = await observe();
        const output = find(result, node => /(?:result|formula)$/.test(node.id || ''));
        if (!output || !/(^|[^0-9])3([^0-9]|$)/.test(label(output))) throw new Error(`Expected calculator result 3; got ${JSON.stringify(output ? label(output) : null)}`);
        console.log('PASS: fresh snapshot index actions calculate 1 + 2 = 3');

        const controls = await observe();
        const clearNode = find(controls, clear);
        if (!clearNode) throw new Error('Missing clear control for pixel verification');
        const image = (await call({ command: 'Observe', mode: 'image', grid: false })).details.image;
        await call({ command: 'ExecuteStep', action: { command: 'Tap', x: clearNode.x, y: clearNode.y, frameId: image.frameId } });
        await sleep(500);
        const cleared = await observe();
        const remaining = find(cleared, node => /(?:result|formula)$/.test(node.id || ''));
        if (remaining && !/^(?:0|0\.0)?$/.test(label(remaining))) throw new Error(`Pixel clear did not clear result: ${label(remaining)}`);
        console.log('PASS: fresh image frameId pixel action clears result');
    } finally { await service.cleanup(); }
}
main().catch(error => { console.error(error.code || 'LIVE_ACTION_FAILED', error.message); process.exitCode = 1; });
