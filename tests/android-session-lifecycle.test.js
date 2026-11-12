'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUiSessions } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-sessions');
const { harness } = require('./helpers/android-service-harness.cjs');

const failure = (code, message) => Object.assign(new Error(message), { code });

test('successful cleanup of a quarantined owner preserves proof for explicit recovery', async () => {
    const { RemoteOwner } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-owner');
    const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
    const serial = 'released-quarantine';
    const owner = new RemoteOwner({ serial, generation: 1, backend: {
        async prepare() { return { endpointBinding: true, atomicTermination: true }; }, launch() {},
        async terminate(context) { return { verified: true, gone: true, nonce: context.nonce, serial }; },
    } });
    await owner.prepare(); owner.begin(9001); owner.quarantine('RPC_OUTCOME_UNKNOWN');
    const sessions = createUiSessions({ failure, identityFor: RemoteOwner.identityFor, invalidate() {},
        createServer: () => new UiServer({ transport: { get ownerIdentity() { return owner.identity; },
            stop: () => owner.release(), recoverOwner: () => owner.release() } }) });
    sessions.get(serial);
    assert.throws(() => sessions.assertCertain(serial), { code: 'DEVICE_STATE_UNCERTAIN' });
    await sessions.stopAll();
    assert.equal(RemoteOwner.identityFor(serial), null);
    assert.equal(sessions.isUncertain(serial), true, 'cleanup must not implicitly authorize recovery');
    assert.equal((await sessions.recover(serial)).status, 'released');
    assert.doesNotThrow(() => sessions.assertCertain(serial));
    assert.equal(sessions.peek(serial), undefined);
});

test('explicit disconnect releases RPC before ADB, evicts session and permits a fresh Observe', async t => {
    const order = [];
    const h = await harness({ uiServer: { ok: true, stop(serial) { order.push(`stop:${serial}`); return { status: 'released' }; } },
        client: { async enqueue(args) { order.push(args.join(' ')); return { stdout: '' }; } } });
    t.after(() => h.service.cleanup());
    await h.service.processToolCall({ command: 'Observe', serial: 'A' });
    await h.api.disconnect({ address: 'A' });
    assert.deepEqual(order, ['stop:A', 'disconnect A']);
    assert.equal(h.client.serial, '');
    await h.service.processToolCall({ command: 'Observe', serial: 'A' });
    assert.equal(h.uiServer.started, 2);
});

test('failed owner release preserves the connection instead of disconnecting its recovery channel', async t => {
    let disconnected = false;
    const h = await harness({ uiServer: { ok: true, stop() { return { status: 'quarantined' }; } },
        client: { async enqueue() { disconnected = true; return { stdout: '' }; } } });
    t.after(() => h.service.cleanup());
    await h.service.processToolCall({ command: 'Observe', serial: 'A' });
    await assert.rejects(h.api.disconnect({ address: 'A' }), { code: 'UI_SERVER_OWNER_QUARANTINED' });
    assert.equal(disconnected, false);
    assert.equal(h.client.serial, 'A');
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_STATE_UNCERTAIN' });
    assert.deepEqual(h.service.getRuntimeStatus().quarantinedDevices, ['A']);
});

test('session cleanup evicts only proven releases and explicit recovery alone clears quarantine', async () => {
    const released = new Set(['A']);
    const stops = [], invalidated = [];
    const sessions = createUiSessions({ failure, identityFor: () => null, invalidate: serial => invalidated.push(serial),
        createServer: serial => ({ async stop() { stops.push(serial); return { status: released.has(serial) ? 'released' : 'quarantined' }; },
            async recoverOwner() { return { status: released.has(serial) ? 'released' : 'quarantined' }; } }) });
    sessions.get('A'); const b = sessions.get('B');
    await assert.rejects(sessions.stopAll({ strict: true }), { code: 'UI_SERVER_OWNER_QUARANTINED' });
    assert.deepEqual(stops.sort(), ['A', 'B']);
    assert.equal(sessions.peek('A'), undefined);
    assert.equal(sessions.peek('B'), b);
    assert.throws(() => sessions.assertCertain('B'), { code: 'DEVICE_STATE_UNCERTAIN' });
    assert.deepEqual(sessions.uncertainSerials(), ['B']);
    released.add('B');
    const owner = await sessions.recover('B');
    assert.equal(owner.status, 'released');
    assert.equal(sessions.peek('B'), undefined);
    assert.equal(sessions.hasUncertain(), false);
    assert.deepEqual(sessions.uncertainSerials(), []);
    assert.doesNotThrow(() => sessions.assertCertain('B'));
    assert.ok(invalidated.includes('B'));
});
