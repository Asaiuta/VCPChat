'use strict';

/**
 * 无线调试后台自动连接。
 *
 * 职责划分：
 * - KnownDevices：持久记住已配对设备（序列号、上次 IP:端口、MAC），换网/换 IP 后凭 MAC 重新定位。
 * - createAutoConnector：调度器。只决定「什么时候试」，具体怎么连由注入的 attempt() 负责，
 *   因此设备管理互斥、预算和选择逻辑仍由服务层唯一持有。
 *
 * 调度策略：
 * - 每 watchMs 读一次网卡指纹（纯内存调用）；变化后等 settleMs 让 DHCP/路由稳定再试。
 * - 未连接：网络变化后 fastWindowMs 内每 fastMs 试一次，之后退到 slowMs。
 * - 已连接：每 connectedMs 只做一次 `adb devices` 级别的检查。
 * - 深度扫描（端口扫描）只在网络变化后或距上次超过 deepScanMs 时允许，避免持续占用局域网。
 */

const MAX_KNOWN = 8;

class KnownDevices {
    constructor({ file, fs }) {
        this.file = file;
        this.fs = fs;
    }

    list() {
        if (!this.file) return [];
        try {
            const raw = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
            return Array.isArray(raw?.devices) ? raw.devices.filter(validEntry) : [];
        } catch {
            return [];
        }
    }

    upsert(entry) {
        if (!this.file || !validEntry(entry)) return null;
        const devices = this.list();
        const index = devices.findIndex((item) => sameDevice(item, entry));
        const merged = { ...(index >= 0 ? devices[index] : {}), ...stripEmpty(entry), at: Date.now() };
        if (index >= 0) devices.splice(index, 1);
        devices.unshift(merged);
        this.write(devices.slice(0, MAX_KNOWN));
        return merged;
    }

    write(devices) {
        try {
            this.fs.mkdirSync(require('node:path').dirname(this.file), { recursive: true });
            this.fs.writeFileSync(this.file, JSON.stringify({ version: 1, devices }, null, 2), 'utf8');
        } catch { /* 记忆写失败只影响下次自动连接速度 */ }
    }
}

function validEntry(entry) {
    return Boolean(entry && typeof entry === 'object'
        && (typeof entry.id === 'string' || typeof entry.host === 'string'));
}

function sameDevice(a, b) {
    if (a.id && b.id) return a.id === b.id;
    if (a.mac && b.mac) return a.mac === b.mac;
    return Boolean(a.host && a.host === b.host);
}

function stripEmpty(entry) {
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function createAutoConnector(options) {
    const {
        attempt,
        fingerprint,
        logger = console,
        watchMs = 5000,
        settleMs = 3000,
        fastMs = 10000,
        slowMs = 30000,
        connectedMs = 15000,
        fastWindowMs = 120000,
        deepScanMs = 300000,
        now = () => Date.now(),
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = options;

    let stopped = true;
    let tickTimer = null;
    let watchTimer = null;
    let running = null;
    let lastFingerprint = '';
    let networkChangedAt = 0;
    let lastDeepScanAt = 0;
    let pendingNetworkChange = true;
    const state = { state: 'idle', lastAttemptAt: 0, lastResult: null, nextAt: 0, attempts: 0 };

    function unref(timer) {
        timer?.unref?.();
        return timer;
    }

    function schedule(delayMs) {
        if (stopped) return;
        if (tickTimer) clearTimer(tickTimer);
        state.nextAt = now() + delayMs;
        tickTimer = unref(setTimer(() => { tickTimer = null; void tick(); }, delayMs));
    }

    function watch() {
        if (stopped) return;
        let current = '';
        try { current = fingerprint(); } catch { current = lastFingerprint; }
        if (current !== lastFingerprint) {
            lastFingerprint = current;
            networkChangedAt = now();
            pendingNetworkChange = true;
            if (current) schedule(settleMs);
        }
        watchTimer = unref(setTimer(watch, watchMs));
    }

    async function tick() {
        if (stopped) return;
        if (running) return running;
        const startedAt = now();
        const networkChanged = pendingNetworkChange;
        const deepScan = networkChanged || startedAt - lastDeepScanAt >= deepScanMs;
        state.state = state.state === 'connected' ? 'connected' : 'searching';
        state.lastAttemptAt = startedAt;
        state.attempts += 1;
        running = (async () => {
            let result;
            try {
                result = await attempt({ networkChanged, deepScan, sinceNetworkChangeMs: startedAt - networkChangedAt });
            } catch (error) {
                result = { ok: false, code: error?.code || 'AUTO_CONNECT_FAILED', message: error?.message || String(error) };
            }
            if (result?.deepScanned) lastDeepScanAt = startedAt;
            if (!result?.busy) pendingNetworkChange = false;
            state.lastResult = summarize(result);
            state.state = result?.ok ? 'connected' : result?.busy ? state.state : 'searching';
            if (result?.ok && result.action !== 'already-connected') {
                logger.log?.(`[AndroidController] 自动连接：${result.message || result.serial}`);
            }
            return result;
        })();
        try {
            const result = await running;
            const fresh = now() - networkChangedAt < fastWindowMs;
            schedule(result?.ok ? connectedMs : result?.busy || fresh ? fastMs : slowMs);
            return result;
        } finally {
            running = null;
        }
    }

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            state.state = 'searching';
            watch();
            schedule(settleMs);
        },
        async stop() {
            stopped = true;
            if (tickTimer) clearTimer(tickTimer);
            if (watchTimer) clearTimer(watchTimer);
            tickTimer = null;
            watchTimer = null;
            state.state = 'stopped';
            state.nextAt = 0;
            await running?.catch(() => {});
        },
        /** 外部事件（配对成功、页面刷新）请求尽快再试一次。 */
        trigger(delayMs = 0) {
            if (!stopped && !running) schedule(delayMs);
        },
        tick,
        status() {
            return { enabled: !stopped, ...state };
        },
    };
}

function summarize(result) {
    if (!result) return null;
    return stripEmpty({
        ok: Boolean(result.ok), action: result.action, serial: result.serial, code: result.code,
        message: typeof result.message === 'string' ? result.message.slice(0, 300) : undefined,
        busy: result.busy || undefined,
    });
}

module.exports = { KnownDevices, createAutoConnector };
