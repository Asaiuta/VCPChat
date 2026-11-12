'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAndroidDisplayTheme, compilePalettes } = require('../modules/services/androidDisplayTheme');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    let revision = 1n, reads = 0, builds = 0, missing = false, readGate;
    const theme = createAndroidDisplayTheme({ projectRoot: '/test', io: {
        async stat() {
            if (missing) throw new Error('missing source');
            return { dev: 1n, ino: 1n, size: 10n, mtimeNs: revision, ctimeNs: revision };
        },
        async readFile() { reads++; if (readGate) await readGate.promise; return String(revision); },
    }, compile(sources) { builds++; return { dark: `dark-${sources[0]}`, light: `light-${sources[0]}` }; } });
    return { theme, get reads() { return reads; }, get builds() { return builds; },
        change() { revision++; }, missing(value) { missing = value; }, block(gate) { readGate = gate; } };
}

test('windows share one in-flight compilation and reuse both palettes without rereading sources', async t => {
    const f = fixture(); t.after(() => f.theme.dispose());
    const values = await Promise.all([f.theme.get(true), f.theme.get(false), f.theme.get(true)]);
    assert.deepEqual(values, ['dark-1', 'light-1', 'dark-1']);
    for (let i = 0; i < 20; i++) assert.equal(await f.theme.get(i % 2 === 0), i % 2 === 0 ? 'dark-1' : 'light-1');
    assert.equal(f.reads, 4); assert.equal(f.builds, 1);
    f.change();
    assert.equal(await f.theme.get(false), 'light-2');
    assert.equal(f.reads, 8); assert.equal(f.builds, 2);
});

test('source errors are observable and a later refresh can recover without keeping failed promises', async t => {
    const f = fixture(); t.after(() => f.theme.dispose());
    await f.theme.get(true);
    f.missing(true);
    await assert.rejects(f.theme.get(true), /missing source/);
    f.missing(false); f.change();
    assert.equal(await f.theme.get(true), 'dark-2');
    assert.equal(f.builds, 2);
});

test('source replacement during a read cannot publish a mixed revision', async t => {
    const f = fixture(); t.after(() => f.theme.dispose());
    const gate = deferred(); f.block(gate);
    const pending = f.theme.get(true);
    while (!f.reads) await new Promise(r => setImmediate(r));
    f.change(); gate.resolve();
    await assert.rejects(pending, /主题文件正在更新/);
    assert.equal(f.builds, 0);
    assert.equal(await f.theme.get(true), 'dark-2');
    assert.equal(f.builds, 1);
});

test('disposal during a read prevents compilation and rejects subsequent loads', async () => {
    const f = fixture(), gate = deferred(); f.block(gate);
    const pending = f.theme.get(true);
    while (!f.reads) await new Promise(r => setImmediate(r));
    f.theme.dispose(); gate.resolve();
    await assert.rejects(pending, /服务已退出/);
    await assert.rejects(f.theme.get(false), /服务已退出/);
    assert.equal(f.builds, 0);
});

test('cached palettes match direct compilation of the actual project sources', async t => {
    const root = path.resolve(__dirname, '..');
    const sources = await Promise.all(['styles/themes.css', 'styles/ui-system/tokens.css', 'styles/ui-system/components.css', 'ScriptoriumModules/scriptorium.css']
        .map(file => fs.readFile(path.join(root, file), 'utf8')));
    const compiled = compilePalettes(sources);
    const theme = createAndroidDisplayTheme({ projectRoot: root });
    t.after(() => theme.dispose());
    for (const dark of [false, true]) {
        assert.equal(await theme.get(dark), compiled[dark ? 'dark' : 'light']);
    }
});
