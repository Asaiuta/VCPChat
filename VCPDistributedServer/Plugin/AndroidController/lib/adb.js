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
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const { AdbError } = require('./adb-error');
const { AdbCommandQueue, DEFAULT_MAX_QUEUE_SIZE } = require('./adb-queue');
const { displayTarget, windowDisplaySections, displayUniqueId, displayDeviceInfo, isShellPrivateMirror } = require('./display-target');
const HOST_READ_KEY = Symbol('adb-host-read');

function normalizeAdbPath(value) {
    const configured = String(value ?? '').trim();
    return configured || 'adb';
}

function schedulingKey(args, request) {
    if (!request.noSelector) return request.serial || null;
    const [command, option] = args;
    const hostRead = (command === 'devices' && (args.length === 1 || (args.length === 2 && option === '-l')))
        || (command === 'version' && args.length === 1)
        || (command === 'mdns' && args.length === 2 && ['services', 'check'].includes(option));
    return hostRead ? HOST_READ_KEY : null;
}

class AdbClient {
    constructor(options = {}) {
        this.adbPath = normalizeAdbPath(options.adbPath);
        this.serial = String(options.serial ?? '').trim();
        this.logger = options.logger || console;
        this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS;
        this.queue = new AdbCommandQueue(options.maxQueueSize);
        this.context = new AsyncLocalStorage();
        this.lastError = null;
        // 分辨率在一次会话里不会变（除非手动改过）。按 serial 缓存，避免每次感知
        // 都跑一遍 `wm size`。probeScreen 的合并命令也靠它决定要不要带尺寸查询。
        this.sizeCache = new Map();
    }

    /**
     * 队列观测快照。性能基线用，不含任何调度副作用。
     *
     * 计数语义：入口拒绝不计 failed；已接纳后的取消/超时保留既有双维度统计。
     *   completed / failed —— 已接纳任务的结局，含排队期取消/超时。
     *   rejected            —— 容量拒绝及取消/超时，含已接纳后排队失效的任务。
     *   failedByCode        —— 已接纳任务失败的分类，入口拒绝不在此列。
     * 所以「队列被挤爆」表现为 rejected.ADB_QUEUE_FULL 上涨而 failed 不变；
     * 「设备/命令有问题」表现为 failed 与 failedByCode 上涨。两者混在一起
     * 就无法从基线判断到底是入口压力还是设备故障。
     */
    queueStats() {
        const stats = this.queue.stats;
        return {
            depth: this.queue.depth,
            pending: this.queue.pending.length,
            running: this.queue.running,
            maxQueueSize: this.queue.maxQueueSize,
            peakDepth: stats.peakDepth,
            completed: stats.completed,
            failed: stats.failed,
            rejected: { ...stats.rejected },
            failedByCode: { ...stats.failedByCode },
        };
    }

    resetQueueStats() {
        this.queue.resetStats();
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
        const argv = [...args];
        const context = this.context.getStore() || {};
        const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? options.timeoutMs : this.timeoutMs;
        const deadlines = [Date.now() + timeoutMs, context.deadlineMs, options.deadlineMs].filter(Number.isFinite);
        const signals = [...new Set([context.signal, options.signal].filter(Boolean))];
        const request = {
            ...options,
            serial: String(options.serial ?? this.serial ?? '').trim(),
            deadlineMs: Math.min(...deadlines),
            signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        };
        return this.queue.push(() => {
            const remaining = request.deadlineMs - Date.now();
            if (remaining <= 0) throw new AdbError('ADB_TIMEOUT', 'adb 调用在队列中已超时。');
            request.timeoutMs = Math.max(1, Math.ceil(Math.min(timeoutMs, remaining)));
            return this.runRaw(argv, request);
        }, request.deadlineMs, request.signal, schedulingKey(argv, request));
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
        const text = await this.runText(['version'], { timeoutMs: 8000, noSelector: true });
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
     * 为什么不能靠 Promise.all：同设备调用共用调度 key（并发打 adb 会
     * 互相挤占、随机 "error: closed"），所以「并发」三个方法实际是严格串行：
     * 三次进程启动 + 三次往返。实测无线连接下 275-327ms，合并后 129-219ms。
     *
     * 用一条 shell 一次性跑完，靠分隔符分段；解析失败不影响其它字段（各自独立容错）。
     */
    async probeScreen(serial, options = {}) {
        if (options.fresh === true && options.display !== undefined && !displayTarget(options.display).isDefault) {
            const target = displayTarget(options.display);
            // Scoped probe adds `dumpsys display` so the target's uniqueId (not just its reusable logical id) is proven.
            const command = 'dumpsys window displays || exit $?; '
                + 'echo @@VCP_POLICY@@; dumpsys window policy || exit $?; '
                + 'echo @@VCP_POWER@@; dumpsys power || exit $?; '
                + 'echo @@VCP_DISPLAY@@; dumpsys display || exit $?; echo @@VCP_END@@';
            const text = await this.runText(['shell', command], {
                serial,
                timeoutMs: options.timeoutMs ?? 20000,
                maxBuffer: 16 * 1024 * 1024,
                signal: options.signal,
                deadlineMs: options.deadlineMs,
            });
            return parseScopedScreenProbe(text, target);
        }
        if (options.fresh === true) {
            // No fallback or cache: cancellation, timeout and transport failures must propagate.
            // These dumps are sequential observations, not an atomic screenshot transaction.
            const command = 'dumpsys window displays || exit $?; '
                + 'echo @@VCP_POLICY@@; dumpsys window policy || exit $?; '
                + 'echo @@VCP_POWER@@; dumpsys power || exit $?; echo @@VCP_END@@';
            const text = await this.runText(['shell', command], {
                serial,
                timeoutMs: options.timeoutMs ?? 20000,
                maxBuffer: 8 * 1024 * 1024,
                signal: options.signal,
                deadlineMs: options.deadlineMs,
            });
            const result = parseFreshScreenProbe(text);
            // Our own viewer's scrcpy mirror adds a content-less display on Android 14+ (PJZ110
            // 2026-11-06: every fresh probe returned displayId=null while the viewer streamed).
            // Only then pay one extra dumpsys display to prove the extra displays are such mirrors.
            if (result.displayId !== null || countDisplayHeaders(text) < 2) return result;
            const displayText = await this.runText(['shell', 'dumpsys display'], {
                serial,
                timeoutMs: options.timeoutMs ?? 20000,
                maxBuffer: 16 * 1024 * 1024,
                signal: options.signal,
                deadlineMs: options.deadlineMs,
            });
            return parseFreshScreenProbeWithMirrors(text, displayText) || result;
        }
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
 * Fresh coordinate evidence uses only explicitly scoped current state. Format reference:
 * AOSP android-14.0.0_r1 DisplayContent.dump (cur = logicalWidth/Height),
 * DisplayRotation.dump (mRotation), KeyguardStateMonitor.dump (showing/input restriction).
 * Unknown OEM formats and multiple displays are deliberately unsupported, not guessed.
 */
function parseFreshScreenProbe(text) {
    // dumpsys can print its own timeout while the surrounding shell still exits zero.
    if (/\bDUMP TIMEOUT\b/.test(String(text ?? ''))) {
        throw new AdbError('ADB_TIMEOUT', '屏幕上下文 dumpsys 采样超时。');
    }
    const result = {
        focus: { window: null, component: null, package: null, raw: '' },
        size: null, rotation: null, displayId: null,
        wakefulness: null, awake: null, keyguard: { showing: null, inputRestricted: null },
    };
    const sections = String(text ?? '').replace(/\r/g, '').split(
        /^@@VCP_(POLICY|POWER|END)@@[ \t]*$/m,
    );
    if (sections.length !== 7 || sections[1] !== 'POLICY'
        || sections[3] !== 'POWER' || sections[5] !== 'END' || sections[6].trim()) return result;
    const [windowText, , policyText, , powerText] = sections;
    const wake = [...powerText.matchAll(/^[ \t]*mWakefulness=([^\n]*)$/gm)].map(match => match[1].trim());
    const wakeStates = ['Asleep', 'Awake', 'Dreaming', 'Dozing'];
    const named = wake.filter(value => wakeStates.includes(value));
    // PJZ110 also dumps the vendor's numeric PowerManagerInternal state. It is
    // corroboration only: a missing, duplicate or conflicting named state stays unknown.
    if (named.length === 1 && wake.length <= 2
        && wake.every(value => value === named[0] || (/^[0-3]$/.test(value) && wakeStates[Number(value)] === named[0]))) {
        result.wakefulness = named[0];
        result.awake = result.wakefulness === 'Awake';
    }
    const monitors = dumpSections(policyText, 'KeyguardStateMonitor');
    if (monitors.length === 1) {
        const showing = dumpBoolean(monitors[0], 'mIsShowing');
        const restricted = dumpBoolean(monitors[0], 'mInputRestricted');
        result.keyguard = { showing, inputRestricted: restricted };
    } else if (monitors.length === 0) {
        // Some ROMs expose only the delegate's explicit cached keyguard fields.
        // Never use it to override an existing incomplete or ambiguous monitor.
        const delegates = dumpSections(policyText, 'KeyguardServiceDelegate');
        if (delegates.length === 1) result.keyguard = {
            showing: dumpBoolean(delegates[0], 'showing'),
            inputRestricted: dumpBoolean(delegates[0], 'inputRestricted'),
        };
    }
    const displays = [...windowText.matchAll(/^[ \t]*Display:[^\n]*$/gm)];
    if (displays.length !== 1 || !/^[ \t]*Display: mDisplayId=0(?: \(organized\))?[ \t]*$/.test(displays[0][0])) return result;
    result.displayId = 0;
    fillDisplayState(result, windowText.slice(displays[0].index));
    return result;
}

function countDisplayHeaders(text) {
    const sections = String(text ?? '').replace(/\r/g, '').split(/^@@VCP_POLICY@@[ \t]*$/m);
    return [...sections[0].matchAll(/^[ \t]*Display:[^\n]*$/gm)].length;
}

/**
 * Default display 0 when every other display is a proven shell private mirror (see
 * display-target.isShellPrivateMirror). Returns null (keep the fail-closed result) otherwise.
 * Adds `ignoredDisplays`; the single-display result shape is unchanged.
 */
function parseFreshScreenProbeWithMirrors(text, displayText) {
    if (/\bDUMP TIMEOUT\b/.test(String(displayText ?? ''))) return null;
    const result = parseFreshScreenProbe(text);
    const sections = String(text ?? '').replace(/\r/g, '').split(/^@@VCP_(POLICY|POWER|END)@@[ \t]*$/m);
    if (sections.length !== 7) return null;
    let parts;
    try { parts = windowDisplaySections(sections[0]); } catch { return null; }
    const physical = parts.filter(part => part.displayId === 0);
    if (physical.length !== 1 || !/^[ \t]*Display: mDisplayId=0(?: \(organized\))?[ \t]*$/m.test(physical[0].text.split('\n')[0])) return null;
    const ignored = [];
    for (const part of parts) {
        if (part.displayId === 0) continue;
        if (part.displayId === null) return null;
        const uniqueId = displayUniqueId(displayText, part.displayId);
        if (!isShellPrivateMirror(displayDeviceInfo(displayText, uniqueId), part.text)) return null;
        ignored.push({ displayId: part.displayId, uniqueId, reason: 'shell_private_mirror' });
    }
    result.displayId = 0;
    fillDisplayState(result, physical[0].text);
    result.ignoredDisplays = ignored;
    return result;
}

function parseDevicePolicyAndPower(result, policyText, powerText) {
    const wake = [...powerText.matchAll(/^[ \t]*mWakefulness=([^\n]*)$/gm)].map(match => match[1].trim());
    const wakeStates = ['Asleep', 'Awake', 'Dreaming', 'Dozing'];
    const named = wake.filter(value => wakeStates.includes(value));
    if (named.length === 1 && wake.length <= 2
        && wake.every(value => value === named[0] || (/^[0-3]$/.test(value) && wakeStates[Number(value)] === named[0]))) {
        result.wakefulness = named[0];
        result.awake = result.wakefulness === 'Awake';
    }
    const monitors = dumpSections(policyText, 'KeyguardStateMonitor');
    if (monitors.length === 1) {
        result.keyguard = { showing: dumpBoolean(monitors[0], 'mIsShowing'), inputRestricted: dumpBoolean(monitors[0], 'mInputRestricted') };
    } else if (monitors.length === 0) {
        const delegates = dumpSections(policyText, 'KeyguardServiceDelegate');
        if (delegates.length === 1) result.keyguard = {
            showing: dumpBoolean(delegates[0], 'showing'),
            inputRestricted: dumpBoolean(delegates[0], 'inputRestricted'),
        };
    }
}

/**
 * M4.5 P1 display-scoped probe. Other displays may exist; exactly one section must match the
 * target logical id AND `dumpsys display` must map that id to the target uniqueId, otherwise
 * displayId stays null (unproven) and frameContext rejects it. Wakefulness/keyguard remain
 * device-global evidence, parsed exactly like the default probe.
 */
function parseScopedScreenProbe(text, target) {
    if (/\bDUMP TIMEOUT\b/.test(String(text ?? ''))) {
        throw new AdbError('ADB_TIMEOUT', '屏幕上下文 dumpsys 采样超时。');
    }
    const result = {
        focus: { window: null, component: null, package: null, raw: '' },
        size: null, rotation: null, displayId: null,
        wakefulness: null, awake: null, keyguard: { showing: null, inputRestricted: null },
        target: { displayId: target.displayId, uniqueId: target.uniqueId, generation: target.generation },
        uniqueId: null,
    };
    const sections = String(text ?? '').replace(/\r/g, '').split(/^@@VCP_(POLICY|POWER|DISPLAY|END)@@[ \t]*$/m);
    if (sections.length !== 9 || sections[1] !== 'POLICY' || sections[3] !== 'POWER'
        || sections[5] !== 'DISPLAY' || sections[7] !== 'END' || sections[8].trim()) return result;
    const [windowText, , policyText, , powerText, , displayDump] = sections;
    parseDevicePolicyAndPower(result, policyText, powerText);
    let parts;
    try { parts = windowDisplaySections(windowText); } catch { return result; }
    const matches = parts.filter(part => part.displayId === target.displayId);
    if (matches.length !== 1) return result;
    result.uniqueId = displayUniqueId(displayDump, target.displayId);
    if (result.uniqueId !== target.uniqueId) return result;
    result.displayId = target.displayId;
    fillDisplayState(result, matches[0].text);
    return result;
}

// Per-display fields; displayText starts at that display's `Display:` header.
function fillDisplayState(result, displayText) {
    const focusLines = displayText.split('\n').filter((line) => /^[ \t]*mCurrentFocus=/.test(line));
    if (focusLines.length === 1 && /^[ \t]*mCurrentFocus=Window\{\S+[ \t]+(?:u\d+[ \t]+)?[^ \t/{}]+\/[^ \t{}]+[^}]*\}[ \t]*$/.test(focusLines[0])) {
        result.focus = parseFocusFromDumpsys(focusLines[0]);
    }
    // cur, unlike init/base/wm size or app bounds, is the current logical display size.
    const sizes = [...displayText.matchAll(/^[ \t]*(?:init=[^\n]*?[ \t]+)?cur=(\d+)x(\d+)[ \t]+app=/gm)];
    if (sizes.length === 1) {
        const width = Number(sizes[0][1]);
        const height = Number(sizes[0][2]);
        if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
            result.size = { width, height };
        }
    }
    const rotations = dumpSections(displayText, 'DisplayRotation');
    if (rotations.length === 1) {
        const values = [...rotations[0].matchAll(/^[ \t]*mRotation=([^ \t\n]+)(?:[ \t]|$)/gm)];
        if (values.length === 1 && /^[0-3]$/.test(values[0][1])) result.rotation = Number(values[0][1]);
    }
}

// Preserve indentation boundaries: similarly named fields in other dump objects are not evidence.
function dumpSections(text, name) {
    const lines = text.split('\n');
    const sections = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].trim() !== name) continue;
        const indent = lines[i].search(/\S/);
        const body = [];
        for (let j = i + 1; j < lines.length; j += 1) {
            if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
            body.push(lines[j]);
        }
        sections.push(body.join('\n'));
    }
    return sections;
}

function dumpBoolean(text, name) {
    const matches = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(`${name}=`));
    if (matches.length !== 1) return null;
    if (matches[0] === `${name}=true`) return true;
    if (matches[0] === `${name}=false`) return false;
    return null;
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
    AdbCommandQueue,
    SerialQueue: AdbCommandQueue,
    normalizeAdbPath,
    parseDevices,
    parseMdnsServices,
    tmpName,
};
