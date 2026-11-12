'use strict';

const { parseSelector, evaluateSelector } = require('./selector');
const { deriveUiAutomatorRole } = require('./argent-uiautomator');
const CONDITIONS = ['id', 'text', 'desc', 'class', 'role'];
const RELATIONS = ['within', 'childOf', 'siblingOf', 'hasDescendant'];
const fail = () => { throw Object.assign(new Error('TASK_INVALID'), { code: 'TASK_INVALID' }); };
const resourcePackage = id => typeof id === 'string' ? id.split(':id/')[0] : undefined;

// Completion selectors deliberately exclude ordinals, aggregate labels and
// approximate matching. Use the existing selector engine on original nodes.
function prepareTarget(value, task) {
    const hasId = value.id !== undefined;
    if (hasId === (value.selector !== undefined) || hasId && value.package !== undefined) fail();
    const packageName = hasId ? resourcePackage(value.id) : value.package ?? task.package;
    if (!task.allowedPackages.includes(packageName)) fail();
    const exactId = id => {
        if (typeof id !== 'string' || id.length > 320 || resourcePackage(id) !== packageName
            || !id.startsWith(packageName + ':id/') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id.slice(packageName.length + 4))) fail();
        return id;
    };
    if (hasId) return Object.freeze({ id: exactId(value.id) });
    const copy = (raw, relations) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
        const result = {};
        for (const key of Reflect.ownKeys(raw)) {
            const d = Object.getOwnPropertyDescriptor(raw, key);
            if (typeof key !== 'string' || !d || !Object.hasOwn(d, 'value')) fail();
            if (CONDITIONS.includes(key)) {
                const v = d.value;
                if (typeof v !== 'string' || !v.trim() || v.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(v)) fail();
                result[key] = key === 'id' ? exactId(v) : v;
            } else if (relations && RELATIONS.includes(key)) result[key] = copy(d.value, false);
            else fail();
        }
        if (!CONDITIONS.some(key => Object.hasOwn(result, key))) fail();
        return result;
    };
    let selector;
    try { selector = parseSelector(copy(value.selector, true)); } catch { fail(); }
    return Object.freeze({ selector, package: packageName });
}

function safeEntry(entry) {
    if (!entry?.visible) return false;
    for (let raw = entry.raw; raw; raw = raw.parent) {
        const a = raw.attrs || {};
        if (a.password === 'true' || a.enabled === 'false' || a['visible-to-user'] === 'false' || a.displayed === 'false') return false;
    }
    return true;
}

function createTargetMatcher(task, entries, activePackage = task.package) {
    const controls = entries.map((entry, index) => {
        const a = entry.attrs, fullClass = String(a.class ?? '');
        return { entry, rawNode: entry.raw, index, id: a['resource-id'] ?? '', text: a.text ?? '', desc: a['content-desc'] ?? '',
            fullClass, cls: fullClass.split('.').pop(), role: deriveUiAutomatorRole(fullClass).toLowerCase(), bounds: entry.bounds };
    });
    const byRaw = new Map(controls.map(c => [c.rawNode, c]));
    return (target, subset = entries) => {
        const packageName = target.selector ? target.package ?? task.package : resourcePackage(target.id);
        // Observing another allowed app cannot prove this app's target absent.
        if (packageName !== activePackage) return { complete: false, hits: [] };
        const scopes = controls.filter(c => c.entry.attrs.package === packageName);
        const candidates = subset.map(e => byRaw.get(e.raw)).filter(c => c?.entry.attrs.package === packageName);
        const query = target.selector ?? { id: target.id };
        for (const relation of RELATIONS) {
            if (!query[relation]) continue;
            const anchors = evaluateSelector(scopes, query[relation]);
            if (!anchors.complete || (relation === 'hasDescendant' ? !anchors.hits.length : anchors.hits.length !== 1)
                || anchors.hits.some(c => !safeEntry(c.entry))) return { complete: false, hits: [] };
        }
        const result = evaluateSelector({ controls: candidates, scopeControls: scopes }, query);
        return { complete: result.complete, hits: result.hits.map(c => c.entry) };
    };
}

module.exports = { prepareTarget, createTargetMatcher, safeEntry };
