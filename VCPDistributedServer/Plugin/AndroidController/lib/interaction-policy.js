'use strict';

/**
 * Pure policy only: the caller must resolve operation and package from trusted context,
 * then recheck immediately before every dispatch. This does not replace system grants.
 * getConfig returns {denyPackages:[], readOnlyPackages:[], confirmEveryWrite:false}
 * or its JSON string. Suggested host key: INTERACTION_POLICY (default '{}').
 * decide/assertAllowed accept {operation:'read'|'write', package?, action?,
 * capability?, control?, controls?}; keyboard/pixel callers supply observed controls.
 * Missing package is denied whenever either package rule list is nonempty.
 * Risk labels are bounded heuristics, not a complete detector of sensitive effects.
 * No approval protocol exists here; model supplied `confirmed` is never accepted.
 */
const { types } = require('node:util');
const { createHash } = require('node:crypto');
const MAX_LABEL_LENGTH = 64;
const MAX_ID_LENGTH = 160;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const CONFIG_KEYS = new Set(['denyPackages', 'readOnlyPackages', 'confirmEveryWrite']);
const REQUEST_KEYS = new Set(['operation', 'package', 'action', 'capability', 'control', 'controls']);

// One vocabulary for observation badges and dispatch decisions. Do not duplicate it.
const RISK_VOCABULARY = Object.freeze([
    Object.freeze({ category: 'payment', words: Object.freeze(['pay', 'payment', 'purchase', 'buy', 'checkout', 'transfer', 'remit', '支付', '付款', '购买', '下单', '转账', '汇款', '充值', '提现']) }),
    Object.freeze({ category: 'communication', words: Object.freeze(['send', 'submit', 'post', 'publish', 'reply', 'forward', 'dial', 'call', 'sms', '发送', '提交', '发布', '回复', '转发', '拨号', '拨打']) }),
    Object.freeze({ category: 'destructive', words: Object.freeze(['delete', 'remove', 'erase', 'wipe', 'reset', 'uninstall', '删除', '移除', '抹除', '清空', '重置', '卸载', '恢复出厂']) }),
    Object.freeze({ category: 'authorization', words: Object.freeze(['allow', 'authorize', 'grant', 'permission', 'install', '允许', '授权', '授予', '权限', '安装']) }),
    Object.freeze({ category: 'account', words: Object.freeze(['login', 'logout', 'signin', 'signout', 'password', 'credential', 'credentials', 'token', '登录', '登入', '退出登录', '注销', '密码', '凭据', '验证码']) }),
    Object.freeze({ category: 'confirmation', words: Object.freeze(['confirm', 'approve', 'accept', '确认', '确定', '同意', '批准']) }),
]);

function invalid(message) { return Object.assign(new Error(`[AndroidController] ${message}`), { code: 'INVALID_ARGUMENT' }); }

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    if (types.isProxy(prototype) || Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    return typeof constructor === 'function' && !types.isProxy(constructor)
        && Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value === prototype
        && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
}

function record(value, allowed) {
    if (!isPlainObject(value)) throw invalid('策略输入必须为纯数据对象。');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value')) throw invalid('策略输入不能含 getter/setter。');
        if (allowed && (typeof key !== 'string' || !allowed.has(key))) throw invalid('策略输入含未知字段。');
    }
    return descriptors;
}
const field = (descriptors, key) => Object.hasOwn(descriptors, key) ? descriptors[key].value : undefined;

function stringField(descriptors, key, max, optional = true) {
    const value = field(descriptors, key);
    if (value === undefined && optional) return '';
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid('策略文本字段类型或长度无效。');
    return value;
}

function packageList(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || types.isProxy(value) || value.length > 1024) throw invalid('包策略必须为包名数组。');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/.test(String(key)) || !Object.hasOwn(descriptors[key], 'value')))) throw invalid('包策略数组含非数据字段。');
    const result = [];
    for (let index = 0; index < value.length; index++) {
        const item = field(descriptors, String(index));
        if (typeof item !== 'string' || item.length > 255 || !PACKAGE.test(item)) throw invalid('包策略含无效包名。');
        result.push(item);
    }
    return result;
}

function configOf(value) {
    if (typeof value === 'string') {
        if (value.length > 262144) throw invalid('策略配置过大。');
        value = JSON.parse(value);
    }
    const descriptors = record(value, CONFIG_KEYS);
    const confirm = field(descriptors, 'confirmEveryWrite');
    if (confirm !== undefined && typeof confirm !== 'boolean') throw invalid('confirmEveryWrite 必须为布尔值。');
    return { denyPackages: packageList(field(descriptors, 'denyPackages')), readOnlyPackages: packageList(field(descriptors, 'readOnlyPackages')), confirmEveryWrite: confirm === true };
}

function tokens(text) {
    return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9\u3400-\u9fff]+/).filter(Boolean);
}

// AOSP SearchView's submit button reads "\u63d0\u4ea4\u67e5\u8be2"/"Submit query" in every app; it runs a
// query, not a send. Only that exact id + stock label pair is exempt; other labels still count.
const SEARCH_SUBMIT_LABELS = new Set(['\u63d0\u4ea4\u67e5\u8be2', 'Submit query']);
function isSearchSubmit(descriptors) {
    const id = field(descriptors, 'id') ?? field(descriptors, 'shortId');
    return typeof id === 'string' && id.split('/').at(-1) === 'search_go_btn';
}

function classifyRisk(control, context = {}) {
    const input = record(context, new Set(['action', 'capability', 'controls']));
    const candidates = [];
    for (const name of ['action', 'capability']) {
        const text = stringField(input, name, MAX_LABEL_LENGTH);
        // EraseText edits a focused field; it is not a business-object erase action.
        if (text && !(name === 'action' && /^erasetext$/i.test(text))) candidates.push(text);
    }
    const controls = field(input, 'controls');
    const selected = [];
    if (control !== undefined && control !== null) selected.push(control);
    if (controls !== undefined) {
        if (!Array.isArray(controls) || types.isProxy(controls) || controls.length > 10000) throw invalid('控件上下文必须为有界纯数据数组。');
        const descriptors = Object.getOwnPropertyDescriptors(controls);
        for (const key of Reflect.ownKeys(descriptors)) {
            if (key === 'length') continue;
            if (!Object.hasOwn(descriptors[key], 'value')) throw invalid('控件上下文含非数据字段。');
            if (descriptors[key].enumerable && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key))) throw invalid('控件上下文含未知字段。');
        }
        for (let index = 0; index < controls.length; index++) {
            if (!Object.hasOwn(descriptors, String(index))) throw invalid('控件上下文不能含空槽。');
            selected.push(descriptors[index].value);
        }
    }
    for (const item of selected) {
        const descriptors = record(item);
        const searchSubmit = isSearchSubmit(descriptors);
        // UI graph has nonenumerable provenance data. Never follow rawNode or value.
        for (const key of ['label', 'desc', 'id', 'shortId']) {
            const text = field(descriptors, key);
            if (text === undefined || text === null) continue;
            if (typeof text !== 'string') throw invalid('控件语义字段必须为字符串。');
            if (searchSubmit && SEARCH_SUBMIT_LABELS.has(text)) continue;
            const max = key === 'id' || key === 'shortId' ? MAX_ID_LENGTH : MAX_LABEL_LENGTH;
            // Ignore an entire long/truncated label, not a prefix that may be chat content.
            if (text.length > max || /[\x00-\x1f\x7f\u2026]/.test(text)) continue;
            candidates.push(key === 'id' || key === 'shortId' ? text.split('/').at(-1) : text);
        }
    }
    const categories = [];
    for (const rule of RISK_VOCABULARY) {
        const matched = candidates.some(text => {
            const parts = tokens(text);
            return rule.words.some(word => /^[a-z]+$/.test(word) ? parts.includes(word) : text.includes(word));
        });
        if (matched) categories.push(rule.category);
    }
    return Object.freeze({ sensitive: categories.length > 0, categories: Object.freeze(categories) });
}

function decision(allowed, code, reasons, risk, needsConfirmation = false) {
    return Object.freeze({ allowed, code, needsConfirmation, reasons: Object.freeze(reasons), risk });
}

function createInteractionPolicy({ getConfig } = {}) {
    if (typeof getConfig !== 'function') throw invalid('策略工厂必须提供 getConfig。');
    function decide(request) {
        let input;
        let risk;
        try {
            input = record(request, REQUEST_KEYS);
            const operation = field(input, 'operation');
            if (operation !== 'read' && operation !== 'write') throw invalid('operation 必须为 read 或 write。');
            risk = classifyRisk(field(input, 'control'), { action: stringField(input, 'action', MAX_LABEL_LENGTH), capability: stringField(input, 'capability', MAX_LABEL_LENGTH), controls: field(input, 'controls') });
            const pkg = stringField(input, 'package', 255);
            if (pkg && !PACKAGE.test(pkg)) throw invalid('目标包名无效。');
            let config;
            try { config = configOf(getConfig()); }
            catch { return decision(false, 'POLICY_CONFIG_INVALID', ['invalidConfig'], risk); }
            if (!pkg && (config.denyPackages.length || config.readOnlyPackages.length)) return decision(false, 'POLICY_DENIED', ['packageUnknown'], risk);
            if (config.denyPackages.includes(pkg)) return decision(false, 'POLICY_DENIED', ['denyPackage'], risk);
            if (operation === 'write' && config.readOnlyPackages.includes(pkg)) return decision(false, 'POLICY_DENIED', ['readOnlyPackage'], risk);
            if (operation === 'write' && (config.confirmEveryWrite || risk.sensitive)) {
                const reasons = [];
                if (config.confirmEveryWrite) reasons.push('confirmEveryWrite');
                if (risk.sensitive) reasons.push('sensitiveOperation');
                return decision(false, 'POLICY_CONFIRMATION_REQUIRED', reasons, risk, true);
            }
            return decision(true, 'POLICY_ALLOWED', [], risk);
        } catch {
            return decision(false, 'INVALID_ARGUMENT', ['invalidRequest'], Object.freeze({ sensitive: false, categories: Object.freeze([]) }));
        }
    }
    function assertAllowed(request) {
        const result = decide(request);
        if (result.allowed) return result;
        const error = Object.assign(new Error('[AndroidController] 交互策略拒绝操作；未派发。'), { code: result.code, needsConfirmation: result.needsConfirmation, details: { policy: result } });
        throw error;
    }
    const fingerprint = () => createHash('sha256').update(JSON.stringify(configOf(getConfig()))).digest('hex');
    return Object.freeze({ decide, assertAllowed, fingerprint });
}

module.exports = { createInteractionPolicy, classifyRisk, RISK_VOCABULARY, MAX_LABEL_LENGTH, MAX_ID_LENGTH };
