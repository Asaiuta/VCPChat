'use strict';

// Device acceptance: read-only UI RPCs, exact acquired forward removal, local
// child termination, and optional targeted adb reconnect. Never kills a remote PID.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { AdbTransport } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-transport');
const { AdbOwnerBackend } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-owner');
const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const serial = args.includes('--serial') ? value('--serial') : null;
const adbPath = args.includes('--adb') ? value('--adb') : 'adb';
if (!serial) throw Error('--serial is required');
if (args.includes('--wireless-reconnect') && !/^[\d.]+:\d+$/.test(serial)) {
    throw Error('--wireless-reconnect requires the current IP:port serial from adb mdns services');
}
const make = () => new AdbTransport({ adbPath, serial });
const adb = argv => exec(adbPath, argv, { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });

if (args.includes('--child')) {
    const transport = make();
    transport.start().then(result => {
        assert.equal(result.ok, true, JSON.stringify(result));
        process.send({ binding: result.owner.binding, ownerForward: transport._owner.backend.ownerForward });
        // The parent intentionally terminates this exact host, without stop().
        setInterval(() => {}, 1000);
    }).catch(error => { process.send({ error: error.message }); process.exit(1); });
} else {
    const out = path.resolve(args.includes('--out') ? value('--out') : 'artifacts/android-owner-rebind-device');
    fs.mkdirSync(out, { recursive: true });
    const evidence = { startedAt: new Date().toISOString(), serial, cases: [],
        ownerJarSha256: createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,
            '../VCPDistributedServer/Plugin/AndroidController/vendor/vcp-ui-owner.jar'))).digest('hex') };
    const record = (name, details) => {
        evidence.cases.push({ name, ...details });
        fs.writeFileSync(path.join(out, 'device-result.json'), JSON.stringify(evidence, null, 2) + '\n');
        console.log(JSON.stringify({ name, ...details }));
    };
    const transport = make();
    const server = new UiServer({ transport });
    let child;
    async function tree() {
        const { xml } = await server.dump({ timeoutMs: 15000 });
        assert.ok(xml.includes('<hierarchy'));
        return { xmlBytes: Buffer.byteLength(xml), xmlSha256: createHash('sha256').update(xml).digest('hex') };
    }
    async function start() {
        const result = await transport.start();
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.owner.binding;
    }
    async function waitFor(predicate, timeoutMs = 40000) {
        const deadline = Date.now() + timeoutMs;
        do {
            if (await predicate()) return;
            await sleep(500);
        } while (Date.now() < deadline);
        throw Error('Timed out waiting for independent state');
    }
    const unauthorizedInfo = port => new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        let reply = '';
        const finish = () => { socket.destroy(); resolve(reply.trim()); };
        socket.setTimeout(2000, finish);
        socket.on('connect', () => socket.write(`INFO ${'0'.repeat(64)}\n`));
        socket.on('data', chunk => { reply += chunk; if (reply.includes('\n')) finish(); });
        socket.on('error', finish);
        socket.on('close', finish);
    });
    (async () => {
        const { stdout: processes } = await adb(['-s', serial, 'shell', 'ps -A -o ARGS']);
        assert.equal(processes.split(/\r?\n/).some(line => /com\.vcpchat\.uiautomator\.Owner|com\.github\.uiautomator2\.Console/.test(line)), false,
            'another owner is already active; do not disturb it');
        evidence.forwardsBefore = (await adb(['forward', '--list'])).stdout.trim();
        let binding = await start();
        record('startup_tree', { binding, ...await tree() });
        await sleep(32000);
        assert.equal(transport.isReady(), true);
        assert.equal(transport.ownerIdentity.binding.pid, binding.pid);
        record('healthy_lease_beyond_30s', { binding, ...await tree() });

        let old = transport._owner;
        await transport._exec(['forward', '--remove', `tcp:${old.backend.ownerForward}`]);
        const exited = once(transport._proc, 'exit');
        transport._proc.kill();
        await exited;
        assert.equal(transport.isReady(), false);
        binding = await start();
        assert.equal(old.status, 'released');
        assert.equal((await old.backend.inspect(old._context())).gone, true);
        assert.notEqual(binding.startTime, old.binding.startTime);
        record('lost_forward_and_adb_child_rebind', { previous: old.binding, binding, independentGone: true, ...await tree() });

        if (args.includes('--wireless-reconnect')) {
            old = transport._owner;
            await adb(['-s', serial, 'reconnect']);
            await adb(['connect', serial]);
            await waitFor(async () => {
                try { return (await adb(['-s', serial, 'get-state'])).stdout.trim() === 'device'; }
                catch { return false; }
            });
            await waitFor(() => !transport.isReady(), 10000);
            binding = await start();
            assert.equal(old.status, 'released');
            assert.equal((await old.backend.inspect(old._context())).gone, true);
            record('wireless_adb_reconnect', { previous: old.binding, binding, independentGone: true, ...await tree() });
        }
        // Keep adb alive while suppressing only authenticated host renewals. This
        // proves the device watchdog, separately from adb/OS child termination.
        old = transport._owner;
        old.backend.stopHeartbeat();
        let exitCode;
        transport._proc.once('exit', code => { exitCode = code; });
        const leaseLostAt = Date.now();
        let denied = 0, nextUnauthorizedAt = 0;
        await waitFor(async () => {
            if ((await old.backend.inspect(old._context())).gone) return true;
            if (Date.now() >= nextUnauthorizedAt) {
                if (await unauthorizedInfo(old.backend.ownerForward) === 'DENIED') denied++;
                nextUnauthorizedAt = Date.now() + 4000;
            }
            return false;
        });
        await waitFor(() => exitCode !== undefined, 5000);
        const leaseElapsedMs = Date.now() - leaseLostAt;
        assert.ok(leaseElapsedMs >= 25000 && leaseElapsedMs < 40000, String(leaseElapsedMs));
        assert.equal(exitCode, 71);
        assert.ok(denied >= 5, 'unauthenticated INFO cannot renew the owner lease');
        assert.equal((await transport.recoverOwner()).status, 'released');
        record('lease_expiry_with_live_adb', { binding: old.binding, elapsedMs: leaseElapsedMs,
            exitCode, deniedRenewals: denied, independentGone: true });
        assert.equal((await transport.stop()).status, 'released');

        child = fork(__filename, ['--child', '--serial', serial, '--adb', adbPath], { windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const receipt = await Promise.race([
            once(child, 'message').then(([message]) => message),
            once(child, 'exit').then(([code]) => { throw Error('child exited before binding: ' + code); }),
        ]);
        assert.ok(!receipt.error, receipt.error);
        const orphan = new AdbOwnerBackend(transport);
        orphan.announcement = { ...receipt.binding, port: receipt.binding.ownerPort };
        orphan.rpcPort = receipt.binding.port;
        const context = { serial, nonce: 'independent-inspection-only' };
        assert.equal((await orphan.inspect(context)).gone, false);
        const childExited = once(child, 'exit');
        const deathAt = Date.now();
        child.kill();
        await childExited;
        child = null;
        await waitFor(async () => (await orphan.inspect(context)).gone);
        const elapsedMs = Date.now() - deathAt;
        assert.ok(elapsedMs <= 40000);
        await transport._removeForward(receipt.ownerForward, receipt.binding.ownerPort);
        await transport._removeForward(receipt.binding.port);
        record('host_death_owner_disappeared', { binding: receipt.binding, elapsedMs, independentGone: true });
        const { stdout: cli } = await adb(['-s', serial, 'exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty']);
        assert.ok(cli.includes('<hierarchy'));
        record('cli_after_host_death', { exitCode: 0, xmlBytes: Buffer.byteLength(cli),
            xmlSha256: createHash('sha256').update(cli).digest('hex') });
        binding = await start();
        record('fresh_host_rebind_after_host_death', { binding, ...await tree() });
        assert.equal((await transport.stop()).status, 'released');
        evidence.forwardsAfter = (await adb(['forward', '--list'])).stdout.trim();
        assert.equal(evidence.forwardsAfter, evidence.forwardsBefore, 'no acquired forwards remain');
        evidence.passed = true;
    })().catch(error => {
        evidence.passed = false;
        evidence.error = error.stack;
        console.error(error.stack);
        process.exitCode = 1;
    }).finally(async () => {
        if (child) child.kill();
        evidence.finalOwner = await transport.stop();
        evidence.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(out, 'device-result.json'), JSON.stringify(evidence, null, 2) + '\n');
    });
}
