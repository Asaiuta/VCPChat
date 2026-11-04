'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { harness } = require('./helpers/android-service-harness.cjs');

async function countedHarness(t, options = {}) {
    const decoded = [];
    const validated = [];
    const run = vm.runInNewContext;
    const spy = t.mock.method(vm, 'runInNewContext', (source, context, options) => run(source, {
        ...context,
        require(name) {
            const dependency = context.require(name);
            return name === './lib/selector' ? { ...dependency, validateSelector(value) {
                validated.push(value);
                return dependency.validateSelector(value);
            } } : dependency;
        },
        JSON: { stringify: JSON.stringify, parse(value) { decoded.push(value); return JSON.parse(value); } },
    }, options));
    try {
        const h = await harness(options);
        t.after(() => h.service.cleanup());
        return { ...h, decoded, validated };
    }
    finally { spy.mock.restore(); }
}
const inputs = h => h.calls.filter(([kind, args]) => kind === 'adb' && args[1] === 'input');
const run = (h, args) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', ...args });

test('single-step entry decodes action, expectation and observation once', async t => {
    const h = await countedHarness(t);
    const action = JSON.stringify({ command: 'KeyEvent', key: 'back' });
    const expect = JSON.stringify({ type: 'visible', selector: 'text=Go' });
    const afterObserve = JSON.stringify({ limit: 5 });
    const result = await run(h, { action, expect, afterObserve });
    for (const value of [action, expect, afterObserve]) assert.equal(h.decoded.filter(item => item === value).length, 1);
    assert.equal(inputs(h).length, 1);
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(result.details.observation.status, 'observed');
});

test('sequence string steps share decoded frame action and validated plans', async t => {
    const h = await countedHarness(t);
    const shot = await h.service.processToolCall({ command: 'Observe', serial: 'A', mode: 'image' });
    const action = JSON.stringify({ command: 'Tap', x: 10, y: 20, frameId: shot.details.image.frameId });
    const expect = JSON.stringify({ type: 'visible', selector: 'text=Go' });
    const first = JSON.stringify({ action, expect });
    const lastAction = JSON.stringify({ command: 'KeyEvent', key: 'back' });
    const steps = JSON.stringify([first, { action: lastAction }]);
    const afterObserve = JSON.stringify({ limit: 6 });
    const args = { steps, afterObserve };
    const result = await run(h, args);
    for (const value of [steps, first, action, expect, lastAction, afterObserve]) assert.equal(h.decoded.filter(item => item === value).length, 1, value);
    assert.equal(h.validated.filter(value => value === 'text=Go').length, 1, 'sequence expectation is validated once');
    assert.equal(args.steps, steps, 'caller arguments must not be rewritten');
    assert.equal(inputs(h).length, 2);
    assert.equal(result.details.sequence.status, 'completed');
    assert.equal(result.details.sequence.steps[0].outcome, 'verified');
    assert.equal(result.details.observation.status, 'observed');
});

test('sequence validates a later malformed expectation before any input', async t => {
    const h = await countedHarness(t);
    const steps = [{ action: { command: 'KeyEvent', key: 'back' }, expect: { type: 'visible', selector: 'text=Go' } },
        { action: { command: 'KeyEvent', key: 'home' }, expect: '{broken' }];
    await assert.rejects(run(h, { steps }), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
});

test('single-step validation retains System serial and observation error precedence', async t => {
    const h = await countedHarness(t);
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: '{"command":"System"}', timeoutMs: 0 }), /显式指定 serial/);
    await assert.rejects(run(h, { action: { command: 'Wait' }, afterObserve: { unknown: true }, expect: '{broken' }), /afterObserve 含未知字段/);
    assert.equal(inputs(h).length, 0);
});


test('auto device selection receives normalized single and sequence inputs', async t => {
    const h = await countedHarness(t, { serial: '' });
    const action = JSON.stringify({ command: 'KeyEvent', key: 'back' });
    const steps = JSON.stringify([JSON.stringify({ action })]);
    const result = await h.service.processToolCall({ command: 'ExecuteStep', steps });
    assert.equal(result.details.sequence.status, 'completed');
    assert.equal(h.decoded.filter(value => value === steps).length, 1);
    assert.equal(h.decoded.filter(value => value === action).length, 1);
    assert.equal(inputs(h).length, 1);
    assert.equal(inputs(h)[0][2].serial, 'A');

    const single = await countedHarness(t, { serial: '' });
    await single.service.processToolCall({ command: 'ExecuteStep', action });
    assert.equal(single.decoded.filter(value => value === action).length, 1);
    assert.equal(inputs(single).length, 1);
    assert.equal(inputs(single)[0][2].serial, 'A');
});