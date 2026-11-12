'use strict';
const { requireValid: valid, record, integer, choice, uuid, list, targetId } = require('./androidTaskTraceData');
const { ROUTE_POLICY } = require('./androidTaskPolicy');
const REFS = ['origin', 'destination'];
function refs(value, required = false) {
    const out = list(value, 2, v => choice(v, REFS));
    valid(JSON.stringify(out) === JSON.stringify(REFS.filter(r => out.includes(r))) && (!required || out.length === 2));
    return out;
}
function scope(value, pkg) {
    const keys = ['form', ...REFS, 'submit', 'completion'], data = record(value, keys, keys);
    const out = Object.fromEntries(keys.map(k => {
        valid(typeof data[k] === 'string' && data[k].length <= 320); return [k, targetId(data[k], pkg)];
    }));
    valid(new Set(Object.values(out)).size === 5); return out;
}
function sample(value) {
    const keys = ['formMatches', 'formSafe', 'noExtraInputs', 'focusRef', 'fields', 'submit', 'result'];
    const data = record(value, keys, keys), fields = record(data.fields, REFS, REFS);
    const item = (value, field = false) => {
        const keys = ['matches', 'safe', ...(field ? ['inputMatched'] : [])], v = record(value, keys, keys);
        valid(typeof v.safe === 'boolean' && (!field || typeof v.inputMatched === 'boolean') && (!v.safe || v.matches === 1)
            && (!field || !v.inputMatched || v.safe));
        return { matches: integer(v.matches, 0, 1000), safe: v.safe, ...(field ? { inputMatched: v.inputMatched } : {}) };
    };
    valid(typeof data.formSafe === 'boolean' && typeof data.noExtraInputs === 'boolean' && (!data.formSafe || data.formMatches === 1));
    return { formMatches: integer(data.formMatches, 0, 1000), formSafe: data.formSafe, noExtraInputs: data.noExtraInputs,
        focusRef: choice(data.focusRef, [null, 'unproven', ...REFS, 'submit']),
        fields: Object.fromEntries(REFS.map(r => [r, item(fields[r], true)])), submit: item(data.submit), result: item(data.result) };
}
function context(value) {
    const keys = ['version', 'observationId', 'round', 'verifiedRefs', 'filledRefs', 'focusRef', 'consecutiveStale', 'lastEvent', 'remaining'];
    const data = record(value, keys, keys), verifiedRefs = refs(data.verifiedRefs), filledRefs = refs(data.filledRefs);
    valid(data.version === ROUTE_POLICY.feedbackVersion && filledRefs.every(r => verifiedRefs.includes(r)));
    const caps = { timeoutMs: 300000, actions: 3, observations: 256, modelCalls: 16, rounds: 6, waits: 0 };
    const remaining = record(data.remaining, Object.keys(caps), Object.keys(caps));
    return { version: data.version, observationId: uuid(data.observationId), round: integer(data.round, 1, 6), verifiedRefs, filledRefs,
        focusRef: choice(data.focusRef, [null, ...REFS, 'submit']), consecutiveStale: integer(data.consecutiveStale, 0, 3),
        lastEvent: choice(data.lastEvent, ['initial', 'verified_fill', 'stale_observation', 'stale_dispatch', 'main_agent_reobserve', 'human_reobserve']),
        remaining: Object.fromEntries(Object.entries(caps).map(([k, max]) => [k, integer(remaining[k], 0, max)])) };
}
function candidates(value, pkg) {
    return list(value, 2, (value, i) => {
        const keys = ['candidateId', 'targetId', 'command', 'role', 'inputRef', 'evidenceSources', 'postcondition'];
        const c = record(value, keys, keys), role = choice(c.role, [...REFS, 'submit']), fill = role !== 'submit';
        valid(c.candidateId === `c${i}` && c.command === (fill ? 'Fill' : 'Tap') && c.inputRef === (fill ? role : null)
            && c.postcondition === (fill ? 'route_input_readback' : 'route_result_visible'));
        const sources = list(c.evidenceSources, 1, v => choice(v, ['declared']));
        valid(sources.length === 1 && typeof c.targetId === 'string' && c.targetId.length <= 320);
        return { candidateId: c.candidateId, targetId: targetId(c.targetId, pkg), command: c.command, role, inputRef: c.inputRef,
            evidenceSources: sources, postcondition: c.postcondition };
    });
}
function bindCandidates(step, candidates, decisionContext, declaration) {
    if (!decisionContext) { valid(candidates.length === 0); return; }
    const pending = REFS.filter(r => !decisionContext.verifiedRefs.includes(r));
    const roles = pending.length ? pending : ['submit'];
    valid((step === 'route_fill') === (pending.length > 0) && candidates.length === roles.length);
    candidates.forEach((c, i) => valid(c.role === roles[i] && c.targetId === declaration[c.role]));
}
module.exports = { refs, scope, sample, context, candidates, bindCandidates };
