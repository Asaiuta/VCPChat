'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AndroidSystemAuthorization, CONSENT_VERSION, GROUPS } = require('../modules/services/androidSystemAuthorization');
function fixture(record) {
    let settings = { androidSystemAuthorizations: record };
    const service = new AndroidSystemAuthorization({ settingsManager: { async readSettingsStrict() { return settings; } } });
    return { service, set(value) { settings = value; } };
}
const grants = (group = 'read') => ({ A: { version: CONSENT_VERSION, acknowledged: true, grants: { [group]: true } } });
test('missing consent or other device cannot authorize any operation', async () => {
    for (const value of [undefined, null, [], {}, grants()]) {
        const f = fixture(value);
        await assert.rejects(f.service.assertAllowed('B', 'read'), { code: 'SYSTEM_NOT_AUTHORIZED' });
    }
});
test('consent must be explicit, current, exact-device and group-specific', async () => {
    const f = fixture(grants());
    await f.service.assertAllowed('A', 'read');
    for (const group of GROUPS.filter(group => group !== 'read')) await assert.rejects(f.service.assertAllowed('A', group), { code: 'SYSTEM_NOT_AUTHORIZED' });
    for (const patch of [{ version: -1 }, { acknowledged: 'true' }, { grants: { read: 'true' } }]) {
        const bad = grants(); Object.assign(bad.A, patch);
        await assert.rejects(fixture(bad).service.assertAllowed('A', 'read'), { code: 'SYSTEM_NOT_AUTHORIZED' });
    }
});
test('revocation is read on each request, not cached', async () => {
    const f = fixture(grants());
    await f.service.assertAllowed('A', 'read'); f.set({});
    await assert.rejects(f.service.assertAllowed('A', 'read'), { code: 'SYSTEM_NOT_AUTHORIZED' });
});
test('invalid identity, inherited devices and invented groups fail closed', async () => {
    const inherited = Object.create(grants());
    const f = fixture(inherited);
    for (const serial of ['', '__proto__', 'constructor', 'A']) await assert.rejects(f.service.assertAllowed(serial, 'read'));
    await assert.rejects(fixture(grants()).service.assertAllowed('A', 'shell'), { code: 'INVALID_ARGUMENT' });
});
test('status is a bounded permission projection, not raw settings', async () => {
    const f = fixture(grants());
    const status = await f.service.getStatus('A');
    assert.equal(status.version, CONSENT_VERSION); assert.equal(status.acknowledged, true);
    assert.equal(status.grants.read, true); assert.equal(status.grants.personal, false);
    assert.deepEqual(Object.keys(status).sort(), ['acknowledged', 'grants', 'serial', 'version']);
});


test('authorization refuses recoverable config readers and never falls back on read failure', async () => {
    const recoverable = { async readSettings() { return { androidSystemAuthorizations: grants() }; } };
    assert.throws(() => new AndroidSystemAuthorization({ settingsManager: recoverable }));
    const service = new AndroidSystemAuthorization({ settingsManager: { async readSettingsStrict() { throw new Error('corrupted'); } } });
    await assert.rejects(service.assertAllowed('A', 'read'), { code: 'SYSTEM_NOT_AUTHORIZED' });
});