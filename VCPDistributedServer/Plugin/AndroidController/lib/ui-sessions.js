'use strict';

// One owner for device RPC sessions and their quarantine state. Transport details
// stay behind UiServer; a deliberate disconnect must release sessions first.
function createUiSessions({ createServer, identityFor, invalidate, failure }) {
    const servers = new Map();
    const uncertain = new Set();
    function quarantine(serial) {
        uncertain.add(serial);
        invalidate(serial);
    }
    function record(serial, owner) {
        if (owner?.status === 'quarantined') quarantine(serial);
    }
    function assertCertain(serial) {
        record(serial, identityFor(serial));
        record(serial, servers.get(serial)?.ownerIdentity);
        if (uncertain.has(serial)) throw failure('DEVICE_STATE_UNCERTAIN',
            '先前RPC传输结局未知，设备已隔离；仅Manage recoverOwner的独立消失证明可解除，普通重连无效。');
    }
    function get(serial) {
        const key = String(serial || '');
        if (!servers.has(key)) servers.set(key, createServer(key));
        return servers.get(key);
    }
    async function start(serial, server = get(serial)) {
        try {
            const result = await server.start();
            record(serial, result.owner);
            if (result.code === 'UI_SERVER_OWNER_QUARANTINED') quarantine(serial);
            assertCertain(serial);
            return result;
        } catch (error) {
            if (error.code === 'UI_SERVER_OWNER_QUARANTINED') quarantine(serial);
            assertCertain(serial);
            throw error;
        }
    }
    async function call(serial, task) {
        assertCertain(serial);
        try { return await task(); }
        catch (error) {
            if (error.dispatched !== false && error.drained !== true) {
                quarantine(serial);
                servers.get(serial)?.quarantineOwner?.(error.code || 'RPC_OUTCOME_UNKNOWN');
            }
            throw error;
        }
    }
    async function stop(serial) {
        const server = servers.get(serial);
        if (!server) return;
        let owner;
        try { owner = await server.stop() || server.ownerIdentity; }
        catch (error) { quarantine(serial); throw error; }
        record(serial, owner);
        if (owner && owner.status !== 'released') {
            quarantine(serial);
            throw failure('UI_SERVER_OWNER_QUARANTINED', '远端owner退出未证明；保留连接与恢复证据。');
        }
        // Release removes the global owner lease. Keep this proof until explicit recovery.
        if (!uncertain.has(serial) && servers.get(serial) === server) servers.delete(serial);
    }
    async function stopAll({ strict = false } = {}) {
        const results = await Promise.allSettled([...servers.keys()].map(stop));
        if (strict) {
            const rejected = results.find(result => result.status === 'rejected');
            if (rejected) throw rejected.reason;
        }
    }
    async function recover(serial) {
        const server = servers.get(serial) || (identityFor(serial)?.quarantined ? get(serial) : null);
        if (!server?.recoverOwner) throw failure('UI_SERVER_OWNER_UNPROVEN', '没有本会话可验证的owner记录；不能凭人工断言清隔离。');
        await server.stop();
        const owner = await server.recoverOwner();
        if (owner?.status !== 'released') throw failure('UI_SERVER_OWNER_QUARANTINED', 'owner消失未证明，设备保持隔离。');
        uncertain.delete(serial);
        servers.delete(serial);
        invalidate(serial);
        return owner;
    }
    return Object.freeze({ get, peek: serial => servers.get(serial), start, call, stop, stopAll, recover,
        quarantine, assertCertain, record, isUncertain: serial => uncertain.has(serial),
        hasUncertain: () => uncertain.size > 0 });
}

module.exports = { createUiSessions };
