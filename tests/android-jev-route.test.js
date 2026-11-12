'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeWorld, spec, response, id, INPUTS } = require('./helpers/android-route-world.cjs');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { projectEvidence, createTaskExecutionOptions } = require('../../VCPToolBox/modules/androidTaskReplanner');
const advice = (p, extra = {}) => ({ schemaVersion: 1, taskId: p.taskId, observationId: p.observationId, action: 'select', candidateId: 'c0', ...extra });
const writes = w => w.state.actions.map(a => a.method === 'click' ? 'submit' : a.ref);

test('matching raw tree cannot overwrite failed RPC Fill readback', async t => {
    const w = await routeWorld({ invoke(method) { if (method === 'getText') return 'wrong RPC value'; } }); t.after(w.close);
    const r = await w.run();
    assert.equal(r.status, 'stopped'); assert.equal(r.code, 'FILL_READBACK_MISMATCH');
    assert.deepEqual(writes(w), ['origin']); assert.equal(r.receipts[0].outcome, 'unknown'); assert.equal(r.counts.verifiedActions, 0);
});

test('verified field disappearing for one sample stops even if it later returns', async t => {
    let remove = false, removed = false;
    const w = await routeWorld({ onTrace(e) { if (e.type === 'action' && e.phase === 'settled') remove = true; }, xml(tree) {
        if (!remove || removed) return tree;
        removed = true; return tree.replace(/<node[^>]*resource-id="com.example:id\/route_origin"[^>]*\/>/, '');
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(removed, true); assert.equal(r.status, 'stopped'); assert.equal(r.code, 'TASK_PROGRESS_LOST');
    assert.deepEqual(writes(w), ['origin']);
});

test('verified field loss at the final write fence cannot become retryable stale', async t => {
    let pending = false, reads = 0, remove = false;
    const w = await routeWorld({ decide(m, q) {
        if (m.decisionContext.round === 2) { pending = true; reads = 0; }
        return response(q, 'c0');
    }, onCapture() { remove = pending && ++reads === 3; if (remove) pending = false; },
    xml(tree) { return remove ? tree.replace(/<node[^>]*resource-id="com.example:id\/route_origin"[^>]*\/>/, '') : tree; } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_PROGRESS_LOST'); assert.equal(r.status, 'stopped');
    assert.deepEqual(writes(w), ['origin']); assert.equal(r.counts.staleEvents, 0); assert.equal(r.receipts.at(-1).outcome, 'failed');
});

for (const first of ['origin', 'destination']) test(`route ${first} first binds exact values and independently verifies submitted pair`, async t => {
    const w = await routeWorld({ decide(m, q) { return response(q, m.candidates.find(c => c.role === first)?.candidateId || 'c0'); } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.deepEqual(w.state.submitted, INPUTS); assert.deepEqual(writes(w), [first, first === 'origin' ? 'destination' : 'origin', 'submit']);
    assert.equal(r.counts.modelCalls, 3); assert.equal(r.counts.verifiedActions, 3); assert.deepEqual(r.receipts.map(r => r.outcome), ['verified', 'verified', 'verified']);
    assert.deepEqual(r.receipts.slice(0, 2).map(r => r.inputRef), writes(w).slice(0, 2));
    const rows = await w.trace(); assert.equal(rows[0].policyVersion, 'route-v1'); assert.equal(rows.at(-1).type, 'completed');
    assert.deepEqual(w.state.models.at(-1).decisionContext.verifiedRefs, ['origin', 'destination']);
    assert.doesNotMatch(JSON.stringify([r, rows, w.state.models, w.state.questions]), /private origin|private destination|Private label|Private result|Clock|android.widget/);
});

for (const prefilled of [['origin'], ['destination'], ['origin', 'destination']]) test(`prefilled ${prefilled.join('/')} is not rewritten`, async t => {
    const w = await routeWorld({ values: Object.fromEntries(prefilled.map(r => [r, INPUTS[r]])) }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, 'completed', JSON.stringify(r)); assert.deepEqual(w.state.submitted, INPUTS);
    assert.deepEqual(writes(w), [...['origin', 'destination'].filter(r => !prefilled.includes(r)), 'submit']);
});

test('equal input strings still retain distinct field roles', async t => {
    const w = await routeWorld(); t.after(w.close); const inputs = { origin: 'same', destination: 'same' };
    const r = await w.run({ inputs }); assert.equal(r.status, 'completed', r.code); assert.deepEqual(w.state.submitted, inputs);
    assert.deepEqual(writes(w), ['origin', 'destination', 'submit']);
});

test('route schema freezes inputs and targets and rejects free parameters, invalid values and incompatible scope', () => {
    const raw = spec(), p = prepareTask(raw); raw.inputs.origin = 'mutated'; raw.targets.origin = id('other');
    assert.equal(p.inputs.origin, INPUTS.origin); assert.equal(p.targets.origin, id('route_origin'));
    for (const change of [{ decision: 'rules' }, { decision: 'shadow' }, { decision: undefined }, { inputs: { origin: 'x' } },
        { inputs: { ...INPUTS, destination: 42 } }, { inputs: { ...INPUTS, query: 'private' } }, { inputs: { ...INPUTS, origin: '  ' } },
        ...['\u0000', '\t', '\n', '\r', '\u007f', '\u0085'].map(control => ({ inputs: { ...INPUTS, origin: `x${control}y` } })),
        { inputs: { ...INPUTS, origin: 'x'.repeat(2001) } },
        { targets: { ...spec().targets, destination: id('route_origin') } }, { targets: { ...spec().targets, form: 'other.app:id/form' } },
        { targets: { ...spec().targets, extra: id('extra') } }, { completion: { ...spec().completion, item: id('item') } },
        { completion: { type: 'visible', id: id('route_origin') } }, { loading: undefined }, { searchActions: {} },
        { budget: { maxActions: 4 } }, { budget: { maxObservations: 7 } }]) assert.throws(() => prepareTask(spec(change)), { code: 'TASK_INVALID' });
    let reads = 0; const inputs = { destination: 'x' }; Object.defineProperty(inputs, 'origin', { get() { reads++; return 'x'; }, enumerable: true });
    assert.throws(() => prepareTask(spec({ inputs })), { code: 'TASK_INVALID' }); assert.equal(reads, 0);
});

for (const kind of ['hidden-duplicate', 'duplicate-submit', 'hidden-form', 'wrong-form', 'password', 'password-missing', 'checked', 'wrong-role', 'disabled', 'partial',
    'clickable-parent', 'extra-field', 'hidden-extra-field', 'hidden-password', 'focus-missing', 'double-focus', 'foreign-focus', 'preexisting-result', 'hidden-result']) {
    test(`${kind} cannot authorize route writes`, async t => {
        const w = await routeWorld({ xml(tree) {
            const field = tree.match(/<node[^>]*resource-id="com.example:id\/route_origin"[^>]*\/>/)[0];
            const submit = tree.match(/<node[^>]*resource-id="com.example:id\/route_go"[^>]*\/>/)[0];
            if (kind === 'hidden-duplicate') return tree.replace('</hierarchy>', field.replace('password="false"', 'password="false" visible-to-user="false"') + '</hierarchy>');
            if (kind === 'duplicate-submit') return tree.replace('</hierarchy>', submit + '</hierarchy>');
            if (kind === 'hidden-form') return tree.replace('class="android.widget.LinearLayout"', 'class="android.widget.LinearLayout" visible-to-user="false"');
            if (kind === 'wrong-form') return tree.replace(field, '').replace('</hierarchy>', field + '</hierarchy>');
            if (kind === 'password') return tree.replace('password="false"', 'password="true"');
            if (kind === 'password-missing') return tree.replace(' password="false"', '');
            if (kind === 'checked') return tree.replace('password="false"', 'password="false" checked="true"');
            if (kind === 'wrong-role') return tree.replace('android.widget.EditText', 'android.widget.TextView');
            if (kind === 'disabled') return tree.replace(field, field.replace('enabled="true"', 'enabled="false"'));
            if (kind === 'partial') return tree.replace('[10,25][90,55]', '[-10,25][90,55]');
            if (kind === 'clickable-parent') return tree.replace('class="android.widget.LinearLayout"', 'class="android.widget.LinearLayout" clickable="true"');
            if (kind === 'focus-missing') return tree.replace(' focused="false"', '');
            if (kind === 'double-focus') return tree.replaceAll('focused="false"', 'focused="true"');
            const attrs = kind.includes('result') ? `resource-id="${id('route_results')}" text="Existing"${kind === 'hidden-result' ? ' visible-to-user="false"' : ''}`
                : kind === 'foreign-focus' ? 'resource-id="com.example:id/foreign" focused="true" text="Focus"'
                    : kind === 'hidden-password' ? 'password="true" visible-to-user="false" text="secret"'
                        : `class="android.widget.EditText" password="false"${kind === 'hidden-extra-field' ? ' visible-to-user="false"' : ''}`;
            return tree.replace('</hierarchy>', `<node package="com.example" enabled="true" bounds="[10,165][90,185]" ${attrs}/></hierarchy>`);
        } }); t.after(w.close);
        const r = await w.run(); assert.equal(r.status, 'stopped', JSON.stringify(r)); assert.equal(w.state.actions.length, 0); assert.equal(r.counts.modelCalls, 0);
        assert.notEqual(r.code, 'TASK_TRACE_FAILED');
    });
}

for (const kind of ['raw-readback', 'wrong-field', 'previous-field-loss', 'result-too-soon']) test(`${kind} stops with unknown effect and never refills`, async t => {
    const w = await routeWorld({ invoke(method, params, s) {
        if (method === 'setText') {
            const ref = params[0].resourceId.endsWith('origin') ? 'origin' : 'destination';
            if (kind === 'raw-readback') return true;
            if (kind === 'wrong-field') { s.values[ref === 'origin' ? 'destination' : 'origin'] = params[1]; return true; }
            s.values[ref] = params[1];
            if (kind === 'previous-field-loss' && ref === 'destination') s.values.origin = 'lost';
            if (kind === 'result-too-soon') s.page = 'results';
            return true;
        }
        if (method === 'getText') return params[0].resourceId.endsWith('origin') ? INPUTS.origin : INPUTS.destination;
    } }); t.after(w.close);
    const r = await w.run({ budget: { maxObservations: 20 } }); assert.equal(r.status, 'stopped');
    assert.deepEqual(writes(w), kind === 'previous-field-loss' ? ['origin', 'destination'] : ['origin']);
    assert.equal(w.state.submitted, null); assert.equal(r.receipts.at(-1).outcome, 'unknown'); assert.notEqual(r.code, 'TASK_TRACE_FAILED');
});

test('actual main Agent adapter selects destination and carries only role-bound evidence', async t => {
    let calls = 0;
    const w = await routeWorld({ decide(m, q) { return response(q, m.decisionContext.round === 1 ? 'escalate' : 'c0'); } }); t.after(w.close);
    const options = createTaskExecutionOptions({ apiUrl: 'https://offline.invalid', apiKey: 'unused', model: 'main', async fetch(_url, request) {
        calls++; const body = JSON.parse(request.body), p = JSON.parse(body.messages[1].content);
        assert.equal(p.intent, 'route_search'); assert.equal(p.candidates[1].role, 'destination');
        assert.doesNotMatch(request.body, /private origin|private destination|Private label/);
        return { ok: true, text: async () => JSON.stringify({ model: 'main', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(advice(p, { candidateId: 'c1' })) } }] }) };
    } });
    const r = await w.run({ assistance: 'main_agent' }, options); assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.equal(calls, 1); assert.deepEqual(writes(w), ['destination', 'origin', 'submit']); assert.equal(r.counts.mainModelRequests, 1);
});

test('sensitive submit label remains subject to the existing policy and is never clicked', async t => {
    const w = await routeWorld({ xml: tree => tree.replace('text="Search routes"', 'text="Submit"') }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'POLICY_CONFIRMATION_REQUIRED');
    assert.deepEqual(writes(w), ['origin', 'destination']); assert.equal(r.receipts.at(-1).outcome, 'failed');
});

for (const kind of ['observation', 'dispatch', 'three-stales', 'after-fill']) test(`${kind} stale preserves field progress and original budgets`, async t => {
    let pending = false, reads = 0;
    const w = await routeWorld({ decide(m, q, s) {
        if (kind === 'three-stales' || (kind === 'after-fill' ? s.models.length === 2 : s.models.length === 1)) {
            if (kind === 'dispatch') { pending = true; reads = 0; } else s.version++;
        }
        return response(q, 'c0');
    }, onCapture(s) { if (pending && ++reads === 2) { pending = false; s.version++; } } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, kind === 'three-stales' ? 'stopped' : 'completed', JSON.stringify(r));
    assert.equal(r.counts.staleEvents, kind === 'three-stales' ? 3 : 1);
    assert.deepEqual(writes(w), kind === 'three-stales' ? [] : ['origin', 'destination', 'submit']);
    if (kind === 'three-stales') assert.equal(r.code, 'TASK_STALE_LIMIT');
    if (kind === 'dispatch') { assert.equal(r.counts.actionAttempts, 4); assert.equal(r.receipts[0].outcome, 'failed'); assert.equal(r.counts.actions, 3); }
});

for (const kind of ['invalid', 'old-answer', 'rebind', 'wait', 'low-confidence']) test(`${kind} model answer cannot authorize an arbitrary field action`, async t => {
    const w = await routeWorld({ decide(_m, q) {
        if (kind === 'invalid') return {};
        const r = response(q, 'c0'), a = r.answers[Object.keys(q)[0]];
        if (kind === 'old-answer') r.answers = { old: a };
        if (kind === 'rebind') a.inputRef = 'destination';
        if (kind === 'wait') a.probabilities.wait = 0;
        if (kind === 'low-confidence') a.probabilities = { c0: 0.5, c1: 0.5, escalate: 0 };
        return r;
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, kind === 'low-confidence' ? 'TASK_JEV_UNCERTAIN' : 'TASK_JEV_INVALID'); assert.deepEqual(writes(w), []);
});

for (const kind of ['missing', 'hidden', 'duplicate', 'editable', 'clickable', 'changing']) test(`${kind} result cannot pass route completion`, async t => {
    const w = await routeWorld({ onCapture(s) { if (kind === 'changing' && s.page === 'results') s.version++; }, xml(tree, s) {
        if (s.page !== 'results') return tree;
        if (kind === 'missing') return tree.replaceAll('route_results', 'other_result');
        if (kind === 'hidden') return tree.replace('text="Private result label"', 'text="Private result label" visible-to-user="false"');
        if (kind === 'duplicate') return tree.replace('</hierarchy>', tree.match(/<node[^>]*\/>/)[0] + '</hierarchy>');
        if (kind === 'editable' || kind === 'clickable') return tree.replace('text="Private result label"', `text="Private result label" ${kind}="true"`);
        return tree;
    } }); t.after(w.close);
    const r = await w.run({ budget: { maxObservations: 35 } }); assert.equal(r.status, 'stopped', JSON.stringify(r));
    assert.deepEqual(writes(w), ['origin', 'destination', 'submit']); assert.equal(r.receipts.at(-1).outcome, 'unknown');
    assert.equal(r.counts.verifiedActions, 2); assert.notEqual(r.code, 'TASK_TRACE_FAILED');
});

for (const phase of ['model', 'fill', 'submit', 'human']) test(`${phase} window drift never verifies an action across contexts`, async t => {
    let moved = false;
    const w = await routeWorld({ client: { async probeScreen() {
        const component = `com.example/.${moved ? 'Other' : 'Main'}`;
        return { focus: { package: 'com.example', component, window: `Window{same u0 ${component}}` }, size: { width: 100, height: 200 },
            rotation: 0, displayId: 0, wakefulness: 'Awake', keyguard: { showing: false, inputRestricted: false } };
    } }, decide(_m, q) { if (phase === 'model') moved = true; return response(q, phase === 'human' ? 'escalate' : 'c0'); },
    invoke(method) { if (phase === 'fill' && method === 'setText' || phase === 'submit' && method === 'click') moved = true; },
    services: { humanInteraction: { request: async () => { moved = true; return true; } } } }); t.after(w.close);
    const r = await w.run({ assistance: phase === 'human' ? 'human' : 'none' }); assert.equal(r.status, 'stopped');
    assert.equal(r.code, 'TASK_CONTEXT_UNPROVEN'); assert.equal(r.counts.verifiedActions, phase === 'submit' ? 2 : 0);
    if (['fill', 'submit'].includes(phase)) assert.equal(r.receipts.at(-1).outcome, 'unknown');
});

for (const mode of ['main_agent', 'human']) for (const change of ['fill-remaining', 'lose-verified']) test(`${mode} after one Fill ${change} keeps verified values binding`, async t => {
    let w, assisted = false;
    const changeState = () => { assisted = true; if (change === 'lose-verified') w.state.values.origin = 'changed'; else w.state.values.destination = INPUTS.destination; };
    w = await routeWorld({ decide(m, q) { return response(q, m.decisionContext.filledRefs.length === 1 && !assisted ? 'escalate' : 'c0'); },
        services: { humanInteraction: { request: async () => { changeState(); return true; } } } }); t.after(w.close);
    const r = await w.run({ assistance: mode }, { androidTaskReplan: async p => {
        assert.deepEqual(projectEvidence(p).decisionContext.filledRefs, ['origin']); changeState(); return advice(p, { action: 'reobserve', candidateId: undefined });
    } });
    assert.equal(r.status, change === 'fill-remaining' ? 'completed' : 'stopped', JSON.stringify(r));
    assert.deepEqual(writes(w), change === 'fill-remaining' ? ['origin', 'submit'] : ['origin']);
    if (change === 'lose-verified') assert.equal(r.code, 'TASK_PROGRESS_LOST');
    assert.equal(r.counts.mainModelCalls + r.counts.humanHandoffs, 1);
});

for (const kind of ['missing', 'stop', 'wrong-candidate', 'rebind', 'wrong-observation', 'repeat', 'human-refuse']) test(`${kind} assistance cannot widen scope`, async t => {
    const w = await routeWorld({ decide: (_m, q) => response(q, 'escalate'), services: { humanInteraction: { request: async () => false } } }); t.after(w.close);
    const r = await w.run({ assistance: kind === 'human-refuse' ? 'human' : 'main_agent' }, kind === 'missing' ? {} : { androidTaskReplan: async p => advice(p,
        kind === 'wrong-candidate' ? { candidateId: 'c7' } : kind === 'rebind' ? { inputRef: 'destination' } : kind === 'wrong-observation' ? { observationId: 'old' }
            : { action: kind === 'stop' ? 'stop' : 'reobserve', candidateId: undefined }) });
    assert.equal(r.code, ({ missing: 'TASK_ASSISTANCE_UNAVAILABLE', stop: 'TASK_ASSISTANCE_STOPPED', repeat: 'TASK_ASSISTANCE_LIMIT', 'human-refuse': 'TASK_HANDOFF_REJECTED' })[kind] || 'TASK_REPLAN_INVALID');
    assert.deepEqual(writes(w), []);
});

for (const kind of ['action', 'observation', 'model', 'unknown']) test(`${kind} limit or unknown stops without replay`, async t => {
    const w = await routeWorld({ invoke(method, params, s) { if (kind === 'unknown' && method === 'setText') { s.values.origin = params[1]; throw Error('lost private response'); } } }); t.after(w.close);
    const r = await w.run({ budget: kind === 'action' ? { maxActions: 1 } : kind === 'observation' ? { maxObservations: 8 }
        : kind === 'model' ? { maxModelCalls: 0 } : {} });
    assert.equal(r.status, 'stopped'); assert.equal(w.state.submitted, null); assert.ok(w.state.actions.length <= 1);
    if (kind === 'unknown') assert.equal(r.receipts[0].outcome, 'unknown'); else assert.equal(r.code, 'TASK_BUDGET_EXHAUSTED');
    assert.notEqual(r.code, 'TASK_TRACE_FAILED');
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
for (const mode of ['main_agent', 'human', 'model', 'rpc']) test(`${mode} cancellation drains before releasing the device`, async t => {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const block = async () => { entered.resolve(); await release.promise; };
    const w = await routeWorld({ decide: async (_m, q) => { if (mode === 'model') await block(); return response(q, ['main_agent', 'human'].includes(mode) ? 'escalate' : 'c0'); },
        invoke: async method => { if (mode === 'rpc' && method === 'setText') await block(); },
        services: { humanInteraction: { request: async () => { await block(); return true; } } } }); t.after(w.close);
    const running = w.run({ assistance: ['main_agent', 'human'].includes(mode) ? mode : 'none' }, { signal: controller.signal,
        androidTaskReplan: async p => { await block(); return advice(p); } }).then(() => assert.fail('cancel must reject'), e => e);
    try {
        await entered.promise; controller.abort(); assert.equal((await running).code, 'STEP_ABORTED');
        await assert.rejects(w.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
    } finally { release.resolve(); await tick(); await tick(); }
    for (let i = 0; i < 30; i++) {
        try { await w.service.processToolCall({ command: 'Observe', serial: 'A' }); break; }
        catch (e) { assert.ok(['DEVICE_BUSY', 'DEVICE_STATE_UNCERTAIN'].includes(e.code), e.code); if (e.code === 'DEVICE_STATE_UNCERTAIN') break; await tick(); }
    }
    assert.equal(w.state.actions.length, mode === 'rpc' ? 1 : 0); assert.equal((await w.trace()).at(-1).type, 'stopped');
});

test('late model answer is rejected at the original per-call deadline', async t => {
    const w = await routeWorld({ async decide(_m, q, _s, request) {
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true })); return response(q, 'c0');
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_JEV_TIMEOUT'); assert.deepEqual(writes(w), []); assert.equal(r.counts.modelCalls, 1);
});

test('low confidence can use one main Agent without changing field bindings', async t => {
    const w = await routeWorld({ decide(m, q) {
        if (m.decisionContext.round > 1) return response(q, 'c0');
        return { answers: { [Object.keys(q)[0]]: { probabilities: { c0: 0.5, c1: 0.5, escalate: 0 } } } };
    } }); t.after(w.close);
    const r = await w.run({ assistance: 'main_agent' }, { androidTaskReplan: async p => {
        assert.equal(projectEvidence(p).reason, 'TASK_JEV_UNCERTAIN'); return advice(p, { candidateId: 'c1' });
    } });
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(r.counts.mainModelCalls, 1);
    assert.deepEqual(writes(w), ['destination', 'origin', 'submit']);
});

for (const change of ['value', 'focus']) test(`submit-time ${change} change is rechecked before dispatch`, async t => {
    let changed = false;
    const w = await routeWorld({ decide(m, q, s) {
        if (m.step === 'route_submit' && !changed) { changed = true; if (change === 'value') s.values.origin = 'lost'; else s.focus = 'submit'; }
        return response(q, 'c0');
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, change === 'value' ? 'stopped' : 'completed', JSON.stringify(r));
    assert.deepEqual(writes(w), change === 'value' ? ['origin', 'destination'] : ['origin', 'destination', 'submit']);
    if (change === 'value') assert.equal(r.code, 'TASK_PROGRESS_LOST'); else assert.equal(r.counts.staleEvents, 1);
});

test('main Agent after an undispatched stale submit preserves both verified fields', async t => {
    let pending = false, reads = 0, stale = false;
    const w = await routeWorld({ decide(m, q) {
        if (m.step === 'route_submit' && !stale) { stale = true; pending = true; reads = 0; return response(q, 'c0'); }
        return response(q, m.step === 'route_submit' ? 'escalate' : 'c0');
    }, onCapture(s) { if (pending && ++reads === 2) { pending = false; s.version++; } } }); t.after(w.close);
    const r = await w.run({ assistance: 'main_agent' }, { androidTaskReplan: async p => {
        const evidence = projectEvidence(p); assert.deepEqual(evidence.decisionContext.verifiedRefs, ['origin', 'destination']);
        assert.equal(evidence.receipts.at(-1).outcome, 'failed'); return advice(p);
    } });
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(r.counts.staleEvents, 1);
    assert.deepEqual(writes(w), ['origin', 'destination', 'submit']); assert.equal(r.counts.actionAttempts, 4);
});

for (const phase of ['fill', 'submit']) test(`slow ${phase} cannot renew its dispatch-time verification deadline`, async () => {
    const realNow = Date.now; let offset = 0, capturedAtWrite;
    Date.now = () => realNow() + offset;
    const w = await routeWorld({ invoke(method, _p, s) {
        if (method === (phase === 'fill' ? 'setText' : 'click')) { capturedAtWrite = s.captures; offset = 6000; }
    } });
    try {
        const r = await w.run(); assert.equal(r.status, 'stopped'); assert.equal(r.receipts.at(-1).outcome, 'unknown');
        assert.equal(r.counts.verifiedActions, phase === 'fill' ? 0 : 2);
        assert.equal(w.state.captures, capturedAtWrite); assert.deepEqual(writes(w), phase === 'fill' ? ['origin'] : ['origin', 'destination', 'submit']);
    } finally { Date.now = realNow; await w.close(); }
});

test('total task deadline rejects a model reply without dispatching', async t => {
    const w = await routeWorld({ async decide(_m, q, _s, request) {
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true })); return response(q, 'c0');
    } }); t.after(w.close);
    await assert.rejects(w.run({ budget: { timeoutMs: 800 } }), { code: 'STEP_DEADLINE' });
    assert.deepEqual(writes(w), []); assert.equal((await w.trace()).at(-1).type, 'stopped');
});
