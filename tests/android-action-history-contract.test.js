'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const history = require('../VCPDistributedServer/Plugin/AndroidController/lib/action-history');
const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
const { harness } = require('./helpers/android-service-harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const metadata = (extra = {}) => ({ serial: 'A', requestId: randomUUID(), command: 'tap', outcome: 'dispatched', durationMs: 1, ...extra });
const read = (serial = 'A', limit = 100) => history.query({ serial, limit }).entries;
const result = () => ({ details: {}, content: [] });
const manage = (h, extra = {}) => h.service.processToolCall({ command: 'Manage', operation: 'actionHistory', serial: 'A', ...extra });

test.beforeEach(() => history.clear());

test('history bounds both entries and devices, reads do not refresh eviction recency', () => {
    for (let i = 0; i < 105; i++) history.record(metadata({ durationMs: i }));
    assert.equal(read().length, 100);
    assert.equal(read()[0].durationMs, 104);
    assert.equal(read().at(-1).durationMs, 5);
    for (let i = 1; i < history.MAX_DEVICES; i++) history.record(metadata({ serial: `D${i}` }));
    read('A');
    history.record(metadata({ serial: 'last' }));
    assert.deepEqual(read('A'), []);
    assert.equal(read('D1').length, 1);
    assert.equal(read('last').length, 1);
});

test('projection saves only fixed primitive metadata and queries return detached copies', () => {
    const secret = 'SECRET_TEXT_SELECTOR_ID_URL_COORDINATES_MESSAGE_EXPECT';
    const attempt = { channel: 'rpc', method: 'click', status: 'dispatched', code: 'UI_SERVER_TIMEOUT', text: secret, selector: secret, params: [secret] };
    const source = metadata({ text: secret, id: secret, url: secret, x: secret, expect: { selector: secret }, error: new Error(secret), receipt: { attempts: [attempt], text: secret } });
    assert.equal(history.record(source), true);
    source.command = 'fill'; attempt.method = 'setText'; attempt.params.push(secret);
    const entry = read()[0];
    assert.deepEqual(Object.keys(entry).sort(), ['requestId', 'command', 'outcome', 'durationMs', 'channel', 'method', 'status', 'code'].sort());
    assert.equal(entry.method, 'click');
    entry.command = secret;
    assert.equal(read()[0].command, 'tap');
    assert.doesNotMatch(JSON.stringify(history.query({ serial: 'A' })), /SECRET/);
});

test('unknown enum values and unbounded serial/request identifiers never enter storage', () => {
    const secret = 'SECRET';
    history.record(metadata({ receipt: { attempts: [{ channel: secret, method: secret, status: secret, code: secret }] }, code: secret }));
    assert.deepEqual(Object.keys(read()[0]).sort(), ['requestId', 'command', 'outcome', 'durationMs'].sort());
    for (const patch of [{ command: secret }, { outcome: secret }, { serial: `A\n${secret}` }, { serial: 'A'.repeat(129) }, { serial: '__auto__' }, { serial: {} }, { requestId: secret }, { durationMs: Infinity }, { durationMs: -1 }]) {
        assert.equal(history.record(metadata(patch)), false);
    }
    assert.equal(read().length, 1);
    let accessed = false;
    history.record(metadata({ receipt: { attempts: [{ get method() { accessed = true; return secret; } }] } }));
    assert.equal(accessed, false);
});

test('history query strictly rejects limit/serial shapes using fixed non-echoing errors', () => {
    for (const limit of [0, 101, -1, 1.5, '1', true, null, NaN, Infinity, {}, []]) {
        assert.throws(() => history.query({ serial: 'A', limit }), { code: 'INVALID_ARGUMENT' });
    }
    for (const serial of ['', null, {}, [], 'A\nSECRET', 'A'.repeat(129), 'http://SECRET', 'A SECRET']) {
        assert.throws(() => history.query({ serial }), error => error.code === 'INVALID_ARGUMENT' && !error.message.includes('SECRET'));
    }
    assert.throws(() => history.query({ serial: 'A', selector: 'SECRET' }), { code: 'INVALID_ARGUMENT' });
    assert.deepEqual(history.query({ serial: 'offline', limit: 1 }).entries, []);
});

test('implicit serial is resolved only from exactly one retained device', () => {
    assert.throws(() => history.query(), { code: 'INVALID_ARGUMENT' });
    history.record(metadata());
    assert.equal(history.query().serial, 'A');
    history.record(metadata({ serial: 'B' }));
    assert.throws(() => history.query(), { code: 'INVALID_ARGUMENT' });
    assert.equal(read('A').length, 1);
});

test('single runtime success records exactly once and accepts only explicit action names', async () => {
    const receipt = { attempts: [{ channel: 'rpc', method: 'click', status: 'dispatched' }], text: 'SECRET' };
    const value = await runtime.run({ serial: 'A', actionCommand: 'Tap' }, async () => {
        runtime.inputReceipt(receipt);
        runtime.markDispatched();
        runtime.verified(true, { condition: { selector: 'SECRET' }, evidence: { text: 'SECRET' } });
        return result();
    });
    assert.equal(read().length, 1);
    assert.equal(read()[0].requestId, value.details.execution.requestId);
    assert.equal(read()[0].outcome, 'verified');
    assert.equal(read()[0].method, 'click');
    assert.ok(read()[0].durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(read()), /SECRET/);
    await runtime.run({ serial: 'A' }, async () => { runtime.setActionCommand('Wait'); return result(); });
    assert.equal(read()[0].command, 'wait');
    await runtime.run({ serial: 'A', actionCommand: 'Tap SECRET' }, async () => result());
    assert.equal(read().length, 2);
});

test('runtime rejection saves safe failure metadata, never arbitrary error code/message', async () => {
    await assert.rejects(runtime.run({ serial: 'A', actionCommand: 'Fill' }, async () => {
        throw Object.assign(new Error('SECRET'), { code: 'SECRET', params: { text: 'SECRET' } });
    }));
    assert.equal(read().length, 1);
    assert.equal(read()[0].outcome, 'failed');
    assert.equal(read()[0].code, undefined);
    assert.doesNotMatch(JSON.stringify(read()), /SECRET/);
});

for (const mode of ['abort', 'deadline']) test(`runtime ${mode} snapshots once before drain and ignores late completion`, async () => {
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const work = runtime.run({ serial: 'A', actionCommand: 'Tap', signal: controller.signal, timeoutMs: mode === 'deadline' ? 30 : 1000 }, async () => {
        runtime.markDispatched(); entered(); await gate;
        runtime.inputReceipt({ attempts: [{ channel: 'rpc', method: 'setText', status: 'dispatched' }] });
        runtime.setActionCommand('Fill');
        return result();
    });
    await ready;
    if (mode === 'abort') controller.abort();
    try {
        await assert.rejects(work, { code: mode === 'abort' ? 'STEP_ABORTED' : 'STEP_DEADLINE' });
        const snapshot = read();
        assert.equal(snapshot.length, 1);
        assert.equal(snapshot[0].command, 'tap');
        assert.equal(snapshot[0].outcome, 'unknown');
        await assert.rejects(runtime.run({ serial: 'A', actionCommand: 'Tap' }, async () => result()), { code: 'DEVICE_BUSY' });
        assert.deepEqual(read(), snapshot);
    } finally { release(); }
    const saved = read();
    await tick();
    assert.deepEqual(read(), saved);
    await runtime.run({ serial: 'A', actionCommand: 'Wait' }, async () => result());
    assert.equal(read().length, 2);
});

test('sequence stores each terminal step once and preserves completed steps across cancellation', async () => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const work = runtime.run({ serial: 'A', signal: controller.signal }, async () => {
        runtime.beginSequence(3);
        runtime.beginItem('Fill');
        runtime.inputReceipt({ attempts: [{ channel: 'rpc', method: 'setText', status: 'dispatched' }] });
        runtime.markDispatched(); runtime.verified(true, { condition: { selector: 'SECRET' } }); runtime.finishItem(true);
        runtime.beginItem('Wait');
        entered(); await gate;
        runtime.verified(true, { condition: { selector: 'SECRET' } }); runtime.finishItem();
        runtime.beginItem('Tap');
        return result();
    });
    await ready;
    controller.abort();
    try {
        await assert.rejects(work, { code: 'STEP_ABORTED' });
        const entries = read().reverse();
        assert.equal(entries.length, 2);
        assert.equal(entries[0].command, 'fill');
        assert.equal(entries[0].outcome, 'verified');
        assert.equal(entries[1].command, 'wait');
        assert.equal(entries[1].outcome, 'failed');
        assert.equal(entries[1].method, undefined, 'beginItem must clear previous inputReceipt');
        assert.equal(entries[0].requestId, entries[1].requestId);
        assert.deepEqual(entries.map(item => item.stepIndex), [0, 1]);
        assert.doesNotMatch(JSON.stringify(entries), /SECRET/);
    } finally { release(); }
    const snapshot = read();
    await tick();
    assert.deepEqual(read(), snapshot);
});

test('successful sequence has exactly one row per step with individual outcomes', async () => {
    await runtime.run({ serial: 'A' }, async () => {
        runtime.beginSequence(2);
        runtime.beginItem('Tap'); runtime.markDispatched(); runtime.verified(true, {}); runtime.finishItem(true);
        runtime.beginItem('KeyEvent'); runtime.markDispatched(); runtime.finishItem();
        return result();
    });
    assert.deepEqual(read().reverse().map(({ command, outcome, stepIndex }) => ({ command, outcome, stepIndex })), [
        { command: 'tap', outcome: 'verified', stepIndex: 0 }, { command: 'keyevent', outcome: 'dispatched', stepIndex: 1 },
    ]);
});

test('Manage actionHistory is offline and pure even while another runtime owns the device lease', async () => {
    const h = await harness();
    history.record(metadata());
    h.client.devices = async () => { throw new Error('must not discover devices'); };
    const before = h.calls.length;
    const snapshot = JSON.stringify(read());
    await runtime.run({ serial: 'A' }, async () => {
        const value = await manage(h, { limit: 1 });
        assert.ok(JSON.stringify(value).includes('requestId'));
        assert.equal(h.calls.length, before);
        assert.equal(JSON.stringify(read()), snapshot);
        return result();
    });
    const offline = await manage(h, { serial: 'offline-device', limit: 1 });
    assert.ok(JSON.stringify(offline).includes('offline-device'));
    assert.equal(h.calls.length, before);
});

test('Service action history contains actual action outcomes and rejects raw parameters in query errors', async () => {
    const h = await harness();
    const value = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'KeyEvent', key: 'back' } });
    assert.equal(read().length, 1);
    assert.equal(read()[0].command, 'keyevent');
    assert.equal(read()[0].requestId, value.details.execution.requestId);
    const before = h.calls.length;
    for (const limit of [0, 101, '1', 1.5, null]) await assert.rejects(manage(h, { limit }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(manage(h, { serial: 'SECRET\nURL' }), error => error.code === 'INVALID_ARGUMENT' && !error.message.includes('SECRET'));
    assert.equal(h.calls.length, before);
});
