'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { searchWorld, spec, response, id } = require('./helpers/android-search-world.cjs');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const taskOf = result => result.details.task;
const advice = (packet, extra = {}) => ({ schemaVersion: 1, taskId: packet.taskId,
    observationId: packet.observationId, action: 'select', candidateId: 'c0', ...extra });
const trigger = (state, questions) => response(questions, state.step === 'entry' ? 'escalate' : state.candidates[0].candidateId);

test('normal search never calls assistance; opt-in and missing service stop without writes', async t => {
    const world = await searchWorld(); t.after(world.close);
    let calls = 0;
    const result = taskOf(await world.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: () => { calls++; } }));
    assert.equal(result.status, 'completed'); assert.equal(calls, 0); assert.equal(result.counts.mainModelCalls, 0);
    const stopped = await searchWorld({ decide: trigger }); t.after(stopped.close);
    assert.equal(taskOf(await stopped.run()).code, 'TASK_ESCALATION_REQUIRED');
    assert.equal(taskOf(await stopped.run(spec({ assistance: 'main_agent' }))).code, 'TASK_ASSISTANCE_UNAVAILABLE');
    assert.equal(stopped.actions.length, 0);
});

test('one main Agent selection resumes the existing loop and production trace without leaking input', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-assist-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const world = await searchWorld({ decide: trigger, traceStore: createTaskTraceStore({ directory }) }); t.after(world.close);
    let calls = 0;
    const result = taskOf(await world.run(spec({ assistance: 'main_agent' }), { async androidTaskReplan(packet) {
        calls++; assert.ok(!JSON.stringify(packet).includes('private query'));
        assert.equal(packet.evidence.scope.policy, 'recheck_required');
        return advice(packet);
    } }));
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(calls, 1); assert.equal(result.counts.mainModelCalls, 1);
    assert.equal(result.counts.modelCalls, 3); assert.equal(result.counts.verifiedActions, 3);
    assert.deepEqual(world.actions.map(a => a.target), ['open', 'query', 'search_go']);
    const rows = (await fs.readFile(path.join(directory, `${result.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].policyVersion, 'search-v9');
    assert.equal(rows.filter(r => r.type === 'assistance').length, 2);
    assert.equal(rows.at(-1).type, 'completed');
});

for (const kind of ['identity', 'candidate', 'extra', 'stop', 'repeat', 'stale']) test(`main Agent ${kind} cannot authorize extra writes`, async t => {
    const world = await searchWorld({ decide: trigger }); t.after(world.close);
    let calls = 0;
    const result = taskOf(await world.run(spec({ assistance: 'main_agent' }), { async androidTaskReplan(packet) {
        calls++;
        if (kind === 'stale') world.change();
        return advice(packet, kind === 'identity' ? { observationId: 'forged' } : kind === 'candidate' ? { candidateId: 'c7' }
            : kind === 'extra' ? { command: 'RunTask' } : kind === 'stop' ? { action: 'stop', candidateId: undefined }
                : kind === 'repeat' ? { action: 'reobserve', candidateId: undefined } : {});
    } }));
    assert.equal(result.status, 'stopped'); assert.equal(calls, 1); assert.equal(world.actions.length, 0);
    assert.equal(result.code, ['repeat', 'stale'].includes(kind) ? 'TASK_ASSISTANCE_LIMIT'
        : kind === 'stop' ? 'TASK_ASSISTANCE_STOPPED' : 'TASK_REPLAN_INVALID');
});

test('human handoff resumes only after a fresh observation and keeps one assistance budget', async t => {
    let world, calls = 0;
    world = await searchWorld({ decide(state, questions) {
        if (!calls) return response(questions, 'escalate');
        return response(questions, state.candidates[0].candidateId);
    }, services: { humanInteraction: { async request({ kind }) { assert.equal(kind, 'handoff'); calls++; return true; } } } });
    t.after(world.close);
    const result = taskOf(await world.run(spec({ assistance: 'human' })));
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.counts.humanHandoffs, 1); assert.equal(result.counts.mainModelCalls, 0);
    assert.equal(result.counts.modelCalls, 4); assert.equal(world.actions.length, 3);
});

test('handoff refusal stops; handing back cannot erase already verified input', async t => {
    const refused = await searchWorld({ decide: trigger, services: { humanInteraction: { request: async () => false } } }); t.after(refused.close);
    assert.equal(taskOf(await refused.run(spec({ assistance: 'human' }))).code, 'TASK_HANDOFF_REJECTED');
    assert.equal(refused.actions.length, 0);
    let world;
    world = await searchWorld({ decide: (state, questions) => response(questions, state.step === 'submit' ? 'escalate' : state.candidates[0].candidateId),
        services: { humanInteraction: { request: async () => { world.setValue('query', 'changed'); return true; } } } }); t.after(world.close);
    const result = taskOf(await world.run(spec({ assistance: 'human' })));
    assert.equal(result.code, 'TASK_PROGRESS_LOST'); assert.equal(result.counts.verifiedActions, 2);
    assert.deepEqual(world.actions.map(a => a.target), ['open', 'query']);
});

test('invalid distribution and unknown action never invoke main Agent', async t => {
    let calls = 0;
    const invalid = await searchWorld({ decide: () => ({}) }); t.after(invalid.close);
    const context = { androidTaskReplan: () => { calls++; } };
    assert.equal(taskOf(await invalid.run(spec({ assistance: 'main_agent' }), context)).code, 'TASK_JEV_INVALID');
    const unknown = await searchWorld({ invoke(method) { if (method === 'click') throw Error('transport lost'); } }); t.after(unknown.close);
    const result = taskOf(await unknown.run(spec({ assistance: 'main_agent' }), context));
    assert.equal(result.status, 'stopped'); assert.equal(calls, 0); assert.equal(result.counts.actionAttempts, 1);
});

test('valid low confidence can use the single main Agent selection', async t => {
    const world = await searchWorld({ decide(state, questions) {
        if (state.step !== 'entry') return response(questions, 'c0');
        return { answers: { [Object.keys(questions)[0]]: { probabilities: { c0: 0.5, wait: 0, escalate: 0.5 } } } };
    } }); t.after(world.close);
    const result = taskOf(await world.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async p => {
        assert.equal(p.evidence.reason, 'TASK_JEV_UNCERTAIN'); return advice(p);
    } }));
    assert.equal(result.status, 'completed'); assert.equal(result.counts.modelCalls, 3); assert.equal(result.counts.mainModelCalls, 1);
});

test('assistance trace failure makes zero callbacks; stopped production trace preserves actual HTTP attempt evidence', async t => {
    let calls = 0;
    const failed = await searchWorld({ decide: trigger, traceFailAt: 'assistance' }); t.after(failed.close);
    const result = taskOf(await failed.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: () => { calls++; } }));
    assert.equal(result.code, 'TASK_TRACE_FAILED'); assert.equal(calls, 0); assert.equal(result.counts.mainModelCalls, 0);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-stop-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const world = await searchWorld({ decide: trigger, traceStore: createTaskTraceStore({ directory }) }); t.after(world.close);
    const stopped = taskOf(await world.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async (p, options) => {
        options.onModelMetadata({ httpRequests: 1, requestedModel: 'actual', returnedModel: 'reported', elapsedMs: 1,
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
        return advice(p, { candidateId: 'c7' });
    } }));
    assert.equal(stopped.code, 'TASK_REPLAN_INVALID'); assert.equal(stopped.counts.mainModelRequests, 1);
    const rows = (await fs.readFile(path.join(directory, `${stopped.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.at(-2).escalation, stopped.escalation); assert.equal(rows.at(-1).code, 'TASK_REPLAN_INVALID');
    assert.equal(world.actions.length, 0);
});

test('main Agent has a ten-second cap inside a longer task deadline and never accepts a late selection', async t => {
    const world = await searchWorld({ decide: trigger }); t.after(world.close);
    const result = taskOf(await world.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async (p, options) => {
        assert.ok(options.timeoutMs <= 10000);
        await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
        return advice(p);
    } }));
    assert.equal(result.code, 'TASK_ASSISTANCE_TIMEOUT'); assert.equal(result.counts.mainModelCalls, 1);
    assert.equal(world.actions.length, 0); assert.ok(result.escalation.remaining.timeoutMs > 0);
});

for (const mode of ['main_agent', 'human']) test(`${mode} cannot cross a changed window context`, async t => {
    let moved = false;
    const world = await searchWorld({ decide: trigger, probeScreen() {
        const component = `com.example/.${moved ? 'Other' : 'Main'}`;
        return { focus: { package: 'com.example', component, window: `Window{same u0 ${component}}` },
            size: { width: 100, height: 200 }, rotation: 0, displayId: 0, wakefulness: 'Awake', keyguard: { showing: false, inputRestricted: false } };
    }, services: { humanInteraction: { request: async () => { moved = true; return true; } } } }); t.after(world.close);
    const result = taskOf(await world.run(spec({ assistance: mode }), { androidTaskReplan: async p => { moved = true; return advice(p); } }));
    assert.equal(result.code, 'TASK_CONTEXT_UNPROVEN'); assert.equal(world.actions.length, 0);
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
for (const mode of ['main_agent', 'human']) for (const boundary of ['cancel', 'deadline', 'viewer']) {
    test(`${mode} ${boundary} retains lease until dependency drain, then never resumes`, async t => {
        const entered = deferred(), release = deferred(), controller = new AbortController(); let signal;
        const block = async (_packet, options) => { signal = options.signal; entered.resolve(); await release.promise; return true; };
        const world = await searchWorld({ decide: trigger, services: { humanInteraction: { request: request => block(null, request) } } }); t.after(world.close);
        const running = world.run(spec({ assistance: mode, budget: { timeoutMs: boundary === 'deadline' ? 100 : 60000 } }),
            { signal: controller.signal, androidTaskReplan: async (p, options) => { await block(p, options); return advice(p); } })
            .then(() => assert.fail('must stop at boundary'), error => error);
        let acquisition;
        try {
            await entered.promise;
            if (boundary === 'cancel') controller.abort();
            if (boundary === 'viewer') acquisition = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime').acquireTakeover({ serial: 'A' });
            assert.equal((await running).code, boundary === 'deadline' ? 'STEP_DEADLINE' : 'STEP_ABORTED');
            assert.equal(signal.aborted, true);
            await assert.rejects(world.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
        } finally {
            release.resolve(); await tick(); await tick();
            if (acquisition) await require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime').releaseTakeover(await acquisition);
        }
        assert.equal(world.actions.length, 0); assert.equal(world.models.length, 1);
        assert.equal(world.events.at(-1).type, 'stopped');
    });
}
