'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launchApp } = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService')._internals;
for (const mode of ['activity', 'resolve-activity', 'monkey']) test(`launcher single dispatch: ${mode}`, async () => {
    const calls = [];
    const client = {
        async runText(args) {
            calls.push(args);
            if (args.includes('packages')) return 'package:com.test.app';
            if (args.includes('resolve-activity')) return mode === 'monkey' ? 'No activity found' : 'com.test.app/.Main';
            return 'started';
        },
        async currentFocus() { return { package: 'com.test.app', component: 'com.test.app/.Main' }; },
    };
    const result = await launchApp({ package: 'com.test.app', ...(mode === 'activity' ? { activity: '.Main' } : {}) }, { client });
    assert.equal(result.details.steps.length, 1);
    assert.equal(result.details.steps[0].by, mode);
    assert.equal(result.details.launchedBy, mode === 'monkey' ? 'monkey' : 'com.test.app/.Main');
    assert.equal(calls.filter(args => args.includes('start') || args.includes('monkey')).length, 1);
    assert.equal(calls.filter(args => args.includes('resolve-activity')).length, mode === 'activity' ? 0 : 1);
    assert.equal(result.details.ok, true);
});
test('failed component dispatch does not fall back to monkey', async () => {
    const calls = [];
    const client = { async runText(args) {
        calls.push(args);
        if (args.includes('packages')) return 'package:com.test.app';
        if (args.includes('resolve-activity')) return 'com.test.app/.Main';
        throw Object.assign(new Error('dispatch failed'), { code: 'TEST_FAILED' });
    } };
    await assert.rejects(launchApp({ package: 'com.test.app' }, { client }), { code: 'TEST_FAILED' });
    assert.equal(calls.some(args => args.includes('monkey')), false);
});
