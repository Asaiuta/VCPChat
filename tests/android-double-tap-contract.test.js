'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { harness } = require('./helpers/android-service-harness.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const action = { command: 'DoubleTap', id: 'com.example:id/go' };
const clicks = h => h.calls.filter(call => call[0] === 'rpc');
const inputs = h => h.calls.filter(call => call[0] === 'adb' && call[1].includes('input'));
const modelText = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const observeWork = work => work.then(value => ({ value }), error => ({ error }));

function clock(t) {
    const epoch = Date.now();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch });
    t.mock.method(performance, 'now', () => Date.now() - epoch);
    return ms => t.mock.timers.tick(ms);
}

function partialFailure(error, statuses) {
    assert.ok(error);
    assert.equal(error.execution.outcome, 'unknown');
    assert.equal(error.execution.retryable, false);
    assert.equal(error.details.experimental, true);
    assert.deepEqual(Array.from(error.details.attempts, item => item.status), statuses);
    assert.match(error.message, /"experimental":true/);
    assert.match(error.message, /"attempts":/);
    assert.doesNotMatch(error.message, /private/);
}

test('DoubleTap 同一目标两次20ms RPC短按，派发间隔100ms，两击各有回执', async t => {
    const advance = clock(t);
    const times = [];
    const captures = [];
    const h = await harness({ uiServer: { ok: true, invoke() {
        times.push(Date.now()); captures.push(h.uiServer.dumped); return true;
    } } });
    const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', action }));
    await tick();
    assert.equal(clicks(h).length, 1);
    advance(99);
    await tick();
    assert.equal(clicks(h).length, 1, '不得提前发出第二击');
    advance(1);
    const { value, error } = await work;
    assert.ifError(error);
    assert.equal(times[1] - times[0], 100);
    assert.ok(times[1] - times[0] >= 60 && times[1] - times[0] <= 120);
    assert.deepEqual(clicks(h).map(call => [call[1], Array.from(call[2])]), [
        ['click', [50, 20, 20]], ['click', [50, 20, 20]],
    ]);
    assert.deepEqual(clicks(h).map(call => call[3].signal), [clicks(h)[0][3].signal, clicks(h)[0][3].signal]);
    assert.deepEqual(Array.from(value.details.attempts, item => item.status), ['dispatched', 'dispatched']);
    assert.equal(value.details.execution.outcome, 'dispatched');
    assert.equal(value.details.execution.verification, null);
    assert.equal(value.details.experimental, true);
    assert.equal(value.details.pressDurationMs, 20);
    assert.match(modelText(value), /"experimental":true/);
    assert.equal(h.uiServer.dumped, 2, '首击前一次目标采样与一次最终policy gate');
    assert.deepEqual(captures, [2, 2], '两击之间不得再采树');
    assert.equal(inputs(h).length, 0, '绝不拼两次shell tap');
});

for (const boundary of ['abort', 'deadline']) {
    test(`DoubleTap 两击之间${boundary}，不补第二击且保留首击副作用`, async t => {
        const advance = clock(t);
        const controller = new AbortController();
        const h = await harness({ uiServer: { ok: true } });
        const work = observeWork(h.service.processToolCall({
            command: 'ExecuteStep', action, timeoutMs: boundary === 'deadline' ? 80 : 1000,
        }, { signal: controller.signal }));
        await tick();
        assert.equal(clicks(h).length, 1);
        if (boundary === 'abort') controller.abort();
        else advance(80);
        const { error } = await work;
        partialFailure(error, ['dispatched']);
        assert.equal(error.code, boundary === 'abort' ? 'STEP_ABORTED' : 'STEP_DEADLINE');
        advance(200);
        await tick();
        assert.equal(clicks(h).length, 1);
        assert.equal(inputs(h).length, 0);
    });
}

for (const delayedStart of [false, true]) {
    test(`DoubleTap ${delayedStart ? '第二击就绪等待' : '调度停顿'}错过120ms窗口，不补过期点击`, async t => {
        const advance = clock(t);
        let count = 0;
        const h = await harness({ uiServer: {
            ok: true,
            start() {
                if (delayedStart && count === 1) advance(21);
                return { ok: true };
            },
            invoke() { count++; return true; },
        } });
        const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', action }));
        await tick();
        advance(delayedStart ? 100 : 121);
        const { error } = await work;
        partialFailure(error, ['dispatched', 'not-dispatched']);
        assert.equal(error.code, 'DOUBLE_TAP_WINDOW_MISSED');
        assert.equal(clicks(h).length, 1);
        assert.equal(inputs(h).length, 0);
    });
}

for (const nth of [1, 2]) {
    for (const mode of ['not-dispatched', 'timeout', 'disconnect', 'false']) {
        test(`DoubleTap 第${nth}击${mode}，不重放不shell降级`, async t => {
            const advance = clock(t);
            let count = 0;
            const h = await harness({ uiServer: { ok: true, invoke() {
                if (++count !== nth) return true;
                if (mode === 'false') return false;
                throw Object.assign(new Error('private transport body'), {
                    code: mode === 'timeout' ? 'UI_SERVER_TIMEOUT'
                        : mode === 'disconnect' ? 'UI_SERVER_RPC_FAILED' : 'UI_SERVER_RPC_ERROR',
                    dispatched: mode !== 'not-dispatched',
                });
            } } });
            const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', action }));
            await tick();
            if (nth === 2) advance(100);
            const { error } = await work;
            const statuses = [...(nth === 2 ? ['dispatched'] : []), mode === 'not-dispatched' ? 'not-dispatched' : 'unknown'];
            if (nth === 1 && mode === 'not-dispatched') {
                assert.equal(error.execution.outcome, 'failed');
                assert.equal(error.details.experimental, true);
                assert.deepEqual(Array.from(error.details.attempts, item => item.status), statuses);
            } else partialFailure(error, statuses);
            advance(200);
            await tick();
            assert.equal(clicks(h).length, nth);
            assert.equal(inputs(h).length, 0);
        });
    }
}

test('DoubleTap RPC不可用是未派发失败，不退回shell双击', async () => {
    const h = await harness();
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action }), error => {
        assert.equal(error.execution.outcome, 'failed');
        assert.equal(error.details.experimental, true);
        return true;
    });
    assert.equal(clicks(h).length, 0);
    assert.equal(inputs(h).length, 0);
});

test('DoubleTap 仅完整两击后才验证外层expect，验证不代表系统识别了双击', async t => {
    const advance = clock(t);
    const h = await harness({ uiServer: { ok: true } });
    const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', action,
        expect: { type: 'visible', selector: 'text=Go' }, afterObserve: true }));
    await tick();
    assert.equal(h.uiServer.dumped, 2, '目标采样与policy gate后，首击不能提前验证');
    advance(100);
    const { value, error } = await work;
    assert.ifError(error);
    assert.equal(value.details.execution.outcome, 'verified');
    assert.equal(clicks(h).length, 2);
    assert.equal(h.uiServer.dumped, 3, '两击之后只采一次验证样本，afterObserve复用');
    assert.equal(value.details.observation.status, 'observed');
});

for (const target of ['index', 'pixel']) {
    test(`DoubleTap ${target}凭据只验证一次，内部第二击可用，动作后外部旧凭据失效`, async t => {
        const advance = clock(t);
        const h = await harness({ uiServer: { ok: true } });
        const observed = await h.service.processToolCall({ command: 'Observe', ...(target === 'pixel' ? { mode: 'image' } : {}) });
        const args = target === 'index'
            ? { index: 0, snapshotId: observed.details.snapshotId }
            : { x: 20, y: 30, frameId: observed.details.frameId };
        const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'DoubleTap', ...args } }));
        await tick();
        advance(100);
        const { error } = await work;
        assert.ifError(error);
        assert.equal(clicks(h).length, 2);
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'Tap', ...args } }));
        assert.equal(clicks(h).length, 2);
    });
}

test('DoubleTap 过期快照和错误像素凭据零写入', async t => {
    const advance = clock(t);
    const h = await harness({ uiServer: { ok: true } });
    const observed = await h.service.processToolCall({ command: 'Observe' });
    advance(15001);
    for (const [args, code] of [
        [{ index: 0, snapshotId: observed.details.snapshotId }, 'STALE_SNAPSHOT'],
        [{ x: 1, y: 2, frameId: 'invalid' }, 'STALE_FRAME'],
    ]) {
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'DoubleTap', ...args } }), { code });
    }
    assert.equal(clicks(h).length, 0);
    assert.equal(inputs(h).length, 0);
});

test('DoubleTap 第二击超时不延长总预算，RPC未排干前保留租约', async t => {
    const advance = clock(t);
    let count = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ uiServer: { ok: true, invoke() { return ++count === 2 ? gate : true; } } });
    const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', action, timeoutMs: 150 }));
    await tick();
    advance(100);
    await tick();
    assert.equal(clicks(h).length, 2);
    assert.equal(clicks(h)[1][3].timeoutMs, 50);
    advance(50);
    const { error } = await work;
    assert.equal(error.code, 'STEP_DEADLINE');
    assert.equal(error.execution.outcome, 'unknown');
    await assert.rejects(h.service.processToolCall({ command: 'Observe' }), { code: 'DEVICE_BUSY' });
    release(true);
    await tick();
    assert.equal(inputs(h).length, 0);
    await h.service.processToolCall({ command: 'Observe' });
});

test('DoubleTap 作为sequence一步时，第二击失败立即停，不能执行下一步', async t => {
    const advance = clock(t);
    let count = 0;
    const h = await harness({ uiServer: { ok: true, invoke() {
        if (++count === 2) throw Object.assign(new Error('private'), { code: 'UI_SERVER_RPC_ERROR', dispatched: false });
        return true;
    } } });
    const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', steps: [
        { action, expect: { type: 'visible', selector: 'text=Go' } },
        { action: { command: 'KeyEvent', key: 'back' } },
    ] }));
    await tick();
    advance(100);
    const { error } = await work;
    partialFailure(error, ['dispatched', 'not-dispatched']);
    assert.equal(error.execution.sequence.status, 'stopped');
    assert.equal(error.execution.sequence.steps.length, 1);
    assert.equal(error.execution.sequence.steps[0].outcome, 'unknown');
    assert.equal(inputs(h).length, 0);
});

test('DoubleTap 仅嵌套动作公开实验状态，不扩张四入口或连坐Tap', async () => {
    const h = await harness();
    await assert.rejects(h.service.processToolCall({ command: 'DoubleTap' }), /不支持的 command/);
    const description = await h.service.processToolCall({ command: 'Describe' });
    const catalog = description.details.catalog.actions;
    assert.equal(catalog.find(item => item.command === 'DoubleTap').experimental, true);
    assert.notEqual(catalog.find(item => item.command === 'Tap').experimental, true);
    assert.match(modelText(description), /DoubleTap/);
    assert.equal(h.calls.length, 0);
});


test('DoubleTap 的实验回执不污染sequence中下一步普通Tap失败', async t => {
    const advance = clock(t);
    let count = 0;
    const h = await harness({ uiServer: { ok: true, invoke() {
        if (++count === 3) throw Object.assign(new Error('private'), { code: 'UI_SERVER_TIMEOUT', dispatched: true });
        return true;
    } } });
    const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', steps: [
        { action, expect: { type: 'visible', selector: 'text=Go' } },
        { action: { command: 'Tap', id: 'com.example:id/go' } },
    ] }));
    await tick();
    advance(100);
    const { error } = await work;
    assert.equal(error.execution.outcome, 'unknown');
    assert.equal(error.execution.sequence.steps[0].outcome, 'verified');
    assert.equal(error.execution.sequence.steps[1].outcome, 'unknown');
    assert.equal(error.details.experimental, undefined);
    assert.equal(error.details.intervalMs, undefined);
    assert.equal(error.details.pressDurationMs, undefined);
    assert.equal(error.details.attempts.length, 1);
});


for (const ackMs of [50, 110, 121]) {
    test(`DoubleTap 首击ACK延迟${ackMs}ms仍按首击派发时点计窗`, async t => {
        const advance = clock(t);
        const times = [];
        const h = await harness({ uiServer: { ok: true, invoke() {
            times.push(Date.now());
            if (times.length === 1) advance(ackMs);
            return true;
        } } });
        const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', action }));
        await tick();
        advance(Math.max(0, 100 - ackMs));
        const { value, error } = await work;
        if (ackMs > 120) {
            partialFailure(error, ['dispatched', 'not-dispatched']);
            assert.equal(error.code, 'DOUBLE_TAP_WINDOW_MISSED');
            assert.equal(times.length, 1);
        } else {
            assert.ifError(error);
            assert.equal(times.length, 2);
            assert.equal(times[1] - times[0], Math.max(100, ackMs));
            assert.ok(times[1] - times[0] >= 60 && times[1] - times[0] <= 120);
            assert.equal(value.details.execution.outcome, 'dispatched');
        }
        assert.equal(inputs(h).length, 0);
    });
}

test('DoubleTap 持久化耗时也占原第二击窗口，过窗不派发', async t => {
    const advance = clock(t), { InputRecovery } = require('../VCPDistributedServer/Plugin/AndroidController/lib/input-recovery');
    const original = InputRecovery.prototype.begin; let begins = 0, writes = 0;
    t.mock.method(InputRecovery.prototype, 'begin', function(...args) {
        const record = original.apply(this, args); if (++begins === 2) advance(50); return record;
    });
    const h = await harness({ uiServer: { ok: true, invoke() { writes++; return true; } } });
    const work = observeWork(h.service.processToolCall({ command: 'ExecuteStep', action }));
    await tick(); advance(100); const { error } = await work;
    assert.equal(error.code, 'DOUBLE_TAP_WINDOW_MISSED'); partialFailure(error, ['dispatched', 'not-dispatched']);
    assert.equal(writes, 1); assert.deepEqual(h.service.getRuntimeStatus().quarantinedDevices, []);
});
