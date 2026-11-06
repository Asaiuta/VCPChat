'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { harness } = require('./helpers/android-service-harness.cjs');
const { createAndroidTaskExecutor } = require('../modules/services/androidTaskExecutor');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { response } = require('./helpers/android-search-world.cjs');

const pkg = 'com.example';
const id = name => `${pkg}:id/${name}`;
const query = 'private completion input 943';
const completion = { type: 'visible', id: id('results'), item: id('item'), minItems: 2,
    itemMatchesInput: true, absent: id('blocker') };
const spec = (decision, extra = {}) => ({ serial: 'A', package: pkg, intent: 'search', decision,
    inputs: { query }, completion,
    ...(decision === 'jev' ? {} : { targets: { entry: id('open'), field: id('query'), submit: id('search_go') } }), ...extra });
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const node = (name, value, top, kind = 'Button', children = '') => `<node class="android.widget.${kind}" package="${pkg}" resource-id="${id(name)}" text="${escape(value)}" enabled="true" clickable="${kind !== 'TextView'}" bounds="[0,${top}][90,${top + 35}]">${children}</node>`;

async function fixture(options = {}) {
    let page = options.start || 'home', value = '', resultReads = 0, submittedAt;
    const events = [], writes = [], sampleTimes = [];
    const traceStore = { async open(header) {
        events.push(header);
        return { async append(event) {
            events.push(structuredClone(event));
            if (event.type === 'observation' && event.step === 'complete') sampleTimes.push(Date.now());
        }, async close() {} };
    } };
    const executor = createAndroidTaskExecutor({ traceStore, jev: { async decide(state, questions) {
        return questions.next ? response(questions, 'c0') : { answers: { target: { probabilities: { c0: 1, none: 0 } } } };
    } } });
    const xml = () => {
        if (page === 'results') resultReads++;
        const form = page === 'home' ? node('open', 'Search', 0) : page === 'form'
            ? node('query', value, 0, 'EditText') + node('search_go', 'Search', 45) : '';
        const elapsed = submittedAt === undefined ? 0 : Date.now() - submittedAt;
        const hasItems = page === 'results' ? resultReads > (options.delayItemsReads || 0)
            && elapsed >= (options.itemsAfterMs || 0) : options.oldItems;
        const items = hasItems ? node('item', 'other result', 105, 'TextView')
            + node('item', options.wrongItems ? 'unrelated result' : query, 115, 'TextView') : '';
        const marker = page === 'results' && elapsed >= (options.delayContainerMs || 0) || options.placeholder
            ? node('results', 'Results', 90, 'Button', items) : '';
        const blocker = options.blocked ? node('blocker', 'Loading', 155, 'TextView') : '';
        const loading = page === 'results' && !marker ? node('loading', 'Loading', 0, 'TextView') : '';
        return `<hierarchy rotation="0">${form}${marker}${blocker}${loading}</hierarchy>`;
    };
    const h = await harness({ services: { androidTaskExecutor: executor }, uiServer: { ok: true, xml,
        async invoke(method, params) {
            if (method === 'click') {
                writes.push(page === 'home' ? 'open' : 'submit');
                page = page === 'home' ? 'form' : 'results';
                if (page === 'results') submittedAt = Date.now();
            }
            if (method === 'setText') { writes.push('fill'); value = params[1]; }
            if (method === 'getText') return value;
            return true;
        } } });
    return { events, writes, sampleTimes, run: async task => (await h.service.processToolCall({ command: 'RunTask', task })).details.task };
}

for (const decision of ['rules', 'shadow', 'jev']) {
    test(`${decision} accepts empty result placeholders before and after entry`, async () => {
        const h = await fixture({ placeholder: true });
        const result = await h.run(spec(decision));
        assert.equal(result.status, 'completed', JSON.stringify(result));
        assert.equal(result.completionPolicyVersion, 'search-completion-v2');
        assert.equal(h.events[0].completionPolicyVersion, result.completionPolicyVersion);
        assert.deepEqual(h.writes, ['open', 'fill', 'submit']);
        assert.equal(result.receipts.length, 3);
        assert.ok(result.receipts.every(r => r.outcome === 'verified'));
        const samples = h.events.filter(e => e.step === 'complete' && e.type === 'observation');
        assert.ok(samples.length >= 2);
        assert.ok(samples.slice(-2).every(e => e.matched && e.completion.items === 2 && e.completion.inputMatched && e.completion.absent));
        assert.equal(samples.at(-1).observation.digest, samples.at(-2).observation.digest);
        assert.ok(h.sampleTimes.at(-1) - h.sampleTimes.at(-2) >= 200, 'two stable reads are separated by the 200ms sampler');
        assert.equal(JSON.stringify(h.events).includes(query), false);
    });

    test(`${decision} waits for delayed items after the result container appears without resubmitting`, async () => {
        const h = await fixture({ start: 'form', delayItemsReads: 3 });
        const result = await h.run(spec(decision));
        assert.equal(result.status, 'completed', JSON.stringify(result));
        assert.deepEqual(h.writes, ['fill', 'submit']);
        const samples = h.events.filter(e => e.step === 'complete' && e.type === 'observation');
        assert.ok(samples.some(e => !e.matched && e.completion.containers === 1 && e.completion.items === 0));
        assert.ok(samples.slice(-2).every(e => e.matched && e.completion.items === 2));
    });

    test(`${decision} rejects already matching results before any write or model call`, async () => {
        const h = await fixture({ placeholder: true, oldItems: true });
        const result = await h.run(spec(decision));
        assert.equal(result.code, 'TASK_COMPLETION_PREEXISTS');
        assert.deepEqual(h.writes, []);
        assert.equal(result.counts.modelCalls, 0);
    });

    for (const [name, options, field] of [
        ['unrelated items', { wrongItems: true }, 'inputMatched'],
        ['negative condition outside the container', { blocked: true }, 'absent'],
    ]) test(`${decision} cannot complete with ${name} or replay a submitted action`, async () => {
        const h = await fixture({ start: 'form', ...options });
        const result = await h.run(spec(decision, { budget: { maxObservations: 18 } }));
        assert.equal(result.status, 'stopped');
        assert.equal(result.code, 'TASK_BUDGET_EXHAUSTED');
        assert.deepEqual(h.writes, ['fill', 'submit']);
        assert.equal(result.receipts.length, 2);
        const samples = h.events.filter(e => e.step === 'complete' && e.type === 'observation');
        assert.ok(samples.length >= 2);
        assert.ok(samples.every(e => !e.matched && e.completion[field] === false));
    });
}

test('Service container waiting cannot renew the full-result window after a late container', async () => {
    const h = await fixture({ start: 'form', delayContainerMs: 4400, itemsAfterMs: 6500 });
    const result = await h.run(spec('jev'));
    assert.equal(result.code, 'TASK_COMPLETION_UNPROVEN');
    assert.deepEqual(h.writes, ['fill', 'submit']);
    assert.ok(result.receipts.every(r => r.outcome === 'verified'), 'container verification completed before the full predicate timed out');
    const samples = h.events.filter(e => e.step === 'complete' && e.type === 'observation');
    assert.ok(samples.length >= 1);
    assert.ok(samples.every(e => e.completion.containers === 1 && e.completion.items === 0 && !e.matched));
});

// An injected clock and device port exercise the original shared deadline without
// sleeping for five seconds. Service-path tests above use actual raw XML evidence.
for (const scenario of ['late-items', 'flash', 'outside-change', 'context-change', 'late-submit']) {
    test(`completion keeps one bounded window and requires stable full evidence: ${scenario}`, async t => {
        t.mock.timers.enable({ apis: ['Date'], now: 100000 });
        let stage = 0, reads = 0, total = 0, submitAt;
        const writes = [], requests = [], events = [];
        const hash = value => createHash('sha256').update(String(value)).digest('hex');
        const executor = createAndroidTaskExecutor({ traceStore: { async open() {
            return { async append(event) { events.push(event); }, async close() {} };
        } } });
        const task = executor.prepare(spec('rules', { targets: { field: id('query'), submit: id('search_go') } }));
        const device = { check() {}, async preflight() {}, remainingMs: () => 60000,
            signal: new AbortController().signal, observationCount: () => total,
            async pause(ms) { t.mock.timers.tick(ms); },
            async observe(task, request) {
                total++;
                if (stage === 2) { reads++; requests.push(request); }
                const matched = stage === 2 && (scenario === 'flash' ? reads === 1 : scenario === 'late-items' ? Date.now() >= submitAt + 5200 : true);
                return { complete: true, package: pkg, displayId: 0,
                    observation: { id: randomUUID(), digest: hash(stage === 2 && scenario === 'outside-change' ? reads : `${stage}:${matched}`),
                        contextDigest: hash(stage === 2 && scenario === 'context-change' ? reads : 'context'), controls: 2 },
                    controls: [{ id: id('query'), enabled: true, inViewport: true, role: 'textfield' },
                        { id: id('search_go'), enabled: true, inViewport: true, clickable: true }],
                    completion: { present: stage === 2, containers: stage === 2 ? 1 : 0, items: matched ? 2 : 0,
                        inputMatched: matched, absent: true } };
            },
            async execute(task, action, expected, sample, verifyAfter, options) {
                writes.push(action.command);
                stage++;
                if (stage === 2) {
                    submitAt = Date.now();
                    assert.equal(options.verificationDeadlineMs, submitAt + 5000);
                    // The container/atomic verification consumed most (or all) of the window.
                    t.mock.timers.tick(scenario === 'late-submit' ? 5001 : 4500);
                }
                return { execution: { requestId: randomUUID(), outcome: 'verified' } };
            } };
        const result = await executor.run(task, device);
        assert.equal(result.status, 'stopped');
        assert.equal(result.code, 'TASK_COMPLETION_UNPROVEN');
        assert.deepEqual(writes, ['Fill', 'Tap']);
        assert.equal(result.receipts.length, 2);
        assert.ok(Date.now() <= submitAt + (scenario === 'late-submit' ? 5001 : 5000));
        assert.ok(requests.every(r => r.deadlineMs <= submitAt + 5000));
        assert.equal(events.some(e => e.type === 'completed'), false);
    });
}

test('production trace persists the completion policy identity and rejects arbitrary policy text', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'android-completion-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createTaskTraceStore({ directory });
    const header = { schemaVersion: 1, taskId: randomUUID(), serial: 'A', package: pkg, intent: 'search',
        inputRefs: ['query'], budget: { timeoutMs: 60000, maxActions: 6, maxObservations: 96, maxModelCalls: 8 },
        decision: 'jev', policyVersion: 'search-v1', completionPolicyVersion: 'search-completion-v2' };
    await assert.rejects(store.open({ ...header, completionPolicyVersion: query }), { code: 'TRACE_INVALID_ARGUMENT' });
    const trace = await store.open(header);
    await trace.append({ type: 'stopped', code: 'TASK_COMPLETION_UNPROVEN' });
    await trace.close();
    const text = await fs.readFile(path.join(directory, `${header.taskId}.jsonl`), 'utf8');
    assert.equal(text.includes(query), false);
    const rows = text.trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].completionPolicyVersion, header.completionPolicyVersion);
    assert.equal(rows[0].policyVersion, 'search-v1');
    assert.equal(rows.at(-1).code, 'TASK_COMPLETION_UNPROVEN');
});
