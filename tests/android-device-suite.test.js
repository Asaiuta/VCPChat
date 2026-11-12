'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const S = require('../scripts/android-j02/storage.cjs');
const C = require('../scripts/android-device-suite/cases.cjs');
const { parseArgs, createDevice } = require('../scripts/android-device-suite/device.cjs');
const base = ['--serial', '127.0.0.1:16384', '--adb', process.execPath, '--output', 'unused', '--apk', 'fixture.apk', '--peer-apk', 'peer.apk'];
test('device suite requires explicit target and immutable batch paths', () => {
    const options = parseArgs(base); assert.equal(options.contentRuntime, 'native'); assert.equal(options.install, undefined);
    for (const args of [base.slice(2), [...base, '--serial', 'other'], [...base, '--content-runtime', 'auto'], [...base, '--matrix', 'all']]) assert.throws(() => parseArgs(args));
});
test('all predefined tasks pass production contract before device work', () => {
    const { prepareTask } = require('../modules/services/androidTaskExecutor');
    for (const c of C.CASES) { const task = C.taskFor(c, 'A'); if (task) { const prepared = prepareTask(task); assert.equal(prepared.decision, 'jev'); assert.ok(task.budget.maxActions <= 12); } }
    assert.equal(C.CASES.length, 17);
});
test('native and 32-bit checker transport never accept nonzero exit with plausible JSON', () => {
    for (const runtime of ['native', '32']) {
        const options = { ...parseArgs(base), contentRuntime: runtime }, calls = [];
        const device = createDevice(options, () => {}, (file, args) => {
            calls.push(args); return { status: 139, stdout: 'Row: 0 state={"ready":true}', stderr: '' };
        });
        assert.throws(() => device.read(), { code: 'DEVICE_COMMAND_FAILED' });
        assert.equal(calls.length, 1); assert.equal(calls[0].includes('app_process32'), runtime === '32');
    }
});
test('system runtime adaptation applies only to the exact read-only fixture query', () => {
    const seen = [], options = { ...parseArgs(base), contentRuntime: '32' };
    const device = createDevice(options, () => {}, (file, args) => { seen.push(args); return { status: 0 }; });
    const write = ['-s', options.serial, 'shell', 'input', 'tap', '5', '5'];
    device.legacySpawn(options.adb, write, {}); assert.deepEqual(seen[0], write);
    const query = ['-s', options.serial, 'shell', 'content', 'query', '--uri', `content://${C.PACKAGE}.state/state`];
    device.legacySpawn(options.adb, query, {}); assert.ok(seen[1].includes('app_process32'));
});

test('preflight requires matching installed APK and RPC bytes without silently provisioning', async () => {
    const rpc = require('node:path').resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/vendor/u2-server-0.5.0.apk');
    for (const mode of ['matching', 'missing-rpc', 'wrong-rpc', 'wrong-apk']) {
        const options = { ...parseArgs(base), apk: process.execPath, peerApk: undefined }, calls = [];
        const device = createDevice(options, () => {}, (file, args) => {
            calls.push(args); const command = args.slice(2); let stdout = '';
            if (command.includes('power')) stdout = 'mWakefulness=Awake';
            else if (command.includes('policy')) stdout = 'mKeyguardShowing=false inputRestricted=false';
            else if (command.includes('path')) stdout = 'package:/data/app/fixture/base.apk';
            else if (command.some(a => a.includes('echo PRESENT'))) stdout = mode === 'missing-rpc' ? 'ABSENT' : 'PRESENT';
            else if (command.includes('sha256sum')) {
                const isRpc = command.at(-1).includes('u2-server');
                stdout = (mode === (isRpc ? 'wrong-rpc' : 'wrong-apk') ? '0'.repeat(64) : S.sha(fs.readFileSync(isRpc ? rpc : options.apk))) + ' file';
            }
            return { status: 0, stdout };
        });
        if (mode === 'matching') await device.prepare(); else await assert.rejects(device.prepare());
        assert.equal(calls.some(a => a.includes('push') || a.includes('install')), false);
    }
});
test('hold checker rejects early release, cancellation, repetition and missing wall evidence', () => {
    const before = { downCount: 0 }, good = { downCount: 1, upCount: 1, cancelCount: 0, holdCount: 1, tapCount: 0, activeTouch: false, durationMs: 2000, wallDurationMs: 2000 };
    C.verifyTouch('Hold2000', before, good);
    for (const change of [{ durationMs: 1000 }, { wallDurationMs: 1000 }, { upCount: 2 }, { cancelCount: 1 }, { activeTouch: true }, { durationMs: 2700 }]) assert.throws(() => C.verifyTouch('Hold2000', before, { ...good, ...change }));
});
test('touch cancel oracle rejects completed tap or hold even if a cancel was counted', () => {
    const good = { downCount: 1, upCount: 0, cancelCount: 1, holdCount: 0, tapCount: 0, activeTouch: false };
    C.verifyTouch('TouchCancel', { downCount: 0 }, good);
    for (const key of ['upCount', 'holdCount', 'tapCount']) assert.throws(() => C.verifyTouch('TouchCancel', { downCount: 0 }, { ...good, [key]: 1 }));
});
test('fixed provider answers select only supplied current candidate branches', () => {
    const { questionsFor, select } = require('../modules/services/androidUiTaskDecision');
    const { prepareTask } = require('../modules/services/androidTaskExecutor');
    const task = prepareTask(C.taskFor(C.CASES.find(c => c.name === 'Toggle'), 'A'));
    const candidates = [{ candidateId: 'c0', action: { command: 'Tap', nodeRef: 'n0' }, description: 'toggle' }];
    const space = questionsFor(task, { observation: { id: '12345678-abcd-4234-abcd-123456789abc', digest: 'a'.repeat(64), contextDigest: 'b'.repeat(64) } }, candidates);
    assert.equal(select(C.response(space.questions, 'c0'), space, candidates).choice, 'c0');
});
test('loading oracle rejects a transient completion before final state', () => {
    const c = C.CASES.find(c => c.name === 'TransientCompletion'), task = C.taskFor(c, 'A');
    const receipt = { status: 'completed', independentlyVerified: true, counts: { mainModelCalls: 0, humanHandoffs: 0 } };
    const good = { starts: 1, finalDone: true, loading: false, pulses: 1 };
    C.verify(c, task, {}, { journey: good }, receipt, null, { calls: 2 });
    assert.throws(() => C.verify(c, task, {}, { journey: { ...good, finalDone: false } }, receipt, null, { calls: 2 }));
});
test('selected evidence never promotes model-only Done into task verified completion', () => {
    const c = C.CASES.find(c => c.name === 'SelectedState'), task = C.taskFor(c, 'A');
    const receipt = { status: 'unverified', independentlyVerified: false, counts: { mainModelCalls: 0, humanHandoffs: 0 } };
    C.verify(c, task, {}, { journey: { selected: true, selections: 1 } }, receipt, null, { calls: 2 });
    assert.throws(() => C.verify(c, task, {}, { journey: { selected: true, selections: 1 } }, { ...receipt, status: 'completed' }, null, {}));
});
