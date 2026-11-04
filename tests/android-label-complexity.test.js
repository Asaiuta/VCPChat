'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const port = require('../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator');
const entry = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator.js');
const node = (attrs = {}, children = []) => ({ tag: 'node', attrs: {
    class: 'android.widget.TextView', bounds: '[10,20][30,40]', ...attrs,
}, children });
const host = (id, children, depth = 0) => node({ class: 'android.widget.Button', clickable: 'true',
    'resource-id': id, bounds: `[${depth},${depth}][${10000 - depth},${20000 - depth}]`,
}, children);
const parse = (root, api = port) => api.parseUiAutomatorTree({ tag: 'hierarchy', attrs: {}, children: [root] }, 10000, 20000);

// Specification deliberately uses recursive preorder and a list (not map merging).
function reference(root) {
    const records = [];
    function add(word, bounds) {
        if (!word || records.some(record => record.word === word)) return;
        const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(bounds || '');
        let box;
        if (match) {
            const [x, y, right, bottom] = match.slice(1).map(Number);
            box = [x, y, Math.max(x, right), Math.max(y, bottom)];
        }
        records.push({ word, box });
    }
    function visit(current) {
        const a = current.attrs;
        if (a.password === 'true') { add('[password]'); return; }
        const words = [String(a.text ?? '').trim(), String(a['content-desc'] ?? '').trim()];
        if (!words.some(Boolean) || (a.clickable !== 'true' && a['long-clickable'] !== 'true')) {
            words.forEach(word => add(word, a.bounds));
        }
        current.children.filter(child => child.tag === 'node').forEach(visit);
    }
    visit(root);
    const full = records.map(record => record.word).join(' / ');
    const boxes = records.map(record => record.box).filter(Boolean);
    let box;
    if (boxes.length) {
        const x = Math.min(...boxes.map(b => b[0]));
        const y = Math.min(...boxes.map(b => b[1]));
        box = { x, y, w: Math.max(...boxes.map(b => b[2])) - x, h: Math.max(...boxes.map(b => b[3])) - y };
    }
    return { full, label: full.length > 120 ? full.slice(0, 120) + '…' : full, box };
}

function verifyHosts(root) {
    const expected = new Map();
    const pending = [root];
    while (pending.length) {
        const current = pending.pop();
        if (current.attrs['resource-id']) expected.set(current.attrs['resource-id'], reference(current));
        pending.push(...current.children.filter(child => child.tag === 'node'));
    }
    const output = parse(root);
    const actual = [...output.children];
    while (actual.length) {
        const current = actual.pop();
        if (expected.has(current.identifier)) {
            const oracle = expected.get(current.identifier);
            assert.equal(current[port.FULL_LABEL], oracle.full);
            assert.equal(current.label, oracle.label);
            assert.deepEqual(current.labelBox, oracle.box);
            assert.equal(Object.getOwnPropertyDescriptor(current, port.FULL_LABEL).enumerable, false);
            expected.delete(current.identifier);
        }
        actual.push(...current.children);
    }
    assert.equal(expected.size, 0, 'all nested aggregate targets must survive');
    return output;
}

test('nested summaries preserve first-occurrence boxes when the largest child is not first', () => {
    const root = host('outer', [
        node({ text: 'Duplicate', bounds: '[1,2][3,4]' }),
        host('inner', [node({ text: 'Duplicate', bounds: '[900,900][999,999]' }),
            node({ text: 'α', 'content-desc': 'A / B' }), node({ text: '😀'.repeat(80) }),
            node({ password: 'true', text: 'SECRET' }, [node({ text: 'CHILD_SECRET' })]),
            node({ text: '[password]', bounds: '[3000,3000][4000,4000]' }),
            node({ text: 'Delete', clickable: 'true' }, [node({ text: 'Grandchild' })]),
        ], 1),
    ]);
    verifyHosts(root);
    assert.equal(JSON.stringify(reference(root)).includes('SECRET'), false);
});

test('seeded nested branching aggregates match the independent specification at every target', () => {
    let seed = 0x5eed;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const words = ['A', 'B', '[password]', 'x / y', 'e\u0301', '😀'.repeat(80), '  spaced  '];
    for (let trial = 0; trial < 100; trial++) {
        let id = 0;
        function branch(depth) {
            const leaves = Array.from({ length: 1 + next() % 4 }, () => node({
                text: words[next() % words.length], 'content-desc': words[next() % words.length],
                bounds: next() % 4 ? `[${next() % 50},2][100,200]` : 'invalid',
                ...(next() % 7 === 0 ? { password: 'true' } : {}),
                ...(next() % 5 === 0 ? { 'long-clickable': 'true' } : {}),
            }, [node({ text: 'descendant' })]));
            leaves.push(node({ text: 'anchor' }));
            if (depth < 4) leaves.splice(next() % leaves.length, 0, branch(depth + 1), branch(depth + 1));
            return host(`target-${id++}`, leaves, depth);
        }
        verifyHosts(branch(0));
    }
});

function countedApi() {
    const counts = { mapEntries: 0, mapOps: 0, textReads: 0 };
    class CountedMap extends Map {
        get(key) { counts.mapOps++; return super.get(key); }
        set(key, value) { counts.mapOps++; return super.set(key, value); }
        *[Symbol.iterator]() { for (const item of super[Symbol.iterator]()) { counts.mapEntries++; yield item; } }
        *values() { for (const item of super.values()) { counts.mapEntries++; yield item; } }
    }
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(entry, 'utf8'), { module, exports: module.exports, Map: CountedMap }, { filename: entry });
    function observe(root) {
        const stack = [root];
        while (stack.length) {
            const current = stack.pop();
            const text = current.attrs.text;
            Object.defineProperty(current.attrs, 'text', { get() { counts.textReads++; return text; }, enumerable: true });
            stack.push(...current.children);
        }
    }
    return { api: module.exports, counts, observe };
}

for (const depth of [64, 128, 256]) {
    test(`duplicate comb ${depth}: raw reads AND summary-entry work stay linear`, t => {
        let root = node({ text: 'Repeated' });
        for (let i = depth - 1; i >= 0; i--) root = host(`n-${i}`, [node({ text: 'Repeated' }), root], i);
        const { api, counts, observe } = countedApi();
        observe(root);
        const output = parse(root, api);
        assert.equal(output.children[0][api.FULL_LABEL], 'Repeated');
        assert.ok(counts.textReads < depth * 30, JSON.stringify(counts));
        assert.ok(counts.mapEntries < depth * 5, JSON.stringify(counts));
        assert.ok(counts.mapOps < depth * 50, JSON.stringify(counts));
        t.diagnostic(JSON.stringify({ depth, ...counts }));
    });
}

test('unique non-aggregating comb transfers its growing summary instead of copying each ancestor', t => {
    const depth = 256;
    let root = node({ text: 'Tail' });
    for (let i = 0; i < depth; i++) root = node({ class: 'android.widget.FrameLayout' }, [node({ text: `Word-${i}` }), root]);
    root = host('outer', [root]);
    const { api, counts, observe } = countedApi();
    observe(root);
    const output = parse(root, api);
    assert.equal(output.children[0][api.FULL_LABEL], reference(root).full);
    assert.ok(counts.mapEntries < depth * 5, JSON.stringify(counts));
    assert.ok(counts.mapOps < depth * 50, JSON.stringify(counts));
    t.diagnostic(JSON.stringify({ depth, ...counts }));
});


test('balanced unique branches bound summary merging by n log n rather than repeated subtree scans', t => {
    const height = 8;
    let id = 0;
    function branch(level) {
        if (!level) return node({ text: `word-${id++}` });
        return node({ class: 'android.widget.FrameLayout' }, [branch(level - 1), branch(level - 1)]);
    }
    const root = host('outer', [branch(height)]);
    const { api, counts, observe } = countedApi();
    observe(root);
    const output = parse(root, api);
    assert.equal(output.children[0][api.FULL_LABEL], reference(root).full);
    const leaves = 2 ** height;
    assert.ok(counts.mapEntries <= leaves * (height + 1), JSON.stringify(counts));
    assert.ok(counts.mapOps <= leaves * 40, JSON.stringify(counts));
    t.diagnostic(JSON.stringify({ leaves, ...counts }));
});

test('unique nested outputs retain their necessarily quadratic complete text, never just the prefix', () => {
    const depth = 40;
    let root = node({ text: 'TAIL' });
    for (let i = depth - 1; i >= 0; i--) root = host(`target-${i}`, [node({ text: `word-${i}` }), root], i);
    const output = verifyHosts(root);
    let total = 0;
    const pending = [...output.children];
    while (pending.length) {
        const current = pending.pop();
        total += (current[port.FULL_LABEL] || '').length;
        pending.push(...current.children);
    }
    assert.ok(total > depth * depth * 3);
});
