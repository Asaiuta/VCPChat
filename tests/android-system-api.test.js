'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeSystem, catalog } = require('../VCPDistributedServer/Plugin/AndroidController/lib/system-api');
function fixture(values = ['1']) {
    const calls = [], grants = [], dispatched = [];
    return { calls, grants, dispatched, deps: {
        async authorize(serial, group) { grants.push([serial, group]); },
        async beforeDispatch() { dispatched.push(true); },
        async run(tokens) { calls.push(tokens); const value = values.shift(); if (value instanceof Error) throw value; return value ?? ''; },
    } };
}
const request = (operation, capability, rest = {}) => ({ serial: 'A', operation, capability, ...rest });
test('catalog exposes fixed IDs and risk groups, never executable templates', () => {
    assert.ok(catalog.length >= 25);
    for (const row of catalog) { assert.ok(row.id && row.group && row.operation); assert.equal(row.tokens, undefined); }
});
test('read uses exact device authorization and fixed tokens, no dispatch', async () => {
    const f = fixture(['46']); const result = await executeSystem(request('read', 'batteryLevel'), f.deps);
    assert.deepEqual(f.grants, [['A', 'read']]); assert.equal(result.value, 46);
    assert.equal(result.outcome, 'observed'); assert.equal(f.dispatched.length, 0);
    assert.deepEqual(f.calls, [['cmd', 'battery', 'get', 'level']]);
});
test('bad inputs and tool-controlled approvals never reach adb', async () => {
    for (const input of [request('read', 'shell'), request('read', '__proto__'), request('set', 'screenTimeout', { value: '30000;id' }),
        request('set', 'screenTimeout', { value: 0 }), request('read', 'batteryLevel', { approved: true }),
        request('navigate', 'wifi', { uri: 'https://example.com' }), request('set', 'brightnessMode', { value: 2 })]) {
        const f = fixture(); await assert.rejects(executeSystem(input, f.deps), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0);
    }
});
test('missing authorization dependency and permission denial do not dispatch', async () => {
    const f = fixture(); delete f.deps.authorize;
    await assert.rejects(executeSystem(request('read', 'batteryLevel'), f.deps), { code: 'SYSTEM_NOT_AUTHORIZED' });
    f.deps.authorize = async () => { throw Object.assign(new Error('denied'), { code: 'SYSTEM_NOT_AUTHORIZED' }); };
    await assert.rejects(executeSystem(request('set', 'brightnessMode', { value: 0 }), f.deps));
    assert.equal(f.calls.length, 0); assert.equal(f.dispatched.length, 0);
});
test('set reads before, dispatches once, reads back and verifies exact value', async () => {
    const f = fixture(['1', '', '0']); const result = await executeSystem(request('set', 'brightnessMode', { value: 0 }), f.deps);
    assert.equal(result.before, 1); assert.equal(result.after, 0); assert.equal(result.outcome, 'verified');
    assert.equal(f.dispatched.length, 1); assert.deepEqual(f.grants, [['A', 'settings'], ['A', 'settings']]);
    assert.deepEqual(f.calls[1], ['settings', '--user', '0', 'put', 'system', 'screen_brightness_mode', '0']);
});
test('no-op is verified without write; malformed before state prevents write', async () => {
    const f = fixture(['1']); const result = await executeSystem(request('set', 'brightnessMode', { value: 1 }), f.deps);
    assert.equal(result.changed, false); assert.equal(f.calls.length, 1); assert.equal(f.dispatched.length, 0);
    for (const value of ['null', 'Permission denial', 'error', '2']) {
        const bad = fixture([value]); await assert.rejects(executeSystem(request('set', 'brightnessMode', { value: 0 }), bad.deps));
        assert.equal(bad.calls.length, 1); assert.equal(bad.dispatched.length, 0);
    }
});
test('readback mismatch or failure remains unknown and never retries', async () => {
    for (const after of ['1', 'null', new Error('offline')]) {
        const f = fixture(['1', '', after]); const result = await executeSystem(request('set', 'brightnessMode', { value: 0 }), f.deps);
        assert.equal(result.outcome, 'unknown'); assert.equal(result.changed, after === '1' ? false : null);
        assert.equal(result.writeAttempts, 1); assert.equal(f.calls.length, 3); assert.equal(f.dispatched.length, 1);
    }
});
test('revocation between before read and write prevents dispatch', async () => {
    const f = fixture(['1']); let count = 0;
    f.deps.authorize = async () => { if (++count > 1) throw Object.assign(new Error('revoked'), { code: 'SYSTEM_NOT_AUTHORIZED' }); };
    await assert.rejects(executeSystem(request('set', 'brightnessMode', { value: 0 }), f.deps));
    assert.equal(f.calls.length, 1); assert.equal(f.dispatched.length, 0);
});
test('navigation resolves fixed public intent first, missing component is unsupported', async () => {
    const f = fixture(['com.android.settings/.Wifi', 'Starting: Intent']);
    const result = await executeSystem(request('navigate', 'wifi'), f.deps);
    assert.equal(result.outcome, 'dispatched'); assert.equal(result.verified, false);
    assert.equal(f.dispatched.length, 1); assert.ok(f.calls[0].includes('android.settings.WIFI_SETTINGS'));
    const bad = fixture(['No activity found']);
    await assert.rejects(executeSystem(request('navigate', 'wifi'), bad.deps), { code: 'UNSUPPORTED' });
    assert.equal(bad.dispatched.length, 0);
});
test('aborted requests do not run and cancellation after before-read prevents write', async () => {
    const controller = new AbortController(); controller.abort();
    const f = fixture(['1']); f.deps.signal = controller.signal;
    await assert.rejects(executeSystem(request('read', 'batteryLevel'), f.deps), { code: 'ABORTED' }); assert.equal(f.calls.length, 0);
    const later = new AbortController(), g = fixture(['1']); g.deps.signal = later.signal;
    g.deps.run = async tokens => { g.calls.push(tokens); later.abort(); return '1'; };
    await assert.rejects(executeSystem(request('set', 'brightnessMode', { value: 0 }), g.deps), { code: 'ABORTED' });
    assert.equal(g.calls.length, 1); assert.equal(g.dispatched.length, 0);
});


test('probe reports read/resolve evidence without starting activities or writing settings', async () => {
    const f = fixture(['46']);
    const result = await executeSystem(request('probe', 'batteryLevel', { targetOperation: 'read' }), f.deps);
    assert.equal(result.support, 'supported'); assert.equal(result.value, 46); assert.equal(f.dispatched.length, 0);
    const denied = fixture(['Permission denied']);
    const no = await executeSystem(request('probe', 'batteryLevel', { targetOperation: 'read' }), denied.deps);
    assert.equal(no.support, 'permission-denied');
    const write = fixture(['1']);
    const hint = await executeSystem(request('probe', 'brightnessMode', { targetOperation: 'set' }), write.deps);
    assert.equal(hint.support, 'unknown'); assert.equal(hint.readable, true); assert.equal(write.dispatched.length, 0);
    const nav = fixture(['No activity found']);
    const unsupported = await executeSystem(request('probe', 'wifi', { targetOperation: 'navigate' }), nav.deps);
    assert.equal(unsupported.support, 'unsupported'); assert.equal(nav.dispatched.length, 0);
});

test('stderr errors are classified separately and post-dispatch failure is not success', async () => {
    const f = fixture(); f.deps.run = async () => ({ stdout: '', stderr: 'Permission denial: blocked' });
    await assert.rejects(executeSystem(request('read', 'batteryLevel'), f.deps), { code: 'PERMISSION_DENIED' });
    const g = fixture(['1', Object.assign(new Error('connection lost'), { code: 'ADB_ERROR' })]);
    const result = await executeSystem(request('set', 'brightnessMode', { value: 0 }), g.deps);
    assert.equal(result.outcome, 'unknown'); assert.equal(result.changed, null); assert.equal(result.before, 1); assert.equal(result.writeAttempts, 1);
});

test('drafts open public editors only; no send/call/skip-ui route exists', async () => {
    for (const [capability, params, group, action] of [
        ['dial', { phone: '+8613800000000' }, 'communication', 'android.intent.action.DIAL'],
        ['sms', { phone: '+8613800000000', body: 'hello; $(id)' }, 'communication', 'android.intent.action.SENDTO'],
        ['calendarEvent', { title: 'demo', begin: 1800000000000, end: 1800003600000 }, 'schedule', 'android.intent.action.INSERT'],
        ['contact', { name: 'demo', phone: '+8613800000000' }, 'personal', 'android.intent.action.INSERT'],
    ]) {
        const f = fixture(['com.example/.Editor', 'Starting: Intent']);
        const result = await executeSystem(request('draft', capability, { params }), f.deps);
        assert.equal(result.outcome, 'dispatched'); assert.equal(result.requiresUserCompletion, true);
        assert.equal(result.businessWrites, null); assert.equal(f.calls[1].includes('-n'), true);
        assert.equal(f.grants[0][1], group); assert.equal(f.calls[1].includes(action), true);
        assert.equal(f.calls[1].some(token => /skip.ui|action.CALL|SEND_SMS/.test(token)), false);
    }
});
test('draft injection/unknown extras and unbounded dates fail before ADB', async () => {
    for (const [capability, params] of [
        ['dial', { phone: '*123#' }], ['dial', { phone: '123;id' }], ['sms', { phone: '1234', body: 'x', approved: true }],
        ['calendarEvent', { title: 'x', begin: 1800000000000, end: 1 }], ['contact', { name: 'x', phone: '1234', uri: 'content://sms' }],
    ]) { const f = fixture(); await assert.rejects(executeSystem(request('draft', capability, { params }), f.deps), { code: 'INVALID_ARGUMENT' }); assert.equal(f.calls.length, 0); }
});

test('draft failures never expose argv, recipient or body', async () => {
    const f = fixture(); f.deps.run = async () => { throw Object.assign(new Error('adb timeout PRIVATE_BODY 1234567'), { code: 'ADB_TIMEOUT', stderr: 'PRIVATE_BODY' }); };
    await assert.rejects(executeSystem(request('draft', 'sms', { params: { phone: '1234567', body: 'PRIVATE_BODY' } }), f.deps), error => {
        assert.equal(error.code, 'ADB_TIMEOUT'); assert.equal(error.message.includes('PRIVATE_BODY'), false);
        assert.equal(error.message.includes('1234567'), false); assert.equal(JSON.stringify(error).includes('PRIVATE_BODY'), false); return true;
    });
});

test('read timeout range is independent of safe write policy', async () => {
    const f = fixture(['5000']);
    assert.equal((await executeSystem(request('read', 'screenTimeout'), f.deps)).value, 5000);
    const g = fixture(); await assert.rejects(executeSystem(request('set', 'screenTimeout', { value: 5000 }), g.deps), { code: 'INVALID_ARGUMENT' });
});
test('additional public settings pages use fixed intents and resolved explicit components', async () => {
    for (const [id, action] of Object.entries({ aboutDevice: 'DEVICE_INFO_SETTINGS', airplane: 'AIRPLANE_MODE_SETTINGS', dataUsage: 'DATA_USAGE_SETTINGS', home: 'HOME_SETTINGS', print: 'ACTION_PRINT_SETTINGS', caption: 'CAPTIONING_SETTINGS' })) {
        const f = fixture(['com.android.settings/.Main', 'Starting']);
        const result = await executeSystem(request('navigate', id), f.deps);
        assert.equal(f.calls[0].includes('android.settings.' + action), true);
        assert.equal(f.calls[1].includes('-n'), true); assert.equal(f.calls[1].includes('--user'), true);
        assert.equal(result.outcome, 'dispatched'); assert.equal(result.verified, false);
    }
});

test('time metadata is fixed, bounded and never guessed for malformed values', async () => {
    const f = fixture(['Asia/Shanghai']); assert.equal((await executeSystem(request('read', 'timeZone'), f.deps)).value, 'Asia/Shanghai');
    for (const capability of ['automaticTime', 'automaticTimeZone']) {
        const g = fixture(['1']); assert.equal((await executeSystem(request('read', capability), g.deps)).value, 1);
        const h = fixture(['null']); await assert.rejects(executeSystem(request('read', capability), h.deps), { code: 'INVALID_RESPONSE' });
    }
    const invalid = fixture(['Unknown/Nowhere']); await assert.rejects(executeSystem(request('read', 'timeZone'), invalid.deps), { code: 'INVALID_RESPONSE' });
});