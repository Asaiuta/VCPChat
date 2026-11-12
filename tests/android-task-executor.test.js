'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const { createAndroidTaskExecutor, prepareTask } = require('../modules/services/androidTaskExecutor');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const pkg = 'com.example';
const id = name => `${pkg}:id/${name}`;
const task = (extra = {}) => ({ serial: 'A', package: pkg, intent: 'search', inputs: { query: '独立输入' },
    targets: { entry: id('open'), field: id('query'), submit: id('search_go') },
    completion: { type: 'visible', id: id('results') }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(options = {}) {
    const events = []; let page = options.start || 'home', value = '', changes = 0, opened = false, closed = false, dumps = 0, ready = false, coldReads = 0, formReads = 0;
    const attr = text => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const node = (name, label, top, cls = 'Button', more = '', children = '') => `<node class="android.widget.${cls}" package="${pkg}" resource-id="${id(name)}" text="${attr(label)}" enabled="true" clickable="${cls !== 'TextView'}" bounds="[0,${top}][90,${top + 35}]" ${more}>${children}</node>`;
    const resultItems = () => (options.items || []).map((label, i) => node('item', label, 5 + i * 10, 'TextView', options.passwordItems ? 'password="true"' : '')).join('');
    const xml = () => {
        dumps++;
        if (page === 'form') formReads++;
        if (options.changeAtDump === dumps || options.restless || options.restlessResults && page === 'results'
            || options.driftOnPrepared && events.at(-1)?.phase === 'prepared') changes++;
        return `<hierarchy rotation="0">${page === 'home' ? node('open', 'Search', 0) : page === 'results'
        ? node('results', '完成证据', options.offscreenResult ? 250 : 0, 'Button', '', options.itemsOutside ? '' : resultItems())
            + (options.itemsOutside ? resultItems() : '')
            + (options.keepInput ? node('query', value, 150, 'EditText') : '')
        : node('query', value, 0, 'EditText', options.password ? 'password="true"' : '')
            + (formReads <= (options.delaySubmitReads || 0) ? '' : node('search_go', options.label || 'Search', 60))
            + (options.duplicate ? node('search_go', 'Other', 110) : '')}
        ${options.preexisting ? node('results', 'old', 150) : ''}
        ${options.placeholder && page !== 'results' ? node('results', '', 150, 'Button', '', options.oldItems ? resultItems() : '') : ''}
        ${changes ? node('changed', String(changes), 150) : ''}</hierarchy>`;
    };
    const store = { async open(header) {
        if (options.openError) throw Error('private-path');
        opened = true; events.push({ type: 'header', ...header });
        return { async append(event) {
            if (options.traceFailAt === event.type && (!options.traceFailPhase || options.traceFailPhase === event.phase)) throw Error('private-path');
            events.push(JSON.parse(JSON.stringify(event)));
        }, async close() { closed = true; } };
    } };
    const executor = createAndroidTaskExecutor({ traceStore: options.traceStore || store, jev: options.jev });
    let h;
    h = await harness({ config: options.config, services: { androidTaskExecutor: executor, ...(options.services || {}) },
        client: { ...(options.coldTransport ? { async runText(args) {
            if (args[1] === 'cat /proc/sys/kernel/random/boot_id && settings get secure android_id') return '12345678-1234-1234-1234-123456789012\n1234567890abcdef';
            if (args.includes('uiautomator')) {
                coldReads++;
                if (!ready) throw Object.assign(Error('cold CLI must not become task evidence'), { code: 'COLD_CLI_EVIDENCE' });
                return xml();
            }
            return '';
        } } : {}), ...(options.probeScreen ? { async probeScreen() { return options.probeScreen({ page, events }); } } : {}) },
        uiServer: { ok: true, xml, ready: options.coldTransport ? () => ready : undefined,
            async start() { ready = true; return { ok: true }; }, async invoke(method, params, request) {
            if (options.invoke) {
                const result = await options.invoke(method, params, request);
                if (result !== undefined) return result;
            }
            if (method === 'click') {
                if (page === 'home') page = 'form';
                else if (params[1] > 50 && !options.noResult) page = 'results';
            }
            if (method === 'setText') value = params[1];
            if (method === 'getText') return value;
            return true;
        } } });
    return { ...h, events, executor, run: (spec = task(), context = {}) => h.service.processToolCall({ command: 'RunTask', task: spec }, context),
        mutate() { changes++; }, get page() { return page; }, get value() { return value; },
        get traceOpened() { return opened; }, get traceClosed() { return closed; }, get coldReads() { return coldReads; } };
}
const writes = h => h.calls.filter(c => c[0] === 'rpc' && ['click', 'setText', 'clearTextField'].includes(c[1]));

test('fixed search completes through real service, independent UI/readback and one task lease', async () => {
    for (const query of ['独立输入', 'second value']) {
        const h = await fixture();
        const result = await h.run(task({ inputs: { query } }));
        assert.equal(result.details.task.status, 'completed', JSON.stringify(result.details.task));
        assert.equal(result.details.execution.outcome, 'verified');
        assert.equal(h.value, query); assert.equal(h.page, 'results');
        assert.deepEqual(result.details.task.counts, { actions: 3, observations: 16, modelCalls: 0, mainModelCalls: 0 });
        assert.equal(writes(h).length, 3);
        assert.equal(h.traceOpened && h.traceClosed, true);
        assert.equal(h.events.filter(e => e.type === 'action' && e.phase === 'settled').length, 3);
        assert.equal(new Set(result.details.task.receipts.map(r => r.requestId)).size, 3);
        assert.doesNotMatch(JSON.stringify(h.events), new RegExp(query));
    }
});

test('form starting state skips entry without replay and rejects a preexisting completion marker before writes', async () => {
    const h = await fixture({ start: 'form' });
    const result = await h.run();
    assert.equal(result.details.task.status, 'completed'); assert.equal(writes(h).length, 2);
    const old = await fixture({ start: 'form', preexisting: true });
    const stopped = await old.run();
    assert.equal(stopped.details.task.code, 'TASK_COMPLETION_PREEXISTS'); assert.equal(writes(old).length, 0);
});

test('invalid input, unknown permissions and insufficient budgets fail before touching device or trace', async () => {
    const h = await fixture();
    for (const spec of [task({ inputs: {} }), task({ permissions: ['shell'] }), task({ serial: '' }),
        task({ targets: { field: id('query'), submit: 'com.other:id/submit' } }),
        task({ budget: { maxActions: 2 } }), task({ decision: 'shadow', budget: { maxObservations: 4 } })]) {
        await assert.rejects(h.run(spec), error => /^TASK_/.test(error.code));
    }
    let read = false;
    const input = task(); Object.defineProperty(input, 'package', { get() { read = true; throw Error('secret'); } });
    assert.throws(() => prepareTask(input), { code: 'TASK_INVALID' }); assert.equal(read, false);
    assert.equal(h.calls.length, 0); assert.equal(h.traceOpened, false);
});

test('missing, ambiguous and password targets stop with no guessed input', async () => {
    for (const options of [{ duplicate: true }, { password: true }]) {
        const h = await fixture({ start: 'form', ...options }); const result = await h.run();
        assert.equal(result.details.task.status, 'stopped'); assert.equal(writes(h).length, 0);
    }
    const h = await fixture({ start: 'form' });
    const result = await h.run(task({ targets: { field: id('missing'), submit: id('search_go') } }));
    // The bounded sampler may expire between its foreground probe and XML dispatch.
    // Both the missing-target stop and that local deadline stop must perform no input.
    assert.equal(result.details.task.status, 'stopped');
    assert.ok(['TASK_TARGET_MISSING', 'VERIFICATION_TIMEOUT'].includes(result.details.task.code), result.details.task.code);
    assert.equal(result.details.execution.outcome, 'failed');
    assert.equal(writes(h).length, 0);
});

test('policy remains authoritative and trace errors stop before dispatch', async () => {
    const unavailable = await fixture({ config: { UI_SERVER: false } });
    const missing = await unavailable.run();
    assert.equal(missing.details.task.code, 'TASK_CAPABILITY_UNAVAILABLE');
    assert.equal(writes(unavailable).length, 0); assert.equal(missing.details.execution.outcome, 'failed');
    const denied = await fixture({ config: { INTERACTION_POLICY: { readOnlyPackages: [pkg] } } });
    const stopped = await denied.run(); assert.equal(stopped.details.task.status, 'stopped'); assert.equal(writes(denied).length, 0);
    for (const opts of [{ openError: true }, { traceFailAt: 'action' }]) {
        const h = await fixture(opts); const result = await h.run();
        assert.equal(result.details.task.code, 'TASK_TRACE_FAILED'); assert.equal(writes(h).length, 0);
        assert.equal(result.details.execution.outcome, 'failed');
    }
});

test('model wait holds ownership, shadow answer never authorizes or declares task success', async () => {
    const entered = deferred(), release = deferred(); let seen;
    const h = await fixture({ jev: { async decide(state) { seen = state; entered.resolve(); await release.promise; return { actions: ['shell'], success: true }; } } });
    const pending = h.run(task({ decision: 'shadow' })); await entered.promise;
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'KeyEvent', key: 'back' } }), { code: 'DEVICE_BUSY' });
    await assert.rejects(h.api.disconnect({ serial: 'A' }), { code: 'DEVICE_BUSY' });
    assert.doesNotMatch(JSON.stringify(seen), /独立输入/); release.resolve();
    const result = await pending;
    assert.equal(result.details.task.status, 'completed'); assert.equal(result.details.task.counts.modelCalls, 3);
    assert.equal(writes(h).length, 3); assert.equal(h.events.filter(e => e.type === 'decision' && e.source === 'shadow').length, 3);
});

test('page changes during model latency stop before the first input, even with one candidate', async () => {
    let h; h = await fixture({ jev: { async decide() { h.mutate(); return {}; } } });
    const result = await h.run(task({ decision: 'shadow' }));
    assert.equal(result.details.task.code, 'TASK_OBSERVATION_CHANGED'); assert.equal(writes(h).length, 0);
});

test('cancellation during uncooperative shadow keeps ownership until actual settle and ignores late answer', async () => {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const h = await fixture({ jev: { async decide() { entered.resolve(); await release.promise; return {}; } } });
    const pending = h.run(task({ decision: 'shadow' }), { signal: controller.signal });
    await entered.promise; controller.abort(); await assert.rejects(pending, { code: 'STEP_ABORTED' });
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
    release.resolve(); await tick(); await tick();
    assert.equal(writes(h).length, 0); assert.equal(h.traceClosed, true);
    await h.service.processToolCall({ command: 'Observe', serial: 'A' });
});

test('RPC unknown is recorded once, stops remaining actions and isolates subsequent operations', async () => {
    const h = await fixture({ async invoke(method) {
        if (method === 'click') throw Object.assign(Error('private RPC body'), { code: 'UI_SERVER_TIMEOUT', dispatched: true, drained: false });
    } });
    const result = await h.run();
    assert.equal(result.details.task.status, 'stopped'); assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(writes(h).length, 1); assert.equal(result.details.task.receipts[0].outcome, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /private RPC body|独立输入/);
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_STATE_UNCERTAIN' });
});

test('real JSONL persistence contains typed references and ordered atomic receipts, never input values', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-android-task-'));
    const h = await fixture({ traceStore: createTaskTraceStore({ directory }) });
    const result = await h.run();
    assert.equal(result.details.task.status, 'completed');
    const output = await fs.readFile(path.join(directory, `${result.details.task.taskId}.jsonl`), 'utf8');
    const rows = output.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.seq), rows.map((_, index) => index));
    assert.equal(rows[0].type, 'task'); assert.equal(rows.at(-1).type, 'completed');
    assert.ok(rows.some(row => row.inputRef === 'query'));
    assert.equal(rows.filter(row => row.phase === 'prepared').length, 3);
    assert.equal(rows.filter(row => row.phase === 'settled').length, 3);
    assert.ok(rows.some(row => row.phase === 'prepared' && row.expectId === id('results')));
    assert.doesNotMatch(output, /独立输入|完成证据|Search|text=|<hierarchy/);
    const shadow = await fixture({ traceStore: createTaskTraceStore({ directory }), jev: { async decide() {
        return { answers: { target: { probabilities: { c0: 0, none: 1 } } } };
    } } });
    const other = await shadow.run(task({ decision: 'shadow' }));
    assert.equal(other.details.task.status, 'completed');
    const shadowRows = (await fs.readFile(path.join(directory, `${other.details.task.taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(shadowRows.filter(row => row.source === 'shadow' && row.choice === 'none').length, 3,
        'shadow disagreement is recorded but has no execution authority');
});

test('page drift rejected before dispatch is re-observed without replaying an action', async () => {
    const h = await fixture({ changeAtDump: 3 });
    const result = await h.run();
    assert.equal(result.details.task.status, 'completed');
    assert.equal(result.details.task.receipts[0].code, 'TASK_OBSERVATION_CHANGED');
    assert.equal(result.details.task.receipts[0].outcome, 'failed');
    assert.equal(result.details.task.receipts.length, 4);
    assert.equal(result.details.task.counts.actions, 3);
    assert.equal(writes(h).length, 3);
});

test('observation budget includes validation polling and prevents further input on exhaustion', async () => {
    const h = await fixture({ noResult: true });
    const result = await h.run(task({ budget: { maxObservations: 16 } }));
    assert.equal(result.details.task.status, 'stopped');
    assert.equal(result.details.task.counts.observations, 16);
    assert.equal(result.details.task.code, 'TASK_BUDGET_EXHAUSTED');
    assert.equal(writes(h).length, 3);
    assert.equal(result.details.task.receipts.at(-1).outcome, 'unknown');
});

test('failed settled trace cannot erase a verified action or replay it', async () => {
    const h = await fixture({ traceFailAt: 'action', traceFailPhase: 'settled' });
    const result = await h.run();
    assert.equal(result.details.task.code, 'TASK_TRACE_FAILED'); assert.equal(writes(h).length, 1);
    assert.equal(result.details.task.receipts.length, 1); assert.equal(result.details.task.receipts[0].outcome, 'verified');
});

test('abort during an in-flight RPC records unknown and retains the task lease until transport settles', async () => {
    const entered = deferred(), release = deferred(), controller = new AbortController();
    const h = await fixture({ async invoke(method) {
        if (method === 'click') { entered.resolve(); await release.promise; return true; }
    } });
    const pending = h.run(task(), { signal: controller.signal });
    await entered.promise; controller.abort();
    await assert.rejects(pending, error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'unknown');
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
    release.resolve(); await tick(); await tick();
    assert.equal(writes(h).length, 1);
    assert.ok(h.events.some(event => event.phase === 'settled' && event.outcome === 'unknown'));
    assert.equal(h.traceClosed, true);
});

test('no host executor means no device activity and no hidden plugin-side planner', async () => {
    const h = await harness();
    await assert.rejects(h.service.processToolCall({ command: 'RunTask', task: task() }), { code: 'TASK_HOST_UNAVAILABLE' });
    assert.equal(h.calls.length, 0);
});


test('shadow trace failure remains trace failure and cannot masquerade as model outage', async () => {
    const h = await fixture({ traceFailAt: 'decision', jev: { async decide() {
        return { answers: { target: { probabilities: { c0: 1, none: 0 } } } };
    } } });
    const result = await h.run(task({ decision: 'shadow' }));
    assert.equal(result.details.task.code, 'TASK_TRACE_FAILED'); assert.equal(result.details.execution.outcome, 'failed');
    assert.equal(writes(h).length, 0);
});

test('task deadline covers uncooperative model waiting without resetting or early unlock', async () => {
    const entered = deferred(), release = deferred();
    const h = await fixture({ jev: { async decide() { entered.resolve(); await release.promise; return {}; } } });
    const pending = h.run(task({ decision: 'shadow', budget: { timeoutMs: 600 } }));
    const rejected = assert.rejects(pending, { code: 'STEP_DEADLINE' });
    await entered.promise; await rejected;
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
    release.resolve(); await tick(); await tick();
    assert.equal(writes(h).length, 0); assert.equal(h.traceClosed, true);
});


test('RPC warmup precedes decision sampling and deny policy still rejects before service startup', async () => {
    const h = await fixture({ coldTransport: true });
    const result = await h.run();
    assert.equal(result.details.task.status, 'completed');
    assert.equal(h.coldReads, 0, 'cold CLI must not issue the first decision snapshot');
    const denied = await fixture({ config: { INTERACTION_POLICY: { denyPackages: [pkg] } } });
    const stopped = await denied.run();
    assert.equal(stopped.details.task.code, 'POLICY_DENIED'); assert.equal(denied.uiServer.started, 0);
    assert.equal(writes(denied).length, 0);
});

test('a page that never holds still stops before the first write', async () => {
    const h = await fixture({ restless: true });
    const result = await h.run();
    assert.equal(result.details.task.code, 'TASK_PAGE_UNSETTLED');
    assert.equal(writes(h).length, 0); assert.equal(result.details.execution.outcome, 'failed');
});

test('completion can require nonempty, input-related items and a vanished input page', async () => {
    const strict = { type: 'visible', id: id('results'), item: id('item'), minItems: 2, itemMatchesInput: true, absent: id('query') };
    const ok = await fixture({ items: ['无关', '含独立输入的结果'] });
    const done = await ok.run(task({ completion: strict }));
    assert.equal(done.details.task.status, 'completed', JSON.stringify(done.details.task));
    assert.doesNotMatch(JSON.stringify(ok.events), /独立输入/);
    for (const items of [[], ['只有一个独立输入'], ['无关', '也无关']]) {
        const h = await fixture({ items });
        const result = await h.run(task({ completion: strict }));
        assert.equal(result.details.task.code, 'TASK_COMPLETION_UNPROVEN', JSON.stringify(items));
    }
    for (const completion of [{ type: 'visible', id: id('results'), minItems: 1 }, { ...strict, minItems: 0 },
        { ...strict, itemMatchesInput: 'yes' }, { ...strict, item: id('results') },
        { ...strict, absent: id('results') }, { ...strict, absent: id('item') }]) {
        assert.throws(() => prepareTask(task({ completion })), { code: 'TASK_INVALID' });
    }
});

test('transiently missing submit target settles before filling, without extra input', async () => {
    const h = await fixture({ delaySubmitReads: 3 });
    const result = await h.run();
    assert.equal(result.details.task.status, 'completed', JSON.stringify(result.details.task));
    assert.equal(writes(h).length, 3);
    assert.ok(result.details.task.counts.observations > 16);
});

test('completion rejects remaining input, offscreen container, password items and unrelated siblings', async () => {
    const completion = { type: 'visible', id: id('results'), item: id('item'), absent: id('query') };
    for (const options of [{ keepInput: true }, { offscreenResult: true }, { passwordItems: true }, { itemsOutside: true }]) {
        const h = await fixture({ items: ['独立输入'], ...options });
        const result = await h.run(task({ completion }));
        // A missing offscreen marker can exhaust polling between samples or while
        // the last sample crosses its deadline. Both retain the same unknown write.
        const codes = options.offscreenResult ? ['TASK_ACTION_UNVERIFIED', 'VERIFICATION_TIMEOUT'] : ['TASK_COMPLETION_UNPROVEN'];
        assert.ok(codes.includes(result.details.task.code), JSON.stringify({ options, code: result.details.task.code }));
        assert.equal(result.details.task.status, 'stopped');
        assert.deepEqual(writes(h).map(call => call[1]), ['click', 'setText', 'click']);
        assert.equal(result.details.task.receipts.length, 3);
        assert.equal(result.details.task.receipts.at(-1).outcome, options.offscreenResult ? 'unknown' : 'verified');
        assert.equal(result.details.execution.outcome, 'unknown');
    }
});

test('repeated pre-dispatch drift stops at three failed attempts with zero input', async () => {
    const h = await fixture({ driftOnPrepared: true });
    const result = await h.run();
    assert.equal(result.details.task.code, 'TASK_OBSERVATION_CHANGED');
    assert.equal(result.details.task.receipts.length, 3);
    assert.ok(result.details.task.receipts.every(r => r.outcome === 'failed'));
    assert.equal(writes(h).length, 0);
    assert.equal(result.details.execution.outcome, 'failed');
});

const probeOf = window => ({ focus: { package: pkg, component: `${pkg}/.Main`, window },
    size: { width: 100, height: 200 }, wakefulness: 'Awake', rotation: 0, displayId: 0,
    keyguard: { showing: false, inputRestricted: false } });

// Real JSONL store, plus an in-memory copy so a fixture can react to persisted progress.
function recordingStore(directory) {
    const real = createTaskTraceStore({ directory }), seen = [];
    return { seen, async open(header) {
        const trace = await real.open(header);
        return { async append(event) { await trace.append(event); seen.push(JSON.parse(JSON.stringify(event))); },
            close: () => trace.close() };
    } };
}
const readTrace = async (directory, taskId) => {
    const text = await fs.readFile(path.join(directory, `${taskId}.jsonl`), 'utf8');
    return { text, rows: text.trim().split('\n').map(line => JSON.parse(line)) };
};

test('window recreated during completion sampling stops with sanitized dimension names only', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-android-task-'));
    const store = recordingStore(directory);
    let armed = 0;
    const h = await fixture({ traceStore: store, probeScreen() {
        // After the first persisted completion sample: the next read starts on the old window
        // token and finishes on a recreated window with the same title.
        if (store.seen.some(e => e.type === 'observation' && e.step === 'complete')) armed++;
        return probeOf(`Window{${armed >= 2 ? 'b0b0' : 'a1a1'} u0 com.example/.Main}`);
    } });
    const result = await h.run();
    const receipt = result.details.task;
    assert.equal(receipt.status, 'stopped');
    assert.equal(receipt.code, 'UI_CONTEXT_CHANGED');
    assert.deepEqual(receipt.contextDiff, ['window_token', 'epoch']);
    assert.equal(writes(h).length, 3, 'read-only completion failure never replays input');
    const { text, rows } = await readTrace(directory, receipt.taskId);
    const stopped = rows.at(-1);
    assert.equal(stopped.type, 'stopped'); assert.equal(stopped.step, 'complete');
    assert.deepEqual(stopped.contextDiff, ['window_token', 'epoch']);
    assert.doesNotMatch(text, /a1a1|b0b0|Window\{|com\.example\/\.Main|独立输入/);
    const complete = rows.filter(row => row.type === 'observation' && row.step === 'complete');
    assert.ok(complete.length >= 1);
    for (const row of complete) {
        assert.equal(typeof row.matched, 'boolean');
        assert.deepEqual(Object.keys(row.completion).sort(), ['absent', 'containers', 'inputMatched', 'items', 'present']);
    }
});

test('drift between two coherent samples is attributed on the later observation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-android-task-'));
    const store = recordingStore(directory);
    let moved = false;
    const h = await fixture({ traceStore: store, probeScreen({ page }) {
        // Each read is coherent on its own; the activity changes between completion reads.
        if (page === 'results' && store.seen.some(e => e.type === 'observation' && e.step === 'complete')) moved = true;
        return moved ? { ...probeOf('Window{a1a1 u0 com.example/.Other}'), focus: { package: pkg,
            component: `${pkg}/.Other`, window: 'Window{a1a1 u0 com.example/.Other}' } } : probeOf('Window{a1a1 u0 com.example/.Main}');
    } });
    const result = await h.run();
    const { rows, text } = await readTrace(directory, result.details.task.taskId);
    const drifted = rows.filter(row => row.contextDiff);
    assert.ok(drifted.length >= 1, JSON.stringify(rows.map(r => [r.type, r.step, r.contextDiff, r.code])));
    assert.ok(drifted.some(row => row.contextDiff.includes('component') && row.contextDiff.includes('window_title')),
        JSON.stringify(drifted));
    assert.doesNotMatch(text, /\.Other|a1a1/);
    assert.equal(result.details.task.status, 'stopped');
    assert.equal(writes(h).length, 3);
});

test('judgement: completion wait demands whole-page stability, not only the declared target', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-android-task-'));
    const store = recordingStore(directory);
    // Results container and its matching item hold still; one node outside it keeps changing.
    const h = await fixture({ traceStore: store, restlessResults: true, items: ['独立输入'] });
    const result = await h.run(task({ budget: { maxObservations: 24 },
        completion: { type: 'visible', id: id('results'), item: id('item'), itemMatchesInput: true } }));
    const receipt = result.details.task;
    assert.equal(receipt.status, 'stopped');
    assert.ok(['TASK_BUDGET_EXHAUSTED', 'TASK_COMPLETION_UNPROVEN'].includes(receipt.code), receipt.code);
    const { rows } = await readTrace(directory, receipt.taskId);
    const complete = rows.filter(row => row.type === 'observation' && row.step === 'complete');
    assert.ok(complete.length >= 3, String(complete.length));
    assert.ok(complete.every(row => row.matched === true && row.completion.items === 1 && row.completion.inputMatched),
        JSON.stringify(complete));
    assert.equal(new Set(complete.map(row => row.observation.targetDigest)).size, 1, 'declared target is stable');
    assert.equal(new Set(complete.map(row => row.observation.outsideDigest)).size, complete.length, 'only outside churns');
    assert.equal(new Set(complete.map(row => row.observation.digest)).size, complete.length);
    assert.ok(complete.every(row => !row.contextDiff));
    assert.equal(writes(h).length, 3);
});

test('strict completion permits an empty result placeholder but rejects already matching results', async () => {
    const completion = { type: 'visible', id: id('results'), item: id('item'), itemMatchesInput: true };
    const h = await fixture({ placeholder: true, items: ['独立输入'] });
    const done = await h.run(task({ completion }));
    assert.equal(done.details.task.status, 'completed');
    assert.equal(writes(h).length, 3);
    const old = await fixture({ placeholder: true, oldItems: true, items: ['独立输入'] });
    const stopped = await old.run(task({ completion }));
    assert.equal(stopped.details.task.code, 'TASK_COMPLETION_PREEXISTS');
    assert.equal(writes(old).length, 0);
});
