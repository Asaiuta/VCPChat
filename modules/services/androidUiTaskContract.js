'use strict';

const { object, integer } = require('./androidTaskInput');
const { prepareTarget } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/task-ui-target');
const fail = () => { throw Object.assign(new Error('TASK_INVALID'), { code: 'TASK_INVALID' }); };
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const REF = /^[a-z][a-zA-Z0-9_]{0,47}$/;
const OPERATIONS = Object.freeze(['Tap', 'Fill', 'Scroll', 'Back', 'ImeAction', 'LongPress', 'LaunchApp']);
const { UI_TASK_POLICY: POLICY } = require('./androidTaskPolicy');
const LIMITS = Object.freeze({ timeoutMs: 300000, maxActions: 32, maxObservations: 512, maxModelCalls: 64 });
const text = (v, cap) => {
    if (typeof v !== 'string' || v.length > cap || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail();
    return v;
};
function array(value, cap, convert) {
    if (!Array.isArray(value) || value.length > cap || Object.keys(value).length !== value.length) fail();
    return Object.freeze(Array.from({ length: value.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !Object.hasOwn(d, 'value')) fail();
        return convert(d.value);
    }));
}
function prepare(task) {
    if (task.decision !== 'jev') fail();
    if (!text(task.goal, 4000).trim()) fail();
    const allowedPackages = array(task.allowedPackages ?? [task.package], 16, p => {
        if (typeof p !== 'string' || p.length > 200 || !PACKAGE.test(p)) fail();
        return p;
    });
    if (!allowedPackages.includes(task.package) || new Set(allowedPackages).size !== allowedPackages.length) fail();
    const operations = array(task.operations ?? OPERATIONS, OPERATIONS.length, op => { if (!OPERATIONS.includes(op)) fail(); return op; });
    if (new Set(operations).size !== operations.length) fail();
    const keys = Reflect.ownKeys(task.inputs ?? {});
    if (keys.length > 8 || keys.some(k => typeof k !== 'string' || !REF.test(k) || ['constructor', 'prototype', '__proto__'].includes(k))) fail();
    const inputs = Object.freeze(Object.fromEntries(Object.entries(object(task.inputs ?? {}, keys)).map(([k, v]) => [k, text(v, 2000)])));
    const target = value => prepareTarget(value, { package: task.package, allowedPackages });
    const matchText = value => {
        const p = object(value, ['id', 'selector', 'package', 'equals', 'inputRef', 'normalize', 'stripPrefix']);
        if ((p.equals === undefined) === (p.inputRef === undefined)) fail();
        if (p.inputRef !== undefined && !Object.hasOwn(inputs, p.inputRef)) fail();
        if (p.normalize !== undefined && p.normalize !== 'NFC_trim') fail();
        if (p.stripPrefix !== undefined) text(p.stripPrefix, 32);
        return Object.freeze({ ...target(p), ...(p.equals !== undefined ? { equals: text(p.equals, 2000) } : { inputRef: p.inputRef }),
            ...(p.normalize ? { normalize: p.normalize } : {}), ...(p.stripPrefix ? { stripPrefix: p.stripPrefix } : {}) });
    };
    let completion = null;
    if (task.completion !== undefined && task.completion !== null) {
        const c = object(task.completion, ['all']);
        const all = array(c.all, 16, value => {
            const p = object(value, ['type', 'id', 'selector', 'package', 'text', 'checked', 'fields']);
            if (p.type === 'text' && Object.keys(p).every(k => ['type', 'text'].includes(k))) return Object.freeze({ type: p.type, text: matchText(p.text) });
            if (p.type === 'row' && Object.keys(p).every(k => ['type', 'id', 'selector', 'package', 'fields'].includes(k))) {
                const fields = array(p.fields, 8, matchText);
                const ids = fields.filter(f => f.id).map(f => f.id);
                if (!fields.length || new Set(ids).size !== ids.length) fail();
                return Object.freeze({ type: p.type, ...target(p), fields });
            }
            if (['visible', 'absent', 'checked'].includes(p.type) && Object.keys(p).every(k => ['type', 'id', 'selector', 'package', 'checked'].includes(k))
                && (p.type === 'checked' ? typeof p.checked === 'boolean' : p.checked === undefined)) {
                return Object.freeze({ type: p.type, ...target(p), ...(p.type === 'checked' ? { checked: p.checked } : {}) });
            }
            fail();
        });
        if (!all.length) fail();
        completion = Object.freeze({ all });
    }
    const loading = task.loading === undefined ? null : target(object(task.loading, ['id', 'selector', 'package']));
    const raw = object(task.budget ?? {}, Object.keys(LIMITS));
    const defaults = { timeoutMs: 120000, maxActions: 16, maxObservations: 256, maxModelCalls: 32 };
    const budget = Object.freeze(Object.fromEntries(Object.entries(LIMITS).map(([k, max]) => [k, integer(raw[k], defaults[k], 1, max)])));
    return { goal: task.goal, allowedPackages, operations, inputs, completion, loading, budget,
        longPressMs: integer(task.longPressMs, 1000, 500, 5000) };
}
module.exports = { prepare, POLICY, LIMITS, OPERATIONS, REF };
