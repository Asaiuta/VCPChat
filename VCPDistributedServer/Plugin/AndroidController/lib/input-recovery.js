'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { UiServerError } = require('./ui-error');

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => new UiServerError(code, message, { dispatched: false, drained: true });
// A changed boot proves the old input dispatcher is gone. Window/touch dumps and
// owner process exit do not prove its injection verifier has forgotten a DOWN.
function bootIdentity(output) {
    const lines = String(output).trim().split(/\r?\n/);
    if (lines.length !== 2 || !uuid.test(lines[0]) || !/^[a-f0-9]{16}$/.test(lines[1]) || /^0+$/.test(lines[1])) {
        throw fail('INPUT_RECOVERY_UNPROVEN', '无法核验设备启动身份；未派发输入。');
    }
    return { bootId: lines[0], device: digest(lines[1]) };
}
class InputRecovery {
    constructor(directory, readIdentity) { this.directory = directory; this.readIdentity = readIdentity; this.identities = new WeakMap(); this.active = new Set(); }
    file(serial) { return path.join(this.directory, digest(serial) + '.json'); }
    records() {
        let names;
        try { names = fs.readdirSync(this.directory); } catch (e) { if (e.code === 'ENOENT') return []; throw fail('INPUT_RECOVERY_STORE', '无法读取输入隔离记录。'); }
        return names.map(name => {
            try {
                if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error();
                const file = path.join(this.directory, name); if (fs.statSync(file).size > 4096) throw Error();
                const r = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (r.version !== 1 || typeof r.serial !== 'string' || !r.serial || !uuid.test(r.bootId)
                    || !uuid.test(r.token) || !/^[a-f0-9]{64}$/.test(r.device) || this.file(r.serial) !== file) throw Error();
                return r;
            } catch { throw fail('INPUT_RECOVERY_STORE', '输入隔离记录损坏；禁止自动清除或继续写入。'); }
        });
    }
    pending(serial) { return this.records().find(r => r.serial === serial) || null; }
    blocked(serial) { const r = this.pending(serial); return r && !this.active.has(r.token); }
    serials() { return this.records().filter(r => !this.active.has(r.token)).map(r => r.serial); }
    retain(record) { this.active.delete(record.token); }
    async assertWritable(serial) {
        const records = this.records(); if (!records.length) return;
        const now = await this.readIdentity(serial);
        if (records.some(r => r.serial === serial || r.device === now.device)) throw fail('DEVICE_STATE_UNCERTAIN', '存在未恢复的触摸记录；禁止其它输入通道继续写入。');
    }
    async identityFor(owner, serial) {
        if (this.identities.has(owner)) return this.identities.get(owner);
        let identity;
        try { identity = await this.readIdentity(serial); }
        catch { throw fail('INPUT_RECOVERY_UNPROVEN', '无法读取输入恢复身份；未派发输入。'); }
        this.identities.set(owner, identity); return identity;
    }
    begin(serial, identity) {
        if (!identity || !uuid.test(identity.bootId) || !/^[a-f0-9]{64}$/.test(identity.device)) throw fail('INPUT_RECOVERY_UNPROVEN', '缺少输入启动身份；未派发输入。');
        if (this.records().some(r => r.serial === serial || r.device === identity.device)) {
            throw fail('DEVICE_STATE_UNCERTAIN', '输入状态未知；需在设备重启后显式恢复，不能重放原动作。');
        }
        const record = { version: 1, serial, ...identity, token: randomUUID() };
        // Exclusive, synced before dispatch. A host crash leaves a conservative
        // marker; no input text, coordinates, labels or raw Android ID are stored.
        try {
            fs.mkdirSync(this.directory, { recursive: true });
            const fd = fs.openSync(this.file(serial), 'wx', 0o600);
            try { fs.writeFileSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        } catch { throw fail('INPUT_RECOVERY_STORE', '输入隔离记录无法持久化；未派发输入。'); }
        this.active.add(record.token); return record;
    }
    complete(record) {
        // A failed deletion is no longer an in-flight operation. Keep it visible
        // to admission even when this follows a known local rejection.
        this.retain(record);
        const current = this.pending(record.serial);
        if (!current || current.token !== record.token) throw fail('INPUT_RECOVERY_STORE', '输入记录归属已变化；保留隔离。');
        try { fs.unlinkSync(this.file(record.serial)); this.active.delete(record.token); }
        catch { throw fail('INPUT_RECOVERY_STORE', '输入记录无法清除；保留隔离。'); }
    }
    async proveReset(serial) {
        const record = this.pending(serial); if (!record) return null;
        const now = await this.readIdentity(serial);
        if (now.device !== record.device || now.bootId === record.bootId) {
            throw Object.assign(fail('DEVICE_INPUT_STATE_UNCERTAIN', '旧 RPC 可已退出，但输入状态仍未知。请重启原 Android 设备，重新连接后执行 Manage recoverOwner；不要重放原动作。'),
                { details: { inputRecovery: { state: 'unknown', requiresDeviceRestart: true, sameDevice: now.device === record.device } } });
        }
        return record;
    }
}
module.exports = { InputRecovery, bootIdentity };
