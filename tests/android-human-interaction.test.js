'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, xml } = require('./helpers/android-service-harness.cjs');
const { createHumanInteraction } = require('../modules/services/humanInteraction');
const { performance } = require('node:perf_hooks');
const execute = (h, action, extra = {}, context = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action, ...extra }, context);
const tap = { command: 'Tap', id: 'com.example:id/go' };
const writes = h => h.calls.filter(c => c[0] === 'rpc' || (c[0] === 'adb' && c[1].includes('input')));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('native dialog defaults to refusal and late replies after abort cannot authorize', async () => {
    const pending = deferred(); let options;
    const window = { isDestroyed: () => false };
    const human = createHumanInteraction({ getWindow: () => window,
        dialog: { showMessageBox(w, opts) { assert.equal(w, window); options = opts; return pending.promise; } } });
    const controller = new AbortController();
    const task = human.request({ kind: 'approval', detail: 'Tap Buy', signal: controller.signal });
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
    controller.abort(); pending.resolve({ response: 1 });
    await assert.rejects(task, { name: 'AbortError' });
});

test('trusted approval allows only its exact live action and is not reused', async () => {
    let prompts = 0;
    const h = await harness({ dump: () => xml('Pay'), services: { humanInteraction: {
        async request({ kind, detail }) { prompts++; assert.equal(kind, 'approval'); assert.match(detail, /Pay/); return true; },
    } } });
    await execute(h, tap); await execute(h, tap);
    assert.equal(prompts, 2); assert.equal(writes(h).length, 2);
});

for (const scenario of ['reject', 'throw', 'label', 'geometry', 'policy', 'action']) test(`approval fails closed on ${scenario}`, async () => {
    let label = 'Pay', top = 0, prompts = 0;
    const config = { confirmEveryWrite: true };
    const action = { ...tap };
    const h = await harness({ config: { INTERACTION_POLICY: config }, dump: () => xml(label, top),
        services: { humanInteraction: { async request() {
            prompts++;
            if (scenario === 'throw') throw Error('dialog failed');
            if (scenario === 'label') label = 'Pay other recipient';
            if (scenario === 'geometry') top = 20;
            if (scenario === 'policy') config.readOnlyPackages = ['com.example'];
            if (scenario === 'action') action.command = 'LongPress';
            return scenario !== 'reject';
        } } } });
    await assert.rejects(execute(h, action), error => /^(POLICY_|HUMAN_INTERACTION_)/.test(error.code));
    assert.equal(prompts, 1); assert.equal(writes(h).length, 0);
});

test('deny policy cannot be overridden by the trusted prompt service', async () => {
    let prompts = 0;
    const h = await harness({ config: { INTERACTION_POLICY: { readOnlyPackages: ['com.example'] } },
        services: { humanInteraction: { async request() { prompts++; return true; } } } });
    await assert.rejects(execute(h, tap), { code: 'POLICY_DENIED' });
    assert.equal(prompts, 0); assert.equal(writes(h).length, 0);
});

test('approval holds device lease and cancellation discards a late yes without replay', async () => {
    const entered = deferred(), answer = deferred();
    const h = await harness({ dump: () => xml('Pay'), services: { humanInteraction: {
        async request() { entered.resolve(); return answer.promise; },
    } } });
    const controller = new AbortController();
    const task = execute(h, tap, {}, { signal: controller.signal });
    await entered.promise;
    await assert.rejects(execute(h, { command: 'KeyEvent', key: 'back' }), { code: 'DEVICE_BUSY' });
    controller.abort(); await assert.rejects(task, { code: 'STEP_ABORTED' });
    answer.resolve(true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes(h).length, 0);
});

test('index and frame credentials cannot be renewed by an approval wait', async () => {
    let prompts = 0;
    const h = await harness({ dump: () => xml('Pay'), services: { humanInteraction: { async request() { prompts++; return true; } } } });
    const observation = await h.service.processToolCall({ command: 'Observe', serial: 'A' });
    await assert.rejects(execute(h, { command: 'Tap', index: 0, snapshotId: observation.details.snapshotId }), { code: 'POLICY_APPROVAL_REQUIRES_SELECTOR' });
    assert.equal(prompts, 0); assert.equal(writes(h).length, 0);
});

for (const resumed of [true, false]) test(`handoff ${resumed ? 'resumes' : 'stops'} same sequence without replaying earlier steps`, async () => {
    const entered = deferred(), answer = deferred();
    const h = await harness({ services: { humanInteraction: { async request({ kind }) { assert.equal(kind, 'handoff'); entered.resolve(); return answer.promise; } } } });
    const step = { action: { command: 'KeyEvent', key: 'back' }, expect: { type: 'visible', selector: 'text=Go' } };
    const task = h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', steps: [step,
        { action: { command: 'Handoff', reason: '请在手机处理' }, expect: { type: 'visible', selector: 'text=Go' } },
        { action: { command: 'KeyEvent', key: 'back' } }] });
    await entered.promise;
    assert.equal(writes(h).length, 1);
    await assert.rejects(execute(h, tap), { code: 'DEVICE_BUSY' });
    answer.resolve(resumed);
    const result = await task;
    assert.equal(writes(h).length, resumed ? 2 : 1);
    assert.equal(result.details.sequence.status, resumed ? 'completed' : 'stopped');
});

test('handoff invalidates an old observation even when human stops', async () => {
    const h = await harness({ services: { humanInteraction: { request: async () => false } } });
    const previous = await h.service.processToolCall({ command: 'Observe', serial: 'A' });
    const result = await execute(h, { command: 'Handoff', reason: '请处理验证码' });
    assert.equal(result.details.execution.outcome, 'unknown');
    await assert.rejects(execute(h, { command: 'Tap', index: 0, snapshotId: previous.details.snapshotId }));
    assert.equal(writes(h).length, 0);
});

test('handoff deadline is unknown, invalidates credentials and releases the lease without a late resume', async () => {
    const entered = deferred(), answer = deferred(); let promptSignal;
    const h = await harness({ services: { humanInteraction: { request({ signal }) {
        promptSignal = signal; entered.resolve(); return answer.promise;
    } } } });
    const task = execute(h, { command: 'Handoff', reason: '处理手机界面' }, { timeoutMs: 100 });
    const checked = assert.rejects(task, error => {
        assert.equal(error.code, 'STEP_DEADLINE'); assert.equal(error.execution.outcome, 'unknown'); return true;
    });
    await entered.promise; await checked;
    assert.equal(promptSignal.aborted, true);
    answer.resolve(true); await new Promise(resolve => setImmediate(resolve));
    await execute(h, tap);
    assert.equal(writes(h).length, 1);
});

test('handoff unavailable host fails before opening an unknown human session', async () => {
    const h = await harness();
    await assert.rejects(execute(h, { command: 'Handoff', reason: '处理手机界面' }), error => {
        assert.equal(error.code, 'HUMAN_INTERACTION_UNAVAILABLE'); assert.equal(error.execution.outcome, 'failed'); return true;
    });
    assert.equal(writes(h).length, 0);
});

test('DoubleTap confirmation is once for the bounded compound gesture and policy revocation still stops the second click', async t => {
    const epoch = Date.now();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch });
    t.mock.method(performance, 'now', () => Date.now() - epoch);
    for (const revoke of [false, true]) {
        let clicks = 0, prompts = 0;
        const config = { confirmEveryWrite: true };
        const h = await harness({ config: { INTERACTION_POLICY: config }, dump: () => xml('Pay'),
            uiServer: { ok: true, xml: () => xml('Pay'), invoke: async method => {
                if (method === 'click') { clicks++; if (revoke) config.readOnlyPackages = ['com.example']; }
                return true;
            } }, services: { humanInteraction: { request: async () => { prompts++; return true; } } } });
        const task = execute(h, { command: 'DoubleTap', id: 'com.example:id/go' }).then(value => ({ value }), error => ({ error }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(clicks, 1);
        t.mock.timers.tick(100);
        const { error } = await task;
        if (revoke) {
            assert.equal(error.code, 'POLICY_DENIED'); assert.equal(error.execution.outcome, 'unknown');
        } else assert.ifError(error);
        assert.equal(prompts, 1); assert.equal(clicks, revoke ? 1 : 2);
    }
});
