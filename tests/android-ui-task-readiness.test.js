'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { run } = require('../modules/services/androidUiTaskLoop');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');

// Local clock/device doubles only; no model service, network or ADB requests.
for (const cancelled of [false, true]) test(`host loading preserves durable evidence and cancellation, cancelled=${cancelled}`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-ui-readiness-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let now = 1000, reads = 0, models = 0, writes = 0;
    t.mock.method(Date, 'now', () => now);
    const task = prepareTask({ serial: 'A', package: 'com.example', intent: 'ui_task', decision: 'jev',
        goal: 'Wait for the requested result', loading: { id: 'com.example:id/loading' },
        completion: { all: [{ type: 'visible', id: 'com.example:id/result' }] },
        budget: { timeoutMs: 300000, maxActions: 1, maxObservations: 64, maxModelCalls: 1 } });
    const stop = code => { throw Object.assign(new Error(code), { code }); };
    const device = {
        preflight: async () => {},
        check() { if (cancelled && reads >= 4) stop('TASK_CANCELLED'); },
        remainingMs: () => 301000 - now,
        observationCount: () => reads,
        pause: async ms => { now += ms; },
        observe: async () => {
            if (reads >= 64) stop('TASK_BUDGET_EXHAUSTED');
            reads++; now += 3501;
            return { complete: true, displayId: 0, package: 'com.example',
                observation: { id: randomUUID(), digest: 'a'.repeat(64), contextDigest: 'b'.repeat(64), controls: 1 },
                ui: { pageDigest: 'c'.repeat(64), loading: true, completion: { matched: false, checks: [false] }, nodes: [] } };
        },
        execute: async () => { writes++; throw new Error('unexpected write'); }
    };
    const result = await run(task, device, { traceStore: createTaskTraceStore({ directory }),
        jev: { decide: async () => { models++; throw new Error('unexpected model'); } } });
    assert.equal(result.code, cancelled ? 'TASK_CANCELLED' : 'TASK_BUDGET_EXHAUSTED');
    assert.equal(models, 0); assert.equal(writes, 0);
    assert.equal(reads, cancelled ? 4 : 64);
    const events = (await fs.readFile(path.join(directory, task.taskId + '.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'stopped');
    assert.equal(events.at(-1).code, result.code);
    assert.ok(events.filter(e => e.type === 'wait').every(e => e.source === 'host' && e.reason === 'loading'));
    if (!cancelled) {
        assert.equal(events.filter(e => e.type === 'observation').length, 64);
        assert.equal(events.filter(e => e.type === 'wait').length, 63);
    }
});
