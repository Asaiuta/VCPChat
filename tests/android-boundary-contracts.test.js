'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { harness, xml } = require('./helpers/android-service-harness.cjs');
const { searchWorld, spec, response, id } = require('./helpers/android-search-world.cjs');
const { rawEntries } = require('../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { createHumanInteraction } = require('../VCPDistributedServer/Plugin/AndroidController/lib/human-interaction');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
const { headerSnapshot, eventForTask } = require('../modules/services/androidTaskTraceSchema');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const execute = (h, action, extra = {}, context = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action, ...extra }, context);
const back = { command: 'KeyEvent', key: 'back' };
const node = (name, attributes = '', children = '') => `<node package="com.example" resource-id="${id(name)}" class="android.widget.TextView" enabled="true" bounds="[0,0][90,35]" ${attributes}>${children}</node>`;
function clock(t) { let now = 0; t.mock.method(performance, 'now', () => now); return ms => { now += ms; }; }
function traceStore(onEvent = () => {}) {
    const events = [];
    return { events, async open(header) {
        const snapshot = headerSnapshot(header);
        return { async append(event) { events.push(eventForTask(event, snapshot)); onEvent(event); }, async close() {} };
    } };
}
const select = packet => ({ schemaVersion: 1, taskId: packet.taskId, observationId: packet.observationId, action: 'select', candidateId: 'c0' });

for (const attribute of ['visible-to-user', 'displayed']) {
    test(`task ${attribute} hides descendants while layout retains their own visibility and raw identity`, () => {
        const tree = `<hierarchy rotation="0">${node('hidden', `${attribute}="false"`, node('nested', '', node('item', `${attribute}="true"`)))}${node('sibling')}</hierarchy>`;
        const graph = parseUiGraph(tree, { screen: { width: 100, height: 200 }, rpcTarget: true });
        const screen = { width: 100, height: 200 };
        const entries = rawEntries(graph, screen, { excludeHiddenSubtrees: true });
        assert.deepEqual(entries.map(e => [e.attrs['resource-id'], Boolean(e.visible)]),
            [['hidden', false], ['nested', false], ['item', false], ['sibling', true]].map(([name, visible]) => [id(name), visible]));
        assert.deepEqual(rawEntries(graph, screen).map(e => Boolean(e.visible)), [false, true, true, true]);
    });

    test(`search cannot complete from a result item under a ${attribute}=false ancestor`, async t => {
        const store = traceStore();
        const world = await searchWorld({ traceStore: store, transformXml(tree) {
            return tree.replace(/(<node [^>]*resource-id="com.example:id\/results"[^>]*)(\/>)/,
                `$1>${node('hidden', `${attribute}="false"`, node('item', 'text="Hidden result"'))}</node>`);
        } });
        t.after(() => world.service.cleanup());
        const result = (await world.run(spec({ completion: { type: 'visible', id: id('results'), item: id('item'), minItems: 1 },
            budget: { maxObservations: 18 } }))).details.task;
        assert.equal(result.status, 'stopped');
        const samples = store.events.filter(e => e.type === 'observation' && e.step === 'complete');
        assert.ok(samples.length >= 2);
        assert.ok(samples.every(e => e.completion.items === 0 && !e.matched));
        assert.deepEqual(world.actions.map(a => a.target), ['open', 'query', 'search_go']);
    });
}

for (const kind of ['approval', 'handoff']) for (const boundary of ['cancel', 'deadline']) {
    test(`${kind} ${boundary} retains the device until the host request settles`, async t => {
        const entered = deferred(), answer = deferred(), controller = new AbortController();
        const h = await harness({ dump: () => xml('Pay'), services: { humanInteraction: { async request() { entered.resolve(); return answer.promise; } } } });
        t.after(() => h.service.cleanup());
        const action = kind === 'approval' ? { command: 'Tap', id: id('go') } : { command: 'Handoff', reason: 'Resolve on device' };
        const running = execute(h, action, { timeoutMs: boundary === 'deadline' ? 100 : 60000 }, { signal: controller.signal }).catch(e => e);
        try {
            await Promise.race([entered.promise, running.then(result => { throw new Error(`Request ended before prompt: ${result.code}`); })]);
            if (boundary === 'cancel') controller.abort();
            assert.equal((await running).code, boundary === 'cancel' ? 'STEP_ABORTED' : 'STEP_DEADLINE');
            await tick();
            await assert.rejects(execute(h, back, { timeoutMs: 100 }), { code: 'DEVICE_BUSY' });
        } finally { answer.resolve(true); await tick(); await tick(); }
        const next = await execute(h, back);
        assert.equal(next.details.execution.outcome, 'dispatched');
        assert.equal(h.calls.filter(c => c[0] === 'adb' && c[1].includes('input')).length, 1);
    });
}

for (const elapsed of [1999, 2000, 2001]) test(`model result at ${elapsed}ms respects its 2000ms deadline without timer delivery`, async t => {
    const advance = clock(t); let first = true;
    const world = await searchWorld({ modelTimeoutMs: 2000, decide(state, questions) {
        if (first) { first = false; advance(elapsed); }
        return response(questions, state.candidates[0].candidateId);
    } });
    t.after(() => world.service.cleanup());
    const result = (await world.run()).details.task;
    assert.equal(result.code, elapsed < 2000 ? null : 'TASK_JEV_TIMEOUT');
    assert.equal(world.actions.length, elapsed < 2000 ? 3 : 0);
});

for (const elapsed of [9999, 10000, 10001]) test(`assistance result at ${elapsed}ms respects its 10000ms deadline without timer delivery`, async t => {
    const advance = clock(t);
    const world = await searchWorld({ decide: (state, q) => response(q, state.step === 'entry' ? 'escalate' : 'c0') });
    t.after(() => world.service.cleanup());
    const result = (await world.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async packet => {
        advance(elapsed); return select(packet);
    } })).details.task;
    assert.equal(result.code, elapsed < 10000 ? null : 'TASK_ASSISTANCE_TIMEOUT');
    assert.equal(world.actions.length, elapsed < 10000 ? 3 : 0);
});

test('assistance trace latency consumes the original window before invoking the dependency', async t => {
    const advance = clock(t); let calls = 0;
    const store = traceStore(e => { if (e.type === 'assistance' && e.assistance.phase === 'started') advance(10001); });
    const world = await searchWorld({ traceStore: store, decide: (_, q) => response(q, 'escalate') });
    t.after(() => world.service.cleanup());
    const result = (await world.run(spec({ assistance: 'main_agent' }), { androidTaskReplan: async packet => { calls++; return select(packet); } })).details.task;
    assert.equal(result.code, 'TASK_ASSISTANCE_TIMEOUT');
    assert.equal(calls, 0);
    assert.equal(world.actions.length, 0);
});

for (const elapsed of [59999, 60000, 60001]) test(`human approval at ${elapsed}ms respects its local cap`, async t => {
    const advance = clock(t);
    const human = createHumanInteraction({ runtime: { check() {}, executionSignal: () => undefined, remainingTaskMs: () => 120000,
        failure: code => Object.assign(Error(code), { code }) },
    getService: () => ({ async request() { advance(elapsed); return true; } }) });
    if (elapsed < 60000) assert.equal(await human.request('approval', 'Test'), true);
    else await assert.rejects(human.request('approval', 'Test'), { code: 'HUMAN_INTERACTION_CANCELLED' });
});

function stream(deviceApi) {
    const hub = { serial: 'A', lastPacketAt: Date.now(), status: () => ({ state: 'streaming' }), isSocketAlive: () => true };
    const server = new StreamServer({ scrcpyHub: hub, deviceApi, logger: {} });
    server.scrcpyStreamers.set({ readyState: 1 }, () => {});
    let recoveries = 0;
    server.handleScrcpyLoss = async () => { recoveries++; };
    return { hub, server, get recoveries() { return recoveries; } };
}

test('device listing failure stays a failure and cannot restart a healthy stream', async t => {
    const h = await harness(); t.after(() => h.service.cleanup());
    h.client.devices = async () => { throw Object.assign(Error('queue full'), { code: 'ADB_QUEUE_FULL' }); };
    const s = stream(h.api);
    await assert.rejects(h.api.listDevices(), { code: 'ADB_QUEUE_FULL' });
    assert.equal(await s.server.checkLiveness(), false);
    assert.equal(s.recoveries, 0);
    let status, body;
    await s.server.handleApi({ method: 'GET' }, {
        writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); },
    }, new URL('http://localhost/api/devices'));
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'queue full');
});

for (const [name, devices, expected] of [
    ['A ready', [{ serial: 'A', state: 'device' }], false],
    ['A offline with B ready', [{ serial: 'A', state: 'offline' }, { serial: 'B', state: 'device' }], true],
    ['A absent with B ready', [{ serial: 'B', state: 'device' }], true],
    ['empty successful query', [], true],
]) test(`stream liveness is bound to its selected serial: ${name}`, async () => {
    const s = stream({ listDevices: async () => ({ ok: true, devices }) });
    assert.equal(await s.server.checkLiveness(), expected);
    assert.equal(s.recoveries, Number(expected));
});

for (const change of ['serial', 'lifecycle', 'hub', 'viewers']) test(`a device query cannot cross a change in ${change}`, async () => {
    const gate = deferred(), s = stream({ listDevices: () => gate.promise });
    const checking = s.server.checkLiveness();
    if (change === 'serial') s.hub.serial = 'B';
    if (change === 'lifecycle') s.server.lifecycle++;
    if (change === 'hub') s.server.scrcpyHub = { ...s.hub };
    if (change === 'viewers') s.server.scrcpyStreamers.clear();
    gate.resolve({ ok: true, devices: [] });
    assert.equal(await checking, false);
    assert.equal(s.recoveries, 0);
});

for (const info of [undefined, { ok: false, devices: [] }, { ok: true }]) {
    test(`inconclusive device query ${JSON.stringify(info)} cannot trigger recovery`, async () => {
        const s = stream({ listDevices: async () => info });
        assert.equal(await s.server.checkLiveness(), false);
        assert.equal(s.recoveries, 0);
    });
}

test('a stream without a selected serial cannot infer its disappearance from other devices', async () => {
    let calls = 0;
    const s = stream({ listDevices: async () => { calls++; return { ok: true, devices: [] }; } });
    s.hub.serial = undefined;
    assert.equal(await s.server.checkLiveness(), false);
    assert.equal(s.recoveries, 0);
    assert.equal(calls, 0);
});
