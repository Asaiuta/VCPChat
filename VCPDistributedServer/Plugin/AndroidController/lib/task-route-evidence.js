'use strict';
const { deriveUiAutomatorRole } = require('./argent-uiautomator');
const REFS = Object.freeze(['origin', 'destination']);
const editable = a => a.editable === 'true' || deriveUiAutomatorRole(a.class) === 'TextField';
const full = e => Boolean(e?.visible) && e.attrs.enabled === 'true'
    && ['left', 'top', 'right', 'bottom'].every(k => e.visible[k] === e.bounds[k]);
function ancestorsSafe(raw) {
    for (let node = raw; node; node = node.parent) {
        const a = node.attrs || {};
        if (a.enabled === 'false' || a.password === 'true' || a['visible-to-user'] === 'false' || a.displayed === 'false'
            || node !== raw && (editable(a) || a.clickable === 'true' || a.checkable === 'true')) return false;
    }
    return true;
}
function routeEvidence(task, entries, controls) {
    const hits = id => entries.filter(e => e.attrs['resource-id'] === id);
    const form = hits(task.targets.form), fields = Object.fromEntries(REFS.map(ref => [ref, hits(task.targets[ref])])), submit = hits(task.targets.submit);
    const marker = hits(task.completion.id);
    const inside = entry => {
        for (let node = entry?.raw.parent; node; node = node.parent) if (form.length === 1 && node === form[0].raw) return true;
        return false;
    };
    const sameNode = entry => {
        const matches = controls.filter(n => n.id === entry?.attrs['resource-id']);
        return matches.length === 1 && matches[0].rawNode === entry?.raw && matches[0].enabled && matches[0].inViewport;
    };
    const fieldEntries = Object.values(fields).flat();
    const noExtraInputs = entries.every(e => e.attrs.password !== 'true' && (!editable(e.attrs) || fieldEntries.includes(e)));
    const focused = entries.filter(e => e.attrs.focused === 'true');
    const focusRef = focused.length === 0 ? null : focused.length !== 1 ? 'unproven'
        : [...REFS, 'submit'].find(ref => (ref === 'submit' ? submit : fields[ref]).includes(focused[0])) || 'unproven';
    const formSafe = form.length === 1 && full(form[0]) && ancestorsSafe(form[0].raw)
        && !editable(form[0].attrs) && form[0].attrs.clickable !== 'true' && form[0].attrs.checkable !== 'true';
    const proof = Object.fromEntries(REFS.map(ref => {
        const matches = fields[ref], entry = matches[0], a = entry?.attrs;
        const safe = matches.length === 1 && formSafe && inside(entry) && full(entry) && ancestorsSafe(entry.raw) && sameNode(entry)
            && deriveUiAutomatorRole(a.class) === 'TextField' && a.password === 'false' && a.checkable !== 'true' && a.checked !== 'true'
            && a.clickable === 'true' && ['true', 'false'].includes(a.focused) && typeof a.text === 'string';
        return [ref, Object.freeze({ matches: matches.length, safe: Boolean(safe), inputMatched: Boolean(safe && a.text === task.inputs[ref]) })];
    }));
    const button = submit[0];
    const submitSafe = submit.length === 1 && formSafe && inside(button) && full(button) && ancestorsSafe(button.raw) && sameNode(button)
        && button.attrs.clickable === 'true' && !editable(button.attrs) && button.attrs.checkable !== 'true';
    const result = marker[0];
    const resultSafe = marker.length === 1 && full(result) && ancestorsSafe(result.raw)
        && !editable(result.attrs) && result.attrs.clickable !== 'true' && result.attrs.checkable !== 'true';
    return Object.freeze({ formMatches: form.length, formSafe: Boolean(formSafe), noExtraInputs, focusRef,
        fields: Object.freeze(proof), submit: Object.freeze({ matches: submit.length, safe: Boolean(submitSafe) }),
        result: Object.freeze({ matches: marker.length, safe: Boolean(resultSafe) }) });
}
function assertRouteForm(proof, verifiedRefs = []) {
    const stop = code => { throw Object.assign(new Error(code), { code }); };
    if (!proof) stop('TASK_CONTEXT_UNPROVEN');
    if (proof.result.matches) stop('TASK_COMPLETION_PREEXISTS');
    // Missing initial targets may settle, but established progress may never recover
    // through the generic missing-target wait path.
    if (verifiedRefs.some(r => !proof.fields[r].inputMatched)) stop('TASK_PROGRESS_LOST');
    for (const count of [proof.formMatches, ...REFS.map(r => proof.fields[r].matches), proof.submit.matches]) {
        if (count !== 1) stop(count ? 'TASK_TARGET_AMBIGUOUS' : 'TASK_TARGET_MISSING');
    }
    if (!proof.formSafe || !proof.noExtraInputs || !proof.submit.safe || REFS.some(r => !proof.fields[r].safe)) stop('TASK_TARGET_UNSAFE');
    if (proof.focusRef === 'unproven') stop('TASK_FOCUS_UNPROVEN');
}
function routeCompleted(sample) {
    const result = sample.route?.result;
    if (result?.matches > 1) throw Object.assign(new Error('TASK_TARGET_AMBIGUOUS'), { code: 'TASK_TARGET_AMBIGUOUS' });
    return result?.matches === 1 && result.safe === true;
}
module.exports = { REFS, routeEvidence, assertRouteForm, routeCompleted };
