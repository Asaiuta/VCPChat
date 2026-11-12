'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { world, spec, response } = require('./helpers/android-ui-task-world.cjs');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { createTaskExecutionOptions, projectEvidence } = require('../../VCPToolBox/modules/androidTaskReplanner');
const advice = (p, action = 'select', candidateId = p.evidence.candidates[0]?.candidateId) => ({ schemaVersion: 1,
    taskId: p.taskId, observationId: p.observationId, action, ...(action === 'select' ? { candidateId } : {}) });
const normal = (s, q) => {
    const command = s.hostCompletionMatched ? 'Done' : !s.recentActions.length ? 'Tap'
        : s.elements.some(n => n.role === 'textfield' && !n.inputMatches.length) ? 'Fill' : 'Tap';
    const c = s.candidates.find(c => c.action.command === command && (command !== 'Tap'
        || s.elements.find(n => n.nodeRef === c.action.nodeRef)?.role !== 'textfield'));
    return response(q, command === 'Done' ? 'Done' : c.candidateId);
};
const trigger = (s, q) => s.recentActions.length ? normal(s, q) : response(q, 'escalate');

test('generic normal path makes zero assistance calls even when opted in', async t => {
    const w = await world(); t.after(w.close); let calls = 0;
    const r = (await w.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: () => { calls++; } })).details.task;
    assert.equal(r.status, 'completed'); assert.equal(calls, 0); assert.equal(r.counts.mainModelCalls, 0);
});

test('main Agent uses the actual upstream projector, metadata and durable private trace', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-assist-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const w = await world({ decide: trigger, traceStore: createTaskTraceStore({ directory }) }); t.after(w.close);
    let calls = 0;
    const options = createTaskExecutionOptions({ apiUrl: 'https://offline.invalid', apiKey: 'offline-only', model: 'actual-main-model',
        fetch: async (_url, req) => {
            calls++; const body = JSON.parse(req.body), packet = JSON.parse(body.messages[1].content);
            assert.equal(body.model, 'actual-main-model'); assert.equal(packet.intent, 'ui_task');
            assert.equal(packet.goal, spec().goal); assert.ok(packet.candidates[0].description.includes('Search'));
            assert.doesNotMatch(req.body, /private query 731|serial|rawNode/);
            return { ok: true, text: async () => JSON.stringify({ model: 'returned-main-version', usage: { prompt_tokens: 3, completion_tokens: 2 },
                choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ schemaVersion: 1, taskId: packet.taskId,
                    observationId: packet.observationId, action: 'select', candidateId: packet.candidates[0].candidateId }) } }] }) };
        } });
    const r = (await w.run(spec({ assistance: 'main_agent' }), options)).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(calls, 1);
    assert.equal(r.counts.mainModelCalls, 1); assert.equal(r.counts.mainModelRequests, 1);
    assert.equal(r.counts.actions, 3); assert.equal(r.counts.modelCalls, 4);
    const rows = (await fs.readFile(path.join(directory, r.taskId + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(e => e.type === 'assistance').length, 2);
    const settled = rows.find(e => e.type === 'assistance' && e.assistance.phase === 'settled');
    assert.equal(settled.modelEvidence.returnedModel, 'returned-main-version'); assert.equal(settled.modelEvidence.usage.totalTokens, null);
    assert.doesNotMatch(JSON.stringify([rows, r]), /private query 731|Find the requested book|Search|Keywords/);
});

for (const kind of ['missing', 'invalid', 'identity', 'extra', 'stop', 'repeat', 'stale', 'context']) test(`generic assistance ${kind} cannot bypass dispatch checks`, async t => {
    let moved = false, calls = 0;
    const w = await world({ decide: trigger, nodes: (s, nodes) => nodes.map(n => ({ ...n, text: (n.text || '') + s.revision })),
        probeScreen: () => moved ? { size: { width: 100, height: 200 } } : undefined }); t.after(w.close);
    const context = kind === 'missing' ? {} : { androidTaskReplan: async p => {
        calls++;
        if (kind === 'stale') w.state.revision++;
        if (kind === 'context') moved = true;
        const a = advice(p, kind === 'repeat' ? 'reobserve' : kind === 'stop' ? 'stop' : 'select');
        if (kind === 'invalid') a.candidateId = 'c999';
        if (kind === 'identity') a.observationId = 'wrong';
        if (kind === 'extra') a.command = 'Fill';
        return a;
    } };
    const r = (await w.run(spec({ assistance: 'main_agent' }), context)).details.task;
    assert.equal(r.status, 'stopped'); assert.equal(w.writes.length, 0); assert.equal(calls, kind === 'missing' ? 0 : 1);
    assert.equal(r.code, ({ missing: 'TASK_ASSISTANCE_UNAVAILABLE', invalid: 'TASK_REPLAN_INVALID', identity: 'TASK_REPLAN_INVALID',
        extra: 'TASK_REPLAN_INVALID', stop: 'TASK_ASSISTANCE_STOPPED', repeat: 'TASK_ASSISTANCE_LIMIT', stale: 'TASK_ASSISTANCE_LIMIT', context: 'CONTEXT_UNPROVEN' })[kind]);
    assert.doesNotMatch(JSON.stringify(r.escalation), /Find the requested book|Search/);
});

for (const invalid of [false, true]) test(`only valid low confidence can upgrade, invalid=${invalid}`, async t => {
    let calls = 0;
    const w = await world({ decide(s, q) {
        if (s.recentActions.length) return normal(s, q);
        if (invalid) return {};
        const a = response(q, 'escalate'), key = Object.keys(q)[0];
        a.answers[key].probabilities.escalate = 0.5; a.answers[key].probabilities.Tap = 0.5; return a;
    } }); t.after(w.close);
    const r = (await w.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async p => { calls++; return advice(p); } })).details.task;
    assert.equal(r.status, invalid ? 'stopped' : 'completed', JSON.stringify(r)); assert.equal(calls, invalid ? 0 : 1);
});

for (const accept of [false, true]) test(`generic human handoff fresh reobservation, accept=${accept}`, async t => {
    let calls = 0;
    const w = await world({ decide: (s, q) => calls ? normal(s, q) : response(q, 'escalate'),
        services: { humanInteraction: { request: async ({ kind }) => { assert.equal(kind, 'handoff'); calls++; return accept; } } } }); t.after(w.close);
    const r = (await w.run(spec({ assistance: 'human' }))).details.task;
    assert.equal(r.status, accept ? 'completed' : 'stopped', JSON.stringify(r)); assert.equal(calls, 1);
    assert.equal(r.counts.humanHandoffs, 1); assert.equal(r.counts.mainModelCalls, 0);
    if (!accept) assert.equal(r.code, 'TASK_HANDOFF_REJECTED');
});

test('human change to a previously filled visible input stops instead of silently overwriting', async t => {
    let w;
    w = await world({ decide: (s, q) => s.recentActions.some(h => h.action.command === 'Fill') ? response(q, 'escalate') : normal(s, q),
        services: { humanInteraction: { request: async () => { w.values.set('opaque_37', 'human changed'); return true; } } } }); t.after(w.close);
    const r = (await w.run(spec({ assistance: 'human' }))).details.task;
    assert.equal(r.code, 'TASK_PROGRESS_LOST', JSON.stringify(r)); assert.equal(w.writes.length, 2);
});

test('unknown write never calls assistance and no callback can add action budget', async t => {
    let calls = 0;
    const w = await world({ invoke() { throw Object.assign(new Error('lost'), { code: 'UI_SERVER_RPC_TIMEOUT' }); } }); t.after(w.close);
    const r = (await w.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: () => { calls++; } })).details.task;
    assert.equal(r.receipts[0].outcome, 'unknown'); assert.equal(calls, 0); assert.equal(w.writes.length, 1);
    const limited = await world({ decide: trigger }); t.after(limited.close);
    const end = (await limited.run(spec({ assistance: 'main_agent', budget: { maxActions: 1, maxModelCalls: 2 } }),
        { androidTaskReplan: async p => { calls++; return advice(p); } })).details.task;
    assert.equal(end.status, 'stopped'); assert.equal(limited.writes.length, 1); assert.equal(end.counts.actions, 1);
});

test('upstream rejects foreign scope, stale identity, extra fields and unknown receipts before fetch', async t => {
    const w = await world({ decide: trigger }); t.after(w.close); let checks = 0;
    await w.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async p => {
        assert.equal(projectEvidence(p).intent, 'ui_task');
        for (const mutate of [x => { x.evidence.candidateObservationId = 'old'; }, x => { x.evidence.context.secret = 'leak'; },
            x => { x.evidence.candidates[0].action = { command: 'LaunchApp', package: 'evil.app' }; },
            x => { x.evidence.counts.actions = 2; }, x => { x.evidence.receipts = [{ outcome: 'unknown' }]; }]) {
            const bad = structuredClone(p); mutate(bad); assert.throws(() => projectEvidence(bad), { code: 'TASK_REPLAN_INVALID' }); checks++;
        }
        return advice(p, 'stop');
    } });
    assert.equal(checks, 5);
});

test('generic main Agent timeout discards late advice without extending the task deadline', async t => {
    const w = await world({ decide: trigger }); t.after(w.close);
    const r = (await w.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async (p, options) => {
        assert.ok(options.timeoutMs <= 10000);
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        return advice(p);
    } })).details.task;
    assert.equal(r.code, 'TASK_ASSISTANCE_TIMEOUT'); assert.equal(w.writes.length, 0);
    assert.equal(r.counts.mainModelCalls, 1); assert.ok(r.escalation.remaining.timeoutMs > 0);
});

test('assistance cannot run when its durable start record fails', async t => {
    let calls = 0;
    const w = await world({ decide: trigger, traceStore: { async open() { return {
        async append(e) { if (e.type === 'assistance') throw new Error('disk full'); }, async close() {} }; } } }); t.after(w.close);
    const r = (await w.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async p => { calls++; return advice(p); } })).details.task;
    assert.equal(r.code, 'TASK_TRACE_FAILED'); assert.equal(calls, 0); assert.equal(w.writes.length, 0);
});

test('full ordinary trace budget still permits the reserved terminal record', async t => {
    const rows = [];
    const w = await world({ decide: () => ({}), traceStore: { async open() { return {
        async append(e) { if (e.type === 'escalation') throw Object.assign(new Error(), { code: 'TRACE_LIMIT' }); rows.push(e); },
        async close() {} }; } } }); t.after(w.close);
    const r = (await w.run()).details.task;
    assert.equal(r.code, 'TASK_TRACE_LIMIT'); assert.equal(rows.at(-1).type, 'stopped');
    assert.equal(rows.at(-1).code, 'TASK_TRACE_LIMIT'); assert.equal(w.writes.length, 0);
});
