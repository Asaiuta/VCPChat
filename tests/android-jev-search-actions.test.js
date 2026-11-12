'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { actionWorld } = require('./helpers/android-search-actions-world.cjs');
const { spec, id, response } = require('./helpers/android-search-world.cjs');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { projectEvidence } = require('../../VCPToolBox/modules/androidTaskReplanner');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { randomUUID } = require('node:crypto');

for (const ime of ['enter', 'search']) for (const focused of [false, true]) test(`IME ${ime}, initially focused=${focused}: exact input and independent completion`, async t => {
    const w = await actionWorld({ ime, focused }); t.after(w.close);
    const result = await w.run();
    assert.equal(result.status, 'completed', result.code);
    assert.deepEqual(w.state.actions.map(a => a.command), focused ? ['setText', 'pressKeyCode'] : ['setText', 'click', 'pressKeyCode']);
    assert.deepEqual(w.state.actions.at(-1).params, [ime === 'enter' ? 66 : 84]);
    assert.equal(result.counts.actions, focused ? 2 : 3);
    const rows = await w.trace();
    assert.equal(rows[0].policyVersion, 'search-v9');
    const candidates = rows.filter(r => r.type === 'candidates');
    assert.equal(candidates.at(-1).candidates[0].command, 'ImeAction');
    assert.equal(candidates.at(-1).decisionContext.queryVerified, true);
    assert.equal(candidates.at(-1).decisionContext.version, 'search-feedback-v4');
    assert.doesNotMatch(JSON.stringify([rows, w.state.models]), /private query 731|android.widget|focusedField|editableCount/);
});

for (const scroll of ['Scroll', 'ScrollUntil']) for (const direction of ['up', 'down', 'left', 'right']) test(`${scroll} ${direction}: one physical swipe reveals bound field`, async t => {
    const w = await actionWorld({ scroll, direction }); t.after(w.close);
    const result = await w.run(); assert.equal(result.status, 'completed', result.code);
    assert.deepEqual(w.state.actions.map(a => a.command), ['swipe', 'setText', 'click']);
    assert.equal(result.counts.actions, 3); assert.equal(result.counts.modelCalls, 3);
    assert.equal(w.calls.some(c => c[1] === 'scrollTo'), false);
    const coords = w.state.actions[0].args.slice(3, 7).map(Number);
    if (direction === 'down') assert.ok(coords[1] > coords[3]);
    if (direction === 'up') assert.ok(coords[1] < coords[3]);
    if (direction === 'right') assert.ok(coords[0] > coords[2]);
    if (direction === 'left') assert.ok(coords[0] < coords[2]);
    const history = w.state.models[1].decisionContext;
    assert.equal(history.lastEvent, 'verified_seek');
    assert.deepEqual(history.recentActions[0].parameters, { direction, revealId: id('query') });
    const rows = await w.trace(); assert.equal(rows.some(r => r.type === 'completed'), true);
});

test('already available target skips scrolling; seek, focus and IME compose under original budget', async t => {
    const ready = await actionWorld({ scroll: 'Scroll' }); t.after(ready.close); ready.state.page = 'form';
    assert.equal((await ready.run()).status, 'completed'); assert.equal(ready.state.actions.some(a => a.command === 'swipe'), false);
    const w = await actionWorld({ scroll: 'ScrollUntil', ime: 'search' }); t.after(w.close);
    const result = await w.run(); assert.equal(result.status, 'completed', result.code);
    assert.deepEqual(w.state.actions.map(a => a.command), ['swipe', 'setText', 'click', 'pressKeyCode']);
    assert.equal(result.counts.actions, 4); assert.equal(result.counts.modelCalls, 4);
});

test('search action admission rejects undeclared, cross-package, unsafe shapes and getters before sampling', () => {
    const scroll = { command: 'Scroll', container: id('list'), target: id('query'), direction: 'down' };
    for (const searchActions of [{}, { imeAction: 'done' }, { imeAction: undefined }, { command: 'KeyEvent' },
        { scroll: { ...scroll, target: 'other.app:id/query' } }, { scroll: { ...scroll, target: id('results') } },
        { scroll: { ...scroll, direction: 'diagonal' } }, { scroll: { ...scroll, maxSwipes: 5 } },
        { scroll: { ...scroll, container: id('query') } }]) assert.throws(() => prepareTask(spec({ searchActions })), { code: 'TASK_INVALID' });
    let reads = 0;
    const getter = Object.defineProperty({}, 'imeAction', { enumerable: true, get() { reads++; return 'search'; } });
    assert.throws(() => prepareTask(spec({ searchActions: getter })), { code: 'TASK_INVALID' }); assert.equal(reads, 0);
    assert.throws(() => prepareTask(spec({ decision: 'rules', searchActions: { imeAction: 'search' } })), { code: 'TASK_INVALID' });
});

for (const options of [{ extraField: true }, { duplicate: true }]) test(`IME refuses ambiguous raw input identity ${JSON.stringify(options)}`, async t => {
    const w = await actionWorld({ ime: 'search', ...options }); t.after(w.close);
    const result = await w.run(); assert.equal(result.status, 'stopped');
    assert.deepEqual(w.state.actions, []);
});

test('focus Tap must preserve query and acquire unique focus; wrong high-confidence choice stops unknown', async t => {
    const w = await actionWorld({ ime: 'search', invoke(method, _params, s) {
        if (method === 'click') { s.otherFocus = true; return true; }
    } }); t.after(w.close);
    const result = await w.run();
    assert.equal(result.status, 'stopped'); assert.equal(result.receipts.at(-1).outcome, 'unknown');
    assert.deepEqual(w.state.actions.map(a => a.command), ['setText', 'click']);
});

for (const loss of ['input', 'focus']) test(`${loss} drift at final IME write fence never emits a key`, async t => {
    let armed = 0;
    const w = await actionWorld({ ime: 'search', focused: true,
        decide(model, questions) { if (model.step === 'submit') armed = 1; return response(questions, 'c0'); },
        onCapture(s) { if (armed && ++armed === 3) { if (loss === 'input') s.value = ''; else s.otherFocus = true; } }
    }); t.after(w.close);
    const result = await w.run({ budget: { timeoutMs: 800 } });
    assert.equal(result.status, 'stopped'); assert.equal(w.state.actions.some(a => a.command === 'pressKeyCode'), false);
    assert.ok(result.counts.staleEvents >= 1 || result.code === 'TASK_FOCUS_UNPROVEN');
});

for (const scroll of ['Scroll', 'ScrollUntil']) test(`${scroll}: decoration-only change is not progress and cannot trigger another swipe`, async t => {
    const w = await actionWorld({ scroll, swipe(s) { s.version++; return ''; } }); t.after(w.close);
    const result = await w.run();
    assert.equal(result.status, 'stopped'); assert.equal(result.receipts.at(-1).outcome, 'unknown');
    assert.deepEqual(w.state.actions.map(a => a.command), ['swipe']); assert.equal(result.counts.modelCalls, 1);
});

for (const kind of ['outside', 'edge', 'duplicate', 'password']) test(`scroll target ${kind} cannot prove progress`, async t => {
    const w = await actionWorld({ scroll: 'ScrollUntil', [kind]: true }); t.after(w.close);
    const result = await w.run(); assert.equal(result.status, 'stopped');
    assert.deepEqual(w.state.actions.map(a => a.command), ['swipe']);
    assert.notEqual(result.receipts.at(-1).outcome, 'verified');
});

test('unknown swipe transport failure is never replayed or upgraded', async t => {
    const w = await actionWorld({ scroll: 'Scroll', swipe() { throw Error('offline transport failed'); } }); t.after(w.close);
    const result = await w.run(); assert.equal(result.status, 'stopped');
    assert.equal(result.receipts.at(-1).outcome, 'unknown'); assert.equal(result.counts.mainModelCalls, 0);
    assert.deepEqual(w.state.actions.map(a => a.command), ['swipe']);
});

test('focus consumes original action budget; no hidden submit is appended', async t => {
    const w = await actionWorld({ ime: 'search' }); t.after(w.close);
    const result = await w.run({ budget: { maxActions: 2 } });
    assert.equal(result.code, 'TASK_BUDGET_EXHAUSTED'); assert.deepEqual(w.state.actions.map(a => a.command), ['setText', 'click']);
});

for (const route of ['seek', 'focus', 'submit']) test(`main Agent sees declared ${route} action and verified history without gaining new parameters`, async t => {
    let upgraded = false, projected;
    const w = await actionWorld({ scroll: 'ScrollUntil', ime: 'search', decide(model, questions) {
        if (!upgraded && model.step === route) { upgraded = true; return response(questions, 'escalate'); }
        return response(questions, 'c0');
    } }); t.after(w.close);
    const result = await w.run({ assistance: 'main_agent' }, { androidTaskReplan: async packet => {
        projected = projectEvidence(packet);
        const bad = structuredClone(packet);
        if (route === 'seek') bad.evidence.candidates[0].parameters.direction = 'left';
        else if (route === 'submit') bad.evidence.candidates[0].parameters.imeAction = 'enter';
        else bad.evidence.candidates[0].postcondition = 'completion_visible';
        assert.throws(() => projectEvidence(bad), { code: 'TASK_REPLAN_INVALID' });
        return { schemaVersion: 1, taskId: packet.taskId, observationId: packet.observationId, action: 'select', candidateId: 'c0' };
    } });
    assert.equal(result.status, 'completed', result.code); assert.equal(result.counts.mainModelCalls, 1);
    assert.equal(projected.step, route); assert.equal(projected.searchActions.imeAction, 'search');
    assert.doesNotMatch(JSON.stringify(projected), /private query 731|android.widget/);
});

test('verified focus cannot be replayed after the same field loses focus again', async t => {
    let changed = false;
    const w = await actionWorld({ ime: 'search', decide(model, questions, state) {
        if (model.step === 'submit' && !changed) { state.focused = false; changed = true; }
        return response(questions, 'c0');
    } }); t.after(w.close);
    const result = await w.run(); assert.equal(result.code, 'TASK_NO_PROGRESS');
    assert.deepEqual(w.state.actions.map(a => a.command), ['setText', 'click']);
    assert.equal(result.counts.staleEvents, 1);
});

test('foreign permission window after focus cannot authorize IME', async t => {
    let foreign = false;
    const w = await actionWorld({ ime: 'search', invoke(method) { if (method === 'click') foreign = true; },
        xml(tree) { return foreign ? tree.replaceAll('package="com.example"', 'package="com.android.permissioncontroller"') : tree; } }); t.after(w.close);
    const result = await w.run(); assert.equal(result.status, 'stopped');
    assert.deepEqual(w.state.actions.map(a => a.command), ['setText', 'click']);
    assert.equal(result.receipts.at(-1).outcome, 'unknown');
});

test('cancelled IME retains lease until the in-flight write drains and never submits again', async t => {
    let entered, release;
    const ready = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
    const controller = new AbortController();
    const w = await actionWorld({ ime: 'search', focused: true, async invoke(method) {
        if (method === 'pressKeyCode') { entered(); await gate; return true; }
    } }); t.after(w.close);
    const work = w.run({}, { signal: controller.signal }).then(() => assert.fail('cancellation must reject'), e => e);
    try {
        await ready; controller.abort();
        assert.equal((await work).code, 'STEP_ABORTED');
        await assert.rejects(w.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    // Wait for actual dependency cleanup, with a bounded event-loop drain.
    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 5));
        try { await w.service.processToolCall({ command: 'Observe', serial: 'A' }); break; }
        catch (e) { if (e.code !== 'DEVICE_BUSY') break; if (i === 99) throw e; }
    }
    assert.deepEqual(w.state.actions.map(a => a.command), ['setText', 'pressKeyCode']);
});

test('v6 trace rejects changed action parameters, scope, history and injected text', async t => {
    const w = await actionWorld({ scroll: 'ScrollUntil', ime: 'search' }); t.after(w.close);
    assert.equal((await w.run()).status, 'completed');
    const rows = await w.trace();
    const { type, seq, ...header } = rows[0]; header.taskId = randomUUID();
    const trace = await createTaskTraceStore({ directory: w.directory }).open(header);
    try {
        const { seq: ignored, ...original } = rows.find(r => r.type === 'candidates' && r.step === 'seek');
        let getters = 0;
        for (const mutate of [
            e => { e.candidates[0].parameters.direction = 'left'; },
            e => { e.candidates[0].parameters.revealId = id('other'); },
            e => { e.candidates[0].command = 'Scroll'; },
            e => { e.candidates[0].parameters.maxSwipes = 2; },
            e => { e.candidates[0].parameters.label = 'secret'; },
            e => { e.candidates[0].parameters = Object.defineProperty({}, 'direction', { enumerable: true, get() { getters++; return 'down'; } }); },
            e => { e.decisionContext.recentActions = [{ step: 'seek', command: 'Scroll', targetId: id('other'),
                postcondition: 'search_target_visible', parameters: { direction: 'down', revealId: id('query') } }]; },
        ]) { const e = structuredClone(original); mutate(e); await assert.rejects(trace.append(e), { code: 'TRACE_INVALID_ARGUMENT' }); }
        assert.equal(getters, 0); await trace.append(original);
    } finally { await trace.close(); }
});

for (const kind of ['disabled', 'not-scrollable', 'duplicate', 'foreign']) test(`unproven ${kind} scroll container authorizes zero writes`, async t => {
    const w = await actionWorld({ scroll: 'Scroll', xml(tree) {
        if (kind === 'disabled') return tree.replace('enabled="true" scrollable="true"', 'enabled="false" scrollable="true"');
        if (kind === 'not-scrollable') return tree.replace('scrollable="true"', 'scrollable="false"');
        if (kind === 'foreign') return tree.replace('package="com.example"', 'package="other.app"');
        return tree.replace('</hierarchy>', `<node package="com.example" class="android.widget.ScrollView" resource-id="${id('list')}" scrollable="true" bounds="[0,0][100,200]"/></hierarchy>`);
    } }); t.after(w.close);
    const result = await w.run(); assert.equal(result.status, 'stopped'); assert.deepEqual(w.state.actions, []);
    assert.equal(result.counts.modelCalls, 0);
});
