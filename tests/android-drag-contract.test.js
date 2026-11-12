'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const rpc = h => h.calls.filter(call => call[0] === 'rpc');
const inputs = h => h.calls.filter(call => call[0] === 'adb' && call[1].includes('input'));
const modelText = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const settle = work => work.then(value => ({ value }), error => ({ error }));
const node = (id, bounds, extra = '') => `<node class="android.widget.Button" package="com.example" resource-id="com.example:id/${id}" text="${id}" clickable="true" bounds="${bounds}" ${extra}/>`;
const tree = (source = '[0,0][40,40]', end = '[60,100][120,250]', extra = '') => `<hierarchy rotation="0">${node('source', source)}${node('end', end)}${extra}</hierarchy>`;
const action = { command: 'Drag', id: 'com.example:id/source', target: { id: 'com.example:id/end' } };
const run = (h, value = action, args = {}, context) => h.service.processToolCall({ command: 'ExecuteStep', action: value, ...args }, context);
const backend = (xml = tree(), extra = {}) => ({ uiServer: { ok: true, xml, ...extra } });

function clock(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    return ms => t.mock.timers.tick(ms);
}

function failure(error, status, outcome = 'unknown') {
    assert.equal(error.execution.outcome, outcome);
    assert.equal(error.execution.retryable, false);
    assert.equal(error.execution.verification, null);
    assert.equal(error.details.experimental, true);
    assert.deepEqual(Array.from(error.details.attempts, item => item.status), [status]);
    assert.match(error.message, /"experimental":true/);
    assert.doesNotMatch(error.message, /private transport body/);
    return true;
}

test('Drag semantic endpoints share one fresh tree and emit one dragTo touch stream', async () => {
    const h = await harness(backend());
    const result = await run(h, { ...action, steps: 100 });
    assert.equal(h.uiServer.dumped, 2, '两端共享一次目标采样，另一次为最终policy gate');
    assert.equal(rpc(h).length, 1);
    const [, method, params] = rpc(h)[0];
    assert.equal(method, 'dragTo');
    assert.equal(params.length, 4);
    assert.equal(params[0].className, 'android.widget.Button');
    assert.equal(params[0].packageName, 'com.example');
    assert.equal(params[0].resourceId, 'com.example:id/source');
    assert.deepEqual(Array.from(params).slice(1), [80, 150, 100]);
    assert.equal(inputs(h).length, 0, '不能拼LongPress与Swipe');
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(result.details.execution.verification, null);
    assert.equal(result.details.experimental, true);
    assert.match(modelText(result), /"experimental":true/);
});

test('Drag rebinds both semantic endpoints live instead of using previous Observe geometry', async () => {
    let dumps = 0;
    const spec = { ok: true, get xml() { return dumps++ === 0 ? tree() : tree('[10,20][50,60]', '[70,160][100,200]'); } };
    const h = await harness({ uiServer: spec });
    await h.service.processToolCall({ command: 'Observe' });
    const result = await run(h);
    assert.equal(h.uiServer.dumped, 3, 'Observe、共享目标采样与最终policy gate各一次');
    assert.deepEqual(Array.from(rpc(h)[0][2]).slice(1), [85, 180, 60]);
    assert.equal(result.details.x1, 30);
    assert.equal(result.details.y1, 40);
});

for (const [name, source, target] of [
    ['source index and semantic end', { index: 0 }, { id: 'com.example:id/end' }],
    ['semantic source and end index', { id: 'com.example:id/source' }, { index: 1 }],
    ['both indices', { index: 0 }, { index: 1 }],
]) test(`Drag ${name} validates the original snapshot before one shared capture`, async () => {
    const h = await harness(backend());
    const observed = await h.service.processToolCall({ command: 'Observe' });
    const snapshotId = observed.details.snapshotId;
    await run(h, { command: 'Drag', ...source, ...(source.index !== undefined ? { snapshotId } : {}), target: { ...target, ...(target.index !== undefined ? { snapshotId } : {}) } });
    assert.equal(rpc(h).length, 1);
    assert.equal(h.uiServer.dumped, 3, 'Observe、共享目标采样与最终policy gate各一次');
    await assert.rejects(run(h, { command: 'Drag', index: 0, snapshotId, target: { id: 'com.example:id/end' } }));
    assert.equal(rpc(h).length, 1, '已消耗凭据不得重放');
});

test('Drag two index endpoints cannot carry different snapshot credentials', async () => {
    const h = await harness(backend());
    const observed = await h.service.processToolCall({ command: 'Observe' });
    await assert.rejects(run(h, { command: 'Drag', index: 0, snapshotId: observed.details.snapshotId, target: { index: 1, snapshotId: 'wrong' } }));
    assert.equal(rpc(h).length, 0);
});

for (const end of ['semantic', 'pixels']) test(`Drag pixel source to ${end} endpoint requires one fresh same-device frame`, async () => {
    const h = await harness(backend());
    const observed = await h.service.processToolCall({ command: 'Observe', mode: 'image' });
    const target = end === 'semantic' ? { target: { id: 'com.example:id/end' } } : { x2: 99, y2: 199 };
    const result = await run(h, { command: 'Drag', x: 0, y: 0, frameId: observed.details.frameId, ...target });
    assert.equal(rpc(h)[0][1], 'drag');
    assert.deepEqual(Array.from(rpc(h)[0][2]), [0, 0, ...(end === 'semantic' ? [80, 150] : [99, 199]), 60]);
    assert.equal(result.details.execution.outcome, 'dispatched');
});

for (const args of [
    { x2: 0, y2: 0 }, { x2: 99, y2: 199 },
]) test(`Drag semantic source to pixel endpoint ${JSON.stringify(args)} uses frame credential`, async () => {
    const h = await harness(backend());
    const shot = await h.service.processToolCall({ command: 'Observe', mode: 'image' });
    await run(h, { command: 'Drag', id: action.id, frameId: shot.details.frameId, ...args });
    assert.equal(rpc(h)[0][1], 'dragTo');
    assert.deepEqual(Array.from(rpc(h)[0][2]).slice(1), [args.x2, args.y2, 60]);
});

for (const [name, value] of [
    ['missing destination', { command: 'Drag', id: action.id }],
    ['mixed destination', { ...action, x2: 1, y2: 1 }],
    ['partial destination', { command: 'Drag', id: action.id, x2: 1 }],
    ['negative endpoint', { command: 'Drag', id: action.id, x2: -1, y2: 0 }],
    ['null target', { ...action, target: null }],
    ['array target', { ...action, target: [] }],
    ['pixel target object', { ...action, target: { x: 1, y: 1 } }],
    ['foreign device', { ...action, target: { id: 'com.example:id/end', serial: 'B' } }],
    ['ambiguous source', { ...action, x: 1, y: 1 }],
    ['ambiguous end', { ...action, target: { id: 'com.example:id/end', text: 'end' } }],
    ['null index', { ...action, id: undefined, index: null }],
    ['index without credential', { ...action, target: { index: 1 } }],
    ['zero steps', { ...action, steps: 0 }],
    ['oversized steps', { ...action, steps: 2001 }],
    ['fractional steps', { ...action, steps: 1.2 }],
    ['boolean steps', { ...action, steps: true }],
    ['exponent steps', { ...action, steps: '1e2' }],
    ['zero duration', { ...action, duration: 0 }],
    ['oversized duration', { ...action, duration: 10001 }],
    ['hex duration', { ...action, duration: '0x10' }],
    ['two clocks', { ...action, duration: 300, steps: 60 }],
    ['custom path', { ...action, gesture: [] }],
]) test(`Drag rejects ${name} before preparation or dispatch`, async () => {
    const h = await harness(backend());
    await assert.rejects(run(h, value), { code: 'INVALID_ARGUMENT' });
    assert.equal(h.uiServer.dumped, 0);
    assert.equal(rpc(h).length, 0);
    assert.equal(inputs(h).length, 0);
});

for (const [value, steps] of [[{ duration: 1 }, 1], [{ duration: 10000 }, 2000], [{ steps: 1 }, 1], [{ steps: 2000 }, 2000]]) {
    test(`Drag accepts timing boundary ${JSON.stringify(value)}`, async () => {
        const h = await harness(backend());
        const result = await run(h, { ...action, ...value });
        assert.equal(rpc(h)[0][2][3], steps);
        assert.equal(result.details.durationMs, steps * 5);
        assert.equal(rpc(h)[0][3].timeoutMs, Math.max(4000, steps * 5 + 1000));
    });
}

for (const [name, override] of [
    ['missing frame', {}], ['wrong frame', { frameId: 'wrong' }],
    ['offscreen x', { x2: 100, y2: 0 }], ['offscreen y', { x2: 0, y2: 200 }],
]) test(`Drag refuses ${name} without writes`, async () => {
    const h = await harness(backend());
    await assert.rejects(run(h, { command: 'Drag', id: action.id, x2: 1, y2: 1, ...override }));
    assert.equal(rpc(h).length, 0);
});

for (const target of ['source', 'end']) test(`Drag refuses disabled ${target} before dispatch`, async () => {
    const xml = `<hierarchy rotation="0">${node('source', '[0,0][40,40]', target === 'source' ? 'enabled="false"' : '')}${node('end', '[60,100][100,200]', target === 'end' ? 'enabled="false"' : '')}</hierarchy>`;
    const h = await harness(backend(xml));
    await assert.rejects(run(h));
    assert.equal(rpc(h).length, 0);
});

test('Drag rejects raw-tree duplicate source identity including hidden nodes', async () => {
    const h = await harness(backend(tree(undefined, undefined, node('source', '[0,250][40,290]'))));
    await assert.rejects(run(h, { ...action, selector: 'id=com.example:id/source#1', id: undefined }));
    assert.equal(rpc(h).length, 0);
});

for (const change of ['page', 'layout', 'expired']) test(`Drag rejects ${change} index endpoint credential`, async t => {
    const advance = clock(t);
    let captures = 0;
    const h = await harness({ uiServer: { ok: true, get xml() { return captures++ === 0 || change === 'expired' ? tree() : change === 'layout' ? tree('[10,0][50,40]') : tree().replace('text="source"', 'text="changed"'); } } });
    const observed = await h.service.processToolCall({ command: 'Observe' });
    if (change === 'expired') advance(15001);
    await assert.rejects(run(h, { command: 'Drag', id: action.id, target: { index: 1, snapshotId: observed.details.snapshotId } }), { code: 'STALE_SNAPSHOT' });
    assert.equal(rpc(h).length, 0);
});

for (const mode of ['not-dispatched', 'timeout', 'disconnect', 'false']) test(`Drag ${mode} never retries or falls back`, async () => {
    const h = await harness(backend(tree(), { invoke() {
        if (mode === 'false') return false;
        throw Object.assign(new Error('private transport body'), { code: mode === 'timeout' ? 'UI_SERVER_TIMEOUT' : 'UI_SERVER_RPC_ERROR', dispatched: mode !== 'not-dispatched' });
    } }));
    await assert.rejects(run(h), error => failure(error, mode === 'not-dispatched' ? 'not-dispatched' : 'unknown', mode === 'not-dispatched' ? 'failed' : 'unknown'));
    assert.equal(rpc(h).length, 1);
    assert.equal(inputs(h).length, 0);
});

test('Drag unavailable RPC is failed and does not attempt shell', async () => {
    const h = await harness({ dump: () => tree() });
    await assert.rejects(run(h), error => failure(error, 'not-dispatched', 'failed'));
    assert.equal(rpc(h).length, 0);
    assert.equal(inputs(h).length, 0);
});

for (const boundary of ['cancel', 'timeout']) test(`Drag in-flight ${boundary} retains lease, shared budget and no premature verification`, async t => {
    const advance = clock(t);
    const controller = new AbortController();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness(backend(tree(), { invoke() { return gate; } }));
    const work = settle(run(h, action, { timeoutMs: 100, expect: { type: 'visible', selector: 'text=end' } }, { signal: controller.signal }));
    await tick();
    assert.equal(rpc(h).length, 1);
    assert.equal(rpc(h)[0][3].timeoutMs, 100);
    assert.equal(h.uiServer.dumped, 2, '目标与policy gate完成，RPC未确认之前不得验证');
    if (boundary === 'cancel') controller.abort(); else advance(100);
    const { error } = await work;
    assert.equal(error.code, boundary === 'cancel' ? 'STEP_ABORTED' : 'STEP_DEADLINE');
    failure(error, 'invoking');
    assert.equal(rpc(h)[0][3].signal.aborted, true);
    await assert.rejects(h.service.processToolCall({ command: 'Observe' }), { code: 'DEVICE_BUSY' });
    release(true);
    await tick();
    assert.equal(rpc(h).length, 1);
    assert.equal(inputs(h).length, 0);
    assert.equal(h.uiServer.dumped, 2, '取消后没有额外验证采样');
    await h.service.processToolCall({ command: 'Observe' });
});

test('Drag outer expect verifies only its condition after the one gesture ACK', async () => {
    const h = await harness(backend());
    const result = await run(h, action, { expect: { type: 'visible', selector: 'text=end' }, afterObserve: true });
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(result.details.execution.verification.condition.selector, 'text=end');
    assert.equal(rpc(h).length, 1);
    assert.equal(h.uiServer.dumped, 3, '共享目标采样、policy gate与ACK后验证各一次');
});

for (const boundary of ['expired', 'size', 'device']) test(`Drag pixel endpoint rejects ${boundary} frame credentials`, async t => {
    const advance = clock(t);
    const h = await harness(backend());
    const shot = await h.service.processToolCall({ command: 'Observe', mode: 'image' });
    if (boundary === 'expired') advance(15001);
    if (boundary === 'size') {
        h.client.screenSize = async () => ({ width: 200, height: 400 });
        const probe = h.client.probeScreen.bind(h.client);
        h.client.probeScreen = async (...args) => ({ ...await probe(...args), size: { width: 200, height: 400 } });
    }
    await assert.rejects(run(h, { command: 'Drag', id: action.id, x2: 1, y2: 1, frameId: shot.details.frameId }, boundary === 'device' ? { serial: 'B' } : {}), { code: 'STALE_FRAME' });
    assert.equal(rpc(h).length, 0);
    assert.equal(inputs(h).length, 0);
});

for (const boundary of ['cancel', 'timeout']) test(`Drag ${boundary} during shared target preparation performs no gesture`, async t => {
    const advance = clock(t);
    const controller = new AbortController();
    const h = await harness({ uiServer: { ok: true, get xml() {
        if (boundary === 'cancel') controller.abort(); else advance(100);
        return tree();
    } } });
    await assert.rejects(run(h, action, { timeoutMs: 100 }, { signal: controller.signal }), error => {
        assert.equal(error.code, boundary === 'cancel' ? 'STEP_ABORTED' : 'STEP_DEADLINE');
        assert.equal(error.execution.outcome, 'failed');
        assert.equal(error.details.experimental, true);
        return true;
    });
    await tick();
    assert.equal(rpc(h).length, 0);
    assert.equal(inputs(h).length, 0);
});

test('Drag destination center stays inside ancestor scroll viewport, not merely inside the screen', async () => {
    const xml = `<hierarchy rotation="0">${node('source', '[0,0][40,40]')}<node class="android.widget.ScrollView" package="com.example" resource-id="com.example:id/list" scrollable="true" bounds="[40,150][100,180]">${node('end', '[60,80][100,200]')}</node></hierarchy>`;
    const h = await harness(backend(xml));
    await run(h);
    const [, , params] = rpc(h)[0];
    assert.ok(params[1] >= 60 && params[1] < 100);
    assert.ok(params[2] >= 150 && params[2] < 180, `endpoint y=${params[2]} must be within clipped scroll viewport`);
});
