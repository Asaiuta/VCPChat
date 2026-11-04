'use strict';

/**
 * 常驻 UI 树采集服务。
 *
 * 解决的瓶颈：`exec-out uiautomator dump --compressed /dev/tty` 每调用一次
 * 都要冷启一个 dalvik VM、重连 UiAutomation、并等 `waitForIdle`。真机实测
 * （PJZ110 / Android 17，2026-11-02）p50 ≈ 2300ms；在动画密集页面（视频详情、
 * 弹幕、加载指示器）上 waitForIdle 会一直等不到，11 秒后吐
 * "ERROR: could not get idle state." —— 剖析里正是它把 Observe 拖到 22.8s。
 *
 * 这里改用 openatx/android-uiautomator-server 的 u2.apk：推到 /data/local/tmp，
 * 由 app_process 以 CLASSPATH 方式加载成常驻 JSON-RPC 服务。**不经过包管理器**，
 * 不出现在应用列表里，卸载就是删文件。同一页面实测 p50 61ms / p95 122ms /
 * 40/40 成功，输出仍是标准 uiautomator XML。
 *
 * 关键取舍：
 * - 端口动态挑选。9008 是上游默认值，容易与他人设备或前一个实例撞上，
 *   所以先让内核分配，占用则退化到候选段，forward 失败再换一次。
 * - 任何一步失败都抛 UiServerError，由调用方回退到 CLI 路径。
 *   这里绝不返回半截 XML —— 空树会被上层误读成「界面确实是空的」。
 * - 就绪判定用 ping，不用「进程起来了」这种弱信号：app_process 先输出日志、
 *   后监听端口，中间有几百毫秒的空窗。
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const net = require('net');
const http = require('http');
const { isKnown, validate } = require('./rpc-methods');

const VENDOR_APK = 'u2-server-0.5.0.apk';
const REMOTE_APK = '/data/local/tmp/u2-server-0.5.0.apk';
const CONSOLE_CLASS = 'com.github.uiautomator2.Console';
const RPC_PATH = '/jsonrpc/0';

// dump 实测 p95 = 122ms。给 4s 是留足冷启动与树特别深时的余量，
// 又远小于旧路径 25s 的超时，卡死能被快速识别并回退。
const DEFAULT_RPC_TIMEOUT_MS = 4000;
const MAX_RPC_TIMEOUT_MS = 120000;
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
// 控件树深度上限。Android 层级实测远小于此值（复杂页 130 节点/约 12 层），
// 留足余量但不依赖服务端对 0 的解释 —— 0 在 uiautomator2 下只返回根节点。
const DEFAULT_DUMP_MAX_DEPTH = 200;
// 方法名集合只有一处定义（lib/rpc-methods.js）。这里不接受任意方法名，
// 也绝不做反射透传 —— 那正是「白名单」二字的本意。参数形状由调用方在同一张表上校验。
// 能力探针的预算。它只打一次，且失败不影响主流程，所以取一个「宁可问不成也不拖住」的值。

// 实测从拉起进程到 ping 通 ~1s。15s 覆盖无线调试抖动与首次 dex 优化。
const DEFAULT_READY_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 200;

// 0 表示交给内核分配；其余是冲突时的退化候选。
const PORT_CANDIDATES = [0, 9008, 9009, 9010, 9011, 9012, 9013, 9014, 9015];

let rpcSeq = 0;

class UiServerError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'UiServerError';
        this.code = code;
        Object.assign(this, details);
    }
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function vendorApkPath() {
    return path.resolve(__dirname, '../vendor', VENDOR_APK);
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


class UiServer {
    constructor(options = {}) {
        this.adbPath = options.adbPath || 'adb';
        this.serial = options.serial;
        this.remoteApk = options.remoteApk || REMOTE_APK;
        this.localApk = options.localApk || vendorApkPath();
        this.readyTimeoutMs = Number.isFinite(options.readyTimeoutMs)
            ? options.readyTimeoutMs
            : DEFAULT_READY_TIMEOUT_MS;
        this.rpcTimeoutMs = Number.isFinite(options.rpcTimeoutMs)
            ? options.rpcTimeoutMs
            : DEFAULT_RPC_TIMEOUT_MS;
        this._proc = null;
        this._ready = false;
        this._port = null;
        this._starting = null;
        this._stopping = null;
        this._generation = 0;
        // Observed failures belong to one service generation; absence means unknown.
        this._unavailableMethods = new Set();
    }

    get port() {
        return this._port;
    }

    isReady() {
        return this._ready === true && Number.isInteger(this._port);
    }

    /** Failure history is not a positive capability probe. */
    capability(method) {
        return this._unavailableMethods.has(method) ? 'unavailable' : 'unknown';
    }

    /**
     * 把「实际观测到的失败」记成能力结论。
     * 按方法记账，不按方法组记账：真机证据是 setClipboard 成功、pasteClipboard
     * 抛 AssertionError —— 同一套反射镜像在同一个 ROM 上也能一半活一半死，
     * 按整组一刀切会把还能用的那一半一起封掉。
     * 只接受 unavailable，避免把已判死的通道又改回可用。
     */
    noteCapability(method, verdict) {
        if (verdict === 'unavailable') this._unavailableMethods.add(method);
    }

    /** 拉起并等到 ping 通。失败返回 { ok:false, reason }，不抛 —— 调用方要能静默回退。 */
    async start() {
        if (this._stopping) {
            await this._stopping;
            return this.start();
        }
        if (this.isReady()) return { ok: true, reused: true, port: this._port };
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
    }

    async _doStart(generation) {
        let port = null;
        let proc = null;
        let ready = false;
        let forwardOwned = false;
        try {
            // Unexpected process exit invalidates readiness but leaves its forward allocated.
            const staleProc = this._proc;
            const stalePort = this._port;
            this._proc = null;
            this._port = null;
            if (staleProc && !staleProc.killed) {
                try { staleProc.kill(); } catch { /* Already exited. */ }
            }
            if (Number.isInteger(stalePort)) await this._removeForward(stalePort);
            this._assertGeneration(generation);
            if (!fs.existsSync(this.localApk)) {
                return { ok: false, reason: `内置 apk 缺失：${this.localApk}` };
            }
            await this._ensureApk(generation);
            this._assertGeneration(generation);
            port = await this._pickPort(generation);
            this._assertGeneration(generation);
            if (!port) return { ok: false, reason: '找不到可用本地端口' };
            await this._forward(port);
            forwardOwned = true;
            this._assertGeneration(generation);
            this._port = port;
            proc = this._spawnServer(port, generation);
            const alive = await this._waitReady(generation);
            this._assertGeneration(generation);
            if (!alive) {
                return { ok: false, reason: `服务在 ${this.readyTimeoutMs}ms 内未响应 ping` };
            }
            this._ready = true;
            ready = true;
            return { ok: true, port };
        } catch (error) {
            return { ok: false, reason: error.message };
        } finally {
            if (!ready) {
                if (this._proc === proc) this._proc = null;
                if (proc && !proc.killed) {
                    try { proc.kill(); } catch { /* Already exited. */ }
                }
                if (this._port === port) this._port = null;
                if (forwardOwned) await this._removeForward(port);
            }
        }
    }

    async _ensureApk(generation) {
        // 3.7MB 每次重推太浪费，先问设备在不在。
        //
        // 命令末尾必须有 `|| echo ABSENT`：`[ -f X ] && echo PRESENT` 在文件不存在时
        // 退出码是 1，而 _exec 把任何非零退出码当失败抛出 —— 结果是首次接入永远
        // "推送失败"、start() 永远 ok:false、上层静默回退 CLI，常驻服务形同不存在。
        // 真机实测（PJZ110 / Android 17，2026-11-02）：缺 apk 时 exit=1，补了 `||` 才 exit=0。
        const check = await this._exec(['shell', `[ -f ${this.remoteApk} ] && echo PRESENT || echo ABSENT`], 15000);
        this._assertGeneration(generation);
        if (String(check.stdout).includes('PRESENT')) return;
        await this._exec(['push', this.localApk, this.remoteApk], 120000);
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

    async _removeForward(port) {
        await this._exec(['forward', '--remove', `tcp:${port}`], 10000).catch(() => null);
    }

    _spawnServer(port, generation) {
        const args = [
            '-s', this.serial,
            'shell',
            `CLASSPATH=${this.remoteApk} app_process / ${CONSOLE_CLASS} -p ${port}`,
        ];
        const proc = spawn(this.adbPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        const invalidate = () => {
            if (this._generation === generation && this._proc === proc) this._ready = false;
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
            const alive = await this._rpc('ping', [], Math.min(1500, this.rpcTimeoutMs))
                .then(() => true).catch(() => false);
            this._assertGeneration(generation);
            if (alive) return true;
            await sleep(PING_INTERVAL_MS);
        }
        return false;
    }

    /**
     * 采集控件树。
     * @returns {Promise<{xml: string}>}
     */
    async dump(options = {}) {
        const startedAt = Date.now();
        if (!this.isReady()) {
            throw new UiServerError('UI_SERVER_NOT_READY', 'UI 服务未就绪，无法采集控件树', { dispatched: false, drained: true });
        }
        const { timeoutMs, signal } = rpcOptions(options, this.rpcTimeoutMs);
        const compressed = options.compressed === true;
        // uiautomator2 的 maxDepth<=0 不是「不限制」，而是「只到根」：真机实测
        // （PJZ110 / Android 17 / u2-server-0.5.0）maxDepth=0 与 -1 均只回 1 个 <node>，
        // 同一屏 maxDepth>=60 回完整树（130 节点）。传 0 会让上层拿到「成功但只有根」的树，
        // 判定界面为空且永不回退 CLI。这里把非法值校正为正整数上限。
        const requestedMaxDepth = Math.floor(options.maxDepth);
        const maxDepth = Number.isFinite(requestedMaxDepth) && requestedMaxDepth > 0
            ? requestedMaxDepth
            : DEFAULT_DUMP_MAX_DEPTH;
        const rootInActive = options.rootInActive !== false;

        const result = await this._rpc('dumpWindowHierarchy', [compressed, maxDepth, rootInActive], timeoutMs, signal, startedAt + timeoutMs);
        const xml = typeof result === 'string' ? result : '';
        if (!xml.includes('<hierarchy')) {
            throw new UiServerError('UI_SERVER_BAD_PAYLOAD', '服务返回的不是控件树 XML', { dispatched: true, drained: true });
        }
        return { xml };
    }

    stop() {
        if (this._stopping) return this._stopping;
        ++this._generation;
        this._ready = false;
        // 新进程可能是重装 APK / 换 ROM 之后拉的，能力结论不能跨代沿用。
        this._unavailableMethods.clear();

        const starting = this._starting;
        const stopping = (async () => {
            await starting;
            const proc = this._proc;
            const port = this._port;
            this._proc = null;
            this._port = null;
            if (proc && !proc.killed) {
                try { proc.kill(); } catch { /* Already exited. */ }
            }
            if (Number.isInteger(port)) await this._removeForward(port);
        })().finally(() => {
            if (this._stopping === stopping) this._stopping = null;
        });
        this._stopping = stopping;
        return stopping;
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

    /**
     * Execute one whitelisted RPC within a total timeout budget.
     * dispatched=false means local rejection or JSON-RPC -32601/-32602;
     * dispatched=true means execution may have happened and must not be replayed blindly.
     * drained=true means this protocol request has no outstanding response, not that
     * the device is idle or its remote owner has terminated.
     */
    async invoke(method, params = [], options = {}) {
        const startedAt = Date.now();
        const invalid = (message) => new UiServerError('UI_SERVER_INVALID_ARGUMENT', message, { dispatched: false, drained: true });
        if (!isKnown(method)) throw invalid('RPC method is not allowed');
        if (!Array.isArray(params)) throw invalid('RPC params must be an array');
        // 唯一 RPC 入口统一校验参数个数：click 接受 (x,y) 或 (x,y,milliseconds)，
        // 四参等未声明形状在写请求体之前拒绝，不依赖设备端试错。
        const shape = validate(method, params);
        if (!shape.ok) throw invalid(shape.reason);
        const { timeoutMs, signal } = rpcOptions(options, this.rpcTimeoutMs);
        if (!this.isReady()) throw new UiServerError('UI_SERVER_NOT_READY', 'UI 服务未就绪', { dispatched: false, drained: true });
        return this._rpc(method, params, timeoutMs, signal, startedAt + timeoutMs);
    }

    _rpc(method, params, timeoutMs = this.rpcTimeoutMs, signal, deadline = Date.now() + timeoutMs) {
        return new Promise((resolve, reject) => {
            let dispatched = false;
            let drained = false;
            const failure = (code, message, details = {}) => new UiServerError(code, message, {
                dispatched, drained: !dispatched || drained, ...details,
            });
            if (!Number.isInteger(this._port)) {
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
                    hostname: '127.0.0.1', port: this._port, path: RPC_PATH, method: 'POST',
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

module.exports = { UiServer, UiServerError };
