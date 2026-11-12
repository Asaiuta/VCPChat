'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { GlobalJevService } = require('../modules/services/globalJevService');
const { modelEvidence } = require('../modules/services/androidJevEvidence');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { traceEventLimit, LIMITS } = require('../modules/services/androidTaskBudget');
const { searchWorld, response, spec, pkg, id } = require('./helpers/android-search-world.cjs');

test('each model call records the actual request alias, returned model and supported usage only', async () => {
    let calls = 0;
    const service = new GlobalJevService({ settingsManager: { async readSettings() {
        return { jevEnabled: true, jevModel: `configured-${calls}`, jevApiKey: 'credential-do-not-log' };
    } }, client: { async decide(state, questions, options) {
        assert.equal(options.onRequestMetadata, undefined, 'host metadata callback is not forwarded to HTTP client');
        assert.equal(options.maxRetries, 0);
        return { ...response(questions, 'c0'), model: `resolved-${calls++}`, usage: {
            prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, private: spec().inputs.query } };
    } } });
    const h = await searchWorld({ decide: (...args) => service.decide(...args) });
    const result = (await h.run()).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const rows = h.events.filter(e => e.type === 'model');
    assert.equal(rows.length, 3);
    rows.forEach((row, i) => {
        assert.equal(row.modelCalls, i + 1);
        assert.equal(row.modelEvidence.requestedModel, `configured-${i}`);
        assert.equal(row.modelEvidence.returnedModel, `resolved-${i}`);
        assert.equal(row.modelEvidence.provider, 'typesafe');
        assert.deepEqual(row.modelEvidence.usage, { inputTokens: 11, outputTokens: 3, totalTokens: 14 });
        assert.ok(row.modelEvidence.elapsedMs >= 0);
        assert.equal(h.events.find(e => e.type === 'decision' && e.modelCalls === i + 1).observation.id, row.observation.id);
    });
    assert.doesNotMatch(JSON.stringify(h.events), /credential-do-not-log|private query 731/);
});

test('metadata is bounded data: missing, malformed or accessor values remain unknown', () => {
    const value = modelEvidence(null, {}, 1.5);
    assert.deepEqual(value, { provider: null, requestedModel: null, returnedModel: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null }, elapsedMs: 1 });
    const response = { model: 'invalid model with private text', usage: { input_tokens: -1, output_tokens: 0.5, total_tokens: Infinity } };
    Object.defineProperty(response, 'usage', { get() { throw Error('getter executed'); } });
    assert.deepEqual(modelEvidence({}, response, 1), value);
    assert.deepEqual(modelEvidence({ provider: 'typesafe', requestedModel: 'x'.repeat(129) }, { usage: {
        input_tokens: 0, output_tokens: 4, total_tokens: 4 } }, 0).usage,
    { inputTokens: 0, outputTokens: 4, totalTokens: 4 });
});

for (const [name, decide, reason, code] of [
    ['invalid', () => ({}), 'invalid_distribution', 'TASK_JEV_INVALID'],
    ['uncertain', (_, q) => ({ answers: { [Object.keys(q)[0]]: { probabilities: Object.fromEntries(Object.keys(q[Object.keys(q)[0]].criteria).map((k, i) => [k, i ? 0.2 : 0.6])) } } }), 'low_probability', 'TASK_JEV_UNCERTAIN'],
    ['escalate', (_, q) => response(q, 'escalate'), 'escalate', 'TASK_ESCALATION_REQUIRED'],
    ['timeout', () => { throw Object.assign(Error('private transport body'), { code: 'TIMEOUT' }); }, 'model_timeout', 'TASK_JEV_TIMEOUT'],
    ['unavailable', () => { throw Error('private transport body'); }, 'model_unavailable', 'TASK_JEV_UNAVAILABLE'],
]) test(`model rejection ${name} persists a bounded reason without retry or input`, async () => {
    const h = await searchWorld({ decide });
    const result = (await h.run()).details.task;
    assert.equal(result.code, code);
    assert.equal(result.counts.modelCalls, 1);
    assert.equal(h.actions.length, 0);
    assert.ok(h.events.some(e => e.rejectionReason === reason));
    assert.equal(h.events.filter(e => e.type === 'model').length, 1);
    assert.doesNotMatch(JSON.stringify(h.events), /private transport body/);
});

test('real trace allows new metadata while rejecting free text, extra fields and accessors', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-jev-evidence-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createTaskTraceStore({ directory });
    const header = { schemaVersion: 1, taskId: randomUUID(), serial: 'A', package: pkg, intent: 'search',
        inputRefs: ['query'], budget: LIMITS, decision: 'jev', policyVersion: 'search-v9', completionPolicyVersion: 'search-completion-v2' };
    const trace = await store.open(header);
    const event = { type: 'model', modelEvidence: modelEvidence(null, {}, 0,
        [{ requestId: randomUUID(), stage: 'http_response', elapsedMs: 10, httpStatus: 200 }]) };
    for (const invalid of [{ ...event, rejectionReason: 'private exception' },
        { ...event, modelEvidence: { ...event.modelEvidence, url: 'https://private' } },
        { ...event, modelEvidence: { ...event.modelEvidence, returnedModel: 'x'.repeat(129) } },
        { ...event, modelEvidence: { ...event.modelEvidence, transport: [{ ...event.modelEvidence.transport[0], body: 'private' }] } },
        { ...event, modelEvidence: { ...event.modelEvidence, transport: [{ ...event.modelEvidence.transport[0], httpStatus: 0 }] } },
        { ...event, modelEvidence: { ...event.modelEvidence, usage: { ...event.modelEvidence.usage, cost: 42 } } }]) {
        await assert.rejects(trace.append(invalid), { code: 'TRACE_INVALID_ARGUMENT' });
    }
    const bad = { ...event.modelEvidence };
    Object.defineProperty(bad, 'usage', { enumerable: true, get() { throw Error('getter executed'); } });
    await assert.rejects(trace.append({ ...event, modelEvidence: bad }), { code: 'TRACE_INVALID_ARGUMENT' });
    await trace.append(event);
    await trace.append({ type: 'decision', choice: 'invalid', rejectionReason: 'invalid_distribution' });
    await trace.close();
    const rows = (await fs.readFile(path.join(directory, `${header.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows[1].modelEvidence, event.modelEvidence);
    assert.equal(rows[2].rejectionReason, 'invalid_distribution');
});

test('maximum admitted evidence fits 512 KiB and the event budget still reserves termination', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-jev-capacity-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const targetId = id('x'.repeat(320 - id('').length));
    const header = { schemaVersion: 1, taskId: randomUUID(), serial: 'A', package: pkg, intent: 'search',
        inputRefs: ['query'], budget: LIMITS, decision: 'jev', assistance: 'main_agent', policyVersion: 'search-v9', completionPolicyVersion: 'search-completion-v2',
        loading: { id: targetId.slice(0, -1) + '3' },
        searchActions: { back: { from: targetId.slice(0, -1) + '4', target: targetId.slice(0, -1) + '5' }, imeAction: 'search', scroll: { command: 'Scroll', container: targetId, target: targetId.slice(0, -1) + '9', direction: 'right', maxSwipes: 4 } } };
    const trace = await createTaskTraceStore({ directory }).open(header);
    const scrollProof = { beforeObservationId: randomUUID(), afterObservationId: randomUUID(), beforeDigest: 'e'.repeat(64),
        afterDigest: 'f'.repeat(64), result: 'directional_motion', anchors: 64, distance: 100000 };
    const observation = { id: randomUUID(), digest: 'a'.repeat(64), contextDigest: 'b'.repeat(64),
        controls: 500, targetDigest: 'c'.repeat(64), outsideDigest: 'd'.repeat(64) };
    const semantics = { role: 'button', hints: ['search', 'query_field', 'search_entry', 'search_submit'], fieldRelation: 'other_parent' };
    const decisionContext = { version: 'search-feedback-v4', observationId: observation.id, round: 8, queryVerified: true,
        scrollProgress: { swipes: 4, maxSwipes: 4, lastResult: 'directional_motion' },
        screenChanged: false, consecutiveStale: 3, waits: 2, lastEvent: 'main_agent_reobserve',
        remaining: { timeoutMs: 300000, actions: 8, observations: 256, modelCalls: 16, rounds: 8, waits: 2 },
        recentActions: Array.from({ length: 3 }, () => ({ step: 'seek', command: 'Scroll', targetId, postcondition: 'search_scroll_progress',
            parameters: { direction: 'right', revealId: targetId.slice(0, -1) + '9' } })) };
    for (let i = 0; i < LIMITS.maxObservations; i++) await trace.append({ type: 'observation', step: 'complete', observation,
        loading: { matches: 1, visible: 1, safe: true },
        matched: false, completion: { present: true, containers: 1, items: 50, inputMatched: false, absent: true } });
    for (let i = 0; i < 3 * LIMITS.maxActions; i++) {
        await trace.append({ type: 'decision', step: 'submit', source: 'rule', targetId });
        await trace.append({ type: 'action', step: 'submit', phase: 'prepared', targetId });
        await trace.append({ type: 'action', step: i < 4 ? 'seek' : 'submit', phase: 'settled', targetId, requestId: randomUUID(), outcome: i < 4 ? 'verified' : 'failed',
            ...(i < 4 ? { scrollProof } : {}) });
    }
    for (let i = 0; i < LIMITS.maxModelCalls; i++) {
        await trace.append({ type: 'candidates', step: 'entry', observation, decisionContext,
            candidates: Array.from({ length: 8 }, (_, n) => ({ candidateId: `c${n}`, targetId: targetId.slice(0, -1) + n,
                command: 'Tap', inputRef: null, semantics, evidenceSources: ['id', 'text', 'desc'], postcondition: 'search_progress' })) });
        await trace.append({ type: 'model', step: 'entry', modelCalls: i + 1, observation,
            modelEvidence: modelEvidence({ provider: 'openrouter', requestedModel: 'x'.repeat(128) },
                { model: 'y'.repeat(128), usage: { input_tokens: 1e9, output_tokens: 1e9, total_tokens: 1e9 } }, 300000,
                Array.from({ length: 8 }, () => ({ requestId: randomUUID(), stage: 'failed', elapsedMs: 300000,
                    errorCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }))) });
        await trace.append({ type: 'decision', source: 'jev', choice: 'c0', observation, probability: 1, margin: 1 });
        await trace.append({ type: 'recovery', step: 'entry', observation, requestId: randomUUID(),
            recovery: { reason: 'dispatch_stale', consecutive: 2, retryAllowed: true } });
    }
    for (const episode of [1, 2]) for (const phase of ['started', 'settled']) {
        await trace.append({ type: 'wait', step: 'submit', observation,
            wait: { phase, episode, reason: 'declared_loading', elapsedMs: phase === 'started' ? 0 : 5000, matched: false } });
    }
    for (const phase of ['started', 'settled']) await trace.append({ type: 'assistance', step: 'entry', observation,
        assistance: { mode: 'main_agent', phase, action: phase === 'started' ? 'pending' : 'select', elapsedMs: 300000,
            ...(phase === 'settled' ? { candidateId: 'c0' } : {}) },
        ...(phase === 'settled' ? { mainModelRequests: 1, modelEvidence: modelEvidence({ requestedModel: 'x'.repeat(128) },
            { model: 'y'.repeat(128), usage: { input_tokens: 1e9, output_tokens: 1e9, total_tokens: 1e9 } }, 300000) } : {}) });
    const h = await searchWorld({ decide: (_, q) => response(q, 'escalate') });
    const packet = (await h.run()).details.task.escalation;
    packet.taskId = header.taskId;
    packet.searchActions = structuredClone(header.searchActions);
    packet.scope.commands = ['Tap', 'Fill', 'Scroll', 'ImeAction', 'KeyEvent'];
    packet.budget = { ...LIMITS };
    packet.observation = observation;
    packet.candidateObservationId = observation.id;
    packet.decisionContext = decisionContext;
    Object.assign(packet.counts, { mainModelCalls: 1, mainModelRequests: 1, humanHandoffs: 0 });
    packet.completion = { type: 'visible', id: targetId, item: targetId.slice(0, -1) + '1',
        absent: targetId.slice(0, -1) + '2', minItems: 50, itemMatchesInput: true };
    packet.loading = { id: targetId.slice(0, -1) + '3' };
    packet.loadingEvidence = { matches: 1, visible: 1, safe: true };
    packet.candidates = Array.from({ length: 8 }, (_, n) => ({ candidateId: `c${n}`, targetId: targetId.slice(0, -1) + n,
        command: 'Tap', inputRef: null, semantics, evidenceSources: ['id', 'text', 'desc'], postcondition: 'search_progress' }));
    packet.receipts = Array.from({ length: 24 }, (_, i) => ({ type: 'action', step: i < 4 ? 'seek' : 'submit', phase: 'settled',
        targetId, outcome: i < 4 ? 'verified' : 'failed', ...(i < 4 ? { scrollProof } : { code: 'TASK_OBSERVATION_CHANGED' }), requestId: randomUUID() }));
    packet.progress.verifiedReceiptIndexes = [0, 1, 2, 3];
    await trace.append({ type: 'escalation', step: 'submit', escalation: packet });
    await trace.append({ type: 'verification', matched: false, observation });
    await assert.rejects(trace.append({ type: 'observation' }), { code: 'TRACE_LIMIT' });
    await trace.append({ type: 'stopped', code: 'TASK_BUDGET_EXHAUSTED', outcome: 'failed' });
    await trace.close();
    const text = await fs.readFile(path.join(directory, `${header.taskId}.jsonl`), 'utf8');
    assert.equal(text.trim().split('\n').length, traceEventLimit(LIMITS) + 1);
    assert.ok(Buffer.byteLength(text) < 512 * 1024 - 4096);
    t.diagnostic(`maxima fixture: ${Buffer.byteLength(text)} bytes, ${traceEventLimit(LIMITS)} events, 4096-byte terminal reserve retained`);
});
