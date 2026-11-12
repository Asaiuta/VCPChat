'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { actionWorld } = require('./helpers/android-search-actions-world.cjs');
const { spec, id, response } = require('./helpers/android-search-world.cjs');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { projectEvidence } = require('../../VCPToolBox/modules/androidTaskReplanner');

const scope = (maxSwipes = 4, direction = 'down') => ({ scroll: { command: 'Scroll', container: id('list'), target: id('query'), direction, maxSwipes } });
async function world(options = {}) {
    const direction = options.direction || 'down', horizontal = ['left', 'right'].includes(direction);
    const sign = ['down', 'right'].includes(direction) ? 1 : -1;
    const w = await actionWorld({ scroll: 'Scroll', direction, services: options.services, invoke: options.invoke,
        async swipe(s, request) {
            s.swipes = (s.swipes || 0) + 1;
            if (options.swipe) return options.swipe(s, request);
            s.position = (s.position || 0) + 1;
            if (s.swipes === (options.findAt ?? 3)) s.page = 'form';
            return '';
        },
        onCapture: options.onCapture,
        decide: options.decide,
        xml(tree, s) {
            const position = options.position ? options.position(s) : s.position || 0;
            const start = 10 + sign * position;
            const rows = [];
            for (let i = 0; i < 4; i++) {
                const row = { id: start + i, cls: 'TextView', at: (horizontal ? 5 : 10) + i * (horizontal ? 22 : 40) };
                options.row?.(row, i, s);
                const bounds = horizontal ? `[${row.at},10][${row.at + 10},30]` : `[10,${row.at}][30,${row.at + 20}]`;
                rows.push(`<node package="com.example" class="android.widget.${row.cls}" resource-id="${id(`row_${row.id}`)}" enabled="true" bounds="${bounds}" text="PRIVATE_CONTACT_731 clock-${options.clock ? s.swipes || 0 : s.labelVersion || 0}"/>`);
            }
            // The labels stay stable by default; tests can vary them independently of geometry.
            tree = tree.replace(/<node[^>]*resource-id="com.example:id\/placeholder"[^>]*\/>/, '')
                .replace('</node>', `${rows.join('')}</node>`);
            return options.xml ? options.xml(tree, s) : tree;
        }
    });
    const run = w.run;
    w.run = (extra = {}, context = {}) => run({ searchActions: scope(options.maxSwipes || 4, direction), ...extra }, context);
    return w;
}

for (const direction of ['up', 'down', 'left', 'right']) test(`multi-scroll ${direction}: each of three swipes receives a new decision and independent proof`, async t => {
    const w = await world({ direction }); t.after(w.close);
    const result = await w.run(); assert.equal(result.status, 'completed', result.code);
    assert.deepEqual(w.state.actions.map(a => a.command), ['swipe', 'swipe', 'swipe', 'setText', 'click']);
    assert.equal(result.counts.actions, 5); assert.equal(result.counts.modelCalls, 5);
    const proofs = result.receipts.filter(r => r.scrollProof).map(r => r.scrollProof);
    assert.deepEqual(proofs.map(p => p.result), ['directional_motion', 'directional_motion', 'target_visible']);
    assert.ok(proofs.slice(0, 2).every(p => p.anchors === 3 && p.distance === (['left', 'right'].includes(direction) ? 22 : 40)));
    assert.ok(proofs.every(p => p.beforeObservationId !== p.afterObservationId && p.beforeDigest !== p.afterDigest));
    const models = w.state.models;
    assert.deepEqual(models.map(m => m.decisionContext.scrollProgress.swipes), [0, 1, 2, 3, 3]);
    assert.equal(new Set(models.map(m => m.decisionContext.observationId)).size, 5);
    const rows = await w.trace(); assert.equal(rows[0].searchActions.scroll.maxSwipes, 4);
    assert.doesNotMatch(JSON.stringify([rows, models]), /PRIVATE_CONTACT|row_\d|android.widget|positionDigest|contentDigest/);
});

test('maxSwipes stops after verified movement without inventing boundary or retry', async t => {
    const w = await world({ maxSwipes: 2, findAt: 10 }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_SCROLL_LIMIT');
    assert.equal(r.counts.modelCalls, 2); assert.equal(w.state.actions.length, 2);
    assert.ok(r.receipts.every(x => x.outcome === 'verified' && x.scrollProof.result === 'directional_motion'));
});

test('original action budget bounds scrolling even when maxSwipes is larger', async t => {
    const w = await world({ findAt: 10 }); t.after(w.close);
    const r = await w.run({ budget: { maxActions: 2 } }); assert.equal(r.code, 'TASK_BUDGET_EXHAUSTED');
    assert.equal(w.state.actions.length, 2); assert.equal(r.counts.verifiedActions, 2);
});

test('multi-scroll opt-in accepts only bounded Scroll and rejects accessors', () => {
    for (const maxSwipes of [0, 5, -1, 2.5, '2', null, undefined]) {
        const searchActions = scope(); searchActions.scroll.maxSwipes = maxSwipes;
        assert.throws(() => prepareTask(spec({ searchActions })), { code: 'TASK_INVALID' });
    }
    const searchActions = scope(2); searchActions.scroll.command = 'ScrollUntil';
    assert.throws(() => prepareTask(spec({ searchActions })), { code: 'TASK_INVALID' });
    let reads = 0; Object.defineProperty(searchActions.scroll, 'maxSwipes', { get() { reads++; return 2; }, enumerable: true });
    assert.throws(() => prepareTask(spec({ searchActions })), { code: 'TASK_INVALID' }); assert.equal(reads, 0);
});

test('A to B to A stops after second write, retaining the first verified proof', async t => {
    const w = await world({ findAt: 10, position(s) { return (s.position || 0) % 2; } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_SCROLL_REVISITED');
    assert.deepEqual(r.receipts.map(x => x.outcome), ['verified', 'unknown']);
    assert.equal(w.state.actions.length, 2); assert.equal(r.counts.modelCalls, 2);
});

for (const kind of ['no-motion', 'reverse', 'all-replaced', 'inconsistent', 'decorations', 'container-change']) test(`${kind} cannot authorize another scroll`, async t => {
    const w = await world({ findAt: 10, clock: kind === 'decorations',
        position(s) { return kind === 'no-motion' || kind === 'decorations' ? 0 : kind === 'reverse' ? -(s.position || 0) : s.position || 0; },
        row(row, i, s) {
            if (kind === 'all-replaced' && s.swipes) row.id += 100;
            if (kind === 'inconsistent' && s.swipes && i === 1) row.at += 5;
        }, xml(tree, s) { return kind === 'container-change' && s.swipes ? tree.replace('bounds="[0,0][100,200]"', 'bounds="[0,0][100,195]"') : tree; }
    }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, 'stopped'); assert.equal(w.state.actions.length, 1);
    assert.equal(r.receipts[0].outcome, 'unknown'); assert.equal(r.receipts[0].scrollProof, undefined);
    assert.equal(r.counts.modelCalls, 1);
});

test('duplicate anchors are insufficient before the first write', async t => {
    const w = await world({ row(row) { row.id = 1; } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_SCROLL_UNPROVEN'); assert.deepEqual(w.state.actions, []);
});

test('position changes during model wait cannot consume another swipe or reset history', async t => {
    let changed = false;
    const w = await world({ decide(model, questions, s) {
        if (model.step === 'seek' && s.swipes === 1 && !changed) { s.position++; changed = true; }
        return response(questions, 'c0');
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.code, 'TASK_SCROLL_DRIFT');
    assert.equal(w.state.actions.length, 1); assert.equal(r.counts.staleEvents, 1);
});

test('pure decorative stale can reobserve the same proven position without another allowance', async t => {
    let changed = false;
    const w = await world({ decide(model, questions, s) {
        if (model.step === 'seek' && s.swipes === 1 && !changed) { s.labelVersion = 1; changed = true; }
        return response(questions, 'c0');
    } }); t.after(w.close);
    const r = await w.run(); assert.equal(r.status, 'completed', r.code);
    assert.equal(r.counts.staleEvents, 1); assert.equal(r.counts.modelCalls, 6);
    assert.equal(w.state.actions.filter(a => a.command === 'swipe').length, 3);
});

test('main Agent reobserve keeps swipe count and receives bounded proof, never anchor payloads', async t => {
    let upgraded = false, projected;
    const w = await world({ decide(model, questions, s) {
        if (s.swipes === 1 && !upgraded) { upgraded = true; return response(questions, 'escalate'); }
        return response(questions, 'c0');
    } }); t.after(w.close);
    const r = await w.run({ assistance: 'main_agent' }, { androidTaskReplan: async p => {
        projected = projectEvidence(p);
        const bad = structuredClone(p); bad.evidence.decisionContext.scrollProgress.maxSwipes = 5;
        assert.throws(() => projectEvidence(bad), { code: 'TASK_REPLAN_INVALID' });
        return { schemaVersion: 1, taskId: p.taskId, observationId: p.observationId, action: 'reobserve' };
    } });
    assert.equal(r.status, 'completed', r.code); assert.equal(projected.decisionContext.scrollProgress.swipes, 1);
    assert.deepEqual(projected.receipts[0].scrollProof, { result: 'directional_motion', anchors: 3, distance: 40 });
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_CONTACT|row_\d|Digest|bounds|android.widget/);
    assert.equal(w.state.actions.filter(a => a.command === 'swipe').length, 3);
});

test('unknown second swipe does not reuse proof from the first or call assistance', async t => {
    const w = await world({ swipe(s) { if (s.swipes === 2) throw Error('offline failure'); s.position = 1; return ''; } }); t.after(w.close);
    const r = await w.run(); assert.deepEqual(r.receipts.map(x => x.outcome), ['verified', 'unknown']);
    assert.equal(r.receipts[1].scrollProof, undefined); assert.equal(w.state.actions.length, 2); assert.equal(r.counts.mainModelCalls, 0);
});

test('trace refuses invented proof data, unbound counters and unknown-outcome proofs', async t => {
    const w = await world(); t.after(w.close); assert.equal((await w.run()).status, 'completed');
    const rows = await w.trace(); const { seq, type, ...header } = rows[0]; header.taskId = randomUUID();
    const trace = await createTaskTraceStore({ directory: w.directory }).open(header);
    try {
        const { seq: ignored, ...receipt } = rows.find(r => r.scrollProof);
        for (const mutate of [r => { r.outcome = 'unknown'; }, r => { r.scrollProof.anchors = 1; },
            r => { r.scrollProof.text = 'secret'; }, r => { r.scrollProof.afterObservationId = r.scrollProof.beforeObservationId; },
            r => { r.scrollProof.afterDigest = r.scrollProof.beforeDigest; }, r => { r.targetId = id('other'); }]) {
            const r = structuredClone(receipt); mutate(r); await assert.rejects(trace.append(r), { code: 'TRACE_INVALID_ARGUMENT' });
        }
        await trace.append(receipt);
        const { seq: ignored2, ...candidate } = rows.find(r => r.type === 'candidates');
        candidate.decisionContext.scrollProgress.maxSwipes = 2;
        await assert.rejects(trace.append(candidate), { code: 'TRACE_INVALID_ARGUMENT' });
    } finally { await trace.close(); }
});

test('human handoff preserves verified position and swipe allowance', async t => {
    let upgraded = false;
    const w = await world({ services: { humanInteraction: { request: async () => true } }, decide(model, questions, s) {
        if (s.swipes === 1 && !upgraded) { upgraded = true; return response(questions, 'escalate'); }
        return response(questions, 'c0');
    } }); t.after(w.close);
    const r = await w.run({ assistance: 'human' }); assert.equal(r.status, 'completed', r.code);
    assert.equal(r.counts.humanHandoffs, 1); assert.equal(w.state.actions.filter(a => a.command === 'swipe').length, 3);
    const returned = w.state.models.find(m => m.decisionContext.lastEvent === 'human_reobserve');
    assert.equal(returned.decisionContext.scrollProgress.swipes, 1);
});

test('finding a search entry can open its form without retaining the old target visibility requirement', async t => {
    let opened = false;
    const w = await world({ findAt: 2, invoke(method, _params, s) {
        if (method === 'click' && !opened) { opened = true; s.page = 'form'; return true; }
    }, xml(tree, s) {
        if (s.page === 'form' && !opened) return tree.replace(/<node[^>]*resource-id="com.example:id\/query"[^>]*\/>/,
            `<node package="com.example" class="android.widget.Button" resource-id="${id('open_search')}" text="Search" clickable="true" enabled="true" bounds="[10,100][90,130]"/>`)
            .replace(/<node[^>]*resource-id="com.example:id\/search_go"[^>]*\/>/, '');
        return tree;
    } }); t.after(w.close);
    const r = await w.run({ searchActions: { scroll: { ...scope().scroll, target: id('open_search') } } });
    assert.equal(r.status, 'completed', r.code);
    assert.deepEqual(w.state.actions.map(a => a.command), ['swipe', 'swipe', 'click', 'setText', 'click']);
});

test('cancelled second swipe retains lease until drain and keeps only the first successful proof', async t => {
    let entered, release;
    const ready = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
    const controller = new AbortController();
    const w = await world({ async swipe(s) { if (s.swipes === 2) { entered(); await gate; return ''; } s.position = 1; return ''; } }); t.after(w.close);
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
    const fs = require('node:fs/promises'), path = require('node:path');
    const file = (await fs.readdir(w.directory)).find(f => f.endsWith('.jsonl'));
    const rows = (await fs.readFile(path.join(w.directory, file), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(r => r.scrollProof).length, 1);
    assert.equal(w.state.actions.length, 2);
});
