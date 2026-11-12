'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { InputRecovery, bootIdentity } = require('../VCPDistributedServer/Plugin/AndroidController/lib/input-recovery');
const { createUiSessions } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-sessions');
const { harness } = require('./helpers/android-service-harness.cjs');
const bootA = '12345678-1234-1234-1234-123456789012', bootB = '12345678-1234-1234-1234-123456789013';
function world(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'input-recovery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let boot = bootA, device = '1234567890abcdef', released = false, calls = 0;
    const read = async () => bootIdentity(boot + '\n' + device);
    const store = new InputRecovery(directory, read), owner = {};
    const options = { identityFor: () => null, invalidate() {}, failure: (code, msg) => Object.assign(Error(msg), { code }), inputRecovery: () => store,
        createServer: () => ({ async stop() { released = true; return { status: 'released' }; }, async recoverOwner() { return { status: 'released' }; } }) };
    const sessions = createUiSessions(options); sessions.get('A');
    return { directory, store, sessions, options, identity: () => store.identityFor(owner, 'A'),
        setBoot: b => { boot = b; }, setDevice: d => { device = d; }, released: () => released,
        call: async (result, error) => sessions.call('A', async () => { calls++; if (error) throw error; return result; }, { inputIdentity: await store.identityFor(owner, 'A') }), calls: () => calls };
}
test('unknown touch survives process release and new sessions, only same-device reboot clears it', async t => {
    const w = world(t);
    await assert.rejects(w.call(null, Object.assign(Error('lost'), { dispatched: true, drained: false })));
    await assert.rejects(w.sessions.recover('A'), { code: 'DEVICE_INPUT_STATE_UNCERTAIN' });
    assert.equal(w.released(), true); assert.equal(w.store.pending('A').bootId, bootA);
    const reloaded = new InputRecovery(w.directory, async () => bootIdentity(bootA + '\n1234567890abcdef'));
    const replacement = createUiSessions({ ...w.options, inputRecovery: () => reloaded });
    assert.throws(() => replacement.assertCertain('A'), { code: 'DEVICE_STATE_UNCERTAIN' });
    await assert.rejects(replacement.recover('A'), { code: 'DEVICE_INPUT_STATE_UNCERTAIN' });
    w.setBoot(bootB); w.setDevice('abcdef1234567890');
    await assert.rejects(w.sessions.recover('A'), { code: 'DEVICE_INPUT_STATE_UNCERTAIN' });
    w.setDevice('1234567890abcdef');
    const r = await w.sessions.recover('A'); assert.equal(r.inputRecovery.proof, 'same_device_new_boot');
    assert.equal(w.store.pending('A'), null); assert.equal(w.sessions.hasUncertain(), false); assert.equal(w.calls(), 1);
});
test('marker exists before dispatch, success and proven non-dispatch clear only own marker', async t => {
    const w = world(t); const identity = await w.identity();
    await w.sessions.call('A', async () => { assert.ok(w.store.pending('A')); return true; }, { inputIdentity: identity });
    assert.equal(w.store.pending('A'), null);
    await assert.rejects(w.call(null, Object.assign(Error('local'), { dispatched: false, drained: true })));
    assert.equal(w.store.pending('A'), null); assert.equal(w.sessions.hasUncertain(), false);
});
for (const result of ['false', 'drained-error']) test(`completed ${result} is not proof of touch release`, async t => {
    const w = world(t);
    if (result === 'false') await w.call(false);
    else await assert.rejects(w.call(null, Object.assign(Error('server'), { dispatched: true, drained: true })));
    await assert.rejects(w.sessions.recover('A'), { code: 'DEVICE_INPUT_STATE_UNCERTAIN' });
    assert.ok(w.store.pending('A'));
});
test('host death marker blocks another selector for the same device before dispatch', async t => {
    const w = world(t), identity = await w.identity(); w.store.begin('A', identity);
    assert.throws(() => w.store.begin('B', identity), { code: 'DEVICE_STATE_UNCERTAIN' });
    w.setBoot(bootB);
    const fresh = createUiSessions(w.options);
    assert.equal((await fresh.recover('A')).scope, 'device_boot'); assert.equal(w.store.pending('A'), null);
});
test('corrupt persistence, invalid boot and write failure cannot authorize an input', async t => {
    const w = world(t); assert.throws(() => bootIdentity(bootA + '\nnull'), { code: 'INPUT_RECOVERY_UNPROVEN' });
    fs.writeFileSync(w.store.file('A'), '{');
    assert.throws(() => w.sessions.assertCertain('A'), { code: 'INPUT_RECOVERY_STORE' });
    assert.throws(() => w.store.begin('A', { bootId: bootA, device: 'a'.repeat(64) }), { code: 'INPUT_RECOVERY_STORE' });
    assert.equal(w.calls(), 0);
});
test('real Service startup reloads pending touch and requires new device boot', async t => {
    const w = world(t), identity = await w.identity();
    const dataDir = path.join(w.directory, 'service'); const store = new InputRecovery(path.join(dataDir, 'android-input-recovery'), async () => identity);
    store.begin('A', identity); let boot = bootA;
    const h = await harness({ dataDir, bootId: () => boot, uiServer: { ok: true } }); t.after(() => h.service.cleanup());
    const tap = () => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', id: 'com.example:id/go' } });
    await assert.rejects(tap(), { code: 'DEVICE_STATE_UNCERTAIN' });
    await assert.rejects(h.service.processToolCall({ command: 'Manage', operation: 'recoverOwner', serial: 'A' }), { code: 'DEVICE_INPUT_STATE_UNCERTAIN' });
    assert.equal(h.calls.filter(c => c[0] === 'rpc').length, 0); boot = bootB;
    assert.equal((await h.service.processToolCall({ command: 'Manage', operation: 'recoverOwner', serial: 'A' })).details.recovered, true);
    assert.equal((await tap()).details.execution.outcome, 'dispatched'); assert.equal(store.pending('A'), null);
});
test('failed persistence cleanup after local rejection keeps input blocked', async t => {
    const w = world(t), original = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', function(file) { if (file === w.store.file('A')) throw Object.assign(Error('locked'), { code: 'EACCES' }); return original(file); });
    await assert.rejects(w.call(null, Object.assign(Error('not sent'), { dispatched: false, drained: true })), { code: 'INPUT_RECOVERY_STORE' });
    assert.throws(() => w.sessions.assertCertain('A'), { code: 'DEVICE_STATE_UNCERTAIN' });
    assert.equal(w.store.serials().length, 1);
});
test('failed marker sync prevents dispatch and leaves a blocking record', async t => {
    const w = world(t); t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(Error('disk'), { code: 'EIO' }); });
    await assert.rejects(w.call(true), { code: 'INPUT_RECOVERY_STORE' }); assert.equal(w.calls(), 0);
    assert.throws(() => w.sessions.assertCertain('A'), { code: 'DEVICE_STATE_UNCERTAIN' });
});
test('failed deletion after successful RPC cannot relabel a real write as not-dispatched', async t => {
    const w = world(t), original = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', function(file) { if (file === w.store.file('A')) throw Error('locked'); return original(file); });
    await assert.rejects(w.call(true), e => e.code === 'INPUT_RECOVERY_STORE' && e.dispatched === true && e.drained === true);
    assert.equal(w.calls(), 1); assert.throws(() => w.sessions.assertCertain('A'), { code: 'DEVICE_STATE_UNCERTAIN' });
});
test('missing boot evidence is a hard stop and cannot fall through to shell input', async t => {
    const h = await harness({ bootId: () => 'unknown', uiServer: { ok: true } }); t.after(() => h.service.cleanup());
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', id: 'com.example:id/go' } }), { code: 'INPUT_RECOVERY_UNPROVEN' });
    assert.equal(h.calls.filter(c => c[0] === 'rpc' || c[0] === 'adb' && c[1].includes('input')).length, 0);
});
test('a pending marker under another selector cannot use RPC-to-shell fallback', async t => {
    const w = world(t), dataDir = path.join(w.directory, 'alias-service');
    const store = new InputRecovery(path.join(dataDir, 'android-input-recovery'), async () => await w.identity());
    store.begin('A', await w.identity());
    const h = await harness({ dataDir, uiServer: { ok: true } }); t.after(() => h.service.cleanup());
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'B', action: { command: 'Tap', id: 'com.example:id/go' } }), { code: 'DEVICE_STATE_UNCERTAIN' });
    assert.equal(h.calls.filter(c => c[0] === 'rpc' || c[0] === 'adb' && c[1].includes('input')).length, 0);
});
test('ADB failure obtaining boot identity cannot become shell fallback permission', async t => {
    const h = await harness({ client: { async runText() { throw Object.assign(Error('offline'), { code: 'ADB_FAILED' }); } }, uiServer: { ok: true } });
    t.after(() => h.service.cleanup());
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', id: 'com.example:id/go' } }), { code: 'INPUT_RECOVERY_UNPROVEN' });
    assert.equal(h.calls.filter(c => c[0] === 'rpc').length, 0);
});
