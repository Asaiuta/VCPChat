'use strict';

/**
 * 传输层：只负责「怎么够到设备端的 RPC 端点」，不管「往端点上发什么」。
 *
 * 当前 AdbTransport 使用 adb（USB 或无线调试）与电脑↔手机链路。
 * 传输接缝可复用，但普通 App UID 不继承 shell UiAutomation 的权限；已安装 App
 * 直连还需要设备端树、动作、截图后端及认证会话。只有新端点满足相同 RPC 语义、
 * 能力和 dispatched/drained 契约时，宿主会话层才可复用，不保证只改 start/stop。
 *
 * 契约（两种实现都必须满足）：
 *   start()  -> { ok:true } | { ok:false, reason }   不抛，调用方要能静默回退
 *   call()   -> Promise<result>                      失败抛 UiServerError，带 dispatched/drained
 *   stop()   -> Promise<void>                        幂等
 *   port / ready                                     当前端点与就绪状态
 *
 * 明确不属于这里：方法白名单、参数个数校验、能力记账、回退决策。
 * 那些在 ui-server.js 会话层，本层只保证「发出去的字节」与「收回来的响应」。
 */

const fs = require('fs');
const { execFile, spawn } = require('child_process');
const net = require('net');
const http = require('http');
const { createHash } = require('node:crypto');
const { UiServerError } = require('./ui-error');
const { RemoteOwner, AdbOwnerBackend } = require('./ui-owner');
const { vendorPath } = require('./vendor-path');

const VENDOR_APK = 'u2-server-0.5.0.apk';
const VENDOR_OWNER_JAR = 'vcp-ui-owner.jar';
const OWNER_CLASS = 'com.vcpchat.uiautomator.Owner';

const CONSOLE_CLASS = 'com.github.uiautomator2.Console';
const RPC_PATH = '/jsonrpc/0';

// dump 实测 p95 = 122ms。给 4s 是留足冷启动与树特别深时的余量，
// 又远小于旧路径 25s 的超时，卡死能被快速识别并回退。
const DEFAULT_RPC_TIMEOUT_MS = 4000;
const MAX_RPC_TIMEOUT_MS = 120000;
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;

// 实测从拉起进程到 ping 通 ~1s。15s 覆盖无线调试抖动与首次 dex 优化。
const DEFAULT_READY_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 200;

// 0 表示交给内核分配；其余是冲突时的退化候选。
const PORT_CANDIDATES = [0, 9008, 9009, 9010, 9011, 9012, 9013, 9014, 9015];

let rpcSeq = 0;

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function vendorApkPath() {
    return vendorPath(VENDOR_APK);
}

function rpcOptions(options, defaultTimeoutMs) {
    const invalid = (message) => new UiServerError('UI_SERVER_INVALID_ARGUMENT', message, { dispatched: false, drained: true });
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('RPC options must be an object');
    const timeoutMs = options.timeoutMs === undefined ? defaultTimeoutMs : options.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RPC_TIMEOUT_MS) {
        throw invalid(`timeoutMs must be an integer from 1 to ${MAX_RPC_TIMEOUT_MS}`);
    }
    const signal = options.signal;
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
        throw invalid('signal must be an AbortSignal');
    }
    return { timeoutMs, signal };
}

/**
 * 走本机 HTTP 到设备端 JSON-RPC 的传输基类。
 *
 * 子类只需提供端点（port 被填上）与 start/stop；收发的全部细节在这里，
 * 因为「HTTP + JSON-RPC 信封」是与通道无关的部分。
 */
class HttpRpcTransport {
    constructor(options = {}) {
        this.rpcTimeoutMs = Number.isFinite(options.rpcTimeoutMs)
            ? options.rpcTimeoutMs
            : DEFAULT_RPC_TIMEOUT_MS;
        // Endpoint readiness and generation have one source of truth.
        this.ready = false;
        this.port = null;
        this.logger = options.logger || null;
        this._generation = 0;
    }

    get generation() { return this._generation; }

    isReady() {
        return this.ready === true && Number.isInteger(this.port);
    }

    /** 由子类实现。基类不假设端点从哪来。 */
    async start() {
        return { ok: false, reason: '该传输没有实现 start()' };
    }

    async stop() {}

    /**
     * 发一条 RPC 并等响应。与 UiServer._rpc 分家前的行为逐字节一致。
     *
     * dispatched=false 表示本地拒绝或 JSON-RPC -32601/-32602；
     * dispatched=true 表示可能已经执行过，绝不能盲目重放。
     * drained=true 表示本次协议请求已无未完成响应，不代表设备空闲或远端owner已退出。
     */
    call(method, params, timeoutMs = this.rpcTimeoutMs, signal, deadline = Date.now() + timeoutMs) {
        return new Promise((resolve, reject) => {
            let dispatched = false;
            let drained = false;
            const failure = (code, message, details = {}) => new UiServerError(code, message, {
                dispatched, drained: !dispatched || drained, ...details,
            });
            if (!Number.isInteger(this.port)) {
                reject(failure('UI_SERVER_NOT_READY', 'UI 服务端口未分配'));
                return;
            }
            if (signal?.aborted) {
                reject(failure('UI_SERVER_ABORTED', `RPC ${method} 已取消`));
                return;
            }
            const id = String(++rpcSeq);
            let body;
            try {
                body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            } catch (error) {
                reject(failure('UI_SERVER_INVALID_ARGUMENT', `RPC 参数无法序列化：${error.message}`));
                return;
            }
            if (Date.now() >= deadline) {
                reject(failure('UI_SERVER_TIMEOUT', `RPC ${method} 超时（${timeoutMs}ms）`));
                return;
            }
            if (signal?.aborted) {
                reject(failure('UI_SERVER_ABORTED', `RPC ${method} 已取消`));
                return;
            }
            let settled = false;
            let timer = null;
            let req;
            let response;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                fn(value);
            };
            const fail = (code, message, details) => {
                finish(reject, failure(code, message, details));
                response?.destroy?.();
                req?.destroy();
            };
            const onAbort = () => fail('UI_SERVER_ABORTED', `RPC ${method} 已取消`);
            const checkBudget = () => {
                if (Date.now() < deadline) return true;
                fail('UI_SERVER_TIMEOUT', `RPC ${method} 超时（${timeoutMs}ms）`);
                return false;
            };
            try {
                req = http.request({
                    hostname: '127.0.0.1', port: this.port, path: RPC_PATH, method: 'POST',
                    // charset 不是可选项：不带它，设备端按 ISO-8859-1 解请求体、按 ASCII
                    // 编响应体，于是每个非 ASCII 字符按 UTF-8 字节裂成 U+FFFD。
                    // 真机实测（PJZ110）：`绫织` 无 charset 返回 6 个 U+FFFD；
                    // 加上 charset=utf-8 后原样往返（e7bbab e7bb87）。
                    // setText 把「绫织M1验收」写成 12 个 U+FFFD、setClipboard 写坏剪贴板，
                    // 都是这一个头的事，不是 ROM 不支持中文。
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Content-Length': Buffer.byteLength(body),
                    },
                }, (res) => {
                    response = res;
                    res.on('error', (error) => fail('UI_SERVER_RPC_FAILED', `RPC 响应失败：${error.message}`));
                    res.on('aborted', () => fail('UI_SERVER_RPC_FAILED', 'RPC 响应中断'));
                    res.on('close', () => {
                        if (!settled) fail('UI_SERVER_RPC_FAILED', 'RPC 响应未完整结束');
                    });
                    if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode >= 300) {
                        fail('UI_SERVER_HTTP_ERROR', `RPC HTTP ${res.statusCode}`, { statusCode: res.statusCode });
                        return;
                    }
                    const declaredBytes = Number(res.headers?.['content-length']);
                    if (declaredBytes > MAX_RPC_RESPONSE_BYTES) {
                        fail('UI_SERVER_RESPONSE_TOO_LARGE', 'RPC 响应超过 8 MiB');
                        return;
                    }
                    const chunks = [];
                    let bytes = 0;
                    res.on('data', (chunk) => {
                        if (settled) return;
                        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        bytes += data.length;
                        if (bytes > MAX_RPC_RESPONSE_BYTES) {
                            fail('UI_SERVER_RESPONSE_TOO_LARGE', 'RPC 响应超过 8 MiB');
                            return;
                        }
                        chunks.push(data);
                    });
                    res.on('end', () => {
                        if (settled) return;
                        let parsed;
                        try { parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch {
                            fail('UI_SERVER_BAD_JSON', `RPC 响应无法解析（${bytes}B）`);
                            return;
                        }
                        const own = (key) => Object.prototype.hasOwnProperty.call(parsed, key);
                        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
                            || parsed.jsonrpc !== '2.0' || parsed.id !== id || own('result') === own('error')) {
                            fail('UI_SERVER_BAD_RESPONSE', 'RPC 响应信封无效');
                            return;
                        }
                        if (own('error')) {
                            const error = parsed.error;
                            if (!error || typeof error !== 'object' || Array.isArray(error)
                                || !Number.isInteger(error.code) || typeof error.message !== 'string') {
                                fail('UI_SERVER_BAD_RESPONSE', 'RPC error 结构无效');
                                return;
                            }
                            drained = true;
                            fail('UI_SERVER_RPC_ERROR', `RPC ${method} 报错：${error.message.slice(0, 300)}`, {
                                rpcCode: error.code, dispatched: error.code !== -32601 && error.code !== -32602,
                            });
                            return;
                        }
                        drained = true;
                        if (!checkBudget()) return;
                        finish(resolve, parsed.result);
                    });
                });
                req.on('error', (error) => fail('UI_SERVER_RPC_FAILED', `RPC ${method} 连接失败：${error.message}`));
                signal?.addEventListener('abort', onAbort, { once: true });
                if (signal?.aborted) { onAbort(); return; }
                if (!checkBudget()) return;
                timer = setTimeout(() => fail('UI_SERVER_TIMEOUT', `RPC ${method} 超时（${timeoutMs}ms）`), deadline - Date.now());
                // Once write starts, a transport failure cannot establish non-execution.
                dispatched = true;
                req.write(body);
                req.end();
            } catch (error) {
                fail('UI_SERVER_RPC_FAILED', `RPC ${method} 连接失败：${error.message}`);
            }
        });
    }
}

/**
 * 现在唯一的实现：随包 APK 推到 /data/local/tmp，app_process 加载成常驻服务，
 * 再用 adb forward 把本机端口接到设备端口。
 *
 * 这是「adb 作为传输」的全部痕迹。换成已安装 App 自监听时，本类的
 * _ensureApk / _pickPort / _forward / _spawnServer / _waitReady 全部消失，
 * 只剩 start() 里等一个外部已经起好的端点。
 */
class AdbTransport extends HttpRpcTransport {
    constructor(options = {}) {
        super(options);
        this.adbPath = options.adbPath || 'adb';
        this.serial = options.serial;
        this.remoteApk = null;
        this.localApk = options.localApk || vendorApkPath();
        this.readyTimeoutMs = Number.isFinite(options.readyTimeoutMs)
            ? options.readyTimeoutMs
            : DEFAULT_READY_TIMEOUT_MS;
        this._proc = null;
        this._starting = null;
        this._stopping = null;
        this._carrierIdentity = null;
        this.localOwnerJar = options.localOwnerJar || vendorPath(VENDOR_OWNER_JAR);
        this.remoteOwnerJar = null;
        this.ownerCleanupTimeoutMs = Number.isInteger(options.ownerCleanupTimeoutMs) && options.ownerCleanupTimeoutMs > 0
            ? options.ownerCleanupTimeoutMs : 4000;
        this._owner = null;
        this._rpcForwardPort = null;
        this._ownerBackendFactory = options.ownerBackendFactory || (transport => new AdbOwnerBackend(transport));
    }

    get ownerIdentity() {
        const own = this._owner?.identity;
        return !own || own.status === 'released' ? (RemoteOwner.identityFor(this.serial) || own || null) : own;
    }

    quarantineOwner(reason = 'RPC_OUTCOME_UNKNOWN', generation = this.generation) {
        if (generation !== this.generation) return this.ownerIdentity;
        this.ready = false;
        return this._owner?.quarantine(reason) || this.ownerIdentity;
    }

    call(...args) {
        const generation = this.generation;
        const admitted = this.isReady();
        return super.call(...args).catch(cause => {
            if (admitted && cause.dispatched === true && cause.drained !== true) {
                this.quarantineOwner(cause.code || 'RPC_OUTCOME_UNKNOWN', generation);
            }
            throw cause;
        });
    }

    get carrierIdentity() {
        return this._carrierIdentity?.generation === this.generation ? this._carrierIdentity : null;
    }

    async start() {
        if (this._stopping) {
            await this._stopping;
            return this.start();
        }
        if (this.isReady()) return { ok: true, reused: true, port: this.port, carrier: this.carrierIdentity, owner: this.ownerIdentity };
        if (this._starting) return this._starting;
        const generation = ++this._generation;
        const starting = this._doStart(generation).finally(() => {
            if (this._starting === starting) this._starting = null;
        });
        this._starting = starting;
        return starting;
    }

    _assertGeneration(generation) {
        if (generation !== this._generation) {
            throw new UiServerError('UI_SERVER_STOPPED', 'UI 服务启动已被停止');
        }
        if (this._owner?.generation === generation && this._owner.status === 'quarantined') {
            throw new UiServerError('UI_SERVER_OWNER_QUARANTINED', 'owner 已失联或隔离');
        }
    }

    async _doStart(generation) {
        let port = null;
        let ready = false;
        let forwardOwned = false;
        let failure = null;
        try {
            // A dead adb client is not proof that its remote app_process exited.
            if (this._owner && this._owner.status !== 'released') {
                if (!this._owner.ownsLease) throw new UiServerError('UI_SERVER_OWNER_QUARANTINED', '设备 owner 由其他实例持有');
                const previous = await this._owner.release();
                if (previous.status !== 'released') throw new UiServerError('UI_SERVER_OWNER_QUARANTINED', '旧 owner 尚未确认消失');
            }
            const stalePort = this.port;
            this.ready = false;
            this.port = null;
            if (Number.isInteger(stalePort)) await this._releaseRpcForward(stalePort);
            this._assertGeneration(generation);
            this._owner = new RemoteOwner({ serial: this.serial, generation, backend: this._ownerBackendFactory(this) });
            await this._owner.prepare();
            this._assertGeneration(generation);
            await this._ensureApk(generation);
            this._assertGeneration(generation);
            port = await this._pickPort(generation);
            this._assertGeneration(generation);
            if (!port) throw new UiServerError('UI_SERVER_NO_PORT', '找不到可用本地端口');
            await this._forward(port);
            this._rpcForwardPort = port;
            forwardOwned = true;
            this._assertGeneration(generation);
            this.port = port;
            this._owner.begin(port);
            await this._owner.bind();
            this._assertGeneration(generation);
            const alive = await this._waitReady(generation);
            this._assertGeneration(generation);
            if (!alive) throw new UiServerError('UI_SERVER_NOT_READY', `服务在 ${this.readyTimeoutMs}ms 内未响应 ping`);
            await this._owner.bind();
            this._assertGeneration(generation);
            this.ready = true;
            ready = true;
        } catch (cause) {
            failure = cause;
        } finally {
            if (!ready) {
                this.ready = false;
                if (this._owner?.ownsLease) await this._owner.release();
                this._proc = null;
                if (this.port === port) this.port = null;
                if (forwardOwned) await this._releaseRpcForward(port);
            }
        }
        if (ready) return { ok: true, port, carrier: this.carrierIdentity, owner: this.ownerIdentity };
        return { ok: false, code: this.ownerIdentity?.quarantined ? 'UI_SERVER_OWNER_QUARANTINED'
            : (failure?.code || 'UI_SERVER_START_FAILED'), reason: failure?.message || 'owner 启动失败',
        carrier: this.carrierIdentity, owner: this.ownerIdentity };
    }

    async _ensureOwnerJar(generation) {
        const bytes = await fs.promises.readFile(this.localOwnerJar);
        this._assertGeneration(generation);
        const hash = createHash('sha256').update(bytes).digest('hex');
        this.remoteOwnerJar = `/data/local/tmp/vcp-owner-${hash}.jar`;
        const probe = async () => {
            const { stdout } = await this._exec(['shell', `if [ ! -f '${this.remoteOwnerJar}' ]; then echo ABSENT; else sha256sum '${this.remoteOwnerJar}' 2>/dev/null || echo UNREADABLE; fi`], 15000);
            this._assertGeneration(generation);
            return stdout.trim();
        };
        let output = await probe();
        const expected = () => {
            const match = /^([a-fA-F0-9]{64})[ \t]+\*?(\/data\/local\/tmp\/vcp-owner-[a-f0-9]{64}\.jar)$/.exec(output);
            return match?.[1].toLowerCase() === hash && match?.[2] === this.remoteOwnerJar;
        };
        if (!expected()) {
            // Only our content-addressed artifact, never another owner's classpath.
            await this._exec(['push', this.localOwnerJar, this.remoteOwnerJar], 120000);
            this._assertGeneration(generation);
            output = await probe();
        }
        if (!expected()) throw new UiServerError('UI_SERVER_OWNER_BOOTSTRAP_MISMATCH', 'owner bootstrap 无法核验');
    }

    async _probeApk(generation) {
        // The path contains only a fixed prefix and a locally computed SHA-256.
        const file = `'${this.remoteApk}'`;
        const { stdout } = await this._exec(['shell',
            `if [ ! -f ${file} ]; then echo ABSENT; else sha256sum ${file} 2>/dev/null || echo UNREADABLE; fi`], 15000);
        this._assertGeneration(generation);
        const output = stdout.trim();
        const match = /^([a-fA-F0-9]{64})[ \t]+\*?(\/data\/local\/tmp\/vcp-u2-[a-f0-9]{64}\.apk)$/.exec(output);
        if (output === 'ABSENT') return { status: 'absent', hash: null, reason: 'FILE_MISSING' };
        if (match?.[2] === this.remoteApk) return { status: 'hashed', hash: match[1].toLowerCase(), reason: null };
        return { status: 'unknown', hash: null,
            reason: output === 'UNREADABLE' ? 'SHA256_UNAVAILABLE' : 'INVALID_SHA256_RESPONSE' };
    }

    async _ensureApk(generation) {
        const contents = await fs.promises.readFile(this.localApk);
        this._assertGeneration(generation);
        const expectedSha256 = createHash('sha256').update(contents).digest('hex');
        // Never overwrite the classpath of a different carrier generation.
        this.remoteApk = `/data/local/tmp/vcp-u2-${expectedSha256}.apk`;
        const record = (status, actualSha256, reason) => {
            this._assertGeneration(generation);
            this._carrierIdentity = Object.freeze({ status, scope: 'startup_file', generation,
                expectedSha256, actualSha256, reason });
        };
        record('unknown', null, 'NOT_PROBED');
        let probe = await this._probeApk(generation);
        if (probe.status === 'absent' || (probe.status === 'hashed' && probe.hash !== expectedSha256)) {
            await this._exec(['push', this.localApk, this.remoteApk], 120000);
            this._assertGeneration(generation);
            probe = await this._probeApk(generation);
        }
        if (probe.status === 'hashed' && probe.hash === expectedSha256) {
            record('verified', probe.hash, null);
            return;
        }
        if (probe.status === 'unknown') {
            record('unknown', null, probe.reason);
            this.logger?.warn?.('[AndroidController] RPC载体内容无法校验；启动文件身份为unknown，不构成设备准入证据。');
            return;
        }
        record(probe.status === 'absent' ? 'unknown' : 'mismatch', probe.hash, probe.reason || 'SHA256_MISMATCH');
        throw new UiServerError(probe.status === 'absent' ? 'UI_SERVER_CARRIER_MISSING' : 'UI_SERVER_CARRIER_MISMATCH',
            '设备端载体与随包内容不一致，拒绝启动。', { dispatched: false, drained: true });
    }

    async _pickPort(generation) {
        for (const candidate of PORT_CANDIDATES) {
            const port = await this._probePort(candidate);
            this._assertGeneration(generation);
            if (port) return port;
        }
        return null;
    }

    /** 绑定再释放，确认端口此刻空闲。返回实际端口或 null。 */
    _probePort(port) {
        return new Promise((resolve) => {
            const probe = net.createServer();
            const settle = (value) => {
                probe.removeAllListeners();
                try { probe.close(() => {}); } catch { /* 已关闭 */ }
                resolve(value);
            };
            probe.once('error', () => settle(null));
            try {
                probe.listen(port, '127.0.0.1', () => {
                    const assigned = probe.address()?.port;
                    try { probe.close(() => resolve(Number.isInteger(assigned) ? assigned : null)); } catch {
                        resolve(null);
                    }
                });
            } catch {
                settle(null);
            }
        });
    }

    async _forward(port) {
        await this._exec(['forward', '--no-rebind', `tcp:${port}`, `tcp:${port}`], 15000);
    }

    async _removeForward(port, remotePort = port) {
        try {
            const { stdout } = await this._exec(['forward', '--list'], 10000);
            const owned = stdout.split(/\r?\n/).some(line => {
                const [serial, local, remote] = line.trim().split(/\s+/);
                return serial === this.serial && local === `tcp:${port}` && remote === `tcp:${remotePort}`;
            });
            if (owned) await this._exec(['forward', '--remove', `tcp:${port}`], 10000);
        } catch { /* Offline or unproven forward ownership: never remove by stale port alone. */ }
    }

    async _releaseRpcForward(port) {
        if (this._rpcForwardPort !== port) return;
        this._rpcForwardPort = null;
        await this._removeForward(port);
    }

    _spawnServer(port, generation, nonce) {
        const args = [
            '-s', this.serial,
            'shell',
            `VCP_OWNER_NONCE='${nonce}' CLASSPATH='${this.remoteOwnerJar}:${this.remoteApk}' app_process / ${OWNER_CLASS} ${port}`,
        ];
        const proc = spawn(this.adbPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const invalidate = () => {
            if (this._generation === generation && this._proc === proc) this.quarantineOwner('OWNER_ADB_LOST', generation);
        };
        proc.on('error', invalidate);
        proc.on('exit', invalidate);
        this._proc = proc;
        return proc;
    }

    async _waitReady(generation) {
        const deadline = Date.now() + this.readyTimeoutMs;
        while (Date.now() < deadline) {
            this._assertGeneration(generation);
            const alive = await this.call('ping', [], Math.min(1500, this.rpcTimeoutMs))
                .then(() => true).catch(() => false);
            this._assertGeneration(generation);
            if (alive) return true;
            await sleep(PING_INTERVAL_MS);
        }
        return false;
    }

    async stop() {
        if (this._stopping) return this._stopping;
        ++this._generation;
        this.ready = false;
        const starting = this._starting;
        const stopping = (async () => {
            // Late prepare/forward/announcement completions are drained before cleanup.
            await starting;
            const owner = await this._owner?.release();
            const port = this.port;
            this._proc = null;
            this.port = null;
            if (Number.isInteger(port)) await this._releaseRpcForward(port);
            return owner || null;
        })().finally(() => {
            if (this._stopping === stopping) this._stopping = null;
        });
        this._stopping = stopping;
        return stopping;
    }

    async recoverOwner() {
        if (this._stopping) await this._stopping;
        if (this._starting || this.isReady()) return this.ownerIdentity;
        return this._owner ? this._owner.release() : RemoteOwner.recover(this.serial);
    }

    _exec(args, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            execFile(this.adbPath, ['-s', this.serial, ...args], {
                timeout: timeoutMs,
                windowsHide: true,
                maxBuffer: 16 * 1024 * 1024,
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(new UiServerError('UI_SERVER_ADB_FAILED',
                        `adb ${args[0]} 失败：${String(stderr || error.message).trim().slice(0, 300)}`));
                    return;
                }
                resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
            });
        });
    }
}

module.exports = {
    HttpRpcTransport,
    AdbTransport,
    rpcOptions,
    vendorApkPath,
    DEFAULT_RPC_TIMEOUT_MS,
    MAX_RPC_TIMEOUT_MS,
    MAX_RPC_RESPONSE_BYTES,
    DEFAULT_READY_TIMEOUT_MS,
    VENDOR_APK,
    VENDOR_OWNER_JAR,
    OWNER_CLASS,

    CONSOLE_CLASS,
    RPC_PATH,
    PORT_CANDIDATES,
};
