'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const input = h => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'InputText', text: '测试输入' } });
const broadcasts = h => h.calls.filter(([kind, args]) => kind === 'adb' && args.includes('ADB_INPUT_B64'));

for (const current of ['com.tencent.wetype/.Service', 'com.android.adbkeyboard.fake/.AdbIME', '', 'null']) {
    test(`Unicode input refuses installed but inactive/unconfirmed IME: ${current}`, async () => {
        const h = await harness({ run(args) {
            if (args.includes('packages')) return 'package:com.android.adbkeyboard';
            if (args.includes('default_input_method')) return current;
        } });
        await assert.rejects(input(h), error => error.code === 'ADB_KEYBOARD_NOT_ACTIVE' && error.execution.outcome === 'failed');
        assert.equal(broadcasts(h).length, 0);
    });
}

test('Unicode input checks current IME on every request rather than trusting installation cache', async () => {
    let current = 'com.android.adbkeyboard/.AdbIME';
    const h = await harness({ run(args) {
        if (args.includes('packages')) return 'package:com.android.adbkeyboard';
        if (args.includes('default_input_method')) return current;
    } });
    await input(h);
    current = 'another.keyboard/.Service';
    await assert.rejects(input(h), { code: 'ADB_KEYBOARD_NOT_ACTIVE' });
    assert.equal(broadcasts(h).length, 1);
});

test('Unicode input does not dispatch if active IME lookup fails', async () => {
    const h = await harness({ run(args) {
        if (args.includes('packages')) return 'package:com.android.adbkeyboard';
        if (args.includes('default_input_method')) throw new Error('private backend state');
    } });
    await assert.rejects(input(h), error => error.code === 'ADB_KEYBOARD_NOT_ACTIVE' && !error.message.includes('private backend state'));
    assert.equal(broadcasts(h).length, 0);
});

test('ASCII input remains independent of ADBKeyboard and never switches IME', async () => {
    const h = await harness();
    await h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'InputText', text: 'hello' } });
    assert.equal(h.calls.some(([, args]) => Array.isArray(args) && (args.includes('default_input_method') || args.includes('ime'))), false);
});



test('Unicode input accepts the full ADBKeyboard component name', async () => {
    const h = await harness({ run(args) {
        if (args.includes('packages')) return 'package:com.android.adbkeyboard';
        if (args.includes('default_input_method')) return 'com.android.adbkeyboard/com.android.adbkeyboard.AdbIME\n';
    } });
    const result = await input(h);
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(broadcasts(h).length, 1);
});

test('Unicode input without ADBKeyboard installation fails before input', async () => {
    const h = await harness();
    await assert.rejects(input(h), error => error.execution.outcome === 'failed');
    assert.equal(broadcasts(h).length, 0);
});


test('Fill is declared separately and rejects missing target without InputText fallback', async () => {
    const h = await harness();
    const catalog = await h.service.processToolCall({ command: 'Describe' });
    assert.equal(catalog.details.catalog.actions.some(action => action.command === 'Fill'), true);
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'Fill', text: 'replacement' } }), { code: 'INVALID_ARGUMENT' });
    assert.equal(h.calls.some(([kind]) => kind === 'adb'), false);
});