'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { actionWorld } = require('./helpers/android-search-actions-world.cjs');
const { spec, id, response } = require('./helpers/android-search-world.cjs');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { projectEvidence } = require('../../VCPToolBox/modules/androidTaskReplanner');
const fixture = name => require('./fixtures/android-jev/cases.json').backCases.find(c => c.name === name);
const back = { from: id('placeholder'), target: id('query') };
const commands = w => w.state.actions.map(a => a.command);

test('declared Back reveals the bound field, fills and submits exactly once with persisted evidence', async t => {
    const f = fixture('panel-to-field'), w = await actionWorld(f.options); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, f.status, r.code);
    assert.deepEqual(commands(w), f.expectedWrites);
    assert.equal(r.counts.modelCalls, f.modelCalls); assert.equal(r.counts.verifiedActions, 3);
    const rows = await w.trace(); assert.equal(rows[0].policyVersion, 'search-v9');
    assert.deepEqual(rows[0].searchActions.back, back);
    assert.deepEqual(w.state.models[0].candidates[0].parameters, { key: 'back', revealId: id('query') });
    assert.equal(w.state.models[1].decisionContext.lastEvent, 'verified_back');
    assert.doesNotMatch(JSON.stringify([rows, w.state.models]), /private query 731|Browse|android.widget/);
});

test('Back to a search entry verifies its new form and releases only the temporary target binding', async t => {
    let opened = false;
    const w = await actionWorld({ back: true, invoke(method, _params, s) {
        if (method === 'click' && !opened) { opened = true; s.page = 'form'; return true; }
    }, xml(tree, s) {
        if (s.page === 'form' && !opened) return tree.replace(/<node[^>]*resource-id="com.example:id\/query"[^>]*\/>/,
            `<node package="com.example" class="android.widget.Button" resource-id="${id('open_search')}" text="Search" clickable="true" enabled="true" bounds="[10,40][90,70]"/>`)
            .replace(/<node[^>]*resource-id="com.example:id\/search_go"[^>]*\/>/, '');
        return tree;
    } }); t.after(w.close);
    const r = await w.run({ searchActions: { back: { ...back, target: id('open_search') } } });
    assert.equal(r.status, 'completed', r.code); assert.deepEqual(commands(w), ['back', 'click', 'setText', 'click']);
});

test('Back, focus and IME compose under one original task budget', async t => {
    const f = fixture('panel-to-ime'), w = await actionWorld(f.options); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, f.status, r.code);
    assert.deepEqual(commands(w), f.expectedWrites); assert.equal(r.counts.modelCalls, f.modelCalls);
});

test('Back declaration is immutable, same-package and Jev-only, with no alternate key or completion marker', () => {
    for (const change of [{ from: id('results') }, { target: id('results') }, { from: id('query') },
        { target: 'other.app:id/query' }, { key: 'home' }, { target: undefined }]) {
        assert.throws(() => prepareTask(spec({ searchActions: { back: { ...back, ...change } } })), { code: 'TASK_INVALID' });
    }
    for (const decision of ['rules', 'shadow']) assert.throws(() => prepareTask(spec({ decision, searchActions: { back } })), { code: 'TASK_INVALID' });
    let reads = 0; const unsafe = { ...back }; Object.defineProperty(unsafe, 'target', { get() { reads++; return back.target; }, enumerable: true });
    assert.throws(() => prepareTask(spec({ searchActions: { back: unsafe } })), { code: 'TASK_INVALID' }); assert.equal(reads, 0);
});

test('already available form skips Back and an undeclared panel grants no Back', async t => {
    const form = await actionWorld(); t.after(form.close);
    assert.equal((await form.run({ searchActions: { back } })).status, 'completed');
    assert.deepEqual(commands(form), ['setText', 'click']);
    const panel = await actionWorld({ back: true }); t.after(panel.close);
    assert.equal((await panel.run({ searchActions: undefined })).status, 'stopped'); assert.deepEqual(commands(panel), []);
});

for (const kind of ['disabled', 'hidden', 'partial', 'clickable', 'duplicate', 'clickable-parent', 'hidden-input', 'password', 'checkable', 'target-present']) {
    test(`${kind} source cannot authorize Back`, async t => {
        const w = await actionWorld({ back: true, xml(tree) {
            const marker = tree.match(/<node[^>]*\/>/)[0];
            if (kind === 'disabled') return tree.replace('enabled="true"', 'enabled="false"');
            if (kind === 'hidden') return tree.replace('text="Browse"', 'text="Browse" visible-to-user="false"');
            if (kind === 'partial') return tree.replace('[10,80][90,110]', '[-10,80][90,110]');
            if (kind === 'clickable') return tree.replace('text="Browse"', 'text="Browse" clickable="true"');
            if (kind === 'duplicate') return tree.replace('</hierarchy>', marker + '</hierarchy>');
            if (kind === 'clickable-parent') return tree.replace(marker, `<node package="com.example" class="android.widget.FrameLayout" clickable="true" bounds="[0,0][100,200]">${marker}</node>`);
            const attrs = kind === 'hidden-input' ? 'class="android.widget.EditText" visible-to-user="false"'
                : kind === 'password' ? 'class="android.widget.TextView" password="true"' : kind === 'checkable' ? 'class="android.widget.Switch" checkable="true"'
                    : `class="android.widget.TextView" resource-id="${id('query')}" visible-to-user="false"`;
            return tree.replace('</hierarchy>', `<node package="com.example" enabled="true" bounds="[10,140][90,170]" ${attrs}/></hierarchy>`);
        } }); t.after(w.close);
        const r = await w.run(); assert.equal(r.status, 'stopped'); assert.deepEqual(commands(w), []); assert.equal(r.counts.modelCalls, 0);
    });
}

for (const kind of ['unchanged', 'decoration', 'wrong-target', 'duplicate-target', 'password-target', 'hidden-target', 'source-remains']) {
    test(`${kind} after Back never authorizes a second key or input`, async t => {
        const w = await actionWorld({ back: true, backKey(s) { if (!['unchanged', 'decoration'].includes(kind)) s.page = 'form'; if (kind === 'decoration') s.version++; return ''; },
            xml(tree, s) {
                if (s.page !== 'form') return tree;
                if (kind === 'wrong-target') return tree.replaceAll('id/query', 'id/unrelated');
                if (kind === 'duplicate-target') return tree.replace('</hierarchy>', tree.match(/<node[^>]*resource-id="com.example:id\/query"[^>]*\/>/)[0] + '</hierarchy>');
                if (kind === 'password-target') return tree.replace('password="false"', 'password="true"');
                if (kind === 'hidden-target') return tree.replace('resource-id="com.example:id/query"', 'resource-id="com.example:id/query" visible-to-user="false"');
                if (kind === 'source-remains') return tree.replace('</hierarchy>', `<node package="com.example" class="android.widget.TextView" resource-id="${back.from}" enabled="true" bounds="[0,0][90,20]" text="Panel"/></hierarchy>`);
                return tree;
            } }); t.after(w.close);
        const r = await w.run({ budget: { maxObservations: 256 } });
        assert.equal(r.status, 'stopped'); assert.deepEqual(commands(w), ['back']);
        assert.equal(r.receipts[0].outcome, 'unknown'); assert.equal(r.counts.modelCalls, 1);
    });
}

for (const phase of ['model', 'final-fence']) test(`${phase} stale redecides without sending Back twice`, async t => {
    let changed = false, captureAt;
    const w = await actionWorld({ back: true, decide(model, q, s) {
        if (model.step === 'back' && !changed) {
            changed = true; if (phase === 'model') s.version++; else captureAt = s.captures + 2;
        }
        return response(q, 'c0');
    }, onCapture(s) { if (s.captures === captureAt) s.version++; } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, 'completed', r.code);
    assert.deepEqual(commands(w), ['back', 'setText', 'click']); assert.equal(r.counts.staleEvents, 1); assert.equal(r.counts.modelCalls, 4);
});

test('a returned panel cannot consume another Back after verified navigation', async t => {
    let reset = false;
    const w = await actionWorld({ back: true, decide(model, q, s) {
        if (model.step === 'fill' && !reset) { reset = true; s.page = 'hidden'; }
        return response(q, 'c0');
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_NAVIGATION_REVISITED'); assert.deepEqual(commands(w), ['back']);
});

test('losing the verified target stops before filling another search field', async t => {
    let changed = false;
    const w = await actionWorld({ back: true, decide(model, q) { if (model.step === 'fill') changed = true; return response(q, 'c0'); },
        xml(tree) { return changed ? tree.replaceAll('id/query', 'id/search_input') : tree; } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_PROGRESS_LOST'); assert.deepEqual(commands(w), ['back']);
});

test('Back consumes the original action budget and cannot append a hidden submit', async t => {
    const f = fixture('original-budget'), w = await actionWorld(f.options); t.after(w.close);
    const r = await w.run(f.task); assert.equal(r.code, f.code); assert.equal(r.status, f.status);
    assert.deepEqual(commands(w), f.expectedWrites); assert.equal(r.counts.modelCalls, f.modelCalls);
});

test('an entry that opens the source panel is not verified progress or permission to compensate with Back', async t => {
    let opened = false;
    const w = await actionWorld({ back: true, invoke(method, _params, s) {
        if (method === 'click' && !opened) { opened = true; s.page = 'hidden'; return true; }
    }, xml(tree, s) {
        return !opened && s.page === 'hidden' ? tree.replace('id/placeholder', 'id/open_search').replace('text="Browse"', 'text="Search" clickable="true"') : tree;
    } }); t.after(w.close);
    const r = await w.run({ budget: { maxObservations: 256 } });
    assert.equal(r.status, 'stopped'); assert.deepEqual(commands(w), ['click']); assert.equal(r.receipts[0].outcome, 'unknown');
});

for (const mode of ['main_agent', 'human']) test(`${mode} reobserve keeps the Back scope and verified history`, async t => {
    let upgraded = false, projected;
    const w = await actionWorld({ back: true, services: { humanInteraction: { request: async () => true } }, decide(model, q) {
        if (model.step === 'fill' && !upgraded) { upgraded = true; return response(q, 'escalate'); }
        return response(q, 'c0');
    } }); t.after(w.close);
    const r = await w.run({ assistance: mode }, { androidTaskReplan: async p => {
        projected = projectEvidence(p);
        return { schemaVersion: 1, taskId: p.taskId, observationId: p.observationId, action: 'reobserve' };
    } });
    assert.equal(r.status, 'completed', r.code); assert.deepEqual(commands(w), ['back', 'setText', 'click']);
    if (mode === 'main_agent') { assert.equal(projected.decisionContext.recentActions[0].command, 'KeyEvent'); assert.deepEqual(projected.searchActions.back, back); }
});

test('unknown Back transport is not retried or upgraded', async t => {
    const w = await actionWorld({ back: true, backKey() { throw Error('offline unknown'); } }); t.after(w.close);
    const r = await w.run({ assistance: 'main_agent' });
    assert.equal(r.status, 'stopped'); assert.equal(r.receipts[0].outcome, 'unknown');
    assert.deepEqual(commands(w), ['back']); assert.equal(r.counts.mainModelCalls, 0);
});

for (const kind of ['read-only', 'sensitive']) test(`Back still obeys ${kind} write policy`, async t => {
    const w = await actionWorld({ back: true,
        ...(kind === 'read-only' ? { config: { INTERACTION_POLICY: { readOnlyPackages: ['com.example'] } } }
            : { xml: tree => tree.replace('text="Browse"', 'text="Pay"') }) }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, 'stopped'); assert.deepEqual(commands(w), []);
    assert.ok(['POLICY_DENIED', 'POLICY_CONFIRMATION_REQUIRED'].includes(r.code), r.code);
});

test('main Agent can select only the declared Back candidate before any device input', async t => {
    let first = true;
    const w = await actionWorld({ back: true, decide(_model, q) { const choice = first ? 'escalate' : 'c0'; first = false; return response(q, choice); } }); t.after(w.close);
    const r = await w.run({ assistance: 'main_agent' }, { androidTaskReplan: async p => {
        const e = projectEvidence(p); assert.equal(e.step, 'back'); assert.equal(e.candidates[0].command, 'KeyEvent');
        assert.deepEqual(commands(w), []);
        return { schemaVersion: 1, taskId: p.taskId, observationId: p.observationId, action: 'select', candidateId: 'c0' };
    } });
    assert.equal(r.status, 'completed', r.code); assert.deepEqual(commands(w), ['back', 'setText', 'click']); assert.equal(r.counts.mainModelCalls, 1);
});

test('Back cannot accept a changed Activity or window as its destination', async t => {
    let drift = false;
    const w = await actionWorld({ back: true, backKey(s) { drift = true; s.page = 'form'; return ''; }, client: {
        async probeScreen() { return { focus: { package: 'com.example', component: drift ? 'com.example/.Other' : 'com.example/.Main',
            window: drift ? 'Window{other u0 com.example/.Other}' : 'Window{test u0 com.example/.Main}' },
            size: { width: 100, height: 200 }, wakefulness: 'Awake', rotation: 0, displayId: 0, keyguard: { showing: false, inputRestricted: false } }; }
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, 'stopped'); assert.deepEqual(commands(w), ['back']);
    assert.equal(r.receipts[0].outcome, 'unknown');
});

test('trace rejects changed Back parameters and old policy adoption', async t => {
    const w = await actionWorld({ back: true }); t.after(w.close); assert.equal((await w.run()).status, 'completed');
    const rows = await w.trace(), { seq, type, ...header } = rows[0]; header.taskId = randomUUID();
    await assert.rejects(createTaskTraceStore({ directory: w.directory }).open({ ...header, policyVersion: 'search-v7' }), { code: 'TRACE_INVALID_ARGUMENT' });
    const trace = await createTaskTraceStore({ directory: w.directory }).open(header);
    try {
        const { seq: ignored, ...candidate } = rows.find(r => r.type === 'candidates');
        for (const mutate of [r => { r.candidates[0].parameters.key = 'home'; }, r => { r.candidates[0].parameters.revealId = id('other'); },
            r => { r.candidates[0].targetId = id('other'); }, r => { r.decisionContext.version = 'search-feedback-v3'; }]) {
            const bad = structuredClone(candidate); mutate(bad); await assert.rejects(trace.append(bad), { code: 'TRACE_INVALID_ARGUMENT' });
        }
        await trace.append(candidate);
    } finally { await trace.close(); }
});

test('cancelled Back retains lease until transport drains and does not run the next action', async t => {
    let enter, release; const ready = new Promise(r => { enter = r; }), gate = new Promise(r => { release = r; });
    const controller = new AbortController();
    const w = await actionWorld({ back: true, async backKey() { enter(); await gate; return ''; } }); t.after(w.close);
    const work = w.run({}, { signal: controller.signal }).then(() => assert.fail('must cancel'), e => e);
    try {
        await ready; controller.abort(); assert.equal((await work).code, 'STEP_ABORTED');
        await assert.rejects(w.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 5));
        try { await w.service.processToolCall({ command: 'Observe', serial: 'A' }); break; }
        catch (e) { if (e.code !== 'DEVICE_BUSY') break; if (i === 99) throw e; }
    }
    assert.deepEqual(commands(w), ['back']);
});
