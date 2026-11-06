'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { traceEventLimit } = require('../modules/services/androidTaskBudget');

const MAX_BYTES = 512 * 1024;
const TERMINAL_RESERVE_BYTES = 4096;
const SECRET = 'private query / raw interface / secret password';
function header() {
    return { schemaVersion: 1, taskId: randomUUID(), serial: '127.0.0.1:5555', package: 'com.example.app',
        intent: 'search', inputRefs: ['query'],
        budget: { timeoutMs: 1000, maxActions: 8, maxObservations: 16, maxModelCalls: 2 } };
}
function event() {
    return { type: 'observation', step: 'entry', observation: {
        id: randomUUID(), digest: 'a'.repeat(64), contextDigest: 'b'.repeat(64), controls: 3
    } };
}
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'android-task-trace-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'nested', 'traces');
    return { directory, store: createTaskTraceStore({ directory }),
        file: value => path.join(directory, `${value.taskId.toLowerCase()}.jsonl`) };
}
async function lines(file) { return (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(JSON.parse); }
const rejects = (promise, code = 'TRACE_INVALID_ARGUMENT') => assert.rejects(promise, { code });

test('writes a private header first and ordered event snapshots, readable after close', async t => {
    const f = await fixture(t);
    const h = header();
    const originalId = h.taskId;
    const opening = f.store.open(h);
    h.budget.timeoutMs = 9999;
    h.inputRefs[0] = SECRET;
    const trace = await opening;
    const observation = event();
    const id = observation.observation.id;
    const writing = trace.append(observation);
    observation.observation.digest = SECRET;
    observation.type = SECRET;
    await writing;
    await trace.append({ type: 'decision', source: 'shadow', inputRef: 'query', requestId: randomUUID(), modelCalls: 1 });
    await trace.append({ type: 'action', step: 'fill', targetId: 'com.example.app:id/query', phase: 'prepared', attempts: 1 });
    await trace.append({ type: 'action', step: 'submit', phase: 'settled', dispatched: true, outcome: 'dispatched' });
    await trace.append({ type: 'verification', step: 'complete', matched: true, outcome: 'verified' });
    await trace.append({ type: 'stopped', code: 'BUDGET_EXHAUSTED', outcome: 'unknown' });
    await trace.append({ type: 'completed' });
    await trace.close();
    await trace.close();
    const file = f.file({ taskId: originalId });
    const records = await lines(file);
    assert.deepEqual(records.map(value => value.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(records[0].type, 'task');
    assert.equal(records[0].budget.timeoutMs, 1000);
    assert.deepEqual(records[0].inputRefs, ['query']);
    assert.equal(records[1].observation.id, id);
    assert.equal(records[1].observation.digest, 'a'.repeat(64));
    assert.equal((await fs.readFile(file, 'utf8')).includes(SECRET), false);
    await rejects(trace.append({ type: 'completed' }), 'TRACE_CLOSED');
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('strict header validation rejects unknown fields, paths, malformed identities and types before mkdir', async t => {
    const f = await fixture(t);
    const cases = [
        { token: SECRET }, { taskId: '../escape' }, { taskId: '00000000-0000-1000-8000-000000000000' },
        { serial: '../../device' }, { serial: 'device\nsecret' }, { serial: '__proto__' },
        { package: '../outside' }, { package: 'com.example/escape' }, { intent: SECRET },
        { schemaVersion: '1' }, { inputRefs: [SECRET] }, { inputRefs: ['query', 'query'] },
        { inputRefs: Object.assign(['query'], { secret: SECRET }) },
        { budget: { timeoutMs: 0, maxActions: 1, maxObservations: 1, maxModelCalls: 0 } },
        { budget: { timeoutMs: 1, maxActions: -1, maxObservations: 1, maxModelCalls: 0 } },
        { budget: { timeoutMs: 1, maxActions: 1.5, maxObservations: 1, maxModelCalls: 0 } },
        { budget: { timeoutMs: 1, maxActions: 1, maxObservations: Infinity, maxModelCalls: 0 } },
        { budget: { timeoutMs: 1, maxActions: 1, maxObservations: 1, maxModelCalls: 17 } },
        { budget: { timeoutMs: 1, maxActions: 1, maxObservations: 1, maxModelCalls: 0, rawError: SECRET } }
    ];
    for (const patch of cases) await rejects(f.store.open({ ...header(), ...patch }));
    const missing = header();
    delete missing.serial;
    await rejects(f.store.open(missing));
    await rejects(f.store.open(null));
    await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('never executes getters in options, headers, nested budget, arrays or events', async t => {
    const f = await fixture(t);
    let calls = 0;
    const getter = () => { calls += 1; throw new Error(SECRET); };
    const options = {};
    Object.defineProperty(options, 'directory', { enumerable: true, get: getter });
    assert.throws(() => createTaskTraceStore(options), { code: 'TRACE_INVALID_ARGUMENT' });
    const a = header();
    Object.defineProperty(a, 'serial', { enumerable: true, get: getter });
    await rejects(f.store.open(a));
    const b = header();
    Object.defineProperty(b.budget, 'maxActions', { enumerable: true, get: getter });
    await rejects(f.store.open(b));
    const c = header();
    Object.defineProperty(c.inputRefs, '0', { enumerable: true, get: getter });
    await rejects(f.store.open(c));
    const trace = await f.store.open(header());
    const d = { type: 'action' };
    Object.defineProperty(d, 'targetId', { enumerable: true, get: getter });
    await rejects(trace.append(d));
    const e = event();
    Object.defineProperty(e.observation, 'digest', { enumerable: true, get: getter });
    await rejects(trace.append(e));
    const unknown = { type: 'completed' };
    Object.defineProperty(unknown, 'secret', { get: getter });
    await rejects(trace.append(unknown));
    await trace.close();
    assert.equal(calls, 0);
});

test('rejects free text, selectors, cross-package resource IDs, unknown and invalid event values', async t => {
    const f = await fixture(t);
    const h = header();
    const trace = await f.store.open(h);
    const invalid = [
        { label: SECRET }, { text: SECRET }, { input: SECRET }, { selector: { text: SECRET } },
        { rawError: SECRET }, { toJSON() { throw new Error(SECRET); } }, { seq: 9 },
        { targetId: 'other.package:id/query' }, { targetId: 'com.example.app:id/query/../../outside' },
        { targetId: 'com.example.app:id/label with spaces' }, { targetId: '#query' }, { targetId: null },
        { type: 'task' }, { type: 1 }, { step: SECRET }, { inputRef: SECRET }, { source: SECRET },
        { requestId: '../../escape' }, { outcome: SECRET }, { code: 'lowercase' }, { code: 'A'.repeat(65) },
        { matched: 'true' }, { modelCalls: -1 }, { modelCalls: 17 }, { modelCalls: 0.5 },
        { phase: 'retry' }, { attempts: 33 }, { dispatched: 1 },
        { observation: { ...event().observation, controls: -1 } },
        { observation: { ...event().observation, digest: SECRET } },
        { observation: { ...event().observation, raw: SECRET } }, { observation: {} }
    ];
    for (const patch of invalid) await rejects(trace.append({ type: 'action', ...patch }));
    await rejects(trace.append(Object.assign(Object.create({ secret: SECRET }), { type: 'completed' })));
    await rejects(trace.append({ type: 'completed', [Symbol('secret')]: SECRET }));
    await rejects(trace.append([]));
    await rejects(trace.append(null));
    await trace.append({ type: 'completed', matched: false, modelCalls: 16, attempts: 32, dispatched: false });
    await trace.close();
    const records = await lines(f.file(h));
    assert.equal(records.length, 2);
    assert.equal(records[1].seq, 1);
    assert.equal((await fs.readFile(f.file(h), 'utf8')).includes(SECRET), false);
});

test('exclusive canonical task filenames never overwrite a conflicting task', async t => {
    const f = await fixture(t);
    const h = header();
    const trace = await f.store.open(h);
    await trace.append({ type: 'completed' });
    await trace.close();
    const original = await fs.readFile(f.file(h), 'utf8');
    await rejects(f.store.open({ ...h, taskId: h.taskId.toUpperCase() }), 'TRACE_EXISTS');
    assert.equal(await fs.readFile(f.file(h), 'utf8'), original);
    assert.deepEqual(await fs.readdir(f.directory), [`${h.taskId}.jsonl`]);
});

test('Jev candidates are bounded data snapshots with no getters, raw labels or foreign targets', async t => {
    const f = await fixture(t);
    const h = { ...header(), decision: 'jev', policyVersion: 'search-v1' };
    const trace = await f.store.open(h);
    const candidate = () => ({ candidateId: 'c0', targetId: 'com.example.app:id/search', command: 'Tap',
        evidenceSources: ['text'], postcondition: 'search_progress' });
    const event = candidates => ({ type: 'candidates', step: 'entry', candidates });
    for (const patch of [{ text: SECRET }, { targetId: 'other.app:id/search' }, { command: 'Shell' },
        { postcondition: SECRET }, { evidenceSources: ['text', 'text'] }, { evidenceSources: [SECRET] }, { candidateId: 'c9' }]) {
        await rejects(trace.append(event([{ ...candidate(), ...patch }])));
    }
    const getter = { ...candidate() };
    Object.defineProperty(getter, 'targetId', { get() { throw Error('getter executed'); } });
    await rejects(trace.append(event([getter])));
    const array = [candidate()];
    Object.defineProperty(array, '0', { get() { throw Error('getter executed'); } });
    await rejects(trace.append(event(array)));
    await rejects(trace.append(event(Array.from({ length: 9 }, (_, i) => ({ ...candidate(), candidateId: `c${i}` })))));
    await trace.append(event([candidate()]));
    await trace.append({ type: 'decision', source: 'jev', choice: 'c0' });
    await trace.close();
    const rows = await lines(f.file(h));
    assert.equal(rows[0].policyVersion, 'search-v1');
    assert.equal(rows.length, 3);
    assert.equal((await fs.readFile(f.file(h), 'utf8')).includes(SECRET), false);
});

test('event limit follows the admitted budget and reserves the final stop record', async t => {
    const f = await fixture(t);
    const h = header();
    const trace = await f.store.open(h);
    const limit = traceEventLimit(h.budget);
    for (let i = 0; i < limit - 1; i += 1) await trace.append({ type: 'observation' });
    await rejects(trace.append({ type: 'observation' }), 'TRACE_LIMIT');
    await trace.append({ type: 'stopped', code: 'TASK_TRACE_LIMIT' });
    await rejects(trace.append({ type: 'completed' }), 'TRACE_LIMIT');
    await trace.close();
    const records = await lines(f.file(h));
    assert.equal(records.length, limit + 1);
    assert.deepEqual(records.map(value => value.seq), Array.from({ length: limit + 1 }, (_, index) => index));
    assert.equal(records.at(-1).type, 'stopped');
});

test('byte budget includes header and newlines and leaves room for the terminal receipt', async t => {
    const f = await fixture(t);
    const h = header();
    const trace = await f.store.open(h);
    const headerBytes = (await fs.stat(f.file(h))).size;
    const prefix = 'com.example.app:id/';
    const baseBytes = Buffer.byteLength(`${JSON.stringify({ type: 'action', targetId: prefix, seq: 1 })}\n`);
    const resourceLength = MAX_BYTES - TERMINAL_RESERVE_BYTES - headerBytes - baseBytes;
    const big = { type: 'action', targetId: prefix + 'r'.repeat(resourceLength) };
    await rejects(trace.append({ ...big, targetId: `${big.targetId}r` }), 'TRACE_LIMIT');
    await trace.append(big);
    await rejects(trace.append({ type: 'observation' }), 'TRACE_LIMIT');
    await trace.append({ type: 'stopped', code: 'TASK_TRACE_LIMIT' });
    await trace.close();
    assert.ok((await fs.stat(f.file(h))).size <= MAX_BYTES);
    assert.equal((await lines(f.file(h)))[1].seq, 1);
    assert.equal((await lines(f.file(h))).at(-1).type, 'stopped');
});

test('rejects concurrent append and close waits for the active write before closing the fd', async t => {
    const f = await fixture(t);
    const realOpen = fs.open;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let writes = 0;
    let closes = 0;
    t.mock.method(fs, 'open', async (...args) => {
        const handle = await realOpen(...args);
        assert.equal(args[1], 'wx');
        assert.equal(args[2], 0o600);
        return {
            async writeFile(...data) { writes += 1; if (writes > 1) await gate; return handle.writeFile(...data); },
            async close() { closes += 1; return handle.close(); }
        };
    });
    const h = header();
    const trace = await f.store.open(h);
    const pending = trace.append({ type: 'action', phase: 'prepared' });
    await rejects(trace.append({ type: 'completed' }), 'TRACE_BUSY');
    const closing = trace.close();
    const closingAgain = trace.close();
    await rejects(trace.append({ type: 'completed' }), 'TRACE_CLOSED');
    assert.equal(closes, 0);
    release();
    await Promise.all([pending, closing, closingAgain]);
    assert.equal(closes, 1);
    assert.equal((await lines(f.file(h))).length, 2);
});

test('a failed or partial append is terminal, sanitized, not retried, and still closable', async t => {
    const f = await fixture(t);
    const realOpen = fs.open;
    let writes = 0;
    let closes = 0;
    t.mock.method(fs, 'open', async (...args) => {
        const handle = await realOpen(...args);
        return {
            async writeFile(...data) {
                writes += 1;
                if (writes > 1) {
                    await handle.writeFile('{', 'utf8');
                    throw new Error(SECRET);
                }
                return handle.writeFile(...data);
            },
            async close() { closes += 1; return handle.close(); }
        };
    });
    const h = header();
    const trace = await f.store.open(h);
    await assert.rejects(trace.append({ type: 'action' }), error => error.code === 'TRACE_WRITE_FAILED' && !error.message.includes(SECRET));
    await rejects(trace.append({ type: 'completed' }), 'TRACE_WRITE_FAILED');
    await trace.close();
    await trace.close();
    assert.equal(writes, 2);
    assert.equal(closes, 1);
    assert.equal((await fs.readFile(f.file(h), 'utf8')).includes(SECRET), false);
});

test('header write failure closes its fd and preserves exclusive conflict instead of retrying', async t => {
    const f = await fixture(t);
    const realOpen = fs.open;
    let writes = 0;
    let closes = 0;
    t.mock.method(fs, 'open', async (...args) => {
        const handle = await realOpen(...args);
        return {
            async writeFile() { writes += 1; throw new Error(SECRET); },
            async close() { closes += 1; return handle.close(); }
        };
    });
    const h = header();
    await rejects(f.store.open(h), 'TRACE_WRITE_FAILED');
    await rejects(f.store.open(h), 'TRACE_EXISTS');
    assert.equal(writes, 1);
    assert.equal(closes, 1);
});

test('invalid factory options and non-file output directories fail without reading existing traces', async t => {
    const f = await fixture(t);
    for (const options of [null, {}, { directory: '' }, { directory: 3 }, { directory: 'a\0b' }, { directory: f.directory, token: SECRET }]) {
        assert.throws(() => createTaskTraceStore(options), { code: 'TRACE_INVALID_ARGUMENT' });
    }
    const blocker = path.join(path.dirname(path.dirname(f.directory)), 'blocker');
    await fs.writeFile(blocker, SECRET);
    const store = createTaskTraceStore({ directory: path.join(blocker, 'child') });
    await rejects(store.open(header()), 'TRACE_OPEN_FAILED');
});

test('context diff and completion evidence are closed-vocabulary, bounded and paired', async t => {
    const f = await fixture(t);
    const h = header();
    const trace = await f.store.open(h);
    const observation = () => ({ ...event().observation, targetDigest: 'c'.repeat(64), outsideDigest: 'd'.repeat(64) });
    const completion = { present: true, containers: 1, items: 2, inputMatched: true, absent: true };
    for (const patch of [{ contextDiff: [] }, { contextDiff: ['window'] }, { contextDiff: [SECRET] },
        { contextDiff: ['epoch', 'epoch'] }, { contextDiff: 'epoch' },
        { completion: { ...completion, text: SECRET } }, { completion: { ...completion, items: -1 } },
        { completion: { ...completion, inputMatched: 'yes' } }, { completion: { present: true } },
        { observation: { ...event().observation, targetDigest: 'c'.repeat(64) } },
        { observation: { ...observation(), outsideDigest: SECRET } }]) {
        await rejects(trace.append({ type: 'observation', step: 'complete', ...patch }));
    }
    await trace.append({ type: 'observation', step: 'complete', observation: observation(), matched: true, completion,
        contextDiff: ['epoch', 'window_token'] });
    await trace.append({ type: 'stopped', code: 'UI_CONTEXT_CHANGED', contextDiff: ['after_keyguard'] });
    await trace.close();
    const rows = await lines(f.file(h));
    assert.deepEqual(rows[1].contextDiff, ['window_token', 'epoch']);
    assert.deepEqual(rows[1].completion, completion);
    assert.equal(rows[1].observation.outsideDigest, 'd'.repeat(64));
    assert.deepEqual(rows[2].contextDiff, ['after_keyguard']);
    assert.equal((await fs.readFile(f.file(h), 'utf8')).includes(SECRET), false);
});
