'use strict';

const { randomBytes } = require('node:crypto');
const net = require('node:net');
const { UiServerError } = require('./ui-error');

// Tombstones intentionally outlive transport instances. No force-clear API.
const leases = new Map();
const error = (code, message) => new UiServerError(code, message, { dispatched: false, drained: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const validPort = n => Number.isInteger(n) && n > 0 && n <= 65535;
const validIdentity = value => value && validPort(value.port) && Number.isSafeInteger(value.pid) && value.pid > 0
    && Number.isSafeInteger(value.uid) && value.uid >= 0 && typeof value.startTime === 'string' && /^\d+$/.test(value.startTime)
    && Array.isArray(value.cmdline) && value.cmdline.length > 0
    && value.cmdline.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 4096);
const sameIdentity = (a, b) => validIdentity(a) && validIdentity(b) && a.port === b.port && a.pid === b.pid
    && a.uid === b.uid && a.startTime === b.startTime && JSON.stringify(a.cmdline) === JSON.stringify(b.cmdline);

function ownerCommand(port, command, nonce, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        let socket, timer, size = 0, data = '', settled = false;
        const finish = (cause, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket?.destroy();
            if (cause) reject(cause); else resolve(value);
        };
        try {
            socket = net.createConnection({ host: '127.0.0.1', port });
            timer = setTimeout(() => finish(error('UI_SERVER_OWNER_TIMEOUT', 'owner 控制通道超时')), timeoutMs);
            socket.on('error', () => finish(error('UI_SERVER_OWNER_UNREACHABLE', 'owner 控制通道不可达')));
            socket.on('connect', () => socket.write(`${command} ${nonce}\n`));
            socket.on('data', chunk => {
                size += chunk.length;
                if (size > 65536) return finish(error('UI_SERVER_OWNER_PROTOCOL', 'owner 响应过大'));
                data += chunk.toString('utf8');
                const end = data.indexOf('\n');
                if (end >= 0) finish(null, data.slice(0, end));
            });
            socket.on('close', () => finish(error('UI_SERVER_OWNER_UNREACHABLE', 'owner 控制连接提前关闭')));
        } catch { finish(error('UI_SERVER_OWNER_UNREACHABLE', 'owner 控制通道不可达')); }
    });
}

class AdbOwnerBackend {
    constructor(transport) {
        this.transport = transport;
        this.announcement = null;
        this.ownerForward = null;
        this.rpcPort = null;
        this.proc = null;
        this.context = null;
        this._forwarding = null;
        this._cleaning = null;
        this._heartbeatEpoch = 0;
        this._heartbeatTimer = null;
        this._heartbeat = null;
    }

    async prepare(context) {
        this.context = context;
        await this.transport._ensureOwnerJar(context.generation);
        return { endpointBinding: true, atomicTermination: true };
    }

    launch(context) {
        this.context = context;
        this.rpcPort = context.port;
        // Keep collecting a late announcement after a timeout: it may make recovery possible.
        this._announced = new Promise(resolve => { this._resolveAnnouncement = resolve; });
        this.proc = this.transport._spawnServer(context.port, context.generation, context.nonce);
        let buffer = '', bytes = 0;
        this.proc.stdout?.on('data', chunk => {
            if (this.announcement || bytes > 65536) return;
            bytes += chunk.length;
            buffer += chunk.toString('utf8');
            if (bytes > 65536) { buffer = ''; return; }
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                if (!line.startsWith('VCP_OWNER_V1 ')) continue;
                let value;
                try { value = JSON.parse(line.slice(13)); } catch { continue; }
                if (!validIdentity(value) || value.nonce !== context.nonce || value.port === context.port) continue;
                this.announcement = Object.freeze({ ...value, cmdline: Object.freeze([...value.cmdline]) });
                this._resolveAnnouncement(this.announcement);
            }
        });
        return this.proc;
    }

    async _announcement() {
        if (this.announcement) return this.announcement;
        let timer;
        try {
            return await Promise.race([this._announced, new Promise((_, reject) => {
                timer = setTimeout(() => reject(error('UI_SERVER_OWNER_UNBOUND', '未收到 owner 启动证据')), this.transport.readyTimeoutMs);
            })]);
        } finally { clearTimeout(timer); }
    }

    async _forward() {
        if (this._forwarding) return this._forwarding;
        this._forwarding = (async () => {
            // Wireless reconnect can delete forwards or reuse their local ports.
            if (this.ownerForward && await this._hasForward()) return this.ownerForward;
            this.ownerForward = null;
            const { stdout } = await this.transport._exec(['forward', '--no-rebind', 'tcp:0', `tcp:${this.announcement.port}`], 15000);
            const port = Number(stdout.trim());
            if (!validPort(port)) throw error('UI_SERVER_OWNER_FORWARD', 'owner forward 未返回内核分配的端口');
            this.ownerForward = port;
            return port;
        })().finally(() => { this._forwarding = null; });
        return this._forwarding;
    }

    async _hasForward() {
        const { stdout } = await this.transport._exec(['forward', '--list'], 10000);
        return stdout.split(/\r?\n/).some(line => {
            const [serial, local, remote] = line.trim().split(/\s+/);
            return serial === this.context.serial && local === `tcp:${this.ownerForward}`
                && remote === `tcp:${this.announcement.port}`;
        });
    }

    async _discardForward() {
        if (!this.ownerForward) return;
        // Never remove a local port that was reassigned during a disconnect.
        if (await this._hasForward()) await this.transport._removeForward(this.ownerForward, this.announcement.port);
        this.ownerForward = null;
    }

    async _info(context) {
        let port = await this._forward();
        let reply;
        try { reply = await ownerCommand(port, 'INFO', context.nonce); }
        catch {
            // INFO is read-only (apart from lease renewal); STOP/RPC are never replayed.
            await this._discardForward();
            port = await this._forward();
            try { reply = await ownerCommand(port, 'INFO', context.nonce); }
            catch { throw error('UI_SERVER_OWNER_UNBOUND', 'owner INFO 认证或响应失败'); }
        }
        let info;
        try { info = JSON.parse(reply); }
        catch { throw error('UI_SERVER_OWNER_UNBOUND', 'owner INFO 认证或响应失败'); }
        if (info.nonce !== context.nonce || !sameIdentity(info, this.announcement) || info.rpcPort !== this.rpcPort) {
            throw error('UI_SERVER_OWNER_UNBOUND', 'owner INFO 与本次启动身份不一致');
        }
        return info;
    }

    keepAlive(context) {
        if (this._heartbeatTimer) return;
        this.stopHeartbeat();
        const epoch = this._heartbeatEpoch;
        const schedule = () => {
            this._heartbeatTimer = setTimeout(() => {
                this._heartbeat = (async () => {
                    try {
                        const info = await this._info(context);
                        if (info.rpcOwned !== true || !/^\d+$/.test(info.rpcInode || '')) {
                            throw error('UI_SERVER_OWNER_UNBOUND', 'owner 已失去 RPC 监听端点');
                        }
                    } catch {
                        if (epoch === this._heartbeatEpoch) {
                            this.transport.quarantineOwner('OWNER_HEARTBEAT_LOST', context.generation);
                        }
                    }
                    if (epoch === this._heartbeatEpoch) schedule();
                })();
            }, 5000);
            this._heartbeatTimer.unref?.();
        };
        schedule();
    }

    stopHeartbeat() {
        ++this._heartbeatEpoch;
        clearTimeout(this._heartbeatTimer);
        this._heartbeatTimer = null;
    }

    async bind(context) {
        await this._announcement();
        const deadline = Date.now() + this.transport.readyTimeoutMs;
        while (Date.now() < deadline) {
            this.transport._assertGeneration(context.generation);
            const info = await this._info(context);
            if (info.rpcOwned === true && typeof info.rpcInode === 'string' && /^\d+$/.test(info.rpcInode)) {
                return { ...info, serial: context.serial, port: context.port, ownerPort: info.port,
                    verified: true, endpointProof: 'socket_inode' };
            }
            await delay(100);
        }
        throw error('UI_SERVER_OWNER_UNBOUND', 'RPC 监听 socket 不属于启动的 owner 进程');
    }

    async inspect(context) {
        const original = this.announcement;
        if (!original) throw error('UI_SERVER_OWNER_UNCONFIRMED', '没有原始 PID/starttime，不能证明远端消失');
        const pid = original.pid;
        // This is an independent adb /proc read, never an assertion from the owner socket.
        const command = `if [ ! -d /proc/${pid} ]; then echo VCP_PROC_ABSENT; elif s=$(cat /proc/${pid}/stat 2>/dev/null); then printf 'VCP_PROC_STAT %s\\n' "$s"; else echo VCP_PROC_UNKNOWN; fi; `
            + "if [ -r /proc/net/tcp ] && [ -r /proc/net/tcp6 ]; then echo VCP_TCP4; if cat /proc/net/tcp; then echo VCP_TCP6; if cat /proc/net/tcp6; then echo VCP_END; fi; fi; else echo VCP_NET_UNKNOWN; fi";
        const { stdout } = await this.transport._exec(['shell', command], 10000);
        const lines = stdout.trim().split(/\r?\n/);
        let gone = lines[0] === 'VCP_PROC_ABSENT';
        if (lines[0]?.startsWith('VCP_PROC_STAT ')) {
            const stat = lines[0].slice(14);
            const closing = stat.lastIndexOf(')');
            const startTime = closing < 0 ? '' : stat.slice(closing + 2).trim().split(/\s+/)[19];
            if (!/^\d+$/.test(startTime || '')) throw error('UI_SERVER_OWNER_UNCONFIRMED', '独立 stat 读回无效');
            gone = startTime !== original.startTime;
        } else if (!gone) throw error('UI_SERVER_OWNER_UNCONFIRMED', '无法独立读取原始进程');
        const four = lines.indexOf('VCP_TCP4'), six = lines.indexOf('VCP_TCP6'), end = lines.indexOf('VCP_END');
        if (four < 1 || six <= four || end <= six) throw error('UI_SERVER_OWNER_UNCONFIRMED', '无法独立读取远端端点');
        const ports = new Set([original.port, this.rpcPort]);
        let listening = false;
        for (const line of lines.slice(four + 1, end)) {
            if (line === 'VCP_TCP6' || /^\s*sl\s/.test(line)) continue;
            const fields = line.trim().split(/\s+/);
            if (fields.length < 10 || !/^\d+:$/.test(fields[0]) || !/^[a-fA-F0-9]+:[a-fA-F0-9]{4}$/.test(fields[1])
                || !/^[a-fA-F0-9]{2}$/.test(fields[3])) throw error('UI_SERVER_OWNER_UNCONFIRMED', '远端 socket 表格式无效');
            if (fields[3] === '0A' && ports.has(parseInt(fields[1].split(':')[1], 16))) listening = true;
        }
        return { verified: true, gone: gone && !listening, nonce: context.nonce, serial: context.serial };
    }

    async terminate(context) {
        if (this._cleaning) return this._cleaning;
        this.stopHeartbeat();
        this._cleaning = (async () => {
            // Drain an in-flight renewal/forward before STOP or resource disposal.
            await this._heartbeat;
            if (this.announcement) {
                try {
                    await this._info(context);
                    await ownerCommand(this.ownerForward, 'STOP', context.nonce);
                } catch { /* Only independent disappearance evidence can resolve uncertainty. */ }
            }
            const deadline = Date.now() + this.transport.ownerCleanupTimeoutMs;
            do {
                const proof = await this.inspect(context);
                if (proof.gone) return proof;
                if (Date.now() >= deadline) return proof;
                await delay(100);
            } while (true);
        })().finally(() => { this._cleaning = null; });
        return this._cleaning;
    }

    async dispose() {
        // Only our own adb client and acquired forwards; never a remote numeric PID kill.
        await this.transport._releaseRpcForward(this.rpcPort);
        if (this.transport.port === this.rpcPort) {
            this.transport.port = null;
            this.transport.ready = false;
        }
        if (this.proc && !this.proc.killed) { try { this.proc.kill(); } catch { /* Exited. */ } }
        await this._discardForward();
    }
}

class RemoteOwner {
    constructor({ serial, generation, backend }) {
        this.serial = serial;
        this.generation = generation;
        this.backend = backend;
        this._nonce = randomBytes(32).toString('hex');
        this.binding = null;
        this.launched = false;
        this.status = 'idle';
        this.reason = null;
        this._releasing = null;
    }

    get identity() {
        return Object.freeze({ status: this.status, generation: this.generation, scope: 'remote_owner',
            serial: this.serial, quarantined: this.status === 'quarantined', reason: this.reason, binding: this.binding });
    }

    _context() { return { ...this.identity, nonce: this._nonce, port: this.port }; }

    quarantine(reason = 'RPC_OUTCOME_UNKNOWN') {
        if (this.launched && this.status !== 'released') {
            this.backend.stopHeartbeat?.();
            this.status = 'quarantined';
            this.reason = reason;
        }
        return this.identity;
    }

    static identityFor(serial) { return leases.get(serial)?.identity || null; }

    static recover(serial) {
        const owner = leases.get(serial);
        return owner?.status === 'quarantined' ? owner.release() : Promise.resolve(owner?.identity || null);
    }

    get ownsLease() { return leases.get(this.serial) === this; }

    async prepare() {
        const previous = leases.get(this.serial);
        if (previous && previous !== this) {
            this.status = 'quarantined';
            this.reason = 'PREVIOUS_OWNER_UNRELEASED';
            throw error('UI_SERVER_OWNER_QUARANTINED', '设备仍有未确认消失的远端 owner');
        }
        if (!this.serial || !this.backend) throw error('UI_SERVER_OWNER_UNSUPPORTED', '缺少设备或 owner 后端');
        leases.set(this.serial, this);
        this.status = 'preparing';
        try {
            const support = await this.backend.prepare(this._context());
            if (support?.endpointBinding !== true || support?.atomicTermination !== true) {
                throw error('UI_SERVER_OWNER_UNSUPPORTED', 'owner 后端没有端点绑定与定向自退出能力');
            }
        } catch (cause) {
            this.status = 'released';
            this.reason = cause.code || 'OWNER_PREPARE_FAILED';
            if (leases.get(this.serial) === this) leases.delete(this.serial);
            throw cause;
        }
    }

    begin(port) {
        this.port = port;
        this.launched = true;
        this.status = 'binding';
        return this.backend.launch(this._context());
    }

    async bind() {
        const binding = await this.backend.bind(this._context());
        if (this.status === 'quarantined') throw error('UI_SERVER_OWNER_QUARANTINED', 'owner 绑定期间已失联');
        if (!binding || binding.verified !== true || binding.nonce !== this._nonce
            || binding.serial !== this.serial || binding.port !== this.port
            || !validIdentity({ ...binding, port: binding.ownerPort }) || binding.endpointProof !== 'socket_inode') {
            throw error('UI_SERVER_OWNER_UNBOUND', 'owner 证据无法绑定本会话端点');
        }
        // Public receipts must never include the authentication nonce or arbitrary backend fields.
        this.binding = Object.freeze({ verified: true, serial: this.serial, port: this.port,
            ownerPort: binding.ownerPort, pid: binding.pid, uid: binding.uid, startTime: binding.startTime,
            cmdline: Object.freeze([...binding.cmdline]), endpointProof: binding.endpointProof, rpcInode: binding.rpcInode });
        this.status = 'bound';
        this.backend.keepAlive?.(this._context());
        return this.identity;
    }

    async release() {
        if (this._releasing) return this._releasing;
        this._releasing = this._release().finally(() => { this._releasing = null; });
        return this._releasing;
    }

    async _release() {
        const previous = leases.get(this.serial);
        // A replacement can inspect/recover the old lease but cannot erase it.
        if (previous && previous !== this) {
            if (previous.status !== 'quarantined') {
                this.status = 'quarantined';
                this.reason = 'PREVIOUS_OWNER_UNRELEASED';
                return this.identity;
            }
            const recovered = await previous.release();
            this.status = recovered.status;
            this.reason = recovered.reason;
            return recovered;
        }
        if (this.status === 'released') return this.identity;
        if (!this.launched) {
            if (leases.get(this.serial) === this) leases.delete(this.serial);
            this.status = 'released';
            return this.identity;
        }
        try {
            const proof = await this.backend.terminate(this._context());
            if (proof?.verified !== true || proof?.gone !== true || proof?.nonce !== this._nonce || proof?.serial !== this.serial) {
                throw error('UI_SERVER_OWNER_UNCONFIRMED', '原始进程与 owner/RPC 端点尚未确认消失');
            }
            await this.backend.dispose?.();
            this.status = 'released';
            this.reason = null;
            if (leases.get(this.serial) === this) leases.delete(this.serial);
        } catch (cause) {
            this.status = 'quarantined';
            this.reason = cause.code || 'OWNER_CLEANUP_FAILED';
        }
        return this.identity;
    }
}

module.exports = { RemoteOwner, AdbOwnerBackend };
