'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
test('System uses injected authorization and fixed commands, never auto-wakes device', async () => {
    const grants = [];
    const f = await harness({ services: { systemAuthorization: { async assertAllowed(...args) { grants.push(args); } } }, run(args) { if (args.includes('get-current-user')) return '0'; if (args.some(token => token.replaceAll("'", '') === 'battery')) return '46'; } });
    const result = await f.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'read', capability: 'batteryLevel' } });
    assert.equal(result.details.system.value, 46); assert.equal(result.details.system.outcome, 'observed');
    assert.equal(grants[0][0], 'A'); assert.equal(grants[0][1], 'read');
    assert.equal(f.calls.some(row => JSON.stringify(row).includes('KEYCODE_WAKEUP')), false);
});
test('System without injected grant service fails closed', async () => {
    const f = await harness();
    await assert.rejects(f.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'read', capability: 'batteryLevel' } }), { code: 'SYSTEM_NOT_AUTHORIZED' });
});
test('System rejects missing explicit serial and model approval fields', async () => {
    const f = await harness();
    for (const extra of [{}, { serial: 'A', approved: true }]) await assert.rejects(f.service.processToolCall({ command: 'ExecuteStep', ...(extra.serial ? { serial: extra.serial } : {}), action: { command: 'System', operation: 'read', capability: 'batteryLevel', ...extra } }), { code: 'INVALID_ARGUMENT' });
});

test('non-owner Android user is refused and switching user before write prevents dispatch', async () => {
    const auth = { async assertAllowed() {} };
    const f = await harness({ services: { systemAuthorization: auth }, run(args) { if (args.includes('get-current-user')) return '10'; } });
    await assert.rejects(f.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'read', capability: 'batteryLevel' } }), { code: 'UNSUPPORTED_USER' });
    let checks = 0;
    const g = await harness({ services: { systemAuthorization: auth }, run(args) {
        if (args.includes('get-current-user')) return ++checks === 1 ? '0' : '10';
        if (args.some(token => token.includes('screen_brightness_mode'))) return '1';
    } });
    await assert.rejects(g.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'set', capability: 'brightnessMode', value: 0 } }), { code: 'UNSUPPORTED_USER' });
    assert.equal(g.calls.some(call => call[0] === 'adb' && call[1].some(token => token === "'put'")), false);
});

test('text tool protocol parses strict integer value and bounded JSON params', async () => {
    const auth = { async assertAllowed() {} };
    let reads = 0;
    const f = await harness({ services: { systemAuthorization: auth }, run(args) {
        if (args.includes('get-current-user')) return '0';
        if (args.some(t => t.includes('screen_brightness_mode')) && args.some(t => t.includes('get'))) return reads++ === 0 ? '1' : '0';
        if (args.some(t => t.includes('resolve-activity'))) return 'com.android.dialer/.Dial';
    } });
    const set = await f.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'set', capability: 'brightnessMode', value: '0' } });
    assert.equal(set.details.system.outcome, 'verified');
    await assert.rejects(f.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'draft', capability: 'dial', params: '{"phone":"1234567"}' } }), { code: 'POLICY_CONFIRMATION_REQUIRED', needsConfirmation: true });
    assert.equal(f.calls.some(c => c[0] === 'adb' && c[1].includes("'start'")), false);
    for (const value of ['0x0', '0garbage', '0.0', ' 0']) await assert.rejects(f.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'set', capability: 'brightnessMode', value } }), { code: 'INVALID_ARGUMENT' });
    for (const params of ['{invalid', '[]', '"abc"']) await assert.rejects(f.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'draft', capability: 'dial', params } }), { code: 'INVALID_ARGUMENT' });
});
