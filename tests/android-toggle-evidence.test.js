'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { traceEventLimit } = require('../modules/services/androidTaskBudget');
const { toggleWorld, response } = require('./helpers/android-toggle-world.cjs');
let evidence;
test.before(async () => {
    const world = await toggleWorld({ decide: (_, questions) => response(questions, 'escalate') });
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
async function store(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toggle-evidence-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { directory, store: createTaskTraceStore({ directory }) };
}
const header = (e = fixture()) => ({ schemaVersion: 1, taskId: e.taskId, serial: e.scope.serial, package: e.scope.package,
    intent: 'set_toggle', inputRefs: ['checked'], decision: 'jev', policyVersion: 'toggle-v1', completionPolicyVersion: 'toggle-completion-v1',
    budget: e.budget, assistance: 'main_agent', toggle: { id: e.completion.id, checked: e.completion.checked } });

test('toggle trace preserves boolean false and binds candidates, feedback and escalation to the declared target', async t => {
    const s = await store(t), e = fixture();
    e.completion.checked = false; e.decisionContext.currentChecked = true; e.decisionContext.desiredChecked = false;
    const trace = await s.store.open(header(e)); t.after(trace.close);
    await trace.append({ type: 'observation', step: 'toggle', observation: e.observation, toggle: { matches: 1, safe: true, checked: false } });
    await trace.append({ type: 'candidates', step: 'toggle', observation: e.observation, candidates: e.candidates, decisionContext: e.decisionContext });
    await trace.append({ type: 'escalation', step: 'toggle', escalation: e });
    await trace.close();
    const rows = (await fs.readFile(path.join(s.directory, `${e.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].toggle.checked, false); assert.equal(rows[1].toggle.checked, false); assert.deepEqual(rows[3].escalation, e);
});

for (const name of ['search-policy', 'search-intent', 'search-completion', 'query-ref', 'search-actions', 'no-goal', 'nonboolean-goal', 'extra-goal', 'two-actions']) test(`toggle header rejects ${name}`, async t => {
    const s = await store(t), h = header();
    if (name === 'search-policy') h.policyVersion = 'search-v9';
    if (name === 'search-intent') h.intent = 'search';
    if (name === 'search-completion') h.completionPolicyVersion = 'search-completion-v2';
    if (name === 'query-ref') h.inputRefs = ['query'];
    if (name === 'search-actions') h.searchActions = { imeAction: 'search' };
    if (name === 'no-goal') delete h.toggle;
    if (name === 'nonboolean-goal') h.toggle.checked = 'false';
    if (name === 'extra-goal') h.toggle.text = 'PRIVATE';
    if (name === 'two-actions') h.budget.maxActions = 2;
    await assert.rejects(s.store.open(h), { code: 'TRACE_INVALID_ARGUMENT' });
});

const eventChanges = {
    'wrong-step': e => { e.step = 'fill'; },
    'other-target': e => { e.candidates[0].targetId = 'com.example:id/other'; },
    'other-command': e => { e.candidates[0].command = 'Fill'; },
    'raw-label': e => { e.candidates[0].text = 'PRIVATE'; },
    'extra-candidate': e => { e.candidates.push({ ...e.candidates[0], candidateId: 'c1' }); },
    'wrong-goal': e => { e.decisionContext.desiredChecked = false; e.decisionContext.currentChecked = true; },
    'already-satisfied': e => { e.decisionContext.currentChecked = true; },
    'wrong-observation': e => { e.decisionContext.observationId = randomUUID(); },
    'old-feedback': e => { e.decisionContext.version = 'search-feedback-v4'; },
    'search-completion': e => { e.completion = { present: true, containers: 1, items: 0, inputMatched: false, absent: true }; },
};
for (const [name, change] of Object.entries(eventChanges)) test(`toggle candidate event rejects ${name}`, async t => {
    const s = await store(t), e = fixture(), trace = await s.store.open(header(e)); t.after(trace.close);
    const event = { type: 'candidates', step: 'toggle', observation: e.observation, candidates: e.candidates, decisionContext: e.decisionContext }; change(event);
    await assert.rejects(trace.append(event), { code: 'TRACE_INVALID_ARGUMENT' });
});

test('search-v9 cannot ingest toggle observations, candidates or escalation', async t => {
    const s = await store(t), e = fixture(), h = header(e);
    delete h.toggle; Object.assign(h, { intent: 'search', inputRefs: ['query'], policyVersion: 'search-v9', completionPolicyVersion: 'search-completion-v2' });
    const trace = await s.store.open(h); t.after(trace.close);
    for (const event of [{ type: 'observation', step: 'entry', toggle: { matches: 1, safe: true, checked: false } },
        { type: 'candidates', step: 'entry', observation: e.observation, candidates: e.candidates, decisionContext: e.decisionContext },
        { type: 'escalation', step: 'entry', escalation: e }]) await assert.rejects(trace.append(event), { code: 'TRACE_INVALID_ARGUMENT' });
});

test('toggle maximum event allowance retains terminal bytes at maximum observation and model budgets', async t => {
    const s = await store(t), e = fixture(), h = header(e);
    const pkg = `com.${'p'.repeat(196)}`, target = `${pkg}:id/${'t'.repeat(116)}`;
    h.package = pkg; h.toggle.id = target; h.serial = 'S'.repeat(128); e.candidates[0].targetId = target;
    h.budget = { timeoutMs: 300000, maxActions: 1, maxObservations: 256, maxModelCalls: 16 };
    const trace = await s.store.open(h), cap = traceEventLimit(h.budget); t.after(trace.close);
    const event = { type: 'candidates', step: 'toggle', observation: e.observation, candidates: e.candidates, decisionContext: e.decisionContext };
    for (let i = 0; i < cap - 1; i++) await trace.append(event);
    await assert.rejects(trace.append(event), { code: 'TRACE_LIMIT' });
    await trace.append({ type: 'stopped', step: 'toggle', code: 'TASK_BUDGET_EXHAUSTED', outcome: 'failed' }); await trace.close();
    const raw = await fs.readFile(path.join(s.directory, `${h.taskId}.jsonl`));
    assert.equal(raw.toString().trim().split('\n').length, cap + 1); assert.ok(raw.length < 512 * 1024 - 4096);
    t.diagnostic(`toggle capacity fixture: ${raw.length} bytes, ${cap} events, 4096-byte terminal reserve retained`);
});
