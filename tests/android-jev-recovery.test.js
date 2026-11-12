'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWorld, spec, response, pkg } = require('./helpers/android-search-world.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const completionWorld = require('./helpers/android-completion-world.cjs');
const fixtures = require('./fixtures/android-jev/cases.json');

for (const scenario of fixtures.cases) test(`offline fixture: ${scenario.name}`, async () => {
    let h, models = 0, lastDispatch = 0, stales = 0;
    if (scenario.world === 'completion') {
        h = await completionWorld.fixture(scenario.options);
        const result = await h.run(completionWorld.spec('jev'));
        assert.equal(result.status, scenario.status, JSON.stringify(result));
        assert.deepEqual(h.writes, scenario.expectedWrites);
        return;
    }
    h = await searchWorld({ decide(_, questions) {
        if (++models <= (scenario.modelStales || 0)) h.change();
        return response(questions, 'c0');
    }, onCapture(_, tools) {
        const count = h?.events.filter(e => e.type === 'action' && e.phase === 'prepared').length || 0;
        if (count > lastDispatch) {
            lastDispatch = count;
            if (stales++ < (scenario.dispatchStales || 0)) tools.change();
        }
    } });
    const result = (await h.run()).details.task;
    assert.equal(result.status, scenario.status, JSON.stringify(result));
    assert.equal(result.code, scenario.code || null);
    assert.deepEqual(h.actions.map(a => a.target), scenario.expectedWrites);
    assert.equal(result.counts.modelCalls, scenario.modelCalls);
    assert.equal(result.counts.staleEvents, scenario.staleEvents);
    assert.equal(result.counts.actions, scenario.expectedWrites.length);
    assert.equal(result.counts.verifiedActions, scenario.expectedWrites.length);
    assert.equal(result.counts.actionAttempts, scenario.expectedWrites.length + (scenario.dispatchStales || 0));
    const recovery = h.events.filter(e => e.type === 'recovery');
    assert.deepEqual(recovery.map(e => e.recovery.consecutive), Array.from({ length: scenario.staleEvents }, (_, i) => i + 1));
    assert.equal(recovery.at(-1).recovery.retryAllowed, scenario.staleEvents < 3);
    assert.equal(new Set(h.events.filter(e => e.type === 'candidates').map(e => e.observation.id)).size, scenario.modelCalls);
    for (const event of recovery.filter(e => e.recovery.reason === 'dispatch_stale')) {
        assert.equal(result.receipts.find(r => r.requestId === event.requestId)?.outcome, 'failed');
    }
});

test('stale after a verified fill resumes submit and never fills twice', async () => {
    let h, stale = 0;
    h = await searchWorld({ start: 'form', decide(state, questions) {
        if (state.step === 'submit' && stale++ < 2) h.change();
        return response(questions, 'c0');
    } });
    const result = (await h.run(spec({ budget: { maxActions: 2 } }))).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(h.actions.map(a => a.target), ['query', 'search_go']);
    assert.equal(result.counts.modelCalls, 4);
    assert.equal(h.values.get('query'), spec().inputs.query);
});

test('only verified progress resets stale; waits retain the consecutive counter', async () => {
    let h, calls = 0;
    h = await searchWorld({ nodes: nodes => calls === 1
        ? [...nodes, { name: 'loading', label: '', kind: 'ProgressBar', clickable: false }] : nodes,
        decide(_, questions) {
        calls++;
        if (calls === 2) return response(questions, 'wait');
        h.change(); return response(questions, 'c0');
    } });
    const result = (await h.run(spec({ loading: { id: `${pkg}:id/loading` } }))).details.task;
    assert.equal(result.code, 'TASK_STALE_LIMIT');
    assert.equal(calls, 4);
    assert.equal(h.actions.length, 0);
    assert.deepEqual(h.events.filter(e => e.type === 'recovery').map(e => e.recovery.consecutive), [1, 2, 3]);
});

test('verified progress resets the stale counter without clearing used actions', async () => {
    let h; const tries = new Map();
    h = await searchWorld({ decide(state, questions) {
        const n = (tries.get(state.step) || 0) + 1; tries.set(state.step, n);
        if (n <= 1) h.change();
        return response(questions, 'c0');
    } });
    const result = (await h.run()).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(h.actions.map(a => a.target), ['open', 'query', 'search_go']);
    assert.deepEqual(h.events.filter(e => e.type === 'recovery').map(e => e.recovery.consecutive), [1, 1, 1]);
});

test('stale uses the original model budget; no fourth call is smuggled through recovery', async () => {
    let h;
    h = await searchWorld({ decide(_, questions) { h.change(); return response(questions, 'c0'); } });
    const result = (await h.run(spec({ budget: { maxModelCalls: 2 } }))).details.task;
    assert.equal(result.code, 'TASK_BUDGET_EXHAUSTED');
    assert.equal(h.models.length, 2);
    assert.equal(h.actions.length, 0);
});

test('a stale-looking error after input dispatch is unknown and never recovered', async () => {
    let attempts = 0;
    const h = await searchWorld({ invoke(method) {
        if (method === 'click') { attempts++; throw Object.assign(Error('private failure'), { code: 'TASK_OBSERVATION_CHANGED', dispatched: true, drained: false }); }
    } });
    const result = (await h.run()).details.task;
    assert.equal(result.status, 'stopped');
    assert.equal(result.receipts[0].outcome, 'unknown');
    assert.equal(result.counts.staleEvents, 0);
    assert.equal(attempts, 1);
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_STATE_UNCERTAIN' });
});

for (const phase of ['model', 'after-recovery']) test(`context drift ${phase} cannot become a stale retry`, async () => {
    let h, moved = false;
    h = await searchWorld({ decide(_, questions) {
        if (phase === 'model') moved = true;
        else h.change();
        return response(questions, 'c0');
    }, probeScreen() {
        if (phase === 'after-recovery' && h?.events.some(e => e.type === 'recovery')) moved = true;
        const component = moved ? `${pkg}/.Other` : `${pkg}/.Main`;
        return { focus: { package: pkg, component, window: `Window{same u0 ${component}}` },
            size: { width: 100, height: 200 }, wakefulness: 'Awake', rotation: 0, displayId: 0,
            keyguard: { showing: false, inputRestricted: false } };
    } });
    const result = (await h.run()).details.task;
    assert.equal(result.code, 'TASK_CONTEXT_UNPROVEN');
    assert.equal(h.models.length, 1);
    assert.equal(h.actions.length, 0);
    assert.equal(result.counts.staleEvents, phase === 'model' ? 0 : 1);
});

test('cancellation after a stale event prevents the next model and keeps earlier effects', async () => {
    const controller = new AbortController(); let h;
    h = await searchWorld({ start: 'form', decide(state, questions) {
        if (state.step === 'submit') h.change();
        return response(questions, 'c0');
    }, onCapture() {
        if (h?.events.some(e => e.type === 'recovery')) controller.abort();
    } });
    await assert.rejects(h.run(spec(), { signal: controller.signal }), { code: 'STEP_ABORTED' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.actions.map(a => a.target), ['query']);
    assert.equal(h.models.length, 2);
});

test('a failed recovery trace prevents new decisions and writes', async () => {
    let h;
    h = await searchWorld({ traceFailAt: 'recovery', decide(_, questions) {
        h.change(); return response(questions, 'c0');
    } });
    const result = (await h.run()).details.task;
    assert.equal(result.code, 'TASK_TRACE_FAILED');
    assert.equal(h.models.length, 1);
    assert.equal(h.actions.length, 0);
});

test('real persisted recovery trace retains failed dispatch and new decision identities', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-stale-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const h = await searchWorld({ traceStore: createTaskTraceStore({ directory }),
        onCapture(n, tools) { if (n === 4) tools.change(); } });
    const result = (await h.run()).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const raw = await fs.readFile(path.join(directory, `${result.taskId}.jsonl`), 'utf8');
    assert.equal(raw.includes(spec().inputs.query), false);
    const rows = raw.trim().split('\n').map(JSON.parse);
    const recovery = rows.find(e => e.type === 'recovery');
    assert.equal(recovery.recovery.reason, 'dispatch_stale');
    const failed = rows.find(e => e.phase === 'settled' && e.requestId === recovery.requestId);
    assert.equal(failed.outcome, 'failed');
    assert.ok(failed.seq < recovery.seq);
    const decisions = rows.filter(e => e.source === 'jev' && e.type === 'decision');
    assert.equal(decisions.length, 4);
    assert.notEqual(decisions[0].observation.id, decisions[1].observation.id);
    assert.ok(decisions[1].seq > recovery.seq);
    assert.equal(rows.at(-1).type, 'completed');
});

test('two final-fence rejections do not consume the two actual actions of a form search', async () => {
    let h, last = 0, changed = 0;
    h = await searchWorld({ start: 'form', onCapture(_, tools) {
        const n = h?.events.filter(e => e.phase === 'prepared').length || 0;
        if (n > last) { last = n; if (changed++ < 2) tools.change(); }
    } });
    const result = (await h.run(spec({ budget: { maxActions: 2 } }))).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.counts.actions, 2);
    assert.equal(result.counts.actionAttempts, 4);
    assert.deepEqual(result.receipts.map(r => r.outcome), ['failed', 'failed', 'verified', 'verified']);
    assert.deepEqual(h.actions.map(a => a.target), ['query', 'search_go']);
});

test('redecision keeps the original deadline even when the next model ignores cancellation', async () => {
    let h, calls = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    h = await searchWorld({ async decide(_, questions) {
        if (++calls === 1) h.change();
        else await gate;
        return response(questions, 'c0');
    } });
    await assert.rejects(h.run(spec({ budget: { timeoutMs: 100 } })), { code: 'STEP_DEADLINE' });
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
    release();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(h.actions.length, 0);
});

test('redecision cannot reset the eight-round loop limit on distinct entry pages', async () => {
    let h, calls = 0;
    h = await searchWorld({ longRoute: true, decide(_, questions) {
        if (++calls === 1) h.change();
        return response(questions, 'c0');
    } });
    const result = (await h.run(spec({ budget: { maxActions: 8, maxModelCalls: 16, maxObservations: 256 } }))).details.task;
    assert.equal(result.code, 'TASK_LOOP_LIMIT');
    assert.equal(calls, 8);
    assert.equal(h.actions.length, 7);
});

test('the old candidate ID cannot execute after candidate identities change', async () => {
    let changed = false;
    const h = await searchWorld({ twoChoices: true, nodes(nodes, page) {
        return changed && page === 'home' ? nodes.filter(n => n.name !== 'open') : nodes;
    }, decide(_, questions) {
        changed = true;
        return response(questions, 'c0');
    } });
    const result = (await h.run()).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(h.actions.map(a => a.target), ['menu_search', 'query', 'search_go']);
    const candidates = h.events.filter(e => e.type === 'candidates');
    assert.equal(candidates[0].candidates[0].targetId, `${pkg}:id/open`);
    assert.equal(candidates[1].candidates[0].targetId, `${pkg}:id/menu_search`);
    assert.equal(result.counts.staleEvents, 1);
});
