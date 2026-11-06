'use strict';

/**
 * 常驻 UI 树采集服务 —— 会话层。
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
 * 分层（2026-11-04 拆出传输层）：
 * - `ui-transport.js` 只管「怎么够到端点」：app_process、forward、HTTP 收发。
 *   已安装 App 直连仅在端点语义/能力/错误契约等价时可复用会话层；设备后端需另验。
 * - 本文件管「发什么、允不允许发、失败算哪一类」：方法白名单、参数形状、
 *   能力记账、回退决策。三条不变量都在这里守住。
 *
 * 关键取舍：
 * - 端口动态挑选。9008 是上游默认值，容易与他人设备或前一个实例撞上，
 *   所以先让内核分配，占用则退化到候选段，forward 失败再换一次。（在传输层。）
 * - 任何一步失败都抛 UiServerError，由调用方回退到 CLI 路径。
 *   这里绝不返回半截 XML —— 空树会被上层误读成「界面确实是空的」。
 * - 就绪判定用 ping，不用「进程起来了」这种弱信号：app_process 先输出日志、
 *   后监听端口，中间有几百毫秒的空窗。（在传输层。）
 */

const { isKnown, validate } = require('./rpc-methods');
const { UiServerError } = require('./ui-error');
const {
    AdbTransport,
    rpcOptions,
    DEFAULT_RPC_TIMEOUT_MS,
    DEFAULT_READY_TIMEOUT_MS,
} = require('./ui-transport');

// 控件树深度上限。Android 层级实测远小于此值（复杂页 130 节点/约 12 层），
// 留足余量但不依赖服务端对 0 的解释 —— 0 在 uiautomator2 下只返回根节点。
const DEFAULT_DUMP_MAX_DEPTH = 200;

class UiServer {
    /**
     * @param {object} options
     * @param {string} [options.adbPath]
     * @param {string} [options.serial]
     * @param {object} [options.transport] 直接注入传输层（测试与未来直连形态用）
     */
    constructor(options = {}) {
        this.rpcTimeoutMs = Number.isFinite(options.rpcTimeoutMs)
            ? options.rpcTimeoutMs
            : DEFAULT_RPC_TIMEOUT_MS;
        this.readyTimeoutMs = Number.isFinite(options.readyTimeoutMs)
            ? options.readyTimeoutMs
            : DEFAULT_READY_TIMEOUT_MS;
        // 传输层可替换：现在只有 AdbTransport。会话层只依赖它的
        // start/stop/call/isReady 四个方法，不依赖 adb 三个字。
        this.transport = options.transport || new AdbTransport({
            adbPath: options.adbPath,
            serial: options.serial,
            logger: options.logger,
            rpcTimeoutMs: this.rpcTimeoutMs,
            readyTimeoutMs: this.readyTimeoutMs,
        });
        // Observed failures belong to one service generation; absence means unknown.
        this._unavailableMethods = new Set();
        this._capabilityGeneration = this.transport.generation;
    }

    get port() {
        return this.transport.port;
    }

    isReady() {
        return this.transport.isReady();
    }

    get carrierIdentity() { return this.transport.carrierIdentity; }

    get ownerIdentity() { return this.transport.ownerIdentity || null; }

    quarantineOwner(reason) { return this.transport.quarantineOwner?.(reason) || this.ownerIdentity; }

    async recoverOwner() {
        if (!this.transport.recoverOwner) throw new UiServerError('UI_SERVER_OWNER_UNPROVEN', '传输层不支持owner退出验证');
        return this.transport.recoverOwner();
    }

    _syncCapabilityGeneration() {
        if (this._capabilityGeneration !== this.transport.generation) {
            this._unavailableMethods.clear();
            this._capabilityGeneration = this.transport.generation;
        }
    }

    /** Failure history is not a positive capability probe. */
    capability(method) {
        this._syncCapabilityGeneration();
        return this._unavailableMethods.has(method) ? 'unavailable' : 'unknown';
    }

    /**
     * 把「实际观测到的失败」记成能力结论。
     * 按方法记账，不按方法组记账：真机证据是 setClipboard 成功、pasteClipboard
     * 抛 AssertionError —— 同一套反射镜像在同一个 ROM 上也能一半活一半死，
     * 按整组一刀切会把还能用的那一半一起封掉。
     * 只接受 unavailable，避免把已判死的通道又改回可用。
     */
    noteCapability(method, verdict, generation = this.transport.generation) {
        this._syncCapabilityGeneration();
        if (generation === this.transport.generation && verdict === 'unavailable') this._unavailableMethods.add(method);
    }

    /** 拉起并等到 ping 通。失败返回 { ok:false, reason }，不抛 —— 调用方要能静默回退。 */
    async start() {
        return this.transport.start();
    }

    stop() {
        // 新进程可能是重装 APK / 换 ROM 之后拉的，能力结论不能跨代沿用。
        this._unavailableMethods.clear();
        return this.transport.stop();
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
        // Vendor DEX: true returns only the active root; false also enumerates window roots.
        // Multiple roots are not a structured window/occlusion contract for host consumers.
        const rootInActive = options.rootInActive !== false;

        const result = await this._rpc('dumpWindowHierarchy', [compressed, maxDepth, rootInActive], timeoutMs, signal, startedAt + timeoutMs);
        const xml = typeof result === 'string' ? result : '';
        if (!xml.includes('<hierarchy')) {
            throw new UiServerError('UI_SERVER_BAD_PAYLOAD', '服务返回的不是控件树 XML', { dispatched: true, drained: true });
        }
        return { xml };
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
        const generation = this.transport.generation;
        try {
            return await this._rpc(method, params, timeoutMs, signal, startedAt + timeoutMs);
        } catch (error) {
            if (method === 'pasteClipboard' && error.code === 'UI_SERVER_RPC_ERROR' && error.drained === true) {
                this.noteCapability(method, 'unavailable', generation);
            }
            throw error;
        }
    }

    /**
     * 一次 RPC 的转发接缝。校验与就绪判定在 invoke，收发在传输层，
     * 这里只把两者接上 —— 保留这一层是为了有唯一的替换点（测试可整体替换）。
     */
    _rpc(method, params, timeoutMs = this.rpcTimeoutMs, signal, deadline = Date.now() + timeoutMs) {
        return this.transport.call(method, params, timeoutMs, signal, deadline);
    }
}

module.exports = { UiServer, UiServerError };
