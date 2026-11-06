'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { replaceFile } = require('../../../../modules/utils/atomicReplace');

const FILE_NAME = 'android-display-preferences.json';
const DEFAULTS = Object.freeze({ maxFps: 30, bitRate: 2000000, maxSize: 540, fitWidth: false });
const invalid = (code, message) => Object.assign(new Error(message), { code });

function validateScrcpyConfig(body) {
    const ranges = { maxFps: [1, 120], bitRate: [100000, 50000000], maxSize: [180, 2160], maxShortEdge: [180, 2160] };
    const fail = message => invalid('INVALID_SCRCPY_CONFIG', message);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('显示配置必须是非空对象');
    const keys = Object.keys(body);
    if (!keys.length) throw fail('显示配置不能为空');
    if (Object.hasOwn(body, 'maxShortEdge') && Object.hasOwn(body, 'maxSize')) {
        throw fail('maxShortEdge 与 maxSize 不能同时提供');
    }
    for (const key of keys) {
        if (!Object.hasOwn(ranges, key)) throw fail(`不支持的显示配置字段：${key}`);
        if (key === 'maxShortEdge' && body[key] === 0) continue;
        const [min, max] = ranges[key];
        if (!Number.isSafeInteger(body[key]) || body[key] < min || body[key] > max) {
            throw fail(`${key} 必须是 ${min}..${max} 范围内的安全整数`);
        }
    }
    return { ...body };
}

function validateFitWidth(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'fitWidth') || typeof body.fitWidth !== 'boolean') {
        throw invalid('INVALID_DISPLAY_PREFERENCES', '显示偏好必须仅包含布尔字段 fitWidth');
    }
    return { fitWidth: body.fitWidth };
}

function validateDocument(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalid('INVALID_DISPLAY_PREFERENCES', '显示偏好文件必须是对象');
    }
    const { fitWidth, ...config } = value;
    validateFitWidth({ fitWidth });
    validateScrcpyConfig(config);
    if (!Object.hasOwn(config, 'maxFps') || !Object.hasOwn(config, 'bitRate')
        || (!Object.hasOwn(config, 'maxSize') && !Object.hasOwn(config, 'maxShortEdge'))) {
        throw invalid('INVALID_DISPLAY_PREFERENCES', '显示偏好文件缺少编码参数或分辨率策略');
    }
    return { ...config, fitWidth };
}

function resolvePreferencesFile(options = {}) {
    const dataDir = options.dataDir || options.appDataRoot || options.services?.loomManager?.appDataRoot
        || options.loomManager?.appDataRoot
        || path.resolve(options.projectBasePath || path.join(__dirname, '../../..'), '..', 'AppData');
    return path.join(path.resolve(dataDir), FILE_NAME);
}

class DisplayPreferences {
    constructor({ file, defaults = DEFAULTS, logger = console } = {}) {
        if (!file) throw new TypeError('显示偏好存储需要文件路径');
        this.file = file;
        this.logger = logger;
        this.value = validateDocument(defaults);
        this.ready = this.read();
        this.queue = this.ready;
    }

    async read() {
        try {
            const stat = await fs.stat(this.file);
            if (stat.size > 4096) throw new Error('显示偏好文件超过 4KB');
            this.value = validateDocument(JSON.parse(await fs.readFile(this.file, 'utf8')));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.warn?.(`[AndroidController] 无法读取显示偏好 ${this.file}，使用安全默认值：${error.message}`);
            }
        }
    }

    async load() {
        await this.ready;
        return this.snapshot();
    }

    snapshot() { return { ...this.value }; }

    async flush() { await this.queue.catch(() => {}); }

    reset({ assertCurrent = () => {} } = {}) {
        return this.update(() => ({ ...DEFAULTS }), assertCurrent);
    }

    updateScrcpy(body, { assertCurrent = () => {} } = {}) {
        const config = validateScrcpyConfig(body);
        return this.update(current => {
            if (Object.hasOwn(config, 'maxSize')) delete current.maxShortEdge;
            if (Object.hasOwn(config, 'maxShortEdge')) delete current.maxSize;
            return { ...current, ...config };
        }, assertCurrent);
    }

    updateFitWidth(body, { assertCurrent = () => {} } = {}) {
        const preferences = validateFitWidth(body);
        return this.update(current => ({ ...current, ...preferences }), assertCurrent);
    }

    update(merge, assertCurrent) {
        const operation = this.queue.catch(() => {}).then(async () => {
            assertCurrent();
            const next = validateDocument(merge(this.snapshot()));
            try {
                await fs.mkdir(path.dirname(this.file), { recursive: true });
                assertCurrent();
                await replaceFile(this.file, `${JSON.stringify(next, null, 2)}\n`);
            } catch (error) {
                if (error.code === 'SCRCPY_CONFIG_CANCELLED' || error.code === 'DISPLAY_PREFERENCES_CANCELLED') throw error;
                throw Object.assign(new Error(`显示偏好保存失败：${error.message}`), {
                    code: 'DISPLAY_PREFERENCES_WRITE_FAILED', cause: error, saved: false,
                });
            }
            this.value = next;
            return this.snapshot();
        });
        this.queue = operation;
        return operation;
    }
}

module.exports = { DisplayPreferences, DEFAULTS, FILE_NAME, resolvePreferencesFile, validateScrcpyConfig, validateFitWidth };
