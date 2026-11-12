'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const S = require('./android-j02/storage.cjs');
const C = require('./android-device-suite/cases.cjs');
const { parseArgs, createDevice } = require('./android-device-suite/device.cjs');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function sourceFiles(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === '.build' ? [] : e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const chosen = options.only ? options.only.split(',') : null;
    const names = options.matrix === 'journeys' ? C.CASES.map(c => c.name) : options.matrix === 'm5' ? require('./verify-android-m5.cjs').CASES : require('./verify-android-m15.cjs').SUITE_CASE_NAMES;
    assert.ok(!chosen || options.matrix !== 'm5' && chosen.length && new Set(chosen).size === chosen.length && chosen.every(n => names.includes(n)), 'Invalid selection');
    for (const file of [options.adb, options.apk, ...(options.peerApk ? [options.peerApk] : [])]) assert.ok(fs.statSync(file).isFile());
    // Exclusive creation prevents accidental overwrite or replay of any earlier batch.
    fs.mkdirSync(options.output); fs.mkdirSync(path.join(options.output, 'traces'));
    let current = null;
    const emit = (type, data) => fs.appendFileSync(path.join(options.output, 'events.jsonl'), JSON.stringify({ type, case: current?.name || null, data }) + '\n');
    const identity = S.snapshot([...S.inventory(root), ...sourceFiles(path.join(__dirname, 'android-device-suite')),
        ...sourceFiles(path.join(__dirname, 'android-m15-fixture')), __filename, path.join(__dirname, 'android-j02/storage.cjs'),
        path.join(__dirname, 'android-j02/contract.cjs'), path.join(__dirname, 'verify-android-m5.cjs'), path.join(__dirname, 'verify-android-m15.cjs'), options.apk, ...(options.peerApk ? [options.peerApk] : [])]);
    const cases = C.CASES.filter(c => !chosen || chosen.includes(c.name));
    S.write(path.join(options.output, 'freeze.json'), { version: 1, options, identity, names: chosen || names,
        tasks: options.matrix === 'journeys' ? cases.map(c => ({ ...c, task: C.taskFor(c, options.serial) })) : [],
        directTouch: { durationsMs: [800, 2000, 4000], toleranceMs: [-100, 500], actionTimeoutMs: 20000, cancel: 'one external DOWN followed by CANCEL on observed fixture target' },
        retries: 0, policy: require('../modules/services/androidTaskPolicy').UI_TASK_POLICY,
        model: 'deterministic-device-fixture', realModelRequests: 0, calibrated: false });
    const device = createDevice(options, emit), results = [];
    let service, runtime, initialized = false, currentContext, fatal = null;
    async function drain() {
        const end = Date.now() + 10000;
        for (;;) {
            try { runtime.assertManagementIdle(); const q = service.getRuntimeStatus().adbQueue; assert.ok(q && q.depth === 0 && q.pending === 0 && q.running === false); return; }
            catch (e) { if (Date.now() >= end) throw Object.assign(Error('Runtime not drained'), { code: 'RUNTIME_NOT_DRAINED' }); await pause(100); }
        }
    }
    try {
        await device.prepare();
        const info = {};
        for (const prop of ['ro.product.model', 'ro.build.fingerprint', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.product.cpu.abi']) info[prop] = device.exec(['shell', 'getprop', prop]);
        S.write(path.join(options.output, 'device.json'), info);
        if (options.matrix !== 'journeys') {
            device.reset(options.matrix === 'm5' ? 'm5:home' : 'gestures');
            const runner = require(`./verify-android-${options.matrix}.cjs`);
            const outcome = await runner.main(['--suite', '--serial', options.serial, '--adb', options.adb,
                ...(options.matrix === 'm5' ? ['--output', options.output] : []), ...(chosen ? ['--only', chosen.join(',')] : [])], {
                spawnSync: device.legacySpawn, emit: data => { emit('legacy', data); if (data.phase === 'case') { results.push(data); console.log(JSON.stringify(data)); } },
            });
            if (outcome.exitCode) fatal = { code: 'LEGACY_SUITE_FAILED' };
        } else {
            service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
            runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
            const { createAndroidTaskExecutor } = require('../modules/services/androidTaskExecutor');
            const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
            const jev = { async decide(state, questions, request) {
                const ctx = currentContext; ctx.calls++; emit('provider', { state, questions, calls: ctx.calls });
                try { return await C.decide(current, state, questions, request, ctx); }
                catch (e) { emit('provider-error', { code: e.code, message: e.message }); throw e; }
            } };
            initialized = true;
            await service.initialize({ config: { ADB_PATH: options.adb, DEVICE_SERIAL: options.serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0 },
                services: { androidTaskExecutor: createAndroidTaskExecutor({ jev, traceStore: createTaskTraceStore({ directory: path.join(options.output, 'traces') }) }) }, logger: { log() {}, warn() {}, error() {} } });
            for (const c of cases) {
                current = c;
                try {
                    assert.ok(S.unchanged(identity), 'Source drift'); await drain();
                    const initial = device.reset(c.variant), session = initial.session;
                    const ctx = currentContext = { calls: 0, controller: new AbortController(), providerAborted: false, injected: false, secondFilled: false,
                        adb: device.exec, read() { const s = device.read(); assert.equal(s.session, session); return s; } };
                    if (c.name === 'StaleBeforeFill') {
                        const r = await service.processToolCall({ command: 'ExecuteStep', serial: options.serial, timeoutMs: 20000, action: { command: 'Tap', id: C.id('m5_query') } });
                        emit('preparation', r.details.execution); assert.ok(['verified', 'dispatched'].includes(r.details.execution.outcome)); await drain();
                    }
                    const before = ctx.read();
                    if (c.name === 'LaunchApp') device.launchPeer();
                    if (C.direct(c)) {
                        device.gate(C.PACKAGE);
                        if (c.name === 'TouchCancel') {
                            const observed = await service.processToolCall({ command: 'Observe', serial: options.serial, mode: 'ui', wake: 'never', includeCoordinates: true, timeoutMs: 20000 });
                            const nodes = observed.details.controls.filter(n => n.id === C.id('jd_touch')); assert.equal(nodes.length, 1);
                            const n = nodes[0]; assert.ok(n.enabled && n.inViewport); const b = n.clipped;
                            const x = String(Math.floor((b.left + b.right) / 2)), y = String(Math.floor((b.top + b.bottom) / 2));
                            let down = false;
                            try { device.exec(['shell', 'input', 'motionevent', 'DOWN', x, y]); down = true; }
                            finally { if (down) device.exec(['shell', 'input', 'motionevent', 'CANCEL', x, y]); }
                            emit('external-touch', { sequence: ['DOWN', 'CANCEL'], x, y });
                        } else {
                            const r = await service.processToolCall({ command: 'ExecuteStep', serial: options.serial, timeoutMs: 20000,
                                action: { command: 'LongPress', id: C.id('jd_touch'), duration: Number(c.name.slice(4)) } });
                            emit('receipt', r.details); assert.ok(['dispatched', 'verified'].includes(r.details.execution.outcome));
                        }
                        await drain(); device.gate(C.PACKAGE); C.verifyTouch(c.name, before.journey, ctx.read().journey);
                    } else {
                        const task = C.taskFor(c, options.serial); let result, error;
                        try { result = await service.processToolCall({ command: 'RunTask', task }, { signal: ctx.controller.signal }); } catch (e) { error = e; }
                        await drain(); device.gate(C.PACKAGE); const after = ctx.read();
                        if (c.name === 'LaunchApp') assert.equal(device.read(C.PEER).resumed, false);
                        emit('receipt', { task: result?.details.task, error: error?.code });
                        C.verify(c, task, before, after, result?.details.task, error, ctx);
                    }
                    results.push({ name: c.name, status: 'PASS', providerCalls: ctx.calls });
                } catch (e) { results.push({ name: c.name, status: 'NOT_PASSED', code: e.code || 'ASSERTION', message: e.message }); }
                emit('case', results.at(-1)); console.log(JSON.stringify(results.at(-1)));
                if (results.at(-1).status !== 'PASS') break;
            }
        }
        for (const [pkg, apk] of [[C.PACKAGE, options.apk], ...(options.peerApk ? [[C.PEER, options.peerApk]] : [])]) assert.equal(device.apkSha(pkg), S.sha(fs.readFileSync(apk)), 'APK changed during batch');
    } catch (e) { fatal = { code: e.code || 'ERROR', message: e.message }; emit('fatal', fatal); }
    finally {
        if (initialized) try {
            await drain(); let timer;
            try { await Promise.race([service.cleanup(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(Error('Cleanup deadline'), { code: 'CLEANUP_DEADLINE' })), 15000);
            })]); } finally { clearTimeout(timer); }
            emit('cleanup', { done: true });
        } catch (e) { fatal = { code: e.code || 'CLEANUP_FAILED', message: e.message }; }
    }
    const count = chosen?.length || names.length, passed = results.filter(r => r.status === 'PASS').length;
    const summary = { matrix: options.matrix, results, selected: count, passed, failed: results.length - passed, notExecuted: count - results.length,
        explicitSelection: Boolean(chosen), sourceUnchanged: S.unchanged(identity), fatal, realModelRequests: 0, acceptanceSamples: 0, calibrated: false };
    S.write(path.join(options.output, 'result.json'), summary); console.log(JSON.stringify(summary));
    return { exitCode: Number(Boolean(fatal) || passed !== count || !summary.sourceUnchanged), summary };
}
module.exports = { main };
if (require.main === module) main().then(r => { process.exitCode = r.exitCode; }).catch(e => { console.error(e.message); process.exitCode = 1; });
