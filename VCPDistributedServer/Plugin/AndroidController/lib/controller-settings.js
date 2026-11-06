'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const dotenv = require('dotenv');
const { replaceFile } = require('../../../../modules/utils/atomicReplace');
const { configSchema } = require('../plugin-manifest.json');
const { createInteractionPolicy } = require('./interaction-policy');

// Native settings only. Display preferences have their own live, atomic store.
const KEYS = Object.freeze(['AUTO_WAKE', 'INTERACTION_POLICY', 'CLIPBOARD_PASTE',
    'ADB_PATH', 'DEVICE_SERIAL', 'ADB_TIMEOUT_MS', 'UI_SERVER', 'DISPLAY_PORT',
    'STREAM_FORMAT', 'STREAM_CAPTURE_MODE', 'STREAM_QUALITY', 'STREAM_INTERVAL_MS', 'STREAM_MAX_WIDTH']);
const RANGES = { ADB_TIMEOUT_MS: [100, 300000], DISPLAY_PORT: [0, 65535],
    STREAM_QUALITY: [10, 95], STREAM_INTERVAL_MS: [20, 5000], STREAM_MAX_WIDTH: [180, 2160] };
const CHOICES = { CLIPBOARD_PASTE: ['keyevent', 'rpc', 'off'], STREAM_FORMAT: ['jpeg', 'png'], STREAM_CAPTURE_MODE: ['auto', 'png'] };
const failure = (code, message) => Object.assign(new Error(message), { code });
const revision = text => createHash('sha256').update(text).digest('hex');

function normalize(key, value, fromFile = false) {
    if (key === 'INTERACTION_POLICY' && typeof value === 'string' && value.length <= 262144) {
        try {
            createInteractionPolicy({ getConfig: () => value }).fingerprint();
            return JSON.stringify(JSON.parse(value));
        } catch { throw failure('INVALID_CONTROLLER_SETTINGS', '应用交互策略无效，请检查包名和确认选项。'); }
    }
    if (configSchema[key].type === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (fromFile && /^(true|false|on|off|1|0)$/i.test(String(value))) return /^(true|on|1)$/i.test(String(value));
    } else if (RANGES[key]) {
        const number = fromFile && /^\d+$/.test(String(value)) ? Number(value) : value;
        const [min, max] = RANGES[key];
        if (Number.isSafeInteger(number) && number >= min && number <= max) return number;
    } else if (typeof value === 'string' && value.length <= 4096
        && !/[\x00-\x1f\x7f]/.test(value)) {
        if (CHOICES[key]?.includes(value)) return value;
        if (key === 'ADB_PATH' && !value.includes('"')) return value.trim();
        if (key === 'DEVICE_SERIAL' && (!value || /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,159}$/.test(value))
            && !['constructor', 'prototype', '__proto__'].includes(value)) return value;
    }
    throw failure('INVALID_CONTROLLER_SETTINGS', `${key} 的值无效，请检查范围或格式。`);
}

function valuesOf(source) {
    return Object.fromEntries(KEYS.map(key => [key, normalize(key, source[key] ?? configSchema[key].default, true)]));
}

function encode(value) {
    if (typeof value !== 'string') return String(value);
    const quote = ["'", '`', '"'].find(char => !value.includes(char));
    if (!quote) throw failure('INVALID_CONTROLLER_SETTINGS', '路径包含不支持的引号。');
    return `${quote}${value}${quote}`;
}

function patchEnv(source, patch) {
    // Same assignment grammar as dotenv, including quoted multiline values.
    const assignment = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?[ \t]*(?:#.*)?\r?$/mg;
    const remaining = new Set(Object.keys(patch));
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    let next = source.replace(assignment, (whole, key) => {
        if (!Object.hasOwn(patch, key)) return whole;
        if (!remaining.delete(key)) return '';
        const prefix = whole.match(/^\s*/)[0].replace(/[^\r\n]/g, '');
        return `${prefix}${key}=${encode(patch[key])}${whole.endsWith('\r') ? '\r' : ''}`;
    });
    if (remaining.size) next += (next && !next.endsWith('\n') ? eol : '')
        + [...remaining].map(key => `${key}=${encode(patch[key])}${eol}`).join('');
    const parsed = dotenv.parse(next);
    for (const [key, value] of Object.entries(patch)) {
        if (normalize(key, parsed[key], true) !== value) throw failure('INVALID_CONTROLLER_SETTINGS', '配置编码校验失败，未保存。');
    }
    return next;
}

class ControllerSettings {
    constructor({ file, effective = {}, write = replaceFile }) {
        this.file = file;
        this.effective = { ...effective };
        this.write = write;
        this.queue = Promise.resolve();
    }
    async source() {
        try {
            const stat = await fs.stat(this.file);
            if (stat.size > 1048576) throw new Error('控制器配置超过 1MB');
            return await fs.readFile(this.file, 'utf8');
        } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    }
    snapshot(source) {
        const current = valuesOf(this.effective);
        const values = valuesOf({ ...this.effective, ...dotenv.parse(source) });
        return { ok: true, values, revision: revision(source),
            pendingRestart: KEYS.filter(key => key === 'INTERACTION_POLICY'
                ? createInteractionPolicy({ getConfig: () => values[key] }).fingerprint() !== createInteractionPolicy({ getConfig: () => current[key] }).fingerprint()
                : values[key] !== current[key]) };
    }
    async read() { await this.queue.catch(() => {}); return this.snapshot(await this.source()); }
    save(request, { assertCurrent = () => {} } = {}) {
        const operation = this.queue.catch(() => {}).then(async () => {
            if (!request || typeof request !== 'object' || Array.isArray(request)
                || Object.keys(request).some(key => !['revision', 'values'].includes(key))
                || typeof request.revision !== 'string' || !request.values || typeof request.values !== 'object' || Array.isArray(request.values)) {
                throw failure('INVALID_CONTROLLER_SETTINGS', '控制器设置请求无效。');
            }
            const patch = {};
            for (const key of Object.keys(request.values)) {
                if (!KEYS.includes(key)) throw failure('INVALID_CONTROLLER_SETTINGS', '包含不支持的配置项。');
                patch[key] = normalize(key, request.values[key]);
            }
            if (!Object.keys(patch).length) throw failure('INVALID_CONTROLLER_SETTINGS', '没有要保存的配置。');
            assertCurrent();
            const source = await this.source();
            if (revision(source) !== request.revision) throw failure('CONTROLLER_SETTINGS_CONFLICT', '配置已被其他窗口修改，请重新读取后再保存。');
            const next = patchEnv(source, patch);
            assertCurrent();
            await this.write(this.file, next);
            return { ...this.snapshot(next), saved: true };
        });
        this.queue = operation;
        return operation;
    }
    async flush() { await this.queue.catch(() => {}); }
}

module.exports = { ControllerSettings, KEYS };
