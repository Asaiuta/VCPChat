'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const S = require('./android-j02/storage.cjs');
const C = require('./android-device-suite/cases.cjs');
const { parseArgs, createDevice } = require('./android-device-suite/device.cjs');
const { createFaultProxy } = require('./android-device-suite/fault-proxy.cjs');
const { restartDevice: restartTestDevice } = require('./android-device-suite/restart.cjs');
const root = path.resolve(__dirname, '..'), lib = '../VCPDistributedServer/Plugin/AndroidController/lib/';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const FAULTS = ['CancelInFlight', 'DelayedResponse', 'DroppedResponse', 'KillOwnedProcess'];
const SOAK = Object.freeze({ durationMs: 1800000, cadenceMs: 15000, cycleDeadlineMs: 60000, minCycles: 60,
    restartEvery: 10, maxRssBytes: 768 * 1048576, maxHeapBytes: 256 * 1048576,
    maxRssGrowthBytes: 128 * 1048576, maxHeapGrowthBytes: 64 * 1048576, maxThreadGrowth: 32, maxFdGrowth: 64 });
function processGone(device, binding) {
    const stat = device.exec(['shell', `if [ -d /proc/${binding.pid} ]; then cat /proc/${binding.pid}/stat; else echo ABSENT; fi`]);
    assert.ok(stat === 'ABSENT' || /^\d+ \(.+\) /.test(stat), 'Unreadable process identity');
    const gone = stat === 'ABSENT' || stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] !== binding.startTime;
    const tcp = device.exec(['shell', 'cat /proc/net/tcp /proc/net/tcp6']);
    const listening = tcp.split(/\r?\n/).some(line => { const f = line.trim().split(/\s+/);
        return f[3] === '0A' && [binding.port, binding.ownerPort].includes(parseInt(f[1]?.split(':')[1], 16)); });
    assert.ok(gone && !listening, 'Original owner process/listeners remain');
    return { pid: binding.pid, startTime: binding.startTime, gone, listening };
}
function killOwned(device, binding) {
    assert.ok(Number.isSafeInteger(binding.pid) && binding.pid > 0); assert.match(binding.startTime, /^\d+$/);
    assert.ok(binding.cmdline.includes('com.vcpchat.uiautomator.Owner'));
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    const command = `s=$(cat /proc/${binding.pid}/stat) && s=\${s##*) } && set -- $s && [ "\${20}" = ${quote(binding.startTime)} ]`
        + ` && [ "$(tr '\\000' ' ' < /proc/${binding.pid}/cmdline)" = ${quote(binding.cmdline.join(' ') + ' ')} ]`
        + ` && [ "$(stat -c %u /proc/${binding.pid})" = '${binding.uid}' ] && kill -9 ${binding.pid} && echo KILLED_OWNED`;
    assert.equal(device.exec(['shell', command]), 'KILLED_OWNED', 'Owner identity changed; kill refused');
}
async function main(argv = process.argv.slice(2)) {
    argv = [...argv]; const restartAt = argv.indexOf('--restart-device'), restartDevice = restartAt >= 0;
    if (restartDevice) argv.splice(restartAt, 1);
    const restartOptions = {};
    for (const [flag, key] of [['--mumu-manager', 'mumuManager'], ['--mumu-instance', 'mumuInstance']]) {
        const index = argv.indexOf(flag);
        if (index >= 0) { assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--')); restartOptions[key] = argv[index + 1]; argv.splice(index, 2); }
    }
    assert.equal(Boolean(restartOptions.mumuManager), restartOptions.mumuInstance !== undefined, 'MuMu manager and instance must be supplied together');
    if (restartOptions.mumuManager) {
        assert.ok(restartDevice); assert.match(restartOptions.mumuInstance, /^(0|[1-9]\d*)$/);
        restartOptions.mumuManager = path.resolve(restartOptions.mumuManager); assert.ok(fs.statSync(restartOptions.mumuManager).isFile());
    }
    const at = argv.indexOf('--mode'); assert.ok(at >= 0); const mode = argv[at + 1]; argv = [...argv]; argv.splice(at, 2);
    assert.ok(['faults', 'soak'].includes(mode)); if (mode === 'soak') assert.equal(typeof global.gc, 'function', 'Use node --expose-gc');
    if (mode === 'faults') assert.ok(restartDevice, 'Fault recovery requires explicit --restart-device and a dedicated device');
    const options = { ...parseArgs(argv), ...restartOptions }; assert.equal(options.matrix, 'journeys'); assert.ok(!options.only);
    assert.ok(!options.mumuManager || mode === 'faults');
    fs.mkdirSync(options.output);
    let current = null;
    const emit = (type, data) => fs.appendFileSync(path.join(options.output, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), type, case: current, data }) + '\n');
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === '.build' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    const identity = S.snapshot([...S.inventory(root), ...walk(path.join(__dirname, 'android-device-suite')), ...walk(path.join(__dirname, 'android-m15-fixture')),
        __filename, path.join(__dirname, 'android-j02/storage.cjs'), path.join(__dirname, 'android-j02/contract.cjs'), path.join(__dirname, 'verify-android-m15.cjs'), options.apk, options.peerApk,
        ...(options.mumuManager ? [options.mumuManager] : [])]);
    S.write(path.join(options.output, 'freeze.json'), { version: 3, mode, options, identity, cases: FAULTS, soak: SOAK,
        recovery: { restartDevice, backend: options.mumuManager ? 'mumu-instance' : 'adb', bootDeadlineMs: 120000, sameBootMustRemainBlocked: true, separateHostProcessMustRemainBlocked: true, noAutomaticCancel: true },
        action: { target: C.id('jd_touch'), faultHoldMs: 4000, responseFaultHoldMs: 800, timeoutMs: 6000, delayMs: 7000 },
        checks: ['independent touch counters', 'unknown nonretryable receipt', 'blocked subsequent write', 'late response cannot clear quarantine', 'explicit recovery', 'original process and listeners absent', 'forwards restored'],
        retries: 0, realModelRequests: 0, providerCalls: 0, calibrated: false });
    const device = createDevice(options, emit), service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
    const runtime = require(lib + 'step-runtime'), { RemoteOwner } = require(lib + 'ui-owner'), { HttpRpcTransport } = require(lib + 'ui-transport');
    const original = HttpRpcTransport.prototype.call;
    let proxy = null, targetPort = null, initialized = false, fatal = null, baseline = null, cycles = 0, actualDurationMs = null;
    const results = [], owners = [];
    // Scope the wire seam to this process, explicit serial, and the captured owner port.
    HttpRpcTransport.prototype.call = function(...args) {
        if (!proxy || this.serial !== options.serial || this.port !== targetPort) return original.apply(this, args);
        const port = this.port; this.port = proxy.port;
        try { return original.apply(this, args); } finally { this.port = port; }
    };
    const forwards = () => device.exec(['forward', '--list']).split(/\r?\n/).filter(Boolean).sort();
    let initialForwards;
    const observe = () => service.processToolCall({ command: 'Observe', serial: options.serial, mode: 'ui', wake: 'never', timeoutMs: 20000 });
    const action = (duration, signal) => service.processToolCall({ command: 'ExecuteStep', serial: options.serial, timeoutMs: 6000,
        action: { command: 'LongPress', id: C.id('jd_touch'), duration } }, { signal });
    const owner = () => { const o = RemoteOwner.identityFor(options.serial); assert.equal(o?.status, 'bound'); assert.equal(o.binding.endpointProof, 'socket_inode'); return o.binding; };
    async function drain() {
        const end = performance.now() + 10000;
        for (;;) {
            try { runtime.assertManagementIdle(); const q = service.getRuntimeStatus().adbQueue;
                assert.ok(q && !q.depth && !q.pending && !q.running); assert.equal(runtime.takeoverStatus().inFlight, 0); return; }
            catch (e) { if (performance.now() >= end) throw e; await pause(100); }
        }
    }
    async function initialize() {
        initialized = true;
        await service.initialize({ dataDir: path.join(options.output, 'state'), config: { ADB_PATH: options.adb, DEVICE_SERIAL: options.serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0 },
            logger: { log() {}, warn() {}, error() {} } });
    }
    async function stop() {
        if (!initialized) return;
        const b = RemoteOwner.identityFor(options.serial)?.binding;
        await drain(); await service.cleanup(); initialized = false;
        if (b) emit('owner-gone', processGone(device, b));
        assert.equal(RemoteOwner.identityFor(options.serial), null); assert.deepEqual(forwards(), initialForwards);
    }
    const readSame = session => { const state = device.read(); assert.equal(state.session, session); return state.journey; };
    try {
        await device.prepare(); initialForwards = forwards();
        const info = {}; for (const p of ['ro.product.model', 'ro.build.fingerprint', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.product.cpu.abi']) info[p] = device.exec(['shell', 'getprop', p]);
        S.write(path.join(options.output, 'device.json'), info);
        if (mode === 'faults') {
            for (const name of FAULTS) {
                current = name; assert.ok(S.unchanged(identity), 'Source drift');
                const initial = device.reset('touch'); await initialize(); await observe(); await drain();
                const b = owner(); owners.push(b); emit('owner', b); targetPort = b.port;
                proxy = await createFaultProxy({ upstreamPort: b.port, mode: name === 'DelayedResponse' ? 'delay' : name === 'DroppedResponse' ? 'drop' : 'pass', emit });
                const controller = new AbortController(), activeFault = ['CancelInFlight', 'KillOwnedProcess'].includes(name);
                let settled = false;
                const pending = action(activeFault ? 4000 : 800, controller.signal).then(value => ({ value }), error => ({ error })).then(receipt => {
                    emit('receipt', { result: receipt.value?.details, error: receipt.error && { code: receipt.error.code, execution: receipt.error.execution } });
                    settled = true; return receipt;
                });
                if (activeFault) {
                    const end = performance.now() + 7000;
                    for (;;) { const state = await device.readAsync(); assert.equal(state.session, initial.session); const j = state.journey; if (j.activeTouch && j.downCount === 1) break;
                        assert.ok(!settled && performance.now() < end, 'No independently observed in-flight touch'); await pause(60); }
                    emit('in-flight', { runtime: runtime.takeoverStatus() }); assert.ok(runtime.takeoverStatus().inFlight > 0);
                    if (name === 'CancelInFlight') controller.abort(); else killOwned(device, b);
                    emit('fault-injected', { name, pid: b.pid });
                }
                const receipt = await pending;
                assert.ok(receipt.error, 'Fault must not produce success'); assert.equal(receipt.error.execution?.outcome, 'unknown');
                assert.equal(receipt.error.execution.retryable, false); await drain();
                assert.ok(service.getRuntimeStatus().quarantinedDevices.includes(options.serial));
                await assert.rejects(action(800), { code: 'DEVICE_STATE_UNCERTAIN' });
                // Wait past both original gesture and delayed response; no acceptance may arrive later.
                await pause(name === 'DelayedResponse' ? 7500 : 4500);
                const after = readSame(initial.session); emit('post-fault', after);
                assert.equal(after.downCount, 1); assert.ok(after.upCount <= 1 && after.holdCount <= 1 && after.tapCount === 0);
                assert.ok(service.getRuntimeStatus().quarantinedDevices.includes(options.serial));
                await assert.rejects(action(800), { code: 'DEVICE_STATE_UNCERTAIN' });
                const stats = proxy.stats(); assert.equal(stats.writes, 1); assert.equal(stats.pendingTimers, 0);
                if (name === 'DelayedResponse') assert.equal(stats.delayed, 1);
                if (name === 'DroppedResponse') assert.equal(stats.dropped, 1);
                await proxy.close(); proxy = null;
                let blocked;
                try { await service.processToolCall({ command: 'Manage', operation: 'recoverOwner', serial: options.serial }); }
                catch (error) { blocked = error; }
                assert.equal(blocked?.code, 'DEVICE_INPUT_STATE_UNCERTAIN'); assert.equal(blocked.details.ownerReleased, true);
                emit('recovery-blocked', { code: blocked.code, details: blocked.details }); emit('owner-gone', processGone(device, b));
                assert.equal(RemoteOwner.identityFor(options.serial), null);
                await assert.rejects(action(800), { code: 'DEVICE_STATE_UNCERTAIN' });
                assert.deepEqual(forwards(), initialForwards);
                await stop();
                const child = await new Promise((resolve, reject) => execFile(process.execPath,
                    [path.join(__dirname, 'android-device-suite/recovery-child.cjs'), path.join(options.output, 'state'), options.adb, options.serial],
                    { timeout: 30000, windowsHide: true }, (e, stdout, stderr) => e ? reject(e) : resolve(JSON.parse(stdout))));
                emit('separate-process-blocked', child); assert.equal(readSame(initial.session).downCount, 1);
                const oldBoot = device.exec(['shell', 'cat', '/proc/sys/kernel/random/boot_id']);
                const end = performance.now() + 120000;
                emit('device-restart', { oldBoot, serial: options.serial }); restartTestDevice(device, options, emit);
                let newBoot;
                for (;;) {
                    try {
                        newBoot = device.exec(['shell', 'cat /proc/sys/kernel/random/boot_id && getprop sys.boot_completed']);
                        if (newBoot.endsWith('\n1') && newBoot.split(/\r?\n/)[0] !== oldBoot) break;
                    } catch { /* Bounded boot wait, never action retry. */ }
                    assert.ok(performance.now() < end, 'Device boot deadline'); await pause(1000);
                }
                emit('device-restarted', { newBoot });
                const fresh = device.reset('touch'); await initialize();
                const recovered = await service.processToolCall({ command: 'Manage', operation: 'recoverOwner', serial: options.serial });
                assert.equal(recovered.details.owner.inputRecovery.proof, 'same_device_new_boot'); emit('recovery', recovered.details);
                assert.deepEqual(service.getRuntimeStatus().quarantinedDevices, []);
                await observe(); const next = owner(); assert.notEqual(`${next.pid}:${next.startTime}`, `${b.pid}:${b.startTime}`);
                const completed = await action(800); assert.ok(['verified', 'dispatched'].includes(completed.details.execution.outcome)); await drain();
                const restartedTouch = readSame(fresh.session); C.verifyTouch('Hold800', fresh.journey, restartedTouch); await stop();
                const result = { name, status: 'PASS', wire: stats, independent: after, ownerGone: true };
                results.push(result); emit('case', result); console.log(JSON.stringify({ name, status: 'PASS' }));
            }
        } else {
            current = 'soak'; const initial = device.reset('touch'); await initialize(); await observe();
            const start = performance.now(), end = start + SOAK.durationMs;
            while (performance.now() < end) {
                const cycleStart = performance.now(); assert.ok(S.unchanged(identity), 'Source drift'); device.gate(C.PACKAGE);
                const before = readSame(initial.session), r = await action(800); assert.ok(['dispatched', 'verified'].includes(r.details.execution.outcome));
                await drain(); const after = readSame(initial.session);
                assert.equal(after.downCount, before.downCount + 1); assert.equal(after.upCount, before.upCount + 1);
                assert.equal(after.holdCount, before.holdCount + 1); assert.equal(after.cancelCount, 0); assert.equal(after.tapCount, 0); assert.equal(after.activeTouch, false);
                assert.ok(after.durationMs >= 700 && after.durationMs <= 1300);
                assert.deepEqual(service.getRuntimeStatus().quarantinedDevices, []);
                const b = owner(); if (!owners.some(x => x.pid === b.pid && x.startTime === b.startTime)) owners.push(b);
                const status = device.exec(['shell', 'cat', `/proc/${b.pid}/status`]);
                const threads = Number(/^Threads:\s+(\d+)$/m.exec(status)?.[1]); assert.ok(threads > 0);
                const fds = device.exec(['shell', 'ls', `/proc/${b.pid}/fd`]).split(/\s+/).filter(Boolean).length;
                global.gc(); const memory = process.memoryUsage();
                baseline ||= { ...memory, threads, fds };
                assert.ok(memory.rss <= SOAK.maxRssBytes && memory.heapUsed <= SOAK.maxHeapBytes, 'Absolute host memory gate');
                assert.ok(memory.rss - baseline.rss <= SOAK.maxRssGrowthBytes && memory.heapUsed - baseline.heapUsed <= SOAK.maxHeapGrowthBytes, 'Host memory growth gate');
                assert.ok(threads - baseline.threads <= SOAK.maxThreadGrowth && fds - baseline.fds <= SOAK.maxFdGrowth, 'Owner resource growth gate');
                cycles++;
                if (cycles % SOAK.restartEvery === 0) { await stop(); await initialize(); await observe(); }
                const elapsedMs = performance.now() - cycleStart; assert.ok(elapsedMs <= SOAK.cycleDeadlineMs, 'Cycle deadline');
                const record = { cycle: cycles, elapsedMs, sinceStartMs: performance.now() - start, memory, threads, fds, pid: b.pid, downCount: after.downCount };
                emit('soak-cycle', record); console.log(JSON.stringify(record));
                await pause(Math.max(0, Math.min(SOAK.cadenceMs - elapsedMs, end - performance.now())));
            }
            actualDurationMs = performance.now() - start; assert.ok(cycles >= SOAK.minCycles); await stop();
            results.push({ name: 'Fixed30MinuteSoak', status: 'PASS', cycles, actualDurationMs });
        }
        for (const [pkg, apk] of [[C.PACKAGE, options.apk], [C.PEER, options.peerApk]]) assert.equal(device.apkSha(pkg), S.sha(fs.readFileSync(apk)));
    } catch (e) { fatal = { case: current, code: e.code || 'ASSERTION', message: e.message, stack: e.stack }; emit('fatal', fatal); }
    finally {
        try { if (proxy) await proxy.close(); proxy = null; await stop(); } catch (e) { emit('cleanup-failed', { code: e.code, message: e.message }); fatal ||= { code: 'CLEANUP_FAILED', message: e.message }; }
        HttpRpcTransport.prototype.call = original;
    }
    const summary = { mode, results, fatal, sourceUnchanged: S.unchanged(identity), cycles, actualDurationMs, ownerGenerations: owners.length,
        selected: mode === 'faults' ? FAULTS.length : 1, passed: results.length, realModelRequests: 0, providerCalls: 0, acceptanceSamples: 0, calibrated: false };
    S.write(path.join(options.output, 'result.json'), summary); console.log(JSON.stringify(summary));
    return { exitCode: Number(Boolean(fatal) || !summary.sourceUnchanged || summary.passed !== summary.selected), summary };
}
module.exports = { main, SOAK, FAULTS, processGone, killOwned };
if (require.main === module) main().then(r => { process.exitCode = r.exitCode; }).catch(e => { console.error(e.stack); process.exitCode = 1; });
