'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, spec, response, id } = require('./helpers/android-ui-task-world.cjs');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { completionEvidence, uiEvidence } = require('../VCPDistributedServer/Plugin/AndroidController/lib/task-ui-evidence');
const { modelElements } = require('../modules/services/androidUiTaskDecision');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { rawEntries } = require('../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence');
const selectResponse = (q, c) => response(q, ['Back', 'Done'].includes(c.action.command) ? c.action.command : c.candidateId);

test('general loop discovers opaque controls and independently verifies a three-action search', async t => {
    const w = await world(); t.after(w.close);
    const result = (await w.run(spec({ budget: { maxActions: 3, maxModelCalls: 8 } }))).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.counts.modelCalls, 4); assert.equal(result.counts.actions, 3);
    assert.deepEqual(w.writes.map(w => w.method), ['click', 'setText', 'click']);
    assert.equal(result.modelClaimedComplete, true); assert.equal(result.independentlyVerified, true);
    assert.doesNotMatch(JSON.stringify(w.events), /private query 731|Keywords|Find the requested book|Found results/);
    assert.ok(w.models[0].state.elements.every(n => !Object.hasOwn(n, 'selector')));
});

test('ID-less field uses a private fresh index and exact RPC readback', async t => {
    const w = await world({ nodes: (_s, nodes) => nodes.map(n => n.kind === 'EditText' ? { ...n, noId: true } : n) }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.equal(w.writes.find(w => w.method === 'setText').params[0].resourceId, undefined);
    assert.equal(w.values.get('opaque_37'), 'private query 731');
});

test('disabled and password fields cannot become candidates', async t => {
    const w = await world({ nodes: (_s, nodes) => [...nodes,
        { name: 'password', kind: 'EditText', password: true, text: 'DO_NOT_SEND' },
        { name: 'off', kind: 'Button', enabled: false, text: 'DISABLED' }],
        decide(s, q) {
            assert.doesNotMatch(JSON.stringify(s), /DO_NOT_SEND|DISABLED|:id\/password/);
            return response(q, 'escalate');
        } }); t.after(w.close);
    assert.equal((await w.run()).details.task.code, 'TASK_ESCALATION_REQUIRED');
    assert.equal(w.writes.length, 0);
});

test('model can distinguish empty, existing and truncated field values without logging them', async t => {
    const secret = 'existing-value-'.repeat(30);
    const w = await world({ nodes: () => [
        { name: 'empty', kind: 'EditText', hint: 'Empty field' },
        { name: 'existing', kind: 'EditText', text: secret },
        { name: 'password', kind: 'EditText', password: true, text: 'HIDDEN_SECRET' }],
        decide(s, q) {
            const empty = s.elements.find(n => n.resourceId === id('empty'));
            const existing = s.elements.find(n => n.resourceId === id('existing'));
            assert.equal(empty.value, ''); assert.equal(empty.valueTruncated, false);
            assert.equal(existing.value, secret.slice(0, 160)); assert.equal(existing.valueTruncated, true);
            assert.deepEqual(existing.inputMatches, []);
            assert.doesNotMatch(JSON.stringify(s), /HIDDEN_SECRET/);
            return response(q, 'escalate');
        } }); t.after(w.close);
    assert.equal((await w.run()).details.task.code, 'TASK_ESCALATION_REQUIRED');
    assert.doesNotMatch(JSON.stringify(w.events), /existing-value|HIDDEN_SECRET/);
    assert.equal(w.writes.length, 0);
});

test('early Done cannot turn a failed host predicate into successful completion', async t => {
    const w = await world({ decide(s, q) {
        assert.equal(s.candidates.some(c => c.action.command === 'Done'), false);
        const r = response(q, 'c999'); r.answers[Object.keys(q)[0]].probabilities.c999 = 1; return r;
    } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.code, 'TASK_JEV_INVALID'); assert.equal(r.modelClaimedComplete, false);
    assert.equal(r.independentlyVerified, false); assert.equal(w.writes.length, 0);
});

for (const removed of [false, true]) test(`Done verifies fresh evidence after content drift, removed=${removed}`, async t => {
    const w = await world({ nodes: (s, nodes) => s.page === 'results' && s.revision
        ? [{ name: removed ? 'unrelated' : 'results', text: 'Updated content', clickable: false }] : nodes,
        decide(s, q, state) {
            const c = s.candidates.find(c => state.page === 'home' ? c.action.command === 'Tap'
                : state.page === 'form' && !s.elements.find(n => n.role === 'textfield').inputMatches.length ? c.action.command === 'Fill'
                    : state.page === 'form' ? c.action.command === 'Tap' && s.elements.find(n => n.nodeRef === c.action.nodeRef).role !== 'textfield'
                        : c.action.command === 'Done');
            if (state.page === 'results') state.revision++;
            return selectResponse(q, c);
        } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.status, removed ? 'stopped' : 'completed', JSON.stringify(r));
    assert.equal(r.independentlyVerified, !removed);
    assert.equal(r.counts.modelCalls, 4); assert.equal(w.writes.length, 3);
    if (removed) assert.equal(r.code, 'TASK_COMPLETION_UNPROVEN');
});

test('without a host verifier, model Done is explicitly unverified', async t => {
    const w = await world({ decide(s, q) { return response(q, 'Done'); } }); t.after(w.close);
    const r = (await w.run(spec({ completion: null }))).details.task;
    assert.equal(r.status, 'unverified'); assert.equal(r.independentlyVerified, false);
});

test('malformed response, generated parameters and low probabilities never dispatch', async t => {
    for (const mode of ['extra', 'uncertain', 'stale_answer']) {
        let old;
        const w = await world({ decide(s, q) {
            const r = response(q, s.candidates[0].candidateId), key = Object.keys(q)[0];
            if (mode === 'extra') r.action = { text: 'generated' };
            if (mode === 'uncertain') { const p = r.answers[key].probabilities; const chosen = Object.keys(p).find(k => p[k] === 1); p[chosen] = 0.6; p.escalate = 0.4; }
            if (mode === 'stale_answer') { if (old) return old; old = r; }
            return r;
        } }); t.after(w.close);
        const r = (await w.run()).details.task;
        assert.equal(r.code, mode === 'uncertain' ? 'TASK_JEV_UNCERTAIN' : 'TASK_JEV_INVALID');
        assert.equal(w.writes.length, mode === 'stale_answer' ? 1 : 0);
        await w.close();
    }
});

test('unknown dispatched write stops once without trying another target', async t => {
    const w = await world({ invoke(method) { if (method === 'click') throw Object.assign(new Error('uncertain'), { code: 'UI_SERVER_RPC_TIMEOUT' }); } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.status, 'stopped'); assert.equal(r.receipts.length, 1);
    assert.equal(r.receipts[0].outcome, 'unknown'); assert.equal(w.writes.length, 1); assert.equal(w.models.length, 1);
});

test('same-row completion cannot merge title and author from different or hidden rows', () => {
    const node = (name, text, body = '', hidden = false) => `<node package="com.example" resource-id="${id(name)}" class="android.widget.TextView" text="${text}" enabled="true" visible-to-user="${!hidden}" bounds="[0,0][90,90]">${body}</node>`;
    const row = (title, author, hidden = false) => node('row', '', node('title', title) + node('author', author, '', hidden));
    const task = prepareTask(spec({ completion: { all: [{ type: 'row', id: id('list'), fields: [
        { id: id('title'), equals: 'A' }, { id: id('author'), equals: 'B', normalize: 'NFC_trim', stripPrefix: '作者：' }] }] } }));
    for (const [body, matched] of [[row('A', '作者：B'), true], [row('A', 'X') + row('X', 'B'), false], [row('A', 'B', true), false]]) {
        const graph = parseUiGraph(`<hierarchy rotation="0">${node('list', '', body)}</hierarchy>`, { rpcTarget: true, screen: { width: 100, height: 200 } });
        assert.equal(completionEvidence(task, rawEntries(graph, { width: 100, height: 200 }, { excludeHiddenSubtrees: true })).matched, matched);
    }
});

test('contract rejects foreign packages, generated input refs and legacy scope mixing', () => {
    for (const value of [spec({ allowedPackages: ['other.app'] }), spec({ operations: ['Shell'] }), spec({ inputs: { query: 2 } }),
        spec({ loading: { id: 'foreign.app:id/loading' } }), spec({ completion: { all: [{ type: 'text', text: { id: id('q'), inputRef: 'missing' } }] } })]) {
        assert.throws(() => prepareTask(value), { code: 'TASK_INVALID' });
    }
});

for (const rowId of ['', id('repeated_row')]) test(`model evidence preserves separate result rows with ambiguous IDs: ${rowId || 'anonymous'}`, () => {
    const text = (name, value, top) => `<node package="com.example" resource-id="${id(name)}" class="android.widget.TextView" text="${value}" enabled="true" visible-to-user="true" bounds="[0,${top}][90,${top + 20}]"/>`;
    const row = (author, top) => `<node package="com.example" resource-id="${rowId}" class="android.widget.LinearLayout" text="" enabled="true" visible-to-user="true" bounds="[0,${top}][90,${top + 50}]">${text('title', 'Same title', top)}${text('author', author, top + 25)}</node>`;
    const xml = `<hierarchy rotation="0"><node package="com.example" resource-id="${id('list')}" class="android.widget.ListView" enabled="true" visible-to-user="true" scrollable="true" bounds="[0,0][100,200]">${row('First author', 0)}${row('Requested author', 60)}</node></hierarchy>`;
    const screen = { width: 100, height: 200 }, graph = parseUiGraph(xml, { rpcTarget: true, screen });
    const task = prepareTask(spec());
    const { ui } = uiEvidence(task, graph, rawEntries(graph, screen, { excludeHiddenSubtrees: true }), () => 'a'.repeat(64));
    const projected = modelElements(ui.nodes);
    const titles = projected.elements.filter(e => e.resourceId === id('title'));
    const authors = projected.elements.filter(e => e.resourceId === id('author'));
    assert.equal(titles.length, 2); assert.equal(authors.length, 2);
    assert.equal(titles[0].contextRefs[0], authors[0].contextRefs[0]);
    assert.equal(titles[1].contextRefs[0], authors[1].contextRefs[0]);
    assert.notEqual(titles[0].contextRefs[0], titles[1].contextRefs[0]);
    assert.equal(titles[0].contextRefs[1], titles[1].contextRefs[1]);
    assert.ok(projected.contexts.every(c => !Object.hasOwn(c, 'contextId') && !Object.hasOwn(c, 'path')));
});

test('declared loading is polled by the host before the first model call', async t => {
    let reads = 0;
    const w = await world({ nodes: state => {
        if (++reads >= 5) state.page = 'results';
        return state.page === 'results'
        ? [{ name: 'results', text: 'Ready', clickable: false }]
        : [{ name: 'loading', text: 'Stop loading' }, { name: 'navigate', text: 'Next' }]; },
        decide(s, q) {
            assert.equal(s.loading.active, false); return response(q, 'Done');
        } }); t.after(w.close);
    const r = (await w.run(spec({ loading: { id: id('loading') } }))).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(w.writes.length, 0);
    assert.equal(r.counts.modelCalls, 1);
    assert.ok(w.events.some(e => e.type === 'wait' && e.source === 'host' && e.reason === 'loading'));
});

test('a visible matched target can be verified while other background loading continues', async t => {
    const w = await world({ nodes: () => [{ name: 'loading', text: 'Stop loading' },
        { name: 'results', text: 'Ready', clickable: false }], decide(s, q) {
        assert.equal(s.loading.active, true);
        assert.deepEqual(s.candidates.map(c => c.action.command), ['Done']);
        return response(q, 'Done');
    } }); t.after(w.close);
    const r = (await w.run(spec({ loading: { id: id('loading') } }))).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.equal(r.counts.modelCalls, 1); assert.equal(w.writes.length, 0);
});

for (const limit of ['observations', 'deadline']) test(`persistent loading stops at the original ${limit} budget without model requests`, async t => {
    const w = await world({ nodes: () => [{ name: 'loading', text: 'Still loading' }] }); t.after(w.close);
    const r = (await w.run(spec({ loading: { id: id('loading') }, budget: limit === 'observations'
        ? { maxObservations: 6 } : { timeoutMs: 2000 } }))).details.task;
    assert.equal(r.code, limit === 'observations' ? 'TASK_BUDGET_EXHAUSTED' : 'TASK_WAIT_TIMEOUT', JSON.stringify(r));
    assert.equal(r.counts.modelCalls, 0); assert.equal(w.writes.length, 0);
    assert.ok(r.counts.observations <= (limit === 'observations' ? 6 : 96));
});

test('multi-field input binds each exact named value and skips fields already satisfied', async t => {
    const w = await world({ nodes: s => s.page === 'results' ? [{ name: 'results', text: 'Route found', clickable: false }]
        : [{ name: 'from', kind: 'EditText', hint: 'Origin' }, { name: 'to', kind: 'EditText', hint: 'Destination' }, { name: 'find', text: 'Find route' }],
        decide(s, q, state) {
            const node = s.elements.find(n => n.role === 'textfield' && !n.inputMatches.length);
            const ref = node?.label === 'Origin' ? 'origin' : 'destination';
            const c = s.candidates.find(c => state.page === 'results' ? c.action.command === 'Done'
                : node ? c.action.command === 'Fill' && c.action.nodeRef === node.nodeRef && c.action.inputRef === ref
                    : c.action.command === 'Tap' && s.elements.find(n => n.nodeRef === c.action.nodeRef).label === 'Find route');
            return selectResponse(q, c);
        }, invoke(method, _p, state) { if (method === 'click') { state.page = 'results'; return true; } } }); t.after(w.close);
    const r = (await w.run(spec({ inputs: { origin: 'A station', destination: 'B station' } }))).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.deepEqual(w.writes.filter(w => w.method === 'setText').map(w => w.params[1]), ['A station', 'B station']);
});

test('visible declared input bindings constrain form actions without blocking navigation to the form', async t => {
    const w = await world({ nodes: (_s, nodes) => nodes,
        decide(s, q, state) {
            if (state.page === 'home') return selectResponse(q, s.candidates.find(c => c.action.command === 'Tap'));
            if (!s.elements.find(n => n.resourceId === id('opaque_37'))?.inputMatches.includes('query')) {
                assert.deepEqual(s.candidates.map(c => c.action.command), ['Fill']);
                assert.equal(s.candidates[0].action.inputRef, 'query');
                return selectResponse(q, s.candidates[0]);
            }
            return response(q, 'escalate');
        } }); t.after(w.close);
    const r = (await w.run(spec({ inputs: { query: 'private query 731', unrelated: 'other value' }, completion: { all: [
        { type: 'text', text: { id: id('opaque_37'), inputRef: 'query' } }, { type: 'visible', id: id('results') }
    ] } }))).details.task;
    assert.equal(r.code, 'TASK_ESCALATION_REQUIRED');
    assert.deepEqual(w.writes.map(w => w.method), ['click', 'setText']);
    assert.equal(w.values.get('opaque_37'), 'private query 731');
    assert.equal(w.models.at(-1).state.candidates.some(c => c.action.command === 'Fill'), false);
});

test('checked goal avoids a second toggle and verifies stable raw checked state', async t => {
    const w = await world({ nodes: () => [{ name: 'dark', text: 'Dark mode', kind: 'Switch', checkable: true }],
        decide(s, q) { return selectResponse(q, s.candidates.find(c => c.action.command === (s.elements[0].checked ? 'Done' : 'Tap'))); },
        invoke(method, _params, state) { if (method === 'click') { state.checked = !state.checked; return true; } } }); t.after(w.close);
    const r = (await w.run(spec({ inputs: {}, completion: { all: [{ type: 'checked', id: id('dark'), checked: true }] } }))).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(w.writes.length, 1);
});

for (const command of ['Scroll', 'Back', 'ImeAction', 'LongPress', 'LaunchApp']) test(`generic ${command} uses production dispatch and reobserves its effect`, async t => {
    const w = await world({ nodes: s => s.page === 'results' ? [{ name: 'results', text: 'Done', clickable: false }]
        : [{ name: 'target', kind: command === 'ImeAction' ? 'EditText' : 'Button', text: 'Target',
            focused: command === 'ImeAction', scrollable: command === 'Scroll', longClickable: command === 'LongPress' }],
        decide(s, q, state) { return selectResponse(q, s.candidates.find(c => c.action.command === (state.page === 'results' || state.package === 'other.app' ? 'Done' : command))); },
        invoke(method, _p, state) { if (['click', 'swipe', 'pressKey', 'pressKeyCode'].includes(method)) { state.page = 'results'; return true; } } }); t.after(w.close);
    const task = spec({ ...(command === 'LaunchApp' ? { allowedPackages: ['com.example', 'other.app'], completion: null } : {}) });
    const r = (await w.run(task)).details.task;
    assert.equal(r.status, command === 'LaunchApp' ? 'unverified' : 'completed', JSON.stringify(r));
    assert.equal(r.counts.actions, 1);
    if (command === 'LongPress') assert.equal(w.writes[0].params[2], 1000);
});

test('a known accepted no-effect action is excluded on the next decision, not blindly retried', async t => {
    const w = await world({ invoke() { return true; }, decide(s, q) {
        if (!s.recentActions.length) return response(q, s.candidates.find(c => c.action.command === 'Tap').candidateId);
        assert.equal(s.recentActions[0].changed, false);
        assert.equal(s.candidates.some(c => c.action.command === 'Tap'), false);
        return response(q, 'escalate');
    } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.code, 'TASK_ESCALATION_REQUIRED'); assert.equal(w.writes.length, 1);
});

test('screen drift before dispatch discards the response and makes a new decision', async t => {
    let changed = false;
    const w = await world({ nodes: (s, nodes) => nodes.map(n => ({ ...n, text: `${n.text || ''}${s.revision || ''}` })),
        decide(s, q, state) {
            if (!changed) { changed = true; state.revision++; return response(q, s.candidates.find(c => c.action.command === 'Tap').candidateId); }
            return response(q, 'escalate');
        } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.counts.staleEvents, 1); assert.equal(w.writes.length, 0); assert.equal(w.models.length, 2);
});

test('a transient rejected post-action read is reacquired without replaying the write', async t => {
    let disturbed = false;
    const w = await world({ transformXml(xml, state) {
        if (state.page === 'results' && !disturbed) { disturbed = true; return xml.replaceAll('package="com.example"', 'package="other.app"'); }
        return xml;
    } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.equal(r.counts.staleEvents, 1); assert.equal(w.writes.length, 3);
    assert.ok(w.events.some(e => e.type === 'recovery' && e.reason === 'sampling_context_changed'));
});

test('a transient missing window probe during settle reacquires complete context without input replay', async t => {
    let disturbed = false;
    const w = await world({ probeScreen(state) {
        if (state.page === 'results' && !disturbed) { disturbed = true; return { size: { width: 100, height: 200 } }; }
    } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.equal(w.writes.length, 3); assert.equal(r.counts.staleEvents, 1);
});

test('a page still changing after the effect window settles without spending another model call', async t => {
    let revision = 0, loadingStarted;
    const w = await world({ transformXml(xml, state) {
        if (state.page !== 'results') return xml;
        loadingStarted ??= Date.now();
        return Date.now() - loadingStarted < 5200 ? xml.replace('Found results', `Found results ${++revision}`) : xml;
    }, decide(s, q, state) {
        assert.equal(s.pageSettled, true);
        const c = s.candidates.find(c => state.page === 'home' ? c.action.command === 'Tap'
            : state.page === 'form' && !s.elements.find(n => n.role === 'textfield').inputMatches.length ? c.action.command === 'Fill'
                : state.page === 'form' ? c.action.command === 'Tap' && s.elements.find(n => n.nodeRef === c.action.nodeRef).role !== 'textfield'
                    : c.action.command === 'Done');
        return selectResponse(q, c);
    } }); t.after(w.close);
    const r = (await w.run(spec({ budget: { maxActions: 3, maxModelCalls: 8 } }))).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r));
    assert.ok(w.events.some(e => e.type === 'wait' && e.source === 'host' && e.reason === 'page_unsettled'));
    assert.equal(w.writes.length, 3); assert.equal(r.counts.modelCalls, 4);
});

test('exhausted write budget removes write choices while pending completion can still be observed', async t => {
    const w = await world({ nodes: () => [{ name: 'entry', text: 'Load results' }],
        decide(s, q, state) {
            if (s.remaining.actions > 0) return selectResponse(q, s.candidates.find(c => c.action.command === 'Tap'));
            assert.ok(s.candidates.every(c => c.action.command === 'Done'));
            if (state.page !== 'results') { state.page = 'results'; return response(q, 'wait'); }
            return response(q, 'Done');
        }, transformXml(xml, state) { return state.page === 'results' ? xml.replaceAll('com.example:id/entry', id('results')) : xml; },
        invoke(method, _p, state) { if (method === 'click') { state.page = 'pending'; return true; } } }); t.after(w.close);
    const r = (await w.run(spec({ budget: { maxActions: 1, maxModelCalls: 3 } }))).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(w.writes.length, 1);
    assert.equal(r.counts.modelCalls, 3);
});

test('repeated inconsistent post-action reads stop at the existing stale limit', async t => {
    const w = await world({ transformXml: (xml, state) => state.page === 'results'
        ? xml.replaceAll('package="com.example"', 'package="other.app"') : xml }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.code, 'TASK_STALE_LIMIT', JSON.stringify(r));
    assert.equal(r.counts.staleEvents, 3); assert.equal(w.writes.length, 3);
    assert.equal(r.modelClaimedComplete, false);
});

test('duplicate resource IDs bind the selected current row rather than the first match', async t => {
    const w = await world({ nodes: s => s.page === 'results' ? [{ name: 'results', text: 'Done', clickable: false }]
        : [{ name: 'card', text: 'First result' }, { name: 'card', text: 'Second result' }],
        decide(s, q, state) {
            const target = s.elements.find(n => n.label === 'Second result');
            return selectResponse(q, s.candidates.find(c => state.page === 'results' ? c.action.command === 'Done'
                : c.action.command === 'Tap' && c.action.nodeRef === target.nodeRef));
        }, invoke(method, params, state) {
            if (method === 'click') { assert.ok(params[1] >= 40); state.page = 'results'; return true; }
        } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(w.writes.length, 1);
});
