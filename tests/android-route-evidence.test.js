'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { traceEventLimit } = require('../modules/services/androidTaskBudget');
const { routeWorld, response } = require('./helpers/android-route-world.cjs');
let evidence;
test.before(async () => {
    const world = await routeWorld({ decide: (model, questions) => response(questions,
        model.decisionContext.verifiedRefs.includes('origin') ? 'escalate' : 'c0') });
    try {
        const result = await world.run();
        assert.equal(result.code, 'TASK_ESCALATION_REQUIRED');
        evidence = result.escalation;
    } finally {
        await world.service.cleanup();
        await world.close();
    }
});
const fixture = () => structuredClone(evidence);
const header = e => ({ schemaVersion: 1, taskId: e.taskId, serial: e.scope.serial, package: e.scope.package, intent: 'route_search',
    inputRefs: ['origin', 'destination'], decision: 'jev', policyVersion: 'route-v1', completionPolicyVersion: 'route-completion-v1', budget: e.budget, route: e.route });
async function store(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'route-evidence-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { directory, store: createTaskTraceStore({ directory }) };
}
const candidateEvent = e => ({ type: 'candidates', step: e.step, observation: { ...e.observation, id: e.candidateObservationId }, candidates: e.candidates, decisionContext: e.decisionContext });
test('partial-route production escalation round trips with parameter references and real action receipts', async t => {
    const s = await store(t), e = fixture(), trace = await s.store.open(header(e)); t.after(trace.close);
    await trace.append(candidateEvent(e)); await trace.append({ type: 'escalation', step: e.step, escalation: e }); await trace.close();
    const rows = (await fs.readFile(path.join(s.directory, `${e.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows[2].escalation, e); assert.equal(rows[1].candidates[0].inputRef, 'destination');
});
const headerChanges = {
    'old-policy': h => { h.policyVersion = 'search-v9'; }, 'old-intent': h => { h.intent = 'search'; },
    'old-completion': h => { h.completionPolicyVersion = 'toggle-completion-v1'; }, 'query-ref': h => { h.inputRefs = ['query']; },
    'missing-ref': h => { h.inputRefs = ['origin']; }, 'reordered-refs': h => { h.inputRefs.reverse(); },
    'missing-scope': h => { delete h.route; }, 'extra-input': h => { h.route.text = 'PRIVATE'; },
    'duplicate-id': h => { h.route.origin = h.route.destination; }, 'foreign-id': h => { h.route.form = 'other.app:id/form'; },
    'search-actions': h => { h.searchActions = {}; }, 'toggle': h => { h.toggle = {}; }, 'too-many-actions': h => { h.budget.maxActions = 4; },
};
for (const [name, change] of Object.entries(headerChanges)) test(`route header rejects ${name}`, async t => {
    const s = await store(t), h = header(fixture()); change(h); await assert.rejects(s.store.open(h), { code: 'TRACE_INVALID_ARGUMENT' });
});
const eventChanges = {
    'wrong-ref': e => { e.candidates[0].inputRef = 'origin'; }, 'wrong-role': e => { e.candidates[0].role = 'origin'; },
    'wrong-target': e => { e.candidates[0].targetId = 'com.example:id/route_origin'; },
    'raw-value': e => { e.candidates[0].text = 'PRIVATE'; }, 'wrong-command': e => { e.candidates[0].command = 'Tap'; },
    'old-step': e => { e.step = 'fill'; }, 'wrong-step': e => { e.step = 'route_submit'; },
    'wrong-observation': e => { e.decisionContext.observationId = '11111111-1111-4111-8111-111111111111'; },
    'wrong-progress': e => { e.decisionContext.verifiedRefs = ['origin', 'destination']; }, 'wrong-focus': e => { e.decisionContext.focusRef = 'unknown'; },
    'old-feedback': e => { e.decisionContext.version = 'search-feedback-v4'; }, 'search-completion': e => { e.completion = {}; },
};
for (const [name, change] of Object.entries(eventChanges)) test(`route event rejects ${name}`, async t => {
    const s = await store(t), e = fixture(), trace = await s.store.open(header(e)); t.after(trace.close);
    const event = candidateEvent(e); change(event); await assert.rejects(trace.append(event), { code: 'TRACE_INVALID_ARGUMENT' });
});
test('route action trace cannot swap input reference or completion marker', async t => {
    const s = await store(t), e = fixture(), trace = await s.store.open(header(e)); t.after(trace.close);
    for (const event of [
        { type: 'action', step: 'route_fill', phase: 'prepared', targetId: e.route.origin, inputRef: 'destination' },
        { type: 'action', step: 'route_fill', phase: 'prepared', targetId: e.route.origin },
        { type: 'action', step: 'route_submit', phase: 'prepared', targetId: e.route.submit, expectId: e.route.form },
        { type: 'action', step: 'route_submit', phase: 'prepared', targetId: e.route.submit, inputRef: 'origin' },
    ]) await assert.rejects(trace.append(event), { code: 'TRACE_INVALID_ARGUMENT' });
});
for (const intent of ['search', 'set_toggle']) test(`${intent} trace rejects route evidence and escalation`, async t => {
    const s = await store(t), e = fixture(), h = header(e); delete h.route;
    Object.assign(h, intent === 'search' ? { intent, inputRefs: ['query'], policyVersion: 'search-v9', completionPolicyVersion: 'search-completion-v2' }
        : { intent, inputRefs: ['checked'], policyVersion: 'toggle-v1', completionPolicyVersion: 'toggle-completion-v1',
            toggle: { id: 'com.example:id/toggle', checked: false }, budget: { ...h.budget, maxActions: 1 } });
    const trace = await s.store.open(h); t.after(trace.close);
    for (const event of [candidateEvent(e), { type: 'observation', route: {} }, { type: 'escalation', escalation: e }]) await assert.rejects(trace.append(event), { code: 'TRACE_INVALID_ARGUMENT' });
});
test('maximum route budget fits maximum-length candidate events with terminal reserve', async t => {
    const s = await store(t), e = fixture(), h = header(e), pkg = `com.${'p'.repeat(196)}`;
    h.package = pkg; h.serial = 'S'.repeat(128); h.budget = { timeoutMs: 300000, maxActions: 3, maxObservations: 256, maxModelCalls: 16 };
    h.route = Object.fromEntries(Object.keys(h.route).map((k, i) => [k, `${pkg}:id/${String.fromCharCode(97+i).repeat(116)}`]));
    const event = candidateEvent(e); event.decisionContext.verifiedRefs = []; event.decisionContext.filledRefs = [];
    event.candidates = ['origin', 'destination'].map((role, i) => ({ candidateId: `c${i}`, targetId: h.route[role], command: 'Fill', role, inputRef: role, evidenceSources: ['declared'], postcondition: 'route_input_readback' }));
    const trace = await s.store.open(h); t.after(trace.close); const cap = traceEventLimit(h.budget);
    // Serialization stress envelope, not an executable trajectory: six largest
    // candidate records, 256 observations, two six-receipt escalation packets,
    // then long-ID action records up to the event cap.
    for (let i = 0; i < 6; i++) await trace.append(event);
    const observation = { type: 'observation', step: 'route_fill', observation: e.observation, route: {
        formMatches: 1, formSafe: true, noExtraInputs: true, focusRef: 'destination',
        fields: { origin: { matches: 1, safe: true, inputMatched: true }, destination: { matches: 1, safe: true, inputMatched: false } },
        submit: { matches: 1, safe: true }, result: { matches: 0, safe: false } } };
    for (let i = 0; i < 256; i++) await trace.append(observation);
    Object.assign(e, { budget: h.budget, route: h.route, step: 'route_submit', candidateStep: 'route_submit', completion: { type: 'visible', id: h.route.completion } });
    e.scope.package = h.package; e.scope.serial = h.serial;
    e.decisionContext.verifiedRefs = ['origin', 'destination']; e.decisionContext.filledRefs = ['origin', 'destination'];
    e.candidates = [{ candidateId: 'c0', targetId: h.route.submit, command: 'Tap', role: 'submit', inputRef: null, evidenceSources: ['declared'], postcondition: 'route_result_visible' }];
    const receipt = e.receipts[0];
    e.receipts = Array.from({ length: 6 }, (_, i) => ({ ...receipt, targetId: h.route[i === 5 ? 'destination' : 'origin'], inputRef: i === 5 ? 'destination' : 'origin',
        outcome: i >= 4 ? 'verified' : 'failed', ...(i < 4 ? { code: 'TASK_OBSERVATION_CHANGED' } : {}) }));
    e.progress.verifiedReceiptIndexes = [4, 5]; e.counts.actions = 2; e.counts.verifiedActions = 2; e.counts.actionAttempts = 6;
    for (let i = 0; i < 2; i++) await trace.append({ type: 'escalation', step: 'route_submit', escalation: e });
    for (let i = 264; i < cap - 1; i++) await trace.append({ type: 'action', step: 'route_submit', phase: 'prepared', targetId: h.route.submit, expectId: h.route.completion });
    await assert.rejects(trace.append(observation), { code: 'TRACE_LIMIT' });
    await trace.append({ type: 'stopped', step: 'route_fill', code: 'TASK_BUDGET_EXHAUSTED', outcome: 'failed' }); await trace.close();
    const raw = await fs.readFile(path.join(s.directory, `${h.taskId}.jsonl`)); assert.ok(raw.length < 512 * 1024 - 4096);
    assert.equal(raw.toString().trim().split('\n').length, cap + 1);
    t.diagnostic(`route capacity fixture: ${raw.length} bytes, ${cap} events, 4096-byte terminal reserve retained`);
});
