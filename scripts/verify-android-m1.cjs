'use strict';

/**
 * M1 真机动作验收：node scripts/verify-android-m1.cjs SERIAL [--fill] [--unicode] [--touch] [--password] [--all]
 *
 * 判据不采信插件自报的 outcome，每一项都用新的 Observe 独立读回：
 * - Fill 非空：执行后 value 必须等于写入文本（插件回执应为 verified）
 * - Fill 清空：执行后 value 必须为空
 * - Unicode：InputText 派发后独立读回必须等于原串（插件只回 dispatched，不声称已验证）
 * - 触摸：Tap/LongPress/Swipe 的 attempts[0].channel 必须是 rpc，出现 shell 回退即判失败
 *
 * 不在锁屏、无可见文本字段或字段不唯一的页面上继续；unknown/failed 立即停止，不重试。
 */
const path = require('node:path');
const service = require(path.resolve(__dirname, '..', 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));

const quiet = { log() {}, warn() {}, error() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const FILL_TEXT = 'Ayari-M1-2026';
const UNICODE_TEXT = '绫织M1验收';
const TERMINAL = ['observed', 'dispatched', 'verified'];

let serial;
const results = [];

function record(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(JSON.stringify({ verdict: pass ? 'PASS' : 'FAIL', name, detail }));
}

async function call(args) {
    const result = await service.processToolCall({ serial, ...args });
    const execution = result.details?.execution;
    if (execution && !TERMINAL.includes(execution.outcome)) {
        throw Object.assign(new Error(`Step ${execution.outcome}；不得盲目重试`), { execution });
    }
    return result;
}

const observe = async () => (await call({ command: 'Observe', mode: 'ui', limit: 200 })).details;
// 文本字段的当前内容在 label 里，不在 value 里：argent-uiautomator 的 makeUiNode 只在
// text 与 label 不同时才写 value，而 textfield 的 text 就是它自己的 label（真机实测，
// com.coloros.note 编辑页 fill 后 label="Ayari-M1-2026"、value=""）。读回必须两处都看。
const textOf = node => {
    const label = String(node?.label ?? '');
    const value = String(node?.value ?? '');
    return label || value;
};
const isField = node => node.role === 'textfield' && node.enabled && node.inViewport
    && !node.flags.includes('password');
const isPassword = node => node.role === 'textfield' && node.enabled && node.inViewport
    && node.flags.includes('password');

function uniqueField(shot, predicate, what) {
    const matches = shot.controls.filter(predicate);
    if (matches.length === 0) throw new Error(`当前页面没有${what}；先把设备停到靶场页面`);
    if (matches.length > 1) {
        throw new Error(`${what}不唯一（${matches.length} 个）：${matches.map(n => `${n.index}:${n.id || n.label}`).join(', ')}`);
    }
    return matches[0];
}

/**
 * 读回不按 index 硬取：字段内容变化可能让控件被剪枝或重排。
 * 顺序为 index 命中 → resource-id 唯一命中 → 全页唯一文本字段；都不成立则返回 null（判失败，不猜）。
 */
function reread(shot, hint) {
    const direct = shot.controls[hint.index];
    if (direct && isField(direct)) return textOf(direct);
    if (hint.id) {
        const byId = shot.controls.filter(node => node.id === hint.id && isField(node));
        if (byId.length === 1) return textOf(byId[0]);
    }
    const fields = shot.controls.filter(isField);
    return fields.length === 1 ? textOf(fields[0]) : null;
}

async function target() {
    const shot = await observe();
    if (shot.keyguard) throw new Error('设备已锁定，拒绝在锁屏上做动作验收');
    return { shot, node: uniqueField(shot, isField, '可见文本输入框') };
}

async function fill(scene, text) {
    const { shot, node } = scene;
    const result = await call({
        command: 'ExecuteStep',
        action: { command: 'Fill', index: node.index, snapshotId: shot.snapshotId, text },
        timeoutMs: 20000,
    });
    await sleep(300);
    const after = await observe();
    return { execution: result.details.execution, actual: reread(after, node), expected: text };
}

async function checkFillNonEmpty() {
    const { execution, actual, expected } = await fill(await target(), FILL_TEXT);
    const match = actual === expected;
    record('M1.2 Fill 非空 setText', execution.outcome === 'verified' && match, {
        outcome: execution.outcome, expected, independentReread: actual, match,
        channel: execution.channels,
        note: '回执 verified 且独立读回一致才算通过',
    });
}

async function checkFillClear() {
    const { execution, actual } = await fill(await target(), '');
    record('M1.2 Fill 空串 clearTextField', execution.outcome === 'verified' && actual === '', {
        outcome: execution.outcome, independentReread: actual, cleared: actual === '',
        channel: execution.channels,
    });
}

async function checkPassword() {
    const shot = await observe();
    if (shot.keyguard) throw new Error('设备已锁定');
    const node = uniqueField(shot, isPassword, '密码输入框');
    const result = await call({
        command: 'ExecuteStep',
        action: { command: 'Fill', index: node.index, snapshotId: shot.snapshotId, text: FILL_TEXT },
        timeoutMs: 20000,
    });
    const execution = result.details.execution;
    const echoed = JSON.stringify(result).includes(FILL_TEXT);
    record('M1.2 Fill 密码框不读回、不回显', execution.outcome === 'dispatched' && !echoed, {
        outcome: execution.outcome, valueEchoed: echoed, channel: execution.channels,
        note: '出现 verified 或任何值回显都判失败',
    });
}

async function checkUnicode() {
    // 先清空再聚焦，避免中文插进残留文本中间造成读回含混。
    await fill(await target(), '');
    const scene = await target();
    await call({
        command: 'ExecuteStep',
        action: { command: 'Tap', index: scene.node.index, snapshotId: scene.shot.snapshotId },
        timeoutMs: 20000,
    });
    await sleep(300);
    const dispatch = await call({
        command: 'ExecuteStep',
        action: { command: 'InputText', text: UNICODE_TEXT },
        timeoutMs: 20000,
    });
    const execution = dispatch.details.execution;
    await sleep(600);
    const after = await observe();
    const actual = reread(after, scene.node);
    record('M1.4 Unicode 剪贴板粘贴', actual === UNICODE_TEXT && execution.outcome === 'dispatched', {
        outcome: execution.outcome, channel: execution.channels, clipboard: execution.clipboard,
        independentReread: actual, expected: UNICODE_TEXT, pasted: actual === UNICODE_TEXT,
        note: '插件只回 dispatched；这里由独立读回给出实际值判定',
    });
}

async function checkTouch() {
    // channels/attempts 在 details 顶层，不在 execution 里（真机回执实测）。
    const scene = await target();
    const { shot, node } = scene;
    const tap = await call({
        command: 'ExecuteStep',
        action: { command: 'Tap', index: node.index, snapshotId: shot.snapshotId },
        timeoutMs: 20000,
    });
    record('M1.3 Tap 走 RPC', tap.details.channels?.[0] === 'rpc', {
        channels: tap.details.channels, method: tap.details.attempts?.[0]?.method,
        outcome: tap.details.execution.outcome,
        note: '出现 shell 回退说明 RPC 未生效，判失败',
    });

    const longScene = await target();
    const long = await call({
        command: 'ExecuteStep',
        action: { command: 'LongPress', index: longScene.node.index, snapshotId: longScene.shot.snapshotId },
        timeoutMs: 20000,
    });
    record('M1.3 LongPress 走 RPC', long.details.channels?.[0] === 'rpc', {
        channels: long.details.channels, method: long.details.attempts?.[0]?.method,
        outcome: long.details.execution.outcome,
    });

    // Swipe 的坐标是设备坐标（不是缩放图坐标），frameId 必须来自新的 image 快照。
    const imageDetails = (await call({ command: 'Observe', mode: 'image', grid: false })).details;
    const frame = imageDetails.image;
    const screen = imageDetails.screen || shot.screen;
    const clamp = (value, max) => Math.max(1, Math.min(max - 2, Math.round(value)));
    const x = clamp(node.x, screen.width);
    const y1 = clamp(node.y + 80, screen.height);
    const y2 = clamp(node.y - 80, screen.height);
    const swipe = await call({
        command: 'ExecuteStep',
        action: { command: 'Swipe', x1: x, y1, x2: x, y2, duration: 300, frameId: frame.frameId },
        timeoutMs: 20000,
    });
    record('M1.3 Swipe 走 RPC', swipe.details.channels?.[0] === 'rpc', {
        channels: swipe.details.channels, method: swipe.details.attempts?.[0]?.method,
        outcome: swipe.details.execution.outcome,
        from: [x, y1], to: [x, y2], deviceScreen: screen,
    });
}

async function main() {
    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter(arg => arg.startsWith('--')));
    const positional = argv.filter(arg => !arg.startsWith('--'));
    const wants = name => flags.has('--all') || flags.has(name);

    await service.initialize({
        config: { ADB_PATH: process.env.ADB_PATH || 'adb', DISPLAY_PORT: 0 },
        logger: quiet,
    });
    try {
        const devices = (await call({ command: 'Describe', topic: 'devices' })).details.devices;
        const online = devices.filter(device => device.state === 'device');
        serial = positional[0] || (online.length === 1 ? online[0].serial : null);
        if (!serial || !online.some(device => device.serial === serial)) {
            throw new Error('需要且仅需要一个已授权的在线设备；设备未连接时不跑动作验收');
        }
        console.log(JSON.stringify({ phase: 'ready', serial }));

        const probe = await observe();
        console.log(JSON.stringify({
            phase: 'probe', package: probe.focus?.package, controls: probe.controls.length,
            keyguard: probe.keyguard, textfields: probe.controls.filter(isField).map(n => n.index),
            passwordFields: probe.controls.filter(isPassword).map(n => n.index),
        }));
        if (probe.keyguard) throw new Error('设备已锁定：先解锁并停到靶场页面');

        const plan = [];
        if (wants('--fill')) plan.push(['Fill 非空', checkFillNonEmpty], ['Fill 清空', checkFillClear]);
        if (wants('--unicode')) plan.push(['Unicode 粘贴', checkUnicode]);
        if (wants('--touch')) plan.push(['触摸 RPC', checkTouch]);
        if (wants('--password')) plan.push(['密码框', checkPassword]);
        if (!plan.length) throw new Error('至少指定 --fill/--unicode/--touch/--password 之一，或 --all');

        for (const [name, task] of plan) {
            try {
                await task();
            } catch (error) {
                record(name, false, { error: error.code || 'FAILED', message: error.message, execution: error.execution });
            }
        }
    } finally {
        await service.cleanup();
    }

    const failed = results.filter(item => !item.pass);
    console.log(JSON.stringify({
        phase: 'summary', total: results.length,
        pass: results.length - failed.length, fail: failed.length,
    }));
    if (failed.length) process.exitCode = 1;
}

main().catch(error => {
    console.error(JSON.stringify({
        phase: 'aborted', code: error.code || 'M1_ACCEPTANCE_ABORTED', message: error.message,
    }));
    process.exitCode = 1;
});
