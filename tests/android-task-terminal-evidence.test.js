'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { searchWorld, spec, id } = require('./helpers/android-search-world.cjs');
const { routeWorld } = require('./helpers/android-route-world.cjs');
const { toggleWorld } = require('./helpers/android-toggle-world.cjs');

test('completion failure preserves its cause and the historical candidate stage in the production trace', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-terminal-evidence-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const world = await searchWorld({ start: 'form', traceStore: createTaskTraceStore({ directory }) });
    t.after(() => world.service.cleanup());
    const result = (await world.run(spec({
        completion: { type: 'visible', id: id('results'), item: id('item'), minItems: 1 },
        budget: { maxObservations: 18 },
    }))).details.task;
    assert.equal(result.code, 'TASK_BUDGET_EXHAUSTED');
    assert.equal(result.escalation.step, 'complete');
    assert.equal(result.escalation.candidateStep, 'submit');
    assert.deepEqual(world.actions.map(a => a.method), ['setText', 'click']);
    const rows = (await fs.readFile(path.join(directory, `${result.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    const evidence = rows.find(e => e.type === 'escalation').escalation;
    assert.deepEqual(evidence, result.escalation);
    assert.equal(rows.at(-1).code, result.code);
    assert.equal(evidence.candidateObservationId, rows.filter(e => e.type === 'candidates').at(-1).observation.id);
    assert.doesNotMatch(JSON.stringify(rows), /private query 731/);

    const header = { ...rows[0], taskId: require('node:crypto').randomUUID() };
    delete header.type; delete header.seq;
    const trace = await createTaskTraceStore({ directory }).open(header);
    t.after(() => trace.close());
    const packet = { ...evidence, taskId: header.taskId };
    for (const key of ['candidateStep', 'decisionContext']) {
        const legacy = { ...packet }; delete legacy[key];
        await assert.rejects(trace.append({ type: 'escalation', step: 'complete', escalation: legacy }),
            { code: 'TRACE_INVALID_ARGUMENT' });
    }
    for (const candidateStep of ['entry', 'complete', 'private stage', null]) {
        await assert.rejects(trace.append({ type: 'escalation', step: 'complete', escalation: { ...packet, candidateStep } }),
            { code: 'TRACE_INVALID_ARGUMENT' });
    }
});

for (const [name, world, candidateStep, maxObservations] of [
    ['route', routeWorld, 'route_submit', 32], ['toggle', toggleWorld, 'toggle', 16],
]) test(`${name} terminal verification keeps the last decision stage without relaxing its candidate binding`, async t => {
    let finalVerification = false;
    const w = await world({ onTrace(event) {
        if (event.type === 'action' && event.step === candidateStep && event.phase === 'settled') finalVerification = true;
    }, onCapture(state) { if (finalVerification) state.version++; } });
    t.after(async () => { await w.service.cleanup(); await w.close(); });
    const result = await w.run({ budget: { maxObservations } });
    assert.equal(result.status, 'stopped');
    assert.equal(result.code, 'TASK_BUDGET_EXHAUSTED');
    assert.equal(result.escalation.step, 'complete');
    assert.equal(result.escalation.candidateStep, candidateStep);
    const rows = await w.trace();
    assert.deepEqual(rows.find(e => e.type === 'escalation').escalation, result.escalation);
    assert.equal(rows.at(-1).code, result.code);
});
