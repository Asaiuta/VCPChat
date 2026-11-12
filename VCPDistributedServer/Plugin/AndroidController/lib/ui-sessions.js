'use strict';

// One owner for device RPC sessions and their quarantine state. Transport details
// stay behind UiServer; a deliberate disconnect must release sessions first.
function createUiSessions({ createServer, identityFor, invalidate, failure, inputRecovery = () => null }) {
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
        if (inputRecovery()?.blocked(serial)) quarantine(serial);
        record(serial, identityFor(serial));
        record(serial, servers.get(serial)?.ownerIdentity);
        if (uncertain.has(serial)) throw failure('DEVICE_STATE_UNCERTAIN',
            '设备状态未知；须Manage recoverOwner核验进程退出与输入恢复，普通重连不能解除隔离。');
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
    async function call(serial, task, { inputIdentity = null } = {}) {
        assertCertain(serial);
        const store = inputIdentity ? inputRecovery() : null;
        const record = store ? store.begin(serial, inputIdentity) : null;
        let completed = false;
        try {
            const result = await task(); completed = true;
            if (record) {
                if (result === false) { store.retain(record); quarantine(serial); servers.get(serial)?.quarantineOwner?.('INPUT_RESULT_UNKNOWN'); }
                else store.complete(record);
            }
            return result;
        }
        catch (error) {
            if (completed) error = Object.assign(error, { dispatched: true, drained: true });
            if (record) {
                if (!completed && error.dispatched === false) store.complete(record);
                else { store.retain(record); quarantine(serial); servers.get(serial)?.quarantineOwner?.('INPUT_RESULT_UNKNOWN'); }
            }
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
        const store = inputRecovery(), pendingInput = store?.pending(serial);
        const server = servers.get(serial) || (identityFor(serial)?.quarantined ? get(serial) : null);
        // After host restart only a changed boot of the same device can prove the
        // old owner AND input dispatcher gone; never trust an empty local registry.
        if (!server?.recoverOwner && !pendingInput) throw failure('UI_SERVER_OWNER_UNPROVEN', '没有本会话可验证的owner记录；不能凭人工断言清隔离。');
        let owner;
        if (server?.recoverOwner) { await server.stop(); owner = await server.recoverOwner(); }
        else owner = { status: 'released', scope: 'device_boot' };
        if (owner?.status !== 'released') throw failure('UI_SERVER_OWNER_QUARANTINED', 'owner消失未证明，设备保持隔离。');
        if (pendingInput) {
            try { const proof = await store.proveReset(serial); store.complete(proof); }
            catch (error) {
                quarantine(serial);
                error.details = { ...error.details, ownerReleased: Boolean(server?.recoverOwner), recovered: false };
                throw error;
            }
        }
        uncertain.delete(serial);
        servers.delete(serial);
        invalidate(serial);
        return pendingInput ? { ...owner, inputRecovery: { state: 'reset', proof: 'same_device_new_boot' } } : owner;
    }
    return Object.freeze({ get, peek: serial => servers.get(serial), start, call, stop, stopAll, recover,
        quarantine, assertCertain, record, isUncertain: serial => uncertain.has(serial),
        hasUncertain: () => uncertain.size > 0 || Boolean(inputRecovery()?.serials().length),
        uncertainSerials: () => [...new Set([...uncertain, ...(inputRecovery()?.serials() || [])])].sort() });
}

module.exports = { createUiSessions };
