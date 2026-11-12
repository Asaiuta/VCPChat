'use strict';

const { record, requireValid: valid, integer, choice, uuid, digest, list } = require('./androidTaskTraceData');
const { POLICY, LIMITS, OPERATIONS, REF } = require('./androidUiTaskContract');
const { MODEL_ID, USAGE_KEYS, TRANSPORT_KEYS, transportEvidence } = require('./androidJevEvidence');
const pkg = value => { valid(typeof value === 'string' && value.length <= 200 && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value)); return value; };
const ref = value => { valid(typeof value === 'string' && REF.test(value) && !['constructor', 'prototype', '__proto__'].includes(value)); return value; };
const code = value => { valid(typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)); return value; };
const node = value => { valid(typeof value === 'string' && /^n(?:0|[1-9][0-9]?)$/.test(value)); return value; };
function headerSnapshot(value) {
    const keys = ['schemaVersion', 'taskId', 'serial', 'package', 'intent', 'decision', 'policyVersion', 'completionPolicyVersion',
        'inputRefs', 'budget', 'allowedPackages', 'operations', 'goalSha256', 'contractSha256'];
    const h = record(value, [...keys, 'assistance'], keys);
    const assistance = choice(h.assistance ?? 'none', ['none', 'main_agent', 'human']);
    valid(h.schemaVersion === 1 && h.intent === 'ui_task' && h.decision === 'jev' && h.policyVersion === POLICY.version
        && h.completionPolicyVersion === POLICY.completionVersion);
    valid(typeof h.serial === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(h.serial));
    const b = record(h.budget, Object.keys(LIMITS), Object.keys(LIMITS));
    const packages = list(h.allowedPackages, 16, pkg), ops = list(h.operations, OPERATIONS.length, v => choice(v, OPERATIONS));
    valid(packages.includes(h.package) && new Set(packages).size === packages.length && new Set(ops).size === ops.length);
    const refs = list(h.inputRefs, 8, ref); valid(new Set(refs).size === refs.length);
    return { ...h, assistance, taskId: uuid(h.taskId), package: pkg(h.package), goalSha256: digest(h.goalSha256), contractSha256: digest(h.contractSha256),
        allowedPackages: packages, operations: ops, inputRefs: refs,
        budget: Object.fromEntries(Object.keys(LIMITS).map(k => [k, integer(b[k], 1, LIMITS[k])])) };
}
function action(value, h) {
    const a = record(value, ['command', 'nodeRef', 'inputRef', 'direction', 'imeAction', 'package'], ['command']);
    choice(a.command, [...OPERATIONS, 'Done']);
    valid(a.command === 'Done' || h.operations.includes(a.command));
    const expected = { Done: [], Back: [], LaunchApp: ['package'], Tap: ['nodeRef'], LongPress: ['nodeRef'],
        Fill: ['nodeRef', 'inputRef'], Scroll: ['nodeRef', 'direction'], ImeAction: ['nodeRef', 'imeAction'] }[a.command];
    valid(Object.keys(a).length === expected.length + 1 && expected.every(k => Object.hasOwn(a, k)));
    if (a.nodeRef !== undefined) node(a.nodeRef);
    if (a.inputRef !== undefined) valid(h.inputRefs.includes(ref(a.inputRef)));
    if (a.direction !== undefined) choice(a.direction, ['up', 'down', 'left', 'right']);
    if (a.imeAction !== undefined) choice(a.imeAction, ['search', 'enter']);
    if (a.package !== undefined) valid(h.allowedPackages.includes(pkg(a.package)));
    return { ...a };
}
function model(value) {
    const keys = ['provider', 'requestedModel', 'returnedModel', 'elapsedMs', 'usage'];
    const m = record(value, [...keys, 'transport'], keys);
    valid([null, 'typesafe', 'openrouter'].includes(m.provider));
    for (const k of ['requestedModel', 'returnedModel']) valid(m[k] === null || typeof m[k] === 'string' && MODEL_ID.test(m[k]));
    const u = record(m.usage, USAGE_KEYS, USAGE_KEYS);
    const usage = Object.fromEntries(USAGE_KEYS.map(k => [k, u[k] === null ? null : integer(u[k], 0, 1e9)]));
    const transport = m.transport === undefined ? undefined : list(m.transport, 8, v => {
        const d = record(v, TRANSPORT_KEYS, ['requestId', 'stage', 'elapsedMs']);
        const clean = transportEvidence(d); valid(clean && Object.keys(clean).length === Object.keys(d).length); return clean;
    });
    return { provider: m.provider, requestedModel: m.requestedModel, returnedModel: m.returnedModel,
        elapsedMs: integer(m.elapsedMs, 0, 1e9), usage, ...(transport ? { transport } : {}) };
}
function eventForTask(value, h) {
    const types = {
        observation: ['observation', 'package', 'pageDigest', 'completionMatched'],
        candidates: ['observationId', 'round', 'candidates', 'excludedCount'],
        model: ['observationId', 'modelCalls', 'modelEvidence', 'code'],
        decision: ['observationId', 'choice', 'probability', 'margin', 'code', 'heads'],
        action: ['phase', 'action', 'requestId', 'outcome', 'code'],
        effect: ['requestId', 'changed', 'pageDigest'],
        recovery: ['observationId', 'consecutive', 'reason'],
        wait: ['observationId', 'changed', 'source', 'reason'],
        assistance: ['observationId', 'assistance', 'mainModelRequests', 'modelEvidence', 'code'],
        escalation: ['observationId', 'code', 'remaining'],
        verification: ['observationId', 'matched'],
        completed: ['outcome'], stopped: ['code', 'outcome'] };
    const descriptor = Object.getOwnPropertyDescriptor(value || {}, 'type');
    valid(descriptor && Object.hasOwn(descriptor, 'value') && Object.hasOwn(types, descriptor.value));
    const type = descriptor.value, e = record(value, ['type', ...types[type]], ['type']);
    const out = { type };
    for (const [k, v] of Object.entries(e)) {
        if (k === 'type') continue;
        if (k === 'observation') {
            const o = record(v, ['id', 'digest', 'contextDigest', 'controls'], ['id', 'digest', 'contextDigest', 'controls']);
            out[k] = { id: uuid(o.id), digest: digest(o.digest), contextDigest: digest(o.contextDigest), controls: integer(o.controls, 0, 500) };
        } else if (['observationId', 'requestId'].includes(k)) out[k] = uuid(v);
        else if (k === 'package') { valid(h.allowedPackages.includes(v)); out[k] = pkg(v); }
        else if (k === 'pageDigest') out[k] = digest(v);
        else if (k === 'completionMatched' && v === null) out[k] = null;
        else if (['completionMatched', 'changed', 'matched'].includes(k)) { valid(typeof v === 'boolean'); out[k] = v; }
        else if (k === 'code') out[k] = code(v);
        else if (k === 'modelEvidence') out[k] = model(v);
        else if (k === 'mainModelRequests') out[k] = v === null ? null : integer(v, 0, 1);
        else if (k === 'remaining') {
            const caps = { timeoutMs: h.budget.timeoutMs, actions: h.budget.maxActions,
                observations: h.budget.maxObservations, modelCalls: h.budget.maxModelCalls };
            const r = record(v, Object.keys(caps), Object.keys(caps));
            out[k] = Object.fromEntries(Object.entries(caps).map(([key, cap]) => [key, integer(r[key], 0, cap)]));
        }
        else if (k === 'assistance') {
            const a = record(v, ['mode', 'phase', 'action', 'elapsedMs', 'candidateId'], ['mode', 'phase', 'action', 'elapsedMs']);
            valid(a.mode === h.assistance && ['main_agent', 'human'].includes(a.mode));
            choice(a.phase, ['started', 'settled']); choice(a.action, ['pending', 'select', 'reobserve', 'stop']);
            valid((a.phase === 'started') === (a.action === 'pending'));
            valid(a.action === 'select' ? a.mode === 'main_agent' && /^c(?:0|[1-9][0-9]{0,2})$/.test(a.candidateId)
                : a.candidateId === undefined);
            out[k] = { ...a, elapsedMs: integer(a.elapsedMs, 0, 1e9) };
        }
        else if (k === 'heads') out[k] = list(v, 2, value => {
            const d = record(value, ['head', 'choice', 'probability', 'margin'], ['head', 'choice', 'probability', 'margin']);
            choice(d.head, ['operation', 'target']);
            valid(d.head === 'operation' ? [...OPERATIONS, 'Done', 'wait', 'escalate'].includes(d.choice)
                : typeof d.choice === 'string' && /^(?:c(?:0|[1-9][0-9]{0,2})|escalate)$/.test(d.choice));
            valid([d.probability, d.margin].every(n => Number.isFinite(n) && n >= 0 && n <= 1));
            return { ...d };
        });
        else if (k === 'action') out[k] = action(v, h);
        else if (k === 'candidates') out[k] = list(v, POLICY.maxCandidates, item => {
            const c = record(item, ['candidateId', 'action'], ['candidateId', 'action']);
            valid(/^c(?:0|[1-9][0-9]{0,2})$/.test(c.candidateId)); return { candidateId: c.candidateId, action: action(c.action, h) };
        });
        else if (k === 'choice') { valid(typeof v === 'string' && /^(?:c(?:0|[1-9][0-9]{0,2})|wait|escalate|invalid)$/.test(v)); out[k] = v; }
        else if (['probability', 'margin'].includes(k)) { valid(Number.isFinite(v) && v >= 0 && v <= 1); out[k] = v; }
        else if (k === 'phase') out[k] = choice(v, ['prepared', 'settled']);
        else if (k === 'outcome') out[k] = choice(v, ['verified', 'dispatched', 'unknown', 'failed', 'unverified']);
        else if (k === 'source') out[k] = choice(v, ['host', 'model']);
        else if (k === 'reason') out[k] = choice(v, type === 'wait' ? ['loading', 'page_unsettled', 'model_requested']
            : ['observation_stale', 'dispatch_stale', 'sampling_context_changed']);
        else out[k] = integer(v, 0, k === 'consecutive' ? 3 : k === 'excludedCount' ? 128 : 64);
    }
    if (type === 'action') valid(out.action && out.phase && (out.phase === 'prepared' || out.requestId && out.outcome));
    if (type === 'model') valid(out.observationId && out.modelCalls && out.modelEvidence);
    if (type === 'assistance') valid(out.observationId && out.assistance);
    if (type === 'escalation') valid(out.code && out.remaining);
    if (type === 'wait') valid(out.observationId && typeof out.changed === 'boolean'
        && (out.source === 'host' ? ['loading', 'page_unsettled'].includes(out.reason)
            : out.source === 'model' && out.reason === 'model_requested'));
    if (type === 'observation') valid(out.observation && out.package && out.pageDigest && Object.hasOwn(out, 'completionMatched'));
    if (type === 'candidates') valid(out.observationId && out.candidates && out.round);
    if (['completed', 'stopped'].includes(type)) valid(out.outcome && (type === 'completed' || out.code));
    return out;
}
module.exports = { headerSnapshot, eventForTask };
