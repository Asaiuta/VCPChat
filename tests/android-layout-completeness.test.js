'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rawEntries, hasCompleteLayout, layoutEvidence } = require('../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence');

function fixture(depth = 1) {
    const pkg = 'com.example', root = { tag: 'hierarchy', attrs: { rotation: '0' }, children: [] };
    let parent = root;
    for (let i = 0; i < depth; i++) {
        const node = { tag: 'node', attrs: { package: pkg, bounds: '[0,0][100,100]', enabled: 'true' }, children: [], parent };
        parent.children.push(node); parent = node;
    }
    return { graph: { rawRoot: root, package: pkg, keyguard: false },
        probe: { focus: { package: pkg, component: `${pkg}/.Main`, window: 'Window{a u0 com.example/.Main}' },
            size: { width: 100, height: 200 }, rotation: 0, displayId: 0, wakefulness: 'Awake', keyguard: { showing: false, inputRestricted: false } } };
}

for (const [name, change, expected] of [
    ['visible foreground', () => {}, true],
    ['missing raw tree', f => { f.graph.rawRoot = null; }, false],
    ['keyguard', f => { f.graph.keyguard = true; }, false],
    ['rotation mismatch', f => { f.probe.rotation = 1; }, false],
    ['package mismatch', f => { f.graph.package = 'other.app'; }, false],
    ['foreign foreground', f => { f.graph.rawRoot.children[0].attrs.package = 'other.app'; }, false],
    ['hidden foreground', f => { f.graph.rawRoot.children[0].attrs['visible-to-user'] = 'false'; }, false],
    ['offscreen foreground', f => { f.graph.rawRoot.children[0].attrs.bounds = '[0,200][100,300]'; }, false],
]) test(`complete-layout gate preserves ${name}`, () => {
    const f = fixture(); change(f);
    assert.equal(hasCompleteLayout(f.graph, f.probe, rawEntries(f.graph, f.probe.size)), expected);
    const evidence = layoutEvidence(f.graph, f.probe);
    assert.equal(evidence.complete, expected);
    if (expected) assert.match(evidence.digest, /^[a-f0-9]{64}$/);
    else assert.equal(evidence.digest, '');
});

for (const depth of [198, 199, 200]) test(`complete-layout gate enforces the raw depth bound at ${depth}`, () => {
    const f = fixture(depth);
    assert.equal(hasCompleteLayout(f.graph, f.probe, rawEntries(f.graph, f.probe.size)), depth < 199);
    assert.equal(layoutEvidence(f.graph, f.probe).complete, depth < 199);
});

test('completeness does not read or serialize raw labels or identities', () => {
    const f = fixture();
    const attrs = f.graph.rawRoot.children[0].attrs;
    for (const key of ['text', 'resource-id', 'content-desc']) Object.defineProperty(attrs, key, {
        enumerable: true, get() { throw new Error('unneeded evidence read'); },
    });
    assert.equal(hasCompleteLayout(f.graph, f.probe, rawEntries(f.graph, f.probe.size)), true);
});
