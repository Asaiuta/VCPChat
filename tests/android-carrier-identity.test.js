'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AdbTransport, vendorApkPath } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-transport');
const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
const { EventEmitter } = require('node:events');
const { ownerWorld } = require('./helpers/android-owner-world.cjs');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const localHash = digest(vendorApkPath());
const remotePath = hash => `/data/local/tmp/vcp-u2-${hash}.apk`;

function fixture(t, options = {}) {
    const owner = ownerWorld();
    const transport = new AdbTransport({ serial: 'offline-only', localApk: options.localApk,
        ownerBackendFactory: owner.backendFactory });
    const calls = [];
    const remote = new Map(options.absent ? [] : [[remotePath(localHash), options.remoteHash || localHash]]);
    let spawns = 0;
    transport._exec = async args => {
        const ownerResponse = owner.exec(args);
        if (ownerResponse) return ownerResponse;
        calls.push(args);
        if (args[0] === 'push') {
            if (options.pushFailure) throw Object.assign(new Error('push failed'), { code: 'UI_SERVER_ADB_FAILED' });
            remote.set(args[2], options.corruptPush ? 'f'.repeat(64) : digest(args[1]));
            return { stdout: '1 file pushed', stderr: '' };
        }
        if (args[0] === 'shell') {
            if (options.probeFailure) throw Object.assign(new Error('disconnected'), { code: 'UI_SERVER_ADB_FAILED' });
            const file = /'([^']+\.apk)'/.exec(args[1])?.[1];
            assert.ok(file, 'probe must use a quoted content-addressed APK path');
            if (!remote.has(file)) return { stdout: 'ABSENT\n', stderr: '' };
            if (options.probeOutput !== undefined) return { stdout: options.probeOutput, stderr: '' };
            return { stdout: `${remote.get(file)}  ${file}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
    transport._pickPort = async () => 41000;
    transport._spawnServer = (port, generation, nonce) => {
        spawns++;
        const proc = new EventEmitter();
        proc.killed = false;
        proc.kill = () => { proc.killed = true; };
        return owner.launch(proc, port, nonce);
    };
    transport._waitReady = async () => true;
    t.after(() => transport.stop());
    return { transport, calls, remote, get spawns() { return spawns; } };
}

test('matching remote contents are verified without push and cached only within this generation', async t => {
    const h = fixture(t);
    const first = await h.transport.start();
    assert.equal(first.ok, true);
    assert.equal(h.transport.remoteApk, remotePath(localHash));
    assert.deepEqual(first.carrier, {
        status: 'verified', scope: 'startup_file', generation: h.transport.generation,
        expectedSha256: localHash, actualSha256: localHash, reason: null,
    });
    assert.ok(Object.isFrozen(first.carrier));
    assert.equal(h.calls.filter(args => args[0] === 'push').length, 0);
    const probes = h.calls.filter(args => args[0] === 'shell').length;
    assert.equal((await h.transport.start()).carrier, first.carrier);
    assert.equal(h.calls.filter(args => args[0] === 'shell').length, probes);
    assert.equal(h.spawns, 1);
    await h.transport.stop();
    assert.equal(h.transport.carrierIdentity, null, 'stopped generation must not retain a current binding');
    assert.equal((await h.transport.start()).ok, true);
    assert.notEqual(h.transport.carrierIdentity.generation, first.carrier.generation);
    assert.equal(h.calls.filter(args => args[0] === 'shell').length, probes + 1);
});

for (const absent of [false, true]) test(`${absent ? 'missing' : 'mismatched'} file is pushed once and verified again before spawn`, async t => {
    const h = fixture(t, { absent, remoteHash: 'a'.repeat(64) });
    const result = await h.transport.start();
    assert.equal(result.ok, true);
    assert.equal(result.carrier.status, 'verified');
    assert.equal(result.carrier.actualSha256, localHash);
    assert.equal(h.calls.filter(args => args[0] === 'push').length, 1);
    assert.equal(h.calls.filter(args => args[0] === 'shell').length, 2);
    assert.equal(h.spawns, 1);
});

test('push success is not content evidence: mismatched readback refuses startup', async t => {
    const h = fixture(t, { absent: true, corruptPush: true });
    const result = await h.transport.start();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UI_SERVER_CARRIER_MISMATCH');
    assert.equal(result.carrier.status, 'mismatch');
    assert.equal(result.carrier.actualSha256, 'f'.repeat(64));
    assert.equal(h.spawns, 0);
    assert.equal(h.transport.isReady(), false);
});

for (const output of ['UNREADABLE\n', 'PRESENT\n', `${localHash}  /wrong.apk\n`, `${localHash}  ${remotePath(localHash)}\nnoise`]) {
    test(`unverifiable remote output stays unknown, never package-version or existence evidence: ${JSON.stringify(output)}`, async t => {
        const h = fixture(t, { probeOutput: output });
        const result = await h.transport.start();
        assert.equal(result.ok, true, 'unavailable hashing alone is not a compatibility veto');
        assert.equal(result.carrier.status, 'unknown');
        assert.equal(result.carrier.actualSha256, null);
        assert.ok(result.carrier.reason);
        assert.equal(h.calls.some(args => /dumpsys package|\binstall\b/.test(args.join(' '))), false);
    });
}

for (const options of [{ probeFailure: true }, { absent: true, pushFailure: true }]) {
    test(`transport failure is not a hash-unavailable downgrade ${JSON.stringify(options)}`, async t => {
        const h = fixture(t, options);
        const result = await h.transport.start();
        assert.equal(result.ok, false);
        assert.equal(result.code, 'UI_SERVER_ADB_FAILED');
        assert.equal(h.spawns, 0);
    });
}

test('changing the local carrier between generations changes the remote content address', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-carrier-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'carrier.apk');
    fs.writeFileSync(file, 'carrier-one');
    const h = fixture(t, { localApk: file, absent: true });
    const first = await h.transport.start();
    assert.equal(first.ok, true);
    assert.equal(first.carrier.expectedSha256, digest(file));
    const firstPath = h.transport.remoteApk;
    await h.transport.stop();
    fs.writeFileSync(file, 'carrier-two');
    const second = await h.transport.start();
    assert.equal(second.ok, true);
    assert.equal(second.carrier.expectedSha256, digest(file));
    assert.notEqual(second.carrier.expectedSha256, first.carrier.expectedSha256);
    assert.notEqual(h.transport.remoteApk, firstPath, 'do not overwrite the old generation classpath');
    assert.equal(h.calls.filter(args => args[0] === 'push').length, 2);
});

test('session capability failures expire on unexpected transport generation changes without explicit stop', async () => {
    const transport = { generation: 1, carrierIdentity: { status: 'verified' }, isReady: () => true };
    const server = new UiServer({ transport });
    server.noteCapability('pasteClipboard', 'unavailable');
    assert.equal(server.capability('pasteClipboard'), 'unavailable');
    transport.generation++;
    assert.equal(server.capability('pasteClipboard'), 'unknown');
    assert.equal(server.carrierIdentity, transport.carrierIdentity);
});

for (const status of ['verified', 'unknown']) test(`Service exposes ${status} startup-file evidence without adding it to action history`, async () => {
    const { harness } = require('./helpers/android-service-harness.cjs');
    const carrier = { status, scope: 'startup_file', generation: 1,
        expectedSha256: localHash, actualSha256: status === 'verified' ? localHash : null,
        reason: status === 'unknown' ? 'SHA256_UNAVAILABLE' : null };
    const h = await harness({ uiServer: { ok: true, carrier } });
    try {
        const observed = await h.service.processToolCall({ command: 'Observe', serial: 'A' });
        assert.equal(observed.details.carrier.status, status);
        assert.match(observed.content[0].text, new RegExp(`RPC载体文件：${status}`));
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
            action: { command: 'Tap', id: 'com.example:id/go' } });
        assert.equal(result.details.attempts[0].carrier.status, status);
        assert.ok(result.content.some(part => part.type === 'text' && part.text.includes('startup_file')));
        const history = await h.service.processToolCall({ command: 'Manage', operation: 'actionHistory', serial: 'A' });
        assert.equal(JSON.stringify(history).includes(localHash), false);
    } finally { await h.service.cleanup(); }
});

test('a cancelled hash probe cannot publish evidence or spawn in a later generation', async t => {
    const h = fixture(t);
    let enter;
    let release;
    const entered = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const exec = h.transport._exec;
    h.transport._exec = async args => {
        if (args[0] === 'shell') { enter(); await blocked; }
        return exec(args);
    };
    const starting = h.transport.start();
    await entered;
    const stopping = h.transport.stop();
    release();
    assert.equal((await starting).ok, false);
    await stopping;
    assert.equal(h.transport.carrierIdentity, null);
    assert.equal(h.spawns, 0);
});


for (const restart of [false, true]) test(`paste capability learning uses request generation (restart=${restart})`, async () => {
    let reject;
    const transport = {
        generation: 1, isReady: () => true,
        async call() { return new Promise((_, fail) => { reject = fail; }); },
        async stop() { this.generation++; },
        async start() { this.generation++; return { ok: true }; },
    };
    const server = new UiServer({ transport });
    const pending = server.invoke('pasteClipboard', []);
    if (restart) { await server.stop(); await server.start(); }
    const error = Object.assign(new Error('device rejected'), {
        code: 'UI_SERVER_RPC_ERROR', dispatched: true, drained: true,
    });
    reject(error);
    await assert.rejects(pending, caught => caught === error);
    assert.equal(server.capability('pasteClipboard'), restart ? 'unknown' : 'unavailable');
});

