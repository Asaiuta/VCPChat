'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForIdle } = require('../VCPDistributedServer/Plugin/AndroidController/lib/idle-wait');
const rpc = require('../VCPDistributedServer/Plugin/AndroidController/lib/rpc-methods');
const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
const stepRuntime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');

const TIMEOUT = { matched: false, idleMode: null, error: 'IDLE_TIMEOUT' };
const STABLE = { matched: true, idleMode: 'layout_stable' };
const context = { width: 1080, height: 1920, rotation: 0, package: 'com.example', window: 'com.example/.Main' };
const frame = (digest = 'full-layout', extra = {}) => ({ digest, context: { ...context }, complete: true, ...extra });
const fault = (code, details = {}, message = code) => Object.assign(new Error(message), { code, ...details });

function clock(totalMs = Infinity) {
    let time = 10000;
    const deadline = time + totalMs;
    const controller = new AbortController();
    const pauses = [];
    const runtime = {
        now: () => time,
        executionSignal: () => controller.signal,
        check() {
            if (controller.signal.aborted) throw fault('STEP_ABORTED');
            if (time >= deadline) throw fault('STEP_DEADLINE');
        },
        remainingMs() { this.check(); return deadline - time; },
        async pause(ms) {
            this.check();
            assert.ok(Number.isInteger(ms) && ms > 0);
            pauses.push(ms);
            time += ms;
            this.onPause?.();
            this.check();
        },
        markDispatched() { assert.fail('idle wait must not dispatch input'); },
        inputReceipt() { assert.fail('idle wait must not write input receipts'); },
        verified() { assert.fail('idle module must not change execution outcome'); },
    };
    return { runtime, pauses, controller, advance(ms) { time += ms; }, now: () => time };
}

function sampler(frames, c, consumeMs = 0) {
    const requests = [];
    async function sample(request) {
        requests.push(request);
        assert.equal(request.signal, c.controller.signal);
        assert.equal(request.deadlineMs, c.now() + request.timeoutMs);
        c.advance(consumeMs);
        const value = frames[Math.min(requests.length - 1, frames.length - 1)];
        return typeof value === 'function' ? value() : value;
    }
    return { sample, requests };
}

for (const nativeResult of [undefined, null, true, false]) {
    test(`native ${String(nativeResult)} is only a hint; two layout frames still required`, async () => {
        const c = clock();
        const s = sampler([frame()], c);
        let nativeCalls = 0;
        const result = await waitForIdle({ runtime: c.runtime, sample: s.sample, nativeIdle: async request => {
            nativeCalls++;
            assert.equal(request.timeoutMs, 1500);
            assert.equal(request.deadlineMs, c.now() + 1750);
            assert.equal(request.signal, c.controller.signal);
            c.advance(1500);
            return nativeResult;
        } });
        assert.deepEqual(result, STABLE);
        assert.equal(nativeCalls, 1);
        assert.equal(s.requests.length, 2);
        assert.deepEqual(c.pauses, [200]);
        assert.equal(s.requests[0].timeoutMs, 3500);
        assert.equal(s.requests[0].deadlineMs, 15000);
    });
}

test('native void cannot wash a continuously changing layout green', async () => {
    const c = clock();
    let index = 0;
    const result = await waitForIdle({ runtime: c.runtime, timeoutMs: 700, nativeIdle: async () => {}, sample: async () => frame(`state-${index++}`) });
    assert.deepEqual(result, TIMEOUT);
    assert.equal(index, 4);
    assert.equal(c.now(), 10700);
});

test('fallback without native requires consecutive complete frames separated by 200ms', async () => {
    const c = clock();
    const s = sampler([frame('A'), frame('B'), frame('B')], c, 20);
    assert.deepEqual(await waitForIdle({ runtime: c.runtime, sample: s.sample, timeoutMs: 1000 }), STABLE);
    assert.equal(s.requests.length, 3);
    assert.deepEqual(c.pauses, [200, 200]);
    assert.deepEqual(s.requests.map(r => r.deadlineMs), [11000, 11000, 11000]);
    assert.deepEqual(s.requests.map(r => r.timeoutMs), [1000, 780, 560]);
});

for (const error of [
    fault('UI_SERVER_RPC_ERROR', { rpcCode: -32601, dispatched: false }),
    fault('UI_SERVER_NOT_READY', { dispatched: false }),
    fault('UI_SERVER_RPC_ERROR', { rpcCode: -32000, dispatched: true }, 'RPC waitForIdle 报错：Idle timeout'),
    fault('UI_SERVER_RPC_ERROR', { rpcCode: -32000 }, 'java.util.concurrent.TimeoutException'),
]) {
    test(`settled ${error.code}/${error.rpcCode || error.message} may fall back exactly once`, async () => {
        const c = clock();
        const s = sampler([frame()], c);
        let nativeCalls = 0;
        const result = await waitForIdle({ runtime: c.runtime, sample: s.sample, nativeIdle: async () => { nativeCalls++; throw error; } });
        assert.deepEqual(result, STABLE);
        assert.equal(nativeCalls, 1);
        assert.equal(s.requests.length, 2);
    });
}

for (const error of [
    fault('UI_SERVER_TIMEOUT', { dispatched: true }),
    fault('UI_SERVER_TIMEOUT', { dispatched: false }),
    fault('UI_SERVER_RPC_FAILED', { dispatched: true }, 'connection reset'),
    fault('UI_SERVER_ABORTED'),
    fault('STEP_ABORTED'),
    fault('STEP_DEADLINE'),
    fault('UI_SERVER_HTTP_ERROR'),
    fault('UI_SERVER_BAD_RESPONSE'),
    fault('UI_SERVER_RPC_ERROR', { rpcCode: -32602, dispatched: false }),
    fault('UI_SERVER_RPC_ERROR', { rpcCode: -32000 }, 'unknown automation failure'),
    fault('UI_SERVER_RPC_ERROR', { rpcCode: -32601, inFlight: true }),
    fault('UI_SERVER_RPC_ERROR', { rpcCode: -32601, drained: false }),
    fault('UI_SERVER_NOT_READY', { dispatched: true }),
    new Error('Idle timeout without a completed RPC response'),
]) {
    test(`unsafe ${error.code || 'unknown'}/${error.message} never launches a fallback RPC`, async () => {
        const c = clock();
        let samples = 0;
        await assert.rejects(waitForIdle({ runtime: c.runtime, nativeIdle: async () => { throw error; }, sample: async () => { samples++; return frame(); } }), e => e === error);
        assert.equal(samples, 0);
    });
}

test('native call has bounded transport headroom and leaves fallback budget', async () => {
    const c = clock();
    const s = sampler([frame()], c);
    await waitForIdle({ runtime: c.runtime, timeoutMs: 1000, sample: s.sample, nativeIdle: async request => {
        assert.equal(request.timeoutMs, 450);
        assert.equal(request.deadlineMs, 10600);
        c.advance(599);
        return false;
    } });
    assert.equal(s.requests[0].timeoutMs, 401);
    assert.equal(s.requests[1].timeoutMs, 201);
    assert.equal(s.requests[1].deadlineMs, 11000);
});

test('late native completion is transport timeout, not permission to send another RPC', async () => {
    const c = clock();
    let samples = 0;
    await assert.rejects(waitForIdle({ runtime: c.runtime, timeoutMs: 1000, nativeIdle: async request => {
        c.advance(request.deadlineMs - c.now());
    }, sample: async () => { samples++; return frame(); } }), { code: 'UI_SERVER_TIMEOUT' });
    assert.equal(samples, 0);
});

test('tiny budget skips native, and ordinary wait exhaustion is IDLE_TIMEOUT', async () => {
    const c = clock();
    const s = sampler([frame()], c);
    let nativeCalls = 0;
    assert.deepEqual(await waitForIdle({ runtime: c.runtime, timeoutMs: 1, sample: s.sample, nativeIdle: async () => { nativeCalls++; } }), TIMEOUT);
    assert.equal(nativeCalls, 0);
    assert.equal(s.requests.length, 1);
    assert.deepEqual(c.pauses, [1]);
});

test('a second identical frame at the deadline cannot succeed', async () => {
    const c = clock();
    const s = sampler([frame()], c, 10);
    assert.deepEqual(await waitForIdle({ runtime: c.runtime, timeoutMs: 220, sample: s.sample }), TIMEOUT);
    assert.equal(s.requests.length, 2);
    assert.equal(c.now(), 10220);
});

for (const changed of [
    { package: 'com.other' }, { window: 'com.example/.Dialog' }, { width: 1920, height: 1080 }, { rotation: 1 },
]) {
    test(`context change ${Object.keys(changed).join('/')} stops immediately without rebaselining`, async () => {
        const c = clock();
        const s = sampler([frame(), frame('full-layout', { context: { ...context, ...changed } }), frame('full-layout', { context: { ...context, ...changed } })], c);
        assert.deepEqual(await waitForIdle({ runtime: c.runtime, timeoutMs: 1000, sample: s.sample }), TIMEOUT);
        assert.equal(s.requests.length, 2);
        assert.equal(c.now(), 10200);
    });
}

test('context from incomplete first frame remains binding; later context cannot wash green', async () => {
    const c = clock();
    const s = sampler([frame('', { complete: false }), frame('full-layout', { context: { ...context, package: 'com.other' } })], c);
    assert.deepEqual(await waitForIdle({ runtime: c.runtime, sample: s.sample }), TIMEOUT);
    assert.equal(s.requests.length, 2);
});

test('equal contexts ignore key insertion order and are captured by value', async () => {
    const c = clock();
    const reverse = Object.fromEntries(Object.entries(context).reverse());
    const s = sampler([frame(), frame('full-layout', { context: reverse })], c);
    assert.deepEqual(await waitForIdle({ runtime: c.runtime, sample: s.sample }), STABLE);
    const c2 = clock();
    const shared = { ...context };
    let calls = 0;
    assert.deepEqual(await waitForIdle({ runtime: c2.runtime, sample: async () => {
        if (++calls === 2) shared.window = 'different';
        return frame('full-layout', { context: shared });
    } }), TIMEOUT);
    assert.equal(calls, 2);
});

for (const invalid of [
    undefined, null, frame('', {}), frame('full-layout', { complete: false }),
    frame('full-layout', { complete: undefined }), frame('full-layout', { context: null }),
    frame('full-layout', { context: {} }), frame('full-layout', { context: '' }),
    frame('full-layout', { context: { width: NaN } }),
]) {
    test(`empty, locked/incomplete or uncertified sample cannot establish stability: ${JSON.stringify(invalid)}`, async () => {
        const c = clock();
        const s = sampler([invalid], c);
        assert.deepEqual(await waitForIdle({ runtime: c.runtime, sample: s.sample, timeoutMs: 401 }), TIMEOUT);
        assert.equal(c.now(), 10401);
    });
}

test('an incomplete middle frame breaks consecutive stability', async () => {
    const c = clock();
    const s = sampler([frame(), frame('', { complete: false }), frame(), frame()], c);
    assert.deepEqual(await waitForIdle({ runtime: c.runtime, sample: s.sample }), STABLE);
    assert.equal(s.requests.length, 4);
});

test('entire opaque digest is compared, including state beyond node forty', async () => {
    const c = clock();
    const nodes = Array.from({ length: 100 }, (_, index) => ({ class: 'Button', package: 'com.example', resourceId: `id/${index}`, bounds: [0, index, 100, index + 1], visible: true, enabled: true, checked: false }));
    const first = JSON.stringify(nodes);
    nodes[99].checked = true;
    const changed = JSON.stringify(nodes);
    const s = sampler([frame(first), frame(changed), frame(changed)], c);
    assert.deepEqual(await waitForIdle({ runtime: c.runtime, sample: s.sample }), STABLE);
    assert.equal(s.requests.length, 3);
});

test('sampler owns text-insensitive digest and complete raw-tree certification', async () => {
    const c = clock();
    const s = sampler([frame('text-independent-digest', { text: 'clock 1' }), frame('text-independent-digest', { text: 'clock 2' })], c);
    assert.deepEqual(await waitForIdle({ runtime: c.runtime, sample: s.sample }), STABLE);
});

test('cancelled before native produces no request', async () => {
    const c = clock();
    c.controller.abort();
    let calls = 0;
    await assert.rejects(waitForIdle({ runtime: c.runtime, sample: async () => { calls++; }, nativeIdle: async () => { calls++; } }), { code: 'STEP_ABORTED' });
    assert.equal(calls, 0);
});

for (const phase of ['native', 'sample', 'pause']) {
    test(`cancellation during ${phase} throws and prevents further RPCs`, async () => {
        const c = clock();
        let samples = 0;
        if (phase === 'pause') c.runtime.onPause = () => c.controller.abort();
        await assert.rejects(waitForIdle({ runtime: c.runtime,
            nativeIdle: async () => { if (phase === 'native') c.controller.abort(); return false; },
            sample: async () => { samples++; if (phase === 'sample') c.controller.abort(); return frame(); },
        }), { code: 'STEP_ABORTED' });
        assert.equal(samples, phase === 'native' ? 0 : 1);
    });
}

test('total runtime deadline overrides ordinary wait timeout and bounds sampler deadline', async () => {
    const c = clock(100);
    const s = sampler([frame()], c);
    await assert.rejects(waitForIdle({ runtime: c.runtime, sample: s.sample, timeoutMs: 5000 }), { code: 'STEP_DEADLINE' });
    assert.equal(s.requests[0].deadlineMs, 10100);
    assert.equal(s.requests[0].timeoutMs, 100);
    assert.equal(s.requests.length, 1);
});

test('sample transport error propagates unchanged without retrying', async () => {
    const c = clock();
    const error = fault('UI_SERVER_RPC_FAILED');
    let calls = 0;
    await assert.rejects(waitForIdle({ runtime: c.runtime, sample: async () => { calls++; throw error; } }), e => e === error);
    assert.equal(calls, 1);
});

test('real step-runtime cancellation remains failed/read-only and not dispatched', async () => {
    const controller = new AbortController();
    await assert.rejects(stepRuntime.run({ serial: 'idle-cancel-unit', signal: controller.signal, timeoutMs: 1000 }, async () => {
        await waitForIdle({ runtime: stepRuntime, sample: async () => { controller.abort(); return frame(); } });
        return {};
    }), error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'failed');
});

test('RPC waitForIdle is one-argument read-only experimental and validates numeric integer 1..2000', async () => {
    assert.deepEqual(rpc.entry('waitForIdle'), { arity: [1], write: false, experimental: true });
    for (const timeout of [1, 1500, 2000]) assert.equal(rpc.validate('waitForIdle', [timeout]).ok, true);
    const client = new UiServer();
    client.transport.ready = true;
    client.transport.port = 1;
    let httpRequests = 0;
    client._rpc = async () => { httpRequests++; return null; };
    for (const params of [[], [1, 2], ['100'], [0], [-1], [2001], [1.1], [NaN], [Infinity], [true], [null], [undefined], [1n]]) {
        assert.equal(rpc.validate('waitForIdle', params).ok, false);
        await assert.rejects(client.invoke('waitForIdle', params), error => error.code === 'UI_SERVER_INVALID_ARGUMENT' && error.dispatched === false);
    }
    assert.equal(httpRequests, 0);
    assert.equal(await client.invoke('waitForIdle', [2000]), null);
    assert.equal(httpRequests, 1);
});

test('invalid module arguments are rejected before any request', async () => {
    const c = clock();
    const base = { runtime: c.runtime, sample: async () => frame() };
    for (const value of [undefined, {}, { ...base, sample: null }, { ...base, runtime: {} }, { ...base, nativeIdle: true }, ...[0, -1, 1.5, '5000', NaN, Infinity].map(timeoutMs => ({ ...base, timeoutMs }))]) {
        await assert.rejects(waitForIdle(value), TypeError);
    }
});
