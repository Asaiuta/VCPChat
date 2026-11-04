'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = work => work.then(value => ({ value }), error => ({ error }));
const rpc = h => h.calls.filter(call => call[0] === 'rpc');
const inputs = h => h.calls.filter(call => call[0] === 'adb' && call[1].includes('input'));
const modelText = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const node = (id = 'map', bounds = '[0,0][100,200]', extra = '') => `<node class="android.view.View" package="com.example" resource-id="${id ? `com.example:id/${id}` : ''}" text="Map" bounds="${bounds}" ${extra}/>`;
const tree = (...nodes) => `<hierarchy>${nodes.length ? nodes.join('') : node()}</hierarchy>`;
const action = { command: 'Pinch', id: 'com.example:id/map', direction: 'in', percent: 50 };
const run = (h, value = action, args = {}, context) => h.service.processToolCall({ command: 'ExecuteStep', action: value, ...args }, context);
const backend = (xml = tree(), extra = {}) => ({ uiServer: { ok: true, xml, ...extra } });

function clock(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    return ms => t.mock.timers.tick(ms);
}

for (const direction of ['in', 'out']) test(`Pinch ${direction} uses a non-clickable visible view and raw class/package/id selector`, async () => {
    const h = await harness(backend());
    const result = await run(h, { ...action, direction });
    assert.equal(rpc(h).length, 1);
    const [, method, params] = rpc(h)[0];
    assert.equal(method, direction === 'in' ? 'pinchIn' : 'pinchOut');
    assert.equal(params.length, 3);
    assert.equal(params[0].className, 'android.view.View');
    assert.equal(params[0].packageName, 'com.example');
    assert.equal(params[0].resourceId, 'com.example:id/map');
    assert.deepEqual(Array.from(params).slice(1), [50, 60]);
    assert.equal(h.uiServer.dumped, 1);
    assert.equal(inputs(h).length, 0);
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(result.details.execution.verification, null);
    assert.equal(result.details.experimental, true);
    assert.match(modelText(result), /"experimental":true/);
});

for (const [value, expectedPercent, expectedSteps] of [
    [{ percent: 1, steps: 1 }, 1, 1],
    [{ percent: 100, steps: 2000 }, 100, 2000],
    [{ percent: '50', duration: 1 }, 50, 1],
    [{ percent: 100, duration: 10000 }, 100, 2000],
]) test(`Pinch accepts inclusive parameter boundary ${JSON.stringify(value)}`, async () => {
    const h = await harness(backend());
    const result = await run(h, { ...action, ...value });
    assert.deepEqual(Array.from(rpc(h)[0][2]).slice(1), [expectedPercent, expectedSteps]);
    assert.equal(result.details.durationMs, expectedSteps * 5);
    assert.equal(rpc(h)[0][3].timeoutMs, Math.max(4000, expectedSteps * 5 + 1000));
});

for (const [name, value] of [
    ['no target', { ...action, id: undefined }],
    ['coordinates instead of node', { ...action, id: undefined, x: 10, y: 20 }],
    ['mixed node and pixels', { ...action, x: 10, y: 20 }],
    ['nested target', { ...action, target: { id: action.id } }],
    ['end coordinate', { ...action, x2: 10 }],
    ['missing percent', { ...action, percent: undefined }],
    ['zero percent', { ...action, percent: 0 }],
    ['over percent', { ...action, percent: 101 }],
    ['negative percent', { ...action, percent: -1 }],
    ['fraction percent', { ...action, percent: 0.5 }],
    ['boolean percent', { ...action, percent: true }],
    ['array percent', { ...action, percent: [50] }],
    ['infinite percent', { ...action, percent: Infinity }],
    ['NaN percent', { ...action, percent: NaN }],
    ['exponent percent', { ...action, percent: '1e2' }],
    ['hex percent', { ...action, percent: '0x10' }],
    ['missing direction', { ...action, direction: undefined }],
    ['bad direction', { ...action, direction: 'open' }],
    ['zero steps', { ...action, steps: 0 }],
    ['over steps', { ...action, steps: 2001 }],
    ['float steps', { ...action, steps: 1.1 }],
    ['string float steps', { ...action, steps: '1.0' }],
    ['array steps', { ...action, steps: [60] }],
    ['null steps', { ...action, steps: null }],
    ['zero duration', { ...action, duration: 0 }],
    ['over duration', { ...action, duration: 10001 }],
    ['two clocks', { ...action, duration: 300, steps: 60 }],
    ['index without credential', { ...action, id: undefined, index: 0 }],
    ['empty id', { ...action, id: '' }],
    ['conflicting node modes', { ...action, text: 'Map' }],
    ['custom four pointer shape', { ...action, p1: [0, 0], p2: [1, 1], p3: [2, 2], p4: [3, 3] }],
    ['gesture selector override', { ...action, gesture: {} }],
]) test(`Pinch rejects ${name} before read/dispatch`, async () => {
    const h = await harness(backend());
    await assert.rejects(run(h, value), { code: 'INVALID_ARGUMENT' });
    assert.equal(h.uiServer.dumped, 0);
    assert.equal(rpc(h).length, 0);
    assert.equal(inputs(h).length, 0);
});

for (const [name, xml] of [
    ['disabled', tree(node('map', undefined, 'enabled="false"'))],
    ['fully offscreen', tree(node('map', '[0,200][100,300]'))],
    ['zero-area', tree(node('map', '[10,10][10,20]'))],
    ['hidden visibility', tree(node('map', undefined, 'visible-to-user="false"'))],
]) test(`Pinch refuses ${name} target`, async () => {
    const h = await harness(backend(xml));
    await assert.rejects(run(h));
    assert.equal(rpc(h).length, 0);
});

test('Pinch allows partially visible target through the visible raw node identity', async () => {
    const h = await harness(backend(tree(node('map', '[-100,-100][50,50]'))));
    await run(h);
    assert.equal(rpc(h).length, 1);
});

for (const duplicate of [
    node('map', '[0,0][100,200]'),
    node('map', '[0,300][100,500]'),
    node('map', '[0,0][100,200]', 'enabled="false"'),
    node('map', '[0,0][100,200]', 'visible-to-user="false"'),
]) test(`Pinch rejects duplicate identity even outside the visible filtered tree: ${duplicate}`, async () => {
    const h = await harness(backend(tree(node(), duplicate)));
    await assert.rejects(run(h, { ...action, id: undefined, selector: 'id=com.example:id/map#1' }));
    assert.equal(rpc(h).length, 0, '不得用instance=0掩盖原始身份不唯一');
});

test('Pinch no-id target is usable only when its class/package identity is unique', async () => {
    const h = await harness(backend(tree(node(''))));
    await run(h, { ...action, id: undefined, selector: 'text=Map' });
    const selector = rpc(h)[0][2][0];
    assert.equal(selector.className, 'android.view.View');
    assert.equal(selector.packageName, 'com.example');
    assert.equal(selector.resourceId, undefined);
    const g = await harness(backend(tree(node(''), node('', '[0,300][100,500]'))));
    await assert.rejects(run(g, { ...action, id: undefined, selector: 'text=Map#1' }));
    assert.equal(rpc(g).length, 0);
});

test('Pinch same resourceId on a different raw class is not the selected identity', async () => {
    const other = node('map').replace('android.view.View', 'android.widget.Button');
    const h = await harness(backend(tree(node(), other)));
    await run(h, { ...action, id: undefined, selector: 'id=com.example:id/map#1' });
    assert.equal(rpc(h)[0][2][0].className, 'android.view.View');
});

test('Pinch index snapshot is rechecked against live layout and consumed on dispatch', async () => {
    const h = await harness(backend(tree(node('map', undefined, 'clickable="true"'))));
    const observed = await h.service.processToolCall({ command: 'Observe' });
    const value = { ...action, id: undefined, index: 0, snapshotId: observed.details.snapshotId };
    await run(h, value);
    await assert.rejects(run(h, value), { code: 'STALE_SNAPSHOT' });
    assert.equal(rpc(h).length, 1);
});

for (const changed of ['layout', 'expired']) test(`Pinch rejects ${changed} snapshot before input`, async t => {
    const advance = clock(t);
    let captures = 0;
    const h = await harness({ uiServer: { ok: true, get xml() { return tree(node('map', captures++ > 0 && changed === 'layout' ? '[0,20][100,180]' : '[0,0][100,200]', 'clickable="true"')); } } });
    const observed = await h.service.processToolCall({ command: 'Observe' });
    if (changed === 'expired') advance(15001);
    await assert.rejects(run(h, { ...action, id: undefined, index: 0, snapshotId: observed.details.snapshotId }), { code: 'STALE_SNAPSHOT' });
    assert.equal(rpc(h).length, 0);
});

for (const mode of ['not-dispatched', 'timeout', 'disconnect', 'false']) test(`Pinch ${mode} keeps experimental failure receipt and never replays`, async () => {
    const h = await harness(backend(tree(), { invoke() {
        if (mode === 'false') return false;
        throw Object.assign(new Error('private transport body'), { code: mode === 'timeout' ? 'UI_SERVER_TIMEOUT' : 'UI_SERVER_RPC_ERROR', dispatched: mode !== 'not-dispatched' });
    } }));
    await assert.rejects(run(h), error => {
        assert.equal(error.execution.outcome, mode === 'not-dispatched' ? 'failed' : 'unknown');
        assert.equal(error.execution.retryable, false);
        assert.equal(error.details.experimental, true);
        assert.match(error.message, /"experimental":true/);
        assert.doesNotMatch(error.message, /private transport body/);
        assert.deepEqual(Array.from(error.details.attempts, item => item.status), [mode === 'not-dispatched' ? 'not-dispatched' : 'unknown']);
        return true;
    });
    assert.equal(rpc(h).length, 1);
    assert.equal(inputs(h).length, 0);
});

for (const boundary of ['cancel', 'timeout']) test(`Pinch ${boundary} keeps one budget/signal/lease and never verifies before ACK`, async t => {
    const advance = clock(t);
    const controller = new AbortController();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness(backend(tree(), { invoke() { return gate; } }));
    const work = settle(run(h, action, { timeoutMs: 100, expect: { type: 'visible', selector: 'text=Map' } }, { signal: controller.signal }));
    await tick();
    assert.equal(rpc(h).length, 1);
    assert.equal(rpc(h)[0][3].timeoutMs, 100);
    assert.equal(h.uiServer.dumped, 1);
    if (boundary === 'cancel') controller.abort(); else advance(100);
    const { error } = await work;
    assert.equal(error.code, boundary === 'cancel' ? 'STEP_ABORTED' : 'STEP_DEADLINE');
    assert.equal(error.execution.outcome, 'unknown');
    assert.equal(error.execution.verification, null);
    assert.equal(error.details.experimental, true);
    assert.equal(rpc(h)[0][3].signal.aborted, true);
    await assert.rejects(h.service.processToolCall({ command: 'Observe' }), { code: 'DEVICE_BUSY' });
    release(true);
    await tick();
    assert.equal(rpc(h).length, 1);
    assert.equal(h.uiServer.dumped, 1);
    assert.equal(inputs(h).length, 0);
    await h.service.processToolCall({ command: 'Observe' });
});

test('Pinch shared budget includes preparation time rather than starting a new RPC budget', async t => {
    const advance = clock(t);
    const h = await harness({ uiServer: { ok: true, get xml() { advance(40); return tree(); } } });
    await run(h, action, { timeoutMs: 100 });
    assert.equal(rpc(h)[0][3].timeoutMs, 60);
});

test('Pinch cancellation before prepare performs no reads or writes', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = await harness(backend());
    await assert.rejects(run(h, action, {}, { signal: controller.signal }), { code: 'STEP_ABORTED' });
    assert.equal(h.calls.length, 0);
});

test('Pinch is verified only by an explicit post-ACK expect, not by true RPC response', async () => {
    const h = await harness(backend());
    const result = await run(h, action, { expect: { type: 'visible', selector: 'text=Map' } });
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(result.details.execution.verification.condition.selector, 'text=Map');
    assert.equal(h.uiServer.dumped, 2);
    assert.equal(rpc(h).length, 1);
});

for (const attribute of ['class', 'package']) test(`Pinch refuses raw identity missing ${attribute} before RPC`, async () => {
    const xml = tree(node()).replace(new RegExp(` ${attribute}="[^"]*"`), '');
    const h = await harness(backend(xml));
    await assert.rejects(run(h));
    assert.equal(rpc(h).length, 0);
});

test('Pinch RPC unavailable never falls back to shell or a custom gesture', async () => {
    const h = await harness({ dump: () => tree() });
    await assert.rejects(run(h), error => {
        assert.equal(error.execution.outcome, 'failed');
        assert.equal(error.details.experimental, true);
        assert.deepEqual(Array.from(error.details.attempts, item => item.status), ['not-dispatched']);
        return true;
    });
    assert.equal(rpc(h).length, 0);
    assert.equal(inputs(h).length, 0);
});
