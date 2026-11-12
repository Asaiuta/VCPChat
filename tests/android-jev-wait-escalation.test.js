'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchWorld, spec, response, id } = require('./helpers/android-search-world.cjs');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { run: runSearch } = require('../modules/services/androidSearchLoop');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const fixtures = require('./fixtures/android-jev/cases.json');
const loading = { id: id('loading') };
const marker = extra => ({ name: 'loading', label: 'private loading text', kind: 'ProgressBar', clickable: false, ...extra });

test('declared loading waits through raw XML and then executes each search action once', async () => {
    let reads = 0;
    const h = await searchWorld({ onCapture() { reads++; },
        nodes: (nodes, page) => page === 'home' && reads < 4 ? [marker()] : nodes,
        decide: (state, q) => response(q, state.waitEvidence ? 'wait' : state.candidates[0].candidateId) });
    const result = (await h.run(spec({ loading }))).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(h.actions.map(a => a.target), ['open', 'query', 'search_go']);
    assert.equal(result.counts.modelCalls, 4);
    assert.deepEqual(h.events.filter(e => e.type === 'wait').map(e => e.wait.phase), ['started', 'settled']);
    assert.doesNotMatch(JSON.stringify(h.models), /private loading text|private query 731/);
});

test('model wait without declared loading evidence stops without input', async () => {
    const h = await searchWorld({ decide: (_, q) => response(q, 'wait') });
    const result = (await h.run()).details.task;
    assert.equal(result.code, 'TASK_WAIT_UNPROVEN');
    assert.equal(result.counts.modelCalls, 1);
    assert.equal(h.actions.length, 0);
});

test('loading admission is immutable, same-package and restricted to Jev', () => {
    const raw = spec({ loading: { ...loading } });
    const task = prepareTask(raw);
    raw.loading.id = id('other');
    assert.deepEqual(task.loading, loading);
    assert.ok(Object.isFrozen(task.loading));
    assert.throws(() => prepareTask(spec({ decision: 'rules', targets: { field: id('query'), submit: id('search_go') }, loading })), { code: 'TASK_INVALID' });
    for (const value of [{}, { id: 'com.foreign:id/loading' }, { id: id('results') }, { ...loading, timeoutMs: 9999 }]) {
        assert.throws(() => prepareTask(spec({ loading: value })), { code: 'TASK_INVALID' });
    }
});

test('partial progress escalation carries the frozen task and receipts without query or screen text', async () => {
    const h = await searchWorld({ start: 'form', decide: (state, q) => response(q, state.step === 'submit' ? 'escalate' : 'c0') });
    const result = (await h.run()).details.task;
    assert.equal(result.code, 'TASK_ESCALATION_REQUIRED');
    const packet = result.escalation;
    assert.equal(packet.schemaVersion, 1);
    assert.equal(packet.taskId, result.taskId);
    assert.equal(packet.disposition, 'assistance_required');
    assert.equal(packet.continuation, 'not_authorized');
    assert.deepEqual(packet.inputRefs, ['query']);
    assert.deepEqual(packet.completion, spec().completion);
    assert.deepEqual(packet.receipts, result.receipts);
    assert.deepEqual(packet.progress.verifiedReceiptIndexes, [0]);
    assert.equal(packet.remaining.actions, 5);
    assert.equal(packet.remaining.modelCalls, 6);
    assert.equal(packet.scope.policy, 'recheck_required');
    assert.deepEqual(h.actions.map(a => a.target), ['query']);
    assert.doesNotMatch(JSON.stringify([packet, h.events]), /private query 731/);
    assert.equal(h.events.filter(e => e.type === 'escalation').length, 1);
});

test('unknown input retains hard-stop evidence and grants no continuation', async () => {
    let attempts = 0;
    const h = await searchWorld({ invoke(method) {
        if (method === 'click') { attempts++; throw Object.assign(Error('private transport body'), { code: 'UI_SERVER_TIMEOUT', dispatched: true, drained: false }); }
    } });
    const result = (await h.run()).details.task;
    assert.equal(result.receipts[0].outcome, 'unknown');
    assert.equal(result.escalation.disposition, 'hard_stop');
    assert.equal(result.escalation.continuation, 'not_authorized');
    assert.deepEqual(result.escalation.progress.verifiedReceiptIndexes, []);
    assert.equal(attempts, 1);
    assert.doesNotMatch(JSON.stringify(result.escalation), /private transport body/);
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_STATE_UNCERTAIN' });
});

for (const [name, nodes, code] of [
    ['hidden', [marker({ visible: false })], 'TASK_WAIT_UNPROVEN'],
    ['duplicate', [marker(), marker()], 'TASK_TARGET_AMBIGUOUS'],
    ['password', [marker({ password: true })], 'TASK_TARGET_UNSAFE'],
    ['editable', [marker({ kind: 'EditText' })], 'TASK_TARGET_UNSAFE'],
    ['autocomplete input', [marker({ kind: 'AutoCompleteTextView' })], 'TASK_TARGET_UNSAFE'],
    ['clickable', [marker({ clickable: true })], 'TASK_TARGET_UNSAFE'],
]) test(`${name} loading marker cannot authorize waiting or writing`, async () => {
    const h = await searchWorld({ nodes: original => [...original, ...nodes], decide: (_, q) => response(q, 'wait') });
    const result = (await h.run(spec({ loading }))).details.task;
    assert.equal(result.code, code);
    assert.equal(h.events.filter(e => e.type === 'wait').length, 0);
    assert.equal(h.actions.length, 0);
});

test('a hidden ancestor cannot turn its child into visible loading evidence', async () => {
    const h = await searchWorld({ nodes: nodes => [...nodes, marker()],
        transformXml: xml => xml.replace(/(<node [^>]*resource-id="com.example:id\/loading"[^>]*\/>)/,
            '<node class="android.widget.FrameLayout" package="com.example" visible-to-user="false" bounds="[0,0][100,200]">$1</node>'),
        decide: (_, q) => response(q, 'wait') });
    const result = (await h.run(spec({ loading }))).details.task;
    assert.equal(result.code, 'TASK_WAIT_UNPROVEN');
    assert.equal(h.actions.length, 0);
});

test('a loading marker is evidence only when explicitly declared', async () => {
    const h = await searchWorld({ nodes: nodes => [...nodes, marker()], decide: (_, q) => response(q, 'wait') });
    assert.equal((await h.run()).details.task.code, 'TASK_WAIT_UNPROVEN');
    assert.equal(h.events.filter(e => e.type === 'wait').length, 0);
});

// A virtual clock verifies temporal boundaries without five-second wall sleeps.
// Separate Service tests above and below exercise the real raw-tree/task-port path.
async function clockLoop(options = {}) {
    let time = 0, reads = 0, calls = 0, writes = 0;
    const events = [], pauses = [], deadlines = [], states = [];
    const task = prepareTask(spec({ loading, budget: { maxObservations: options.maxObservations || 96 } }));
    const check = () => {
        if (options.cancelAt !== undefined && time >= options.cancelAt) throw Object.assign(Error(), { code: 'STEP_ABORTED' });
        if (time >= (options.rootDeadline ?? 60000)) throw Object.assign(Error(), { code: 'STEP_DEADLINE' });
    };
    const control = { id: id('open'), role: 'button', enabled: true, inViewport: true, password: false, clickable: true, text: 'Search', desc: '' };
    let code;
    try {
        await runSearch(task, {
            remainingBudget: () => ({ timeoutMs: 60000-time, actions: 6-writes, observations: 96-reads, modelCalls: 8-calls, rounds: 8-states.at(-1).rounds, waits: 2-states.at(-1).waits }),
            check, now: () => time, remainingMs: () => (options.rootDeadline ?? 60000) - time,
            pause: async ms => { pauses.push(ms); time += ms; },
            async observe(request = {}) {
                check();
                if (++reads > task.budget.maxObservations) throw Object.assign(Error(), { code: 'TASK_BUDGET_EXHAUSTED' });
                deadlines.push(request.deadlineMs);
                if (options.slowCapture && reads > 1) time += options.slowCapture;
                if (options.captureError && reads > 1) throw Object.assign(Error(), options.captureError);
                const active = options.loadingAt ? options.loadingAt({ time, reads, calls }) : time < (options.clearAt ?? Infinity);
                return { complete: true, package: task.package, displayId: 0,
                    observation: { id: randomUUID(), digest: String(reads).padStart(64, '0'),
                        contextDigest: (options.contextAt && time >= options.contextAt || options.contextRead && reads >= options.contextRead ? 'b' : 'a').repeat(64), controls: 1 },
                    contextDiff: options.epochAt && time >= options.epochAt ? ['epoch'] : [],
                    controls: time >= (options.candidatesAt ?? 0) ? [control] : [],
                    loading: { matches: active ? 1 : 0, visible: active ? 1 : 0, safe: true } };
            },
            async model(state, q) { calls++; return response(q, state.waitEvidence ? 'wait' : 'escalate'); },
            async act() { writes++; },
            async append(event) { events.push(event); if (options.slowTrace && event.wait?.phase === 'started') time += options.slowTrace; },
            setStep() {}, onState: state => states.push(state), completedActions: () => 0,
            hasPreexistingCompletion: () => options.oldResultAt !== undefined && time >= options.oldResultAt,
            onStale() {},
        });
    } catch (error) { code = error.code; }
    return { code, time, reads, calls, writes, events, pauses, deadlines, states };
}

test('marker disappearance and candidate availability share one fixed window', async () => {
    const r = await clockLoop({ clearAt: 600, candidatesAt: 1200 });
    assert.equal(r.code, 'TASK_ESCALATION_REQUIRED');
    assert.equal(r.time, 1200);
    assert.equal(r.calls, 2);
    assert.equal(r.writes, 0);
    assert.ok(r.deadlines.filter(Boolean).every(x => x === 5000));
    assert.equal(r.events.find(e => e.wait?.phase === 'settled').wait.matched, true);
});

for (const [name, options, code] of [
    ['expired capture', { slowCapture: 5000, captureError: { code: 'VERIFICATION_TIMEOUT' } }, 'TASK_WAIT_TIMEOUT'],
    ['expired ADB capture', { slowCapture: 5000, captureError: { code: 'ADB_TIMEOUT' } }, 'TASK_WAIT_TIMEOUT'],
    ['early capture failure', { captureError: { code: 'VERIFICATION_TIMEOUT' } }, 'VERIFICATION_TIMEOUT'],
    ['in-flight request', { slowCapture: 5000, captureError: { code: 'VERIFICATION_TIMEOUT', inFlight: true } }, 'VERIFICATION_TIMEOUT'],
    ['undrained request', { slowCapture: 5000, captureError: { code: 'VERIFICATION_TIMEOUT', drained: false } }, 'VERIFICATION_TIMEOUT'],
    ['undrained ADB capture', { slowCapture: 5000, captureError: { code: 'ADB_TIMEOUT', drained: false } }, 'ADB_TIMEOUT'],
    ['transport timeout', { slowCapture: 5000, captureError: { code: 'UI_SERVER_TIMEOUT' } }, 'UI_SERVER_TIMEOUT'],
    ['cancellation at expiry', { slowCapture: 5000, cancelAt: 5000, captureError: { code: 'VERIFICATION_TIMEOUT' } }, 'STEP_ABORTED'],
    ['root deadline at expiry', { slowCapture: 5000, rootDeadline: 5000, captureError: { code: 'VERIFICATION_TIMEOUT' } }, 'STEP_DEADLINE'],
]) test(`loading deadline preserves ${name}`, async () => {
    const r = await clockLoop(options);
    assert.equal(r.code, code);
    assert.equal(r.events.at(-1).code, code);
    assert.equal(r.calls, 1);
    assert.equal(r.writes, 0);
});

test('production capture expiry retains the wait cause in its persisted escalation', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-loading-expiry-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let reads = 0;
    const h = await searchWorld({ traceStore: createTaskTraceStore({ directory }),
        onCapture() { if (++reads === 2) t.mock.timers.tick(5000); },
        nodes: () => [marker()], decide: (_, q) => response(q, 'wait') });
    t.after(() => h.service.cleanup());
    const result = (await h.run(spec({ loading }))).details.task;
    assert.equal(result.code, 'TASK_WAIT_TIMEOUT');
    assert.equal(result.escalation.disposition, 'assistance_required');
    assert.equal(result.escalation.remaining.timeoutMs, 55000);
    assert.equal(result.counts.modelCalls, 1);
    assert.equal(h.actions.length, 0);
    const rows = (await fs.readFile(path.join(directory, `${result.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.find(e => e.wait?.phase === 'settled').code, 'TASK_WAIT_TIMEOUT');
    assert.deepEqual(rows.find(e => e.type === 'escalation').escalation, result.escalation);
    assert.equal(rows.at(-1).code, 'TASK_WAIT_TIMEOUT');
});

for (const { name, options, code } of [...fixtures.waitCases,
    { name: 'late capture', options: { loadingAt: ({ reads }) => reads === 1, slowCapture: 5000 }, code: 'TASK_WAIT_TIMEOUT' },
]) test(`waiting stops on ${name} without a second model or write`, async () => {
    const r = await clockLoop(options);
    assert.equal(r.code, code);
    assert.equal(r.calls, 1);
    assert.equal(r.writes, 0);
    assert.equal(r.events.at(-1).wait.matched, false);
    assert.equal(r.events.at(-1).code, code);
    assert.ok(r.states.every(s => s.waits <= 1));
});

test('loading failure after a verified fill preserves the receipt and never submits', async () => {
    let h;
    h = await searchWorld({ start: 'form', nodes: nodes => h?.events.some(e => e.phase === 'settled' && e.step === 'fill')
        ? [...nodes, marker()] : nodes,
        decide: (state, q) => response(q, state.waitEvidence ? 'wait' : state.candidates[0].candidateId) });
    const result = (await h.run(spec({ loading, budget: { maxObservations: 12 } }))).details.task;
    assert.equal(result.code, 'TASK_BUDGET_EXHAUSTED', JSON.stringify(result));
    assert.deepEqual(h.actions.map(a => a.target), ['query']);
    assert.deepEqual(result.escalation.progress.verifiedReceiptIndexes, [0]);
    assert.equal(result.escalation.progress.waits, 1);
    assert.equal(result.escalation.remaining.observations, 0);
    assert.equal(result.escalation.disposition, 'hard_stop');
});

test('an escalation trace failure preserves the stopped outcome and earlier receipts', async () => {
    const h = await searchWorld({ start: 'form', traceFailAt: 'escalation',
        decide: (state, q) => response(q, state.step === 'submit' ? 'escalate' : 'c0') });
    const result = (await h.run()).details.task;
    assert.equal(result.code, 'TASK_TRACE_FAILED');
    assert.equal(result.escalation.reason, result.code);
    assert.equal(result.escalation.disposition, 'hard_stop');
    assert.deepEqual(h.actions.map(a => a.target), ['query']);
    assert.equal(h.events.at(-1).type, 'stopped');
    assert.equal(h.events.at(-1).code, 'TASK_TRACE_FAILED');
});

test('stale failure preserves the candidate observation separately from the later observation', async () => {
    let h;
    h = await searchWorld({ decide(_, q) { h.change(); return response(q, 'c0'); } });
    const result = (await h.run()).details.task;
    assert.equal(result.code, 'TASK_STALE_LIMIT');
    assert.notEqual(result.escalation.candidateObservationId, result.escalation.observation.id);
    assert.equal(result.escalation.evidenceFreshness, 'historical');
    assert.equal(result.escalation.progress.consecutiveStale, 3);
    assert.equal(result.escalation.remaining.modelCalls, 5);
    assert.equal(result.escalation.remaining.rounds, 5);
    assert.equal(result.escalation.receipts.length, 0);
});

test('third loading episode cannot reopen a window or reset the original round count', async () => {
    const r = await clockLoop({ loadingAt: ({ reads }) => reads % 2 === 1 });
    assert.equal(r.code, 'TASK_WAIT_LIMIT');
    assert.equal(r.calls, 3);
    assert.equal(r.writes, 0);
    assert.equal(r.time, 400);
    assert.equal(r.events.filter(e => e.wait?.phase === 'started').length, 2);
    assert.deepEqual(r.states.at(-1), { rounds: 3, waits: 2, consecutiveStale: 0 });
});

test('a different context immediately after a successful wait is not rebaselined', async () => {
    const virtual = await clockLoop({ clearAt: 200, contextRead: 3 });
    assert.equal(virtual.code, 'TASK_CONTEXT_UNPROVEN');
    assert.equal(virtual.events.find(e => e.wait?.phase === 'settled').wait.matched, true);
    assert.equal(virtual.calls, 1);
    // The same contextDigest with an epoch difference must also remain a hard stop.
    let reads = 0;
    const h = await searchWorld({ onCapture() { reads++; },
        nodes: nodes => reads < 3 ? [...nodes, marker()] : nodes,
        probeScreen() { const component = reads >= 3 ? 'com.example/.Other' : 'com.example/.Main';
            return { focus: { package: 'com.example', component, window: `Window{same u0 ${component}}` }, size: { width: 100, height: 200 },
                wakefulness: 'Awake', rotation: 0, displayId: 0, keyguard: { showing: false, inputRestricted: false } }; },
        decide: (state, q) => response(q, state.waitEvidence ? 'wait' : 'c0') });
    const result = (await h.run(spec({ loading }))).details.task;
    assert.ok(['TASK_CONTEXT_UNPROVEN', 'UI_CONTEXT_CHANGED'].includes(result.code), JSON.stringify(result));
    assert.equal(h.actions.length, 0);
    assert.equal(result.escalation.disposition, 'hard_stop');
});

test('an unlabeled loading-only page uses declared raw evidence even when presentation prunes it', async () => {
    let calls = 0;
    const h = await searchWorld({ nodes: nodes => calls === 0 ? [marker({ label: '' })] : nodes,
        decide(state, q) { calls++; return response(q, state.waitEvidence ? 'wait' : 'escalate'); } });
    const result = (await h.run(spec({ loading }))).details.task;
    assert.equal(result.code, 'TASK_ESCALATION_REQUIRED', JSON.stringify(result));
    assert.equal(result.escalation.progress.waits, 1);
    assert.equal(h.actions.length, 0);
    assert.equal(h.events.find(e => e.type === 'candidates').observation.controls, 0);
});

test('unrelated text changes do not permit a previously visited search state', async () => {
    let h;
    h = await searchWorld({ multiEntry: true, cycle: true, onCapture() { if (h?.actions.length === 2) h.change(); } });
    const result = (await h.run()).details.task;
    assert.equal(result.code, 'TASK_NO_PROGRESS');
    assert.deepEqual(h.actions.map(a => a.target), ['open', 'action_search']);
    assert.equal(result.counts.modelCalls, 2);
    assert.equal(result.escalation.counts.verifiedActions, 1);
    assert.deepEqual(result.receipts.map(r => r.outcome), ['verified', 'unknown']);
});

test('waiting after a verified fill resumes submit without filling again', async () => {
    let h, loadingReads = 0;
    h = await searchWorld({ start: 'form', nodes: nodes => h?.events.some(e => e.phase === 'settled' && e.step === 'fill') && loadingReads++ < 3
        ? [...nodes, marker()] : nodes,
        decide: (state, q) => response(q, state.waitEvidence ? 'wait' : state.candidates[0].candidateId) });
    const result = (await h.run(spec({ loading }))).details.task;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(h.actions.map(a => a.target), ['query', 'search_go']);
    assert.equal(result.counts.verifiedActions, 2);
    assert.equal(result.counts.modelCalls, 3);
});

test('waiting consumes the same model allowance before any subsequent action', async () => {
    let calls = 0;
    const h = await searchWorld({ nodes: nodes => calls === 0 ? [marker()] : nodes,
        decide(state, q) { calls++; return response(q, state.waitEvidence ? 'wait' : state.candidates[0].candidateId); } });
    const result = (await h.run(spec({ loading, budget: { maxModelCalls: 2 } }))).details.task;
    assert.equal(result.code, 'TASK_BUDGET_EXHAUSTED');
    assert.deepEqual(h.actions.map(a => a.target), ['open']);
    assert.equal(result.escalation.remaining.modelCalls, 0);
    assert.equal(result.escalation.progress.waits, 1);
});

test('Service cancellation during loading retains its terminal evidence and never writes', async () => {
    const controller = new AbortController(); let h;
    h = await searchWorld({ nodes: () => [marker()], onCapture() {
        if (h?.events.some(e => e.wait?.phase === 'started')) controller.abort();
    }, decide: (_, q) => response(q, 'wait') });
    await assert.rejects(h.run(spec({ loading }), { signal: controller.signal }), { code: 'STEP_ABORTED' });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const packet = h.events.find(e => e.type === 'escalation')?.escalation;
    assert.equal(packet.reason, 'STEP_ABORTED');
    assert.equal(packet.remaining.timeoutMs, 0);
    assert.equal(packet.disposition, 'hard_stop');
    assert.equal(h.events.at(-1).type, 'stopped');
    assert.equal(h.models.length, 1);
    assert.equal(h.actions.length, 0);
});

test('real trace persists waits and the same bounded escalation packet, rejecting extra data and getters', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-wait-escalation-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let calls = 0;
    const store = createTaskTraceStore({ directory });
    const h = await searchWorld({ traceStore: store, nodes: nodes => calls === 0 ? [marker()] : nodes,
        decide(state, q) { calls++; return response(q, state.waitEvidence ? 'wait' : 'escalate'); } });
    const result = (await h.run(spec({ loading }))).details.task;
    assert.equal(result.code, 'TASK_ESCALATION_REQUIRED', JSON.stringify(result));
    const raw = await fs.readFile(path.join(directory, `${result.taskId}.jsonl`), 'utf8');
    assert.doesNotMatch(raw, /private query 731|private loading text/);
    const rows = raw.trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].policyVersion, 'search-v9');
    assert.deepEqual(rows[0].loading, loading);
    assert.deepEqual(rows.find(e => e.type === 'observation').loading, { matches: 1, visible: 1, safe: true });
    assert.deepEqual(result.escalation.loadingEvidence, { matches: 0, visible: 0, safe: true });
    assert.equal(rows.filter(e => e.type === 'wait').length, 2);
    assert.deepEqual(rows.at(-2).escalation, result.escalation);
    assert.equal(rows.at(-1).type, 'stopped');
    const header = { ...rows[0], taskId: randomUUID() }; delete header.seq; delete header.type;
    const trace = await store.open(header);
    const packet = { ...result.escalation, taskId: header.taskId };
    let getterCalls = 0;
    const badScope = { ...packet.scope };
    Object.defineProperty(badScope, 'serial', { enumerable: true, get() { getterCalls++; return 'A'; } });
    for (const invalid of [
        { ...packet, rawText: 'private' }, { ...packet, inputRefs: ['private'] },
        { ...packet, continuation: 'resume' }, { ...packet, scope: badScope },
        { ...packet, completion: { ...packet.completion, id: 'com.foreign:id/results' } },
        { ...packet, candidates: [{ ...packet.candidates[0], label: 'private' }] },
        { ...packet, taskId: result.taskId },
        { ...packet, budget: { ...packet.budget, maxModelCalls: 16 } },
        { ...packet, loading: { id: id('different_loader') } },
        { ...packet, loadingEvidence: { matches: 1, visible: 1, safe: true, label: 'private' } },
    ]) await assert.rejects(trace.append({ type: 'escalation', escalation: invalid }), { code: 'TRACE_INVALID_ARGUMENT' });
    assert.equal(getterCalls, 0);
    await trace.append({ type: 'escalation', escalation: packet });
    await trace.append({ type: 'stopped', code: packet.reason });
    await trace.close();
});
