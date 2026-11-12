'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { createFaultProxy } = require('../scripts/android-device-suite/fault-proxy.cjs');
const { HttpRpcTransport } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-transport');
const { processGone, killOwned } = require('../scripts/verify-android-resilience.cjs');
const { restartDevice } = require('../scripts/android-device-suite/restart.cjs');
test('MuMu restart refuses a different instance endpoint before issuing control', () => {
    let controls = 0;
    const run = (_file, args) => { if (args[0] === 'control') controls++; return JSON.stringify({ error_code: 0, index: '0', adb_host_ip: '127.0.0.1', adb_port: 16384 }); };
    assert.throws(() => restartDevice({}, { mumuManager: 'manager', mumuInstance: '1', serial: '127.0.0.1:16384' }, () => {}, run));
    assert.throws(() => restartDevice({}, { mumuManager: 'manager', mumuInstance: '0', serial: '127.0.0.1:16385' }, () => {}, run));
    assert.equal(controls, 0);
});
test('MuMu restart command failure does not fall back to another reboot', () => {
    let adb = 0;
    const run = (_file, args) => { if (args[0] === 'control') throw Error('manager failed'); return JSON.stringify({ error_code: 0, index: '0', adb_host_ip: '127.0.0.1', adb_port: 16384 }); };
    assert.throws(() => restartDevice({ exec() { adb++; } }, { mumuManager: 'manager', mumuInstance: '0', serial: '127.0.0.1:16384' }, () => {}, run), /manager failed/);
    assert.equal(adb, 0);
});
test('MuMu nonzero result cannot be accepted merely because the process exited normally', () => {
    const run = (_file, args) => JSON.stringify(args[0] === 'control' ? { errcode: 7 } : { error_code: 0, index: '0', adb_host_ip: '127.0.0.1', adb_port: 16384 });
    assert.throws(() => restartDevice({}, { mumuManager: 'manager', mumuInstance: '0', serial: '127.0.0.1:16384' }, () => {}, run), /MuMu restart rejected/);
});
for (const mode of ['pass', 'drop', 'delay']) test(`real loopback ${mode}: one forwarded write, truthful uncertainty`, async () => {
    let calls = 0;
    const server = http.createServer((req, res) => { const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
        calls++; const rpc = JSON.parse(Buffer.concat(chunks)); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }));
    }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const events = [], proxy = await createFaultProxy({ upstreamPort: server.address().port, mode, delayMs: 200, emit: (type, data) => events.push({ type, data }) });
    const transport = new HttpRpcTransport(); transport.port = proxy.port;
    try {
        if (mode === 'pass') assert.equal(await transport.call('click', [1, 1, 800], 1000), true);
        else await assert.rejects(transport.call('click', [1, 1, 800], mode === 'delay' ? 100 : 1000), e => e.dispatched === true && e.drained === false);
        if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(calls, 1); assert.equal(proxy.stats().writes, 1); assert.equal(proxy.stats().pendingTimers, 0);
        if (mode === 'delay') assert.ok(events.some(e => e.type === 'wire-deliver' && e.data.clientClosed));
    } finally { await proxy.close(); await new Promise(resolve => server.close(resolve)); }
});
test('independent disappearance rejects live listener even with absent PID', () => {
    const binding = { pid: 123, startTime: '1', port: 8080, ownerPort: 8081 };
    assert.throws(() => processGone({ exec: args => args[1].startsWith('if') ? 'ABSENT' : '0: 00000000:1F90 00000000:0000 0A' }, binding));
    assert.equal(processGone({ exec: args => args[1].startsWith('if') ? 'ABSENT' : 'sl local_address rem_address st' }, binding).gone, true);
});
test('kill refuses unverified owner class and changed identity response', () => {
    let calls = 0;
    const device = { exec: () => { calls++; return ''; } }, binding = { pid: 123, startTime: '1', uid: 2000, cmdline: ['other'] };
    assert.throws(() => killOwned(device, binding)); assert.equal(calls, 0);
    assert.throws(() => killOwned(device, { ...binding, cmdline: ['com.vcpchat.uiautomator.Owner'] })); assert.equal(calls, 1);
});
test('async independent reader rejects nonzero exits even with valid JSON', async () => {
    const cp = require('node:child_process'), original = cp.execFile;
    const { createDevice } = require('../scripts/android-device-suite/device.cjs');
    const state = { ready: true, protocol: 1, package: 'com.vcpchat.m15fixture', session: '12345678-1234-1234-1234-123456789012' };
    const events = [], device = createDevice({ adb: 'fixture-adb', serial: 'fixture', contentRuntime: '32' }, (type, data) => events.push({ type, data }));
    try {
        cp.execFile = (_file, args, _opts, cb) => { assert.ok(args.includes('app_process32')); queueMicrotask(() => cb(null, 'Row: 0 state=' + JSON.stringify(state), '')); };
        assert.deepEqual(await device.readAsync(), state);
        cp.execFile = (_file, _args, _opts, cb) => queueMicrotask(() => cb(Object.assign(Error('crash'), { code: 139 }), 'Row: 0 state=' + JSON.stringify(state), 'crash'));
        await assert.rejects(device.readAsync(), { code: 'DEVICE_COMMAND_FAILED' });
        assert.equal(events.filter(e => e.type === 'independent').length, 1);
        assert.equal(events.at(-1).data.exit, 139);
    } finally { cp.execFile = original; }
});
