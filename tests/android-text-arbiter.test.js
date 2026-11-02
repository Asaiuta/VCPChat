'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { arbitrate } = require('../VCPDistributedServer/Plugin/AndroidController/lib/text-arbiter');
const evidence = () => ({ snapshotId: 'snap', observedAt: Date.now(), serial: 'A', controls: [
    { index: 0, label: 'Open first', cls: 'Button', value: 'PRIVATE', x: 10, y: 20 },
    { index: 1, label: 'Open second', cls: 'Button' },
], focus: { package: 'com.example' } });
const response = (key, probabilities) => ({ answers: { [key]: { type: 'choice', probabilities } }, usage: { cost: 0.01 } });
function fixture(result = response('target', { c0: 0.95, c1: 0.02, none: 0.03 })) {
    const calls = [];
    return { calls, jev: { async decide(...args) { calls.push(args); return typeof result === 'function' ? result(...args) : result; } } };
}
const target = (extra = {}) => ({ mode: 'target', goal: 'open the first item', candidates: [0, 1], ...extra });

test('a unique explicit candidate bypasses Jev; no candidate requests observation', async () => {
    const f = fixture();
    const one = await arbitrate(target({ candidates: [1] }), evidence(), f);
    assert.equal(one.source, 'rule'); assert.equal(one.candidateId, 'c1');
    const none = await arbitrate(target({ candidates: [] }), evidence(), f);
    assert.equal(none.route, 'reobserve'); assert.equal(f.calls.length, 0);
});
test('ambiguous candidates use the shared service once, return only a mapped ID and bounded text', async () => {
    const f = fixture();
    const result = await arbitrate(target(), evidence(), f);
    assert.equal(result.candidateId, 'c0'); assert.equal(result.source, 'jev');
    assert.equal(result.advisory, true); assert.equal(result.modelCalls, 1);
    assert.equal(result.usage.cost, 0.01); assert.equal(f.calls.length, 1);
    const [state, questions, options] = f.calls[0];
    assert.equal(questions.target.type, 'choice');
    assert.equal(options.maxRetries, 0); assert.ok(options.timeoutMs <= 2000);
    assert.equal(JSON.stringify(state).includes('PRIVATE'), false);
    assert.equal('x' in state.controls[0], false); assert.equal('y' in state.controls[0], false);
    assert.equal('assets' in state, false);
});
test('low confidence, tie, malformed or unknown candidate never yields a selected target', async () => {
    for (const probabilities of [{ c0: 0.5, c1: 0.49, none: 0.01 }, { c0: 1, evil: 0 }, { c0: '0.99', c1: 0, none: 0.01 }, { c0: 0.99 }, { c0: NaN, c1: 0, none: 0 }]) {
        const result = await arbitrate(target(), evidence(), fixture(response('target', probabilities)));
        assert.equal(result.candidateId, null); assert.equal(result.route, 'escalate');
    }
});
test('keyguard, incomplete evidence and changing page recovery are rule-only safe stops', async () => {
    const f = fixture();
    assert.equal((await arbitrate({ mode: 'recovery' }, { ...evidence(), keyguard: true }, f)).route, 'human');
    assert.equal((await arbitrate({ mode: 'recovery' }, { ...evidence(), stability: 'changing' }, f)).route, 'reobserve');
    assert.equal((await arbitrate(target(), { ...evidence(), truncated: true }, f)).route, 'reobserve');
    assert.equal(f.calls.length, 0);
});
test('page and recovery use distinct allowed choices, never a planning or action question', async () => {
    for (const [mode, probabilities, selected] of [
        ['page', { loading: 0.01, error: 0.01, permission: 0.95, target: 0.01, unknown: 0.02 }, 'permission'],
        ['recovery', { reobserve: 0.02, escalate: 0.96, human: 0.02 }, 'escalate'],
    ]) {
        const f = fixture(response(mode, probabilities));
        const result = await arbitrate({ mode, goal: 'details page' }, evidence(), f);
        assert.equal(result.decision, selected); assert.equal(result.candidateId, null);
        assert.deepEqual(Object.keys(f.calls[0][1]), [mode]);
    }
});
test('an explicit visible target condition bypasses page Jev inference', async () => {
    const f = fixture();
    const result = await arbitrate({ mode: 'page', goal: 'details', targetVisible: true }, evidence(), f);
    assert.equal(result.decision, 'target'); assert.equal(f.calls.length, 0);
});
test('expired or invalid evidence fails before model transmission', async () => {
    const f = fixture();
    for (const changes of [{ observedAt: Date.now() - 16000 }, { snapshotId: '' }, { observedAt: Date.now() + 10000 }]) {
        await assert.rejects(arbitrate(target(), { ...evidence(), ...changes }, f), error => error.code === 'STALE_SNAPSHOT');
    }
    assert.equal(f.calls.length, 0);
});
test('late responses are discarded when snapshot expires or its identity changes', async () => {
    const f = fixture(async () => { await new Promise(r => setTimeout(r, 25)); return response('target', { c0: 1, c1: 0, none: 0 }); });
    const result = await arbitrate(target(), { ...evidence(), observedAt: Date.now() - 14990 }, f);
    assert.equal(result.candidateId, null); assert.equal(result.reason, 'STALE_SNAPSHOT');
    const changed = await arbitrate(target(), evidence(), { ...f, isCurrent: () => false });
    assert.equal(changed.candidateId, null); assert.equal(changed.reason, 'STALE_SNAPSHOT');
});
test('timeout aborts even an uncooperative service and does not retry', async () => {
    const f = fixture(() => new Promise(() => {}));
    const result = await arbitrate(target(), evidence(), { ...f, timeoutMs: 10 });
    assert.equal(result.reason, 'JEV_TIMEOUT'); assert.equal(result.candidateId, null);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].signal.aborted, true);
});
test('trusted cancellation and disabled service return safe advice without action', async () => {
    const c = new AbortController(); c.abort();
    const f = fixture();
    const result = await arbitrate(target(), evidence(), { ...f, signal: c.signal });
    assert.equal(result.reason, 'ABORTED'); assert.equal(f.calls.length, 0);
    const disabled = await arbitrate(target(), evidence(), {});
    assert.equal(disabled.reason, 'JEV_UNAVAILABLE');
});
test('request bounds reject duplicates, out-of-range indexes, unknown mode and excessive text', async () => {
    const f = fixture();
    for (const args of [target({ candidates: [0, 0] }), target({ candidates: [5] }), target({ candidates: [0.5] }), target({ goal: 'x'.repeat(513) }), { mode: 'plan' }]) {
        await assert.rejects(arbitrate(args, evidence(), f), error => error.code === 'INVALID_ARGUMENT');
    }
    assert.equal(f.calls.length, 0);
});

test('an explicit short provider budget may exceed the 2s default but is capped at 5s', async () => {
    const f = fixture();
    const result = await arbitrate(target(), evidence(), { ...f, timeoutMs: 4000 });
    assert.equal(result.candidateId, 'c0'); assert.equal(f.calls[0][2].timeoutMs, 4000);
    await assert.rejects(arbitrate(target(), evidence(), { ...f, timeoutMs: 5001 }), error => error.code === 'INVALID_ARGUMENT');
});
test('disabled shared service does not count as an actual model request', async () => {
    let calls = 0;
    const result = await arbitrate(target(), evidence(), { jev: { async getStatus() { return { configured: false }; }, async decide() { calls++; } } });
    assert.equal(calls, 0); assert.equal(result.modelCalls, 0); assert.equal(result.reason, 'JEV_UNAVAILABLE');
});
test('disabled or offscreen controls are not legal target candidates', async () => {
    const f = fixture();
    for (const metadata of [{ enabled: false }, { inViewport: false }]) {
        const sample = evidence(); sample.controls[0] = { ...sample.controls[0], ...metadata };
        await assert.rejects(arbitrate(target({ candidates: [0] }), sample, f), error => error.code === 'INVALID_ARGUMENT');
    }
    assert.equal(f.calls.length, 0);
});
test('editable labels and password metadata never leave the arbiter', async () => {
    const f = fixture();
    const sample = evidence();
    sample.controls[0] = { ...sample.controls[0], role: 'textfield', label: 'PRIVATE_TYPED_VALUE' };
    sample.controls[1] = { ...sample.controls[1], flags: ['password'], label: 'PRIVATE_PASSWORD' };
    await arbitrate(target(), sample, f);
    const sent = JSON.stringify(f.calls[0][0]);
    assert.equal(sent.includes('PRIVATE_TYPED_VALUE'), false);
    assert.equal(sent.includes('PRIVATE_PASSWORD'), false);
});
