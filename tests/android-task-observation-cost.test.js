'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskPort } = require('../VCPDistributedServer/Plugin/AndroidController/lib/task-port');
const { frameContext } = require('../VCPDistributedServer/Plugin/AndroidController/lib/context');

function fixture(size) {
    let idReads = 0;
    const pkg = 'com.example';
    const root = { tag: 'hierarchy', attrs: { rotation: '0' }, children: [] };
    const controls = [];
    for (let i = 0; i < size; i++) {
        const id = `${pkg}:id/button_${i}`;
        const attrs = { package: pkg, class: 'android.widget.Button', bounds: `[0,${i * 40}][90,${i * 40 + 35}]`,
            enabled: 'true', clickable: 'true', text: 'Other', password: 'false' };
        Object.defineProperty(attrs, 'resource-id', { enumerable: true, get() { idReads++; return id; } });
        const raw = { tag: 'node', attrs, children: [], parent: root };
        root.children.push(raw);
        controls.push({ id, role: 'button', enabled: true, inViewport: true, flags: [], rawNode: raw, text: 'Other', desc: '' });
    }
    const probe = { focus: { package: pkg, component: `${pkg}/.Main`, window: 'Window{a u0 com.example/.Main}' },
        size: { width: 100, height: size * 40 }, rotation: 0, displayId: 0, wakefulness: 'Awake', keyguard: { showing: false, inputRestricted: false } };
    const graph = { rawRoot: root, controls, package: pkg, truncated: false, keyguard: false,
        contextEvidence: { context: frameContext(probe), probe, epoch: 1 } };
    const task = { serial: 'A', package: pkg, intent: 'search', decision: 'jev', inputs: { query: 'q' },
        completion: { id: `${pkg}:id/results` }, budget: { maxObservations: 256 } };
    const port = createTaskPort({ runtime: { check() {}, remainingMs: () => 60000 }, captureGraph: async () => graph });
    return { task, port, root, reset() { idReads = 0; }, get reads() { return idReads; } };
}

function scrollFixture(size) {
    const f = fixture(size), container = f.root.children[0], children = f.root.children.slice(1);
    container.attrs.scrollable = 'true'; container.attrs.bounds = `[0,0][100,${size * 40}]`;
    container.children = children.slice(0, 63); f.root.children = [container];
    for (const raw of container.children) raw.parent = container;
    for (const raw of children.slice(63)) {
        raw.parent = container.children.at(-1); raw.parent.children.push(raw);
    }
    f.task.searchActions = { scroll: { command: 'Scroll', container: 'com.example:id/button_0',
        target: 'com.example:id/search', direction: 'down', maxSwipes: 1 } };
    return f;
}

test('multi-scroll reuses the observation identity index instead of rescanning all raw ids', async () => {
    for (const nodes of [32, 128, 500]) {
        const f = scrollFixture(nodes);
        await f.port.run(f.task, () => f.port.observe(f.task));
        const single = f.reads;
        f.reset(); f.task.searchActions.scroll.maxSwipes = 4;
        const sample = await f.port.run(f.task, () => f.port.observe(f.task));
        assert.ok(sample.searchActionEvidence.scroll.position);
        assert.ok(f.reads - single <= nodes, `multi-scroll added ${f.reads - single} id reads for ${nodes} nodes`);
    }
});

test('search action evidence adds linear work at the maximum supported control count', async () => {
    for (const nodes of [32, 128, 500]) {
        const f = fixture(nodes);
        await f.port.run(f.task, () => f.port.observe(f.task));
        const ordinary = f.reads;
        f.reset(); f.task.searchActions = { imeAction: 'search' };
        const sample = await f.port.run(f.task, () => f.port.observe(f.task));
        assert.ok(f.reads - ordinary <= nodes * 2, `additional work must stay linear: ${f.reads - ordinary} reads for ${nodes} nodes`);
        assert.ok(sample.controls.every(c => c.rawMatches === 1));
    }
});

test('the next observation counts hidden duplicates afresh and never mutates previous evidence', async () => {
    const f = fixture(2); f.task.searchActions = { imeAction: 'search' };
    await f.port.run(f.task, async () => {
        const first = await f.port.observe(f.task);
        const source = f.root.children[0];
        f.root.children.push({ ...source, attrs: { ...source.attrs, 'visible-to-user': 'false' } });
        const second = await f.port.observe(f.task);
        assert.equal(first.controls[0].rawMatches, 1);
        assert.equal(second.controls[0].rawMatches, 2);
        f.root.children.pop();
        assert.equal((await f.port.observe(f.task)).controls[0].rawMatches, 1);
        assert.equal(second.controls[0].rawMatches, 2);
    });
});
