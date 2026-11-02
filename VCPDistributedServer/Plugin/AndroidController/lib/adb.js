'use strict';

/**
 * adb 子进程封装。
 *
 * 设计约束：
 * 1) 全部参数走数组传入（execFile），绝不拼 shell 字符串 —— 模型给的文本可能就是
 *    `; rm -rf /`，走 shell 等于把执行权交出去。
 * 2) 每次调用都有超时与输出上限，超时后杀进程树（Windows 上直接 kill 只杀 cmd 包装层）。
 * 3) 二进制（screencap）走 stdout Buffer，文本走 utf8 并容忍 BOM / CRLF。
 */

const { execFile } = require('child_process');
const { AsyncLocalStorage } = require('node:async_hooks');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_QUEUE_SIZE = 64;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

class AdbError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'AdbError';
        this.code = code;
        Object.assign(this, details);
    }
}

function normalizeAdbPath(value) {
    const configured = String(value ?? '').trim();
    return configured || 'adb';
}

/**
 * 串行化对同一设备的 adb 调用。
 *
 * 为什么不并发：uiautomator dump 与 screencap 同时打一台手机时，adb 的 EXEC 服务
 * 会互相挤占，实测表现为随机 "error: closed" 或空输出。队列化比重试便宜。
 */
class SerialQueue {
    constructor(maxQueueSize = DEFAULT_MAX_QUEUE_SIZE) {
        this.maxQueueSize = Number.isSafeInteger(maxQueueSize) && maxQueueSize > 0
            ? maxQueueSize : DEFAULT_MAX_QUEUE_SIZE;
        this.tail = Promise.resolve();
        this.depth = 0;
        this.pending = [];
        this.running = false;
    }

    push(task, deadlineMs, signal) {
        if (signal?.aborted) return Promise.reject(new AdbError('ADB_ABORTED', 'adb 调用已取消。'));
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
            return Promise.reject(new AdbError('ADB_TIMEOUT', 'adb 调用在队列中已超时。'));
        }
        if (this.depth >= this.maxQueueSize) {
            return Promise.reject(new AdbError('ADB_QUEUE_FULL', 'adb 调用队列已满。'));
        }
        if (this.depth === 0) this.tail = new Promise((resolve) => { this.resolveIdle = resolve; });
        this.depth += 1;
        return new Promise((resolve, reject) => {
            const entry = { task, resolve, reject, deadlineMs, signal };
            const cancel = (error) => {
                const index = this.pending.indexOf(entry);
                if (index < 0) return;
                this.pending.splice(index, 1);
                this.finish(entry, error);
            };
            entry.onAbort = () => cancel(new AdbError('ADB_ABORTED', 'adb 调用已取消。'));
            this.pending.push(entry);
            signal?.addEventListener('abort', entry.onAbort, { once: true });
            if (deadlineMs !== undefined) {
                entry.timer = setTimeout(() => cancel(new AdbError('ADB_TIMEOUT', 'adb 调用在队列中已超时。')),
                    Math.min(2147483647, Math.max(0, deadlineMs - Date.now())));
            }
            Promise.resolve().then(() => this.drain());
        });
    }

    cleanup(entry) {
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener('abort', entry.onAbort);
    }

    finish(entry, error, result, failed = true) {
        this.cleanup(entry);
        this.depth -= 1;
        if (failed) entry.reject(error);
        else entry.resolve(result);
        if (this.depth === 0) this.resolveIdle();
    }

    drain() {
        if (this.running || !this.pending.length) return;
        const entry = this.pending.shift();
        this.running = true;
        this.cleanup(entry);
        const complete = (error, result, failed = true) => {
            this.running = false;
            this.finish(entry, error, result, failed);
            this.drain();
        };
        try {
            if (entry.signal?.aborted) throw new AdbError('ADB_ABORTED', 'adb 调用已取消。');
            if (entry.deadlineMs !== undefined && Date.now() >= entry.deadlineMs) {
                throw new AdbError('ADB_TIMEOUT', 'adb 调用在队列中已超时。');
            }
            Promise.resolve(entry.task()).then((result) => complete(null, result, false), (error) => complete(error));
        } catch (error) {
            complete(error);
        }
    }
}

class AdbClient {
    constructor(options = {}) {
        this.adbPath = normalizeAdbPath(options.adbPath);
        this.serial = String(options.serial ?? '').trim();
        this.logger = options.logger || console;
        this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS;
        this.queue = new SerialQueue(options.maxQueueSize);
        this.context = new AsyncLocalStorage();
        this.lastError = null;
        // 分辨率在一次会话里不会变（除非手动改过）。按 serial 缓存，避免每次感知
        // 都跑一遍 `wm size`。probeScreen 的合并命令也靠它决定要不要带尺寸查询。
        this.sizeCache = new Map();
    }

    configure(options = {}) {
        if (options.adbPath !== undefined) this.adbPath = normalizeAdbPath(options.adbPath);
        if (options.serial !== undefined) this.serial = String(options.serial ?? '').trim();
        if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
            this.timeoutMs = options.timeoutMs;
        }
        if (Number.isSafeInteger(options.maxQueueSize) && options.maxQueueSize > 0) {
            this.queue.maxQueueSize = options.maxQueueSize;
        }
    }

    withContext(options, task) {
        const parent = this.context.getStore() || {};
        const deadlines = [parent.deadlineMs, options.deadlineMs].filter(Number.isFinite);
        const signals = [...new Set([parent.signal, options.signal].filter(Boolean))];
        return this.context.run({
            deadlineMs: deadlines.length ? Math.min(...deadlines) : undefined,
            signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        }, task);
    }

    selectors(serialOverride) {
        const serial = String(serialOverride ?? this.serial ?? '').trim();
        return serial ? ['-s', serial] : [];
    }

    runRaw(args, options = {}) {
        // 全局 adb 命令（pair / connect / disconnect / devices / start-server 等）
        // 不接受 -s，传了会直接报错。这些命令用 noSelector 标记。
        const argv = [...(options.noSelector ? [] : this.selectors(options.serial)), ...args];
        const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : this.timeoutMs;
        const maxBuffer = options.maxBuffer || DEFAULT_MAX_BUFFER;
        const encoding = options.encoding === 'buffer' ? 'buffer' : 'utf8';

        return new Promise((resolve, reject) => {
            const child = execFile(
                this.adbPath,
                argv,
                { timeout, maxBuffer, encoding, windowsHide: true, signal: options.signal },
                (error, stdout, stderr) => {
                    if (!error) {
                        resolve({ stdout, stderr: String(stderr ?? '') });
                        return;
                    }
                    if (error.code === 'ABORT_ERR' || error.name === 'AbortError') {
                        reject(new AdbError('ADB_ABORTED', 'adb 调用已取消。', { argv }));
                        return;
                    }
                    if (error.code === 'ENOENT') {
                        reject(new AdbError(
                            'ADB_NOT_FOUND',
                            `找不到 adb 可执行文件：${this.adbPath}。请安装 Android platform-tools 或在插件配置里指定 ADB_PATH。`,
                        ));
                        return;
                    }
                    if (error.killed || error.signal) {
                        reject(new AdbError('ADB_TIMEOUT', `adb 调用超时（${timeout}ms）：adb ${argv.join(' ')}`, { argv }));
                        return;
                    }
                    const message = String(stderr || error.message || '').trim();
                    reject(new AdbError('ADB_FAILED', message || `adb 调用失败：adb ${argv.join(' ')}`, {
                        argv,
                        stderr: message,
                    }));
                },
            );
            // adb pair 会交互式询问配对码，必须通过 stdin 喂入
            if (typeof options.input === 'string' && child.stdin) {
                child.stdin.on('error', () => { /* 进程提前退出时忽略 EPIPE */ });
                child.stdin.end(options.input);
            }
            child.on('error', () => {});
        });
    }

    enqueue(args, options = {}) {
        const context = this.context.getStore() || {};
        const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs : this.timeoutMs;
        const deadlines = [Date.now() + timeoutMs, context.deadlineMs, options.deadlineMs].filter(Number.isFinite);
        const signals = [...new Set([context.signal, options.signal].filter(Boolean))];
        const request = {
            ...options,
            serial: options.serial ?? this.serial,
            deadlineMs: Math.min(...deadlines),
            signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        };
        return this.queue.push(() => {
            const remaining = request.deadlineMs - Date.now();
            if (remaining <= 0) throw new AdbError('ADB_TIMEOUT', 'adb 调用在队列中已超时。');
            request.timeoutMs = Math.max(1, Math.ceil(Math.min(timeoutMs, remaining)));
            return this.runRaw(args, request);
        }, request.deadlineMs, request.signal);
    }

    async runText(args, options = {}) {
        const { stdout } = await this.enqueue(args, options);
        return String(stdout ?? '').replace(/^\uFEFF/, '');
    }

    /**
     * stdout 返回 Buffer。screencap / screenrecord 这类二进制输出必须走这里，
     * 走 runText 会被 utf8 解码破坏字节。
     */
    async execOutBinary(args, options = {}) {
        const { stdout } = await this.enqueue(args, { ...options, encoding: 'buffer' });
        if (!Buffer.isBuffer(stdout)) {
            return Buffer.from(String(stdout ?? ''), 'utf8');
        }
        return stdout;
    }

    async version() {
        const text = await this.runText(['version'], { timeoutMs: 8000 });
        return text.trim();
    }

    async devices(options = {}) {
        const text = await this.runText(['devices', '-l'], { timeoutMs: 10000, ...options, noSelector: true });
        return parseDevices(text);
    }

    /**
     * 局域网内自动发现无线调试设备。
     *
     * 这是「不用填 IP」的关键：Android 11+ 会通过 mDNS 广播
     * `_adb-tls-connect._tcp`（已配对）和 `_adb-tls-pairing._tcp`（配对中）。
     * 但 `adb mdns services` 是快照 —— 发现需要时间，所以要轮询。
     *
     * mdns 不可用时返回空数组而不是抛错，让上层降级到手动填 IP。
     */
    async mdnsServices(options = {}) {
        const text = await this.runText(['mdns', 'services'], {
            timeoutMs: 8000,
            ...options,
            noSelector: true,
        }).catch(() => '');
        return parseMdnsServices(text);
    }

    async mdnsAvailable() {
        const text = await this.runText(['mdns', 'check'], {
            timeoutMs: 8000,
            noSelector: true,
        }).catch(() => '');
        return /mdns daemon version/i.test(text);
    }

    /**
     * 当前设备前台窗口焦点。用于在操作前确认「现在到底在哪个 App 上」。
     * 不同 Android 版本输出字段不同，做宽松匹配。
     */
    async currentFocus(serial) {
        const text = await this.runText(
            ['shell', 'dumpsys', 'window', 'displays'],
            { serial, timeoutMs: 15000, maxBuffer: 8 * 1024 * 1024 },
        ).catch(async () => this.runText(['shell', 'dumpsys', 'window'], { serial, timeoutMs: 15000 }));
        return parseFocusFromDumpsys(text);
    }

    /**
     * 屏幕亮灭状态。返回 Awake / Dozing / Asleep / Dreaming，取不到则 null。
     *
     * 为什么需要它：息屏时 uiautomator 拿到的是一棵 systemui 锁屏树，
     * 过滤后剩 0 个控件 —— 这和「页面是自绘的、没有节点」在结果上完全一样。
     * 不探测电源态就没法给模型一个可执行的下一步。
     */
    async wakefulness(serial) {
        const text = await this.runText(
            ['shell', 'dumpsys power'],
            { serial, timeoutMs: 10000, maxBuffer: 8 * 1024 * 1024 },
        ).catch(() => '');
        const match = /mWakefulness=(\w+)/.exec(text);
        return match ? match[1] : null;
    }

    /**
     * 一次往返取齐感知层需要的三件事：前台焦点、屏幕尺寸、电源态。
     *
     * 为什么不能靠 Promise.all：所有调用都过 SerialQueue（同一设备并发打 adb 会
     * 互相挤占、随机 "error: closed"），所以「并发」三个方法实际是严格串行：
     * 三次进程启动 + 三次往返。实测无线连接下 275-327ms，合并后 129-219ms。
     *
     * 用一条 shell 一次性跑完，靠分隔符分段；解析失败不影响其它字段（各自独立容错）。
     */
    async probeScreen(serial) {
        const MARK_SIZE = '@@VCP_SIZE@@';
        const MARK_POWER = '@@VCP_POWER@@';
        const cacheKey = String(serial ?? this.serial ?? '');
        const cachedSize = this.sizeCache.get(cacheKey) || null;

        // grep 在全部主流 Android 上都有（toybox/busybox）。dumpsys 输出可达数 MB，
        // 不能整包回传；取不到也不强求，退化为只拿其它字段。
        // 尺寸已缓存时跳过 `wm size`，省一段 shell 开销。
        const parts = ['dumpsys window displays 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp"'];
        if (!cachedSize) parts.push('; echo ' + MARK_SIZE + '; wm size');
        parts.push('; echo ' + MARK_POWER + '; dumpsys power 2>/dev/null | grep mWakefulness');

        const text = await this.runText(['shell', parts.join('')], {
            serial,
            timeoutMs: 20000,
            maxBuffer: 8 * 1024 * 1024,
        }).catch(() => '');

        // 先切 MARK_POWER 再切 MARK_SIZE：尺寸段可能被整体省略，
        // 那时 MARK_POWER 落在前段里，反过来切会把电源态丢掉。
        const [beforePower, powerText = ''] = String(text).split(MARK_POWER);
        const [windowPart, sizeText = ''] = beforePower.split(MARK_SIZE);

        const focus = parseFocusFromDumpsys(windowPart || '');
        let size = cachedSize;
        if (!size) {
            size = parseWmSize(String(sizeText || ''));
            if (size) this.sizeCache.set(cacheKey, size);
        }
        const wakeMatch = /mWakefulness=(\w+)/.exec(String(powerText || ''));

        return { focus, size, wakefulness: wakeMatch ? wakeMatch[1] : null };
    }

    /**
     * 屏幕尺寸。带缓存：同一 serial 在 SESSION 内只查一次。
     * force=true 时绕过缓存（用户可能改了分辨率 / 换了设备）。
     */
    async screenSize(serial, options = {}) {
        const key = String(serial ?? this.serial ?? '');
        if (!options.force && this.sizeCache.has(key)) return this.sizeCache.get(key);
        const text = await this.runText(['shell', 'wm', 'size'], { serial, timeoutMs: 10000 });
        const size = parseWmSize(text);
        if (size) this.sizeCache.set(key, size);
        return size;
    }
}

/**
 * 解析 dumpsys 里的焦点信息。
 *
 * dumpsys 里同一个键会出现多次（每个 display 一段），必须取最后一条：
 * 第一条常常是 mCurrentFocus=null（历史记录或未初始化的 display），
 * 取第一条会把「计算器已在前台」误判成「前台是桌面/未知」。
 *
 * 必须逐行匹配。旧实现直接在整份文本上跑正则，`[^\n}]*` 虽然不跨行，
 * 但 `\s+` 会跨行 —— 一旦 `mCurrentFocus=null` 后面紧跟任意带 `}` 的行，
 * 正则会从 null 那行一路轿接到下一行的右花括号，把整段当成一个匹配。
 * 实际故障：grep 预过滤后只剩 4 行，单次错误匹配吞掉全部内容，
 * component 变成 null。逐行匹配从根上消除这类轿接。
 */
function parseFocusFromDumpsys(text) {
    const strict = /mCurrentFocus=(Window\{\S+)[ \t]+(?:u\d+[ \t]+)?([^ \t/{}]+)\/([^ \t{}]+)[^}]*\}/;
    const loose = /mCurrentFocus=([^\n]+)/;
    const focusedAppRe = /mFocusedApp=.*?\s(\S+?)\/(\S+?)\s/;

    let focusMatch = null;
    let focusedApp = null;

    for (const line of String(text ?? '').split(/\r?\n/)) {
        const s = strict.exec(line);
        if (s) {
            focusMatch = s;
        } else {
            const l = loose.exec(line);
            if (l) focusMatch = l;
        }
        const fa = focusedAppRe.exec(line);
        if (fa) focusedApp = fa;
    }

    // mCurrentFocus=null 时不能把它当成「有窗口但无名」
    const focusIsNull = !focusMatch || /^\s*null\s*$/.test(focusMatch[1] || '');

    return {
        window: focusIsNull ? null : focusMatch[1],
        component: focusIsNull
            ? null
            : `${focusMatch[2] || ''}${focusMatch[3] ? `/${focusMatch[3]}` : ''}`.trim(),
        package: !focusIsNull && focusMatch[2] ? focusMatch[2] : (focusedApp ? focusedApp[1] : null),
        raw: String(text ?? '').slice(0, 2000),
    };
}

/**
 * 解析 `wm size` 输出。
 * 优先取 Override size：用户手动设过分辨率时它才存在，且才是实际渲染尺寸。
 */
function parseWmSize(text) {
    const source = String(text ?? '');
    const override = /Override size:\s*(\d+)x(\d+)/.exec(source);
    const physical = /Physical size:\s*(\d+)x(\d+)/.exec(source);
    const picked = override || physical;
    if (!picked) return null;
    return { width: Number(picked[1]), height: Number(picked[2]) };
}

/**
 * 解析 `adb mdns services` 的输出。
 *
 * 格式（制表符或空格分隔）：
 *   List of discovered mdns services
 *   adb-XXXXXX-YYYYYY   _adb-tls-connect._tcp   192.168.1.20:5555
 *   adb-XXXXXX-ZZZZZZ   _adb-tls-pairing._tcp   192.168.1.20:37105
 *
 * 这两类服务含义不同：
 * - connect：设备已经配对过，可以直接连
 * - pairing：手机上正开着配对对话框，此时才能配对
 */
function parseMdnsServices(text) {
    const services = [];
    const lines = String(text ?? '').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || /^List of discovered/i.test(trimmed)) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 3) continue;
        const [name, type, address] = parts;
        if (!/^_adb-tls-(connect|pairing)\._tcp$/.test(type)) continue;

        const separator = address.lastIndexOf(':');
        if (separator < 1) continue;
        const host = address.slice(0, separator);
        const port = Number(address.slice(separator + 1));
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;

        services.push({
            name,
            type,
            kind: type.includes('pairing') ? 'pairing' : 'connect',
            host,
            port,
            address: `${host}:${port}`,
        });
    }
    return services;
}

function parseDevices(text) {
    const devices = [];
    const lines = String(text ?? '').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || /^List of devices/i.test(trimmed) || /^\*/.test(trimmed)) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        const [serial, state] = parts;
        const extra = {};
        for (const token of parts.slice(2)) {
            const separator = token.indexOf(':');
            if (separator < 1) continue;
            extra[token.slice(0, separator)] = token.slice(separator + 1);
        }
        devices.push({
            serial,
            state,
            model: extra.model || '',
            device: extra.device || '',
            product: extra.product || '',
            transportId: extra.transport_id || '',
            usb: extra.usb || '',
        });
    }
    return devices;
}

function tmpName(prefix, ext) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

module.exports = {
    AdbClient,
    AdbError,
    DEFAULT_MAX_BUFFER,
    DEFAULT_MAX_QUEUE_SIZE,
    DEFAULT_TIMEOUT_MS,
    MAX_TEXT_BYTES,
    SerialQueue,
    normalizeAdbPath,
    parseDevices,
    parseMdnsServices,
    tmpName,
};
