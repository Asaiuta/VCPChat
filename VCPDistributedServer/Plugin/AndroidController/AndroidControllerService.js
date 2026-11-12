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
    projectUiGraph,
    parseBounds,
    renderView,
    resolveSelector,
    samePage,
} = require('./lib/ui-graph');
const { validateSelector: isValidSelector } = require('./lib/selector');
const { waitForExpectation } = require('./lib/expectation-wait');
const { waitForIdle } = require('./lib/idle-wait');
const { samplingExpired } = require('./lib/sampling-deadline');
const { screenContext, layoutEvidence, m2IdleDiagnostic } = require('./lib/layout-evidence');


const { FrameHub } = require('./lib/frame-hub');
const vision = require('./lib/vision');
const { ScrcpyHub } = require('./lib/scrcpy-hub');
const { UiServer } = require('./lib/ui-server');
const { RemoteOwner } = require('./lib/ui-owner');
const { createUiSessions } = require('./lib/ui-sessions');
const { InputRecovery, bootIdentity } = require('./lib/input-recovery');
let inputRecovery = null;
const { StreamServer } = require('./lib/stream-server');
const { DisplayPreferences, resolvePreferencesFile } = require('./lib/display-preferences');
const { ControllerSettings } = require('./lib/controller-settings');
let controllerSettings = null;
const fs = require('node:fs');
const { parseHostPort, parsePairCode, localAddresses, probePort, diagnoseEndpoint, scanSubnets, scanLocalNetwork,
    readArpTable, primeArp, networkFingerprint } = require('./lib/device-network');
const { KnownDevices, createAutoConnector } = require('./lib/wireless-auto');
const { qrSvg } = require('./lib/qr-svg');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { URL } = require('node:url');
const stepRuntime = require('./lib/step-runtime');
const { arbitrate } = require('./lib/text-arbiter');
const { queryGitHub, capability: githubCapability } = require('./lib/github-query');
const { executeSystem, catalog: systemCatalog } = require('./lib/system-api');
const toolCatalog = require('./lib/tool-catalog');
const rpcMethods = require('./lib/rpc-methods');
const elementShot = require('./lib/element-shot').createElementShot({ runtime: stepRuntime, vision,
    prepareTarget, getRecord: serial => lastObserve.get(serial), captureGraph, resolveSelector, intOf, validateSelector, graphLayout,
    freshProbe: freshFrameProbe });
const { syncLoomAppUrl } = require('./lib/loom-display-url');
const contextEvidence = require('./lib/context');
const contextTracker = contextEvidence.createContextTracker();
const { createInteractionPolicy, classifyRisk } = require('./lib/interaction-policy');
const { createInteractionGuard } = require('./lib/interaction-guard');
const { createTaskPort } = require('./lib/task-port');
const { windowEvidence, emptyTreeState } = require('./lib/window-evidence');
const { createViewerTakeover } = require('./lib/viewer-takeover');
const { computeCodeIdentity, computePerformanceIdentity, computeCapabilityIdentity } = require('./lib/code-identity');
const os = require('node:os');
const humanInteraction = require('./lib/human-interaction').createHumanInteraction({
    getService: () => runtime.humanInteraction, runtime: stepRuntime,
});
const interactionPolicy = createInteractionPolicy({ getConfig: () => runtime.config.INTERACTION_POLICY ?? {} });
const interactionGuard = createInteractionGuard({ policy: interactionPolicy,
    probe: serial => freshFrameProbe(requireAdb(), serial), captureGraph,
    check: stepRuntime.check, fail: stepRuntime.failure, human: humanInteraction, requestId: stepRuntime.requestId,
    assertWrite: async (serial, probe, graph) => {
        await inputRecovery?.assertWritable(serial);
        return taskPort.assertWrite(serial, probe, graph);
    } });
const taskPort = createTaskPort({ runtime: stepRuntime, captureGraph, executePlan: executeStepPlan, bindSnapshot: storeSnapshot,
    handoff: async (task, options) => {
        if (!humanInteraction.available()) throw stepRuntime.failure('TASK_ASSISTANCE_UNAVAILABLE', '宿主未提供用户交互服务。');
        const resumed = await requestHandoff(task.serial, '当前任务需要协助。处理界面后可交还；继续会重新验证原任务约束。', options);
        return { resumed, epoch: contextTracker.epoch(task.serial) };
    },
    ensureCapabilities: async serial => {
        await guardRead(serial);
        if (!uiServerEnabled()) throw stepRuntime.failure('TASK_CAPABILITY_UNAVAILABLE', '搜索任务需要可读回的Fill RPC能力。');
        const ready = await startUiServer(serial, uiServerFor(serial));
        if (!ready.ok) throw stepRuntime.failure('TASK_CAPABILITY_UNAVAILABLE', '搜索任务设备RPC未就绪；不先派发GUI动作。');
    } });
const guardRead = (serial, probe) => {
    assertDeviceCertain(serial);
    return interactionGuard.read(serial, probe);
};
const policyFailure = error => /^(?:POLICY_|HUMAN_INTERACTION_|INPUT_RECOVERY_|DEVICE_STATE_UNCERTAIN|DEVICE_INPUT_STATE_UNCERTAIN)/.test(error?.code || '') || error?.needsConfirmation === true;

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
let viewerTakeover = null;
let knownDevices = null;
let autoConnector = null;
let qrPairing = null;
const rememberedSerials = new Set();
// 用户手动断开后不再后台重连，直到显式连接或配对。
let autoConnectPaused = false;
let serviceStopped = false;
let initializePromise = null;
let cleanupPromise = null;
const serviceCalls = new Set();

function admitServiceCall(task) {
    if (serviceStopped) return Promise.reject(stepRuntime.failure('SERVICE_STOPPED', '安卓服务已停止或正在停止。'));
    const operation = Promise.resolve().then(() => {
        if (serviceStopped) throw stepRuntime.failure('SERVICE_STOPPED', '安卓服务已停止或正在停止。');
        return task();
    });
    serviceCalls.add(operation);
    operation.finally(() => serviceCalls.delete(operation)).catch(() => {});
    return operation;
}

// 每台设备的最近一次 Observe 结果，供 index 寻址使用
const lastObserve = new Map();
const lastVision = new Map();
const uiSessions = createUiSessions({
    createServer: serial => new UiServer({ adbPath: adb?.adbPath || 'adb', serial, logger: runtime.logger }),
    identityFor: serial => RemoteOwner.identityFor(serial),
    invalidate: serial => { contextTracker.invalidate(serial); lastObserve.delete(serial); lastVision.delete(serial); },
    failure: stepRuntime.failure,
    inputRecovery: () => inputRecovery,
});
const { quarantine: quarantineDevice, record: recordOwnerState, assertCertain: assertDeviceCertain,
    start: startUiServer, call: withDeviceRpc, get: uiServerFor } = uiSessions;
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
            if (client === adb) {
                writeDeviceCache(target);
                await rememberDevice(client, target, deadlineMs);
            }
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

function autoConnectEnabled() {
    const raw = String(runtime.config?.AUTO_CONNECT ?? 'true').trim().toLowerCase();
    return !['false', 'off', '0', 'no'].includes(raw);
}

function knownDevicesFile() {
    try {
        return path.join(runtime?.dataDir || path.join(process.cwd(), 'AppData'), 'android-controller-known-devices.json');
    } catch {
        return null;
    }
}

const IPV4_ADDRESS_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/;

/** 记住已授权的无线设备：序列号作身份，IP:端口作快速路径，MAC 用于换 IP 后重新定位。 */
async function rememberDevice(client, serial, deadlineMs = Date.now() + 4000) {
    if (!knownDevices || !serial) return null;
    const left = () => Math.max(1, Math.min(3000, deadlineMs - Date.now()));
    let host = null;
    let port = null;
    const direct = IPV4_ADDRESS_RE.exec(serial);
    if (direct) {
        host = direct[1];
        port = Number(direct[2]);
    } else if (/^adb-/.test(serial)) {
        const services = await client.mdnsServices({ timeoutMs: left(), deadlineMs }).catch(() => []);
        const service = services.find((item) => item.kind === 'connect' && serial.startsWith(`${item.name}.`));
        if (service) ({ host, port } = service);
    } else {
        return null;
    }
    const id = String(await client.runText(['shell', 'getprop', 'ro.serialno'], { serial, timeoutMs: left(), deadlineMs })
        .catch(() => '')).trim();
    const mac = host ? (await readArpTable({ timeoutMs: left() })).find((entry) => entry.ip === host)?.mac : undefined;
    rememberedSerials.add(serial);
    return knownDevices.upsert({ id: /^[\w.-]{1,64}$/.test(id) ? id : undefined, host, port, mac });
}

function isKnownSerial(serial, known) {
    const direct = IPV4_ADDRESS_RE.exec(serial);
    return known.some((item) => (item.id && serial.startsWith(`adb-${item.id}-`))
        || (direct && item.host === direct[1]));
}

async function runBackgroundManagement(task) {
    if (uiSessions.hasUncertain()) return { ok: false, busy: true, code: 'DEVICE_STATE_UNCERTAIN' };
    try {
        return await stepRuntime.runManagement(task);
    } catch (error) {
        if (error?.code === 'DEVICE_BUSY' || error?.code === 'TAKEOVER_ACTIVE') return { ok: false, busy: true, code: error.code };
        throw error;
    }
}

/**
 * 后台自动连接一轮。发现阶段（adb devices / mDNS / ARP / 端口探测）都是宿主侧只读查询，
 * 不占设备管理锁；只有真正 connect / 切换选中设备时才进入管理互斥，避免长时间阻塞 AI 操作。
 */
async function backgroundReconnect(client, ctx = {}) {
    if (autoConnectPaused) return { ok: false, code: 'PAUSED', message: '已手动断开，自动连接暂停；点「连接设备」恢复。' };
    const deadlineMs = Date.now() + (ctx.budgetMs ?? 12000);
    const left = (cap) => Math.max(1, Math.min(cap, deadlineMs - Date.now()));
    const devices = await client.devices({ timeoutMs: left(5000), deadlineMs }).catch(() => null);
    if (!devices) return { ok: false, code: 'ADB_UNAVAILABLE', message: 'adb 不可用。' };
    const ready = devices.filter((device) => device.state === 'device');
    const known = knownDevices?.list() || [];

    if (client.serial && ready.some((device) => device.serial === client.serial)) {
        if (client === adb && !rememberedSerials.has(client.serial)
            && (IPV4_ADDRESS_RE.test(client.serial) || /^adb-/.test(client.serial))) {
            await rememberDevice(client, client.serial, deadlineMs).catch(() => null);
        }
        return { ok: true, action: 'already-connected', serial: client.serial };
    }
    const selectedGone = !client.serial || !devices.some((device) => device.serial === client.serial);
    const pick = selectedGone && (ready.find((device) => isKnownSerial(device.serial, known))
        || (!client.serial ? ready[0] : null));
    if (pick) {
        const selected = await runBackgroundManagement(async () => {
            await selectDevice(client, pick.serial);
            return { ok: true, action: 'selected', serial: pick.serial, message: `已选用 ${pick.model || pick.serial}` };
        });
        return selected;
    }
    if (devices.some((device) => device.state === 'unauthorized')) {
        return { ok: false, code: 'UNAUTHORIZED', message: '手机等待「允许调试」授权。' };
    }

    const candidates = [];
    const seen = new Set();
    const add = (address, source) => {
        if (!address || seen.has(address) || ready.some((device) => device.serial === address)) return;
        seen.add(address);
        candidates.push({ address, source });
    };
    const services = await client.mdnsServices({ timeoutMs: left(4000), deadlineMs }).catch(() => []);
    for (const service of services) if (service.kind === 'connect') add(service.address, 'mdns');

    const legacy = client === adb ? readDeviceCache()?.address : null;
    const targets = known.filter((item) => item.host || item.mac);
    if (!targets.length && legacy && IPV4_ADDRESS_RE.test(legacy)) {
        const [, host, port] = IPV4_ADDRESS_RE.exec(legacy);
        targets.push({ host, port: Number(port) });
    }
    let arp = targets.some((item) => item.mac) ? await readArpTable({ timeoutMs: left(3000) }) : [];
    const hostOf = (item) => (item.mac && arp.find((entry) => entry.mac === item.mac)?.ip) || item.host;
    const probes = targets.filter((item) => item.port && hostOf(item)).map(async (item) => {
        const host = hostOf(item);
        const probe = await probePort(host, item.port, Math.min(800, left(800)));
        if (probe.kind === 'OPEN') add(`${host}:${item.port}`, 'known');
    });
    await Promise.all(probes);

    let deepScanned = false;
    if (!candidates.length && ctx.deepScan && targets.length && deadlineMs - Date.now() > 2000) {
        if (ctx.networkChanged) {
            await primeArp(scanSubnets(), { waitMs: Math.min(1200, left(1200)) });
            arp = await readArpTable({ timeoutMs: left(3000) });
        }
        const hosts = [...new Set(targets.map(hostOf).filter(Boolean))];
        const scan = await scanLocalNetwork({ hosts, deadlineMs: Math.min(deadlineMs - 1500, Date.now() + 9000) });
        deepScanned = true;
        for (const { host, port } of scan.hosts) add(`${host}:${port}`, 'portscan');
    }
    if (!candidates.length) {
        return { ok: false, code: 'NOT_FOUND', deepScanned,
            message: known.length || legacy ? '已配对手机不在线：确认无线调试已打开且与电脑同一网络。' : '尚无已配对的手机。' };
    }

    let last = null;
    for (const candidate of candidates.sort((a, b) => rankSource(b.source) - rankSource(a.source))) {
        if (deadlineMs - Date.now() < 1500) break;
        try {
            last = await runBackgroundManagement(() => autoConnectDevice(client, { address: candidate.address, deadlineMs }));
            if (last?.ok || last?.busy) return { ...last, deepScanned, source: candidate.source };
        } catch (error) {
            last = { ok: false, code: error.code || 'CONNECT_FAILED', message: error.message };
            if (error.code === 'UNAUTHORIZED' || error.code === 'CONNECT_TIMEOUT') break;
        }
    }
    return { ...(last || { ok: false, code: 'CONNECT_FAILED' }), deepScanned };
}

const QR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const QR_PAIRING_TTL_MS = 180000;

function randomToken(length) {
    return [...randomBytes(length)].map((byte) => QR_ALPHABET[byte % QR_ALPHABET.length]).join('');
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

function uiServerEnabled() {
    const raw = String(runtime.config?.UI_SERVER ?? process.env.ANDROID_UI_SERVER ?? 'true')
        .trim().toLowerCase();
    return raw !== 'false' && raw !== '0' && raw !== 'off';
}

/**
 * 通过常驻服务取控件树；仅明确未派发或已排干的失败允许调用方回退 CLI。
 * 未知传输结局隔离设备；取消和总截止继续抛出，不得启动新的采集。
 */
async function dumpViaUiServer(serial) {
    if (!uiServerEnabled()) return null;
    const server = uiServerFor(serial);
    try {
        const started = await startUiServer(serial, server);
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
        if (uiSessions.isUncertain(serial)) throw error;
        runtime.logger?.warn?.(`[AndroidController] UI 服务采集失败，回退 CLI：${error.message}`);
        // 服务已不可用，下一轮重新拉起，别带着坏状态反复超时。
        const owner = await server.stop().catch(() => null);
        recordOwnerState(serial, owner || server.ownerIdentity);
        assertDeviceCertain(serial);
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
    taskPort.beforeCapture(serial);
    assertDeviceCertain(serial);
    const client = requireAdb();
    const before = options.probe || await freshFrameProbe(client, serial, options);
    await guardRead(serial, before);
    const context = frameContext(before);
    const epoch = contextTracker.epoch(serial);
    if (!context && options.allowUnproven !== true) {
        throw Object.assign(stepRuntime.failure('CONTEXT_UNPROVEN', '未确认display 0、前台窗口、旋转、尺寸与明确未锁定状态。'),
            { contextDiff: contextEvidence.unprovenReasons(before).map(reason => `before_${reason}`) });
    }
    let xml;
    if (options.deadlineMs !== undefined) {
        const budget = Math.floor(Math.min(options.deadlineMs - Date.now(), stepRuntime.remainingMs()));
        if (budget < 1) throw stepRuntime.failure('VERIFICATION_TIMEOUT', '等待采样预算耗尽。');
        const server = uiServerEnabled() ? uiServerFor(serial) : null;
        if (server?.isReady() === true) ({ xml } = await withDeviceRpc(serial, () => server.dump({ rootInActive: true, timeoutMs: budget, signal: stepRuntime.executionSignal() })));
        else xml = await client.runText(['exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty'],
            { serial, timeoutMs: budget, maxBuffer: 8 * 1024 * 1024 });
    } else ({ xml } = await dumpUi(serial));
    validateHierarchy(xml);
    stepRuntime.check();
    const graph = parseUiGraph(xml, { ...options, rpcTarget: true, screen: context?.size || options.screen || before?.size });
    interactionGuard.readGraph(graph);
    const after = await freshFrameProbe(client, serial, options);
    await guardRead(serial, after);
    const epochChanged = contextTracker.epoch(serial) !== epoch;
    const coherent = sameFrameContext(context, frameContext(after)) && !epochChanged
        && contextEvidence.graphMatchesContext(graph, context);
    if (!coherent) {
        lastObserve.delete(serial);
        lastVision.delete(serial);
        if (options.allowUnproven !== true) {
            throw Object.assign(stepRuntime.failure('UI_CONTEXT_CHANGED', '布局采样期间前台、窗口、旋转或屏幕上下文变化/不明，请重新观察。'),
                { contextDiff: contextEvidence.describeContextChange({ before, after, epochChanged, graph }) });
        }
    }
    Object.defineProperty(graph, 'contextEvidence', { value: coherent ? { context, epoch, probe: after } : null });
    return graph;
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
    const evidence = graph.contextEvidence;
    const record = { snapshotId: randomUUID(), graph, at: Date.now(), size: evidence?.context.size || size,
        focus: evidence?.probe.focus || focus, limit, context: evidence?.context || null,
        contextEpoch: evidence?.epoch ?? null, actionable: Boolean(evidence && evidence.epoch === contextTracker.epoch(serial)) };
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
    const checkSnapshot = () => {
        if (!record) throw stepRuntime.failure('STALE_SNAPSHOT', '尚未在该设备上执行 Observe，快照不可用。');
        if (!firstString(args.snapshotId)) throw stepRuntime.failure('SNAPSHOT_REQUIRED', 'index 必须携带 Observe 返回的 snapshotId。');
        if (lastObserve.get(serial) !== record || record.snapshotId !== args.snapshotId || Date.now() - record.at > STALE_SNAPSHOT_MS
            || record.actionable === false || !record.context || record.contextEpoch !== contextTracker.epoch(serial)) {
            throw stepRuntime.failure('STALE_SNAPSHOT', '快照上下文不匹配、无法确认或已过期，请重新 Observe。');
        }
    };
    if (index !== null) checkSnapshot();
    let size;
    if (semantic) {
        const before = await freshFrameProbe(client, serial);
        if (index !== null) checkSnapshot();
        const context = frameContext(before);
        if (!context) throw stepRuntime.failure('CONTEXT_UNPROVEN', '未确认当前主屏前台与未锁定状态，不执行语义动作。');
        size = context.size;
        const graph = await captureGraph(serial, { limit: index !== null ? record.limit || DEFAULT_LIMIT : 500, screen: size,
            probe: before, rpcTarget: args.rpcTarget === true,
            ...(args.safeRead === true ? { deadlineMs: Date.now() + stepRuntime.remainingMs() } : {}) });
        if (index !== null) {
            checkSnapshot();
            if (!sameFrameContext(record.context, graph.contextEvidence?.context)
                || !samePage(record.graph, graph) || graphLayout(record.graph) !== graphLayout(graph)) {
                lastObserve.delete(serial);
                throw stepRuntime.failure('STALE_SNAPSHOT', '页面内容、布局或前台上下文已变化，请重新 Observe 获取快照。');
            }
            if (args.rpcTarget === true) record.graph = graph;
        } else storeSnapshot(serial, graph, size);
    } else size = await requireFrame(args, serial);
    const target = resolveTarget(pinned, label);
    if (!size || target.x < 0 || target.y < 0 || target.x >= size.width || target.y >= size.height) throw stepRuntime.failure('INVALID_COORDINATES', '坐标超出当前屏幕或屏幕尺寸未知。');
    interactionGuard.target(target.node, { context: semantic ? lastObserve.get(serial)?.context : lastVision.get(serial)?.context,
        epoch: contextTracker.epoch(serial) });
    stepRuntime.check();
    return target;
}

function logicalSize(size) {
    return size && Number.isSafeInteger(size.width) && size.width > 0
        && Number.isSafeInteger(size.height) && size.height > 0 ? { width: size.width, height: size.height } : null;
}

function frameContext(probe) {
    return contextEvidence.frameContext(probe);
}

function sameFrameContext(a, b) {
    return contextEvidence.sameContext(a, b);
}


async function freshFrameProbe(client, serial, options = {}) {
    stepRuntime.check();
    const timeoutMs = Math.floor(Math.min(stepRuntime.remainingMs(), options.deadlineMs === undefined ? Infinity : options.deadlineMs - Date.now(), 10000));
    if (timeoutMs < 1) throw stepRuntime.failure('VERIFICATION_TIMEOUT', '新鲜上下文采样预算耗尽。');
    let probe = null, failure = null;
    try {
        probe = await client.probeScreen(serial, { fresh: true, signal: stepRuntime.executionSignal(), timeoutMs });
        stepRuntime.check();
    } catch (error) { stepRuntime.check(); failure = error; }
    const state = contextTracker.observe(serial, probe);
    if (state.changed || !state.context) {
        lastObserve.delete(serial);
        lastVision.delete(serial);
    }
    if (failure && options.propagateErrors === true) throw failure;
    return probe;
}

function checkFrame(args, serial) {
    if (!firstString(args.frameId)) throw stepRuntime.failure('FRAME_REQUIRED', '像素坐标动作必须携带 Screenshot 或 Observe screenshot 返回的 frameId。');
    const frame = lastVision.get(serial);
    if (!frame || frame.frameId !== args.frameId || Date.now() - frame.at > STALE_SNAPSHOT_MS
        || !frame.context || frame.contextEpoch !== contextTracker.epoch(serial)) {
        lastVision.delete(serial);
        throw stepRuntime.failure('STALE_FRAME', '截图 frameId 或上下文epoch无效/过期，请重新截图。');
    }
    return frame;
}

async function requireFrame(args, serial, sampledProbe) {
    const entries = Array.isArray(args) ? args : [args];
    const frames = entries.map(entry => checkFrame(entry, serial));
    const probe = sampledProbe || await freshFrameProbe(requireAdb(), serial);
    const context = frameContext(probe);
    if (frames.some(frame => !sameFrameContext(frame.context, context) || frame.contextEpoch !== contextTracker.epoch(serial))) {
        lastVision.delete(serial);
        throw stepRuntime.failure('STALE_FRAME', '截图上下文已变化或无法确认，请重新截图。');
    }
    entries.forEach(entry => checkFrame(entry, serial));
    interactionGuard.binding({ context, epoch: contextTracker.epoch(serial) });
    stepRuntime.check();
    return context.size;
}

async function prepareTargets(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 2) throw stepRuntime.failure('INVALID_ARGUMENT', '触摸目标数量无效。');
    const client = requireAdb();
    const semantic = args => args.index !== undefined || args.selector !== undefined || firstString(args.id, args.resourceId, args.resource_id, args.text);
    const pixels = entries.filter(({ args }) => !semantic(args)).map(({ args }) => args);
    const hasSemantic = pixels.length < entries.length;
    pixels.forEach(args => checkFrame(args, resolveSerial(args)));
    const { serial } = await ensureActiveDevice(client, resolveSerial(entries[0].args));
    if (entries.some(({ args }) => resolveSerial(args) !== serial)) throw stepRuntime.failure('INVALID_ARGUMENT', '触摸目标不能跨设备。');
    const record = lastObserve.get(serial);
    const indexed = entries.some(({ args }) => args.index !== undefined);
    const checkSnapshots = () => {
        for (const { args } of entries) {
            if (args.index === undefined) continue;
            requireInt(args.index, 'index');
            if (!record || lastObserve.get(serial) !== record || record.snapshotId !== args.snapshotId
                || Date.now() - record.at > STALE_SNAPSHOT_MS || record.actionable === false
                || !record.context || record.contextEpoch !== contextTracker.epoch(serial)) {
                throw stepRuntime.failure('STALE_SNAPSHOT', '触摸目标快照已过期或前台上下文不匹配。');
            }
        }
    };
    checkSnapshots();
    const before = await freshFrameProbe(client, serial);
    let size = pixels.length ? await requireFrame(pixels, serial, before) : frameContext(before)?.size;
    checkSnapshots();
    if (!size) throw stepRuntime.failure('CONTEXT_UNPROVEN', '未确认当前主屏前台与未锁定状态，不执行触摸动作。');
    if (hasSemantic) {
        let graph;
        try { graph = await captureGraph(serial, { limit: indexed ? record.limit || DEFAULT_LIMIT : 500, screen: size, rpcTarget: true, probe: before }); }
        catch (error) {
            if (pixels.length && ['CONTEXT_UNPROVEN', 'UI_CONTEXT_CHANGED'].includes(error.code)) throw stepRuntime.failure('STALE_FRAME', '语义树与截图上下文不一致，请重新观察。');
            throw error;
        }
        if (pixels.length) size = await requireFrame(pixels, serial, graph.contextEvidence?.probe);
        checkSnapshots();
        if (indexed && (!sameFrameContext(record.context, graph.contextEvidence?.context)
            || !samePage(record.graph, graph) || graphLayout(record.graph) !== graphLayout(graph))) {
            lastObserve.delete(serial);
            throw stepRuntime.failure('STALE_SNAPSHOT', '页面或布局已变化，请重新 Observe。');
        }
        if (indexed) record.graph = graph;
        else storeSnapshot(serial, graph, size);
        interactionGuard.binding({ context: graph.contextEvidence.context, epoch: graph.contextEvidence.epoch });
    }
    const targets = entries.map(({ args, label }) => {
        const target = resolveTarget({ ...args, serial }, label);
        if (target.x < 0 || target.y < 0 || target.x >= size.width || target.y >= size.height) throw stepRuntime.failure('INVALID_COORDINATES', '触摸坐标超出屏幕。');
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
    if (mark) await interactionGuard.write(serial);
    else await interactionGuard.preflight(serial);
    lastObserve.delete(serial);
    lastVision.delete(serial);
    if (mark) stepRuntime.markDispatched();
    return stepRuntime.stage('actionMs', task);
}

async function sampleWindowDiagnostics(serial) {
    const before = await guardRead(serial);
    const server = uiSessions.peek(serial);
    if (!server?.isReady()) return { source: 'unavailable', actionable: false, reason: 'RPC_NOT_READY', occlusion: 'unknown' };
    const { xml } = await withDeviceRpc(serial, () => server.dump({ rootInActive: false,
        timeoutMs: Math.min(4000, stepRuntime.remainingMs()), signal: stepRuntime.executionSignal() }));
    const evidence = windowEvidence(xml, before, pkg => interactionPolicy.assertAllowed({ operation: 'read', package: pkg }));
    const after = await guardRead(serial);
    if (!sameFrameContext(frameContext(before), frameContext(after))) return { source: evidence.source,
        actionable: false, state: 'CONTEXT_CHANGED', rootCount: null, roots: [], occlusion: 'unknown' };
    return evidence;
}

async function attachStaleScreen(error, serial) {
    error.details = { ...error.details, screen: null, screenReason: 'UNAVAILABLE' };
    if (uiSessions.isUncertain(serial)) { error.details.screenReason = 'DEVICE_STATE_UNCERTAIN'; return; }
    try {
        stepRuntime.check();
        if (stepRuntime.remainingMs() < 1000) { error.details.screenReason = 'BUDGET_EXHAUSTED'; return; }
        await guardRead(serial);
        const observed = await observe({ serial, wake: 'never', stable: false });
        error.details.screen = { content: observed.content, ...observed.details };
        error.details.screenReason = 'OBSERVED';
    } catch (screenError) {
        error.details.screenReason = screenError.code || 'UI_ACQUISITION_FAILED';
    }
}

function presentationOptions(args) {
    const textLength = args.textLength ?? 120;
    if (!Number.isSafeInteger(textLength) || textLength < 16 || textLength > 4096) throw stepRuntime.failure('INVALID_ARGUMENT', 'textLength必须为16–4096的安全整数。');
    for (const key of ['detail', 'includeCoordinates', 'includeShortId']) {
        if (args[key] !== undefined && typeof args[key] !== 'boolean') throw stepRuntime.failure('INVALID_ARGUMENT', `${key}必须为布尔值。`);
    }
    return { textLength, detail: args.detail === true,
        ...(args.includeCoordinates === undefined ? {} : { includeCoordinates: args.includeCoordinates }),
        ...(args.includeShortId === undefined ? {} : { includeShortId: args.includeShortId }) };
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
    presentationOptions(args);
    if (args.windows !== undefined && typeof args.windows !== 'boolean') throw stepRuntime.failure('INVALID_ARGUMENT', 'windows必须为布尔值。');
    if (args.wake !== undefined && !['never', 'ifAllowed'].includes(args.wake)) throw stepRuntime.failure('INVALID_ARGUMENT', 'wake 仅支持 never、ifAllowed。');
    const client = requireAdb();
    const serial = resolveSerial(args);
    const limit = intOf(args.limit, 'limit', DEFAULT_LIMIT) ?? DEFAULT_LIMIT;
    const wantStable = args.stable === true || String(args.stable).toLowerCase() === 'true';
    const { serial: active, switchNote } = await ensureActiveDevice(client, serial);
    let probe = await freshFrameProbe(client, active);
    await guardRead(active, probe);
    let wokeNote = '';
    const asleep = probe?.wakefulness === 'Asleep' || probe?.wakefulness === 'Dozing';
    if (asleep && args.wake !== 'never' && autoWakeEnabled()) {
        await interactionGuard.run('wake', {}, () => dispatchInput(active,
            () => client.runText(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { serial: active, timeoutMs: 10000 })));
        const woke = await awaitWake(active, { timeoutMs: wakeTimeoutOf(args) });
        probe = await freshFrameProbe(client, active);
        await guardRead(active, probe);
        wokeNote = woke.ready ? '（原处于息屏，已自动点亮）'
            : `（原处于息屏，已派发点亮但 ${wakeTimeoutOf(args)}ms 内未确认唤醒，界面可能是锁屏）`;
    }
    let graph = await captureGraph(active, { limit, screen: probe?.size, probe, allowUnproven: true });
    let settled = null;
    let stability = wantStable ? 'unknown' : 'not-sampled';
    if (wantStable) {
        const firstEvidence = graph.contextEvidence ? layoutEvidence(graph, graph.contextEvidence.probe) : null;
        await stepRuntime.pause(200);
        const again = await captureGraph(active, { limit, allowUnproven: true }).catch(error => {
            stepRuntime.check();
            if (uiSessions.isUncertain(active) || !['UI_ACQUISITION_FAILED', 'UI_IDLE_TIMEOUT', 'VERIFICATION_TIMEOUT'].includes(error.code)) throw error;
            return null;
        });
        if (again) {
            const secondEvidence = again.contextEvidence ? layoutEvidence(again, again.contextEvidence.probe) : null;
            if (firstEvidence?.complete && secondEvidence?.complete) {
                settled = firstEvidence.context === secondEvidence.context && firstEvidence.digest === secondEvidence.digest
                    && graph.contextEvidence.epoch === again.contextEvidence.epoch;
                stability = settled ? 'stable' : 'changing';
            }
            graph = again;
        }
    }
    const sample = graph.contextEvidence;
    return renderObservation(args, { serial: active, graph, size: sample?.context.size || probe?.size || null,
        focus: sample?.probe.focus || probe?.focus || null, limit, settled, stability, switchNote, wokeNote });
}

async function renderObservation(args, sample) {
    const { serial, graph, size, focus, limit, at = Date.now(), settled = null, stability = 'not-sampled', switchNote = '', wokeNote = '' } = sample;
    await guardRead(serial);
    interactionGuard.readGraph(graph);
    if (args.windows !== undefined && typeof args.windows !== 'boolean') throw stepRuntime.failure('INVALID_ARGUMENT', 'windows必须为布尔值。');
    const windows = args.windows === true ? await sampleWindowDiagnostics(serial) : null;
    const treeState = emptyTreeState(graph.contextEvidence?.probe, graph.stats?.rawNodes || graph.controls.length);
    const previous = lastObserve.get(serial);
    const changed = previous ? !samePage(previous.graph, graph) : null;
    const contextStale = graph.contextEvidence && graph.contextEvidence.epoch !== contextTracker.epoch(serial);
    const record = storeSnapshot(serial, graph, size, focus, limit);
    record.at = at;
    record.stability = contextStale ? 'unknown' : stability;
    if (contextStale || stability === 'changing' || stability === 'unknown') {
        record.actionable = false;
        lastVision.delete(serial);
    }
    const viewLimit = intOf(args.limit, 'limit', DEFAULT_LIMIT);
    const view = projectUiGraph(graph, { limit: viewLimit, ...presentationOptions(args) });
    const riskControls = view.controls.map((control, index) => ({ ...control, risk: classifyRisk(graph.controls[index]) }));
    const carrier = uiSessions.peek(serial)?.carrierIdentity || null;
    const code = await computeCodeIdentity({ rootDir: __dirname });
    stepRuntime.check();
    const performanceIdentity = computePerformanceIdentity({ node: process.version,
        os: { platform: os.platform(), arch: os.arch(), release: os.release() },
        config: { uiServer: uiServerEnabled(), viewLimit, ...presentationOptions(args) },
        workload: { operation: 'observe', stable: args.stable === true || args.stable === 'true', limit: viewLimit } });
    const capability = computeCapabilityIdentity({ codeDigest: code.digest, carrier,
        sessionGeneration: carrier?.generation ?? null,
        deviceEvidence: graph.contextEvidence ? graph.contextEvidence.context : null });
    const identity = { code: { digest: code.digest, complete: code.complete, issues: code.issues },
        performance: performanceIdentity, capability, reusable: code.complete && capability.complete, authorization: false };
    const header = [
        switchNote.trim(),
        `设备：${serial}`,
        carrier ? `RPC载体文件：${carrier.status}（仅启动文件证据，不证明远端进程身份）` : null,
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
            if (policyFailure(error)) throw error;
            shotNote = `\n\n[截图失败] ${error.code || 'IMAGE_ACQUISITION_FAILED'}`;
        }
    }
    const body = view.controls.length ? renderView(view) : '(控件树为空；可用 mode=image 查看像素界面。)';
    const content = [{ type: 'text', text: `${header}\n\n${body}${shotNote}` }];
    if (shot) content.push({ type: 'image_url', image_url: { url: shot.frame.dataUrl } });
    return {
        content,
        details: {
            serial, carrier, identity, focus, screen: shot?.size || size, signature: graph.signature,
            snapshotId: record.snapshotId, observedAt: record.at, actionable: record.actionable,
            changed, settled: contextStale ? null : settled, stability: record.stability,
            controls: riskControls, total: graph.total, truncated: view.truncated,
            keyguard: graph.keyguard, canvas: graph.canvas, stats: graph.stats, treeState, windows,
            context: graph.contextEvidence ? { ...graph.contextEvidence.context, epoch: graph.contextEvidence.epoch } : null,
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
    if (isWrite && options.dispatchDeadline === undefined) await interactionGuard.preflight(serial);
    else if (!isWrite) await guardRead(serial);
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
        const ready = await startUiServer(serial, server);
        if (ready.carrier) attempt.carrier = ready.carrier;
        stepRuntime.check();
        if (!ready.ok) {
            throw Object.assign(new Error(), { code: ready.code || 'UI_SERVER_NOT_READY', dispatched: false });
        }
        // Resolve once per proven owner, before the final fresh target fence.
        // The second click of DoubleTap must not add an ADB round trip.
        const inputIdentity = isWrite && rpcMethods.entry(method)?.touch === true
            ? await inputRecovery.identityFor(server.ownerIdentity?.binding || server, serial) : null;
        if (options.beforeDispatch) {
            await options.beforeDispatch();
            stepRuntime.check();
        }
        if (isWrite) await interactionGuard.write(serial, { continuation: options.dispatchDeadline !== undefined });
        else await guardRead(serial);
        const request = {
            signal: stepRuntime.executionSignal(),
            timeoutMs: rpcActionTimeoutMs(method, params, options.durationMs),
        };
        // 从首击 invoke 前的单调时刻计窗；ACK 和第二击就绪等待都占用窗口。
        const value = await withDeviceRpc(serial, () => {
            // Persistence is pre-dispatch work and must consume the original
            // budget/window. Recheck after it, immediately before writing RPC.
            try { stepRuntime.check(); }
            catch (error) { throw Object.assign(error, { dispatched: false, drained: true }); }
            const dispatchAt = performance.now();
            if (options.dispatchDeadline !== undefined && dispatchAt > options.dispatchDeadline) {
                throw Object.assign(new Error(), { code: 'DOUBLE_TAP_WINDOW_MISSED', dispatched: false, drained: true });
            }
            if (options.dispatchTiming) options.dispatchTiming.startedAt = dispatchAt;
            attempt.status = 'invoking';
            invoking = true;
            if (isWrite) stepRuntime.markDispatched();
            return server.invoke(method, params, request);
        }, {
            inputIdentity,
        });
        rpcCompleted = true;
        if (isWrite) stepRuntime.markDispatched();
        attempt.status = 'dispatched';
        if (value === false) {
            throw Object.assign(new Error(), { code: 'UI_SERVER_ACTION_REJECTED', dispatched: true, drained: true });
        }
        stepRuntime.check();
        return value;
    } catch (error) {
        if (policyFailure(error)) throw error;
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
                if (error.dispatched || policyFailure(error)) throw error;
            }
        }
        stepRuntime.check();
        await interactionGuard.write(serial);
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
                        if (policyFailure(error)) throw error;
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
        if (policyFailure(error)) throw error;
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
    freshProbe: serial => freshFrameProbe(requireAdb(), serial),
    uiServerEnabled, uiServerFor, getGraph: serial => lastObserve.get(serial)?.graph,
    textResult, channelReceipt,
});

const collect = require('./lib/collect').createCollector({ runtime: stepRuntime, prepareTarget,
    getGraph: serial => lastObserve.get(serial)?.graph, scroll, textResult });

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

    if (args.frameId !== undefined) await requireFrame(args, serial);
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
    const server = uiSessions.peek(String(serial || ''));
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
                    await rpcAction(serial, 'pasteClipboard', [], attempts, RPC_OPERATION.WRITE);
                }
                stepRuntime.check();
                if (enter) await client.runText(['shell', 'input', 'keyevent', 'KEYCODE_ENTER'], { serial, timeoutMs: 10000 });
            }, false);
            return channelReceipt(textResult(
                '已派发当前光标/选区的 Unicode 粘贴；不证明字段值。',
                { serial, method: strategy === 'keyevent' ? 'rpc-clipboard+keyevent-paste' : 'rpc-clipboard', ascii: false },
            ), attempts, { clipboard, pasteStrategy: strategy });
        } catch (error) {

            if (policyFailure(error)) throw error;
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
        if (policyFailure(error)) throw error;
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
    await guardRead(serial, before);
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
    await guardRead(serial, after);
    stepRuntime.check();
    const afterContext = frameContext(after);
    const reason = !context || !afterContext ? 'CONTEXT_UNKNOWN'
        : !sameFrameContext(context, afterContext) ? 'CONTEXT_CHANGED'
            : frameResult.sourceWidth !== size.width || frameResult.sourceHeight !== size.height ? 'SOURCE_SIZE_MISMATCH' : 'READY';
    const actionable = reason === 'READY';
    const record = lastObserve.get(serial) || null;
    const frameId = actionable ? randomUUID() : null;
    if (actionable) lastVision.set(serial, { frameId, at: Date.now(), context, contextEpoch: contextTracker.epoch(serial) });
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

async function requestHandoff(serial, reason, options) {
    if (!humanInteraction.available()) throw stepRuntime.failure('HUMAN_INTERACTION_UNAVAILABLE', '宿主没有注入可信用户交互服务。');
    const invalidate = () => { contextTracker.invalidate(serial); lastObserve.delete(serial); lastVision.delete(serial); };
    invalidate();
    try { return await humanInteraction.request('handoff', `设备：${serial}\n${reason}`, options); }
    finally { invalidate(); }
}

async function handoff(args) {
    if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 500
        || Object.keys(args).some(key => !['command', 'serial', 'reason'].includes(key))) {
        throw stepRuntime.failure('INVALID_ARGUMENT', 'Handoff 只接受 reason（1–500字符）与绑定设备。');
    }
    const serial = args.serial;
    if (!humanInteraction.available()) throw stepRuntime.failure('HUMAN_INTERACTION_UNAVAILABLE', '宿主没有注入可信用户交互服务。');
    let resumed = false;
    stepRuntime.verified(false, { condition: { type: 'humanResume' }, evidence: { resumed: false, deviceEffectVerified: false } });
    resumed = await requestHandoff(serial, args.reason);
    stepRuntime.verified(resumed, { condition: { type: 'humanResume' }, evidence: { resumed, deviceEffectVerified: false } });
    return textResult(resumed ? '用户选择继续；旧凭据已失效，请根据当前界面继续。' : '用户选择停止；未恢复或重放任何动作。',
        { serial, handoff: resumed ? 'resumed' : 'stopped', actionVerified: resumed });
}

const ACTIONS = Object.freeze({
    tap, doubletap: doubleTap, swipe, scroll, scrolluntil: scrollUntil, fill, longpress: longPress, inputtext: inputText,
    drag, pinch, imeaction: imeAction, erasetext: eraseText, keycombo: keyCombo,
    keyevent: keyEvent, launchapp: launchApp, killapp: killApp, system: systemOperation, handoff, collect,
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
    } catch (error) {
        stepRuntime.check();
        const code = policyFailure(error) ? error.code : after.mode === 'image' ? 'IMAGE_ACQUISITION_FAILED' : 'UI_ACQUISITION_FAILED';
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

async function waitIdle(serial, timeoutMs, executionContext) {
    const client = requireAdb();
    const deadlineMs = Date.now() + Math.min(timeoutMs, stepRuntime.remainingMs());
    const inBudget = task => typeof client.withContext === 'function' ? client.withContext({ deadlineMs }, task) : task();
    const freshProbe = () => inBudget(async () => {
        const sampled = await freshFrameProbe(client, serial, { deadlineMs, propagateErrors: true });
        await guardRead(serial, sampled);
        return sampled;
    });
    let latest = null;
    let result;
    try {
        const probe = await freshProbe();
        const baseline = screenContext(probe);
        const baselineEpoch = contextTracker.epoch(serial);
        if (!baseline) {
            stepRuntime.verified(false, { condition: { type: 'idle' }, error: 'IDLE_CONTEXT_UNPROVEN' });
            return textResult('未确认醒着的未锁定应用上下文；不唤醒。', { serial, actionVerified: false, idleMode: null, experimental: true });
        }
        // Only in-process callers can supply this synchronous collector; tool args never enable diagnostics.
        const fixture = 'com.vcpchat.m15fixture';
        const onSample = probe.focus.package === fixture
            && [`${fixture}/.MainActivity`, `${fixture}/${fixture}.MainActivity`].includes(probe.focus.component)
            && typeof executionContext?.onM2IdleSample === 'function' ? executionContext.onM2IdleSample : null;
        let sampleIndex = 0;
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
                const index = ++sampleIndex;
                const startedAtMs = onSample ? performance.now() : null;
                let dumpStartedAtMs = null, dumpCompletedAtMs = null;
                let phase = 'sample-error', diagnostic = null;
                try {
                    stepRuntime.check();
                    const current = await freshProbe();
                    if (screenContext(current) !== baseline || contextTracker.epoch(serial) !== baselineEpoch) {
                        phase = 'context-before';

                        return { complete: false, context: screenContext(current) || 'invalid-context', digest: '' };
                    }
                    const budget = Math.floor(Math.min(request.deadlineMs - Date.now(), remaining()));
                    if (budget < 1) { phase = 'budget-exhausted'; return { complete: false, context: baseline, digest: '' }; }
                    let xml;
                    if (onSample) dumpStartedAtMs = performance.now();
                    if (ready) ({ xml } = await withDeviceRpc(serial, () => server.dump({ rootInActive: true, timeoutMs: budget, signal: request.signal })));
                    else xml = await client.runText(['exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty'],
                        { serial, timeoutMs: budget, maxBuffer: 8 * 1024 * 1024 });
                    if (onSample) dumpCompletedAtMs = performance.now();
                    stepRuntime.check();
                    validateHierarchy(xml);
                    const graph = parseUiGraph(xml, { limit: 500, screen: current.size, rpcTarget: true });
                    interactionGuard.readGraph(graph);
                    const after = await freshProbe();
                    if (screenContext(after) !== baseline || contextTracker.epoch(serial) !== baselineEpoch) {
                        phase = 'context-after';
                        return { complete: false, context: screenContext(after) || 'invalid-context', digest: '' };
                    }
                    Object.defineProperty(graph, 'contextEvidence', { value: { context: frameContext(after), epoch: baselineEpoch, probe: after } });
                    latest = { serial, graph, size: current.size, focus: current.focus, limit: 500, at: Date.now() };
                    const evidence = layoutEvidence(graph, current);
                    if (onSample) {
                        try { diagnostic = m2IdleDiagnostic(graph, current, evidence); }
                        catch { /* Optional evidence collection must not alter layout verification. */ }
                    }
                    phase = evidence.complete ? 'complete' : 'incomplete';
                    return evidence;
                } finally {
                    // Bounded synchronous memory collection only: no extra device reads and no awaited hook work.
                    if (onSample && index <= 160) {
                        try {
                            const pending = onSample({ sampleIndex: index, clock: 'host-performance.now-ms',
                                startedAtMs, dumpStartedAtMs, dumpCompletedAtMs, completedAtMs: performance.now(),
                                phase, requestDeadlineUnixMs: request.deadlineMs,
                                completedWithinRequestDeadline: Date.now() < request.deadlineMs,
                                diagnosticAvailable: diagnostic !== null, ...diagnostic });
                            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
                        } catch { /* Diagnostics cannot change the production outcome. */ }
                    }
                }
            }),
        });
    } catch (error) {
        stepRuntime.check();
        if (!samplingExpired(error, deadlineMs)) throw error;
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

async function executeStepPlan({ action, command, expected, waitMs, experimentalM2, verificationDeadlineMs }, serial, after, executionContext) {
    return interactionGuard.run(command, action, async () => {
    const waitDeadline = command === 'wait' && action.mode === 'idle' ? Date.now() + waitMs : null;
    let result;
    try {
        if (command !== 'wait') {
            result = await ACTIONS[command]({ ...action, serial }, executionContext);
        } else if (action.mode === 'idle') {
            result = await stepRuntime.stage('verificationMs', () => waitIdle(serial, waitMs, executionContext));
        } else {
            result = textResult('只读等待条件采样；不派发输入或唤醒。', { serial });
        }
    } catch (error) {
        if (/^(?:STALE_|SNAPSHOT_REQUIRED|ELEMENT_(?:TARGET|CONTEXT)_CHANGED)/.test(error.code || '')) await attachStaleScreen(error, serial);
        if (policyFailure(error)) throw error;
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
            deadlineMs: Math.min(waitDeadline ?? Date.now() + waitMs, verificationDeadlineMs ?? Infinity),
        }));
        verifiedSample = verification.matched ? verification.sample || verifiedSample : null;
    }
    return appendObservation(result, after, serial, verifiedSample);
    });
}

async function arbitrateSnapshot(args, executionContext = {}) {
    const serial = resolveSerial(args) || adb?.serial || '';
    await guardRead(serial);
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
    await guardRead(serial);
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
            await guardRead(device);
            const user = (await requireAdb().runText(['shell', 'am', 'get-current-user'], { serial: device, maxBuffer: 1024 })).trim();
            if (user !== '0') throw stepRuntime.failure('UNSUPPORTED_USER', '系统适配当前只支持主用户0；多用户或无法确认用户时拒绝操作。');
        },
        run: async tokens => {
            const write = (tokens[0] === 'am' && tokens[1] === 'start') || (tokens[0] === 'settings' && tokens.includes('put'));
            if (!write) await guardRead(serial);
            return requireAdb().enqueue(['shell', ...tokens.map(shellQuote)], { serial, maxBuffer: 32768 });
        },
        beforeDispatch: async tokens => {
            const componentIndex = tokens?.indexOf('-n') ?? -1;
            if (componentIndex >= 0) interactionPolicy.assertAllowed({ operation: 'write',
                package: String(tokens[componentIndex + 1]).split('/')[0], action: 'system', capability: request.capability });
            await dispatchInput(serial, async () => {});
        },
    });
    await guardRead(serial);
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

async function recoverOwner(args) {
    const serial = firstString(args.serial);
    if (!serial || Object.keys(args).some(key => !['command', 'commandIdentifier', 'operation', 'serial'].includes(key))) {
        throw stepRuntime.failure('INVALID_ARGUMENT', 'recoverOwner必须显式serial且不接受force/approval。');
    }
    return stepRuntime.runManagement(async () => {
        const owner = await uiSessions.recover(serial);
        return textResult('已核验旧RPC退出及所需输入恢复证据；隔离解除，未重放任何动作。', { serial, owner, recovered: true });
    });
}

async function manage(args, executionContext) {
    const operation = firstString(args.operation).toLowerCase();
    if (operation === 'recoverowner') return recoverOwner(args);
    if (uiSessions.hasUncertain() && operation !== 'actionhistory' && operation !== 'displaystatus') throw stepRuntime.failure('DEVICE_STATE_UNCERTAIN', 'RPC结局未知，设备管理变更暂停；普通重连不能证明远端服务排干。');
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
    if (!handler) throw stepRuntime.failure('INVALID_ARGUMENT', 'Manage operation 仅支持 connect、reconnect、disconnect、startDisplay、stopDisplay、displayStatus、actionHistory、recoverOwner。');
    return stepRuntime.runManagement(() => handler(args, executionContext));
}

async function runTask(args, executionContext) {
    if (Object.keys(args).some(key => !['command', 'task'].includes(key))) throw stepRuntime.failure('TASK_INVALID', 'RunTask只接受task契约。');
    const executor = runtime.taskExecutor;
    if (!executor) throw stepRuntime.failure('TASK_HOST_UNAVAILABLE', '宿主未注入任务执行器。');
    const task = executor.prepare(parseObject(args.task, 'task'));
    const client = requireAdb();
    assertDeviceCertain(task.serial);
    try {
        return await stepRuntime.run({ serial: task.serial, timeoutMs: task.budget.timeoutMs,
            signal: executionContext.signal, client, outcome: 'failed' }, async () => {
            await ensureActiveDevice(client, task.serial);
            stepRuntime.bindDevice(task.serial);
            assertDeviceCertain(task.serial);
            const receipt = await taskPort.run(task, () => executor.run(task, taskPort, executionContext));
            if (receipt.status === 'completed' || stepRuntime.dispatchState().dispatched) {
                stepRuntime.verified(receipt.status === 'completed', { condition: { type: 'taskCompletion', taskId: task.taskId },
                    evidence: { status: receipt.status, code: receipt.code } });
            }
            return textResult(JSON.stringify({ task: receipt }), { task: receipt });
        });
    } catch (error) {
        // Cancellation may return before an in-flight child drains. Expose only its trace identity.
        if (error.execution) error.execution.taskId = task.taskId;
        throw error;
    }
}

const COMMANDS = Object.freeze({ describe, observe, executestep: executeStep, runtask: runTask, manage });

async function processToolCall(args = {}, executionContext = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('[AndroidController] 无效的工具参数。');
    }

    const command = commandOf(args);
    if (!command) {
        throw new Error(
            '[AndroidController] 缺少 command。可用：Describe、Observe、ExecuteStep、RunTask、Manage。',
        );
    }

    if (command === 'executestep' && args.steps === undefined) args = { ...args, action: parseObject(args.action, 'action') };
    if (command === 'executestep' && typeof args.steps === 'string') {
        let steps;
        try { steps = JSON.parse(args.steps); } catch { throw stepRuntime.failure('INVALID_ARGUMENT', 'steps 必须是JSON数组。'); }
        args = { ...args, steps };
    }
    if (command === 'executestep' && Array.isArray(args.steps)) {
        if (args.steps.length < 1 || args.steps.length > 8) throw stepRuntime.failure('INVALID_ARGUMENT', 'steps需要1–8步。');
        args = { ...args, steps: args.steps.map(raw => {
            const step = parseObject(raw, 'step');
            return { ...step, action: parseObject(step.action, 'action') };
        }) };
    }
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
        if (serial === '__auto__' && uiSessions.hasUncertain()) throw stepRuntime.failure('DEVICE_STATE_UNCERTAIN', '存在结局未知设备时禁止自动选设备。');
        assertDeviceCertain(serial);
        const isHandoff = command === 'executestep' && (commandOf(args.action || {}) === 'handoff'
            || (Array.isArray(args.steps) && args.steps.some(step => commandOf(step.action) === 'handoff')));
        const timeoutMs = intOf(args.timeoutMs, 'timeoutMs', isHandoff ? 600000 : 60000);
        if (timeoutMs < 1 || timeoutMs > (isHandoff ? 600000 : 300000)) throw stepRuntime.failure('INVALID_ARGUMENT', 'timeoutMs 超出执行预算（Handoff最多600000ms，其他调用最多300000ms）。');
        const outcome = command === 'executestep' ? 'dispatched' : 'observed';
        return await stepRuntime.run({ serial, timeoutMs, signal: executionContext.signal, client, outcome }, async () => {
            try {
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
                return await handler({ ...args, serial: active.serial }, executionContext);
            } catch (error) {
                if (/^(?:STALE_|SNAPSHOT_REQUIRED|ELEMENT_(?:TARGET|CONTEXT)_CHANGED)/.test(error.code || '')
                    && error.details?.screenReason === undefined) await attachStaleScreen(error, stepRuntime.activeDevice() || serial);
                throw error;
            }
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
        const devices = await adb.devices();
        const ready = devices.filter((d) => d.state === 'device');
        return {
            ok: true,
            devices,
            ready: ready.length,
            // 前端据此决定要不要开始拉画面
            streaming: Boolean(frameHub?.status?.().streaming),
            autoConnect: autoConnector?.status() || { enabled: false, state: 'disabled' },
        };
    },

    /** 后台调度器专用：一轮自动连接，不经 HTTP 暴露。 */
    async autoReconnect(ctx = {}) {
        return backgroundReconnect(requireAdb(), ctx);
    },

    /**
     * 二维码配对（与 Android Studio 相同协议）：手机「使用二维码配对设备」扫码后，
     * 会以二维码里指定的实例名发布 _adb-tls-pairing 服务，主机据此找到它并用二维码里的密码配对。
     */
    async pairQrStart() {
        const name = `studio-${randomToken(10)}`;
        const password = randomToken(12);
        const payload = `WIFI:T:ADB;S:${name};P:${password};;`;
        qrPairing = { name, password, expiresAt: Date.now() + QR_PAIRING_TTL_MS };
        return { ok: true, name, expiresAt: qrPairing.expiresAt, svg: qrSvg(payload) };
    },

    async pairQrPoll(body = {}) {
        const session = qrPairing;
        if (!session || (body.name && body.name !== session.name)) {
            return { ok: false, state: 'stale', error: '二维码已失效，请重新生成。' };
        }
        if (Date.now() > session.expiresAt) {
            qrPairing = null;
            return { ok: false, state: 'expired', error: '二维码已过期，请重新生成。' };
        }
        const services = await adb.mdnsServices({ timeoutMs: 4000 }).catch(() => []);
        const service = services.find((item) => item.kind === 'pairing' && item.name === session.name);
        if (!service) return { ok: true, state: 'waiting' };
        if (uiSessions.hasUncertain()) throw stepRuntime.failure('DEVICE_STATE_UNCERTAIN', 'RPC请求结局未知，设备管理暂停。');
        const result = await stepRuntime.runManagement(() => adb.enqueue(['pair', service.address], {
            timeoutMs: 30000, noSelector: true, input: `${session.password}\n`,
        })).catch((error) => {
            if (error?.code === 'DEVICE_BUSY') throw error;
            return { stdout: '', stderr: error.message };
        });
        const output = `${result.stdout || ''}${result.stderr || ''}`;
        if (!/Successfully paired/i.test(output)) {
            return { ok: false, state: 'failed', error: output.trim() || '配对失败', hint: '在手机上重新扫码；仍失败时改用配对码。' };
        }
        if (qrPairing === session) qrPairing = null;
        autoConnectPaused = false;
        autoConnector?.trigger(1500);
        return { ok: true, state: 'paired', address: service.address, message: '配对成功' };
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

        autoConnectPaused = false;
        return { ok: true, address, autoDiscovered, message: '配对成功' };
    },

        async connect(body = {}) {
        autoConnectPaused = false;
        return autoConnectDevice(requireAdb(), { address: firstString(body.address) || undefined });
    },

        async disconnect(body = {}) {
        stepRuntime.assertManagementIdle();
        const client = requireAdb();
        const address = firstString(body.address);
        autoConnectPaused = true;
        if (address) await uiSessions.stop(address);
        else await uiSessions.stopAll({ strict: true });
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
        if (uiSessions.hasUncertain()) throw stepRuntime.failure('DEVICE_STATE_UNCERTAIN', 'RPC请求结局未知，设备管理暂停。');
        return stepRuntime.runManagement(() => handler(...args));
    };
}

for (const name of Object.keys(deviceApi)) {
    const handler = deviceApi[name];
    deviceApi[name] = (...args) => admitServiceCall(() => handler(...args));
}

function initialize(options = {}) {
    if (initializePromise) return initializePromise;
    const stopping = cleanupPromise;
    serviceStopped = true;
    initializePromise = (async () => {
        await stopping;
        await initializeService(options);
        if (!cleanupPromise) serviceStopped = false;
    })().finally(() => { initializePromise = null; });
    return initializePromise;
}

async function initializeService(options = {}) {
    contextTracker.clear();
    lastObserve.clear();
    lastVision.clear();
    runtime = {
        logger: options.logger || console,
        config: options.config || {},
        // 由 VCPDistributedServer 注入（VCPDistributedServer.js:161 的 services）
        // 用于把显示屏开进主界面的侧栏浏览器；独立运行插件时为 null，走降级路径。
        loomManager: options.services?.loomManager || options.loomManager || null,
        jevService: options.services?.jevService || null,
        systemAuthorization: options.services?.systemAuthorization || null,
        humanInteraction: options.services?.humanInteraction || null,
        taskExecutor: options.services?.androidTaskExecutor || null,
    };

    const config = runtime.config;
    controllerSettings = new ControllerSettings({ file: options.controllerConfigFile || path.join(__dirname, 'config.env'), effective: config });
    adb = new AdbClient({
        adbPath: config.ADB_PATH || process.env.ADB_PATH || 'adb',
        serial: config.DEVICE_SERIAL || '',
        logger: runtime.logger,
        timeoutMs: parseOptionalInt(config.ADB_TIMEOUT_MS),
    });
    inputRecovery = new InputRecovery(path.join(path.dirname(resolvePreferencesFile(options)), 'android-input-recovery'),
        async serial => bootIdentity(await adb.runText(['shell', 'cat /proc/sys/kernel/random/boot_id && settings get secure android_id'],
            { serial, timeoutMs: 4000 })));

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
        control: true,
        adbPath: adb.adbPath,
        serial: config.DEVICE_SERIAL || '',
        logger: runtime.logger,
        maxSize: parseOptionalInt(config.SCRCPY_MAX_SIZE),
        bitRate: parseOptionalInt(config.SCRCPY_BIT_RATE),
        maxFps: parseOptionalInt(config.SCRCPY_MAX_FPS),
    });

    const displayPreferences = options.displayPreferences || new DisplayPreferences({
        file: resolvePreferencesFile({ ...options, loomManager: runtime.loomManager }),
        defaults: { maxSize: scrcpyHub.maxSize ?? 540, bitRate: scrcpyHub.bitRate ?? 2000000,
            maxFps: scrcpyHub.maxFps ?? 30, fitWidth: false },
        logger: runtime.logger,
    });
    const { fitWidth: _fitWidth, ...savedDisplayConfig } = await displayPreferences.load();
    scrcpyHub.configure(savedDisplayConfig);

    viewerTakeover = createViewerTakeover({ runtime: stepRuntime,
        selectedSerial: () => adb?.serial || null,
        authorize: typeof runtime.humanInteraction?.request === 'function'
            ? serial => humanInteraction.request('takeover', `设备：${serial}\n仅默认屏。允许本连接在实时画面上触摸、拖动及返回/主页/最近任务，最长10分钟。\n原AI任务将停止，不会自动恢复；禁止访问/只读应用策略仍然有效，逐次确认不适用于人工实时输入。`) : null,
        control: () => (scrcpyHub?.serial === adb?.serial ? scrcpyHub : null),
        // Human live input: package deny/read-only rules apply; per-write confirmation is
        // satisfied by the session approval because the human is the actor.
        checkPolicy: async serial => {
            const probe = await requireAdb().probeScreen(serial);
            const pkg = probe?.focus?.package || '';
            const decision = interactionPolicy.decide({ operation: 'write', package: pkg });
            if (!decision.allowed && !decision.needsConfirmation) {
                throw Object.assign(new Error('前台应用受包策略限制。'), { code: decision.code });
            }
            return pkg;
        },
        invalidate: serial => { contextTracker.invalidate(serial); lastObserve.delete(serial); lastVision.delete(serial); },
        assertCertain: assertDeviceCertain, quarantine: quarantineDevice,
    });
    streamServer = new StreamServer({
        frameHub,
        scrcpyHub,
        displayPreferences,
        logger: runtime.logger,
        // 0 是合法值（随机端口），不能用 `|| undefined` 吞掉
        port: parseOptionalInt(config.DISPLAY_PORT),
        host: '127.0.0.1',
        deviceApi,
        takeoverApi: viewerTakeover,
    });

    // 启动即尝试拉起显示屏；失败不阻塞插件注册（用户可能还没装 adb）
    try {
        await ensureDisplay();
    } catch (error) {
        runtime.logger.warn?.(`[AndroidController] 显示屏启动失败：${error.message}`);
    }

    await autoConnector?.stop();
    autoConnector = null;
    knownDevices = new KnownDevices({ file: knownDevicesFile(), fs });
    rememberedSerials.clear();
    autoConnectPaused = false;
    qrPairing = null;
    if (autoConnectEnabled()) {
        autoConnector = createAutoConnector({
            logger: runtime.logger,
            fingerprint: networkFingerprint,
            attempt: (ctx) => deviceApi.autoReconnect(ctx),
        });
        autoConnector.start();
    }

    runtime.logger.log?.(`[AndroidController] 已初始化，adb=${adb.adbPath}，显示屏=${streamServer.url() || '不可用'}`);
}

function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    serviceStopped = true;
    const initializing = initializePromise;
    cleanupPromise = (async () => {
        await initializing?.catch(() => {});
        const connector = autoConnector;
        autoConnector = null;
        qrPairing = null;
        await connector?.stop();
        const draining = stepRuntime.cancelAndDrain();
        await viewerTakeover?.stop();
        await draining;
        await Promise.allSettled([...serviceCalls]);
        await controllerSettings?.flush();
        await streamServer?.stop().catch(() => {});
        await frameHub?.stop();
        await scrcpyHub?.stop().catch(() => {});
        await uiSessions.stopAll();
        lastObserve.clear();
        lastVision.clear();
        adbKeyboardCache.clear();
        contextTracker.clear();
    })().finally(() => { cleanupPromise = null; });
    return cleanupPromise;
}

async function ensureDisplayUrl() {
    if (!streamServer) throw new Error('安卓显示服务尚未初始化。');
    const server = await ensureDisplay();
    return server.url();
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
        // 结局未知而被隔离的 adb 选择器；按选择器记录，不代表物理设备身份。
        quarantinedDevices: uiSessions.uncertainSerials(),
        display: streamServer?.metrics?.() || null,
        takeover: viewerTakeover?.status() || null,
        autoConnect: autoConnector?.status() || null,
    };
}

module.exports = {
    initialize,
    processToolCall: (...args) => admitServiceCall(() => processToolCall(...args)),
    cleanup,
    getRuntimeStatus,
    ensureDisplayUrl: () => admitServiceCall(ensureDisplayUrl),
    readControllerSettings: () => controllerSettings.read(),
    saveControllerSettings: (request, options) => controllerSettings.save(request, options),
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
        backgroundReconnect,
        rememberDevice,
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
