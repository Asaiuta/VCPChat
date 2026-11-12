'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { main, optionsOf } = require('../scripts/verify-android-no-ocr.cjs');
const PACKAGE = 'com.vcpchat.m15fixture';
function fixture({ foreground = PACKAGE, carrier = true, online = true, session = '11111111-1111-4111-8111-111111111111' } = {}) {
    const calls = [], logs = [];
    return { calls, logs, emit: v => logs.push(v), loadService() { throw Error('SERVICE_MUST_NOT_LOAD'); },
        spawnSync(file, args) {
            calls.push(args);
            let stdout;
            if (args[0] === 'devices') stdout = 'List of devices attached\n' + (online ? 'A device\n' : '');
            else if (args.includes('displays')) stdout = `mCurrentFocus=Window{a u0 ${foreground}/.MainActivity}`;
            else if (args.includes('power')) stdout = 'mWakefulness=Awake';
            else if (args.includes('policy')) stdout = 'KeyguardServiceDelegate\n  showing=false\n  inputRestricted=false';
            else if (args.includes('content')) stdout = 'Row: 0 state=' + JSON.stringify({ready:true,resumed:true,package:PACKAGE,protocol:1,session,
                mode:'m2',m2ClicksA:0,m2ClicksB:0,m2DynamicCounter:0,m2Ticks:0,m2Motion:false,m2Label:'M2 DYNAMIC 0'});
            else if (args.some(arg => arg.includes('echo PRESENT'))) stdout = carrier ? 'PRESENT' : 'ABSENT';
            else throw Error('UNEXPECTED_DEVICE_OPERATION');
            return { status: 0, stdout };
        } };
}
test('no-OCR runner requires explicit canonical serial and does not accept human mode for read-only probe', () => {
    assert.equal(optionsOf(['--serial','A']).mode, 'probe');
    for (const args of [[], ['--serial','A','--human'], ['--serial','A','--human','--human','--suite'], ['--serial','A','--force']]) assert.throws(() => optionsOf(args));
});
test('no-OCR probe only reads device and fixed fixture without loading plugin or native dialogs', async () => {
    const f = fixture(); const result = await main(['--serial','A'], f);
    assert.equal(result.exitCode, 0); assert.equal(f.calls.length, 5);
    assert.equal(f.logs[0].serviceInitialized, false);
});
for (const [name, options, code, count] of [
    ['offline', {online:false}, 'EXPLICIT_DEVICE_NOT_ONLINE', 1],
    ['other foreground', {foreground:'com.other'}, 'UNSAFE_OR_UNPROVEN_TARGET_STOP', 4],
    ['invalid fixture', {session:'bad'}, 'FIXTURE_STATE_INVALID', 5],
    ['missing carrier', {carrier:false}, 'PREPROVISIONED_RPC_APK_REQUIRED', 6],
]) test(`no-OCR suite stops before service initialization on ${name}`, async () => {
    const f = fixture(options); await assert.rejects(main(['--suite','--serial','A'], f), {code});
    assert.equal(f.calls.length, count);
});
test('native suite cannot substitute a model answer or run without an injected host', async () => {
    const f = fixture(); await assert.rejects(main(['--suite','--human','--serial','A'], f), {code:'NATIVE_ELECTRON_HOST_REQUIRED'});
});

test('M2 preparation uses its own counters rather than a detached ScrollView offset', async () => {
    const f = fixture(), spawn = f.spawnSync;
    f.spawnSync = (file, args) => {
        const result = spawn(file, args);
        if (args.includes('content')) result.stdout = result.stdout.slice(0, -1) + ',"scrollY":9194}';
        return result;
    };
    let operations = 0, cleaned = false;
    f.loadRuntime = () => ({ assertManagementIdle() {} });
    f.loadService = () => ({
        async initialize() {}, async cleanup() { cleaned = true; },
        getRuntimeStatus: () => ({ adbQueue: { depth: 0, pending: 0, running: false } }),
        async processToolCall() {
            operations++;
            if (operations > 1) throw Object.assign(Error(), {code:'EXPECTED_TEST_BOUNDARY'});
            return { details: { execution: { serial:'A', outcome:'dispatched' }, attempts: [{channel:'rpc',method:'click',status:'dispatched'}] } };
        },
    });
    const result = await main(['--suite','--serial','A'], f);
    assert.equal(operations, 2); assert.equal(cleaned, true);
    assert.equal(result.summary.executed, 1);
    assert.ok(f.logs.some(log => log.code === 'EXPECTED_TEST_BOUNDARY'));
});
