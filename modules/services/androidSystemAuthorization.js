'use strict';

const CONSENT_VERSION = 1;
const GROUPS = Object.freeze(['read', 'navigate', 'settings', 'personal', 'communication', 'schedule']);
const own = (value, key) => value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function validateSerial(serial) {
    if (typeof serial !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,159}$/.test(serial)
        || ['constructor', 'prototype', '__proto__'].includes(serial)) {
        throw failure('INVALID_ARGUMENT', '必须指定有效的设备序列号。');
    }
}
class AndroidSystemAuthorization {
    constructor({ settingsManager } = {}) {
        if (typeof settingsManager?.readSettingsStrict !== 'function') throw new TypeError('settingsManager.readSettingsStrict required');
        this.settingsManager = settingsManager;
    }
    async getStatus(serial) {
        validateSerial(serial);
        let settings;
        try { settings = await this.settingsManager.readSettingsStrict(); }
        catch { throw failure('SYSTEM_NOT_AUTHORIZED', '无法读取当前有效授权配置；已拒绝系统能力，不能从旧备份恢复权限。'); }
        const map = settings?.androidSystemAuthorizations;
        const record = own(map, serial) ? map[serial] : null;
        const acknowledged = record?.version === CONSENT_VERSION && record?.acknowledged === true;
        const grants = Object.fromEntries(GROUPS.map(group => [group,
            acknowledged && own(record?.grants, group) && record.grants[group] === true]));
        return { serial, version: CONSENT_VERSION, acknowledged, grants };
    }
    async assertAllowed(serial, group) {
        if (!GROUPS.includes(group)) throw failure('INVALID_ARGUMENT', '未知系统授权类别。');
        const status = await this.getStatus(serial);
        if (!status.grants[group]) throw failure('SYSTEM_NOT_AUTHORIZED', `设备未授权系统能力：${group}。请在“Android 系统授权”设置中确认风险并分项授权。`);
    }
}
module.exports = { AndroidSystemAuthorization, CONSENT_VERSION, GROUPS };
