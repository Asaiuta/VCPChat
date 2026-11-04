'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const focus = { package: 'com.example', component: 'com.example/.Main', window: 'Main' };
const probe = () => ({ focus: { ...focus }, size: { width: 100, height: 200 }, wakefulness: 'Awake' });
const tree = (text = '消息(3)', top = 20) => `<hierarchy rotation="0"><node class="android.widget.Button" package="com.example" resource-id="com.example:id/messages" text="${text}" clickable="true" enabled="true" bounds="[0,${top}][80,${top + 30}]"/></hierarchy>`;
const execute = (h, args = {}, ctx) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', ...args }, ctx);
const idle = { action: { command: 'Wait', mode: 'idle' }, waitTimeoutMs: 1000 };
const inputs = h => h.calls.filter(call => call[0] === 'rpc' && call[1] !== 'waitForIdle');

test('host fuzzy selector rebinds fresh dynamic text and explicit nth disambiguates only on request', async () => {
    const h = await harness({ uiServer: { ok: true, xml: tree('消息(4)') } });
    try {
        const result = await execute(h, { action: { command: 'Tap', selector: { contains: '消息', class: 'Button' } } });
        assert.equal(result.details.execution.outcome, 'dispatched');
        assert.equal(inputs(h).length, 1);
    } finally { await h.service.cleanup(); }
    const repeated = `<hierarchy>${tree('重复', 20).replace(/<\/?hierarchy[^>]*>/g, '')}${tree('重复', 80).replace(/<\/?hierarchy[^>]*>/g, '').replace('id/messages', 'id/other')}</hierarchy>`;
    const second = await harness({ uiServer: { ok: true, xml: repeated } });
    try {
        await assert.rejects(execute(second, { action: { command: 'Tap', selector: 'text=重复' } }), { code: 'TARGET_NOT_UNIQUE' });
        assert.equal(inputs(second).length, 0);
        await execute(second, { action: { command: 'Tap', selector: { text: '重复', nth: 1 } } });
        assert.equal(inputs(second).length, 1);
        assert.equal(inputs(second)[0][2][1], 95);
    } finally { await second.service.cleanup(); }
});

test('Wait idle RPC success is only a hint, layout stable verifies with no inputs and afterObserve reuses last tree', async () => {
    let index = 0;
    const h = await harness({ client: { async probeScreen() { return probe(); } },
        uiServer: { ok: true, xml: () => tree(`消息(${index++})`), invoke: () => null } });
    try {
        const result = await execute(h, { ...idle, afterObserve: true });
        assert.equal(result.details.execution.outcome, 'verified');
        assert.equal(result.details.idleMode, 'layout_stable');
        assert.equal(result.details.observation.status, 'observed');
        assert.equal(h.uiServer.dumped, 2);
        assert.equal(h.calls.filter(call => call[0] === 'rpc' && call[1] === 'waitForIdle').length, 1);
        assert.equal(inputs(h).length, 0);
        assert.match(result.content.map(part => part.text || '').join(''), /layout_stable/);
    } finally { await h.service.cleanup(); }
});

test('Wait idle continuously changing geometry is unknown even with always-true foreground expect', async () => {
    let index = 0;
    const h = await harness({ client: { async probeScreen() { return probe(); } },
        uiServer: { ok: true, xml: () => tree('消息', 20 + index++), invoke: () => null } });
    try {
        const result = await execute(h, { ...idle, waitTimeoutMs: 450, expect: { type: 'foreground', package: 'com.example' } });
        assert.equal(result.details.execution.outcome, 'unknown');
        assert.equal(result.details.actionVerified, false);
        assert.equal(result.details.idleMode, null);
        assert.equal(inputs(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('Wait idle transport timeout does not sample again or replay native', async () => {
    const h = await harness({ client: { async probeScreen() { return probe(); } }, uiServer: { ok: true,
        invoke() { throw Object.assign(new Error('transport secret'), { code: 'UI_SERVER_TIMEOUT', dispatched: true }); } } });
    try {
        await assert.rejects(execute(h, idle), error => error.code === 'UI_SERVER_TIMEOUT' && error.execution.outcome === 'failed');
        assert.equal(h.uiServer.dumped, 0);
        assert.equal(h.calls.filter(call => call[0] === 'rpc').length, 1);
    } finally { await h.service.cleanup(); }
});

test('Wait idle locks/asleep/context changes never become stable and never wake', async () => {
    let calls = 0;
    const h = await harness({ client: { async probeScreen() { const p = probe(); if (++calls > 1) p.focus.window = 'Other'; return p; } }, uiServer: { ok: true, invoke: () => null } });
    try { const result = await execute(h, { ...idle, waitTimeoutMs: 450 }); assert.equal(result.details.execution.outcome, 'unknown'); assert.equal(inputs(h).length, 0); }
    finally { await h.service.cleanup(); }
    const asleep = await harness({ client: { async probeScreen() { return { ...probe(), wakefulness: 'Asleep' }; } } });
    try { const result = await execute(asleep, idle); assert.equal(result.details.execution.outcome, 'unknown'); assert.equal(asleep.calls.some(call => call[0] === 'adb' && call[1].includes('input')), false); }
    finally { await asleep.service.cleanup(); }
});

test('idle Wait middle step still requires explicit expect in sequence before any input', async () => {
    const h = await harness();
    try { await assert.rejects(execute(h, { steps: [{ action: { command: 'Wait', mode: 'idle' } }, { action: { command: 'Tap', id: 'com.example:id/go' } }] }), { code: 'INVALID_ARGUMENT' }); assert.equal(h.dumpCount, 0); assert.equal(inputs(h).length, 0); }
    finally { await h.service.cleanup(); }
});

test('sequence dynamic fuzzy selectors and expectations rebind every step, not old snapshots', async () => {
    let clicks = 0;
    const h = await harness({ uiServer: { ok: true, xml: () => tree(`消息(${3 + clicks})`), invoke: () => { clicks++; return true; } } });
    try {
        const result = await execute(h, { steps: [
            { action: { command: 'Tap', selector: { contains: '消息' } }, expect: { type: 'visible', selector: { regex: '^消息.*$', role: 'button' } } },
            { action: { command: 'Tap', selector: { contains: '消息', nth: 0 } } },
        ] });
        assert.equal(result.details.sequence.status, 'completed'); assert.equal(clicks, 2); assert.equal(h.uiServer.dumped, 3);
    } finally { await h.service.cleanup(); }
});

test('invalid regex is rejected before first sequence action', async () => {
    const h = await harness({ uiServer: { ok: true } });
    try { await assert.rejects(execute(h, { steps: [
        { action: { command: 'Tap', id: 'com.example:id/go' }, expect: { type: 'visible', selector: 'text=Go' } },
        { action: { command: 'Wait' }, expect: { type: 'visible', selector: { regex: '(a+)+$' } } },
    ] }), { code: 'INVALID_ARGUMENT' }); assert.equal(inputs(h).length, 0); }
    finally { await h.service.cleanup(); }
});


for (const mode of ['duplicates', 'scope-missing', 'over-budget']) test(`Wait absent never turns incomplete/ambiguous ${mode} into verified`, async () => {
    const xml = mode === 'over-budget' ? `<hierarchy>${Array.from({ length: 300 }, () => tree('a'.repeat(100)).replace(/<\/?hierarchy[^>]*>/g, '')).join('')}</hierarchy>`
            : mode === 'duplicates' ? `<hierarchy>${tree('重复').replace(/<\/?hierarchy[^>]*>/g, '')}${tree('重复', 80).replace(/<\/?hierarchy[^>]*>/g, '')}</hierarchy>` : tree('重复');
    const selector = mode === 'duplicates' ? 'text=重复' : mode === 'scope-missing' ? { contains: '重复', within: { id: 'missing' } } : { regex: 'b'.repeat(512) };
    const h = await harness({ uiServer: { ok: true, xml } });
    try { const result = await execute(h, { action: { command: 'Wait' }, expect: { type: 'absent', selector }, waitTimeoutMs: 5 }); assert.equal(result.details.execution.outcome, 'unknown'); assert.equal(inputs(h).length, 0); }
    finally { await h.service.cleanup(); }
});

for (const code of ['UI_SERVER_TIMEOUT', 'UI_SERVER_ABORTED', 'UI_SERVER_RPC_FAILED', 'UI_SERVER_BAD_JSON', 'UI_SERVER_BAD_RESPONSE', 'UI_SERVER_RESPONSE_TOO_LARGE']) test(`M2 ${code} quarantines subsequent device reads/writes and management without another request`, async () => {
    const h = await harness({ client: { async probeScreen() { return probe(); } }, uiServer: { ok: true, invoke() { throw Object.assign(new Error('incomplete transport'), { code, dispatched: true }); } } });
    try {
        await assert.rejects(execute(h, idle), { code });
        const count = h.calls.length;
        for (const args of [{ command: 'Observe', serial: 'A' }, { command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', id: 'com.example:id/go' } }, { command: 'Manage', operation: 'reconnect', serial: 'A' }]) await assert.rejects(h.service.processToolCall(args), { code: 'DEVICE_STATE_UNCERTAIN' });
        assert.equal(h.calls.length, count);
    } finally { await h.service.cleanup(); }
});

test('idle plus expect consumes one wait budget rather than a fresh second budget', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const h = await harness({ client: { async probeScreen() { return probe(); } }, uiServer: { ok: true, xml: tree(), invoke() { t.mock.timers.tick(400); return null; } } });
    try {
        const started = Date.now();
        const pending = execute(h, { ...idle, waitTimeoutMs: 1000, expect: { type: 'foreground', package: 'never.match' } });
        let result; pending.then(value => { result = value; });
        for (let i = 0; i < 20 && !result; i++) { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(100); }
        await pending;
        assert.equal(result.details.execution.outcome, 'unknown');
        assert.ok(Date.now() - started < 1600);
    } finally { await h.service.cleanup(); }
});


test('failed condition transport cannot launch afterObserve inside the same ExecuteStep', async () => {
    const h = await harness({ uiServer: { ok: true, xml() { throw Object.assign(new Error('still remote'), { code: 'UI_SERVER_TIMEOUT', dispatched: true }); } } });
    try {
        const result = await execute(h, { action: { command: 'Wait' }, expect: { type: 'visible', selector: 'text=Go' }, afterObserve: true, waitTimeoutMs: 100 });
        assert.equal(result.details.execution.outcome, 'unknown');
        assert.equal(result.details.observation.status, 'failed');
        assert.equal(h.uiServer.dumped, 1); assert.equal(h.dumpCount, 0);
        for (const operation of ['reconnect', 'connect', 'disconnect', 'pair']) assert.throws(() => h.api[operation]({}), { code: 'DEVICE_STATE_UNCERTAIN' });
    } finally { await h.service.cleanup(); }
});

test('idle drained ADB probe timeout at its own deadline is unknown IDLE_TIMEOUT without a new request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let probes = 0;
    let drained = false;
    const h = await harness({ client: { async probeScreen() {
        if (++probes === 1) return probe();
        t.mock.timers.tick(4500);
        drained = true;
        throw Object.assign(new Error('read probe deadline'), { code: 'ADB_TIMEOUT' });
    } }, uiServer: { ok: true, invoke: () => null } });
    try {
        const result = await execute(h, { ...idle, waitTimeoutMs: 4500, timeoutMs: 10000 });
        assert.equal(drained, true);
        assert.equal(result.details.execution.outcome, 'unknown');
        assert.equal(result.details.execution.verification.error, 'IDLE_TIMEOUT');
        assert.equal(result.details.actionVerified, false);
        assert.equal(result.details.idleMode, null);
        assert.equal(probes, 2);
        assert.equal(h.uiServer.dumped, 0);
        assert.equal(h.calls.filter(call => call[0] === 'rpc').length, 1);
        assert.equal(inputs(h).length, 0);
    } finally { await h.service.cleanup(); }
});


for (const phase of ['baseline-probe', 'baseline-size', 'sample-size', 'final-probe']) test(`idle budget-expired drained ADB_TIMEOUT from ${phase} stops without more reads`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let probes = 0;
    let sizes = 0;
    let stopped = false;
    const deadlines = [];
    const fail = () => {
        t.mock.timers.tick(4500);
        stopped = true;
        throw Object.assign(new Error('drained read'), { code: 'ADB_TIMEOUT' });
    };
    const h = await harness({ client: {
        withContext({ deadlineMs }, task) { deadlines.push(deadlineMs); return task(); },
        async probeScreen() {
            assert.equal(stopped, false);
            probes++;
            if ((phase === 'baseline-probe' && probes === 1) || (phase === 'final-probe' && probes === 3)) return fail();
            return probe();
        },
        async screenSize() {
            assert.equal(stopped, false);
            sizes++;
            if ((phase === 'baseline-size' && sizes === 1) || (phase === 'sample-size' && sizes === 2)) return fail();
            return { width: 100, height: 200 };
        },
    }, uiServer: { ok: true, xml: tree(), invoke: () => null } });
    try {
        const started = Date.now();
        const result = await execute(h, { ...idle, waitTimeoutMs: 4500, timeoutMs: 10000 });
        assert.equal(result.details.execution.outcome, 'unknown');
        assert.equal(result.details.execution.verification.error, 'IDLE_TIMEOUT');
        assert.equal(result.details.actionVerified, false);
        assert.equal(Date.now() - started, 4500);
        assert.ok(deadlines.includes(started + 4500));
        assert.equal(h.uiServer.dumped, phase === 'final-probe' ? 1 : 0);
        assert.equal(inputs(h).length, 0);
        assert.equal(h.calls.filter(call => call[0] === 'rpc').length, phase.startsWith('baseline') ? 0 : 1);
    } finally { await h.service.cleanup(); }
});

for (const [code, elapsed] of [['ADB_TIMEOUT', 4499], ['ADB_ABORTED', 4500], ['STEP_ABORTED', 4500], ['STEP_DEADLINE', 4500], ['UI_SERVER_TIMEOUT', 4500], ['UI_SERVER_RPC_FAILED', 4500]]) test(`idle does not normalize ${code} at ${elapsed}ms`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let probes = 0;
    const failure = Object.assign(new Error('preserve error classification'), { code });
    const h = await harness({ client: { async probeScreen() {
        if (++probes === 1) return probe();
        t.mock.timers.tick(elapsed);
        throw failure;
    } }, uiServer: { ok: true, invoke: () => null } });
    try {
        await assert.rejects(execute(h, { ...idle, waitTimeoutMs: 4500, timeoutMs: 10000 }), error => error === failure && error.code === code);
        assert.equal(probes, 2);
        assert.equal(h.uiServer.dumped, 0);
        assert.equal(h.calls.filter(call => call[0] === 'rpc').length, 1);
    } finally { await h.service.cleanup(); }
});

for (const boundary of ['cancel', 'step-deadline']) test(`idle expired ADB_TIMEOUT cannot hide ${boundary}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const controller = new AbortController();
    let probes = 0;
    const h = await harness({ client: { async probeScreen() {
        if (++probes === 1) return probe();
        t.mock.timers.tick(boundary === 'cancel' ? 4500 : 5000);
        if (boundary === 'cancel') controller.abort();
        throw Object.assign(new Error('drained read after terminal boundary'), { code: 'ADB_TIMEOUT' });
    } }, uiServer: { ok: true, invoke: () => null } });
    try {
        await assert.rejects(execute(h, { ...idle, waitTimeoutMs: 4500, timeoutMs: boundary === 'cancel' ? 10000 : 5000 }, { signal: controller.signal }), { code: boundary === 'cancel' ? 'STEP_ABORTED' : 'STEP_DEADLINE' });
        assert.equal(probes, 2); assert.equal(h.uiServer.dumped, 0);
        assert.equal(h.calls.filter(call => call[0] === 'rpc').length, 1);
    } finally { await h.service.cleanup(); }
});

