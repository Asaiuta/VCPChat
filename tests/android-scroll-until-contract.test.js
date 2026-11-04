'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const ID = 'com.example:id/list';
const TARGET = 'com.example:id/goal';
const leaf = (options = {}) => `<node class="android.widget.TextView" package="${options.package || 'com.example'}" resource-id="${options.id || TARGET}" text="${options.text || 'Goal'}" bounds="${options.bounds || '[10,80][90,110]'}" ${options.extra || ''}/>`;
const tree = (options = {}) => `<hierarchy rotation="0"><node class="android.widget.ScrollView" package="${options.package || 'com.example'}" resource-id="${options.id || ID}" scrollable="${options.scrollable ?? true}" enabled="${options.enabled ?? true}" bounds="${options.bounds || '[0,20][100,180]'}" ${options.extra || ''}>${options.children || ''}</node>${options.sibling || ''}</hierarchy>`;
const inputs = h => h.calls.filter(([kind, args]) => kind === 'adb' && args[1] === 'input');
const rpcs = h => h.calls.filter(([kind]) => kind === 'rpc');
const run = (h, action = {}, extra = {}, context) => h.service.processToolCall({
    command: 'ExecuteStep', serial: 'A', action: {
        command: 'ScrollUntil', container: `id=${ID}`, target: `id=${TARGET}`, ...action,
    }, ...extra,
}, context);
const visibleTree = () => tree({ children: leaf() });
const shellHarness = options => harness({ config: { UI_SERVER: false }, dump: () => tree(), ...options });

for (const action of [
    { container: undefined }, { target: undefined }, { container: 'text=List' },
    { container: `id=${ID}#1` }, { target: 'text=Goal#2' }, { target: 'text=' },
    { target: 'text=\u0000' }, { strategy: 'random' },
    { direction: 'diagonal' }, { maxSwipes: 0 }, { maxSwipes: 21 }, { maxSwipes: 1.1 },
    { maxSwipes: true }, { maxSwipes: '1e1' }, { maxSwipes: '0x1' },
    { strategy: 'rpc', maxSwipes: 2 }, { strategy: 'rpc', direction: 'up' },
    { strategy: 'rpc', direction: 'left' }, { index: 0 }, { x: 1 }, { duration: 300 },
]) test(`ScrollUntil rejects invalid shape before sampling: ${JSON.stringify(action)}`, async () => {
    const h = await shellHarness();
    await assert.rejects(run(h, action), { code: 'INVALID_ARGUMENT' });
    assert.equal(h.dumpCount, 0);
    assert.equal(inputs(h).length, 0);
    assert.equal(rpcs(h).length, 0);
});

test('ScrollUntil already-visible target is read-only and intrinsically verified', async () => {
    const h = await shellHarness({ dump: visibleTree });
    const result = await run(h);
    assert.equal(result.details.actionVerified, true);
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(result.details.swipes, 0);
    assert.equal(result.details.experimental, true);
    assert.equal(inputs(h).length, 0);
    assert.equal(rpcs(h).length, 0);
    assert.equal(h.dumpCount, 1);
});

test('ScrollUntil exact raw text works without relying on normalized or merged labels', async () => {
    const h = await shellHarness({ dump: () => tree({ children: leaf({ text: 'A #1 &amp; B' }) }) });
    const result = await run(h, { target: 'text=A %231 & B' });
    assert.equal(result.details.actionVerified, true);
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil host repeatedly rebinds live container and accumulates one shell attempt per swipe', async () => {
    let swipes = 0;
    const h = await shellHarness({
        dump: () => tree({ bounds: swipes ? '[0,40][100,160]' : '[0,20][100,180]', children: swipes >= 2 ? leaf() : '' }),
        run: args => { if (args[1] === 'input') swipes += 1; },
    });
    const result = await run(h, { strategy: 'host', maxSwipes: 3 });
    assert.equal(result.details.strategy, 'host');
    assert.equal(result.details.swipes, 2);
    assert.equal(result.details.execution.outcome, 'verified');
    assert.deepEqual(inputs(h).map(call => Array.from(call[1])), [
        ['shell', 'input', 'swipe', '50', '148', '50', '52', '300'],
        ['shell', 'input', 'swipe', '50', '136', '50', '64', '300'],
    ]);
    assert.deepEqual(Array.from(result.details.attempts, a => a.channel), ['shell', 'shell']);
    assert.equal(h.dumpCount, 5);
    assert.equal(rpcs(h).length, 0);
});

for (const [direction, coords] of [
    ['down', ['50', '148', '50', '52']], ['up', ['50', '52', '50', '148']],
    ['right', ['80', '100', '20', '100']], ['left', ['20', '100', '80', '100']],
]) test(`ScrollUntil host ${direction} stays strictly inside the clipped container`, async () => {
    const h = await shellHarness();
    const result = await run(h, { strategy: 'host', direction, maxSwipes: 1 });
    assert.deepEqual(Array.from(inputs(h)[0][1]).slice(3, 7), coords);
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.actionVerified, false);
    assert.equal(result.details.swipes, 1);
});

test('ScrollUntil at maxSwipes returns progress and unknown that outer expect cannot wash green', async () => {
    const h = await shellHarness();
    const result = await run(h, { maxSwipes: 2 }, { expect: { type: 'visible', selector: `id=${ID}` } });
    assert.equal(result.details.strategy, 'host');
    assert.equal(result.details.swipes, 2);
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.execution.verification.matched, false);
    assert.equal(result.details.actionVerified, false);
    assert.equal(inputs(h).length, 2);
});

for (const [name, options] of [
    ['offscreen target', { children: leaf({ bounds: '[0,220][90,250]' }) }],
    ['outside container clipping', { children: leaf({ bounds: '[0,0][90,15]' }) }],
    ['same-bounds sibling is not a descendant', { sibling: leaf() }],
    ['different package', { children: leaf({ package: 'com.other' }) }],
    ['hidden target', { children: leaf({ extra: 'visible-to-user="false"' }) }],
    ['nested scroll clips target', { children: `<node class="android.widget.ScrollView" package="com.example" scrollable="true" bounds="[0,30][100,60]">${leaf()}</node>` }],
]) test(`ScrollUntil cannot verify ${name}`, async () => {
    const h = await shellHarness({ dump: () => tree(options) });
    const result = await run(h, { strategy: 'host', maxSwipes: 1 });
    assert.equal(result.details.actionVerified, false);
    assert.equal(result.details.execution.outcome, 'unknown');
});

for (const [name, source, code] of [
    // Shared resolution rejects pruned and ambiguous nodes before factory-local validation.
    ['non-scrollable', tree({ scrollable: false }), 'SCROLL_UNTIL_SAMPLE_FAILED'],
    ['disabled', tree({ enabled: false }), 'SCROLL_UNTIL_SAMPLE_FAILED'],
    ['tiny', tree({ bounds: '[0,0][2,2]' }), 'INVALID_SCROLL_CONTAINER'],
    ['duplicate container', tree({ sibling: tree().replace(/<\/?hierarchy[^>]*>/g, '') }), 'SCROLL_UNTIL_SAMPLE_FAILED'],
    ['duplicate target', tree({ children: leaf() + leaf({ bounds: '[10,120][90,150]' }) }), 'AMBIGUOUS_SCROLL_TARGET'],
]) test(`ScrollUntil refuses ${name} before input`, async () => {
    const h = await shellHarness({ dump: () => source });
    await assert.rejects(run(h), { code });
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil host enforces same package after first input and never retries', async () => {
    let moved = false;
    const h = await shellHarness({ dump: () => tree({ package: moved ? 'com.changed' : 'com.example' }),
        run: args => { if (args[1] === 'input') moved = true; } });
    await assert.rejects(run(h, { strategy: 'host' }), error => {
        assert.equal(error.code, 'SCROLL_CONTEXT_CHANGED');
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(error.details.attempts.length, 1);
        return true;
    });
    assert.equal(inputs(h).length, 1);
});

test('ScrollUntil refuses changed screen dimensions before another input', async () => {
    const h = await shellHarness();
    let reads = 0;
    h.client.screenSize = async () => (++reads > 2 ? { width: 200, height: 100 } : { width: 100, height: 200 });
    await assert.rejects(run(h, { strategy: 'host' }), error => error.execution.outcome === 'unknown');
    assert.equal(inputs(h).length, 1);
});

for (const probe of [
    { wakefulness: 'Asleep', focus: { package: 'com.example' } },
    { wakefulness: 'Dozing', focus: { package: 'com.example' } },
    { wakefulness: 'Awake', focus: { package: 'com.android.systemui' } },
]) test(`ScrollUntil checks awake/unlocked without autoWake: ${JSON.stringify(probe)}`, async () => {
    const h = await shellHarness({ config: { UI_SERVER: false, AUTO_WAKE: true } });
    h.client.probeScreen = async () => probe;
    await assert.rejects(run(h));
    assert.equal(h.dumpCount, 0);
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil stops immediately when device locks after one swipe', async () => {
    let moved = false;
    const h = await shellHarness({ run: args => { if (args[1] === 'input') moved = true; } });
    h.client.probeScreen = async () => ({ wakefulness: 'Awake', size: { width: 100, height: 200 },
        focus: { package: moved ? 'com.android.systemui' : 'com.example' } });
    await assert.rejects(run(h, { strategy: 'host' }), error => error.code === 'DEVICE_LOCKED' && error.execution.outcome === 'unknown');
    assert.equal(inputs(h).length, 1);
});

for (const kind of ['id', 'text']) test(`ScrollUntil RPC compiles exact ${kind} mask with fixed container package and verifies fresh tree`, async () => {
    let moved = false;
    const spec = { ok: true,
        get xml() { return moved ? visibleTree() : tree(); },
        invoke(method) { assert.equal(method, 'scrollTo'); moved = true; return true; },
    };
    const h = await harness({ uiServer: spec });
    const result = await run(h, { target: kind === 'id' ? `id=${TARGET}` : 'text=Goal' }, { timeoutMs: 15000 });
    assert.equal(rpcs(h).length, 1);
    const rpc = rpcs(h)[0];
    assert.equal(rpc[1], 'scrollTo');
    assert.equal(rpc[2][0].className, 'android.widget.ScrollView');
    assert.equal(rpc[2][0].resourceId, ID);
    // Bundled Selector uses 0x80000 for packageName; 0x1000000 is instance.
        assert.equal(rpc[2][1].mask, 524288 | (kind === 'text' ? 1 : 2097152));
    assert.equal(rpc[2][1].packageName, 'com.example');
    assert.equal(rpc[2][1][kind === 'text' ? 'text' : 'resourceId'], kind === 'text' ? 'Goal' : TARGET);
    assert.equal(rpc[2][2], true);
    assert.ok(rpc[3].timeoutMs > 10000, 'scrollTo must use shared remaining budget, not the default 4 seconds');
    assert.equal(result.details.strategy, 'rpc');
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(inputs(h).length, 0);
    assert.equal(h.uiServer.dumped, 3);
});

for (const direction of ['right']) test(`ScrollUntil RPC ${direction} uses horizontal scrollTo`, async () => {
    const h = await harness({ uiServer: { ok: true, xml: tree() } });
    const result = await run(h, { strategy: 'rpc', direction });
    assert.equal(rpcs(h)[0][2][2], false);
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.actionVerified, false);
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil RPC ACK without a visible target remains unknown and does not host-scroll', async () => {
    const h = await harness({ uiServer: { ok: true, xml: tree() } });
    const result = await run(h, {}, { expect: { type: 'visible', selector: `id=${ID}` } });
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.actionVerified, false);
    assert.equal(rpcs(h).length, 1);
    assert.equal(inputs(h).length, 0);
});

for (const mode of ['false', 'timeout', 'not-dispatched', 'unknown']) test(`ScrollUntil RPC ${mode} never switches strategy or replays`, async () => {
    const h = await harness({ uiServer: { ok: true, xml: tree(), invoke() {
        if (mode === 'false') return false;
        throw Object.assign(new Error('private target content'), { code: 'UI_SERVER_TIMEOUT',
            ...(mode === 'not-dispatched' ? { dispatched: false } : mode === 'timeout' ? { dispatched: true } : {}) });
    } } });
    await assert.rejects(run(h), error => {
        assert.equal(error.execution.outcome, mode === 'not-dispatched' ? 'failed' : 'unknown');
        assert.equal(error.message.includes('private target content'), false);
        assert.equal(error.details.attempts.length, 1);
        return true;
    });
    assert.equal(rpcs(h).length, 1);
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil auto with explicit maxSwipes selects host even with ready RPC', async () => {
    const h = await harness({ uiServer: { ok: true, xml: tree() } });
    const result = await run(h, { maxSwipes: 1 });
    assert.equal(result.details.strategy, 'host');
    assert.equal(rpcs(h).length, 0);
    assert.equal(inputs(h).length, 1);
});

test('ScrollUntil auto can select host only before writes on known unready service', async () => {
    const h = await harness({ dump: () => tree(), uiServer: { ok: false } });
    // Target appears after one swipe so the default host limit is not reached.
    h.client.runText = ((original) => async (args, request) => {
        if (args.includes('uiautomator') && inputs(h).length) return visibleTree();
        return original.call(h.client, args, request);
    })(h.client.runText);
    const result = await run(h);
    assert.equal(result.details.strategy, 'host');
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(inputs(h).length, 1);
    assert.equal(rpcs(h).length, 0);
});

test('ScrollUntil explicit rpc rejects known unavailable service without host input', async () => {
    const h = await harness({ dump: () => tree(), uiServer: { ok: false } });
    await assert.rejects(run(h, { strategy: 'rpc' }), { code: 'UI_SERVER_NOT_READY' });
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil readiness unknown is not evidence for auto host fallback', async () => {
    const h = await harness({ dump: () => tree(), uiServer: { start() { throw new Error('private'); } } });
    await assert.rejects(run(h), { code: 'UI_SERVER_READINESS_UNKNOWN' });
    assert.equal(inputs(h).length, 0);
    assert.equal(rpcs(h).length, 0);
});

test('ScrollUntil shell unknown failure preserves one attempt and never replays', async () => {
    const h = await shellHarness({ run: args => { if (args[1] === 'input') throw new Error('secret'); } });
    await assert.rejects(run(h, { strategy: 'host' }), error => {
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(error.details.attempts[0].status, 'unknown');
        assert.equal(error.message.includes('secret'), false);
        return true;
    });
    assert.equal(inputs(h).length, 1);
});

test('ScrollUntil post-input acquisition failure cannot be washed by outer expect', async () => {
    let moved = false;
    const h = await shellHarness({ dump: () => moved ? '<hierarchy><node></hierarchy>' : tree(),
        run: args => { if (args[1] === 'input') moved = true; } });
    await assert.rejects(run(h, { strategy: 'host' }, { expect: { type: 'visible', selector: `id=${ID}` } }), error => {
        assert.equal(error.code, 'SCROLL_UNTIL_SAMPLE_FAILED');
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(error.details.attempts.length, 1);
        return true;
    });
    assert.equal(inputs(h).length, 1);
});

test('ScrollUntil cancellation after first host input prevents every later send', async () => {
    const controller = new AbortController();
    const h = await shellHarness({ run: args => { if (args[1] === 'input') controller.abort(); } });
    await assert.rejects(run(h, { strategy: 'host' }, {}, { signal: controller.signal }), error => {
        assert.equal(error.code, 'STEP_ABORTED');
        assert.equal(error.execution.outcome, 'unknown');
        return true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(inputs(h).length, 1);
});

test('ScrollUntil readiness consumes the shared deadline and cannot dispatch late', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let starts = 0;
    const h = await harness({ dump: () => tree(), uiServer: { start() {
        starts += 1;
        return starts === 1 ? { ok: false } : gate;
    } } });
    try {
        await assert.rejects(run(h, {}, { timeoutMs: 25 }), { code: 'STEP_DEADLINE' });
        assert.equal(inputs(h).length, 0);
        assert.equal(rpcs(h).length, 0);
    } finally {
        release({ ok: true });
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(inputs(h).length, 0);
    assert.equal(rpcs(h).length, 0);
});


for (const direction of ['up', 'left']) test(`ScrollUntil auto ${direction} chooses directional host path even with ready RPC`, async () => {
    let moved = false;
    const h = await harness({ uiServer: { ok: true, get xml() { return moved ? visibleTree() : tree(); } },
        run: args => { if (args[1] === 'input') moved = true; } });
    const result = await run(h, { direction });
    assert.equal(result.details.strategy, 'host');
    assert.equal(rpcs(h).length, 0);
    assert.equal(inputs(h).length, 1);
});

test('ScrollUntil selector uses only shared %25/%23 escaping, not URL decoding', async () => {
    const h = await shellHarness({ dump: () => tree({ children: leaf({ text: '%41 #1' }) }) });
    const result = await run(h, { target: 'text=%2541 %231' });
    assert.equal(result.details.actionVerified, true);
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil host gestures stay within ancestor clipping as well as the container', async () => {
    const inner = tree({ bounds: '[-20,-20][120,220]' }).replace(/<\/?hierarchy[^>]*>/g, '');
    const h = await shellHarness({ dump: () => tree({ id: 'com.example:id/outer', bounds: '[20,60][80,140]', children: inner }) });
    const result = await run(h, { strategy: 'host', maxSwipes: 1 });
    assert.deepEqual(Array.from(inputs(h)[0][1]).slice(3, 7), ['50', '124', '50', '76']);
    assert.equal(result.details.execution.outcome, 'unknown');
});

test('ScrollUntil maxSwipes=20 is accepted and has exactly twenty cumulative attempts', async () => {
    const h = await shellHarness();
    const result = await run(h, { maxSwipes: 20 });
    assert.equal(inputs(h).length, 20);
    assert.equal(result.details.attempts.length, 20);
    assert.equal(result.details.swipes, 20);
    assert.equal(result.details.execution.outcome, 'unknown');
});


test('ScrollUntil RPC post-write invalid tree remains unknown despite outer expect', async () => {
    let moved = false;
    const h = await harness({
        uiServer: { ok: true, get xml() { return moved ? '<hierarchy><node></hierarchy>' : tree(); },
            invoke() { moved = true; return true; } },
    });
    await assert.rejects(run(h, {}, { expect: { type: 'visible', selector: `id=${ID}` } }), error => {
        assert.equal(error.code, 'SCROLL_UNTIL_SAMPLE_FAILED');
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(error.details.attempts.length, 1);
        assert.equal(error.details.experimental, true);
        return true;
    });
    assert.equal(rpcs(h).length, 1);
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil RPC cancellation never schedules host input or another RPC', async () => {
    const controller = new AbortController();
    const h = await harness({ uiServer: { ok: true, xml: tree(), invoke() { controller.abort(); return true; } } });
    await assert.rejects(run(h, {}, {}, { signal: controller.signal }), error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'unknown');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rpcs(h).length, 1);
    assert.equal(inputs(h).length, 0);
});

test('ScrollUntil explicit B uses only B without switching default A', async () => {
    let moved = false;
    const h = await shellHarness({ dump: () => moved ? visibleTree() : tree(),
        run: args => { if (args[1] === 'input') moved = true; } });
    const result = await run(h, { strategy: 'host' }, { serial: 'B' });
    assert.equal(result.details.execution.serial, 'B');
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(inputs(h)[0][2].serial, 'B');
    assert.equal(h.client.serial, 'A');
    assert.ok(h.calls.filter(call => call[0] === 'probe').every(call => call[1] === 'B'));
});
