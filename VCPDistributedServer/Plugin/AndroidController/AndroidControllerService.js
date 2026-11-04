'use strict';

/**
 * AndroidController — 通过 adb 让 Agent 感知与操作 Android 设备。
 *
 * 设计要点：
 * - execFile 数组参数只避免宿主 shell；设备端参数仍需语法校验或 shell 引用。
 * - 感知优先 UIA 树，截图只作兜底。原始 XML 会压成索引表再交给模型。
 * - 所有动作都有超时；对同一设备串行化，避免 screencap 与 uiautomator 互抢。
 */

const { AdbClient, AdbError } = require('./lib/adb');
const {
    DEFAULT_LIMIT,
    parseUiGraph,
    parseBounds,
    renderView,
    resolveSelector,
    samePage,
} = require('./lib/ui-graph');
const { validateSelector: isValidSelector } = require('./lib/selector');
const { waitForExpectation } = require('./lib/expectation-wait');
const { waitForIdle } = require('./lib/idle-wait');
const { screenContext, layoutEvidence } = require('./lib/layout-evidence');


const { FrameHub } = require('./lib/frame-hub');
const vision = require('./lib/vision');
const { ScrcpyHub } = require('./lib/scrcpy-hub');
const { UiServer } = require('./lib/ui-server');
const { StreamServer } = require('./lib/stream-server');
const fs = require('node:fs');
const { parseHostPort, parsePairCode, localAddresses, probePort, diagnoseEndpoint, scanSubnets, scanLocalNetwork } = require('./lib/device-network');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { URL } = require('node:url');
const stepRuntime = require('./lib/step-runtime');
const { arbitrate } = require('./lib/text-arbiter');
const { queryGitHub, capability: githubCapability } = require('./lib/github-query');
const { executeSystem, catalog: systemCatalog } = require('./lib/system-api');
const toolCatalog = require('./lib/tool-catalog');
const rpcMethods = require('./lib/rpc-methods');
const elementShot = require('./lib/element-shot').createElementShot({ runtime: stepRuntime, vision,
    prepareTarget, getRecord: serial => lastObserve.get(serial), captureGraph, resolveSelector, intOf, validateSelector, graphLayout });
const { syncLoomAppUrl } = require('./lib/loom-display-url');

const DEFAULT_DUMP_TIMEOUT_MS = 25000;
// 快照与图像凭据超过此年龄后拒绝执行。
const STALE_SNAPSHOT_MS = 15000;
const MAX_TEXT_INPUT = 2000;
const ADB_KEYBOARD_PACKAGE = 'com.android.adbkeyboard';

const KEY_ALIASES = Object.freeze({
    back: 'KEYCODE_BACK',
    home: 'KEYCODE_HOME',
    recents: 'KEYCODE_APP_SWITCH',
    appswitch: 'KEYCODE_APP_SWITCH',
    menu: 'KEYCODE_MENU',
    enter: 'KEYCODE_ENTER',
    tab: 'KEYCODE_TAB',
    space: 'KEYCODE_SPACE',
    delete: 'KEYCODE_DEL',
    backspace: 'KEYCODE_DEL',
    forwarddelete: 'KEYCODE_FORWARD_DEL',
    escape: 'KEYCODE_ESCAPE',
    volumeup: 'KEYCODE_VOLUME_UP',
    volumedown: 'KEYCODE_VOLUME_DOWN',
    mute: 'KEYCODE_VOLUME_MUTE',
    power: 'KEYCODE_POWER',
    wakeup: 'KEYCODE_WAKEUP',
    sleep: 'KEYCODE_SLEEP',
    up: 'KEYCODE_DPAD_UP',
    down: 'KEYCODE_DPAD_DOWN',
    left: 'KEYCODE_DPAD_LEFT',
    right: 'KEYCODE_DPAD_RIGHT',
    center: 'KEYCODE_DPAD_CENTER',
    camera: 'KEYCODE_CAMERA',
    search: 'KEYCODE_SEARCH',
});

let runtime = {
    logger: console,
    config: {},
    loomManager: null,
    jevService: null,
};

let adb = null;
let frameHub = null;
let scrcpyHub = null;
let streamServer = null;
let displayStarting = null;

// 每台设备的最近一次 Observe 结果，供 index 寻址使用
const lastObserve = new Map();
const lastVision = new Map();
const uncertainDevices = new Set();

async function withDeviceRpc(serial, task) {
    assertDeviceCertain(serial);
    try { return await task(); }
    catch (error) {
        // A local socket closing is not evidence that the remote request finished.
        if (error.dispatched !== false && error.drained !== true) {
            uncertainDevices.add(serial);
            lastObserve.delete(serial);
            lastVision.delete(serial);
        }
        throw error;
    }
}

function assertDeviceCertain(serial) {
    if (uncertainDevices.has(serial)) throw stepRuntime.failure('DEVICE_STATE_UNCERTAIN', '先前RPC传输结局未知，设备已隔离；人工确认旧设备服务终止后重启插件，不能靠重试或普通重连解除。');
}
// ADBKeyboard 可用性缓存（包名 → boolean）
const adbKeyboardCache = new Map();

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function commandOf(args = {}) {
    return firstString(args.command, args.action, args.commandIdentifier).toLowerCase();
}

function intOf(value, fieldName, fallback = null) {
    if (value === undefined || value === null || value === '') return fallback;
    if ((typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && !/^-?\d+$/.test(value))
        || !Number.isSafeInteger(Number(value))) {
        throw stepRuntime.failure('INVALID_ARGUMENT', `${fieldName} 必须是安全整数或十进制整数字符串。`);
    }
    return Number(value);
}

function requireInt(value, fieldName) {
    const parsed = intOf(value, fieldName);
    if (parsed === null) throw stepRuntime.failure('INVALID_ARGUMENT', `缺少必需参数 ${fieldName}。`);
    return parsed;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * 解析配置里的可选整数。与 `parseInt(x) || undefined` 的区别：
 * 0 是合法输入（如 DISPLAY_PORT=0 表示随机端口），不能被当成缺失。
 */
function parseOptionalInt(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 为设备侧 shell 做单引号转义。仅用于必须由 shell 解释的文本参数。
 * `'` → `'\''` 是 POSIX sh / mksh / toybox 通用的安全写法。
 */
function shellQuote(value) {
    const text = String(value ?? '');
    return `'${text.replace(/'/g, "'\\''")}'`;
}

function textResult(text, details = {}) {
    return {
        content: [{ type: 'text', text }],
        details,
    };
}

function resolveSerial(args = {}) {
    const serial = firstString(args.serial, args.device, args.deviceSerial);
    if (serial) return serial;
    return adb?.serial || '';
}
async function selectDevice(client, serial) {
    stepRuntime.assertManagementIdle();
    if (client !== adb) {
        client.serial = serial;
        return;
    }
    if (client.serial === serial) return;
    await streamServer.changeDevice(() => {
        client.serial = serial;
        scrcpyHub.configure({ serial: serial || undefined });
        frameHub.invalidateSelection();
        lastObserve.clear();
        lastVision.clear();
        adbKeyboardCache.clear();
    }, { resume: Boolean(serial) });
}


function requireAdb() {
    if (!adb) throw new Error('[AndroidController] adb 客户端尚未初始化。');
    return adb;
}

// ---------------------------------------------------------------------------
// 设备与连接
// ---------------------------------------------------------------------------

async function listDevices() {
    const client = requireAdb();
    const devices = await client.devices();

    if (devices.length === 0) {
        return textResult(
            '未发现任何已连接设备。\n'
            + '无线调试：手机「开发者选项 → 无线调试」开启后，先 Connect 配对，再 Connect 连接。\n'
            + 'USB 调试：插线后在手机上点「允许 USB 调试」。',
            { devices: [], count: 0 },
        );
    }

    const lines = devices.map((device) => {
        const model = device.model ? device.model.replace(/_/g, ' ') : '(未知型号)';
        const marker = device.state === 'device' ? '✓' : '✗';
        const hint = device.state === 'unauthorized'
            ? '  ← 需在手机上点「允许 USB 调试」'
            : device.state === 'offline'
                ? '  ← 设备离线，尝试 adb reconnect'
                : '';
        return `${marker} ${device.serial}  ${model}  [${device.state}]${hint}`;
    });

    const current = client.serial ? `\n\n当前选用设备：${client.serial}` : '\n\n尚未选定设备，请用 Connect 指定 serial。';
    return textResult(`已连接设备（${devices.length}）：\n${lines.join('\n')}${current}`, {
        devices,
        count: devices.length,
        currentSerial: client.serial || null,
    });
}

async function connectDevice(args = {}) {
    stepRuntime.assertManagementIdle();
    const client = requireAdb();
    const mode = firstString(args.mode, args.type).toLowerCase() || 'auto';
    const serial = firstString(args.serial, args.address, args.host);
    if (mode === 'pair') {
        const result = await deviceApi.pair({
            address: firstString(args.address, args.serial),
            code: firstString(args.code, args.pairingCode),
        });
        if (!result.ok) throw withHint(new Error(result.error), result.hint);
        return textResult(result.message, result);
    }
    if (mode === 'usb') {
        if (!serial) throw new Error('[AndroidController] USB 连接需要 serial。先调用 ListDevices 获取。');
        await ensureActiveDevice(client, serial);
        await selectDevice(client, serial);
        return textResult(`已选定 USB 设备 ${serial}。`, { ok: true, mode, serial, state: 'device' });
    }
    if (!['auto', 'wireless'].includes(mode)) throw new Error(`[AndroidController] 不支持的连接模式：${mode}`);
    const result = await deviceApi.connect({ address: serial || undefined });
    return textResult(result.message, result);
}





/** 已连接 → 缓存地址 → mDNS → LAN 兜底；所有探测共享预算，设备切换等待旧流安全退出。 */
async function autoConnectDevice(client, options = {}) {
    stepRuntime.assertManagementIdle();
    const deadlineMs = options.deadlineMs ?? Date.now() + (options.budgetMs ?? 15000);
    const remaining = (cap) => {
        const ms = Math.min(cap, deadlineMs - Date.now());
        if (ms <= 0) throw Object.assign(new Error('[AndroidController] 连接预算已耗尽。'), { code: 'CONNECT_TIMEOUT' });
        return ms;
    };
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const address = options.address ? normalizeConnectAddress(parseHostPort(options.address, 5555).address) : '';
    const known = address || firstString(options.serial, client.serial);
    const sameTarget = (serial) => !known || serial === known
        || (!address && known.includes(':') && serial.replace(/:\d+$/, '') === known.replace(/:\d+$/, ''));
    const devices = await client.devices({ timeoutMs: remaining(10000), deadlineMs }).catch(() => []);
    const ready = devices.find((device) => device.state === 'device' && sameTarget(device.serial));
    if (ready) {
        await selectDevice(client, ready.serial);
        return { ok: true, action: 'already-connected', serial: ready.serial, address: ready.serial,
            state: 'device', model: ready.model || null, autoDiscovered: !address, message: `已连接 ${ready.model || ready.serial}`, devices };
    }

    const failures = [];
    const tried = new Set();
    const tryConnect = async (candidate) => {
        const target = candidate.address;
        if (!target || tried.has(target) || !sameTarget(target)) return null;
        tried.add(target);
        try {
            const timeoutMs = remaining(12000);
            const result = options.connect
                ? await options.connect(target, { timeoutMs, deadlineMs })
                : { output: await client.runText(['connect', target], { noSelector: true, timeoutMs, deadlineMs }) };
            if (result.ok === false || /cannot|failed|refused|unable/i.test(result.output || '')) {
                failures.push(`${target}: ${result.output || 'connect 失败'}`);
                return null;
            }
            const state = await waitForDeviceState(client, target, remaining(5000), sleep, deadlineMs);
            if (state === 'unauthorized') {
                throw withHint(Object.assign(new Error(`[AndroidController] ${target} 已连接但未授权。`), { code: 'UNAUTHORIZED' }),
                    '在手机上确认「允许 USB 调试」，或重新配对。');
            }
            if (state !== 'device') {
                failures.push(`${target}: 状态 ${state}`);
                return null;
            }
            await selectDevice(client, target);
            if (client === adb) writeDeviceCache(target);
            return { ok: true, action: 'connected', serial: target, address: target, state,
                source: candidate.source || 'mdns', autoDiscovered: !address, message: `已连接 ${target}` };
        } catch (error) {
            if (error.code === 'UNAUTHORIZED' || error.code === 'CONNECT_TIMEOUT') throw error;
            failures.push(`${target}: ${error.message}`);
            return null;
        }
    };

    // 自定义发现用于隔离测试/调用方策略，不读取宿主的持久缓存。
    const cached = !options.discover && !address ? readDeviceCache()?.address : null;
    const preferred = address || (known.includes(':') ? known : cached);
    if (preferred) {
        const connected = await tryConnect({ address: preferred, source: 'cached' });
        if (connected) return connected;
    }
    if (!address) {
        const discoverOptions = {
            waitMs: Math.min(4000, remaining(4000)), fallbackScan: options.portScan !== false, deadlineMs,
            scanDeadlineMs: deadlineMs - Math.min(3000, Math.max(0, deadlineMs - Date.now()) / 3),
        };
        const found = await (options.discover
            ? options.discover(discoverOptions)
            : discoverDevices(client, discoverOptions)).catch(() => null);
        remaining(1);
        const candidates = (found?.connect || []).filter((candidate) => candidate?.address && !candidate.connected)
            .sort((a, b) => rankSource(b.source) - rankSource(a.source));
        for (const candidate of candidates) {
            const connected = await tryConnect(candidate);
            if (connected) return connected;
        }
    }
    const detail = failures.slice(0, 3).join('；');
    throw withHint(Object.assign(new Error(failures.length
        ? `[AndroidController] 候选设备无法连接。${detail}`
        : '[AndroidController] 没有找到可连接的手机。'), { code: failures.length ? 'CONNECT_FAILED' : 'NO_DEVICE' }),
        '确认手机「无线调试」已打开；首次使用先配对，mDNS 不可用时填写手机的 IP:端口。');
}

function rankSource(source) {
    if (source === 'connected') return 3;
    if (source === 'mdns') return 2;
    return 1;
}

/** 重连原传输；失败后由同一连接策略重新发现该主机。 */
async function reconnectDevice(client, options = {}) {
    stepRuntime.assertManagementIdle();
    const deadlineMs = Date.now() + (options.budgetMs ?? 20000);
    const serial = firstString(options.serial, client.serial);
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    try {
        const devices = await client.devices({ timeoutMs: Math.min(10000, deadlineMs - Date.now()), deadlineMs });
        const ready = devices.find((device) => device.state === 'device' && (!serial || device.serial === serial));
        if (ready) {
            await selectDevice(client, ready.serial);
            return { ok: true, action: 'already-ready', serial: ready.serial, message: `设备在线：${ready.serial}` };
        }
        if (serial && client.reconnect && Date.now() < deadlineMs) {
            await client.reconnect(serial, { timeoutMs: Math.min(4000, deadlineMs - Date.now()), deadlineMs }).catch(() => {});
            const state = await waitForDeviceState(client, serial, Math.min(4000, deadlineMs - Date.now()), sleep, deadlineMs);
            if (state === 'device') {
                await selectDevice(client, serial);
                return { ok: true, action: 'reconnect', serial, message: `已重连 ${serial}` };
            }
        }
        const result = await autoConnectDevice(client, { ...options, serial, deadlineMs });
        return { ...result, action: 'rediscovered' };
    } catch (error) {
        return { ok: false, action: 'failed', serial: null,
            message: `手机重连失败：${error.message} 确认无线调试仍已开启，手机与电脑在同一 WiFi，必要时重新配对。` };
    }
}

function withHint(error, hint) {
    error.hint = hint;
    return error;
}

/** 补默认端口；adb 的无线调试端口不固定，已带端口就不动 */
function normalizeConnectAddress(address) {
    return /:\d+$/.test(address) ? address : `${address}:5555`;
}

/** 轮询仅查询目标serial；底层命令和休眠都受同一个截止时间约束。 */
async function waitForDeviceState(client, address, timeoutMs, sleep, deadlineMs = Infinity) {
    const deadline = Math.min(deadlineMs, Date.now() + timeoutMs);
    let state = 'missing';
    while (Date.now() < deadline) {
        const devices = await client.devices({ timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())), deadlineMs: deadline }).catch(() => []);
        state = devices.find((device) => device.serial === address)?.state || 'missing';
        if (state === 'device' || state === 'unauthorized') return state;
        if (Date.now() < deadline) await sleep(Math.min(300, deadline - Date.now()));
    }
    return state;
}

async function disconnectDevice(args = {}) {
    const serial = resolveSerial(args);
    if (!serial) throw new Error('[AndroidController] 缺少 serial。');
    const result = await deviceApi.disconnect({ address: serial });
    return textResult(result.message, { ...result, serial });
}

// ---------------------------------------------------------------------------
// 感知
// ---------------------------------------------------------------------------

/**
 * 抓一帧控件树。
 *
 * 关键：失败必须抛出，不能吐 ''。空字符串会被 parseUiGraph 压成一张空表，
 * 和「页面真的是自绘、没有节点」长得一模一样 —— 模型会照着空表继续瞎点。
 * 实测：手机息屏 30 秒后无线 adb 掉线，一次「device offline」就能让整条
 * 感知链路静默失败，模型完全不知道自己在对着空气操作。
 */
/**
 * 从 dump 原始输出里截出 <hierarchy> 段。
 * `uiautomator dump` 无论写哪里都会在末尾追加一行 "UI hierchary dumped to:"。
 */
function extractHierarchy(xml) {
    const text = String(xml ?? '');
    const start = text.indexOf('<hierarchy');
    if (start < 0) return '';
    const end = text.lastIndexOf('</hierarchy>');
    if (end > start) return text.slice(start, end + '</hierarchy>'.length);
    const empty = text.slice(start).match(/^<hierarchy\b[^>]*\/\s*>/);
    return empty ? empty[0] : '';
}

// ---------------------------------------------------------------------------
// 常驻 UI 采集服务（u2 JSON-RPC）
// ---------------------------------------------------------------------------
// 走 CLI 的 uiautomator dump 每次都要冷启 VM + 等 waitForIdle，实测 p50 2300ms，
// 动画页面上还会卡到 11s 后失败。改用 app_process 常驻的 JSON-RPC 服务后
// 同一页面 p50 61ms / p95 122ms。这里只做「优先尝试 + 静默回退」：
// 服务没起来、设备没权限、apk 缺失，任何一步失败都落回原 CLI 路径，
// 行为与接入前完全一致。

/** serial -> UiServer。按设备复用，避免每轮 Observe 都重推 3.7MB 与重启进程。 */
const uiServers = new Map();

function uiServerEnabled() {
    const raw = String(runtime.config?.UI_SERVER ?? process.env.ANDROID_UI_SERVER ?? 'true')
        .trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function uiServerFor(serial) {
    const key = String(serial || '');
    let entry = uiServers.get(key);
    if (!entry) {
        entry = new UiServer({
            adbPath: adb?.adbPath || 'adb',
            serial: key,
            logger: runtime.logger,
        });
        uiServers.set(key, entry);
    }
    return entry;
}

/** 关停所有常驻服务。插件停止/重连设备时调用，避免泄漏 app_process 与 forward。 */
async function shutdownUiServers() {
    const all = [...uiServers.values()];
    uiServers.clear();
    await Promise.all(all.map((server) => server.stop().catch(() => null)));
}

/**
 * 通过常驻服务取控件树；仅明确未派发或已排干的失败允许调用方回退 CLI。
 * 未知传输结局隔离设备；取消和总截止继续抛出，不得启动新的采集。
 */
async function dumpViaUiServer(serial) {
    if (!uiServerEnabled()) return null;
    const server = uiServerFor(serial);
    try {
        const started = await server.start();
        stepRuntime.check();
        if (!started.ok) {
            runtime.logger?.warn?.(`[AndroidController] UI 服务未就绪，回退 CLI：${started.reason}`);
            return null;
        }
        // 不传 maxDepth：UiServer 会用正深度默认值。传 0 在 uiautomator2 下只回根节点，
        // 上层会拿到「成功但空树」并因此永不回退 CLI（真机实测，见 lib/ui-server.js）。
        const { xml } = await withDeviceRpc(serial, () => server.dump({ rootInActive: true, signal: stepRuntime.executionSignal() }));
        stepRuntime.check();
        const hierarchy = extractHierarchy(xml);
        if (!hierarchy) return null;
        return { xml: hierarchy, note: '' };
    } catch (error) {
        stepRuntime.check();
        if (uncertainDevices.has(serial)) throw error;
        runtime.logger?.warn?.(`[AndroidController] UI 服务采集失败，回退 CLI：${error.message}`);
        // 服务已不可用，下一轮重新拉起，别带着坏状态反复超时。
        await server.stop().catch(() => null);
        stepRuntime.check();
        return null;
    }
}

async function dumpUi(serial) {
    const client = requireAdb();

    // 快路径：常驻服务。仅安全失败落到 CLI；传输未知直接抛错。
    const fast = await dumpViaUiServer(serial);
    if (fast) return fast;

    const viaTtyOnce = async () => {
        const text = await client.runText(
            ['exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty'],
            { serial, timeoutMs: DEFAULT_DUMP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        ).catch(() => null);
        if (!text) return { xml: null, idle: false, text: '' };
        const xml = extractHierarchy(text);
        return {
            xml: xml || null,
            // 动画密集页面（视频详情、长列表）会让 uiautomator 等 idle 直到超时，
            // 实测 11.1–12.0s 后输出这一行。这是瞬态失败：界面一停就能成功。
            idle: /could not get idle state/i.test(String(text)),
            text: String(text),
        };
    };

    // 主路径：一次 adb 往返，直接把压缩后的树写到 /dev/tty。
    // 相比「dump 到文件再 cat」：省一次进程启动与一次往返（实测 81ms），
    // --compressed 又砍掉 38% 传输量（17395B → 10751B），内容完全等价
    // （同一屏 28 个节点，字节数逐次一致，连跑 10 次无失败）。
    const first = await viaTtyOnce();
    if (first.xml) return { xml: first.xml, note: first.text.replace(first.xml, '').trim() };

    if (first.idle) {
        // 关键：idle 超时不能退回 file 路径 —— 它走的是同一个 uiautomator，
        // 会再卡一次同样的 11 秒。剖析日志里正是这样把 Observe 拖到 22.8s。
        // 正确做法是重试主路径：动画一停就能成功，成本只有一次往返。
        const retried = await viaTtyOnce();
        if (retried.xml) {
            return { xml: retried.xml, note: retried.text.replace(retried.xml, '').trim() };
        }
        throw stepRuntime.failure('UI_IDLE_TIMEOUT',
            '界面持续动画，uiautomator 无法等到 idle 状态（连续两次超时）。'
            + '这通常发生在视频、弹幕、加载动画不停歇的页面。'
            + '可尝试：先 KeyEvent back 回到静态页面，或在页面加载完成后再 Observe。');
    }

    // 回退：老设备不支持 --compressed，或 /dev/tty 不可写。
    // 只在「主路径不可用」时走这里；idle 超时已在上面单独处理。
    const remote = '/data/local/tmp/vcp_ui_dump.xml';
    let dumpText = '';
    try {
        dumpText = await client.runText(
            ['shell', 'uiautomator', 'dump', remote],
            { serial, timeoutMs: DEFAULT_DUMP_TIMEOUT_MS },
        );
    } catch (error) {
        if (/could not get idle state/i.test(String(error?.message || ''))) {
            throw stepRuntime.failure('UI_IDLE_TIMEOUT',
                '界面持续动画，uiautomator 无法等到 idle 状态。'
                + '这通常发生在视频、弹幕、加载动画不停歇的页面。'
                + '可尝试：先 KeyEvent back 回到静态页面，或在页面加载完成后再 Observe。');
        }
        throw withHint(error, 'uiautomator dump 未能执行。若设备是无线连接，先确认没有被息屏断开（ListDevices 看状态）。');
    }
    const xml = await client.runText(
        ['exec-out', 'cat', remote],
        { serial, timeoutMs: 15000, maxBuffer: 8 * 1024 * 1024 },
    ).catch((error) => {
        throw withHint(error, '控件树文件读不到，通常是 dump 没有真正落盘（uiautomator 服务未就绪或设备锁屏）。');
    });
    const hierarchy = extractHierarchy(xml);
    if (!hierarchy) throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 不完整，无法采集有效页面。');
    return { xml: hierarchy, note: String(dumpText || '').trim() };
}

async function captureGraph(serial, options = {}) {
    stepRuntime.check();
    assertDeviceCertain(serial);
    let xml;
    if (options.deadlineMs !== undefined) {
        const budget = Math.floor(Math.min(options.deadlineMs - Date.now(), stepRuntime.remainingMs()));
        if (budget < 1) throw stepRuntime.failure('VERIFICATION_TIMEOUT', '等待采样预算耗尽。');
        const server = uiServerEnabled() ? uiServerFor(serial) : null;
        if (server?.isReady() === true) ({ xml } = await withDeviceRpc(serial, () => server.dump({ rootInActive: true, timeoutMs: budget, signal: stepRuntime.executionSignal() })));
        else xml = await requireAdb().runText(['exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty'],
            { serial, timeoutMs: budget, maxBuffer: 8 * 1024 * 1024 });
    } else ({ xml } = await dumpUi(serial));
    validateHierarchy(xml);
    stepRuntime.check();
    return parseUiGraph(xml, options);
}

/**
 * 快照年龄提示。dump 一次要 1-3 秒，模型很可能拿着十秒前的表去点已经滚走的列表项。
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 息屏自动点亮。默认开，Android 默认 30 秒就息屏，Agent 一轮任务轻松超过这个时间。
 * AUTO_WAKE=false 可关掉，避免在演示时突然亮屏。
 */
function autoWakeEnabled() {
    const raw = String(runtime.config?.AUTO_WAKE ?? 'true').trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
}

const WAKE_TIMEOUT_DEFAULT_MS = 2500;
const WAKE_POLL_DEFAULT_MS = 150;
const WAKE_DEADLINE_MAX_MS = 15000;

/** 点亮等待预算。0 表示只做一次探测（单测用）。 */
function wakeTimeoutOf(args = {}) {
    const raw = args.wakeTimeoutMs;
    if (raw === undefined || raw === null) return WAKE_TIMEOUT_DEFAULT_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > WAKE_DEADLINE_MAX_MS) {
        throw stepRuntime.failure('INVALID_ARGUMENT', `wakeTimeoutMs 必须是 0-${WAKE_DEADLINE_MAX_MS} 的数字。`);
    }
    return Math.round(value);
}

/**
 * 点亮后轮询 probeScreen 直到「已唤醒且焦点不是锁屏」。
 *
 * 一次 probeScreen 就同时给出 wakefulness / focus / size，所以轮询它不会
 * 比旧的「单独两次往返」更贵；典型一次就够（实测 160–241ms）。
 *
 * 「焦点不是锁屏」是必要判据：dumpsys power 会先一步报 Awake，但此时
 * WindowManager 可能仍停在该死的 keyguard 上，直接 dump 会拿到锁屏树。
 * 超时不让整次 Observe 失败 —— 交回 best-effort 数据，由调用方注明。
 */
async function awaitWake(serial, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : WAKE_TIMEOUT_DEFAULT_MS;
    const client = requireAdb();
    const deadline = Date.now() + timeoutMs;
    let last = { wakefulness: null, focus: null, size: null, ready: false };

    const usable = (probe) => {
        const state = probe?.wakefulness;
        if (!state || state === 'Asleep' || state === 'Dozing') return false;
        const pkg = String(probe?.focus?.package || '');
        // 锁屏/下拉/系统对话框都不算「可用前台」
        return pkg.length > 0 && !/systemui|keyguard/i.test(pkg);
    };

    do {
        stepRuntime.check();
        const probe = await client.probeScreen(serial).catch(() => null);
        if (probe) {
            last = {
                wakefulness: probe.wakefulness ?? last.wakefulness,
                focus: probe.focus || last.focus,
                size: probe.size || last.size,
                ready: usable(probe),
            };
            if (last.ready) return last;
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_DEFAULT_MS));
        stepRuntime.check();
    } while (Date.now() < deadline);

    return last;
}

function validatePackage(pkg) {
    if (!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*$/.test(pkg)) {
        throw stepRuntime.failure('INVALID_ARGUMENT', 'package 包名无效。');
    }
}

function validateHierarchy(xml) {
    // CLI prints this exact carrier suffix after the XML, sometimes without a separator.
    xml = String(xml).replace(/(?:\r?\n)?UI hierchary dumped to: \/dev\/tty(?:\r?\n)?$/, '');
    xml = String(xml).replace(/^\uFEFF?\s*<\?xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>/i, '');
    const tags = xml.match(/<[^>"']*(?:"[^"]*"|'[^']*'|[^>"']*)*>/g) || [];
    const stack = [];
    let roots = 0;
    for (const tag of tags) {
        const match = tag.match(/^<(\/?)(hierarchy|node)\b[\s\S]*?(\/?)>$/);
        if (!match) throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 包含无效标签。');
        const [, closing, name, empty] = match;
        const body = tag.replace(/^<\/?(?:hierarchy|node)\b/, '').replace(/\/?\s*>$/, '');
        if (closing && body.trim()) throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 闭合标签无效。');
        if (!closing) {
            const attributes = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gy;
            const names = new Set();
            let offset = 0;
            while (body.slice(offset).trim()) {
                attributes.lastIndex = offset;
                const attribute = attributes.exec(body);
                if (!attribute || names.has(attribute[1])) throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 属性无效或重复。');
                names.add(attribute[1]);
                const value = attribute[2] ?? attribute[3];
                if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 实体无效。');
                offset = attributes.lastIndex;
            }
        }
        if (closing) {
            if (stack.pop() !== name) throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 标签不匹配。');
        } else {
            if (name === 'hierarchy') {
                if (stack.length || roots++) throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 根节点无效。');
            } else if (!stack.length) throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 缺少根节点。');
            if (!empty) stack.push(name);
        }
    }
    if (roots !== 1 || stack.length || tags.join('').replace(/\s/g, '') !== String(xml).replace(/\s/g, '')) {
        throw stepRuntime.failure('UI_ACQUISITION_FAILED', '控件树 XML 不完整。');
    }
}

function graphLayout(graph) {
    return JSON.stringify([graph.package, graph.rotation, graph.controls.map((node) => [node.id, node.label, node.value, node.flags, node.x, node.y, node.bounds])]);
}

function storeSnapshot(serial, graph, size, focus = null, limit = DEFAULT_LIMIT) {
    const record = { snapshotId: randomUUID(), graph, at: Date.now(), size, focus, limit };
    lastObserve.set(serial, record);
    return record;
}

async function prepareTarget(args, label) {
    const client = requireAdb();
    const index = intOf(args.index, 'index', null);
    const semantic = index !== null || args.selector !== undefined || firstString(args.id, args.resourceId, args.resource_id, args.text);
    if (!semantic) checkFrame(args, resolveSerial(args));
    const { serial } = await ensureActiveDevice(client, resolveSerial(args));
    const pinned = { ...args, serial };
    const record = lastObserve.get(serial);
    if (index !== null) {
        if (!record) throw stepRuntime.failure('STALE_SNAPSHOT', '尚未在该设备上执行 Observe，快照不可用。');
        if (!firstString(args.snapshotId)) throw stepRuntime.failure('SNAPSHOT_REQUIRED', 'index 必须携带 Observe 返回的 snapshotId。');
        if (record.snapshotId !== args.snapshotId || Date.now() - record.at > STALE_SNAPSHOT_MS) {
            throw stepRuntime.failure('STALE_SNAPSHOT', '快照不匹配或已过期，请重新 Observe。');
        }
    }
    const size = semantic ? await client.screenSize(serial) : await requireFrame(args, serial);
    if (semantic) {
        const graph = await captureGraph(serial, { limit: index !== null ? record.limit || DEFAULT_LIMIT : 500, screen: size, rpcTarget: args.rpcTarget === true,
            ...(args.safeRead === true ? { deadlineMs: Date.now() + stepRuntime.remainingMs() } : {}) });
        if (index !== null) {
            if (JSON.stringify(size) !== JSON.stringify(record.size) || !samePage(record.graph, graph) || graphLayout(record.graph) !== graphLayout(graph)) {
                lastObserve.delete(serial);
                throw stepRuntime.failure('STALE_SNAPSHOT', '页面内容或布局已变化，请重新 Observe 获取快照。');
            }
        }
        if (index !== null && args.rpcTarget === true) record.graph = graph;
        if (index === null) storeSnapshot(serial, graph, size);
    }
    const target = resolveTarget(pinned, label);
    if (!size || target.x >= size.width || target.y >= size.height) throw stepRuntime.failure('INVALID_COORDINATES', '坐标超出当前屏幕或屏幕尺寸未知。');

    stepRuntime.check();
    return target;
}

function logicalSize(size) {
    return size && Number.isSafeInteger(size.width) && size.width > 0
        && Number.isSafeInteger(size.height) && size.height > 0 ? { width: size.width, height: size.height } : null;
}

function frameContext(probe) {
    const size = logicalSize(probe?.size);
    if (!size || ![0, 1, 2, 3].includes(probe.rotation) || probe.displayId !== 0
        || probe.wakefulness !== 'Awake' || probe.keyguard?.showing !== false || probe.keyguard?.inputRestricted !== false
        || /systemui|keyguard/i.test(probe.focus?.package || '')
        || !['package', 'component', 'window'].every(key => typeof probe.focus?.[key] === 'string' && probe.focus[key].trim())) return null;
    return { package: probe.focus.package, component: probe.focus.component, window: probe.focus.window,
        size, rotation: probe.rotation };
}

function sameFrameContext(a, b) {
    return Boolean(a && b && a.package === b.package && a.component === b.component && a.window === b.window
        && a.rotation === b.rotation && a.size.width === b.size.width && a.size.height === b.size.height);
}


async function freshFrameProbe(client, serial) {
    stepRuntime.check();
    try {
        const probe = await client.probeScreen(serial, { fresh: true, signal: stepRuntime.executionSignal(),
            timeoutMs: Math.min(stepRuntime.remainingMs(), 10000) });
        stepRuntime.check();
        return probe;
    } catch { stepRuntime.check(); return null; }
}

function checkFrame(args, serial) {
    if (!firstString(args.frameId)) throw stepRuntime.failure('FRAME_REQUIRED', '像素坐标动作必须携带 Screenshot 或 Observe screenshot 返回的 frameId。');
    const frame = lastVision.get(serial);
    if (!frame || frame.frameId !== args.frameId || Date.now() - frame.at > STALE_SNAPSHOT_MS) {
        lastVision.delete(serial);
        throw stepRuntime.failure('STALE_FRAME', '截图 frameId 无效或过期，请重新截图。');
    }
    return frame;
}

async function requireFrame(args, serial) {
    const entries = Array.isArray(args) ? args : [args];
    const frames = entries.map(entry => checkFrame(entry, serial));
    const probe = await freshFrameProbe(requireAdb(), serial);
    const context = frameContext(probe);
    if (frames.some(frame => !sameFrameContext(frame.context, context))) {
        lastVision.delete(serial);
        throw stepRuntime.failure('STALE_FRAME', '截图上下文已变化或无法确认，请重新截图。');
    }
    entries.forEach(entry => checkFrame(entry, serial));
    stepRuntime.check();
    return logicalSize(probe.size);
}

async function prepareTargets(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 2) throw stepRuntime.failure('INVALID_ARGUMENT', '触摸目标数量无效。');
    const client = requireAdb();
    const semantic = args => args.index !== undefined || args.selector !== undefined || firstString(args.id, args.resourceId, args.resource_id, args.text);
    const pixels = entries.filter(({ args }) => !semantic(args)).map(({ args }) => args);
    const hasSemantic = pixels.length < entries.length;
    const pixelFrames = pixels.map(args => checkFrame(args, resolveSerial(args)));
    const { serial } = await ensureActiveDevice(client, resolveSerial(entries[0].args));
    if (entries.some(({ args }) => resolveSerial(args) !== serial)) throw stepRuntime.failure('INVALID_ARGUMENT', '触摸目标不能跨设备。');
    const record = lastObserve.get(serial);
    let size = pixelFrames.length ? pixelFrames[0].context.size : await client.screenSize(serial);
    const indexed = entries.some(({ args }) => args.index !== undefined);
    for (const { args } of entries) {
        if (args.index === undefined) continue;
        requireInt(args.index, 'index');
        if (!record || record.snapshotId !== args.snapshotId || Date.now() - record.at > STALE_SNAPSHOT_MS) throw stepRuntime.failure('STALE_SNAPSHOT', '触摸目标快照已过期或不匹配。');
    }
    if (hasSemantic) {
        const graph = await captureGraph(serial, { limit: indexed ? record.limit || DEFAULT_LIMIT : 500, screen: size, rpcTarget: true });
        if (graph.keyguard) {
            if (pixelFrames.length) lastVision.delete(serial);
            throw stepRuntime.failure(pixelFrames.length ? 'STALE_FRAME' : 'DEVICE_LOCKED', '锁屏时不执行触摸动作。');
        }
        if (pixelFrames.length) {
            const context = pixelFrames[0].context;
            const rotation = graph.rawRoot?.attrs?.rotation;
            if (graph.package !== context.package || rotation !== String(context.rotation)) {
                lastVision.delete(serial);
                throw stepRuntime.failure('STALE_FRAME', '语义树与截图的前台或旋转证据不一致，请重新观察。');
            }
        }
        if (indexed && (JSON.stringify(size) !== JSON.stringify(record.size) || !samePage(record.graph, graph) || graphLayout(record.graph) !== graphLayout(graph))) {
            lastObserve.delete(serial);
            throw stepRuntime.failure('STALE_SNAPSHOT', '页面或布局已变化，请重新 Observe。');
        }
        if (indexed) record.graph = graph;
        else storeSnapshot(serial, graph, size);
    }
    if (pixels.length) size = await requireFrame(pixels, serial);
    const targets = entries.map(({ args, label }) => {
        const target = resolveTarget({ ...args, serial }, label);
        if (!size || target.x < 0 || target.y < 0 || target.x >= size.width || target.y >= size.height) throw stepRuntime.failure('INVALID_COORDINATES', '触摸坐标超出屏幕。');
        if (semantic(args)) rpcNodeSelector(serial, target.node);
        return { ...target, screen: size };
    });
    stepRuntime.check();
    return targets;
}

function rpcNodeSelector(serial, node) {
    if (!node?.enabled || !node.inViewport) throw stepRuntime.failure('INVALID_RPC_TARGET', 'RPC 目标必须可见且启用。');
    const attributes = [];
    const intersect = (a, b) => {
        if (!a || !b) return null;
        const box = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
        return box.right > box.left && box.bottom > box.top ? box : null;
    };
    const stack = [{ raw: lastObserve.get(serial)?.graph.rawRoot, hidden: false, clip: node.clipped }];
    while (stack.length) {
        const { raw, hidden, clip } = stack.pop();
        if (!raw) continue;
        const ownHidden = hidden || raw.attrs?.['visible-to-user'] === 'false' || raw.attrs?.displayed === 'false';
        if (raw.tag === 'node') attributes.push({ ...raw.attrs, hidden: ownHidden, clip });
        const childClip = raw.attrs?.scrollable === 'true' ? intersect(clip, parseBounds(raw.attrs.bounds)) : clip;
        for (const child of raw.children) stack.push({ raw: child, hidden: ownHidden, clip: childClip });
    }
    const sameIdentity = attrs => String(attrs.class || '').split('.').at(-1) === node.cls && attrs.package === node.package && (!node.id || attrs['resource-id'] === node.id);
    const identities = attributes.filter(sameIdentity);
    if (identities.length !== 1 || !identities[0].class || !identities[0].package || identities[0].enabled === 'false' || identities[0].hidden || !identities[0].clip) throw stepRuntime.failure('INVALID_RPC_TARGET', 'RPC 原始节点身份不唯一或不可见。');
    node.clipped = identities[0].clip;
    const selector = { mask: 16 | 524288, className: identities[0].class, packageName: node.package };
    if (node.id) { selector.mask |= 2097152; selector.resourceId = node.id; }
    return selector;
}

async function dispatchInput(serial, task, mark = true) {
    stepRuntime.check();
    assertDeviceCertain(serial);
    lastObserve.delete(serial);
    lastVision.delete(serial);
    if (mark) stepRuntime.markDispatched();
    return stepRuntime.stage('actionMs', task);
}

function staleNote(record) {
    if (!record) return '';
    const ageMs = Date.now() - record.at;
    if (ageMs <= STALE_SNAPSHOT_MS) return '';
    return `（快照已 ${Math.round(ageMs / 1000)} 秒，页面可能已变；若没按预期生效请重新 Observe）`;
}

/** 每次感知只查询一次；单次 serial 覆盖不修改默认选择。 */
async function ensureActiveDevice(client, serial) {
    const target = firstString(serial, client.serial);
    if (target && stepRuntime.activeDevice() === target) return { serial: target, switchNote: '' };
    const devices = await client.devices();
    if (target) {
        const found = devices.find((device) => device.serial === target);
        if (found?.state !== 'device') {
            throw new Error(`[AndroidController] 设备 ${target} 未就绪（${found?.state || 'missing'}）。请确认授权或用 Connect 重连。`);
        }
        return { serial: target, switchNote: '' };
    }
    const ready = devices.find((device) => device.state === 'device');
    if (!ready) throw new Error('[AndroidController] 没有可用的已授权设备，请先 Connect。');
    await selectDevice(client, ready.serial);
    return { serial: ready.serial, switchNote: '' };
}

async function observe(args = {}, executionContext = {}) {
    const mode = firstString(args.mode).toLowerCase() || 'ui';
    if (mode === 'image') return screenshot(args);
    if (mode === 'api') return apiQuery(args, executionContext);
    if (mode === 'arbitrate') {
        const arbitration = parseObject(args.arbitration, 'arbitration');
        if (Object.keys(arbitration).some(key => !['mode', 'snapshotId', 'goal', 'candidates', 'targetSelector', 'requestTimeoutMs'].includes(key))) throw stepRuntime.failure('INVALID_ARGUMENT', 'arbitration 含未知字段。');
        return arbitrateSnapshot({ ...arbitration, serial: resolveSerial(args) });
    }
    if (mode !== 'ui') throw stepRuntime.failure('INVALID_ARGUMENT', 'Observe mode 仅支持 ui、image、arbitrate、api。');
    if (args.wake !== undefined && !['never', 'ifAllowed'].includes(args.wake)) throw stepRuntime.failure('INVALID_ARGUMENT', 'wake 仅支持 never、ifAllowed。');
    const client = requireAdb();
    const serial = resolveSerial(args);
    const limit = intOf(args.limit, 'limit', DEFAULT_LIMIT) ?? DEFAULT_LIMIT;

    const wantStable = args.stable === true || String(args.stable).toLowerCase() === 'true';

    const { serial: active, switchNote } = await ensureActiveDevice(client, serial);
    // 一次往返取齐焦点 / 尺寸 / 电源态。
    // 不能用 Promise.all 并发三个方法：同设备调用共用一个调度 key，
    // 实测是严格串行（275-327ms），合并成单次 shell 后 130-163ms。
    const probe = await client.probeScreen(active).catch(() => null);
    let focus = probe?.focus || { package: null, component: null, window: null };
    let size = probe?.size || null;
    let wakefulness = probe?.wakefulness || null;
    // 合并命令里的 grep 万一不可用（精简 ROM），退回到独立调用。
    if (!probe) {
        [focus, size, wakefulness] = await Promise.all([
            client.currentFocus(active).catch(() => ({ package: null, component: null, window: null })),
            client.screenSize(active).catch(() => null),
            client.wakefulness(active).catch(() => null),
        ]);
    }

    // 息屏时 uiautomator 只会给一棵 systemui 锁屏树，过滤后是空表。
    // 与其让模型看空表自己猜，不如先点亮再抓。
    //
    // 旧实现固定等待后再单独调两次 wakefulness / currentFocus。
    // 真机实测（PJZ110，4 轮）：keyevent 之后第一次 probeScreen 返回时
    // wakefulness 已是 Awake、focus 已是前台应用，典型 160–241ms。
    // 所以改成轮询 probeScreen —— 一次往返拿齐三项，典型 1 次就够。
    let wokeNote = '';
    const asleep = wakefulness === 'Asleep' || wakefulness === 'Dozing';
    if (asleep && args.wake !== 'never' && autoWakeEnabled()) {
        await dispatchInput(active, () => client.runText(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { serial: active, timeoutMs: 10000 }))
            .catch(() => { stepRuntime.check(); });
        const woke = await awaitWake(active, { timeoutMs: wakeTimeoutOf(args) });
        wakefulness = woke.wakefulness;
        focus = woke.focus || focus;
        size = woke.size || size;
        if (woke.ready) {
            wokeNote = '（原处于息屏，已自动点亮）';
        } else {
            // 点亮没能在预算内确认成功。不抛错：至少给出当前树让模型判断，
            // 但要明确说清「点了但没确认亮」，而不是假装成功。
            wokeNote = `（原处于息屏，已派发点亮但 ${wakeTimeoutOf(args)}ms 内未确认唤醒，界面可能是锁屏）`;
        }
    }

    // dump 一次就要 1-3 秒，默认只采一帧；要“等页面稳”就显式 stable:true，
    // 采两次取后一帧，并给出两次签名是否一致。
    let graph = await captureGraph(active, { limit, screen: size });
    let settled = null;
    let stability = wantStable ? 'unknown' : 'not-sampled';
    if (wantStable) {
        const again = await captureGraph(active, { limit, screen: size }).catch(error => {
            stepRuntime.check();
            if (uncertainDevices.has(active)) throw error;
            return null;
        });
        if (again) {
            settled = samePage(graph, again) && graphLayout(graph) === graphLayout(again);
            stability = settled ? 'stable' : 'changing';
            graph = again;
        }
    }

    return renderObservation(args, { serial: active, graph, size, focus, limit, settled, stability, switchNote, wokeNote });
}

async function renderObservation(args, sample) {
    const { serial, graph, size, focus, limit, at = Date.now(), settled = null, stability = 'not-sampled', switchNote = '', wokeNote = '' } = sample;
    const previous = lastObserve.get(serial);
    const changed = previous ? !samePage(previous.graph, graph) : null;
    const record = storeSnapshot(serial, graph, size, focus, limit);
    record.at = at;
    record.stability = stability;
    const viewLimit = intOf(args.limit, 'limit', DEFAULT_LIMIT);
    const view = { ...graph, controls: graph.controls.slice(0, viewLimit) };
    view.truncated = graph.total > view.controls.length;
    const header = [
        switchNote.trim(),
        `设备：${serial}`,
        `前台：${focus?.package || graph.package || '(未知)'}${focus?.component ? `  ${focus.component}` : ''}`,
        size ? `分辨率：${size.width}×${size.height}` : null,
        wokeNote,
        `快照：${record.snapshotId}（index 操作必须携带 snapshotId）`,
        `页面签名：${graph.signature}${changed === null ? '' : changed ? '（较上次已变化）' : '（与上次相同，页面可能未响应本次操作）'}`,
        graph.keyguard ? '屏幕状态：锁屏。需要用户解锁后再观察，不自动解锁。' : null,
        stability === 'unknown' ? '注意：第二次采样失败，稳定性未知。' : null,
        settled === false ? '注意：连续两次采样内容或布局不一致，页面仍在变化。' : null,
    ].filter(Boolean).join('\n');
    let shot = null;
    let shotNote = '';
    if (args.screenshot === true || args.screenshot === 'true') {
        try {
            shot = await captureVisionShot({ client: requireAdb(), serial, size, args });
            shotNote = `\n\n${describeVisionShot(shot, { serial, size })}`;
        } catch (error) {
            stepRuntime.check();
            shotNote = `\n\n[截图失败] ${error.code || 'IMAGE_ACQUISITION_FAILED'}`;
        }
    }
    const body = view.controls.length ? renderView(view) : '(控件树为空；可用 mode=image 查看像素界面。)';
    const content = [{ type: 'text', text: `${header}\n\n${body}${shotNote}` }];
    if (shot) content.push({ type: 'image_url', image_url: { url: shot.frame.dataUrl } });
    return {
        content,
        details: {
            serial, focus, screen: shot?.size || size, signature: graph.signature,
            snapshotId: record.snapshotId, observedAt: record.at, changed, settled, stability,
            controls: view.controls, total: graph.total, truncated: view.truncated,
            keyguard: graph.keyguard, canvas: graph.canvas, stats: graph.stats,
            image: shot?.frame || null, displayUrl: streamServer?.url() || null,
        },
    };
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

function resolveTarget(args = {}, actionLabel = '操作') {
    const serial = resolveSerial(args);
    const record = lastObserve.get(serial || adb?.serial || '');
    const index = intOf(args.index, 'index', null);

    if (index !== null) {
        if (!record) {
            throw new Error('[AndroidController] 尚未在该设备上执行 Observe，无法按 index 定位。请先 Observe，或直接给出 x/y。');
        }
        const node = record.graph.controls[index];
        if (!node) {
            throw new Error(`[AndroidController] index ${index} 超出范围（当前快照共 ${record.graph.controls.length} 个控件）。请重新 Observe。`);
        }
        return { serial, x: node.x, y: node.y, node, note: staleNote(record) };
    }

    // 跨帧定位：id / text / selector 不依赖上次的数组下标，列表滚动后依然能命中。
    const selector = args.selector;
    if (selector !== undefined) validateSelector(selector);
    const byId = firstString(args.id, args.resourceId, args.resource_id);
    const byText = firstString(args.text);
    if (selector !== undefined || byId || byText) {
        if (!record) {
            throw new Error('[AndroidController] 尚未在该设备上执行 Observe，无法按 id/text 定位。请先 Observe，或直接给出 index / x,y。');
        }
        const encode = (value) => value.replace(/%/g, '%25').replace(/#/g, '%23');
        const key = selector || (byId ? `id=${encode(byId)}` : `text=${encode(byText)}`);
        const node = resolveSelector(record.graph, key);
        if (!node) {
            throw stepRuntime.failure('TARGET_NOT_UNIQUE', `当前页面没有匹配「${typeof key === 'string' ? key : '组合selector'}」的唯一控件；请收紧条件或显式指定nth。`);
        }
        return { serial, x: node.x, y: node.y, node, note: staleNote(record) };
    }

    const x = intOf(args.x, 'x', null);
    const y = intOf(args.y, 'y', null);
    if (x === null || y === null) {
        throw new Error(`[AndroidController] ${actionLabel}需要 x/y 坐标，或先 Observe 后用 index 指定元素。`);
    }
    if (x < 0 || y < 0) throw new Error('[AndroidController] 坐标必须为非负数。');
    return { serial, x, y, node: null, note: '' };
}

function channelReceipt(result, attempts, extra = {}) {
    const receipt = { channels: attempts.map(item => item.channel), attempts, ...extra };
    result.details = { ...result.details, ...receipt };
    result.content.push({ type: 'text', text: JSON.stringify(receipt) });
    return result;
}

const RPC_OPERATION = Object.freeze({ READ: 'read', WRITE: 'write' });

/**
 * 单步预算。长按由调用方显式声明持续时长，避免动作原语切换时丢掉时长预算。
 * click 的第三参是按压毫秒；swipe 的 steps 换算只用于回退及滑动。
 */
function rpcActionTimeoutMs(method, params, declaredDurationMs) {
    const declared = Number.isFinite(declaredDurationMs) ? declaredDurationMs : 0;
    // swipe 是唯一能在参数自身里读出时长的原语（steps 而不是毫秒）。
    const durationMs = declared
        || (method === 'swipe' && Number.isFinite(params?.[4]) ? params[4] * 5 : 0);
    const actionBudgetMs = Math.max(4000, durationMs + 1000);
    return Math.min(stepRuntime.remainingMs(), actionBudgetMs);
}

async function rpcAction(serial, method, params, attempts, operation, options = {}) {
    stepRuntime.check();
    assertDeviceCertain(serial);
    // 参数形状不在这一层校验：UiServer.invoke 是通往设备的唯一入口，那里校验一次
    // 才是权威。此处只负责把它抛出的本地拒绝如实落成 not-dispatched 回执。
    const isWrite = operation === RPC_OPERATION.WRITE;
    // silent：轮询式只读（如 Fill 读回）由调用方落一条汇总，避免回执里堆几十条 getText。
    const silent = options.silent === true;
    const attempt = { channel: 'rpc', method, status: 'starting' };
    if (!silent) {
        attempts.push(attempt);
        stepRuntime.inputReceipt({ channels: attempts.map(item => item.channel), attempts });
    }
    const previousDispatch = isWrite ? stepRuntime.dispatchState() : null;
    let invoking = false;
    let rpcCompleted = false;
    try {
        if (!uiServerEnabled()) {
            throw Object.assign(new Error(), { code: 'UI_SERVER_DISABLED', dispatched: false });
        }
        const server = uiServerFor(serial);
        const ready = await server.start();
        stepRuntime.check();
        if (!ready.ok) {
            throw Object.assign(new Error(), { code: 'UI_SERVER_NOT_READY', dispatched: false });
        }
        if (options.beforeDispatch) {
            await options.beforeDispatch();
            stepRuntime.check();
        }
        const request = {
            signal: stepRuntime.executionSignal(),
            timeoutMs: rpcActionTimeoutMs(method, params, options.durationMs),
        };
        // 从首击 invoke 前的单调时刻计窗；ACK 和第二击就绪等待都占用窗口。
        const dispatchAt = performance.now();
        if (options.dispatchDeadline !== undefined && dispatchAt > options.dispatchDeadline) {
            throw Object.assign(new Error(), { code: 'DOUBLE_TAP_WINDOW_MISSED', dispatched: false });
        }
        if (options.dispatchTiming) options.dispatchTiming.startedAt = dispatchAt;
        attempt.status = 'invoking';
        invoking = true;
        if (isWrite) stepRuntime.markDispatched();
        const value = await withDeviceRpc(serial, () => server.invoke(method, params, request));
        rpcCompleted = true;
        if (isWrite) stepRuntime.markDispatched();
        attempt.status = 'dispatched';
        if (value === false) {
            throw Object.assign(new Error(), { code: 'UI_SERVER_ACTION_REJECTED', dispatched: true, drained: true });
        }
        stepRuntime.check();
        return value;
    } catch (error) {
        attempt.code = error.code || 'UI_SERVER_RPC_FAILED';
        const notDispatched = !invoking || error.dispatched === false;
        attempt.status = notDispatched ? 'not-dispatched' : 'unknown';
        if (isWrite) {
            if (notDispatched) stepRuntime.restoreDispatch(previousDispatch);
            else stepRuntime.markDispatched();
        }
        const clean = stepRuntime.failure(attempt.code, 'RPC 动作未确认；已派发时不得重试。');
        clean.dispatched = !notDispatched;
        clean.drained = notDispatched || rpcCompleted || error.drained === true;
        if (Number.isInteger(error.rpcCode)) clean.rpcCode = error.rpcCode;
        clean.details = { channels: attempts.map(item => item.channel), attempts };
        if (silent) clean.silent = true;
        throw clean;
    }
}

async function gesture(serial, method, params, shell, options = {}) {
    const attempts = [];
    stepRuntime.inputReceipt({ channels: attempts.map(item => item.channel), attempts });
    await dispatchInput(serial, async () => {
        const candidates = [{ method, params }];
        if (options.rpcFallback) candidates.push(options.rpcFallback);
        for (const candidate of candidates) {
            try {
                await rpcAction(serial, candidate.method, candidate.params, attempts, RPC_OPERATION.WRITE, options);
                return;
            } catch (error) {
                stepRuntime.check();
                if (error.dispatched) throw error;
            }
        }
        stepRuntime.check();
        const attempt = { channel: 'shell', status: 'dispatched' };
        attempts.push(attempt);
        stepRuntime.inputReceipt({ channels: attempts.map(item => item.channel), attempts });
        stepRuntime.markDispatched();
        try {
            await shell();
        } catch (error) {
            attempt.status = 'unknown';
            attempt.code = error.code || 'INPUT_FAILED';
            const clean = stepRuntime.failure(attempt.code, 'Shell 动作未确认。');
            clean.details = { channels: attempts.map(item => item.channel), attempts };
            throw clean;
        }
    }, false);
    return attempts;
}

// 与 ui-graph 的 textfield 判定同源：只有这些类才是可承载文本的节点。
const EDITABLE_CLASS = /(?:EditText|AutoCompleteTextView)$/;

function fieldSelector(serial, node) {
    const attributes = [];
    const stack = [lastObserve.get(serial)?.graph.rawRoot];
    while (stack.length) {
        const raw = stack.pop();
        if (!raw) continue;
        if (raw.tag === 'node') attributes.push(raw.attrs);
        for (let index = raw.children.length - 1; index >= 0; index--) {
            stack.push(raw.children[index]);
        }
    }

    const { left, top, right, bottom } = node.bounds;
    const bounds = `[${left},${top}][${right},${bottom}]`;
    // 唯一性只在可编辑节点里算：无 resource-id 的输入框外面常套着 bounds 完全相同的
    // android.view.View 容器（真机 com.coloros.note 编辑页即如此）。把包裹容器也算进来，
    // 会把「一个输入框」误判成「两个重复字段」而拒绝 Fill。
    const matches = attributes.filter(attrs => (
        EDITABLE_CLASS.test(attrs.class || '')
        && attrs['resource-id'] === node.id
        && attrs.package === node.package
        && attrs.bounds === bounds
    ));
    if (matches.length !== 1) {
        throw stepRuntime.failure('INVALID_FILL_TARGET', '无法唯一绑定实时输入框。');
    }

    const target = matches[0];
    // RPC identity must remain unique across the unfiltered tree, not only visible controls.
    const identityMatches = attributes.filter(attrs => (
        attrs.class === target.class
        && attrs.package === target.package
        && (!node.id || attrs['resource-id'] === node.id)
    ));
    if (identityMatches.length !== 1) {
        throw stepRuntime.failure('INVALID_FILL_TARGET', 'RPC 目标身份不唯一；拒绝重复字段。');
    }

    const selector = {
        mask: 16 | 524288 | 16777216,
        className: target.class,
        packageName: target.package,
        instance: identityMatches.indexOf(target),
    };
    if (node.id) {
        selector.mask |= 2097152;
        selector.resourceId = node.id;
    }
    return selector;
}

// The bundled carrier returns one structural newline after clearTextField.
function readbackMatches(actual, expected) {
    return typeof actual === 'string' && (actual === expected || (expected === '' && actual === '\n'));
}

// setText 返回不代表 UI 线程已应用：真机实测（PJZ110 / com.coloros.note）setText 返回
// 后立即 getText 读到的是**上一次**的旧值，+20ms 才是新值。只读一次会把「写成功」误判
// 成 FILL_READBACK_MISMATCH。这里只重复**读**，绝不重发写动作。
const READBACK_WINDOW_MS = 1200;
const READBACK_INTERVAL_MS = 40;

async function fill(args = {}) {
    const attempts = [];
    try {
        if (typeof args.text !== 'string'
            || args.text.length > MAX_TEXT_INPUT
            || !(firstString(args.id, args.resourceId, args.resource_id, args.selector)
                || args.index !== undefined)
            || (args.selector !== undefined && (typeof args.selector !== 'string' || !args.selector.startsWith('id=')))
            || ['x', 'y', 'frameId', 'content'].some(key => args[key] !== undefined)) {
            throw stepRuntime.failure('INVALID_ARGUMENT', 'Fill 需要 text 字符串及 id/selector 或 index+snapshotId；空字符串清空。');
        }
        // The RPC transport declares UTF-8; field text is passed unchanged.
        const { serial, node } = await stepRuntime.stage('prepareMs', () => prepareTarget({
            ...args,
            text: undefined,
            rpcTarget: true,
        }, '填充'));
        if (!node?.enabled || !node.inViewport || node.role !== 'textfield') {
            throw stepRuntime.failure('INVALID_FILL_TARGET', 'Fill 目标必须是可见启用的输入框。');
        }
        const selector = fieldSelector(serial, node);
        const method = args.text ? 'setText' : 'clearTextField';
        const params = args.text ? [selector, args.text] : [selector];
        await dispatchInput(serial, () => rpcAction(
            serial, method, params, attempts, RPC_OPERATION.WRITE,
        ), false);
        if (!node.flags.includes('password')) {
            let matched = false;
            let code = null;
            let reads = 0;
            let readDispatched = false;
            let readUnknown = false;
            await stepRuntime.stage('verificationMs', async () => {
                const deadline = Date.now() + Math.min(READBACK_WINDOW_MS, stepRuntime.remainingMs());
                for (;;) {
                    stepRuntime.check();
                    reads += 1;
                    try {
                        const value = await rpcAction(
                            serial, 'getText', [selector], attempts, RPC_OPERATION.READ, { silent: true },
                        );
                        readDispatched = true;
                        if (typeof value !== 'string') { code = 'FILL_READBACK_INVALID'; break; }
                        // Preserve requested whitespace; only the proven clearTextField newline is accepted.
                        matched = readbackMatches(value, args.text);
                        code = null;
                    } catch (error) {
                        stepRuntime.check();
                        code = error.code;
                        readDispatched ||= error.dispatched !== false;
                        readUnknown ||= error.dispatched !== false && error.drained !== true;
                        // 传输/服务层失败不会因为再读一次就变好；只有「读到旧值」才值得重试。
                        if (error.code !== 'UI_SERVER_RPC_ERROR') break;
                    }
                    if (matched || Date.now() >= deadline) break;
                    await stepRuntime.pause(READBACK_INTERVAL_MS);
                }
            });
            // 读回是一个动作的验证，不是一次独立派发：无论轮询几次，回执里只留一条。
            // No returned value does not prove that no read was dispatched.
            attempts.push({
                channel: 'rpc', method: 'getText', reads,
                status: readUnknown ? 'unknown' : readDispatched ? 'dispatched' : 'not-dispatched',
            });
            stepRuntime.verified(matched, {
                condition: { type: 'fill-readback' },
                reads,
                error: code || (matched ? null : 'FILL_READBACK_MISMATCH'),
            });
            return channelReceipt(textResult(
                '字段替换已派发；读回' + (matched ? '一致。' : '未证实。'),
                { serial, fillVerified: matched },
            ), attempts);
        }
        return channelReceipt(textResult(
            '密码字段替换已派发；不读取或证明字段值。',
            { serial, password: true },
        ), attempts);
    } catch (error) {
        const clean = stepRuntime.failure(
            error.code || 'FILL_FAILED',
            '字段替换失败；无可靠 shell 替换回退，不模拟全选删除。',
        );
        clean.details = { channels: attempts.map(item => item.channel), attempts };
        throw clean;
    }
}

async function tap(args = {}) {
    const client = requireAdb();
    const { serial, x, y, node, note } = await stepRuntime.stage('prepareMs', () => prepareTarget(args, '点击'));
    const attempts = await gesture(serial, 'click', [x, y], () => client.runText(['shell', 'input', 'tap', String(x), String(y)], { serial, timeoutMs: 15000 }));
    const label = node ? `控件 [${node.index}]「${node.label || node.cls}」` : `坐标 (${x}, ${y})`;
    return channelReceipt(textResult(`已点击 ${label}${note}。`, {
        serial,
        x,
        y,
        index: node ? node.index : null,
        selector: node ? node.selector : null,
    }), attempts);
}

const DOUBLE_TAP_INTERVAL_MS = 100;
const DOUBLE_TAP_WINDOW_MS = 120;
const DOUBLE_TAP_PRESS_MS = 20;

async function doubleTap(args = {}) {
    const attempts = [];
    const extra = { experimental: true, intervalMs: DOUBLE_TAP_INTERVAL_MS, pressDurationMs: DOUBLE_TAP_PRESS_MS };
    stepRuntime.inputReceipt({ channels: [], attempts, ...extra });
    const { serial, x, y, node, note } = await stepRuntime.stage('prepareMs', () => prepareTarget(args, '双击'));
    await dispatchInput(serial, async () => {
        const dispatchTiming = {};
        // The bundled two-argument click holds for 100ms; use explicit short taps so
        // sequential acknowledgements do not consume almost the entire double-tap window.
        await rpcAction(serial, 'click', [x, y, DOUBLE_TAP_PRESS_MS], attempts, RPC_OPERATION.WRITE, { dispatchTiming });
        const dispatchDeadline = dispatchTiming.startedAt + DOUBLE_TAP_WINDOW_MS;
        const waitMs = Math.max(0, dispatchTiming.startedAt + DOUBLE_TAP_INTERVAL_MS - performance.now());
        await stepRuntime.pause(waitMs);
        stepRuntime.check();
        await rpcAction(serial, 'click', [x, y, DOUBLE_TAP_PRESS_MS], attempts, RPC_OPERATION.WRITE, { dispatchDeadline });
    }, false);
    const label = node ? `控件 [${node.index}]「${node.label || node.cls}」` : `坐标 (${x}, ${y})`;
    return channelReceipt(textResult(`已向 ${label} 派发两次短按${note}；本次目标的双击识别须独立读回。`, {
        serial, x, y,
        index: node ? node.index : null,
        selector: node ? node.selector : null,
    }), attempts, extra);
}


const { drag, pinch } = require('./lib/gesture-actions').createGestureActions({
    stepRuntime, prepareTargets, rpcNodeSelector, dispatchInput, rpcAction, textResult, channelReceipt,
});

async function swipe(args = {}) {
    const client = requireAdb();
    const serial = resolveSerial(args);
    const x1 = requireInt(args.x1 ?? args.x, 'x1');
    const y1 = requireInt(args.y1 ?? args.y, 'y1');
    const x2 = requireInt(args.x2, 'x2');
    const y2 = requireInt(args.y2, 'y2');
    const duration = intOf(args.duration, 'duration', 300);
    if (duration < 1 || duration > 10000) throw stepRuntime.failure('INVALID_ARGUMENT', 'duration 必须在1–10000ms内。');
    await stepRuntime.stage('prepareMs', async () => {
        const size = await requireFrame(args, serial);
        if (!size || [x1, x2].some((x) => x < 0 || x >= size.width) || [y1, y2].some((y) => y < 0 || y >= size.height)) {
            throw stepRuntime.failure('INVALID_COORDINATES', '滑动坐标超出当前屏幕。');
        }

    });
    const attempts = await gesture(serial, 'swipe', [x1, y1, x2, y2, Math.max(1, Math.round(duration / 5))], () => client.runText(
        ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)],
        { serial, timeoutMs: 15000 },
    ));
    return channelReceipt(textResult(`已滑动 (${x1},${y1}) → (${x2},${y2})，历时 ${duration}ms。`, { serial, x1, y1, x2, y2, duration }), attempts);
}

const scrollUntil = require('./lib/scroll-until').createScrollUntil({
    stepRuntime, prepareTargets, rpcNodeSelector, dispatchInput, rpcAction, requireAdb,
    uiServerEnabled, uiServerFor, getGraph: serial => lastObserve.get(serial)?.graph,
    textResult, channelReceipt,
});

async function scroll(args = {}) {
    const direction = firstString(args.direction).toLowerCase();
    const distance = args.distance === undefined ? 0.6 : Number(args.distance);
    const duration = intOf(args.duration, 'duration', 300);
    const numeric = value => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value));
    const hasIndex = args.index !== undefined;
    if ((hasIndex && requireInt(args.index, 'index') < 0) || (args.distance !== undefined && !numeric(args.distance))) throw stepRuntime.failure('INVALID_ARGUMENT', 'Scroll index/distance/duration 必须为有效数字。');
    const semantic = hasIndex || args.selector !== undefined || firstString(args.id, args.resourceId, args.resource_id, args.text);
    if (!['up', 'down', 'left', 'right'].includes(direction) || !Number.isFinite(distance) || distance < 0.1 || distance > 0.9 || !Number.isInteger(duration) || duration < 1 || duration > 10000 || !semantic || ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'frameId'].some(key => args[key] !== undefined)) {
        throw stepRuntime.failure('INVALID_ARGUMENT', 'Scroll 需要语义目标及 direction=up|down|left|right；distance=0.1–0.9，duration=1–10000ms，不接受像素坐标。');
    }
    const { serial, node } = await stepRuntime.stage('prepareMs', () => prepareTarget(args, '滚动'));
    const box = node?.clipped;
    if (!node?.enabled || !node.inViewport || !node.flags.includes('scroll') || !box || box.right - box.left < 16 || box.bottom - box.top < 16) {
        throw stepRuntime.failure('INVALID_SCROLL_TARGET', '目标必须是当前可见且有足够空间的启用滚动容器。');
    }
    const horizontal = direction === 'left' || direction === 'right';
    const cx = (box.left + box.right) / 2;
    const cy = (box.top + box.bottom) / 2;
    const delta = (horizontal ? box.right - box.left : box.bottom - box.top) * distance / 2;
    const sign = direction === 'down' || direction === 'right' ? 1 : -1;
    const x1 = Math.round(cx + (horizontal ? sign * delta : 0));
    const y1 = Math.round(cy + (horizontal ? 0 : sign * delta));
    const x2 = Math.round(cx - (horizontal ? sign * delta : 0));
    const y2 = Math.round(cy - (horizontal ? 0 : sign * delta));
    const attempts = await gesture(serial, 'swipe', [x1, y1, x2, y2, Math.max(1, Math.round(duration / 5))], () => requireAdb().runText(
        ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(duration)],
        { serial, timeoutMs: 15000 },
    ));
    return channelReceipt(textResult(`已派发一次 ${direction} 滚动；不证明页面移动或到达边界。`, { serial, direction, distance, duration, index: node.index, x1, y1, x2, y2 }), attempts);
}


async function longPress(args = {}) {
    const client = requireAdb();
    const { serial, x, y, node, note } = await stepRuntime.stage('prepareMs', () => prepareTarget(args, '长按'));
    const duration = intOf(args.duration, 'duration', 800);
    if (duration < 300 || duration > 10000) throw stepRuntime.failure('INVALID_ARGUMENT', 'duration 必须在300–10000ms内。');
    // 原生 click(x,y,milliseconds)；只有明确未执行才降级同点 swipe，再到 shell。
    const steps = Math.max(1, Math.round(duration / 5));
    const attempts = await gesture(serial, 'click', [x, y, duration], () => client.runText(
        ['shell', 'input', 'swipe', String(x), String(y), String(x), String(y), String(duration)],
        { serial, timeoutMs: 15000 },
    ), { durationMs: duration, rpcFallback: { method: 'swipe', params: [x, y, x, y, steps] } });
    const label = node ? `控件 [${node.index}]「${node.label || node.cls}」` : `坐标 (${x}, ${y})`;
    return channelReceipt(textResult(`已长按 ${label}，${duration}ms${note}。`, {
        serial,
        x,
        y,
        duration,
        index: node ? node.index : null,
        selector: node ? node.selector : null,
    }), attempts);
}

const keyboardActions = require('./lib/keyboard-actions').createKeyboardActions({
    stepRuntime, prepareTarget, dispatchInput, rpcAction, RPC_OPERATION,
    captureGraph, fieldSelector, requireAdb, resolveSerial, ensureActiveDevice,
    textResult, channelReceipt,
});

async function imeAction(args = {}) { return keyboardActions.imeAction(args); }
async function eraseText(args = {}) { return keyboardActions.eraseText(args); }
async function keyCombo(args = {}) { return keyboardActions.keyCombo(args); }

async function keyEvent(args = {}) {
    const client = requireAdb();
    const serial = resolveSerial(args);
    const raw = firstString(args.key, args.keyevent, args.code);
    if (!raw) throw new Error('[AndroidController] 缺少 key（如 back、home、enter，或 KEYCODE_*）。');

    const normalized = raw.toLowerCase().replace(/[\s_-]/g, '');
    let keycode = KEY_ALIASES[normalized] || null;
    if (!keycode && /^keycode_[A-Z0-9_]+$/i.test(raw)) keycode = raw.toUpperCase();
    if (!keycode && /^\d+$/.test(raw)) keycode = raw;
    if (!keycode) {
        throw new Error(`[AndroidController] 不认识按键「${raw}」。可用别名：${Object.keys(KEY_ALIASES).join(', ')}，或直接给 KEYCODE_* / 数字码。`);
    }

    await dispatchInput(serial, () => client.runText(['shell', 'input', 'keyevent', String(keycode)], { serial, timeoutMs: 15000 }));
    return textResult(`已发送按键 ${keycode}。`, { serial, keycode, requested: raw });
}



/**
 * 剪贴板写入之后，用哪条路子把内容粘进当前光标。
 *
 * 真机证据（PJZ110 / ColorOS / Android 17，逐条实测而非推断）：
 *   setClipboard   → 成功（返回 null）
 *   getClipboard   → 成功（能读回刚写入的内容）
 *   pasteClipboard → java.lang.AssertionError
 * 三个方法共用同一套隐藏 IClipboard 反射，但**不是同生共死**：死的只有 paste 一个。
 * 所以「剪贴板整组不可用」是错结论，按组一刀切会把 set/get 一起封掉。
 *
 * KEYCODE_PASTE(279) 是 TextView 自己的聚合粘贴路径，不碰那套反射。但它的适用范围
 * 实测只到原生 EditText：WebView 渲染的编辑框（com.coloros.note 的 WVJBWebView）
 * 直接忽略它，setClipboard 成功后发 279、字段依旧为空。
 * 依然只是「已派发」，不声称粘贴成功 —— 验证者必须是独立读回。
 */
const KEYCODE_PASTE = 'KEYCODE_PASTE';

/**
 * keyevent is the default; rpc uses pasteClipboard unless this generation recorded a failure.
 * none disables clipboard input. Neither dispatch path proves that text was inserted.
 */
function clipboardPasteStrategy(serial) {
    const raw = String(runtime.config?.CLIPBOARD_PASTE ?? 'keyevent').trim().toLowerCase();
    if (raw === 'off' || raw === 'none' || raw === 'false' || raw === '0') return 'none';
    if (raw !== 'rpc') return 'keyevent';
    const server = uiServers.get(String(serial || ''));
    const observed = server?.capability('pasteClipboard');
    return observed === 'unavailable' ? 'keyevent' : 'rpc';
}



async function hasAdbKeyboard(serial) {
    const cacheKey = serial || 'default';
    if (adbKeyboardCache.has(cacheKey)) return adbKeyboardCache.get(cacheKey);
    try {
        const output = await adb.runText(['shell', 'pm', 'list', 'packages', ADB_KEYBOARD_PACKAGE], { serial, timeoutMs: 15000 });
        const available = output.includes(ADB_KEYBOARD_PACKAGE);
        adbKeyboardCache.set(cacheKey, available);
        return available;
    } catch {
        adbKeyboardCache.set(cacheKey, false);
        return false;
    }
}

async function inputText(args = {}) {
    const client = requireAdb();
    const serial = resolveSerial(args);
    const text = String(args.text ?? args.content ?? '');
    if (!text) throw new Error('[AndroidController] 缺少 text。');
    if (text.length > MAX_TEXT_INPUT) {
        throw new Error(`[AndroidController] 文本过长（${text.length} > ${MAX_TEXT_INPUT}），请分段输入。`);
    }

    const enter = args.enter === true || String(args.enter).toLowerCase() === 'true';
    // eslint-disable-next-line no-control-regex
    const asciiOnly = /^[\x20-\x7E\r\n\t]*$/.test(text);

    if (asciiOnly) {
        // input text 以空格分词，必须把空格换成 %s，再整体单引号包起来
        const escaped = text.replace(/([\\%'"()&|;<>*?$`])/g, '\\$1').replace(/ /g, '%s');
        await dispatchInput(serial, async () => {
            await client.runText(['shell', 'input', 'text', shellQuote(escaped)], { serial, timeoutMs: 20000 });
            stepRuntime.check();
            if (enter) await client.runText(['shell', 'input', 'keyevent', 'KEYCODE_ENTER'], { serial, timeoutMs: 10000 });
        });
        return textResult(`已输入 ASCII 文本（${text.length} 字符）${enter ? '并回车' : ''}。`, {
            serial, method: 'input-text', ascii: true,
        });
    }

    const attempts = [];
    let clipboard = null;
    // Only explicit RPC mode consults observed paste failures; no mutating capability probe.
    const strategy = clipboardPasteStrategy(serial);
    if (strategy !== 'none') {
        try {
            await dispatchInput(serial, async () => {
                await rpcAction(
                    serial, 'setClipboard', ['AndroidController', text], attempts, RPC_OPERATION.WRITE,
                );
                clipboard = 'replaced';
                stepRuntime.inputReceipt({ channels: attempts.map(item => item.channel), attempts, clipboard });
                stepRuntime.check();
                if (strategy === 'keyevent') {
                    // KEYCODE_PASTE uses the focused widget; acknowledgement does not prove insertion.
                    const attempt = { channel: 'keyevent', method: KEYCODE_PASTE, status: 'dispatched' };
                    attempts.push(attempt);
                    stepRuntime.inputReceipt({ channels: attempts.map(item => item.channel), attempts, clipboard });
                    stepRuntime.markDispatched();
                    await client.runText(['shell', 'input', 'keyevent', '279'], { serial, timeoutMs: 10000 });
                } else {
                    try {
                        await rpcAction(serial, 'pasteClipboard', [], attempts, RPC_OPERATION.WRITE);
                    } catch (error) {
                        // This policy applies to future requests, never replaying the current write.
                        if (error.code === 'UI_SERVER_RPC_ERROR' && error.drained === true) {
                            uiServerFor(serial).noteCapability('pasteClipboard', 'unavailable');
                        }
                        throw error;
                    }
                }
                stepRuntime.check();
                if (enter) await client.runText(['shell', 'input', 'keyevent', 'KEYCODE_ENTER'], { serial, timeoutMs: 10000 });
            }, false);
            return channelReceipt(textResult(
                '已派发当前光标/选区的 Unicode 粘贴；不证明字段值。',
                { serial, method: strategy === 'keyevent' ? 'rpc-clipboard+keyevent-paste' : 'rpc-clipboard', ascii: false },
            ), attempts, { clipboard, pasteStrategy: strategy });
        } catch (error) {

            error.details = { ...error.details, ...(clipboard ? { clipboard } : {}) };
            stepRuntime.check();
            if (error.dispatched !== false) throw error;
        }
    }
    stepRuntime.check();
    // 非 ASCII 必须走 ADBKeyboard 的 base64 广播，input text 处理不了中文
    const fallback = { channel: 'adbkeyboard', status: 'not-dispatched' };
    attempts.push(fallback);
    stepRuntime.inputReceipt({ channels: attempts.map(item => item.channel), attempts, ...(clipboard ? { clipboard } : {}) });
    try {
        if (!(await hasAdbKeyboard(serial))) {
            throw stepRuntime.failure('ADB_KEYBOARD_NOT_ACTIVE',
                '[AndroidController] 非 ASCII 文本（如中文）需要 ADBKeyboard 输入法。\n'
                + '请先安装 https://github.com/senzhk/ADBKeyBoard 的 APK，并切换为当前输入法：\n'
                + '  adb shell ime enable com.android.adbkeyboard/.AdbIME\n'
                + '  adb shell ime set com.android.adbkeyboard/.AdbIME\n'
                + '若只用英文输入可继续使用 input text。',
            );
        }

        stepRuntime.check();
        const currentIme = await client.runText(
            ['shell', 'settings', 'get', 'secure', 'default_input_method'],
            { serial, timeoutMs: 10000 },
        ).catch(() => {
            stepRuntime.check();
            return '';
        });
        stepRuntime.check();
        const adbKeyboardComponents = [
            'com.android.adbkeyboard/.AdbIME',
            'com.android.adbkeyboard/com.android.adbkeyboard.AdbIME',
        ];
        if (!adbKeyboardComponents.includes(currentIme.trim())) {
            throw stepRuntime.failure('ADB_KEYBOARD_NOT_ACTIVE', 'ADBKeyboard 不是当前输入法或无法确认；未派发文本，不自动切换输入法。');
        }
        fallback.status = 'dispatched';
        const base64 = Buffer.from(text, 'utf8').toString('base64');
        await dispatchInput(serial, async () => {
            await client.runText(
                ['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', shellQuote(base64)],
                { serial, timeoutMs: 20000 },
            );
            stepRuntime.check();
            if (enter) {
                await client.runText(
                    ['shell', 'input', 'keyevent', 'KEYCODE_ENTER'],
                    { serial, timeoutMs: 10000 },
                );
            }
        });
        return channelReceipt(textResult(
            `已通过 ADBKeyboard 输入文本（${text.length} 字符）${enter ? '并回车' : ''}。`,
            { serial, method: 'adbkeyboard-b64', ascii: false },
        ), attempts, clipboard ? { clipboard } : {});
    } catch (error) {
        fallback.code = error.code || 'INPUT_FAILED';
        if (fallback.status === 'dispatched') fallback.status = 'unknown';
        const clean = stepRuntime.failure(error.code || 'INPUT_FAILED', 'Unicode 输入失败；不自动切换输入法或重放。');
        clean.details = { channels: attempts.map(item => item.channel), attempts, ...(clipboard ? { clipboard } : {}) };
        throw clean;
    }
}

/** Select one launcher, dispatch once, and verify foreground independently of command output. */
async function launchApp(args = {}, context = {}) {

    const client = context?.client || requireAdb();
    const serial = resolveSerial(args);
    const pkg = firstString(args.package, args.packageName, args.app);
    if (args.url !== undefined) return launchUrl(args, client, serial, pkg);
    if (!pkg) throw new Error('[AndroidController] 缺少 package（如 com.tencent.mm）。');
    validatePackage(pkg);
    const activity = firstString(args.activity);
    if (activity && !/^(?:\.?[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(activity)) {
        throw stepRuntime.failure('INVALID_ARGUMENT', 'activity 组件名称无效。');
    }
    // stop=true 先杀掉再起：应用已停在深层页面时，am start 可能只是恢复旧任务栈
    const stopFirst = args.stop === true || String(args.stop).toLowerCase() === 'true';
    if (stopFirst) {
        await dispatchInput(serial, () => client.runText(['shell', 'am', 'force-stop', pkg], { serial, timeoutMs: 15000 })).catch(() => { stepRuntime.check(); return ''; });
    }

    const steps = [];
    let output = '';
    let component = activity ? `${pkg}/${activity}` : '';

    // 先确认包真的存在。否则 monkey 会抛一大段 adb 原始输出，
    // 调用方看不出是「包名写错了」还是「启动失败了」。
    // 注意：查询本身失败（多设备、超时）不等于包不存在 —— 不能据此报 APP_NOT_FOUND。
    const listed = await client
        .runText(['shell', 'pm', 'list', 'packages', pkg], { serial, timeoutMs: 15000 })
        .catch(() => { stepRuntime.check(); return null; });
    if (listed !== null && !String(listed).split(/\r?\n/).some(line => line.trim() === `package:${pkg}`)) {
        const clean = new Error(`[AndroidController] 设备上没有 ${pkg}。用 ListPackages 查看可用的包名。`);
        clean.code = 'APP_NOT_FOUND';
        throw clean;
    }
    // 查不到就继续尝试启动：宁可多试一次，也不要谎称包不存在

    if (!component) {
        // Resolve a launcher before considering monkey.
        const resolved = await client
            .runText(['shell', 'cmd', 'package', 'resolve-activity', '--brief', pkg], { serial, timeoutMs: 15000 })
            .catch(() => { stepRuntime.check(); return ''; });
        const candidate = String(resolved).split(/\r?\n/).map((s) => s.trim())
            .filter((s) => s.includes('/')).pop() || '';
        if (/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)*\/(?:\.?[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(candidate)) component = candidate;
    }
    if (component) {
        output = await dispatchInput(serial, () => client.runText(['shell', 'am', 'start', '-n', component], { serial, timeoutMs: 20000 }));
        steps.push({ by: activity ? 'activity' : 'resolve-activity', component, output: output.trim() });
    } else {
        // No component resolved: dispatch monkey once, then verify foreground.
        output = await dispatchInput(serial, () => client.runText(
            ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
            { serial, timeoutMs: 25000 },
        )).catch(() => {
            stepRuntime.check();
            // Hide raw command output; a failed package query does not prove existence.
            const clean = new Error(`[AndroidController] ${pkg} 存在，但没有找到可启动的界面。`
                + '如果它是个服务类应用，需要显式指定 activity。');
            clean.code = 'NO_LAUNCHER_ACTIVITY';
            throw clean;
        });
        steps.push({ by: 'monkey', output: output.trim() });
    }

    // 等前台稳定：应用冷启动需要时间，轮询到 pkg 出现或超时
    const foreground = await stepRuntime.stage('verificationMs', () => waitForForeground(client, pkg, 6000, serial));
    const ok = foreground.package === pkg;
    stepRuntime.verified(ok, { condition: { type: 'foreground', package: pkg }, evidence: foreground });

    const launchedBy = component || 'monkey';
    const head = ok ? `已打开 ${pkg}` : `启动 ${pkg} 失败`;
    const detail = ok
        ? `\n入口：${launchedBy}`
        : `\n当前前台：${foreground.package || '(未知)'}`
            + '\n如果应用确实开着，试试 stop=true 先杀掉再启动。';

    return textResult(`${head}${detail}`, {
        serial,
        package: pkg,
        activity: activity || null,
        launchedBy,
        ok,
        failed: !ok,
        foreground: foreground.package,
        foregroundActivity: foreground.component,
        steps,
        output: output.trim().slice(0, 600),
    });
}

async function launchUrl(args, client, serial, pkg) {
    const raw = args.url;
    if (!pkg || typeof raw !== 'string' || raw.length < 1 || raw.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(raw) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw) || args.activity !== undefined || (args.stop !== undefined && args.stop !== false && args.stop !== 'false')) {
        throw stepRuntime.failure('INVALID_ARGUMENT', 'URL导航必须指定package及1–4096字符http/https URL，不接受控制字符、空白、反斜杠、activity或stop。');
    }
    validatePackage(pkg);
    let url;
    try { url = new URL(raw); } catch { throw stepRuntime.failure('INVALID_ARGUMENT', 'URL格式无效。'); }
    if (!/^https?:\/\//i.test(raw) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw stepRuntime.failure('INVALID_ARGUMENT', 'URL仅支持无账号密码的http/https地址。');
    const intent = ['-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE', '-d', shellQuote(raw)];
    let resolved;
    try {
        resolved = await client.runText(['shell', 'cmd', 'package', 'resolve-activity', '--brief', ...intent, '-p', pkg], { serial, timeoutMs: 15000 });
    } catch {
        stepRuntime.check();
        throw stepRuntime.failure('URL_RESOLUTION_FAILED', '无法确认目标应用的URL处理组件；未派发。');
    }
    const components = String(resolved).split(/\r?\n/).map(line => line.trim()).filter(line => line.includes('/'));
    const component = components[0] || '';
    const activity = component.slice(pkg.length + 1);
    if (components.length !== 1 || !component.startsWith(`${pkg}/`) || !/^(?:\.?[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(activity)) throw stepRuntime.failure('URL_NOT_SUPPORTED', '目标应用没有唯一可确认的URL处理组件；未派发，不回退其他应用。');
    try {
        const output = await dispatchInput(serial, () => client.runText(['shell', 'am', 'start', ...intent, '-n', component], { serial, timeoutMs: 20000 }));
        if (/\b(?:Error|Exception|SecurityException)\b/i.test(output)) throw new Error();
    } catch {
        stepRuntime.check();
        throw stepRuntime.failure('URL_DISPATCH_FAILED', 'URL导航可能已派发但未确认；不重试，不返回原始命令。');
    }
    const foreground = await stepRuntime.stage('verificationMs', () => waitForForeground(client, pkg, 6000, serial));
    const ok = foreground.package === pkg;
    stepRuntime.verified(ok, { condition: { type: 'foreground', package: pkg }, evidence: { package: foreground.package } });
    return textResult(`已派发URL导航；目标应用前台${ok ? '已确认' : '未确认'}。不证明网页加载、路径到达或业务成功。`, { serial, package: pkg, launchedBy: component, ok, pageLoaded: null });
}


/**
 * 轮询等应用进入前台。
 *
 * 用两个来源交叉确认：dumpsys 的 topResumedActivity 与 mCurrentFocus。
 * 前者反映任务栈顶部，后者反映实际获得输入的窗口 —— 冷启动期间两者会短暂不一致。
 */
async function waitForForeground(client, pkg, timeoutMs = 5000, serial = client.serial) {
    const deadline = Date.now() + timeoutMs;
    let last = { package: null, component: null };
    while (Date.now() < deadline) {
        const focus = await client.currentFocus(serial).catch(() => ({ package: null, component: null }));
        last = focus || last;
        if (focus?.package === pkg) return focus;
        await stepRuntime.pause(300);
    }
    return last;
}

async function killApp(args = {}) {
    const client = requireAdb();
    const serial = resolveSerial(args);
    const pkg = firstString(args.package, args.packageName, args.app);
    if (!pkg) throw new Error('[AndroidController] 缺少 package。');
    validatePackage(pkg);
    const output = await dispatchInput(serial, () => client.runText(['shell', 'am', 'force-stop', pkg], { serial, timeoutMs: 20000 }));
    return textResult(`已停止 ${pkg}。${output.trim() ? `\n${output.trim()}` : ''}`, { serial, package: pkg });
}

async function listPackages(args = {}) {
    const client = requireAdb();
    const serial = resolveSerial(args);
    const filter = firstString(args.filter, args.query).toLowerCase();
    const output = await client.runText(['shell', 'pm', 'list', 'packages'], { serial, timeoutMs: 25000 });
    let packages = output.split(/\r?\n/)
        .map((line) => line.replace(/^package:/, '').trim())
        .filter(Boolean);
    if (filter) packages = packages.filter((name) => name.toLowerCase().includes(filter));
    packages.sort();

    const shown = packages.slice(0, 200);
    return textResult(
        `应用包名${filter ? `（含「${filter}」）` : ''}：${packages.length} 个`
        + `${packages.length > shown.length ? `，显示前 ${shown.length} 个` : ''}\n${shown.join('\n')}`,
        { serial, filter: filter || null, packages: shown, total: packages.length },
    );
}

// ---------------------------------------------------------------------------
// 显示屏
// ---------------------------------------------------------------------------

async function ensureDisplay(args = {}) {
    if (displayStarting) return displayStarting;
    if (streamServer?.server && streamServer.actualPort && !streamServer.stopped
        && !streamServer.startPromise && !streamServer.stopPromise) return streamServer;

    displayStarting = (async () => {
        const requestedPort = intOf(args.port, 'port', null);
        if (requestedPort && requestedPort !== streamServer?.port) {
            streamServer.port = clamp(requestedPort, 1024, 65535);
        }
        await streamServer.start();
        await syncLoomAppUrl({ manager: runtime.loomManager, appId: runtime.config.LOOM_APP_ID || 'android-mirror', url: streamServer.url(), logger: runtime.logger });
        return streamServer;
    })().finally(() => { displayStarting = null; });

    return displayStarting;
}


async function startDisplay(args = {}) {
    const server = await ensureDisplay(args);
    const url = server.url();
    // 预热一帧，页面一打开就有画面
    await frameHub.capture().catch(() => {});

    const openInChat = args.open === true || String(args.open).toLowerCase() === 'true';
    let sidePane = null;
    let sidePaneError = null;
    if (openInChat) {
        try {
            sidePane = await openInSidePane(url);
        } catch (error) {
            // 侧栏可能因为主窗口未就绪而失败；这不影响显示屏本身，降级为提示 URL
            sidePaneError = error.message;
        }
    }

    const target = sidePane
        ? `已在 VCPChat 侧栏打开标签页（${sidePane.targetId || 'browser'}）。`
        : sidePaneError
            ? `侧栏打开失败：${sidePaneError}\n可手动在侧栏地址栏输入上面的地址。`
            : '在 Loom 中打开「Android 显示屏」应用，或在侧栏地址栏输入上面的地址。';

    return textResult(
        `手机显示屏已就绪：${url}\n\n${target}\n`
        + '该服务只监听 127.0.0.1，不对外网暴露。',
        { url, port: server.actualPort, sidePane, sidePaneError },
    );
}

/**
 * 把显示屏开进 VCPChat 主界面的侧栏浏览器。
 *
 * 复用既有 side pane，而不是新开窗口或 iframe：
 * - browserHandlers 的 guest 白名单已含 http:，127.0.0.1 直接放行
 * - 不触碰 main.html 的 CSP，零侵入
 * - 聊天与手机画面并排，形成「人说一句 → AI 点一下 → 立刻看见」的闭环
 *
 * loomManager 由 VCPDistributedServer 通过 services 注入，不保证存在（独立运行插件时）。
 */
async function openInSidePane(url) {
    const manager = runtime.loomManager;
    if (!manager?.sideBrowser?.open) {
        throw new Error('当前环境没有可用的侧栏浏览器（LoomManager 未注入）。');
    }
    const described = await manager.sideBrowser.open({ url });
    return {
        targetId: described?.targetId || described?.id || null,
        url,
        title: described?.title || null,
    };
}

async function stopDisplay() {
    if (!streamServer?.server) return textResult('显示屏未在运行。', { running: false });
    await streamServer.stop();
    frameHub.pauseLoop();
    return textResult('显示屏已停止。', { running: false });
}

async function displayStatus() {
    const url = streamServer?.url() || null;
    const status = frameHub.status();
    return textResult(
        `显示屏：${url || '未启动'}\n`
        + `推流中：${status.streaming ? '是' : '否'}\n`
        + `订阅者：${status.subscribers}\n`
        + `已出帧：${status.seq}\n`
        + `最近帧龄：${status.latestAgeMs === null ? '无' : `${status.latestAgeMs}ms`}\n`
        + `单帧耗时：${status.lastDurationMs}ms\n`
        + `格式：${status.format} q=${status.quality} 间隔=${status.intervalMs}ms\n`
        + (status.lastError ? `最近错误：${status.lastError.message}` : '最近错误：无'),
        { url, ...status },
    );
}

// ---------------------------------------------------------------------------
// 视觉通道
// ---------------------------------------------------------------------------

/**
 * 按需把当前屏幕像素交给模型；与 Observe screenshot 一样内嵌图片，
 * 同时返回坐标映射和单次 frameId。
 *
 * 三种取图方式：
 *   - 默认：整屏
 *   - target="canvas"：裁到上一个 Observe 识别出的画布区域（地图 / 游戏必用）
 *   - region：显式给设备坐标
 */
async function screenshot(args = {}) {
    if (args.target === 'element') stepRuntime.inputReceipt({ experimental: true, milestone: 'M2' });
    elementShot.validate(args);
    if (!frameHub) throw new Error('[AndroidController] 画面采集未初始化。');
    const client = requireAdb();
    const requested = resolveSerial(args);
    // 和 Observe 共用同一套选设备逻辑：同一台机器可能同时存在
    // WiFi 直连与 mDNS 两条传输，此时没显式指定 serial 就不能硬跑，
    // 否则 `wm size` 会直接报 "more than one device"。
    const { serial } = await ensureActiveDevice(client, requested);

    const shot = await captureVisionShot({ client, serial, args });
    const size = shot.size;

    return {
        content: [
            { type: 'text', text: describeVisionShot(shot, { serial, size }) },
            { type: 'image_url', image_url: { url: shot.frame.dataUrl } },
        ],
        details: {
            command: 'Screenshot',
            serial,
            screen: size,
            image: shot.frame,
            mapping: shot.frame.mapping,
            region: shot.frame.mapping.region,
            canvas: shot.canvas,
                        ...(shot.element ? { element: shot.element, experimental: true } : {}),
                        capturedAt: Date.now(),
            frameId: shot.frame.frameId,
        },
    };
}

async function captureVisionShot({ client, serial, size, args = {} }) {
    lastVision.delete(serial);
    assertDeviceCertain(serial);
    const before = await freshFrameProbe(client, serial);
    const context = frameContext(before);
    size = logicalSize(before?.size) || logicalSize(size) || logicalSize(await client.screenSize(serial).catch(() => null));
    stepRuntime.check();
    // 区域优先级：元素目标、显式 region、target=canvas、整屏。
    let region = null;
    let regionNote = '';
    const target = firstString(args.target, args.crop);
    elementShot.validate(args);
    const baseline = target === 'element' ? await elementShot.prepare({ client, serial, size, args }) : null;
    if (baseline) {
        region = baseline.element.region;
        regionNote = '已裁到当前元素；遮挡状态未知，padding仅增加图像上下文。';
    } else if (args.region && typeof args.region === 'object') {
        region = args.region;
    } else if (target && target.toLowerCase() === 'canvas') {
        const record = lastObserve.get(serial) || null;
        const bounds = record?.graph?.canvas?.bounds;
        if (bounds && bounds.width > 0 && bounds.height > 0) {
            region = bounds;
            regionNote = `已裁到画布区域（${(record.graph.canvas.kinds || []).join('/')}）`;
        } else {
            regionNote = '未找到画布区域（先跑一次 Observe），本次回退整屏。';
        }
    }

    const sharp = frameHub.requireSharp();
    // 采集原生分辨率，复用统一裁剪、缩放、网格和设备坐标映射。
    const frame = await frameHub.captureOneShot({ serial, raw: true, ...(size ? { maxWidth: size.width } : {}), format: 'png' });
    if (!size) {
        size = logicalSize(frame.raw) || logicalSize(frame);
        if (!size && Buffer.isBuffer(frame.buffer)) size = logicalSize(await sharp(frame.buffer).metadata());
        if (!size) throw new Error('[AndroidController] 无法读取截图尺寸。');
    }
    const frameResult = await vision.buildVisionFrame({
        sharp,
        frame,
        screen: size,
        region,
        maxWidth: parseOptionalInt(args.maxWidth) || parseOptionalInt(args.width) || vision.DEFAULT_MAX_WIDTH,
        format: firstString(args.format) || 'jpeg',
        quality: parseOptionalInt(args.quality),
        grid: args.grid !== false && String(args.grid).toLowerCase() !== 'false',
    });

    if (baseline) await elementShot.verify({ client, serial, size, args, baseline });
    const after = await freshFrameProbe(client, serial);
    stepRuntime.check();
    const afterContext = frameContext(after);
    const reason = !context || !afterContext ? 'CONTEXT_UNKNOWN'
        : !sameFrameContext(context, afterContext) ? 'CONTEXT_CHANGED'
            : frameResult.sourceWidth !== size.width || frameResult.sourceHeight !== size.height ? 'SOURCE_SIZE_MISMATCH' : 'READY';
    const actionable = reason === 'READY';
    const record = lastObserve.get(serial) || null;
    const frameId = actionable ? randomUUID() : null;
    if (actionable) lastVision.set(serial, { frameId, at: Date.now(), context });
    return {
        size,
        frame: {
            frameId,
            actionable,
            reason,
            sourceWidth: frameResult.sourceWidth,
            sourceHeight: frameResult.sourceHeight,
            width: frameResult.width,
            height: frameResult.height,
            mime: frameResult.mime,
            byteLength: frameResult.byteLength,
            grid: frameResult.grid,
            mapping: frameResult.mapping,
            dataUrl: frameResult.dataUrl,
        },
        canvas: record?.graph?.canvas || null,
        element: baseline?.element || null,
        regionNote,
    };
}

/** 把一次视觉截图的元信息写成模型能直接用的说明。 */
function describeVisionShot(shot, { serial }) {
    const { frame, canvas, regionNote } = shot;
    const size = shot.size;
    return [
        `设备：${serial || '(当前设备)'}`,
        `屏幕：${size.width}×${size.height}`,
        frame.actionable ? `图像凭据：${frame.frameId}（像素动作必须携带 frameId，动作后失效）`
            : `图像凭据：null（${frame.reason}；仅供显示，不可用作坐标动作）`,
        regionNote || null,
        shot.element ? JSON.stringify({ element: shot.element, experimental: true }) : null,
        frame.actionable ? vision.describeMapping(frame.mapping) : '坐标映射未经确认，仅供显示参考。',
        `图像：${frame.width}×${frame.height}  ${Math.round(frame.byteLength / 1024)}KB  ${frame.mime}`,
        frame.grid ? '网格：已叠加（标签为设备坐标）' : '网格：未叠加（模型需自行按换算公式换算）',
        canvas?.present
            ? `画布：${(canvas.kinds || []).join('/')} 占屏 ${Math.round((canvas.coverage || 0) * 100)}%，内部内容只能从图中读`
            : null,
        frame.actionable ? '点击时直接传设备坐标（Tap 的 x/y），不要传图上坐标。' : '请重新截图取得有效 frameId 后再操作。',
    ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

const ACTIONS = Object.freeze({
    tap, doubletap: doubleTap, swipe, scroll, scrolluntil: scrollUntil, fill, longpress: longPress, inputtext: inputText,
    drag, pinch, imeaction: imeAction, erasetext: eraseText, keycombo: keyCombo,
    keyevent: keyEvent, launchapp: launchApp, killapp: killApp, system: systemOperation,
});
const STEP_ACTIONS = new Set([...Object.keys(ACTIONS), 'wait']);

function parseObject(value, label) {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { throw stepRuntime.failure('INVALID_ARGUMENT', `${label} 必须是 JSON 对象。`); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw stepRuntime.failure('INVALID_ARGUMENT', `${label} 必须是对象。`);
    return value;
}

function validateSelector(selector) {
    if (!isValidSelector(selector)) throw stepRuntime.failure('INVALID_ARGUMENT', 'selector 格式无效；请使用合法属性条件与显式序号。');
}

function parseExpectation(raw) {
    if (raw === undefined || raw === null) return null;
    const expected = parseObject(raw, 'expect 后置条件');
    if (['visible', 'absent'].includes(expected.type)) {
        if (expected.selector === undefined) throw stepRuntime.failure('INVALID_ARGUMENT', 'expect 必须提供非空 selector。');
        validateSelector(expected.selector);
    } else if (expected.type === 'foreground') {
        validatePackage(firstString(expected.package));
    } else throw stepRuntime.failure('INVALID_ARGUMENT', 'expect 后置条件仅支持 visible、absent、foreground。');
    return expected;
}

function parseAfterObserve(value) {
    if (value === undefined || value === false || value === 'false') return null;
    if (value === true || value === 'true') return {};
    const options = { ...parseObject(value, 'afterObserve') };
    const allowed = ['mode', 'limit', 'screenshot', 'region', 'target', 'maxWidth', 'format', 'quality', 'grid', 'selector', 'id', 'index', 'snapshotId', 'padding'];
    if (Object.keys(options).some(key => !allowed.includes(key))) throw stepRuntime.failure('INVALID_ARGUMENT', 'afterObserve 含未知字段。');
    if (options.mode !== undefined && !['ui', 'image'].includes(options.mode)) throw stepRuntime.failure('INVALID_ARGUMENT', 'afterObserve mode 仅支持 ui、image。');
    for (const [key, min, max] of [['limit', 1, 500], ['maxWidth', 64, 4096], ['quality', 10, 95]]) {
        if (options[key] === undefined) continue;
        const parsed = intOf(options[key], `afterObserve ${key}`);
        if (parsed === null || parsed < min || parsed > max) throw stepRuntime.failure('INVALID_ARGUMENT', `afterObserve ${key} 越界。`);
        options[key] = parsed;
    }
    for (const key of ['screenshot', 'grid']) {
        if (options[key] !== undefined && typeof options[key] !== 'boolean') throw stepRuntime.failure('INVALID_ARGUMENT', `afterObserve ${key} 必须是布尔值。`);
    }
    if (options.format !== undefined && !['png', 'jpeg'].includes(options.format)) throw stepRuntime.failure('INVALID_ARGUMENT', 'afterObserve format 无效。');
    if (options.target !== undefined && !['canvas', 'element'].includes(options.target)) throw stepRuntime.failure('INVALID_ARGUMENT', 'afterObserve target 仅支持 canvas、element。');
    elementShot.validate(options);
    if (options.target !== 'element' && ['selector', 'id', 'index', 'snapshotId'].some(key => options[key] !== undefined)) throw stepRuntime.failure('INVALID_ARGUMENT', '元素寻址字段仅用于target=element。');
    if (options.region !== undefined) {
        const region = options.region;
        if (!region || typeof region !== 'object' || Array.isArray(region) || Object.keys(region).some(key => !['left', 'top', 'width', 'height'].includes(key)) || !['left', 'top', 'width', 'height'].every(key => Number.isInteger(region[key])) || region.left < 0 || region.top < 0 || region.width <= 0 || region.height <= 0) throw stepRuntime.failure('INVALID_ARGUMENT', 'afterObserve region 必须为有效设备坐标矩形。');
    }
    return options;
}

async function appendObservation(result, after, serial, sample = null) {
    if (!after) return result;
    try {
        assertDeviceCertain(serial);
        let observed;
        if (after.mode !== 'image' && sample && Date.now() - sample.at < STALE_SNAPSHOT_MS) {
            // Reuse the acquired tree, provenance and timestamp as one immutable sample.
            observed = await renderObservation(after, sample);
        } else observed = await observe({ ...after, serial, wake: 'never' });
        result.content.push(...observed.content);
        result.details = { ...result.details, observation: { status: 'observed', ...observed.details } };
    } catch {
        stepRuntime.check();
        const code = after.mode === 'image' ? 'IMAGE_ACQUISITION_FAILED' : 'UI_ACQUISITION_FAILED';
        result.details = { ...result.details, observation: { status: 'failed', code } };
        result.content.push({ type: 'text', text: JSON.stringify({ observation: result.details.observation }) });
    }
    return result;
}

async function executeSequence(args, executionContext) {
    const steps = args.steps;
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 8 || ['action', 'expect', 'waitTimeoutMs'].some(key => args[key] !== undefined)) throw stepRuntime.failure('INVALID_ARGUMENT', 'steps需要1–8步，不可混用外层action/expect/waitTimeoutMs。');
    const after = parseAfterObserve(args.afterObserve);
    const serial = resolveSerial(args);
    const parsed = steps.map((raw, index) => {
        const step = parseObject(raw, 'step');
        if (Object.keys(step).some(key => !['action', 'expect', 'waitTimeoutMs'].includes(key))) throw stepRuntime.failure('INVALID_ARGUMENT', 'step只接受action/expect/waitTimeoutMs。');
        const action = parseObject(step.action, 'action');
        const command = commandOf(action);
        const nestedTarget = command === 'drag' && action.target && typeof action.target === 'object' ? action.target : {};
        const deviceKeys = ['serial', 'device', 'deviceSerial'];
        const credentialKeys = ['index', 'snapshotId', 'frameId', 'x', 'y', 'x1', 'y1', 'x2', 'y2'];
        if (!STEP_ACTIONS.has(command) || command === 'system' || deviceKeys.some(key => action[key] !== undefined || nestedTarget[key] !== undefined) || (index > 0 && credentialKeys.some(key => action[key] !== undefined || nestedTarget[key] !== undefined))) throw stepRuntime.failure('INVALID_ARGUMENT', '序列仅支持绑定设备的GUI动作；后续步骤必须实时语义定位，不能复用旧凭据。');
        const expect = parseExpectation(step.expect);
        validateWait(action, command, expect);
        if (index < steps.length - 1 && !expect) throw stepRuntime.failure('INVALID_ARGUMENT', '中间步骤必须声明expect，通过验证后才继续。');
        const waitTimeoutMs = intOf(step.waitTimeoutMs, 'waitTimeoutMs', 5000);
        if (waitTimeoutMs < 1 || waitTimeoutMs > 30000) throw stepRuntime.failure('INVALID_ARGUMENT', 'waitTimeoutMs必须在1–30000ms内。');
        return { action, expected: expect, waitMs: waitTimeoutMs, command };
    });
    stepRuntime.beginSequence(parsed.length);
    const receipts = [];
    let result;
    let status = 'completed';
    for (const step of parsed) {
        stepRuntime.check();
        const isIntermediate = step !== parsed.at(-1);
        stepRuntime.beginItem(step.command);
        stepRuntime.setActionCommand(step.command);
        const experimentalM2 = markStepExperiment(step.action, step.expected);
        result = await executeStepPlan({ ...step, experimentalM2 }, serial, isIntermediate ? null : after, executionContext);
        const receipt = stepRuntime.finishItem(isIntermediate);
        receipts.push(receipt);
        if (receipt.outcome === 'unknown' || (isIntermediate && receipt.outcome !== 'verified')) {
            status = 'stopped';
            break;
        }
    }
    const sequence = { status, total: parsed.length, steps: receipts };
    result.details = { ...result.details, sequence };
    result.content.push({ type: 'text', text: JSON.stringify({ sequence }) });
    return result.details.observation ? result : appendObservation(result, after, serial);
}

async function waitIdle(serial, timeoutMs) {
    const client = requireAdb();
    const deadlineMs = Date.now() + Math.min(timeoutMs, stepRuntime.remainingMs());
    const inBudget = task => typeof client.withContext === 'function' ? client.withContext({ deadlineMs }, task) : task();
    const freshProbe = () => inBudget(async () => {
        const sampled = await client.probeScreen(serial);
        sampled.size = await client.screenSize(serial, { force: true });
        return sampled;
    });
    let latest = null;
    let result;
    try {
        const probe = await freshProbe();
        const baseline = screenContext(probe);
        if (!baseline) {
            stepRuntime.verified(false, { condition: { type: 'idle' }, error: 'IDLE_CONTEXT_UNPROVEN' });
            return textResult('未确认醒着的未锁定应用上下文；不唤醒。', { serial, actionVerified: false, idleMode: null, experimental: true });
        }
        const server = uiServerEnabled() ? uiServerFor(serial) : null;
        const ready = server?.isReady() === true;
        const remaining = () => Math.max(0, Math.min(deadlineMs - Date.now(), stepRuntime.remainingMs()));
        if (remaining() < 1) result = { matched: false, idleMode: null, error: 'IDLE_TIMEOUT' };
        else result = await waitForIdle({ runtime: stepRuntime, timeoutMs: remaining(),
            nativeIdle: ready ? async request => {
                await withDeviceRpc(serial, () => server.invoke('waitForIdle', [request.timeoutMs], {
                    signal: request.signal, timeoutMs: Math.max(1, Math.min(request.deadlineMs - Date.now(), remaining())),
                }));
            } : undefined,
            sample: request => inBudget(async () => {
                stepRuntime.check();
                const current = await freshProbe();
                if (screenContext(current) !== baseline) return { complete: false, context: screenContext(current) || 'invalid-context', digest: '' };
                const budget = Math.floor(Math.min(request.deadlineMs - Date.now(), remaining()));
                if (budget < 1) return { complete: false, context: baseline, digest: '' };
                let xml;
                if (ready) ({ xml } = await withDeviceRpc(serial, () => server.dump({ rootInActive: true, timeoutMs: budget, signal: request.signal })));
                else xml = await client.runText(['exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty'],
                    { serial, timeoutMs: budget, maxBuffer: 8 * 1024 * 1024 });
                stepRuntime.check();
                validateHierarchy(xml);
                const graph = parseUiGraph(xml, { limit: 500, screen: current.size, rpcTarget: true });
                const after = await freshProbe();
                if (screenContext(after) !== baseline) return { complete: false, context: screenContext(after) || 'invalid-context', digest: '' };
                latest = { serial, graph, size: current.size, focus: current.focus, limit: 500, at: Date.now() };
                return layoutEvidence(graph, current);
            }),
        });
    } catch (error) {
        stepRuntime.check();
        if (error.code !== 'ADB_TIMEOUT' || Date.now() < deadlineMs) throw error;
        result = { matched: false, idleMode: null, error: 'IDLE_TIMEOUT' };
    }
    stepRuntime.verified(result.matched, { condition: { type: 'idle' }, evidence: { idleMode: result.idleMode }, error: result.error || null });
    return textResult(result.matched ? '两次完整布局采样一致；不证明像素静止或业务完成。' : '等待预算内未证实布局稳定。', {
        serial, actionVerified: result.matched, idleMode: result.idleMode, experimental: true,
        ...(result.matched && latest ? { idleSample: latest } : {}),
    });
}

function validateWait(action, command, expected) {
    if (command !== 'wait') return;
    const idle = action.mode === 'idle';
    if ((!idle && !expected) || (action.mode !== undefined && !idle)
        || Object.keys(action).some(key => !['command', 'action', 'commandIdentifier', 'mode'].includes(key))) throw stepRuntime.failure('INVALID_ARGUMENT', 'Wait需要expect或mode=idle；不支持固定延时或其它动作参数。');
}

async function executeStep(args, executionContext) {
    if (args.steps !== undefined) return executeSequence(args, executionContext);
    const action = args.action;
    const command = commandOf(action);
    const after = parseAfterObserve(args.afterObserve);
    if (!STEP_ACTIONS.has(command)) throw stepRuntime.failure('INVALID_ARGUMENT', 'action 仅支持单个白名单动作，不能递归或切换设备。');
    stepRuntime.setActionCommand(command);
    const serial = resolveSerial(args);
    const requested = firstString(action.serial, action.device, action.deviceSerial);
    if (requested && requested !== serial) throw stepRuntime.failure('INVALID_ARGUMENT', 'action 不能覆盖单步绑定设备。');
    const expected = parseExpectation(args.expect);
    const experimentalM2 = markStepExperiment(action, expected);
    validateWait(action, command, expected);
    const waitMs = intOf(args.waitTimeoutMs, 'waitTimeoutMs', 5000);
    if (waitMs < 1 || waitMs > 30000) throw stepRuntime.failure('INVALID_ARGUMENT', 'waitTimeoutMs 必须在 1–30000ms 内。');
    return executeStepPlan({ action, command, expected, waitMs, experimentalM2 }, serial, after, executionContext);
}

function markStepExperiment(action, expected) {
    const m2Selector = value => value && (typeof value === 'object' || /^(contains|regex|class|role)=/.test(value));
    const experimentalM2 = action.mode === 'idle' || [action.selector, action.target?.selector, expected?.selector].some(m2Selector);
    if (experimentalM2) stepRuntime.inputReceipt({ experimental: true, milestone: 'M2' });
    return experimentalM2;
}

async function executeStepPlan({ action, command, expected, waitMs, experimentalM2 }, serial, after, executionContext) {
    const waitDeadline = command === 'wait' && action.mode === 'idle' ? Date.now() + waitMs : null;
    let result;
    try {
        if (command !== 'wait') {
            result = await ACTIONS[command]({ ...action, serial }, executionContext);
        } else if (action.mode === 'idle') {
            result = await stepRuntime.stage('verificationMs', () => waitIdle(serial, waitMs));
        } else {
            result = textResult('只读等待条件采样；不派发输入或唤醒。', { serial });
        }
    } catch (error) {
        if (command === 'inputtext' || command === 'fill') {
            const clean = stepRuntime.failure(error.code || 'INPUT_FAILED', '文本输入失败；已派发时不得直接重试。');
            clean.details = error.details;
            throw clean;
        }
        throw error;
    }
    if (experimentalM2) {
        result.details = { ...result.details, experimental: true, milestone: 'M2' };
        result.content.push({ type: 'text', text: JSON.stringify({ experimental: true, milestone: 'M2' }) });
    }
    let verifiedSample = result.details?.idleSample || null;
    if (result.details) delete result.details.idleSample;
    if (expected && result.details?.actionVerified !== false && !(command === 'fill' && (result.details.fillVerified === false || result.details.password))) {
        const verification = await stepRuntime.stage('verificationMs', () => waitForExpectation({
            runtime: stepRuntime, client: requireAdb(), captureGraph, serial, expected,
            deadlineMs: waitDeadline ?? Date.now() + waitMs,
        }));
        verifiedSample = verification.matched ? verification.sample || verifiedSample : null;
    }
    return appendObservation(result, after, serial, verifiedSample);
}

async function arbitrateSnapshot(args, executionContext = {}) {
    const serial = resolveSerial(args) || adb?.serial || '';
    const record = lastObserve.get(serial);
    if (!record || !args.snapshotId || record.snapshotId !== args.snapshotId) {
        throw stepRuntime.failure('STALE_SNAPSHOT', '仲裁必须绑定该设备当前 Observe 的 snapshotId。');
    }
    let candidates = args.candidates;
    if (typeof candidates === 'string') {
        try { candidates = JSON.parse(candidates); }
        catch { throw stepRuntime.failure('INVALID_ARGUMENT', 'candidates 必须为索引数组。'); }
    }
    let targetVisible = false;
    if (args.targetSelector !== undefined) {
        validateSelector(args.targetSelector);
        targetVisible = Boolean(resolveSelector(record.graph, args.targetSelector));
    }
    const arbitration = await arbitrate({ mode: args.mode, goal: args.goal, candidates, targetVisible }, {
        snapshotId: record.snapshotId, observedAt: record.at, serial,
        controls: record.graph.controls, focus: record.focus,
        keyguard: record.graph.keyguard, truncated: record.graph.truncated, stability: record.stability,
    }, {
        jev: runtime.jevService, signal: stepRuntime.executionSignal() || executionContext.signal,
        timeoutMs: intOf(args.requestTimeoutMs, 'requestTimeoutMs', 2000),
        isCurrent: () => lastObserve.get(serial) === record && stepRuntime.activeDevice() === serial,
    });
    const selectedIndex = candidates?.find(index => `c${index}` === arbitration.candidateId);
    arbitration.target = selectedIndex === undefined ? null : { serial, index: selectedIndex, snapshotId: record.snapshotId };
    return { content: [{ type: 'text', text: JSON.stringify(arbitration) }], details: { arbitration } };
}

function apiCapabilities() {
    return { content: [{ type: 'text', text: JSON.stringify(githubCapability) }], details: { capabilities: [githubCapability] } };
}

async function apiQuery(args, executionContext = {}) {
    if (args.capability !== githubCapability.name) throw stepRuntime.failure('UNSUPPORTED_CAPABILITY', '仅支持 github-public-issue；未执行 GUI 回退。');
    const result = await queryGitHub(parseObject(args.params, 'params'), {
        timeoutMs: intOf(args.requestTimeoutMs, 'requestTimeoutMs', 5000), signal: stepRuntime.executionSignal() || executionContext.signal,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { api: result } };
}

async function systemOperation(args, executionContext = {}) {
    const { command, timeoutMs, ...request } = args;
    if (typeof request.value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(request.value)) request.value = Number(request.value);
    if (typeof request.params === 'string') {
        if (request.params.length > 8192) throw stepRuntime.failure('INVALID_ARGUMENT', '草稿参数过大。');
        try { request.params = JSON.parse(request.params); }
        catch { throw stepRuntime.failure('INVALID_ARGUMENT', '草稿参数必须为有效JSON对象。'); }
    }
    const serial = request.serial;
    const system = await executeSystem(request, {
        signal: stepRuntime.executionSignal() || executionContext.signal,
        authorize: async (device, group) => {
            if (!runtime.systemAuthorization?.assertAllowed) throw stepRuntime.failure('SYSTEM_NOT_AUTHORIZED', '请先在 Android 系统授权设置中授权设备。');
            await runtime.systemAuthorization.assertAllowed(device, group);
            const user = (await requireAdb().runText(['shell', 'am', 'get-current-user'], { serial: device, maxBuffer: 1024 })).trim();
            if (user !== '0') throw stepRuntime.failure('UNSUPPORTED_USER', '系统适配当前只支持主用户0；多用户或无法确认用户时拒绝操作。');
        },
        run: tokens => requireAdb().enqueue(['shell', ...tokens.map(shellQuote)], { serial, maxBuffer: 32768 }),
        beforeDispatch: () => dispatchInput(serial, async () => {}),
    });
    system.androidUser = 0;
    if (system.outcome === 'verified') stepRuntime.verified(true, { capability: system.capability, after: system.after });
    if (system.outcome === 'unknown') stepRuntime.verified(false, { capability: system.capability, after: system.after });
    return { content: [{ type: 'text', text: JSON.stringify(system) }], details: { system } };
}

function systemCapabilities() {
    return { content: [{ type: 'text', text: JSON.stringify(systemCatalog) }], details: { capabilities: systemCatalog, support: 'declared-only', authorizationRequired: true } };
}

async function describe(args = {}) {
    switch (firstString(args.topic).toLowerCase() || 'overview') {
        case 'overview': return textResult(JSON.stringify(toolCatalog), { catalog: toolCatalog });
        case 'devices': return listDevices();
        case 'packages': return listPackages(args);
        case 'system': return systemCapabilities();
        case 'api': return apiCapabilities();
        default: throw stepRuntime.failure('INVALID_ARGUMENT', 'Describe topic 仅支持 overview、devices、packages、system、api。');
    }
}

async function manage(args, executionContext) {
    const operation = firstString(args.operation).toLowerCase();
    if (uncertainDevices.size && operation !== 'actionhistory' && operation !== 'displaystatus') throw stepRuntime.failure('DEVICE_STATE_UNCERTAIN', 'RPC结局未知，设备管理变更暂停；普通重连不能证明远端服务排干。');
    if (operation === 'actionhistory') {
        const allowed = new Set(['command', 'commandIdentifier', 'operation', 'serial', 'limit']);
        if (Object.keys(args).some(key => !allowed.has(key))) throw stepRuntime.failure('INVALID_ARGUMENT', '动作历史只接受 serial 和 limit。');
        const history = require('./lib/action-history').query({ serial: args.serial, limit: args.limit });
        return textResult('只读动作历史；不重放、不连接设备。', history);
    }
    const handlers = { connect: connectDevice, disconnect: disconnectDevice, startdisplay: startDisplay, stopdisplay: stopDisplay, displaystatus: displayStatus };
    const handler = Object.hasOwn(handlers, operation) ? handlers[operation] : null;
    if (operation === 'reconnect') {
        return stepRuntime.runManagement(async () => {
            const result = await reconnectDevice(requireAdb(), { serial: resolveSerial(args) });
            return textResult(result.message, result);
        });
    }
    if (!handler) throw stepRuntime.failure('INVALID_ARGUMENT', 'Manage operation 仅支持 connect、reconnect、disconnect、startDisplay、stopDisplay、displayStatus、actionHistory。');
    return stepRuntime.runManagement(() => handler(args, executionContext));
}

const COMMANDS = Object.freeze({ describe, observe, executestep: executeStep, manage });

async function processToolCall(args = {}, executionContext = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('[AndroidController] 无效的工具参数。');
    }

    const command = commandOf(args);
    if (!command) {
        throw new Error(
            '[AndroidController] 缺少 command。可用：Describe、Observe、ExecuteStep、Manage。',
        );
    }

    if (command === 'executestep' && args.steps === undefined) args = { ...args, action: parseObject(args.action, 'action') };
    const systemAction = command === 'executestep' && args.steps === undefined && commandOf(args.action) === 'system';
    if (systemAction && (typeof args.serial !== 'string' || !args.serial.trim())) throw stepRuntime.failure('INVALID_ARGUMENT', '系统能力必须显式指定 serial，不使用默认设备。');
    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!handler) {
        throw new Error(`[AndroidController] 不支持的 command：${args.command}`);
    }

    try {
        const deviceRead = command === 'describe' && firstString(args.topic).toLowerCase() === 'packages';
        const apiRead = command === 'observe' && firstString(args.mode).toLowerCase() === 'api';
        if ((command !== 'executestep' && command !== 'observe' && !deviceRead) || apiRead) return await handler(args, executionContext);
        const client = requireAdb();
        const serial = resolveSerial(args) || '__auto__';
        if (serial === '__auto__' && uncertainDevices.size) throw stepRuntime.failure('DEVICE_STATE_UNCERTAIN', '存在结局未知设备时禁止自动选设备。');
        assertDeviceCertain(serial);
        const timeoutMs = intOf(args.timeoutMs, 'timeoutMs', 60000);
        if (timeoutMs < 1 || timeoutMs > 300000) throw stepRuntime.failure('INVALID_ARGUMENT', 'timeoutMs 必须在 1–300000ms 内。');
        const outcome = command === 'executestep' ? 'dispatched' : 'observed';
        return await stepRuntime.run({ serial, timeoutMs, signal: executionContext.signal, client, outcome }, async () => {
            if (command === 'executestep' && typeof args.steps === 'string') {
                let steps;
                try { steps = JSON.parse(args.steps); } catch { throw stepRuntime.failure('INVALID_ARGUMENT', 'steps 必须是JSON数组。'); }
                args = { ...args, steps };
            }
            if (command === 'executestep' && serial !== '__auto__') {
                const steps = args.steps;
                const firstStep = steps === undefined ? args : parseObject(steps?.[0], 'step');
                const action = steps === undefined ? firstStep.action : parseObject(firstStep.action, 'action');
                if (Array.isArray(steps)) args = { ...args, steps: [{ ...firstStep, action }, ...steps.slice(1)] };
                const actionCommand = commandOf(action);
                const semantic = action.index !== undefined || action.selector !== undefined || firstString(action.id, action.resourceId, action.resource_id, action.text);
                if (firstString(action.frameId) && (actionCommand === 'swipe'
                    || (['tap', 'doubletap', 'longpress'].includes(actionCommand) && !semantic)
                    || (actionCommand === 'drag' && (!semantic || action.x2 !== undefined || action.y2 !== undefined)))) checkFrame(action, serial);
            }
            const active = await stepRuntime.stage('prepareMs', () => ensureActiveDevice(client, serial === '__auto__' ? '' : serial));
            stepRuntime.bindDevice(active.serial);
            assertDeviceCertain(active.serial);
            const pinned = { ...args, serial: active.serial };
            return handler(pinned, executionContext);
        });
    } catch (error) {
        if (error instanceof AdbError) {
            // 保留 code，方便上层按契约判断，同时把可读信息交给模型
            const offline = /device (offline|not found)|no devices\/emulators/i.test(error.message);
            const suffix = offline
                ? '\n无线调试在息屏 / 切网后会掉线，端口也会变：先 Describe topic=devices 看状态，再 Manage operation=reconnect 重连。'
                : '';
            const wrapped = new Error(`[AndroidController] ${error.message}${suffix}`);
            wrapped.code = error.code;
            wrapped.execution = error.execution;
            throw wrapped;
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// 设备管理接口（给显示屏页面用，人类点按钮，不敲命令行）
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// 已连地址缓存
//
// 无线调试的端口是随机的，每次都要重扫 2 万个端口（约 21 秒）。
// 记住上次连上的 host，下次端口变了也只扫这一台（约 7 秒）；
// 端口没变就是一条 adb connect（毫秒级）。
// ---------------------------------------------------------------------------

function cacheFilePath() {
    try {
        return path.join(runtime?.dataDir || path.join(process.cwd(), 'AppData'), 'android-controller-device.json');
    } catch {
        return null;
    }
}

function readDeviceCache() {
    const file = cacheFilePath();
    if (!file) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw.address !== 'string') return null;
        return raw;
    } catch {
        return null;
    }
}

function writeDeviceCache(address) {
    const file = cacheFilePath();
    if (!file || !address) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ address, at: Date.now() }), 'utf8');
    } catch { /* 缓存写失败不影响连接 */ }
}



/** 只把 device 状态视为已连接；mDNS 无候选时默认在预算内扫描 LAN，可显式禁用。 */
async function discoverDevices(client, body = {}) {
    const waitMs = clamp(intOf(body.waitMs, 'waitMs', 4000), 0, 15000);
    const scanDeadlineMs = Math.min(body.scanDeadlineMs ?? Infinity, body.deadlineMs ?? Date.now() + waitMs + 15000);
    const deadlineMs = Math.min(body.deadlineMs ?? Infinity, Date.now() + waitMs);
    const commandOptions = () => ({ timeoutMs: Math.max(1, Math.min(8000, deadlineMs - Date.now())), deadlineMs: Math.max(Date.now() + 1, deadlineMs) });
    const devices = await client.devices(commandOptions()).catch(() => []);
    const ready = devices.filter((device) => device.state === 'device');
    let services = [];
    let attempts = 0;
    do {
        services = await client.mdnsServices(commandOptions()).catch(() => []);
        attempts += 1;
        if (services.length || ready.length || Date.now() >= deadlineMs) break;
        await sleep(Math.min(800, deadlineMs - Date.now()));
    } while (Date.now() < deadlineMs);
    const connected = new Set(ready.map((device) => device.serial));
    const reachable = services.filter((service) => service.kind === 'connect')
        .map((service) => ({ ...service, source: 'mdns', connected: connected.has(service.address) }));
    for (const device of ready) {
        if (reachable.some((item) => item.address === device.serial)) continue;
        reachable.unshift({ kind: 'connect', address: device.serial, connected: true,
            source: 'connected', model: device.model || null });
    }
    let mode = services.length ? 'mdns' : ready.length ? 'connected' : 'mdns';
    if (!reachable.length && body.fallbackScan !== false) {
        mode = 'portscan';
        const scan = await scanLocalNetwork({ deadlineMs: scanDeadlineMs });
        for (const { host, port } of scan.hosts) {
            reachable.push({ kind: 'connect', host, port, address: `${host}:${port}`, connected: false, source: 'portscan' });
        }
    }
    const pairing = services.filter((service) => service.kind === 'pairing');
    return { ok: true, attempts, mode, pairing, connect: reachable,
        canPair: pairing.length > 0, canConnect: reachable.some((item) => !item.connected), mdns: services.length > 0 };
}

const deviceApi = {
    async discover(body = {}) {
        return discoverDevices(requireAdb(), body);
    },

    async adbStatus() {
        try {
            const version = await adb.version();
            return { ok: true, available: true, version, addresses: localAddresses() };
        } catch (error) {
            return {
                ok: true,
                available: false,
                error: error.message,
                addresses: localAddresses(),
            };
        }
    },

    async reconnect(body = {}) {
        return reconnectDevice(requireAdb(), { serial: firstString(body.serial, adb.serial) });
    },

    async listDevices() {
        let devices = [];
        let error = null;
        try {
            devices = await adb.devices();
        } catch (e) {
            error = e.message;
        }
        const ready = devices.filter((d) => d.state === 'device');
        return {
            ok: true,
            devices,
            ready: ready.length,
            // 前端据此决定要不要开始拉画面
            streaming: Boolean(frameHub?.status?.().streaming),
            error,
        };
    },

    async pair(body = {}) {
        stepRuntime.assertManagementIdle();
        const code = parsePairCode(body.code);

        // 优先使用 mDNS 发现的配对服务地址。这样用户只需要输入 6 位码，
        // 完全不用知道 IP 和那个每次都变的随机端口。
        let address = null;
        let autoDiscovered = false;

        if (!body.address) {
            const discovered = await adb.mdnsServices().catch(() => []);
            const pairing = discovered.find((s) => s.kind === 'pairing');
            if (!pairing) {
                return {
                    ok: false,
                    error: '没有自动发现配对中的手机。',
                    hint: '请在手机上打开「无线调试 → 使用配对码配对设备」，让配对框保持打开，然后重试；或手动填写地址。',
                    diagnosis: 'NO_PAIRING_SERVICE',
                };
            }
            address = pairing.address;
            autoDiscovered = true;
        } else {
            address = parseHostPort(body.address, null).address;
        }

        // adb pair 需要交互式输入配对码，用 stdin 喂进去；
        // noSelector 是因为 pair 属于全局命令，带 -s 会被 adb 拒绝
        const result = await adb.enqueue(['pair', address], {
            timeoutMs: 30000,
            noSelector: true,
            input: `${code}\n`,
        }).catch((error) => ({ stdout: '', stderr: error.message, code: 1 }));

        const output = `${result.stdout || ''}${result.stderr || ''}`;
        const success = /Successfully paired/i.test(output);

        if (!success) {
            // 配对端口每次都不一样。连不上时先探一下这个端口，
            // 能区分「端口填错」和「网络不通」——这是最容易搞混的两件事。
            if (/cannot connect|Connection refused|timeout|no route/i.test(output)) {
                const diagnosis = await diagnoseEndpoint(address);
                return {
                    ok: false,
                    error: diagnosis.kind === 'PORT_CLOSED'
                        ? `手机上 ${address} 没有在监听。配对端口每次都不一样，请重新点手机上的「使用配对码配对设备」抄最新的。`
                        : diagnosis.message,
                    hint: diagnosis.hint,
                    diagnosis: diagnosis.kind,
                    raw: output.trim(),
                };
            }
            if (/failed to authenticate/i.test(output)) {
                return {
                    ok: false,
                    error: '配对码不正确，或这个配对对话框已经过期。',
                    hint: '手机上关掉旧的配对框，重新点「使用配对码配对设备」，用新的 6 位码。',
                    diagnosis: 'PAIR_CODE_WRONG',
                    raw: output.trim(),
                };
            }
            return {
                ok: false,
                error: output.trim() || '配对失败',
                hint: '确认手机上的「无线调试」还开着。',
                raw: output.trim(),
            };
        }

        return { ok: true, address, autoDiscovered, message: '配对成功' };
    },

        async connect(body = {}) {
        return autoConnectDevice(requireAdb(), { address: firstString(body.address) || undefined });
    },

        async disconnect(body = {}) {
        stepRuntime.assertManagementIdle();
        const client = requireAdb();
        const address = firstString(body.address);
        await client.enqueue(address ? ['disconnect', address] : ['disconnect'], { timeoutMs: 10000, noSelector: true });
        if (!address || client.serial === address) await selectDevice(client, '');
        if (address) {
            lastObserve.delete(address);
            lastVision.delete(address);
            adbKeyboardCache.delete(address);
        } else {
            lastObserve.clear();
            lastVision.clear();
            adbKeyboardCache.clear();
        }
        return { ok: true, address: address || null, message: address ? `已断开 ${address}` : '已断开所有无线设备' };
    },
};

for (const name of ['pair', 'connect', 'disconnect', 'reconnect']) {
    const handler = deviceApi[name];
    deviceApi[name] = (...args) => {
        if (uncertainDevices.size) throw stepRuntime.failure('DEVICE_STATE_UNCERTAIN', 'RPC请求结局未知，设备管理暂停。');
        return stepRuntime.runManagement(() => handler(...args));
    };
}

async function initialize(options = {}) {
    runtime = {
        logger: options.logger || console,
        config: options.config || {},
        // 由 VCPDistributedServer 注入（VCPDistributedServer.js:161 的 services）
        // 用于把显示屏开进主界面的侧栏浏览器；独立运行插件时为 null，走降级路径。
        loomManager: options.services?.loomManager || options.loomManager || null,
        jevService: options.services?.jevService || null,
        systemAuthorization: options.services?.systemAuthorization || null,
    };

    const config = runtime.config;
    adb = new AdbClient({
        adbPath: config.ADB_PATH || process.env.ADB_PATH || 'adb',
        serial: config.DEVICE_SERIAL || '',
        logger: runtime.logger,
        timeoutMs: parseOptionalInt(config.ADB_TIMEOUT_MS),
    });

    frameHub = new FrameHub({
        adb,
        logger: runtime.logger,
        quality: parseOptionalInt(config.STREAM_QUALITY),
        intervalMs: parseOptionalInt(config.STREAM_INTERVAL_MS),
        maxWidth: parseOptionalInt(config.STREAM_MAX_WIDTH),
        format: config.STREAM_FORMAT || 'jpeg',
        // 'auto' 先试 raw，失败降级 PNG；'png' 强制老路径（排查兼容性用）
        captureMode: config.STREAM_CAPTURE_MODE || 'auto',
    });

    // scrcpy H.264 通道：帧率比 screencap 高一个数量级。
    // 设备地址要等连接后才知道，所以先建实例，start 时再补 serial。
    scrcpyHub = new ScrcpyHub({
        adbPath: adb.adbPath,
        serial: config.DEVICE_SERIAL || '',
        logger: runtime.logger,
        maxSize: parseOptionalInt(config.SCRCPY_MAX_SIZE),
        bitRate: parseOptionalInt(config.SCRCPY_BIT_RATE),
        maxFps: parseOptionalInt(config.SCRCPY_MAX_FPS),
    });

    streamServer = new StreamServer({
        frameHub,
        scrcpyHub,
        logger: runtime.logger,
        // 0 是合法值（随机端口），不能用 `|| undefined` 吞掉
        port: parseOptionalInt(config.DISPLAY_PORT),
        host: '127.0.0.1',
        deviceApi,
    });

    // 启动即尝试拉起显示屏；失败不阻塞插件注册（用户可能还没装 adb）
    try {
        await ensureDisplay();
    } catch (error) {
        runtime.logger.warn?.(`[AndroidController] 显示屏启动失败：${error.message}`);
    }

    runtime.logger.log?.(`[AndroidController] 已初始化，adb=${adb.adbPath}，显示屏=${streamServer.url() || '不可用'}`);
}

async function cleanup() {
    frameHub?.stop();
    await scrcpyHub?.stop().catch(() => {});
    await streamServer?.stop().catch(() => {});
    await shutdownUiServers();
    lastObserve.clear();
    lastVision.clear();
    adbKeyboardCache.clear();
}

function getRuntimeStatus() {
    return {
        adbPath: adb?.adbPath || null,
        serial: adb?.serial || null,
        displayUrl: streamServer?.url() || null,
        frame: frameHub?.status() || null,
        scrcpy: scrcpyHub?.status() || null,
        // 性能基线观测面：队列压力与显示链路丢帧计数。只读快照，不改变调度行为。
        adbQueue: adb?.queueStats?.() || null,
        display: streamServer?.metrics?.() || null,
    };
}

module.exports = {
    initialize,
    processToolCall,
    cleanup,
    getRuntimeStatus,
    // 导出内部函数便于单测
    _internals: {
        COMMANDS,
        KEY_ALIASES,
        clamp,
        commandOf,
        intOf,
        parseOptionalInt,
        parseHostPort,
        parsePairCode,
        localAddresses,
        scanSubnets,
        probePort,
        diagnoseEndpoint,
        scanLocalNetwork,
        autoConnectDevice,
        reconnectDevice,
        normalizeConnectAddress,

        waitForForeground,
        launchApp,


        resolveSerial,
        resolveTarget,
        shellQuote,
        textResult,
        lastObserve,
    },
};
