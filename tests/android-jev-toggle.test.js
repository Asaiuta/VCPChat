'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toggleWorld, spec, response, id } = require('./helpers/android-toggle-world.cjs');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { projectEvidence, createTaskExecutionOptions } = require('../../VCPToolBox/modules/androidTaskReplanner');
const advice = (p, extra = {}) => ({ schemaVersion: 1, taskId: p.taskId, observationId: p.observationId, action: 'select', candidateId: 'c0', ...extra });

for (const desired of [true, false]) for (const already of [false, true]) test(`set checked=${desired}, already=${already}: independently verified exact effect`, async t => {
    const w = await toggleWorld({ checked: already ? desired : !desired, noModel: already }); t.after(w.close);
    const r = await w.run({ inputs: { checked: desired }, ...(already ? { budget: { maxModelCalls: 0 } } : {}) });
    assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.equal(w.state.checked, desired); assert.equal(w.state.otherChecked, false);
    assert.equal(w.state.actions.length, already ? 0 : 1); assert.equal(r.counts.modelCalls, already ? 0 : 1);
    assert.equal(r.receipts.length, already ? 0 : 1); assert.equal(r.counts.verifiedActions, already ? 0 : 1);
    assert.equal(r.decisionPolicy.version, 'toggle-v1'); assert.equal(r.decisionPolicy.calibrated, false);
    // The outer receipt has no public dispatched boolean. Actual XML state,
    // RPC writes and owned child receipts are the independent write evidence.
    assert.equal(w.execution.outcome, 'verified');
    if (!already) assert.deepEqual(w.state.actions[0], { method: 'click', params: [50, 55] });
    const rows = await w.trace(); assert.equal(rows[0].completionPolicyVersion, 'toggle-completion-v1');
    assert.deepEqual(rows[0].toggle, { id: id('notifications'), checked: desired });
    assert.equal(rows.at(-1).type, 'completed');
    assert.ok(rows.filter(e => e.type === 'observation' && e.toggle.checked === desired).length >= 2);
    assert.doesNotMatch(JSON.stringify([rows, w.state.models, w.state.questions, r]), /Private setting|Private label|android.widget|clock 0/);
});

test('toggle task is immutable, data-only, boolean-specific and cannot supply search scope or completion', () => {
    const original = spec(), prepared = prepareTask(original); original.inputs.checked = false; original.targets.toggle = id('other');
    assert.deepEqual(prepared.completion, { type: 'checked', id: id('notifications'), checked: true });
    assert.ok(Object.isFrozen(prepared.inputs) && Object.isFrozen(prepared.targets));
    for (const extra of [ { decision: 'rules' }, { decision: 'shadow' }, { decision: undefined }, { completion: undefined },
        { completion: { type: 'checked', id: id('other'), checked: false } }, { loading: { id: id('loading') } },
        { searchActions: { back: { from: id('from'), target: id('target') } } }, { inputs: { checked: 'false' } },
        { inputs: { checked: null } }, { inputs: {} }, { inputs: { checked: true, query: 'private' } },
        { targets: { toggle: 'other.app:id/toggle' } }, { targets: { toggle: id('x'), other: id('y') } },
        { budget: { maxActions: 2 } }, { budget: { maxObservations: 3 } } ]) assert.throws(() => prepareTask(spec(extra)), { code: 'TASK_INVALID' });
    let reads = 0; const inputs = {}; Object.defineProperty(inputs, 'checked', { get() { reads++; return true; }, enumerable: true });
    assert.throws(() => prepareTask(spec({ inputs })), { code: 'TASK_INVALID' }); assert.equal(reads, 0);
});

for (const kind of ['missing-checked', 'invalid-checked', 'not-checkable', 'not-clickable', 'disabled', 'hidden', 'partial', 'duplicate',
    'hidden-duplicate', 'password', 'editable', 'textfield', 'hidden-parent', 'disabled-parent', 'clickable-parent', 'checkable-parent']) {
    test(`${kind} raw toggle cannot authorize a model call or write`, async t => {
        const w = await toggleWorld({ xml(tree) {
            const node = tree.match(/<node[^>]*\/>/)[0];
            if (kind === 'missing-checked') return tree.replace(' checked="false"', '');
            if (kind === 'invalid-checked') return tree.replace('checked="false"', 'checked="0"');
            if (kind === 'not-checkable') return tree.replace('checkable="true"', 'checkable="false"');
            if (kind === 'not-clickable') return tree.replace('clickable="true"', 'clickable="false"');
            if (kind === 'disabled') return tree.replace('enabled="true"', 'enabled="false"');
            if (kind === 'hidden') return tree.replace('checked="false"', 'checked="false" visible-to-user="false"');
            if (kind === 'partial') return tree.replace('[10,40][90,70]', '[-10,40][90,70]');
            if (kind === 'duplicate' || kind === 'hidden-duplicate') return tree.replace('</hierarchy>', node.replace('checked="false"', `checked="false"${kind === 'hidden-duplicate' ? ' visible-to-user="false"' : ''}`) + '</hierarchy>');
            if (kind === 'password' || kind === 'editable') return tree.replace('checked="false"', `checked="false" ${kind}="true"`);
            if (kind === 'textfield') return tree.replace('android.widget.Switch', 'android.widget.EditText');
            const attr = { 'hidden-parent': 'visible-to-user="false"', 'disabled-parent': 'enabled="false"', 'clickable-parent': 'clickable="true"', 'checkable-parent': 'checkable="true"' }[kind];
            return tree.replace(node, `<node package="com.example" class="android.widget.FrameLayout" bounds="[0,0][100,200]" ${attr}>${node}</node>`);
        } }); t.after(w.close);
        const r = await w.run(); assert.equal(r.status, 'stopped'); assert.equal(w.state.actions.length, 0); assert.equal(r.counts.modelCalls, 0);
        assert.ok(['TASK_TARGET_UNSAFE', 'TASK_TARGET_AMBIGUOUS', 'TASK_CONTEXT_UNPROVEN'].includes(r.code), r.code);
    });
}

for (const kind of ['no-effect', 'other-target', 'revert', 'missing-state', 'unsettled']) test(`${kind} after dispatch stops without replay or assistance`, async t => {
    let readsAfter = 0, assists = 0;
    const w = await toggleWorld({ click(s) {
        if (kind === 'other-target') s.otherChecked = true;
        else if (kind !== 'no-effect') s.checked = true;
        return true;
    }, onCapture(s) {
        if (!s.actions.length) return;
        readsAfter++;
        if (kind === 'revert' && readsAfter > 1) s.checked = false;
        if (kind === 'unsettled') s.version++;
    }, xml: (tree, s) => kind === 'missing-state' && s.actions.length ? tree.replace(' checked="true"', '') : tree }); t.after(w.close);
    const r = await w.run({ assistance: 'main_agent', budget: { maxObservations: 18 } }, { androidTaskReplan() { assists++; } });
    assert.equal(r.status, 'stopped'); assert.equal(r.counts.actionAttempts, 1); assert.equal(w.state.actions.length, 1);
    assert.equal(assists, 0); assert.equal(r.counts.verifiedActions, 0); assert.equal(r.receipts.length, 1);
    assert.equal(r.receipts[0].outcome, 'unknown');
});

for (const kind of ['observation', 'dispatch', 'third-stale']) test(`${kind} stale preserves one-write allowance and history`, async t => {
    let pending = false, afterDecision = 0;
    const w = await toggleWorld({ decide(_m, q, s) {
        if (kind === 'third-stale' || s.models.length === 1) {
            if (kind === 'dispatch') { pending = true; afterDecision = 0; } else s.version++;
        }
        return response(q, 'c0');
    }, onCapture(s) { if (pending && ++afterDecision === 2) { s.version++; pending = false; } } }); t.after(w.close);
    const r = await w.run();
    assert.equal(r.status, kind === 'third-stale' ? 'stopped' : 'completed', JSON.stringify(r));
    assert.equal(r.counts.staleEvents, kind === 'third-stale' ? 3 : 1);
    assert.equal(w.state.actions.length, kind === 'third-stale' ? 0 : 1);
    if (kind === 'third-stale') assert.equal(r.code, 'TASK_STALE_LIMIT');
    if (kind === 'dispatch') { assert.equal(r.counts.actionAttempts, 2); assert.deepEqual(r.receipts.map(r => r.outcome), ['failed', 'verified']); }
});

test('changed state during model latency completes after fresh stable reads without a compensating tap', async t => {
    const w = await toggleWorld({ decide(_m, q, s) { s.checked = true; return response(q, 'c0'); } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, 'completed', r.code); assert.equal(w.state.actions.length, 0); assert.equal(r.counts.staleEvents, 1);
});

for (const kind of ['invalid', 'wait', 'wrong-key', 'low-confidence', 'unavailable', 'model-budget']) test(`${kind} cannot dispatch a toggle`, async t => {
    const w = await toggleWorld({ noModel: kind === 'unavailable', decide(_m, q) {
        if (kind === 'invalid') return {};
        if (kind === 'wrong-key') return { answers: { old: { probabilities: { c0: 1, escalate: 0 } } } };
        if (kind === 'wait') { const r = response(q, 'c0'); r.answers[Object.keys(q)[0]].probabilities.wait = 0; return r; }
        return { answers: { [Object.keys(q)[0]]: { probabilities: { c0: 0.5, escalate: 0.5 } } } };
    } }); t.after(w.close);
    const r = await w.run(kind === 'model-budget' ? { budget: { maxModelCalls: 0 } } : {});
    assert.equal(r.status, 'stopped'); assert.equal(w.state.actions.length, 0);
    assert.equal(r.code, kind === 'low-confidence' ? 'TASK_JEV_UNCERTAIN' : kind === 'unavailable' ? 'TASK_JEV_UNAVAILABLE'
        : kind === 'model-budget' ? 'TASK_BUDGET_EXHAUSTED' : 'TASK_JEV_INVALID');
});

test('actual main Agent adapter projects boolean evidence and selects the existing candidate through mocked fetch', async t => {
    let calls = 0;
    const w = await toggleWorld({ decide: (_m, q) => response(q, 'escalate') }); t.after(w.close);
    const options = createTaskExecutionOptions({ apiUrl: 'https://offline.invalid', apiKey: 'unused', model: 'main-model', async fetch(_url, request) {
        calls++; const body = JSON.parse(request.body), e = JSON.parse(body.messages[1].content);
        assert.equal(body.model, 'main-model'); assert.equal(e.intent, 'set_toggle'); assert.equal(e.completion.checked, true);
        assert.equal(e.decisionContext.currentChecked, false); assert.doesNotMatch(request.body, /Private setting|Private label|android.widget/);
        return { ok: true, text: async () => JSON.stringify({ model: 'main-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(advice(e)) } }] }) };
    } });
    const r = await w.run({ assistance: 'main_agent' }, options);
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(calls, 1); assert.equal(r.counts.mainModelRequests, 1);
    assert.equal(w.state.actions.length, 1); assert.equal(r.counts.mainModelCalls, 1);
});

for (const mode of ['main_agent', 'human']) test(`${mode} reobserve can finish a manually satisfied toggle without input`, async t => {
    let w;
    w = await toggleWorld({ decide: (_m, q) => response(q, 'escalate'), services: { humanInteraction: { request: async () => { w.state.checked = true; return true; } } } }); t.after(w.close);
    const r = await w.run({ assistance: mode }, { androidTaskReplan: async p => { w.state.checked = true; return advice(p, { action: 'reobserve', candidateId: undefined }); } });
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(w.state.actions.length, 0); assert.equal(r.counts.modelCalls, 1);
    assert.equal(r.counts.humanHandoffs + r.counts.mainModelCalls, 1);
});

for (const kind of ['missing-service', 'reject-human', 'wrong-target', 'wrong-value', 'wrong-observation', 'stop', 'second-assistance']) test(`${kind} assistance stops without writes`, async t => {
    const w = await toggleWorld({ decide: (_m, q) => response(q, 'escalate'), services: { humanInteraction: { request: async () => false } } }); t.after(w.close);
    const r = await w.run({ assistance: kind === 'reject-human' ? 'human' : 'main_agent' }, kind === 'missing-service' ? {} : { androidTaskReplan: async p => advice(p,
        kind === 'wrong-target' ? { candidateId: 'c1' } : kind === 'wrong-value' ? { checked: false } : kind === 'wrong-observation' ? { observationId: 'stale' }
            : { action: kind === 'stop' ? 'stop' : 'reobserve', candidateId: undefined }) });
    assert.equal(r.status, 'stopped'); assert.equal(w.state.actions.length, 0);
    assert.equal(r.code, ({ 'missing-service': 'TASK_ASSISTANCE_UNAVAILABLE', 'reject-human': 'TASK_HANDOFF_REJECTED', stop: 'TASK_ASSISTANCE_STOPPED',
        'second-assistance': 'TASK_ASSISTANCE_LIMIT' })[kind] || 'TASK_REPLAN_INVALID');
    assert.equal((await w.trace()).at(-1).code, r.code);
});

test('unknown RPC effect is retained once and cannot invoke a replanner', async t => {
    let calls = 0;
    const w = await toggleWorld({ click(s) { s.checked = true; throw Error('lost transport private text'); } }); t.after(w.close);
    const r = await w.run({ assistance: 'main_agent' }, { androidTaskReplan() { calls++; } });
    assert.equal(r.status, 'stopped'); assert.equal(w.state.checked, true); assert.equal(w.state.actions.length, 1);
    assert.equal(r.receipts[0].outcome, 'unknown'); assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify([r, await w.trace()]), /lost transport|private text/);
});

test('late Jev answer after its request cap is rejected with no retry', async t => {
    const w = await toggleWorld({ async decide(_m, q, _s, request) {
        assert.ok(request.timeoutMs <= 30000); assert.equal(request.maxRetries, 0);
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
        return response(q, 'c0');
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_JEV_TIMEOUT'); assert.equal(w.state.actions.length, 0);
    assert.equal(r.counts.modelCalls, 1); assert.ok(r.escalation.remaining.timeoutMs > 0);
});

test('low confidence uses the single main Agent without weakening the fixed boolean goal', async t => {
    const w = await toggleWorld({ decide: (_m, q) => ({ answers: { [Object.keys(q)[0]]: { probabilities: { c0: 0.5, escalate: 0.5 } } } }) }); t.after(w.close);
    const r = await w.run({ assistance: 'main_agent' }, { androidTaskReplan: async p => {
        assert.equal(p.evidence.reason, 'TASK_JEV_UNCERTAIN'); assert.equal(projectEvidence(p).completion.checked, true); return advice(p);
    } });
    assert.equal(r.status, 'completed', r.code); assert.equal(w.state.actions.length, 1); assert.equal(r.counts.mainModelCalls, 1);
});

for (const phase of ['initial-stability', 'between-samples', 'model', 'write', 'main_agent', 'human']) test(`${phase} window drift is a hard stop`, async t => {
    let moved = false;
    const w = await toggleWorld({ client: { async probeScreen() {
        const component = `com.example/.${moved ? 'Other' : 'Main'}`;
        return { focus: { package: 'com.example', component, window: `Window{same u0 ${component}}` },
            size: { width: 100, height: 200 }, rotation: 0, displayId: 0, wakefulness: 'Awake', keyguard: { showing: false, inputRestricted: false } };
    } }, onCapture(s) { if (phase === 'initial-stability' && s.captures === 1) moved = true; },
    onTrace(e) { if (phase === 'between-samples' && e.type === 'observation') moved = true; },
    decide(_m, q) { if (phase === 'model') moved = true; return response(q, ['main_agent', 'human'].includes(phase) ? 'escalate' : 'c0'); },
    click(s) { moved = true; s.checked = true; return true; },
    services: { humanInteraction: { request: async () => { moved = true; return true; } } } }); t.after(w.close);
    const r = await w.run({ assistance: ['main_agent', 'human'].includes(phase) ? phase : 'none' },
        { androidTaskReplan: async p => { moved = true; return advice(p); } });
    assert.equal(r.status, 'stopped', JSON.stringify(r));
    assert.equal(r.code, phase === 'initial-stability' ? 'UI_CONTEXT_CHANGED' : 'TASK_CONTEXT_UNPROVEN');
    assert.equal(w.state.actions.length, phase === 'write' ? 1 : 0);
    assert.equal(r.counts.verifiedActions, 0);
    if (phase === 'write') assert.equal(r.receipts[0].outcome, 'unknown');
});

test('postcondition uses the deadline started before dispatch, never a new window after a slow click', async t => {
    const realNow = Date.now; let offset = 0, capturedAtWrite;
    Date.now = () => realNow() + offset;
    const w = await toggleWorld({ click(s) { s.checked = true; capturedAtWrite = s.captures; offset = 6000; return true; } });
    try {
        const r = await w.run();
        assert.equal(r.status, 'stopped'); assert.equal(r.code, 'TASK_NO_PROGRESS');
        assert.equal(w.state.actions.length, 1); assert.equal(r.receipts[0].outcome, 'unknown');
        assert.equal(w.state.captures, capturedAtWrite); // no post-deadline sample is accepted
    } finally { Date.now = realNow; await w.close(); }
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
for (const mode of ['main_agent', 'human', 'model', 'rpc']) test(`${mode} cancellation keeps device leased until dependency drain`, async t => {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    let dependencySignal;
    const block = async signal => { dependencySignal = signal; entered.resolve(); await release.promise; };
    const w = await toggleWorld({ decide: async (_m, q, _s, request) => {
        if (mode === 'model') await block(request.signal);
        return response(q, ['main_agent', 'human'].includes(mode) ? 'escalate' : 'c0');
    }, click: async (s, request) => { s.checked = true; await block(request?.signal); return true; },
    services: { humanInteraction: { request: async request => { await block(request.signal); return true; } } } }); t.after(w.close);
    const running = w.run({ assistance: ['main_agent', 'human'].includes(mode) ? mode : 'none' }, { signal: controller.signal,
        androidTaskReplan: async (p, request) => { await block(request.signal); return advice(p); } }).then(() => assert.fail('cancel must reject'), e => e);
    try {
        await entered.promise; controller.abort();
        assert.equal((await running).code, 'STEP_ABORTED');
        if (mode !== 'rpc') assert.equal(dependencySignal.aborted, true);
        await assert.rejects(w.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
    } finally { release.resolve(); await tick(); await tick(); }
    // Trace close is asynchronous after the lease drains; a read action proves
    // that drain completed before inspecting its final persisted evidence.
    for (let i = 0; i < 30; i++) {
        try { await w.service.processToolCall({ command: 'Observe', serial: 'A' }); break; }
        catch (e) { assert.ok(['DEVICE_BUSY', 'DEVICE_STATE_UNCERTAIN'].includes(e.code), e.code); if (e.code === 'DEVICE_STATE_UNCERTAIN') break; await tick(); }
    }
    assert.equal(w.state.actions.length, mode === 'rpc' ? 1 : 0);
    const rows = await w.trace(); assert.equal(rows.at(-1).type, 'stopped');
});
