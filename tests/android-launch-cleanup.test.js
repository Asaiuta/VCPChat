'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

for (const mode of ['activity', 'resolve-activity', 'monkey']) test(`launcher single dispatch: ${mode}`, async () => {
    const h = await harness({
        foreground: 'com.test.app',
        run(args) {
            if (args.includes('packages')) return 'package:com.test.app';
            if (args.includes('resolve-activity')) return mode === 'monkey' ? 'No activity found' : 'com.test.app/.Main';
            if (args.includes('start') || args.includes('monkey')) return 'started';
        },
    });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', action: {
        command: 'LaunchApp', package: 'com.test.app', ...(mode === 'activity' ? { activity: '.Main' } : {}),
    } });
    const calls = h.calls.filter(call => call[0] === 'adb').map(call => call[1]);
    assert.equal(result.details.steps.length, 1);
    assert.equal(result.details.steps[0].by, mode);
    assert.equal(result.details.launchedBy, mode === 'monkey' ? 'monkey' : 'com.test.app/.Main');
    assert.equal(calls.filter(args => args.includes('start') || args.includes('monkey')).length, 1);
    assert.equal(calls.filter(args => args.includes('resolve-activity')).length, mode === 'activity' ? 0 : 1);
    assert.equal(result.details.ok, true);
    assert.equal(result.details.execution.outcome, 'verified');
});

test('failed component dispatch does not fall back to monkey', async () => {
    const h = await harness({ run(args) {
        if (args.includes('packages')) return 'package:com.test.app';
        if (args.includes('resolve-activity')) return 'com.test.app/.Main';
        if (args.includes('start')) throw Object.assign(new Error('dispatch failed'), { code: 'TEST_FAILED' });
    } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: {
        command: 'LaunchApp', package: 'com.test.app',
    } }), { code: 'TEST_FAILED' });
    assert.equal(h.calls.some(call => call[0] === 'adb' && call[1].includes('monkey')), false);
});
