'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { computeCodeIdentity, computePerformanceIdentity, computeCapabilityIdentity, CODE_REQUIRED_FILES } = require('../VCPDistributedServer/Plugin/AndroidController/lib/code-identity');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'android-identity-'));
    const rootDir = path.join(base, 'plugin');
    fs.mkdirSync(rootDir);
    function put(relative, data) {
        const absolute = path.join(rootDir, relative);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, data);
    }
    for (const relative of CODE_REQUIRED_FILES) put(relative, `fixture:${relative}\n`);
    t.after(() => {
        assert.equal(path.dirname(base), os.tmpdir());
        assert.ok(path.basename(base).startsWith('android-identity-'));
        fs.rmSync(base, { recursive: true, force: true });
    });
    return { rootDir, base, put, identity: () => computeCodeIdentity({ rootDir }) };
}
const performanceInput = () => ({ node: { version: 'v22.0.0', arch: 'x64' }, os: { platform: 'win32', release: '10.0' },
    rom: { manufacturer: 'Example', build: 'ROM-A', sdk: 35 }, config: { UI_SERVER: true, INTERACTION_POLICY: { denyPackages: [] } },
    workload: { scenario: 'observe', iterations: 20, image: false } });
const capabilityInput = () => ({ codeDigest: 'a'.repeat(64), carrier: { status: 'verified', scope: 'startup_file', generation: 1,
    expectedSha256: 'b'.repeat(64), actualSha256: 'b'.repeat(64), reason: null }, sessionGeneration: 1,
    deviceEvidence: { serialHash: 'c'.repeat(64), buildFingerprint: 'example/rom/35' } });

test('code identity is deterministic and each file hash independently matches fresh bytes', async t => {
    const h = fixture(t);
    const first = await h.identity();
    assert.equal(first.complete, true);
    assert.deepEqual(first, await h.identity());
    assert.match(first.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.files.map(file => file.path), first.files.map(file => file.path).sort());
    for (const file of first.files) assert.equal(file.sha256, hash(fs.readFileSync(path.join(h.rootDir, file.path))));
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.files[0]));
});

test('dirty same-size bytes invalidate identity even with restored mtime, without git/cache', async t => {
    const h = fixture(t);
    const relative = 'lib/dirty.js';
    h.put(relative, 'one');
    const first = await h.identity();
    const absolute = path.join(h.rootDir, relative);
    const stat = fs.statSync(absolute);
    h.put(relative, 'two');
    fs.utimesSync(absolute, stat.atime, stat.mtime);
    const second = await h.identity();
    assert.notEqual(first.digest, second.digest);
    assert.equal(second.files.find(file => file.path === relative).sha256, hash('two'));
});

test('production JS, nested JS, vendor bytes and manifest each affect code identity', async t => {
    const h = fixture(t);
    let previous = (await h.identity()).digest;
    for (const [relative, bytes] of [['another-production.js', 'root'], ['lib/sub/runtime.js', 'nested'],
        ['lib/runtime.mjs', 'esm'], ['runtime.cjs', 'cjs'],
        ['vendor/new.bin', Buffer.from([0, 255, 13])], ['plugin-manifest.json', '{"version":"changed"}']]) {
        h.put(relative, bytes);
        const next = await h.identity();
        assert.equal(next.complete, true);
        assert.notEqual(previous, next.digest, relative);
        previous = next.digest;
    }
});

test('git, environment secrets, tests, docs and dependencies are outside the code scope', async t => {
    const h = fixture(t);
    const before = await h.identity();
    for (const relative of ['.git/HEAD', '.git/objects/object', 'config.env', 'config.env.example', 'README.md',
        'tests/sample.js', 'node_modules/dependency/index.js', 'lib/readme.md']) h.put(relative, 'NOT TO BE READ');
    assert.deepEqual(await h.identity(), before);
});

for (const relative of ['vendor/u2-server-0.5.0.apk', 'vendor/vcp-ui-owner.jar']) test(`missing ${relative} produces an incomplete identity, restoration is fresh`, async t => {
    const h = fixture(t);
    const before = await h.identity();
    const absolute = path.join(h.rootDir, relative);
    assert.equal(path.dirname(absolute), path.join(h.rootDir, 'vendor'));
    fs.unlinkSync(absolute);
    const missing = await h.identity();
    assert.equal(missing.complete, false);
    assert.ok(missing.issues.includes(`missing:${relative}`));
    assert.notEqual(missing.digest, before.digest);
    h.put(relative, `fixture:${relative}\n`);
    assert.deepEqual(await h.identity(), before);
});

test('deleted optional production modules and added modules always change membership', async t => {
    const h = fixture(t);
    const before = await h.identity();
    h.put('lib/temporary.js', 'module.exports = 1;');
    assert.notEqual((await h.identity()).digest, before.digest);
    const absolute = path.join(h.rootDir, 'lib/temporary.js');
    assert.equal(path.dirname(absolute), path.join(h.rootDir, 'lib'));
    fs.unlinkSync(absolute);
    assert.deepEqual(await h.identity(), before);
});

test('missing plugin root is deterministic, incomplete and never mistaken for current code', async t => {
    const h = fixture(t);
    const rootDir = path.join(h.base, 'missing');
    const first = await computeCodeIdentity({ rootDir });
    assert.equal(first.complete, false);
    assert.ok(first.issues.includes('missing:.'));
    assert.deepEqual(first, await computeCodeIdentity({ rootDir }));
});

test('root relocation and directory insertion order do not enter the identity', async t => {
    const a = fixture(t);
    const b = fixture(t);
    a.put('lib/z.js', 'z'); a.put('lib/a.js', 'a');
    b.put('lib/a.js', 'a'); b.put('lib/z.js', 'z');
    assert.deepEqual(await a.identity(), await b.identity());
});

test('symlink content is not followed outside plugin root', async t => {
    const h = fixture(t);
    const outside = path.join(h.base, 'outside.js');
    fs.writeFileSync(outside, 'outside');
    try { fs.symlinkSync(outside, path.join(h.rootDir, 'lib/linked.js'), 'file'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('host does not permit fixture symlinks'); throw error; }
    const result = await h.identity();
    assert.equal(result.complete, false);
    assert.ok(result.issues.includes('symlink:lib/linked.js'));
    const before = result.digest;
    fs.writeFileSync(outside, 'changed outside');
    assert.equal((await h.identity()).digest, before);
});

test('performance keys are canonical and independently partition Node/OS/ROM/config/workload', () => {
    const input = performanceInput();
    const before = computePerformanceIdentity(input);
    assert.equal(before.complete, true);
    assert.deepEqual(computePerformanceIdentity({ workload: input.workload, config: input.config, rom: { sdk: 35, build: 'ROM-A', manufacturer: 'Example' }, os: input.os, node: input.node }), before);
    for (const name of ['node', 'os', 'rom', 'config', 'workload']) {
        const next = computePerformanceIdentity({ ...input, [name]: { changed: true } });
        assert.notEqual(next.digest, before.digest);
        assert.notEqual(next.digests[name], before.digests[name]);
        for (const other of Object.keys(before.digests).filter(key => key !== name)) assert.equal(next.digests[other], before.digests[other]);
    }
    assert.equal(computePerformanceIdentity({ node: 'v22' }).complete, false);
    assert.deepEqual(computePerformanceIdentity({ node: 'v22' }).missing, ['os', 'rom', 'config', 'workload']);
});

test('capability identity binds code, carrier bytes, session and device evidence but not perf', () => {
    const input = capabilityInput();
    const first = computeCapabilityIdentity(input);
    assert.equal(first.complete, true);
    assert.deepEqual(first, computeCapabilityIdentity(input));
    for (const patch of [{ codeDigest: 'd'.repeat(64) }, { sessionGeneration: 2 },
        { carrier: { ...input.carrier, generation: 2 } },
        { carrier: { ...input.carrier, expectedSha256: 'e'.repeat(64), actualSha256: 'e'.repeat(64) } },
        { deviceEvidence: { ...input.deviceEvidence, buildFingerprint: 'other/rom/35' } }]) {
        assert.notEqual(computeCapabilityIdentity({ ...input, ...patch }).digest, first.digest);
    }
    computePerformanceIdentity(performanceInput());
    assert.deepEqual(computeCapabilityIdentity(input), first);
});

test('unverified/mismatched/missing carrier, generation or evidence can never be reusable', () => {
    const input = capabilityInput();
    for (const patch of [{ carrier: null }, { carrier: { ...input.carrier, status: 'unknown' } },
        { carrier: { ...input.carrier, actualSha256: 'f'.repeat(64) } }, { sessionGeneration: null }, { sessionGeneration: '' },
        { deviceEvidence: null }, { deviceEvidence: {} }]) assert.equal(computeCapabilityIdentity({ ...input, ...patch }).complete, false);
});

test('identity data rejects secrets, getters, hooks, cycles and invalid numbers without running code', async () => {
    let calls = 0;
    const accessor = { get version() { calls++; return 'x'; } };
    const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
    const cyclic = {}; cyclic.self = cyclic;
    for (const config of [{ apiKey: 'PRIVATE' }, { nested: { password: 'PRIVATE' } }, { authToken: 'PRIVATE' }, accessor,
        proxy, cyclic, { value: Infinity }, { value: undefined }, { toJSON() { calls++; return {}; } }, new Date(), [,,]]) {
        assert.throws(() => computePerformanceIdentity({ ...performanceInput(), config }), { code: 'INVALID_ARGUMENT' });
    }
    await assert.rejects(computeCodeIdentity({ get rootDir() { calls++; return '.'; } }), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => computeCapabilityIdentity({ ...capabilityInput(), approvalToken: 'PRIVATE' }), { code: 'INVALID_ARGUMENT' });
    assert.equal(calls, 0);
});

test('performance output contains only digests, not supplied values or raw device identifiers', () => {
    const input = performanceInput();
    input.rom.serial = 'PRIVATE-SERIAL';
    const output = JSON.stringify(computePerformanceIdentity(input));
    assert.equal(output.includes('PRIVATE-SERIAL'), false);
    assert.equal(output.includes('ROM-A'), false);
    assert.equal(output.includes('Example'), false);
    assert.equal(JSON.stringify(computeCapabilityIdentity(capabilityInput())).includes('example/rom/35'), false);
});


test('native cross-realm records and arrays produce the same identity', async t => {
    const vm = require('node:vm');
    const crossRealm = value => vm.runInNewContext(`(${JSON.stringify(value)})`);
    const input = performanceInput();
    input.workload.samples = [1, 2, { warm: true }];
    assert.deepEqual(computePerformanceIdentity(crossRealm(input)), computePerformanceIdentity(input));
    assert.deepEqual(computeCapabilityIdentity(crossRealm(capabilityInput())), computeCapabilityIdentity(capabilityInput()));
    const h = fixture(t);
    assert.deepEqual(await computeCodeIdentity(crossRealm({ rootDir: h.rootDir })), await h.identity());
});

test('unreadable and changing-during-read files produce incomplete evidence, not stale hashes', async t => {
    const h = fixture(t);
    h.put('lib/race.js', 'before');
    const target = path.join(h.rootDir, 'lib/race.js');
    const original = fs.createReadStream;
    let mode = 'unreadable';
    fs.createReadStream = function(file, ...args) {
        if (file !== target) return original.call(this, file, ...args);
        if (mode === 'unreadable') throw Object.assign(new Error('private operating-system detail'), { code: 'EACCES' });
        const stream = original.call(this, file, ...args);
        stream.once('end', () => {
            const future = new Date(Date.now() + 60000);
            fs.utimesSync(target, future, future);
        });
        return stream;
    };
    try {
        const denied = await h.identity();
        assert.equal(denied.complete, false);
        assert.ok(denied.issues.includes('unreadable:lib/race.js'));
        assert.equal(JSON.stringify(denied).includes('private operating-system detail'), false);
        mode = 'change';
        const changed = await h.identity();
        assert.equal(changed.complete, false);
        assert.ok(changed.issues.includes('changedDuringRead:lib/race.js'));
    } finally { fs.createReadStream = original; }
    assert.equal((await h.identity()).complete, true);
});

test('code hashing yields while reading vendor bytes and never uses synchronous filesystem operations', async t => {
    const h = fixture(t);
    const bytes = Buffer.alloc(8 * 1024 * 1024, 23);
    h.put('vendor/large.bin', bytes);
    const expected = hash(bytes);
    const originalStream = fs.createReadStream;
    let chunks = 0, maxChunk = 0, turns = 0;
    const timer = setInterval(() => { turns++; }, 1);
    const mocks = ['lstatSync', 'readdirSync', 'readFileSync'].map(name => t.mock.method(fs, name, () => {
        throw new Error(`synchronous I/O: ${name}`);
    }));
    mocks.push(t.mock.method(fs, 'createReadStream', (...args) => {
        const stream = originalStream(...args);
        stream.on('data', chunk => { chunks++; maxChunk = Math.max(maxChunk, chunk.length); });
        return stream;
    }));
    let result;
    try { result = await h.identity(); }
    finally { clearInterval(timer); for (const mock of mocks) mock.mock.restore(); }
    assert.equal(result.complete, true);
    assert.equal(result.files.find(file => file.path === 'vendor/large.bin').sha256, expected);
    assert.ok(chunks > 100);
    assert.ok(maxChunk <= 64 * 1024);
    assert.ok(turns > 0, 'timers must run during identity acquisition');
});
