'use strict';

/**
 * 画面采集与推流。
 *
 * 性能实测（PJZ110 / Android 17 / WiFi 热点，1440×3168）：
 *
 *   screencap -p (PNG)   2450ms/帧  设备端 PNG 编码是大头
 *   screencap (raw)      1219ms/帧  = 首字节 315ms + 传输 904ms + sharp 54ms
 *   raw × 3 并发         3000ms/帧  设备端抢 SurfaceFlinger，反而慢 3 倍
 *
 * 结论：单路 raw 是当前架构的极限。瓶颈在传输 17.4MB（ADB 实测 161Mbps）。
 * sharp 只占 54ms，并发采集有害无益，因此只运行单路采集。
 *
 * 三条硬规则：
 * 1) 每一帧都必须校验字节数 —— adb exec-out 传 17MB 时约 1/8 概率短读
 *    （尾部丢几百字节），不校验会让 sharp 直接报内存不足。
 * 2) 无人订阅不采集：WS 客户端为 0 且超过 idleGraceMs 就停，别让手机一直发热。
 * 3) 只保留最新帧：宁可丢帧也不排队，过时的画面没有推送价值。
 */

const { EventEmitter } = require('events');

const DEFAULT_QUALITY = 70;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_IDLE_GRACE_MS = 5000;

// screencap raw 头部：width(4) height(4) format(4) colorspace(4)，小端
const RAW_HEADER_BYTES = 16;
const PIXEL_FORMAT_RGBA_8888 = 1;

const MODE_AUTO = 'auto';
const MODE_RAW = 'raw';
const MODE_PNG = 'png';

class FrameHub extends EventEmitter {
    constructor(options = {}) {
        super();
        this.adb = options.adb;
        this.sharp = options.sharp || null;
        this.logger = options.logger || console;

        this.quality = clampInt(options.quality, DEFAULT_QUALITY, 10, 95);
        this.intervalMs = clampInt(options.intervalMs, DEFAULT_INTERVAL_MS, 20, 5000);
        this.maxWidth = clampInt(options.maxWidth, 540, 180, 2160);
        this.idleGraceMs = clampInt(options.idleGraceMs, DEFAULT_IDLE_GRACE_MS, 0, 120000);
        this.format = options.format === 'png' ? 'png' : 'jpeg';
        this.captureMode = normalizeMode(options.captureMode);

        this.latest = null;          // { buffer, mime, width, height, capturedAt, seq }
        this.seq = 0;
        this.inFlight = null;        // 单飞：capture() 期间共享的 Promise
        this.pendingCaptures = new Set();
        this.generation = 0;
        this.timer = null;
        this.retryTimer = null;
        this.subscribers = new Set();
        this.lastError = null;
        this.lastDurationMs = 0;
        this.idleSince = 0;
        this.consecutiveFailures = 0;
        this.stopped = false;
        this.effectiveMode = this.captureMode === MODE_AUTO ? MODE_RAW : this.captureMode;
        this.fallbackCount = 0;      // raw 失败降级 PNG 的次数
        this.lastReadRetries = 0;
        this.frameTimes = [];        // 最近发布帧的时间戳
    }

    configure(options = {}) {
        if (options.adb) this.adb = options.adb;
        if (Number.isFinite(options.quality)) this.quality = clampInt(options.quality, this.quality, 10, 95);
        if (Number.isFinite(options.intervalMs)) this.intervalMs = clampInt(options.intervalMs, this.intervalMs, 20, 5000);
        if (Number.isFinite(options.maxWidth)) this.maxWidth = clampInt(options.maxWidth, this.maxWidth, 180, 2160);
        if (typeof options.format === 'string') this.format = options.format === 'png' ? 'png' : 'jpeg';
        if (typeof options.captureMode === 'string') {
            this.captureMode = normalizeMode(options.captureMode);
            this.effectiveMode = this.captureMode === MODE_AUTO ? MODE_RAW : this.captureMode;
        }
    }

    invalidateSelection() {
        this.generation += 1;
        this.inFlight = null;
        this.latest = null;
        this.frameTimes = [];
        this.effectiveMode = this.captureMode === MODE_AUTO ? MODE_RAW : this.captureMode;
        this.fallbackCount = 0;
        this.lastReadRetries = 0;
        this.lastError = null;
        this.lastDurationMs = 0;
        this.consecutiveFailures = 0;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }


    requireSharp() {
        if (this.sharp) return this.sharp;
        try {
            // eslint-disable-next-line global-require
            this.sharp = require('sharp');
            return this.sharp;
        } catch {
            throw new Error('缺少 sharp 依赖，无法缩放/重编码画面。请安装 sharp 或把 STREAM_FORMAT 设为 png。');
        }
    }

    /**
     * 采集一帧。单飞语义：并发调用共享同一个 Promise。
     *
     * 这条规则不能因为改成流水线就丢 —— 一次性请求（HTTP /frame）和
     * 推送循环会同时调这里，不单飞就会让 adb 请求成倍堆积。
     */
    capture() {
        if (this.stopped) return Promise.reject(new Error('FrameHub 已停止。'));
        if (!this.adb) return Promise.reject(new Error('FrameHub 尚未绑定 AdbClient。'));
        if (this.inFlight) return this.inFlight;

        const startedAt = Date.now();
        const generation = this.generation;
        const options = { serial: this.adb.serial ?? '', generation };
        const flight = (async () => {
            try {
                const frame = await this._captureOnce(options);
                if (generation !== this.generation || this.stopped) return frame;
                this.lastDurationMs = Date.now() - startedAt;
                this.lastError = null;
                this.consecutiveFailures = 0;
                return frame;
            } catch (error) {
                if (generation !== this.generation || this.stopped) throw error;
                this.lastError = { message: error.message, code: error.code || null, at: Date.now() };
                this.consecutiveFailures += 1;
                if (!this.stopped) this.emit('frame-error', this.lastError);
                throw error;
            }
        })().finally(() => {
            if (this.inFlight === flight) this.inFlight = null;
        });
        this.inFlight = flight;
        return this._trackCapture(flight);
    }

    _trackCapture(operation) {
        this.pendingCaptures.add(operation);
        operation.finally(() => this.pendingCaptures.delete(operation)).catch(() => {});
        return operation;
    }

    /** 单次采集：raw 优先，失败自动降级 PNG */
    async _captureOnce(options = {}) {
        if (this.effectiveMode === MODE_RAW) {
            try {
                return await this._captureRaw(options);
            } catch (error) {
                if (this.stopped || this.captureMode !== MODE_AUTO) throw error;
                // 有些设备/ROM 的 raw 输出格式不是 RGBA_8888，或直接不给 raw
                if (options.generation === this.generation && !this.stopped) {
                    this.fallbackCount += 1;
                    this.effectiveMode = MODE_PNG;
                }
                this.logger.warn?.(`[FrameHub] raw 采集失败，降级为 PNG：${error.message}`);
                return this._capturePng(options);
            }
        }
        return this._capturePng(options);
    }

    /**
     * 一次性采集：按调用方指定的分辨率/格式出帧，不写 this.latest、不广播事件。
     *
     * 为什么不直接改 this.maxWidth 再调 capture()：那会连带改变推流画质，
     * 而且 capture() 的 inFlight 单飞语义会把「1080 宽的截图请求」和
     * 「540 宽的推流帧」合成同一个 Promise，谁先到就返回谁的分辨率。
     * 也不复用 inFlight：参数不同，复用就是错。
     */
    async captureOneShot(options = {}) {
        if (this.stopped) throw new Error('FrameHub 已停止。');
        if (!this.adb) throw new Error('FrameHub 尚未绑定 AdbClient。');
        return this._trackCapture(this._captureOneShot(options));
    }

    async _captureOneShot(options) {
        const opts = { ...options, serial: options.serial ?? this.adb.serial ?? '', publish: false };
        if (this.effectiveMode === MODE_RAW) {
            try {
                return await this._captureRaw(opts);
            } catch (error) {
                if (this.stopped || this.captureMode !== MODE_AUTO) throw error;
                return await this._capturePng(opts);
            }
        }
        return await this._capturePng(opts);
    }

    /** raw 采集：跳过设备端 PNG 编码，短读重试以保证像素字节完整。 */
    async _captureRaw(options = {}) {
        const generation = options.generation ?? this.generation;
        const maxWidth = clampInt(options.maxWidth, this.maxWidth, 180, 4320);
        const format = options.format === 'png' ? 'png' : options.format === 'jpeg' ? 'jpeg' : this.format;
        const quality = clampInt(options.quality, this.quality, 10, 95);
        const publish = options.publish !== false;
        let lastShortfall = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (this.stopped) throw new Error('FrameHub 已停止。');
            if (generation === this.generation && !this.stopped) this.lastReadRetries = attempt;
            const raw = await this.adb.execOutBinary(
                ['exec-out', 'screencap'],
                { serial: options.serial, timeoutMs: 20000, maxBuffer: 64 * 1024 * 1024 },
            );

            if (!Buffer.isBuffer(raw) || raw.length < RAW_HEADER_BYTES) {
                throw new Error('screencap raw 返回数据过短：设备可能锁屏，或该 ROM 屏蔽了截图。');
            }

            const width = raw.readUInt32LE(0);
            const height = raw.readUInt32LE(4);
            const pixelFormat = raw.readUInt32LE(8);

            if (!width || !height || width > 20000 || height > 20000) {
                throw new Error(`screencap raw 头部异常：${width}×${height}`);
            }
            if (pixelFormat !== PIXEL_FORMAT_RGBA_8888) {
                throw new Error(`不支持的 raw 像素格式 0x${pixelFormat.toString(16)}`);
            }

            const expected = RAW_HEADER_BYTES + width * height * 4;
            if (raw.length < expected) {
                lastShortfall = expected - raw.length;
                continue;   // 短读，重试
            }

            const pixels = raw.subarray(RAW_HEADER_BYTES, expected);

            // 只要像素不要编码：调用方（视觉通道）还要裁剪/缩放/重新编码，
            // 走 PNG 等于「编码一次再解码一次」，实测白耗 ~110ms。
            if (options.raw === true) {
                return {
                    raw: { data: pixels, width, height, channels: 4 },
                    width,
                    height,
                    capturedAt: Date.now(),
                    source: 'raw-pixels',
                };
            }

            const sharp = this.requireSharp();
            let pipeline = sharp(pixels, {
                raw: { width, height, channels: 4 },
                failOn: 'none',
            });

            // 丢掉 alpha：Android 的 raw 第 4 通道不可靠，留着会让 JPEG 偏色
            pipeline = pipeline.removeAlpha();

            let outWidth = width;
            let outHeight = height;
            if (outWidth > maxWidth) {
                outHeight = Math.round(height * (maxWidth / width));
                outWidth = maxWidth;
                pipeline = pipeline.resize({ width: outWidth, withoutEnlargement: true });
            }

            let buffer;
            let mime;
            if (format === 'jpeg') {
                buffer = await pipeline.jpeg({ quality, mozjpeg: false }).toBuffer();
                mime = 'image/jpeg';
            } else {
                buffer = await pipeline.png({ compressionLevel: 3 }).toBuffer();
                mime = 'image/png';
            }

            if (!buffer || buffer.length < 64) {
                throw new Error('编码输出为空，画面可能全黑。');
            }

            this.seq += 1;
            const frame = {
                buffer,
                mime,
                width: outWidth,
                height: outHeight,
                capturedAt: Date.now(),
                seq: this.seq,
                byteLength: buffer.length,
                source: 'raw',
            };
            if (publish) this._publishFrame(frame, generation);
            return frame;
        }

        throw new Error(`screencap raw 连续短读 ${lastShortfall} 字节，放弃本帧。`);
    }

    /** PNG 采集：兼容性最好，但设备端编码慢（2.4 秒） */
    async _capturePng(options = {}) {
        if (this.stopped) throw new Error('FrameHub 已停止。');
        const generation = options.generation ?? this.generation;
        const maxWidth = clampInt(options.maxWidth, this.maxWidth, 180, 4320);
        const format = options.format === 'png' ? 'png' : options.format === 'jpeg' ? 'jpeg' : this.format;
        const quality = clampInt(options.quality, this.quality, 10, 95);
        const publish = options.publish !== false;
        const png = await this.adb.execOutBinary(
            ['exec-out', 'screencap', '-p'],
            { serial: options.serial, timeoutMs: 20000, maxBuffer: 64 * 1024 * 1024 },
        );
        if (!Buffer.isBuffer(png) || png.length < 64) {
            throw new Error('screencap 返回空数据：设备可能锁屏、正在录屏，或该 ROM 屏蔽了截图。');
        }

        const sharp = this.requireSharp();
        let pipeline = sharp(png, { failOn: 'none' });
        const meta = await pipeline.metadata();
        let width = meta.width || null;
        let height = meta.height || null;

        if (width && width > maxWidth) {
            height = height ? Math.round(height * (maxWidth / width)) : height;
            width = maxWidth;
            pipeline = pipeline.resize({ width, withoutEnlargement: true });
        }

        let buffer;
        let mime;
        if (format === 'jpeg') {
            buffer = await pipeline.jpeg({ quality, mozjpeg: false }).toBuffer();
            mime = 'image/jpeg';
        } else {
            buffer = await pipeline.png({ compressionLevel: 3 }).toBuffer();
            mime = 'image/png';
        }

        this.seq += 1;
        const frame = {
            buffer,
            mime,
            width,
            height,
            capturedAt: Date.now(),
            seq: this.seq,
            byteLength: buffer.length,
            source: 'png',
        };
        if (publish) this._publishFrame(frame, generation);
        return frame;
    }

    latestOrNull() {
        return this.latest;
    }

    subscribe(sink) {
        this.subscribers.add(sink);
        this.idleSince = 0;
        this.ensureLoop();
        return () => {
            this.subscribers.delete(sink);
            if (this.subscribers.size === 0) this.idleSince = Date.now();
        };
    }

    ensureLoop() {
        if (this.stopped || this.timer || this.retryTimer) return;
        if (this.subscribers.size === 0) return;
        this.timer = setInterval(() => { void this._pump(); }, this.intervalMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        void this._pump();
    }

    /** 单路驱动：循环与 HTTP 请求共享 capture() 的在途 Promise。 */
    _pump() {
        if (this.stopped) return;
        if (this.subscribers.size === 0) {
            if (this.idleSince && Date.now() - this.idleSince > this.idleGraceMs) {
                this.pauseLoop();
            }
            return;
        }
        if (this.inFlight || this.retryTimer) return;

        const generation = this.generation;
        this.capture()
            .then((frame) => {
                if (this.stopped || generation !== this.generation || (this.latest && frame.seq < this.latest.seq)) return;
                for (const sink of this.subscribers) {
                    if (this.stopped || generation !== this.generation) break;
                    try {
                        sink(frame);
                    } catch {
                        // 单个订阅者发送失败不应影响其他人
                    }
                }
            })
            .catch(() => {
                if (this.stopped || generation !== this.generation || this.consecutiveFailures < 5) return;
                this.pauseLoop();
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    this.ensureLoop();
                }, Math.min(10000, 500 * this.consecutiveFailures));
                if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
            });
    }

    _publishFrame(frame, generation) {
        if (this.stopped || generation !== this.generation) return;
        this.latest = frame;
        this.frameTimes.push(Date.now());
        if (this.frameTimes.length > 20) this.frameTimes.shift();
        this.emit('frame', frame);
    }

    pauseLoop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    stop() {
        this.stopped = true;
        this.pauseLoop();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.subscribers.clear();
        this.latest = null;
        return Promise.allSettled([...this.pendingCaptures]).then(() => undefined);
    }

    /** 实测有效帧率：最近发布帧之间的实际时间间隔。 */
    effectiveFps() {
        if (this.frameTimes.length < 2) return 0;
        const elapsed = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
        return elapsed > 0 ? (this.frameTimes.length - 1) * 1000 / elapsed : 0;
    }

    status() {
        return {
            streaming: Boolean(this.timer),
            subscribers: this.subscribers.size,
            seq: this.seq,
            latestAgeMs: this.latest ? Date.now() - this.latest.capturedAt : null,
            lastDurationMs: this.lastDurationMs,
            byteLength: this.latest ? this.latest.byteLength : null,
            format: this.format,
            quality: this.quality,
            intervalMs: this.intervalMs,
            captureMode: this.effectiveMode,
            configuredMode: this.captureMode,
            fallbackCount: this.fallbackCount,
            lastReadRetries: this.lastReadRetries,
            effectiveFps: Number(this.effectiveFps().toFixed(2)),
            consecutiveFailures: this.consecutiveFailures,
            lastError: this.lastError,
        };
    }
}

function normalizeMode(value) {
    const text = String(value ?? '').toLowerCase();
    if (text === MODE_RAW) return MODE_RAW;
    if (text === MODE_PNG) return MODE_PNG;
    return MODE_AUTO;
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

module.exports = {
    DEFAULT_IDLE_GRACE_MS,
    DEFAULT_INTERVAL_MS,
    DEFAULT_QUALITY,
    FrameHub,
    clampInt,
    normalizeMode,
};
