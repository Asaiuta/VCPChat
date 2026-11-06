'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createAndroidTaskExecutor } = require('../modules/services/androidTaskExecutor');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { traceEventLimit } = require('../modules/services/androidTaskBudget');
const digest = value => createHash('sha256').update(String(value)).digest('hex');

test('a legal search exceeding 64 trace events completes with the production trace store', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-budget-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const executor = createAndroidTaskExecutor({ traceStore: createTaskTraceStore({ directory }) });
    const id = name => `com.example:id/${name}`;
    const task = executor.prepare({ serial: 'A', package: 'com.example', intent: 'search', inputs: { query: 'query' },
        targets: { entry: id('entry'), field: id('field'), submit: id('submit') },
        completion: { type: 'visible', id: id('results') }, budget: { maxObservations: 128 } });
    let stage = 0, reads = 0, total = 0, writes = 0;
    const control = (name, role) => ({ id: id(name), enabled: true, inViewport: true, password: false, role, clickable: role !== 'textfield' });
    const device = {
        check() {}, async preflight() {}, remainingMs: () => 60000,
        // Yield without wall-clock waiting: each page changes 18 times then settles.
        pause: () => new Promise(resolve => setImmediate(resolve)), signal: new AbortController().signal,
        observationCount: () => total,
        async observe() {
            reads++; total++;
            return { complete: true, package: task.package, displayId: 0,
                observation: { id: randomUUID(), digest: digest(`${stage}:${Math.min(reads, 19)}`), contextDigest: digest('same'), controls: 2 },
                controls: stage === 0 ? [control('entry', 'button')] : [control('field', 'textfield'), control('submit', 'button')],
                completion: { present: stage === 3, containers: stage === 3 ? 1 : 0, items: 0, inputMatched: false, absent: true } };
        },
        async execute() { stage++; writes++; reads = 0; return { execution: { requestId: randomUUID(), outcome: 'verified' } }; },
    };
    const result = await executor.run(task, device);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.counts.observations, 80);
    assert.equal(writes, 3);
    const rows = (await fs.readFile(path.join(directory, `${task.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(rows.length > 64);
    assert.equal(rows.at(-1).type, 'completed');
});

test('trace exhaustion stops before dispatch and persists the terminal reason', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-budget-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createTaskTraceStore({ directory });
    const executor = createAndroidTaskExecutor({ traceStore: {
        async open(header) {
            const trace = await store.open(header);
            // Fill ordinary-event capacity to exercise the executor/store failure boundary.
            for (let i = 0; i < traceEventLimit(header.budget) - 1; i++) await trace.append({ type: 'observation' });
            return trace;
        },
    } });
    const task = executor.prepare({ serial: 'A', package: 'com.example', intent: 'search', inputs: { query: 'query' },
        targets: { field: 'com.example:id/field', submit: 'com.example:id/submit' },
        completion: { type: 'visible', id: 'com.example:id/results' } });
    let writes = 0;
    const result = await executor.run(task, {
        check() {}, async preflight() {}, remainingMs: () => 60000,
        pause: async () => {}, signal: new AbortController().signal, observationCount: () => 1,
        async observe() {
            return { complete: true, package: task.package, displayId: 0,
                observation: { id: randomUUID(), digest: digest('page'), contextDigest: digest('context'), controls: 0 } };
        },
        async execute() { writes++; throw new Error('Must not dispatch after trace exhaustion'); },
    });
    assert.equal(result.status, 'stopped');
    assert.equal(result.code, 'TASK_TRACE_LIMIT');
    assert.equal(writes, 0);
    const rows = (await fs.readFile(path.join(directory, `${task.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).type, 'stopped');
    assert.equal(rows.at(-1).code, 'TASK_TRACE_LIMIT');
});
