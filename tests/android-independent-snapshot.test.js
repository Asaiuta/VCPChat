'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSnapshotReader } = require('../scripts/android-independent-snapshot/reader.cjs');

function setup(t, overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-reader-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const jar = path.join(dir, 'reader.jar');
    fs.writeFileSync(jar, 'fixture');
    const hash = createHash('sha256').update('fixture').digest('hex');
    const calls = [];
    let live = false;
    let reader;
    reader = createSnapshotReader({ jar, executeAdb(args) {
        calls.push(args);
        if (args[1] === 'ps') return { status: 0, stdout: 'ARGS\n' + (live ? reader.identity.processName + '\n' : '') };
        if (args[1] === 'sha256sum') return { status: 0, stdout: (overrides.badHash ? '0'.repeat(64) : hash) + ' ' + args[2] };
        if (args.includes('app_process')) {
            live = Boolean(overrides.liveAfter);
            return overrides.result || { status: 0, stdout: '<xml/>' };
        }
        if (overrides.cleanupFailed && args[1] === 'test') return { status: 1, stdout: '' };
        return { status: 0, stdout: '' };
    } });
    return { reader, calls, hash, terminate: () => { live = false; } };
}

test('snapshot read verifies remote bytes, process absence and deletion; sends no input', t => {
    const { reader, calls, hash } = setup(t);
    reader.prepare();
    assert.equal(reader.identity.sha256, hash);
    assert.match(reader.identity.remotePath, /^\/data\/local\/tmp\/vcp-snapshot-[a-f0-9]+-[a-f0-9]+\.jar$/);
    assert.equal(reader.execute(15000).stdout, '<xml/>');
    assert.deepEqual(reader.cleanup(), { removed: true, processAbsent: true });
    assert.deepEqual(calls.map(args => args[0] === 'push' ? 'push' : args[1].startsWith('CLASSPATH=') ? 'sample' : args[1]),
        ['ps','push','sha256sum','ps','sample','ps','ps','rm','test']);
    assert.throws(() => reader.execute(100), { code: 'INDEPENDENT_SNAPSHOT_STATE' });
});

test('mismatched remote jar cannot execute', t => {
    const { reader, calls } = setup(t, { badHash: true });
    assert.throws(() => reader.prepare(), { code: 'INDEPENDENT_SNAPSHOT_HASH' });
    assert.throws(() => reader.execute(100), { code: 'INDEPENDENT_SNAPSHOT_STATE' });
    reader.cleanup();
    assert.equal(calls.some(args => args.includes('app_process')), false);
});

test('live process after client exit blocks another read and file deletion', t => {
    const { reader, calls, terminate } = setup(t, { liveAfter: true });
    reader.prepare();
    assert.throws(() => reader.execute(100), { code: 'INDEPENDENT_SNAPSHOT_EXIT_UNPROVEN' });
    assert.throws(() => reader.execute(100), { code: 'INDEPENDENT_SNAPSHOT_STATE' });
    assert.throws(() => reader.cleanup(), { code: 'INDEPENDENT_SNAPSHOT_EXIT_UNPROVEN' });
    assert.equal(calls.some(args => args[1] === 'rm'), false);
    terminate();
    assert.equal(reader.cleanup().removed, true);
});

test('a timed-out client remains failed despite valid output and proven process exit', t => {
    const { reader } = setup(t, { result: { status: null, error: { code: 'ETIMEDOUT' }, stdout: '<xml/>' } });
    reader.prepare();
    assert.equal(reader.execute(100).error.code, 'ETIMEDOUT');
    assert.equal(reader.cleanup().removed, true);
});

test('cleanup cannot report success when file absence is unproven', t => {
    const { reader } = setup(t, { cleanupFailed: true });
    reader.prepare();
    assert.throws(() => reader.cleanup(), { code: 'INDEPENDENT_SNAPSHOT_ADB_FAILED' });
});
