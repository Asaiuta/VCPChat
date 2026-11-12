'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');
const { ControllerSettings, KEYS } = require('../VCPDistributedServer/Plugin/AndroidController/lib/controller-settings');

async function fixture(t, source = '', options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'android-controller-settings-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'config.env');
    await fs.writeFile(file, source);
    return { file, store: new ControllerSettings({ file, ...options }) };
}

test('native settings read is side-effect free and successful saves survive plugin reconstruction', async t => {
    const f = await fixture(t, '# local config\r\nSCRCPY_MAX_FPS=60\r\nLOOM_APP_ID=mine\r\n');
    const before = await f.store.read();
    assert.deepEqual(Object.keys(before.values).sort(), [...KEYS].sort());
    assert.deepEqual(before.pendingRestart, []);
    assert.equal(before.values.AUTO_WAKE, true);
    const values = { ...before.values, AUTO_WAKE: false, DEVICE_SERIAL: '192.168.1.2:5555',
        ADB_PATH: "C:\\new\\O'Neil\\platform-tools\\adb.exe", STREAM_FORMAT: 'png', STREAM_QUALITY: 95,
        INTERACTION_POLICY: '{"denyPackages":["com.private"],"readOnlyPackages":["com.reader"],"confirmEveryWrite":true}' };
    const saved = await f.store.save({ revision: before.revision, values });
    assert.equal(saved.saved, true);
    assert.ok(saved.pendingRestart.includes('AUTO_WAKE'));
    const text = await fs.readFile(f.file, 'utf8');
    assert.ok(text.startsWith('# local config\r\nSCRCPY_MAX_FPS=60\r\nLOOM_APP_ID=mine\r\n'));
    const persisted = dotenv.parse(text);
    assert.equal(persisted.ADB_PATH, values.ADB_PATH);
    const next = await new ControllerSettings({ file: f.file, effective: persisted }).read();
    assert.deepEqual(next.values, values);
    assert.deepEqual(next.pendingRestart, []);
    assert.deepEqual(Object.keys(next.values).sort(), [...KEYS].sort());
});

test('env updates preserve unrelated multiline values and replace owned duplicate assignments', async t => {
    const f = await fixture(t, '# keep\r\nOTHER="one\r\nAUTO_WAKE=true\r\nthree"\r\nexport AUTO_WAKE="true"\r\nAUTO_WAKE=false\r\nINTERACTION_POLICY=\'{\n"denyPackages": ["com.old"]\n}\'\r\nTAIL=untouched\r\n');
    const first = await f.store.read();
    const values = { AUTO_WAKE: true, INTERACTION_POLICY: '{}' };
    await f.store.save({ revision: first.revision, values });
    const text = await fs.readFile(f.file, 'utf8');
    assert.ok(text.includes('OTHER="one\r\nAUTO_WAKE=true\r\nthree"'));
    assert.ok(text.includes('TAIL=untouched\r\n'));
    assert.equal(dotenv.parse(text).AUTO_WAKE, 'true');
    assert.equal(dotenv.parse(text).INTERACTION_POLICY, '{}');
    assert.equal((text.match(/^AUTO_WAKE=/mg) || []).length, 2, 'one inside unrelated multiline value and one owned assignment');
});

test('invalid settings never modify disk or accept runtime-only and authorization fields', async t => {
    const f = await fixture(t, 'AUTO_WAKE=true\n');
    const { revision } = await f.store.read();
    for (const values of [{ AUTO_WAKE: 'false' }, { DISPLAY_PORT: -1 }, { ADB_TIMEOUT_MS: 0 },
        { STREAM_INTERVAL_MS: 1 }, { STREAM_QUALITY: 96 }, { STREAM_MAX_WIDTH: 2170 },
        { ADB_PATH: 'adb\nINJECT=1' }, { DEVICE_SERIAL: '__proto__' }, { CLIPBOARD_PASTE: 'shell' },
        { INTERACTION_POLICY: '{"allowAll":true}' }, { INTERACTION_POLICY: '{"denyPackages":["invalid/pkg"]}' },
        { androidSystemAuthorizations: {} }, { SCRCPY_MAX_FPS: 60 }, { LOOM_APP_ID: 'other' }, {}, []]) {
        await assert.rejects(f.store.save({ revision, values }), { code: 'INVALID_CONTROLLER_SETTINGS' });
        assert.equal(await fs.readFile(f.file, 'utf8'), 'AUTO_WAKE=true\n');
    }
});

test('external changes and concurrent stale saves cannot overwrite newer values', async t => {
    const f = await fixture(t);
    const { revision } = await f.store.read();
    const results = await Promise.allSettled([
        f.store.save({ revision, values: { AUTO_WAKE: false } }),
        f.store.save({ revision, values: { UI_SERVER: false } }),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].reason.code, 'CONTROLLER_SETTINGS_CONFLICT');
    const current = await f.store.read();
    await fs.appendFile(f.file, 'OTHER=externally-edited\n');
    await assert.rejects(f.store.save({ revision: current.revision, values: { AUTO_WAKE: true } }), { code: 'CONTROLLER_SETTINGS_CONFLICT' });
    assert.equal(dotenv.parse(await fs.readFile(f.file)).OTHER, 'externally-edited');
});

test('failed writes and invalidated native sender leave the last file intact', async t => {
    const f = await fixture(t, 'AUTO_WAKE=true\n', { write: async () => { throw new Error('disk unavailable'); } });
    const request = { revision: (await f.store.read()).revision, values: { AUTO_WAKE: false } };
    await assert.rejects(f.store.save(request), /disk unavailable/);
    await assert.rejects(f.store.save(request, { assertCurrent() { throw new Error('window closed'); } }), /window closed/);
    assert.equal(await fs.readFile(f.file, 'utf8'), 'AUTO_WAKE=true\n');
    assert.deepEqual((await f.store.read()).pendingRestart, []);
});
