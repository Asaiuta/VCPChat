'use strict';

/**
 * scrcpy 视频流采集。
 *
 * 为什么不用 screencap：
 *   screencap 每帧 1219ms（raw 17.4MB），设备端编码/传输都是瓶颈，
 *   实测天花板 0.8 fps。而 scrcpy 用设备硬件编码器输出 H.264，
 *   实测 10.9 fps、每帧 2.5KB、227kbps —— 帧率 13× 提升，流量降到 1/7000。
 *
 * 协议（官方 doc/develop.md）：
 *   握手： dummy(1) + 设备名(64) + codec(4)
 *   会话包(12)：flag(1) + padding(3) + width(4) + height(4)
 *   媒体包：    pts(8, 大端) + size(4, 大端) + payload
 *
 *   pts 高 3 位是标志：
 *     bit7 = 会话包（旋转/尺寸变更时重发）
 *     bit6 = config 包（SPS/PPS）
 *     bit5 = 关键帧
 *
 * 生命周期：一个设备一个实例。start() 推 jar → 建转发 → 起 server → 连流。
 */

const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { randomInt } = require('crypto');

// scrcpy scid is a 31-bit integer. Never reuse one within this process.
let nextScid = randomInt(0x80000000);
let allocatedScids = 0;
function allocateScid() {
    if (allocatedScids === 0x80000000) throw new Error('scrcpy 会话编号已耗尽');
    allocatedScids += 1;
    const scid = nextScid.toString(16).padStart(8, '0');

    nextScid = (nextScid + 1) % 0x80000000;
    return scid;
}

const SERVER_VERSION = '5.0.1';
const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
// 随插件分发（vendor/ 与 lib/ 同级）
const LOCAL_JAR = path.join(__dirname, '..', 'vendor', `scrcpy-server-v${SERVER_VERSION}`);

const FLAG_SESSION = 0x80;
const FLAG_CONFIG = 0x40;
const FLAG_KEYFRAME = 0x20;
const PTS_MASK = 0x1fffffff;

const STATE_IDLE = 'idle';
const STATE_STARTING = 'starting';
const STATE_STREAMING = 'streaming';
const STATE_STOPPED = 'stopped';
const STATE_ERROR = 'error';

/**
 * 从 SPS 里读 profile/constraint/level 拼 WebCodecs 需要的 codec 串。
 *
 * 不需要完整 exp-golomb 解析：profile_idc、约束标志、level_idc 就是
 * NAL 头之后的前 3 个字节。findSps() 正好返回这 3 个字节。
 */
function codecStringFromSps(spsNal) {
    if (!spsNal || spsNal.length < 3) return null;
    const profile = spsNal[0];
    const constraints = spsNal[1];
    const level = spsNal[2];
    const hex = (b) => b.toString(16).padStart(2, '0');
    return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
}

/** 在 Annex-B 字节流里找第一个 SPS（NAL type 7） */
function findSps(buffer) {
    for (let i = 0; i + 4 < buffer.length; i += 1) {
        // 起始码 00 00 01 或 00 00 00 01
        let headerAt = -1;
        if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) headerAt = i + 3;
        else if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === 1) headerAt = i + 4;
        if (headerAt < 0) continue;
        if ((buffer[headerAt] & 0x1f) === 7) {
            // SPS 内容从 NAL 头之后开始
            return buffer.subarray(headerAt + 1, headerAt + 4);
        }
    }
    return null;
}

class ScrcpyHub {
    constructor(options = {}) {
        this.adbPath = options.adbPath;
        this.serial = options.serial;
        this._requestedSerial = options.serial;
        this.logger = options.logger || console;

        this.maxSize = clampInt(options.maxSize, 540, 180, 2160);
        this.bitRate = clampInt(options.bitRate, 2000000, 100000, 50000000);
        this.maxFps = clampInt(options.maxFps, 30, 1, 120);

        // 就绪等待。旧实现是 `setTimeout(resolve, 1800)` 盲等，无出处。
        // 真机实测（PJZ110，2026-11-02，3 轮）：
        //   adb forward 后本地 TCP 在 145–209ms 就能连上，但那是 forward 的
        //   监听 socket；此时连接会在 93–108ms 被立即 reset，收到 0 字节。
        //   设备端 abstract socket（/proc/net/unix 的 scrcpy_<scid>）在
        //   482–733ms 出现，握手字节在 923–1056ms 到达。
        // 所以判据改成「设备端 socket 是否出现」，用轮询替代盲等。
        this.readyPollMs = clampInt(options.readyPollMs, 100, 10, 1000);
        // 0 表示显式关闭轮询（单测用），只做一次查询后直接进入连接。
        this.readyDeadlineMs = Number.isFinite(options.readyDeadlineMs)
            ? Math.max(0, options.readyDeadlineMs) : 4000;
        this.readyPolls = 0;   // 观测用：本轮启动查询了几次

        this.state = STATE_IDLE;
        this.serverProc = null;
        this.socket = null;
        this.localPort = null;
        this.subscribers = new Set();

        this.seq = 0;
        this.codec = null;
        this.width = null;
        this.height = null;
        this.codecString = null;
        this.sps = null;

        this.lastError = null;
        this.startedAt = 0;
        this.packetsReceived = 0;
        this.bytesReceived = 0;
        this.lastPacketAt = 0;
        this.frameTimes = [];
        this.stopping = false;
        this.startPromise = null;
        this.stopPromise = null;
        this.cleanupPromise = null;
        this._generation = 0;
        this._serverSession = null;

        // ---- 新订阅者补发用的缓存 ----
        // SPS/PPS 只在流启动时发一次；之后才连上的客户端收不到就永远黑屏。
        // 关键帧同理：不留最近一个 IDR，新客户端要等下一个（约 10 秒）才出画。
        this.lastConfig = null;
        this.lastSession = null;
        this.lastKeyFrame = null;

        this._parser = null;
    }

    /** 选一个空闲本地端口给 adb forward 用 */
    static async findFreePort() {
        return new Promise((resolve, reject) => {
            const probe = net.createServer();
            probe.once('error', reject);
            probe.listen(0, '127.0.0.1', () => {
                const { port } = probe.address();
                probe.close(() => resolve(port));
            });
        });
    }

    _adb(args, timeoutMs = 20000, serial = this.serial) {
        return new Promise((resolve) => {
            execFile(this.adbPath, ['-s', serial, ...args], {
                timeout: timeoutMs,
                windowsHide: true,
                maxBuffer: 8 * 1024 * 1024,
            }, (error, stdout, stderr) => {
                resolve({ ok: !error, stdout: stdout || '', stderr: stderr || (error ? error.message : '') });
            });
        });
    }

    async _ensureJar() {
        const check = await this._adb(['shell', `[ -f ${REMOTE_JAR} ] && echo PRESENT`]);
        if (check.stdout.includes('PRESENT')) return;

        if (!fs.existsSync(LOCAL_JAR)) {
            throw new Error(`缺少 scrcpy server 文件：${LOCAL_JAR}。请重新获取插件资源。`);
        }
        const pushed = await this._adb(['push', LOCAL_JAR, REMOTE_JAR], 60000);
        if (!pushed.ok) throw new Error(`推送 scrcpy server 失败：${pushed.stderr.trim()}`);
    }

    /**
     * 解析目标设备：优先用构造时给的 serial，否则取当前第一台已授权设备。
     * 每次 start 都重新解析，插拔/重连后不用手工同步。
     */
    async _resolveSerial() {
        const listed = await this._adbListDevices();
        if (this._requestedSerial) {
            const ready = listed.some((d) => d.serial === this._requestedSerial && d.state === 'device');
            if (!ready) throw new Error(`指定设备 ${this._requestedSerial} 不可用（未连接或未授权）`);
            this.serial = this._requestedSerial;
            return this.serial;
        }
        const picked = listed.find((d) => d.state === 'device');
        if (!picked) {
            throw new Error('没有已连接的设备。请先连接手机（无线调试），再打开画面。');
        }
        this.serial = picked.serial;
        return this.serial;
    }

    async _adbListDevices() {
        const result = await new Promise((resolve) => {
            execFile(this.adbPath, ['devices'], { timeout: 10000, windowsHide: true }, (error, stdout) => {
                resolve(stdout || '');
            });
        });
        const devices = [];
        for (const line of result.split(/\r?\n/)) {
            const match = /^(\S+)\s+(\S+)/.exec(line.trim());
            if (!match || match[1] === 'List') continue;
            devices.push({ serial: match[1], state: match[2] });
        }
        return devices;
    }

    start() {
        if (this.stopPromise) return this.stopPromise.then(() => this.start());
        if (this.cleanupPromise) return this.cleanupPromise.then(() => this.start());
        if (this.startPromise) return this.startPromise;
        if (this.state === STATE_STREAMING) return Promise.resolve(this.status());

        const generation = ++this._generation;
        this._resetSession();
        this.stopping = false;
        this.state = STATE_STARTING;
        this.startedAt = Date.now();
        this.lastError = null;
        this.startPromise = this._start(generation).finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    _resetSession() {
        this.seq = 0;
        this.codec = null;
        this.width = null;
        this.height = null;
        this.codecString = null;
        this.sps = null;
        this.startedAt = 0;
        this.packetsReceived = 0;
        this.bytesReceived = 0;
        this.lastPacketAt = 0;
        this.frameTimes = [];
        this.lastConfig = null;
        this.lastSession = null;
        this.lastKeyFrame = null;
        this._parser = null;
    }

    _checkGeneration(generation) {
        if (generation !== this._generation) throw new Error('scrcpy 启动已取消');
    }

    async _start(generation) {
        try {
            if (this.socket || this.serverProc || this.localPort) {
                await this._cleanup();
                this._checkGeneration(generation);
            }
            await this._resolveSerial();
            this._checkGeneration(generation);
            await this._ensureJar();
            this._checkGeneration(generation);

            this._serverSession = { generation, serial: this.serial, scid: allocateScid(), spawned: false };
            this.localPort = await ScrcpyHub.findFreePort();
            this._checkGeneration(generation);
            const fwd = await this._adb(['forward', `tcp:${this.localPort}`, `localabstract:scrcpy_${this._serverSession.scid}`]);
            this._checkGeneration(generation);
            if (!fwd.ok) throw new Error(`建立端口转发失败：${fwd.stderr.trim()}`);

            this._spawnServer();
            await this._waitForRemoteSocket(generation);
            this._checkGeneration(generation);
            await this._connect();
            this._checkGeneration(generation);
            if (this.state === STATE_ERROR) throw new Error(this.lastError.message);
            this.state = STATE_STREAMING;
            this.logger.log?.(`[ScrcpyHub] 已开流 ${this.serial} → 127.0.0.1:${this.localPort}`);
            return this.status();
        } catch (error) {
            if (generation === this._generation) {
                this.state = STATE_ERROR;
                this.lastError = { message: error.message, at: Date.now() };
                await this._cleanup(generation);
            }
            throw error;
        }
    }

    _spawnServer() {
        const session = this._serverSession;
        if (!session || session.generation !== this._generation) throw new Error('scrcpy 会话已失效');
        const args = [
            'shell',
            `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${SERVER_VERSION}`
            + ` scid=${session.scid} log_level=warn max_size=${this.maxSize} video_bit_rate=${this.bitRate}`
            + ` max_fps=${this.maxFps} tunnel_forward=true audio=false control=false cleanup=false`,
        ];

        this.serverProc = spawn(this.adbPath, ['-s', this.serial, ...args], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        session.spawned = true;
        const proc = this.serverProc;
        const generation = this._generation;
        const current = () => generation === this._generation && this.serverProc === proc;
        this.serverProc.stdout.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text) this.logger.log?.(`[ScrcpyHub] ${text}`);
        });
        this.serverProc.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text) this.logger.warn?.(`[ScrcpyHub] ${text}`);
        });
        this.serverProc.on('exit', (code) => {
            if (this.stopping || !current()) return;
            this.state = STATE_ERROR;
            this.lastError = { message: `scrcpy server 退出（code=${code}）`, at: Date.now() };
            this.emit_('closed');
        });
        proc.on('error', (error) => {
            if (this.stopping || !current()) return;
            this.state = STATE_ERROR;
            this.lastError = { message: error.message, at: Date.now() };
            this.emit_('closed');
        });
    }

    /**
     * 等设备端 abstract socket 出现。
     *
     * 为什么不能只等本地 TCP 可连：`adb forward` 的本地监听在服务起来之前
     * 就已经能 accept，连接会在 ~100ms 内被 reset。那条路径不是就绪信号。
     *
     * 查询只是加速手段，不是正确性的必要条件：查不到就把预算耗完，交给
     * 后续 _connect 的握手超时兜底。早期设备或权限受限时 cat 可能失败，
     * 此时降级为「按预算等待」，行为不比旧的盲等更差。
     */
    async _waitForRemoteSocket(generation) {
        this.readyPolls = 0;
        const scid = this._serverSession?.scid;
        if (!scid || this.readyDeadlineMs <= 0) return;

        const deadline = Date.now() + this.readyDeadlineMs;
        const pattern = `scrcpy_${scid}`;
        do {
            this._checkGeneration(generation);
            this.readyPolls += 1;
            // grep -c 只回一个数字，避免把整个 /proc/net/unix 拖回来。
            const probe = await this._adb(
                ['shell', `cat /proc/net/unix 2>/dev/null | grep -c ${pattern}`],
                8000,
            ).catch(() => null);
            if (probe?.ok && Number(String(probe.stdout).trim()) > 0) return;
            if (Date.now() >= deadline) return;
            await new Promise((resolve) => setTimeout(resolve, this.readyPollMs));
        } while (Date.now() < deadline);
    }

    _connect() {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: '127.0.0.1', port: this.localPort });
            const generation = this._generation;
            this.socket = socket;
            const current = () => generation === this._generation && this.socket === socket;
            socket.setNoDelay(true);   // 低延迟：禁用 Nagle 攒包

            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error('连接 scrcpy 流超时'));
            }, 10000);

            socket.once('connect', () => {
                clearTimeout(timeout);
                if (!current()) {
                    socket.destroy();
                    reject(new Error('scrcpy 启动已取消'));
                    return;
                }
                this._parser = new StreamParser({
                    onHandshake: (info) => {
                        this.codec = info.codec;
                        this.width = info.width;
                        this.height = info.height;
                        this.codecString = info.codecString;
                        this.sps = info.sps;
                    },
                    onConfig: (payload) => {
                        const sps = findSps(payload);
                        if (sps) {
                            this.sps = Buffer.from(sps);
                            this.codecString = codecStringFromSps(sps) || this.codecString;
                        }
                        this._emitPacket({ type: 'config', data: payload, pts: 0, key: false });
                    },
                    onFrame: (payload, pts, key) => {
                        this._emitPacket({ type: 'frame', data: payload, pts, key });
                    },
                    onSession: (width, height) => {
                        this.width = width;
                        this.height = height;
                        this.logger.log?.(`[ScrcpyHub] 画面尺寸变更为 ${width}×${height}`);
                        this._emitPacket({ type: 'session', data: null, width, height, pts: 0, key: false });
                    },
                });
                socket.on('data', (chunk) => { if (current()) this._onData(chunk); });
                resolve();
            });

            socket.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
            socket.on('close', () => {
                clearTimeout(timeout);
                reject(new Error('scrcpy 流断开'));
                if (!this.stopping && current()) {
                    this.state = STATE_ERROR;
                    this.lastError = { message: 'scrcpy 流断开', at: Date.now() };
                    this._emitPacket({ type: 'closed', data: null, pts: 0, key: false });
                }
            });
        });
    }

    _onData(chunk) {
        this.bytesReceived += chunk.length;
        try {
            this._parser.push(chunk);
        } catch (error) {
            this.lastError = { message: `流解析失败：${error.message}`, at: Date.now() };
            this.logger.warn?.(`[ScrcpyHub] ${this.lastError.message}`);
            this.socket?.destroy();
        }
    }

    _emitPacket(packet) {
        if (packet.type === 'frame') {
            this.seq += 1;
            packet.seq = this.seq;
            this.packetsReceived += 1;
            this.lastPacketAt = Date.now();
            this.frameTimes.push(this.lastPacketAt);
            if (this.frameTimes.length > 60) this.frameTimes.shift();
            // 只留最近的 IDR：新订阅者靠它立刻出画，不用等下一个（约 10 秒）
            if (packet.key) this.lastKeyFrame = packet;
        } else if (packet.type === 'config') {
            this.packetsReceived += 1;
            this.lastConfig = packet;
        } else if (packet.type === 'session') {
            this.lastSession = packet;
        }

        for (const sink of this.subscribers) {
            try {
                sink(packet);
            } catch {
                // 单个订阅者出错不能拖垮整条流
            }
        }
    }

    /**
     * 把「开始一条新流时应发的东西」按顺序补发给一个回调。
     *
     * 顺序必须是 session → config → keyframe：
     * 页面先知道尺寸才能建解码器，再有 SPS/PPS 才能 configure，最后有关键帧才出画。
     * 没有缓存的部分直接跳过（例如流刚启动还没收到 config）。
     */
    replayInitTo(sink) {
        if (!sink) return 0;
        let sent = 0;
        for (const packet of [this.lastSession, this.lastConfig, this.lastKeyFrame]) {
            if (!packet) continue;
            try {
                sink(packet);
                sent += 1;
            } catch {
                // 补发失败不影响实时流
            }
        }
        return sent;
    }

    emit_(event) {
        for (const sink of this.subscribers) {
            try {
                sink({ type: event, data: null, pts: 0, key: false });
            } catch { /* 忽略 */ }
        }
    }

    /**
     * 底层连接是否还活着。
     *
     * 用户看静止画面时 scrcpy 不发帧，靠「有没有新包」判断会误判。
     * 这里看的是 TCP 本身：socket 存在、未销毁、没被对端关闭。
     */
    isSocketAlive() {
        const socket = this.socket;
        if (!socket) return false;
        if (socket.destroyed) return false;
        if (socket.readableEnded) return false;
        return true;
    }

    subscribe(sink) {
        this.subscribers.add(sink);
        return () => { this.subscribers.delete(sink); };
    }

    /** 运行期调整参数。只影响下一次 start()，不会中断当前流。 */
    configure(options = {}) {
        if (Object.hasOwn(options, 'serial')) this._requestedSerial = options.serial;
        if (Number.isFinite(options.maxSize)) this.maxSize = clampInt(options.maxSize, this.maxSize, 180, 2160);
        if (Number.isFinite(options.bitRate)) this.bitRate = clampInt(options.bitRate, this.bitRate, 100000, 50000000);
        if (Number.isFinite(options.maxFps)) this.maxFps = clampInt(options.maxFps, this.maxFps, 1, 120);
    }

    /** 实测 fps：用最近包的到达时间反推 */
    effectiveFps() {
        if (this.frameTimes.length < 2) return 0;
        const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
        if (span <= 0) return 0;
        return ((this.frameTimes.length - 1) / span) * 1000;
    }

    stop() {

        if (this.stopPromise) return this.stopPromise;
        ++this._generation;
        this._resetSession();
        this.stopping = true;
        this.state = STATE_STOPPED;
        this.stopPromise = (async () => {
            await this.startPromise?.catch(() => {});
            await this.cleanupPromise?.catch(() => {});
            await this._cleanup();
        })().finally(() => { this.stopPromise = null; });
        return this.stopPromise;
    }

    async failStartup(error, generation = this._generation) {
        if (generation !== this._generation || this.stopping) return;
        if (this.cleanupPromise) return this.cleanupPromise;
        this.state = STATE_ERROR;
        this.lastError = { message: error.message, at: Date.now() };
        this.cleanupPromise = Promise.resolve().then(() => this._cleanup()).finally(() => {
            this.cleanupPromise = null;
        });
        return this.cleanupPromise;
    }

    async _cleanup(generation = this._generation) {
        if (generation !== this._generation) return;
        const session = this._serverSession;
        this._serverSession = null;
        const socket = this.socket;
        const proc = this.serverProc;
        const port = this.localPort;
        this.socket = null;
        this.serverProc = null;
        this.localPort = null;
        this._parser = null;
        try { socket?.destroy(); } catch { /* 忽略 */ }
        try { proc?.kill(); } catch { /* 忽略 */ }

        // Match only this server's exact scid token. [c] excludes the pkill shell itself.
        if (session?.spawned) {
            const pattern = `[c]om[.]genymobile[.]scrcpy[.]Server .* scid=${session.scid}( |$)`;
            try { await this._adb(['shell', `pkill -f '${pattern}' 2>/dev/null; true`], 8000, session.serial); } catch { /* 忽略 */ }
        }
        if (port) {
            try { await this._adb(['forward', '--remove', `tcp:${port}`], 8000, session?.serial || this.serial); } catch { /* 忽略 */ }
        }
    }

    status() {
        return {
            state: this.state,
            serial: this.serial,
            codec: this.codec,
            codecString: this.codecString,
            width: this.width,
            height: this.height,
            subscribers: this.subscribers.size,
            packetsReceived: this.packetsReceived,
            bytesReceived: this.bytesReceived,
            seq: this.seq,
            effectiveFps: Number(this.effectiveFps().toFixed(2)),
            lastPacketAgeMs: this.lastPacketAt ? Date.now() - this.lastPacketAt : null,
            maxSize: this.maxSize,
            bitRate: this.bitRate,
            maxFps: this.maxFps,
            lastError: this.lastError,
            uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
        };
    }
}

/**
 * 流解析状态机。
 *
 * 分三个区：握手 → 会话包 → 媒体包。会话包在旋转时会再次出现，
 * 所以不能当成一次性状态。
 */
class StreamParser {
    constructor(handlers) {
        this.handlers = handlers;
        this.buffer = Buffer.alloc(0);
        this.stage = 'dummy';
        this.codec = null;
        this.width = null;
        this.height = null;
        this.codecString = null;
    }

    push(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        this._drain();
    }

    _drain() {
        let guard = 0;
        while (guard < 1000) {
            guard += 1;

            if (this.stage === 'dummy') {
                if (this.buffer.length < 1) return;
                this.buffer = this.buffer.subarray(1);
                this.stage = 'name';
                continue;
            }

            if (this.stage === 'name') {
                if (this.buffer.length < 64) return;
                this.buffer = this.buffer.subarray(64);
                this.stage = 'codec';
                continue;
            }

            if (this.stage === 'codec') {
                if (this.buffer.length < 4) return;
                this.codec = `0x${this.buffer.readUInt32BE(0).toString(16)}`;
                this.buffer = this.buffer.subarray(4);
                this.stage = 'media';
                continue;
            }

            // media 区
            if (this.buffer.length < 12) return;

            const flagByte = this.buffer[0];
            const size = this.buffer.readUInt32BE(8);

            // 会话包：flag 最高位为 1
            if ((flagByte & FLAG_SESSION) !== 0) {
                if (this.buffer.length < 12) return;
                this.width = this.buffer.readUInt32BE(4);
                this.height = this.buffer.readUInt32BE(8);
                this.buffer = this.buffer.subarray(12);
                this.handlers.onSession?.(this.width, this.height);
                this.handlers.onHandshake?.({
                    codec: this.codec, width: this.width, height: this.height, codecString: this.codecString, sps: null,
                });
                continue;
            }

            if (size > 16 * 1024 * 1024) {
                throw new Error(`包尺寸异常 ${size}，流可能错位`);
            }
            if (this.buffer.length < 12 + size) return;

            // 标志位只存在于 pts 的最高字节的高 3 位。
            // 用 readUInt32BE 读出来的值再与 0x40 相与永远为 0 —— 陷阱。
            const ptsRaw = this.buffer.readBigUInt64BE(0);
            const isConfig = (flagByte & FLAG_CONFIG) !== 0;
            const isKey = (flagByte & FLAG_KEYFRAME) !== 0;
            // 低 61 位是 PTS（微秒）
            const pts = Number(ptsRaw & 0x1fffffffffffffffn) / 1000;

            const payload = this.buffer.subarray(12, 12 + size);
            this.buffer = this.buffer.subarray(12 + size);

            if (isConfig) {
                const sps = findSps(payload);
                if (sps) {
                    this.codecString = codecStringFromSps(sps) || this.codecString;
                }
                this.handlers.onConfig?.(payload);
            } else {
                this.handlers.onFrame?.(payload, pts, isKey);
            }
        }
    }
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

module.exports = {
    ScrcpyHub,
    StreamParser,
    codecStringFromSps,
    findSps,
    LOCAL_JAR,
    REMOTE_JAR,
    SERVER_VERSION,
};
