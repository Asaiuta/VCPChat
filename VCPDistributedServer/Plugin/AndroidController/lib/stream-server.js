'use strict';

/**
 * Loom 显示屏服务。
 *
 * 只监听 127.0.0.1：
 *   - loopback 是 potentially trustworthy origin，Loom 页面的 secure context 成立
 *   - 避免局域网内任何人都能看见你的手机屏幕
 *   - 避开 mixed-content / Private Network Access 的一堆麻烦
 *
 * 双通道：
 *   scrcpy（首选）— 设备硬件编码的 H.264，实测 ~11 fps、2.5KB/帧
 *   frameHub（回退）— screencap 出的 JPEG，~0.8 fps，但兼容性最好
 *
 * 路由：
 *   GET  /          查看器页面（Loom APP 的 startUrl 指向这里）
 *   GET  /frame     最新一帧（image/jpeg | image/png），无帧时现场采一帧
 *   GET  /status    采集状态 JSON
 *   GET  /health    存活探测
 *   WS   /stream    二进制帧推送 + 文本控制消息
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomBytes, timingSafeEqual } = require('crypto');
const { attachTakeoverChannel } = require('./takeover-channel');
const { validateScrcpyConfig, validateFitWidth, DEFAULTS: DISPLAY_DEFAULTS } = require('./display-preferences');

const VIEWER_FILE = path.join(__dirname, 'viewer.html');
const DEFAULT_PORT = 5977;

// JPEG 帧头：4 字节魔数 + 4 字节序号 + 8 字节时间戳（ms），小端。
// 有了它浏览器端才能丢弃乱序/重复帧，也便于统计真实帧率。
const FRAME_MAGIC = 0x56434d31; // "VCM1"

// H.264 帧头：4 字节魔数 + 4 字节序号 + 4 字节 pts(ms) + 4 字节标志，小端。
// 标志位：1=关键帧 2=配置包(SPS/PPS) 4=会话变更
const H264_MAGIC = 0x56434831; // "VCH1"
const H264_FLAG_KEY = 1;
const H264_FLAG_CONFIG = 2;
const H264_FLAG_SESSION = 4;

function encodeFrameHeader(frame) {
    const header = Buffer.allocUnsafe(16);
    header.writeUInt32LE(FRAME_MAGIC, 0);
    header.writeUInt32LE(frame.seq >>> 0, 4);
    header.writeBigUInt64LE(BigInt(frame.capturedAt), 8);
    return header;
}

function encodeH264Header(packet) {
    const header = Buffer.allocUnsafe(16);
    header.writeUInt32LE(H264_MAGIC, 0);
    header.writeUInt32LE(packet.seq >>> 0, 4);
    header.writeUInt32LE(Math.max(0, Math.round(packet.pts || 0)) >>> 0, 8);
    let flags = 0;
    if (packet.key) flags |= H264_FLAG_KEY;
    if (packet.type === 'config') flags |= H264_FLAG_CONFIG;
    if (packet.type === 'session') flags |= H264_FLAG_SESSION;
    header.writeUInt32LE(flags >>> 0, 12);
    return header;
}

function loadViewer() {
    try {
        return fs.readFileSync(VIEWER_FILE, 'utf8');
    } catch {
        return `<!doctype html><meta charset="utf-8"><title>Android 显示屏</title>
<body style="font:14px system-ui;background:#111;color:#eee;padding:24px">
<h1>缺少 viewer.html</h1><p>请检查插件目录：${VIEWER_FILE}</p></body>`;
    }
}

class StreamServer {
    constructor(options = {}) {
        this.frameHub = options.frameHub;
        // 可选：scrcpy H.264 通道。注入后 WS 优先走它（帧率高两个数量级）。
        this.scrcpyHub = options.scrcpyHub || null;
        this.displayPreferences = options.displayPreferences || null;
        this.logger = options.logger || console;
        this.port = Number.isFinite(options.port) && options.port >= 0 ? options.port : DEFAULT_PORT;
        this.host = options.host || '127.0.0.1';
        if (!['127.0.0.1', 'localhost'].includes(this.host)) {
            throw new Error('显示屏仅允许 localhost/127.0.0.1 回环监听');
        }
        this.sessionToken = null;
        this.server = null;
        this.wss = null;
        this.actualPort = null;
        this.startPromise = null;
        this.stopPromise = null;
        this.unsubscribers = new Map();
        // 设备管理接口（配对/连接/断开）。由主服务注入，未注入时 API 返回 503。
        this.deviceApi = options.deviceApi || null;
        this.takeoverApi = options.takeoverApi || null;
        this.takeoverChannels = new Map();
        this.scrcpyStreamers = new Map();   // socket → 取消订阅函数
        this.h264Decoders = new WeakMap(); // per-subscriber configuration and reference continuity
        this.lifecycle = 0;
        this.stopped = false;
        this.h264Paused = false;
        this.changingDevice = null;
        this.selectionBarrier = null;
        this.configQueue = null;
        this.configEpoch = 0;
        this.disposedSockets = new WeakSet();
        this.jpegOnlySockets = new WeakSet();
        this.maxBufferedBytes = Number.isFinite(options.maxBufferedBytes) && options.maxBufferedBytes > 0
            ? options.maxBufferedBytes : 4 * 1024 * 1024;
        this.pendingScrcpyAttachments = new Map();
        this.scrcpyProbePromise = null;
        this.idleScrcpyStop = null;

        // ---- 断流恢复状态 ----
        // scrcpy 流会因为手机息屏（无线调试关闭）、server 被杀、网络抖动而断。
        // 断开后必须自动重建，否则「回退兼容模式」只是个死胡同提示。
        this.recovering = false;            // 恢复流程单飞标志
        this.failures = 0;                  // 连续重启失败次数
        this.recoveryTimer = null;          // JPEG 模式下的周期探活
        this.reconnectDelayMs = options.reconnectDelayMs ?? 400;
        this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 4;
        this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 2500;
        this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? 5000;

        // ---- 沉默断流看门狗 ----
        // 无线调试半开、手机息屏、编码器卡死时，TCP 不会 close，
        // 于是 closed 事件永远不来 —— 画面就那么静止了。
        //
        // 阈值必须给得很大：手机画面完全静止时 scrcpy 本来就不发帧，
        // 4 秒就重启会把「用户在看一页不动的内容」当成故障，反复重启编码器。
        // 主信号是设备掉线；帧超时只用来兜编码器 hang 这种少数情况。
        this.stallTimeoutMs = options.stallTimeoutMs ?? 20000;
        this.watchdogTimer = null;
        this.watchdogIntervalMs = options.watchdogIntervalMs ?? 2000;
        this.stallLogged = false;   // 一轮停滞只报一次日志

        // ---- 性能基线计数 ----
        // 只增不改：任何分支都不得据此改变丢帧/断连决策，否则基线测的就不是产品行为。
        this.counters = {
            h264PacketsSent: 0,
            h264BytesSent: 0,
            jpegFramesSent: 0,
            jpegBytesSent: 0,
            jpegDroppedByBackpressure: 0,   // JPEG 通道溢出：丢帧继续
            textDroppedByBackpressure: 0,   // 文本回执溢出：丢弃
            slowSubscribersClosed: 0,       // H.264 通道溢出：断开慢订阅者
            recoveryAttempts: 0,
            recoverySuccesses: 0,
        };
    }

    /** 显示链路计数快照。性能基线用，不含副作用。 */
    metrics() {
        return {
            ...this.counters,
            h264Viewers: this.scrcpyStreamers.size,
            jpegViewers: this.unsubscribers.size,
            bufferedBytes: [...new Set([...this.scrcpyStreamers.keys(), ...this.unsubscribers.keys()])]
                .reduce((sum, socket) => sum + (socket.bufferedAmount || 0), 0),
            maxBufferedBytes: this.maxBufferedBytes,
            recovering: this.recovering,
            consecutiveFailures: this.failures,
            watchdogRunning: Boolean(this.watchdogTimer),
        };
    }

    resetMetrics() {
        for (const key of Object.keys(this.counters)) this.counters[key] = 0;
    }

    /**
     * 帧是否已经停了。
     *
     * 判据：hub 说自己 streaming，但距上一帧超过 stallTimeoutMs。
     * 首帧缺失使用独立期限；已有首帧的静屏由链路状态进一步判断。
     */
    framesStalled(now = Date.now()) {
        const hub = this.scrcpyHub;
        if (!hub) return false;
        const status = hub.status();
        if (status.state !== 'streaming') return false;
        const last = Number(hub.lastPacketAt) || 0;
        if (!last) return Boolean(hub.startedAt && now - hub.startedAt > this.firstFrameTimeoutMs);
        return now - last > this.stallTimeoutMs;
    }

    /** 开看门狗。有观众时才需要。 */
    startWatchdog() {
        if (this.watchdogTimer) return;
        this.watchdogTimer = setInterval(() => {
            this.checkLiveness().catch(() => {});
        }, this.watchdogIntervalMs);
        if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref();
    }

    stopWatchdog() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }

    /**
     * 一次存活检查。返回 true 表示发起了恢复。
     *
     * 分级判断，避免把「手机画面静止」误判成故障：
     *   1) 设备掉线（adb 看不到 / offline）→ 高置信度，直接恢复
     *   2) 设备还在，但帧停了很久 → 大概率是编码器卡死或半开连接
     *
     * 画面完全静止时 scrcpy 可能确实不发帧，所以 (2) 的阈值给得比较宽。
     */
    async checkLiveness() {
        if (!this.scrcpyHub) return false;
        if (this.recovering) return false;
        // 有观众才管：H.264 订阅者或 JPEG 订阅者都算
        if (this.scrcpyStreamers.size === 0 && this.unsubscribers.size === 0) return false;

        const status = this.scrcpyHub.status();
        if (status.state !== 'streaming') return false;
        // 已经在 JPEG 兼容模式：交给 scheduleScrcpyProbe 探活，别抢占
        if (this.scrcpyStreamers.size === 0) return false;


        if (!this.scrcpyHub.lastPacketAt && this.framesStalled()) {
            await this.handleScrcpyLoss('scrcpy 首帧超时');
            return true;
        }
        // ---- 1) 设备还在吗？----
        const deviceGone = await this.deviceVanished();
        if (deviceGone) {
            this.logger.warn?.('[AndroidController] 设备已掉线，开始恢复');
            await this.handleScrcpyLoss('设备掉线');
            return true;
        }

        // ---- 2) 设备在，但帧停了 ----
        if (!this.framesStalled()) {
            this.stallLogged = false;   // 恢复正常，下一轮停滞可以再报一次
            return false;
        }

        // 手机画面完全静止时 scrcpy 不发帧，这是正常的。
        // 只有「帧停了 且 底层连接确实死了」才动手 —— 否则会把静止画面当故障，
        // 每 20 秒重启一次编码器，白白烧 CPU 还卡顿。
        if (!this.isStreamDead()) {
            // 一轮停滞只报一次：静止画面可能持续几十秒，每个 tick 都打日志会刷屏
            if (!this.stallLogged) {
                this.stallLogged = true;
                this.logger.log?.('[AndroidController] 帧已停但链路正常，判定为静止画面，不重启');
            }
            return false;
        }
        this.stallLogged = false;

        this.logger.warn?.(`[AndroidController] 超过 ${this.stallTimeoutMs}ms 没有新帧且链路已断，开始恢复`);
        await this.handleScrcpyLoss('画面停止更新（链路中断）');
        return true;
    }

    /** 底层 scrcpy 连接是否确实死了（socket 已销毁或不存在） */
    isStreamDead() {
        const hub = this.scrcpyHub;
        if (!hub) return true;
        if (typeof hub.isSocketAlive === 'function') return !hub.isSocketAlive();
        // 兜底：能拿到 socket 就看它的状态
        const socket = hub.socket;
        if (!socket) return true;
        if (socket.destroyed) return true;
        return false;
    }

    /**
     * 设备是否已经不在了。
     *
     * 用 listDevices 而不是 devices()：前者已经封装好错误处理。
     * 拿不到结果时返回 false —— 查不清就别乱重启。
     */
    async deviceVanished() {
        if (!this.deviceApi?.listDevices) return false;
        let info;
        try {
            info = await this.deviceApi.listDevices();
        } catch {
            return false;
        }
        if (!info?.devices?.length) return true;        // 一台都没了
        return !info.devices.some((d) => d.state === 'device');
    }

    /**
     * 断流后重建 scrcpy 通道。
     *
     * 策略：快退避连试几次；全失败才真的切 JPEG（并继续低频探活）。
     * 单飞是必须的 —— 多个 socket 会各自收到同一次 closed 事件。
     */
    async handleScrcpyLoss(reason = 'stream closed') {
        if (this.scrcpyProbePromise) return this.scrcpyProbePromise;
        if (this.recovering) return;
        if (!this.scrcpyHub) return;
        // 主动 stop（用户关页面、服务收尾）不该被当成故障去重启。
        // scrcpy-hub 在 stop() 里置 stopping=true，start() 时清除。
        if (this.scrcpyHub.stopping) return;

        const token = this.lifecycle;
        if (!this.recoveryIsCurrent(token)) return;
        this.recovering = true;
        this.recoveryToken = token;
        this.notifyScrcpyClosed(reason);

        try {
            for (let attempt = 1; attempt <= this.maxRecoveryAttempts; attempt += 1) {
                if (this.scrcpyHub.stopping) return;
                if (this.scrcpyStreamers.size === 0 && this.unsubscribers.size === 0) {
                    // 没人看了，不必折腾手机去重启编码器
                    return;
                }
                const delay = this.reconnectDelayMs * attempt;
                if (delay > 0) await new Promise((r) => setTimeout(r, delay));
                if (!this.recoveryIsCurrent(token)) return;

                try {
                    await this.startScrcpy();
                    if (!this.recoveryIsCurrent(token)) return;
                    this.failures = 0;
                    this.counters.recoveryAttempts += attempt;
                    this.counters.recoverySuccesses += 1;
                    this.logger.log?.(`[AndroidController] scrcpy 已恢复（第 ${attempt} 次尝试）`);
                    await this.reattachScrcpy();
                    return;
                } catch (error) {
                    if (!this.recoveryIsCurrent(token)) return;
                    this.counters.recoveryAttempts += 1;
                    this.failures += 1;
                    this.logger.warn?.(`[AndroidController] scrcpy 重启失败 ${attempt}/${this.maxRecoveryAttempts}：${error.message}`);

                    // 关键一步：无线调试端口会变，设备掉线时重启 scrcpy 永远失败。
                    // 先把设备连回来，下一轮才有意义。
                    const reconnected = await this.ensureDevice().catch(() => null);
                    if (!this.recoveryIsCurrent(token)) return;
                    if (reconnected?.ok) {
                        this.logger.log?.(`[AndroidController] 设备已恢复：${reconnected.message}`);
                        // 设备回来了，立刻重试一次，不浪费一轮退避
                        try {
                            await this.startScrcpy();
                            if (!this.recoveryIsCurrent(token)) return;
                            this.failures = 0;
                            this.counters.recoverySuccesses += 1;
                            await this.reattachScrcpy();
                            return;
                        } catch { /* 继续下一轮 */ }
                    }
                }
            }

            if (!this.recoveryIsCurrent(token)) return;
            // 彻底失败：真的切到 JPEG，并继续低频探活
            this.logger.warn?.('[AndroidController] scrcpy 多次重启失败，切到 JPEG 兼容模式');
            this.fallbackAllToJpeg();
            this.scheduleScrcpyProbe();
        } finally {
            if (this.recoveryToken === token) this.recovering = false;
        }
    }

    hasH264Viewers() {
        return [...this.scrcpyStreamers.keys(), ...this.unsubscribers.keys(), ...this.pendingScrcpyAttachments.keys()]
            .some((socket) => this.canAttachScrcpy(socket));
    }

    recoveryIsCurrent(token) {
        return token === this.lifecycle && !this.stopped && !this.changingDevice
            && !this.scrcpyHub?.stopping && this.hasH264Viewers();
    }

    /** 停旧流后选择设备；只为仍有 H264 意图的观众恢复新流。 */
    changeDevice(select, { resume = true, configuration = false, onStreamError } = {}) {
        if (!configuration) this.configEpoch += 1;
        const previous = this.selectionBarrier;
        this.h264Paused = !resume;
        const token = ++this.lifecycle;
        this.cancelScrcpyProbe();
        this.stopWatchdog();
        this.notifyScrcpyClosed('设备切换');
        // Only selection stages serialize. Waiting for a previous full recovery
        // would cycle through its attachments back into this selection barrier.
        const selection = (async () => {
            if (previous) await previous.catch(() => {});
            if (token !== this.lifecycle || this.stopped) return;
            if (this.scrcpyHub) await this.scrcpyHub.stop();
            if (token !== this.lifecycle || this.stopped) return;
            return select();
        })();
        this.selectionBarrier = selection;
        selection.finally(() => {
            if (this.selectionBarrier === selection) this.selectionBarrier = null;
        }).catch(() => {});
        const operation = selection.then(async (result) => {
            if (token !== this.lifecycle || this.stopped || !this.hasH264Viewers()) return result;
            if (this.scrcpyHub) {
                try {
                    await this.startScrcpy();
                    if (token !== this.lifecycle || this.stopped || !this.hasH264Viewers()) return result;
                    await this.reattachScrcpy();
                    if (token === this.lifecycle && !this.stopped && this.scrcpyStreamers.size > 0) this.startWatchdog();
                } catch (error) {
                    if (token === this.lifecycle && !this.stopped && this.hasH264Viewers()) {
                        onStreamError?.(error);
                        this.logger.warn?.(`[AndroidController] 设备已切换，H264 启动失败：${error.message}`);
                        this.fallbackAllToJpeg();
                        this.scheduleScrcpyProbe();
                    }
                }
            }
            return result;
        });
        this.changingDevice = operation;
        operation.finally(() => {
            if (this.changingDevice === operation) this.changingDevice = null;
        }).catch(() => {});
        return operation;
    }

    /** Validate before enqueueing; only configuration requests share this FIFO. */
    configureScrcpy(body, { resetDisplay = false } = {}) {
        const config = validateScrcpyConfig(body);
        const epoch = this.configEpoch;
        const previous = this.configQueue;
        const operation = (async () => {
            if (previous) await previous.catch(() => {});
            // A device transaction may be restoring viewers after its selection
            // barrier has cleared. Do not let a configuration supersede it.
            while (this.changingDevice) await this.changingDevice;
            if (this.idleScrcpyStop) await this.idleScrcpyStop;
            const current = () => epoch === this.configEpoch && !this.stopped;
            const cancelled = (saved = false, configured = false) => Object.assign(new Error('显示配置已被设备切换或停止取消'), {
                code: 'SCRCPY_CONFIG_CANCELLED', saved, applied: configured ? 'next-start' : null,
            });
            if (!current()) throw cancelled();
            const hub = this.scrcpyHub;
            let saved = false, configured = false, streamError = null;
            const persistAndConfigure = async () => {
                const assertCurrent = () => { if (!current()) throw cancelled(); };
                assertCurrent();
                if (this.displayPreferences) {
                    if (resetDisplay) await this.displayPreferences.reset({ assertCurrent });
                    else await this.displayPreferences.updateScrcpy(config, { assertCurrent });
                    saved = true;
                }
                // A committed preference remains the next-start value even when a
                // device transaction supersedes the stream restart during disk I/O.
                hub.configure(config);
                configured = true;
            };
            if (!this.hasH264Viewers()) {
                await persistAndConfigure();
                if (!current()) throw cancelled(saved, configured);
                return { ok: true, saved, status: hub.status(), applied: 'next-start' };
            }
            let saveError = null;
            const changing = this.changeDevice(async () => {
                try { await persistAndConfigure(); }
                catch (error) {
                    if (error.code === 'SCRCPY_CONFIG_CANCELLED') throw error;
                    // Resume the previous configuration; an I/O failure must not
                    // leave subscribed viewers attached to a permanently stopped hub.
                    saveError = error;
                }
            }, { resume: !this.h264Paused, configuration: true, onStreamError: error => { streamError = error; } });
            const token = this.lifecycle;
            await changing;
            if (!current() || token !== this.lifecycle) throw cancelled(saved, configured);
            const status = hub.status();
            if (saveError) throw saveError;
            if (streamError) {
                return { ok: false, saved, status, applied: 'fallback', error: streamError.message, code: streamError.code || null };
            }
            return { ok: true, saved, status, applied: this.scrcpyStreamers.size > 0 && status.state === 'streaming'
                ? 'active-stream' : 'next-start' };
        })();
        this.configQueue = operation;
        operation.finally(() => {
            if (this.configQueue === operation) this.configQueue = null;
        }).catch(() => {});
        return operation;
    }

    /** nudge 设备重连：没注入 deviceApi 时视为不可用（测试/降级环境） */
    async ensureDevice() {
        if (!this.deviceApi?.reconnect) return { ok: false, action: 'unavailable', message: '没有设备管理接口' };
        if (this.reconnectingDevice) return this.reconnectingDevice;   // 单飞，别并发扫网
        this.reconnectingDevice = this.deviceApi.reconnect({ serial: this.scrcpyHub?.serial })
            .catch((error) => ({ ok: false, action: 'failed', message: error.message }))
            .finally(() => { this.reconnectingDevice = null; });
        return this.reconnectingDevice;
    }

    /** 通知所有在看的 socket：H.264 断了（但别急着切模式，服务端正在抢救） */
    notifyScrcpyClosed(reason) {
        const message = JSON.stringify({ type: 'scrcpy-closed', reason });
        for (const socket of this.scrcpyStreamers.keys()) {
            this.sendText(socket, message);
        }
    }

    /** 重启成功：已经订阅的补发 ready；已切 JPEG 的重新接回 H.264 */
    async reattachScrcpy() {
        const token = this.lifecycle;
        for (const socket of [...this.scrcpyStreamers.keys()]) {
            const pending = this.pendingScrcpyAttachments.get(socket);
            // eslint-disable-next-line no-await-in-loop
            if (pending) await pending.catch(() => false);
            if (token !== this.lifecycle || this.stopped) return;
            if (!this.scrcpyStreamers.has(socket)) continue;
            this.sendScrcpyReady(socket);
            // 新流 = 新 SPS/PPS + 新 keyframe，必须补发，否则页面等不到 config
            this.replayInit(socket);
        }
        for (const socket of [...this.unsubscribers.keys()]) {
            const pending = this.pendingScrcpyAttachments.get(socket);
            // A shared attachment may belong to a superseded lifecycle. Drain it
            // before one new attempt; a genuine readiness failure is not retried.
            // eslint-disable-next-line no-await-in-loop
            if (pending) await pending.catch(() => false);
            if (token !== this.lifecycle || this.stopped) return;
            if (this.scrcpyStreamers.has(socket)) continue;
            // eslint-disable-next-line no-await-in-loop
            await this.switchToScrcpy(socket).catch(() => {});
        }
    }

    /** 把单个 socket 从 JPEG 切回 H.264 */
    switchToScrcpy(socket) {
        return this.attachScrcpy(socket);
    }

    /** 全部切到 JPEG。这是真正的兼容模式，页面必须能看到东西。 */
    fallbackAllToJpeg() {
        for (const socket of [...this.scrcpyStreamers.keys()]) {
            const unsubscribe = this.scrcpyStreamers.get(socket);
            if (unsubscribe) unsubscribe();
            this.scrcpyStreamers.delete(socket);

            this.sendText(socket, JSON.stringify({
                type: 'scrcpy-fallback',
                reason: 'H.264 通道不可用，已切到兼容模式',
            }));
            this.attachFrames(socket);
        }
    }

    /** JPEG 模式下定期试一下 scrcpy 是否恢复 */
    scheduleScrcpyProbe(intervalMs = 8000) {
        if (this.recoveryTimer || this.stopped || !this.hasH264Viewers()) return;
        this.recoveryTimer = setInterval(() => {
            if (this.scrcpyStreamers.size > 0) {
                this.cancelScrcpyProbe();
                return;
            }

            this.tryRecoverScrcpy().catch(() => {});
        }, intervalMs);
        if (typeof this.recoveryTimer.unref === 'function') this.recoveryTimer.unref();
    }

    cancelScrcpyProbe() {
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
        }
    }

    /** 手动触发一次恢复尝试（探活与测试都用它） */
    tryRecoverScrcpy() {
        if (this.scrcpyProbePromise) return this.scrcpyProbePromise;
        if (this.recovering) return Promise.resolve(false);
        const operation = this.recoverScrcpyProbe();
        this.scrcpyProbePromise = operation;
        operation.finally(() => {
            if (this.scrcpyProbePromise === operation) this.scrcpyProbePromise = null;
        }).catch(() => {});
        return operation;
    }

    async recoverScrcpyProbe() {
        const token = this.lifecycle;
        if (!this.scrcpyHub || !this.recoveryIsCurrent(token)) return false;
        if (this.scrcpyStreamers.size > 0) return true;   // 已经在 H.264 上
        try {
            if (this.scrcpyHub.status().state !== 'streaming') {
                await this.startScrcpy();
            } else {
                await this.requireScrcpyReady(this.scrcpyHub, token);
            }
            if (!this.recoveryIsCurrent(token)) return false;
            await this.reattachScrcpy();
            if (!this.recoveryIsCurrent(token)) return false;
            this.cancelScrcpyProbe();
            return true;
        } catch {
            return false;
        }
    }

    /** 统一发 ready（首次连接与恢复共用） */
    sendScrcpyReady(socket) {
        const now = this.scrcpyHub.status();
        this.sendText(socket, JSON.stringify({
            type: 'scrcpy-ready',
            codec: now.codec,
            codecString: now.codecString,
            width: now.width,
            height: now.height,
            maxSize: now.maxSize,
            maxShortEdge: now.maxShortEdge ?? null,
            sourceWidth: now.sourceWidth ?? null,
            sourceHeight: now.sourceHeight ?? null,
            effectiveMaxSize: now.effectiveMaxSize ?? null,
            maxFps: now.maxFps,
        }));
        this.sendText(socket, JSON.stringify({ type: 'status', scrcpy: now }));
    }

    start() {
        if (this.stopPromise) return this.stopPromise.then(() => this.start());
        if (this.startPromise) return this.startPromise;
        if (this.server) return Promise.resolve(this.actualPort);
        this.startPromise = this._start().catch(async (error) => {
            await this._stop();
            throw error;
        }).finally(() => { this.startPromise = null; });
        return this.startPromise;
    }

    async _start() {
        this.stopped = false;
        this.sessionToken = randomBytes(32).toString('hex');

        this.server = http.createServer((req, res) => { this.handleHttp(req, res); });
        this.server.on('clientError', (_error, socket) => {
            try { socket.destroy(); } catch { /* 忽略 */ }
        });

        // ws 是项目既有依赖（package.json 已声明），不额外引入
        // eslint-disable-next-line global-require
        const { WebSocketServer } = require('ws');
        this.wss = new WebSocketServer({
            server: this.server,
            path: '/stream',
            maxPayload: 16384,
            verifyClient: ({ req }, done) => {
                const allowed = this.isSameOrigin(req) && this.isAllowedRequest(req) && this.hasSession(req);
                done(allowed, 403, 'Forbidden');
            },
        });
        // WSS 会把底层 server 的 error 转发出来。没有监听器时 Node 会当成未捕获异常
        // 直接掀翻进程 —— 端口被占用这种可恢复情况尤其不能这样。
        this.wss.on('error', (error) => {
            this.logger.warn?.(`[AndroidController] WebSocket 服务错误：${error.message}`);
        });
        this.wss.on('connection', (socket) => this.handleSocket(socket));

        // 首选端口被占用时退到随机端口：显示屏是有便更好、没有也无妨的附加能力，
        // 不该因为 5977 撞车就让整个插件初始化失败。调用方可通过 url() 读取实际地址。
        const bind = () => new Promise((resolve, reject) => {
            const onError = (error) => {
                this.server?.removeListener('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                this.server?.removeListener('error', onError);
                resolve();
            };
            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(this.port, this.host);
        });

        try {
            await bind();
            this.fallbackReason = null;
        } catch (error) {
            if (error.code !== 'EADDRINUSE' || this.port === 0) throw error;
            this.fallbackReason = `端口 ${this.port} 已被占用，改用随机端口`;
            this.logger.warn?.(`[AndroidController] ${this.fallbackReason}`);
            this.port = 0;
            await bind();
        }

        this.actualPort = this.server.address().port;
        this.logger.log?.(`[AndroidController] 显示屏服务已启动: http://${this.host}:${this.actualPort}`);
        return this.actualPort;
    }

    handleHttp(req, res) {
        if (!this.isAllowedRequest(req)) {
            sendJson(res, 403, { error: 'Forbidden' });
            return;
        }
        const url = new URL(req.url || '/', this.requestOrigin(req));
        const sensitive = ['/frame', '/status', '/api/display/preferences'].includes(url.pathname)
            || (url.pathname.startsWith('/api/') && this.deviceApi);
        if (sensitive && !this.hasSession(req)) {
            sendJson(res, 403, { ok: false, error: 'Session required' });
            return;
        }

        // 设备管理 API 允许写操作；其余路由保持只读。
        if (url.pathname.startsWith('/api/')) {
            this.handleApi(req, res, url);
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'Method Not Allowed' });
            return;
        }

        switch (url.pathname) {
            case '/':
            case '/settings':
            case '/index.html': {
                const html = loadViewer();
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Frame-Options': 'DENY',
                    'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
                    'Referrer-Policy': 'no-referrer',
                    'X-Content-Type-Options': 'nosniff',
                    ...(req.method === 'GET' ? { 'Set-Cookie': `${this.sessionCookieName()}=${this.sessionToken}; Path=/; HttpOnly; SameSite=Strict` } : {}),
                });
                res.end(req.method === 'HEAD' ? undefined : html);
                return;
            }
            case '/health':
                sendJson(res, 200, { ok: true });
                return;
            case '/status':
                sendJson(res, 200, {
                    ok: true,
                    scrcpy: this.scrcpyHub?.status?.() || null,
                    display: this.frameHub ? { ...this.frameHub.status(), serial: this.frameHub.adb?.serial || null } : null,
                    takeover: this.takeoverApi?.status() || { available: false, state: 'idle' },
                });
                return;
            case '/frame':
                this.serveFrame(req, res);
                return;
            default:
                sendJson(res, 404, { error: 'Not Found', path: url.pathname });
        }
    }

    /**
     * 设备管理 API —— 把 adb 命令行包装成按钮背后的接口。
     *
     * 安全模型：
     * 1) 回环监听隔离局域网，但不是身份认证；本机进程仍在信任边界内。
     * 2) HTTP 入口验证内存会话；写操作额外要求精确同源 Origin。
     * 3) 不接受跨源请求或预检。会话只由 viewer 启动响应的 HttpOnly cookie 交付。
     */
    async handleApi(req, res, url) {
        if (!this.deviceApi && url.pathname !== '/api/display/preferences') {
            sendJson(res, 503, { ok: false, error: '设备接口未就绪' });
            return;
        }

        const isWrite = req.method === 'POST';
        const manage = task => this.takeoverApi?.management ? this.takeoverApi.management(task) : task();

        // 预检请求一律拒绝：本服务不接受任何跨源写操作
        // （浏览器只有拿到 2xx 预检才会发真实 POST，这里直接断掉）
        // 必须放在方法校验之前，否则会被 405 抢先吃掉。
        if (req.method === 'OPTIONS') {
            res.writeHead(403);
            res.end();
            return;
        }

        if (!isWrite && req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
            return;
        }

        if (isWrite && !this.isSameOrigin(req)) {
            sendJson(res, 403, { ok: false, error: 'Cross-origin write rejected' });
            return;
        }

        try {
            if (req.method === 'GET') {
                switch (url.pathname) {
                    case '/api/display/preferences': {
                        const preferences = await this.displayPreferences?.load();
                        sendJson(res, 200, { ok: true, fitWidth: preferences?.fitWidth ?? false });
                        return;
                    }
                    case '/api/devices':
                        sendJson(res, 200, await this.deviceApi.listDevices());
                        return;
                    case '/api/adb':
                        sendJson(res, 200, await this.deviceApi.adbStatus());
                        return;
                    case '/api/scrcpy':
                        sendJson(res, 200, {
                            ok: true,
                            available: Boolean(this.scrcpyHub),
                            status: this.scrcpyHub ? this.scrcpyHub.status() : null,
                        });
                        return;
                    default:
                        sendJson(res, 404, { ok: false, error: 'Unknown API' });
                }
                return;
            }

            const body = await readJsonBody(req);
            if (url.pathname === '/api/display/preferences') {
                const preferences = validateFitWidth(body);
                if (!this.displayPreferences) throw Object.assign(new Error('显示偏好存储未就绪'), {
                    code: 'DISPLAY_PREFERENCES_UNAVAILABLE',
                });
                const session = this.sessionToken;
                const assertCurrent = () => {
                    if (this.stopped || session !== this.sessionToken) throw Object.assign(new Error('显示偏好保存已取消'), {
                        code: 'DISPLAY_PREFERENCES_CANCELLED',
                    });
                };
                const saved = await this.displayPreferences.updateFitWidth(preferences, { assertCurrent });
                sendJson(res, 200, { ok: true, fitWidth: saved.fitWidth });
                return;
            }
            this.takeoverApi?.assertIdle();
            switch (url.pathname) {
                case '/api/discover':
                    sendJson(res, 200, await this.deviceApi.discover(body));
                    return;
                case '/api/pair':
                    sendJson(res, 200, await manage(() => this.deviceApi.pair(body)));
                    return;
                case '/api/connect':
                    sendJson(res, 200, await manage(() => this.deviceApi.connect(body)));
                    return;
                case '/api/disconnect':
                    sendJson(res, 200, await manage(() => this.deviceApi.disconnect(body)));
                    return;
                case '/api/scrcpy/start':
                    if (!this.scrcpyHub) {
                        sendJson(res, 200, { ok: false, error: 'scrcpy 通道未启用' });
                        return;
                    }
                    if (this.h264Paused) {
                        let streamError = null;
                        const restarting = this.changeDevice(() => {}, { resume: true,
                            onStreamError: error => { streamError = error; } });
                        const token = this.lifecycle;
                        await restarting;
                        if (token !== this.lifecycle || this.stopped) throw new Error('scrcpy 启动已取消');
                        if (streamError) throw streamError;
                        if (!this.hasH264Viewers()) await this.startScrcpy();
                    } else {
                        await this.startScrcpy();
                    }
                    sendJson(res, 200, { ok: true, status: this.scrcpyHub.status() });
                    return;
                case '/api/scrcpy/stop':
                    if (!this.scrcpyHub) {
                        sendJson(res, 200, { ok: false, error: 'scrcpy 通道未启用' });
                        return;
                    }
                    await this.changeDevice(() => {}, { resume: false });
                    sendJson(res, 200, { ok: true, status: this.scrcpyHub.status() });
                    return;
                case '/api/scrcpy/config':
                    if (!this.scrcpyHub) {
                        sendJson(res, 200, { ok: false, error: 'scrcpy 通道未启用' });
                        return;
                    }
                    sendJson(res, 200, await this.configureScrcpy(body));
                    return;
                case '/api/display/reset': {
                    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
                        throw new Error('恢复默认显示设置不接受额外参数。');
                    }
                    if (!this.scrcpyHub || !this.displayPreferences) throw new Error('显示设置尚未就绪。');
                    const { fitWidth, ...config } = DISPLAY_DEFAULTS;
                    const result = await this.configureScrcpy(config, { resetDisplay: true });
                    sendJson(res, 200, { ...result, ...(result.saved ? { fitWidth } : {}) });
                    return;
                }
                default:
                    sendJson(res, 404, { ok: false, error: 'Unknown API' });
            }
        } catch (error) {
            // 业务错误统一以 200 + ok:false 返回，前端只处理一种响应形态
            sendJson(res, 200, {
                ok: false,
                error: error.message || '操作失败',
                code: error.code || null,
                ...(['/api/scrcpy/config', '/api/display/reset'].includes(url.pathname) ? {
                    status: this.scrcpyHub?.status() || null,
                    saved: error.saved === true,
                    applied: error.applied ?? null,
                    ...(url.pathname === '/api/display/reset' && error.saved === true
                        ? { fitWidth: this.displayPreferences.snapshot().fitWidth } : {}),
                } : {}),
            });
        }
    }

    requestOrigin(req) {
        const host = req.headers.host;
        const port = this.actualPort;
        return port && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host)
            ? `http://${host}` : null;
    }

    isSameOrigin(req) {
        // 不把 localhost 与 127.0.0.1、http 与 https 混成同一来源。
        const expected = this.requestOrigin(req);
        return Boolean(expected && req.headers.origin === expected);
    }

    isAllowedRequest(req) {
        if (!this.requestOrigin(req)) return false;
        if (req.headers.origin !== undefined && !this.isSameOrigin(req)) return false;
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return false;
        const dest = req.headers['sec-fetch-dest'];
        return !dest || !['iframe', 'frame', 'embed', 'object'].includes(dest);
    }

    sessionCookieName() {
        // Cookie 不按端口隔离，名称需带端口，避免多个显示屏互相覆盖。
        return `android_display_${this.actualPort}`;
    }

    hasSession(req) {
        if (!this.sessionToken) return false;
        const name = this.sessionCookieName();
        const values = String(req.headers.cookie || '').split(';')
            .map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
        if (values.length !== 1) return false;
        const token = values[0].slice(name.length + 1);
        if (!/^[a-f0-9]{64}$/.test(token)) return false;
        return timingSafeEqual(Buffer.from(token), Buffer.from(this.sessionToken));
    }

    async serveFrame(req, res) {
        if (!this.frameHub) {
            sendJson(res, 503, { error: 'FrameHub 未就绪' });
            return;
        }
        const generation = this.frameHub.generation;
        let frame = this.frameHub.latestOrNull();
        if (!frame) {
            try {
                frame = await this.frameHub.capture();
                if (generation !== this.frameHub.generation) {
                    sendJson(res, 503, { error: '设备已切换，请重试' });
                    return;
                }
            } catch (error) {
                sendJson(res, 503, { error: error.message, code: error.code || null });
                return;
            }
        }
        if (!frame) {
            sendJson(res, 503, { error: '暂无可用画面' });
            return;
        }
        res.writeHead(200, {
            'Content-Type': frame.mime,
            'Content-Length': frame.buffer.length,
            'Cache-Control': 'no-store',
            'X-Frame-Seq': String(frame.seq),
        });
        res.end(req.method === 'HEAD' ? undefined : frame.buffer);
    }

    handleSocket(socket) {
        if (!this.frameHub && !this.scrcpyHub) {
            socket.close(1011, '采集组件未就绪');
            return;
        }

        this.takeoverChannels.set(socket, attachTakeoverChannel({ socket, api: this.takeoverApi,
            send: text => {
                if (socket.readyState !== 1 || this.disposedSockets.has(socket)
                    || (socket.bufferedAmount || 0) + Buffer.byteLength(text) > this.maxBufferedBytes) return false;
                try { socket.send(text); return true; } catch { return false; }
            } }));

        // 优先尝试 scrcpy 通道；失败则降级到 JPEG 采集。
        this.attachScrcpy(socket)
            .then((attached) => {
                if (!attached && !this.scrcpyStreamers.has(socket)) {
                    this.attachFrames(socket);
                    this.scheduleScrcpyProbe();
                }
            })
            .catch(() => {
                if (!this.scrcpyStreamers.has(socket)) this.attachFrames(socket);
            });

        socket.on('message', (raw) => {
            let payload;
            try {
                payload = JSON.parse(String(raw));
            } catch {
                return;
            }
            if (payload?.type === 'ping') {
                this.sendText(socket, JSON.stringify({ type: 'pong', at: Date.now() }));
            } else if (payload?.type === 'request-jpeg') {
                // 页面自己决定回退（解码器出错等）。必须真的给它推 JPEG，
                // 否则它切到 <img> 后永远等不到帧。
                this.jpegOnlySockets.add(socket);
                this.attachFrames(socket);
            } else if (payload?.type === 'request-keyframe') {
                if (!this.scrcpyStreamers.has(socket)) return;
                // Replay current configuration, then wait for a fresh IDR if any
                // delta has already followed the cached keyframe.
                const replayed = this.replayInit(socket);
                if (!replayed) {
                    this.handleScrcpyLoss('客户端请求重同步').catch(() => {});
                }
            } else if (payload?.type === 'stats') {
                this.sendText(socket, JSON.stringify({
                    type: 'stats',
                    scrcpy: this.scrcpyHub ? this.scrcpyHub.status() : null,
                    frame: this.frameHub ? this.frameHub.status() : null,
                }));
            }
        });

        socket.on('close', () => this.disposeSocket(socket));
        socket.on('error', () => this.disposeSocket(socket));
    }

    /**
     * 接上 scrcpy H.264 通道。
     * 返回 false 表示不可用（调用方应回退到 JPEG 路径）。
     */
    attachScrcpy(socket) {
        if (!this.canAttachScrcpy(socket)) return Promise.resolve(false);
        const pending = this.pendingScrcpyAttachments.get(socket);
        if (pending) return pending;
        const operation = this.attachScrcpyOnce(socket);
        this.pendingScrcpyAttachments.set(socket, operation);
        operation.finally(() => {
            if (this.pendingScrcpyAttachments.get(socket) === operation) this.pendingScrcpyAttachments.delete(socket);
        }).catch(() => {});
        return operation;
    }

    async attachScrcpyOnce(socket) {
        // Follow replacement barriers when concurrent selections arrive while
        // waiting. Attachments must not wait for recovery, which awaits them.
        do {
            while (this.selectionBarrier) await this.selectionBarrier;
            if (this.idleScrcpyStop) await this.idleScrcpyStop;
        } while (this.selectionBarrier);
        const token = this.lifecycle;
        const hub = this.scrcpyHub;
        if (token !== this.lifecycle || !hub || !this.canAttachScrcpy(socket)) return false;
        if (this.scrcpyStreamers.has(socket)) return true;

        clearTimeout(this.h264Decoders.get(socket)?.timer);
        this.h264Decoders.set(socket, { configured: false, waiting: true, seq: null });

        // 先订阅再启流，避免漏掉开头那个 config 包（SPS/PPS）
        const unsubscribe = hub.subscribe((packet) => {
            if (packet.type === 'closed') {
                // 不再只是"通知页面然后等死"：交给恢复流程重建通道
                this.handleScrcpyLoss('stream closed').catch(() => {});
                return;
            }
            this.sendScrcpyPacket(socket, packet);
        });
        this.scrcpyStreamers.set(socket, unsubscribe);

        try {
            if (hub.status().state !== 'streaming') {
                await hub.start();
                if (token !== this.lifecycle || !this.canAttachScrcpy(socket)) {
                    if (this.scrcpyStreamers.get(socket) === unsubscribe) {
                        unsubscribe();
                        this.scrcpyStreamers.delete(socket);
                    }
                    if (!this.hasH264Viewers()) this.releaseIdleScrcpy();
                    return false;
                }
            }
            await this.requireScrcpyReady(hub, token);
        } catch (error) {
            if (this.scrcpyStreamers.get(socket) === unsubscribe) {
                unsubscribe();
                this.scrcpyStreamers.delete(socket);
            }
            if (token !== this.lifecycle) return false;
            this.logger.warn?.(`[AndroidController] scrcpy 启动失败，回退 JPEG：${error.message}`);
            return false;
        }

        // Readiness includes dimensions, codec configuration and a real first frame.
        if (token !== this.lifecycle || this.scrcpyStreamers.get(socket) !== unsubscribe || !this.canAttachScrcpy(socket)) return false;
        const stopFrames = this.unsubscribers.get(socket);
        if (stopFrames) {
            stopFrames();
            this.unsubscribers.delete(socket);
        }
        this.sendScrcpyReady(socket);

        // Replay configuration; a stale IDR must never jump to current deltas.
        this.replayInit(socket);

        if (token !== this.lifecycle || this.scrcpyStreamers.get(socket) !== unsubscribe || !this.canAttachScrcpy(socket)) return false;
        this.startWatchdog();     // 有人在看了，开始盯帧
        return true;
    }

    /** 把初始化所需的缓存包补发给某个 socket（顺序 session → config → keyframe） */
    replayInit(socket) {
        const hub = this.scrcpyHub;
        if (!hub || !this.canAttachScrcpy(socket)) return 0;
        const wasPreviewing = this.h264Decoders.get(socket)?.preview;
        this.unsubscribers.get(socket)?.();
        this.unsubscribers.delete(socket);
        clearTimeout(this.h264Decoders.get(socket)?.timer);
        this.h264Decoders.set(socket, { configured: false, waiting: true, seq: null });
        if (wasPreviewing) this.sendScrcpyReady(socket);
        if (typeof hub.replayInitTo === 'function') {
            return hub.replayInitTo((packet) => this.sendScrcpyPacket(socket, packet));
        }
        // 兜底：hub 没实现 replayInitTo 时按字段拼一遍
        let sent = 0;
        for (const packet of [hub.lastSession, hub.lastConfig, hub.lastKeyFrame]) {
            if (!packet) continue;
            if (packet.type === 'frame' && packet.seq !== hub.seq) continue;
            this.sendScrcpyPacket(socket, packet);
            sent += 1;
        }
        return sent;
    }

    async startScrcpy() {
        const hub = this.scrcpyHub;
        const token = this.lifecycle;
        await hub.start();
        if (token !== this.lifecycle && !this.hasH264Viewers()) this.releaseIdleScrcpy();
        await this.requireScrcpyReady(hub, token);
    }

    async requireScrcpyReady(hub, token) {
        const generation = hub._generation;
        const current = () => token === this.lifecycle && !this.stopped
            && generation === hub._generation;
        const handshake = await this.waitForHandshake(hub, this.handshakeTimeoutMs, current);
        if (!current()) throw new Error('scrcpy 启动已取消');
        const firstFrame = handshake && await this.waitForFirstFrame(hub, this.firstFrameTimeoutMs, current);
        if (!current()) throw new Error('scrcpy 启动已取消');
        if (handshake && firstFrame) return;
        const error = new Error(handshake ? 'scrcpy 首帧超时' : 'scrcpy 握手超时');
        if (typeof hub.failStartup === 'function') await hub.failStartup(error, generation);
        else await hub.stop();
        throw error;
    }

    async waitForFirstFrame(hub, timeoutMs, current = () => true) {
        const deadline = Date.now() + timeoutMs;
        while (current()) {
            if (hub.status().state !== 'streaming') return false;
            if (hub.lastPacketAt > 0) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, Math.min(120, deadline - Date.now())));
        }
        return false;
    }

    /** 轮询等待 scrcpy 握手完成（拿到尺寸与 SPS） */
    async waitForHandshake(hub, timeoutMs, current = () => true) {
        const deadline = Date.now() + timeoutMs;
        while (current()) {
            const status = hub.status();
            if (status.state === 'error' || status.state === 'stopped') return false;
            if (status.width && status.height && status.codecString) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, Math.min(120, deadline - Date.now())));
        }
        return false;
    }

    canAttachScrcpy(socket) {
        return !this.stopped && !this.h264Paused && socket?.readyState === 1
            && !this.disposedSockets.has(socket) && !this.jpegOnlySockets.has(socket);
    }

    /** JPEG 回退路径 */
    attachFrames(socket, { keepScrcpy = false } = {}) {
        if (this.stopped || !socket || socket.readyState !== 1 || this.disposedSockets.has(socket)) return;
        const stopScrcpy = this.scrcpyStreamers.get(socket);
        if (!keepScrcpy) clearTimeout(this.h264Decoders.get(socket)?.timer);
        if (stopScrcpy && !keepScrcpy) {
            this.scrcpyStreamers.delete(socket);
            stopScrcpy();
        }
        if (this.jpegOnlySockets.has(socket)) this.releaseIdleScrcpy();
        if (!this.frameHub) {
            socket.close(1011, 'FrameHub 未就绪');
            return;
        }
        // 幂等：恢复流程可能对同一个 socket 调多次，重复订阅会翻倍推流
        if (this.unsubscribers.has(socket)) return;

        const latest = this.frameHub.latestOrNull();
        if (latest) this.sendFrame(socket, latest);
        this.sendText(socket, JSON.stringify({ type: 'status', frame: this.frameHub.status() }));

        if (this.stopped || socket.readyState !== 1 || this.disposedSockets.has(socket)) return;
        const unsubscribe = this.frameHub.subscribe((frame) => this.sendFrame(socket, frame));
        this.unsubscribers.set(socket, unsubscribe);
    }

    disposeSocket(socket) {
        if (this.disposedSockets.has(socket)) return;
        this.disposedSockets.add(socket);
        clearTimeout(this.h264Decoders.get(socket)?.timer);
        this.h264Decoders.delete(socket);
        this.takeoverChannels.get(socket)?.();
        this.takeoverChannels.delete(socket);
        const unsubscribe = this.unsubscribers.get(socket);
        if (unsubscribe) {
            unsubscribe();
            this.unsubscribers.delete(socket);
        }

        const stopScrcpy = this.scrcpyStreamers.get(socket);
        if (stopScrcpy) {
            stopScrcpy();
            this.scrcpyStreamers.delete(socket);
        }

        this.releaseIdleScrcpy();
    }

    releaseIdleScrcpy() {
        if (this.hasH264Viewers()) return;
        this.lifecycle += 1;
        this.stopWatchdog();
        this.cancelScrcpyProbe();
        if (!this.scrcpyHub || this.idleScrcpyStop) return;
        const operation = this.scrcpyHub.stop().catch(() => {});
        this.idleScrcpyStop = operation;
        operation.finally(() => {
            if (this.idleScrcpyStop === operation) this.idleScrcpyStop = null;
        }).catch(() => {});
    }


    sendText(socket, text) {
        if (!socket || socket.readyState !== 1 || this.disposedSockets.has(socket)) return;
        if ((socket.bufferedAmount || 0) + Buffer.byteLength(text) > this.maxBufferedBytes) {
            if (this.scrcpyStreamers.has(socket)) {
                this.counters.slowSubscribersClosed += 1;
                this.disposeSocket(socket);
                try { socket.close(1013, 'H264 send queue exceeded'); } catch { /* 已关闭 */ }
            } else {
                this.counters.textDroppedByBackpressure += 1;
            }
            return;
        }
        try { socket.send(text); } catch { this.disposeSocket(socket); }
    }

    waitForKeyframe(socket, decoder) {
        if (decoder.timer || decoder.preview || !this.scrcpyStreamers.has(socket)) return;
        decoder.timer = setTimeout(() => {
            decoder.timer = null;
            if (this.h264Decoders.get(socket) !== decoder || !decoder.waiting
                || !this.canAttachScrcpy(socket) || !this.scrcpyStreamers.has(socket)) return;
            // A static screen may never produce a new IDR. Keep the video
            // subscription, but show JPEG until a complete reference chain starts.
            decoder.preview = true;
            this.sendText(socket, JSON.stringify({ type: 'scrcpy-fallback', reason: '等待新关键帧' }));
            this.attachFrames(socket, { keepScrcpy: true });
        }, this.firstFrameTimeoutMs);
        decoder.timer.unref?.();
    }

    sendScrcpyPacket(socket, packet) {
        if (!this.canAttachScrcpy(socket)) return;
        if (packet.type !== 'session' && !packet.data?.length) return;
        let decoder = this.h264Decoders.get(socket);
        if (!decoder) {
            decoder = { configured: false, waiting: true, seq: null };
            this.h264Decoders.set(socket, decoder);
        }
        if (packet.type === 'session') {
            decoder.configured = false; decoder.waiting = true; decoder.seq = null;
            this.waitForKeyframe(socket, decoder);
        } else if (packet.type === 'config') {
            decoder.configured = true; decoder.waiting = true; decoder.seq = null;
            this.waitForKeyframe(socket, decoder);
        } else if (packet.type === 'frame') {
            if (!decoder.configured) return;
            if (!packet.key && (decoder.waiting || packet.seq !== decoder.seq + 1)) {
                decoder.waiting = true;
                this.waitForKeyframe(socket, decoder);
                return;
            }
            if (decoder.preview) {
                this.unsubscribers.get(socket)?.();
                this.unsubscribers.delete(socket);
                this.sendScrcpyReady(socket);
                // JPEG fallback closed the viewer decoder. Reconfigure before IDR.
                for (const header of [this.scrcpyHub?.lastSession, this.scrcpyHub?.lastConfig]) {
                    if (header) this.sendScrcpyPacket(socket, header);
                }
                if (!this.canAttachScrcpy(socket)) return;
                decoder.preview = false;
            }
            clearTimeout(decoder.timer); decoder.timer = null;
            decoder.waiting = false; decoder.seq = packet.seq;
        }
        let data = packet.data;
        if (packet.type === 'session') {
            data = Buffer.alloc(12);
            data.writeUInt32BE(packet.width >>> 0, 4);
            data.writeUInt32BE(packet.height >>> 0, 8);
        } else if (!data?.length) return;

        if ((socket.bufferedAmount || 0) + 16 + data.length > this.maxBufferedBytes) {
            this.counters.slowSubscribersClosed += 1;
            this.disposeSocket(socket);
            try { socket.close(1013, 'H264 send queue exceeded'); } catch { /* 已关闭 */ }
            return;
        }
        try {
            socket.send(Buffer.concat([encodeH264Header(packet), data]), { binary: true });
            this.counters.h264PacketsSent += 1;
            this.counters.h264BytesSent += data.length;
        } catch {
            this.disposeSocket(socket);
        }
    }

    sendFrame(socket, frame) {
        if (!socket || socket.readyState !== 1 || this.disposedSockets.has(socket)) return;
        if (!frame?.buffer?.length) return;
        if ((socket.bufferedAmount || 0) + 16 + frame.buffer.length > this.maxBufferedBytes) {
            this.counters.jpegDroppedByBackpressure += 1;
            return;
        }
        try {
            socket.send(Buffer.concat([encodeFrameHeader(frame), frame.buffer]), { binary: true });
            this.counters.jpegFramesSent += 1;
            this.counters.jpegBytesSent += frame.buffer.length;
        } catch {
            this.disposeSocket(socket);
        }
    }

    stop() {
        if (this.stopPromise) return this.stopPromise;
        this.stopped = true;
        this.configEpoch += 1;
        this.lifecycle += 1;
        this.stopPromise = (async () => {
            if (this.startPromise) await this.startPromise.catch(() => {});
            await this._stop();
        })().finally(() => { this.stopPromise = null; });
        return this.stopPromise;
    }

    async _stop() {
        this.stopped = true;
        this.lifecycle += 1;
        this.cancelScrcpyProbe();
        this.stopWatchdog();
        await this.takeoverApi?.stop();
        for (const close of this.takeoverChannels.values()) close();
        this.takeoverChannels.clear();
        for (const socket of [...this.unsubscribers.keys()]) this.disposeSocket(socket);
        for (const socket of [...this.scrcpyStreamers.keys()]) this.disposeSocket(socket);
        await this.displayPreferences?.flush?.();

        // 关掉设备端的编码器，不然它会一直占着 SurfaceFlinger
        if (this.scrcpyHub) {
            try { await this.scrcpyHub.stop(); } catch { /* 忽略 */ }
        }

        if (this.wss) {
            const wss = this.wss;
            this.wss = null;
            for (const client of wss.clients) {
                try { client.terminate(); } catch { /* 忽略 */ }
            }
            await new Promise((resolve) => {
                wss.close(() => resolve());
                // 没有客户端时 close 应立即回调；防御性兜底避免异常路径挂死
                setTimeout(resolve, 2000).unref?.();
            });
        }

        if (this.server) {
            const server = this.server;
            this.server = null;
            if (server.listening) {
                // close() 只停止接受新连接，已有 keep-alive 连接会让它永远不回调。
                // 调用方的 fetch / <img> 都走 keep-alive，不主动断开就会把 stop() 挂死。
                const closing = new Promise((resolve) => server.close(() => resolve()));
                if (typeof server.closeAllConnections === 'function') {
                    server.closeAllConnections();
                }
                await Promise.race([
                    closing,
                    new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
                ]);
            }
            // 从未成功 listen 时没有资源需要释放，直接丢弃实例即可
        }

        this.actualPort = null;
        this.sessionToken = null;
    }

    url() {
        return this.actualPort ? `http://${this.host}:${this.actualPort}` : null;
    }
}






function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

/**
 * 读取 JSON 请求体，带大小上限。
 * 上限 4KB 足够，防止本机其他进程把服务当内存垃圾桶。
 */
function readJsonBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('error', reject);
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text) { resolve({}); return; }
            try { resolve(JSON.parse(text)); }
            catch { reject(new Error('请求体不是合法 JSON')); }
        });
    });
}

module.exports = {
    DEFAULT_PORT,
    FRAME_MAGIC,
    StreamServer,
    encodeFrameHeader,
    sendJson,
    readJsonBody,
};
