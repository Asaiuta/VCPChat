'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const port = require('../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator');

function node(attrs = {}, children = []) {
    return { tag: 'node', attrs: { class: 'android.widget.TextView', package: 'com.example', bounds: '[10,10][30,30]', ...attrs }, children };
}
const host = children => node({ class: 'android.widget.Button', clickable: 'true', 'resource-id': 'host', bounds: '[0,0][1000,2000]' }, children);

// Independent preorder specification: no production label/bounds/union helpers.
function reference(root, maxChars = 120) {
    const seen = new Set();
    const words = [];
    const boxes = [];
    function visit(current) {
        const a = current.attrs;
        if (a.password === 'true') {
            if (!seen.has('[password]')) { seen.add('[password]'); words.push('[password]'); }
            return;
        }
        const text = String(a.text ?? '').trim();
        const description = String(a['content-desc'] ?? '').trim();
        if (!(text || description) || (a.clickable !== 'true' && a['long-clickable'] !== 'true')) {
            for (const word of [text, description]) {
                if (!word || seen.has(word)) continue;
                seen.add(word);
                words.push(word);
                const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(String(a.bounds ?? ''));
                if (match) {
                    const [x, y, right, bottom] = match.slice(1).map(Number);
                    boxes.push([x, y, x + Math.max(0, right - x), y + Math.max(0, bottom - y)]);
                }
            }
        }
        for (const child of current.children) if (child.tag === 'node') visit(child);
    }
    visit(root);
    const fullLabel = words.join(' / ');
    const result = { fullLabel, label: fullLabel.length > maxChars ? `${fullLabel.slice(0, maxChars)}…` : fullLabel };
    if (boxes.length) {
        const x = Math.min(...boxes.map(box => box[0]));
        const y = Math.min(...boxes.map(box => box[1]));
        result.labelBox = { x, y, w: Math.max(...boxes.map(box => box[2])) - x, h: Math.max(...boxes.map(box => box[3])) - y };
    }
    return result;
}

function direct(root, maxChars = 120) {
    const out = {};
    const label = port.descendantText(root, maxChars, out);
    return { ...out, label };
}
function parsedHost(root) {
    const tree = port.parseUiAutomatorTree({ tag: 'hierarchy', attrs: {}, children: [root] }, 1000, 2000);
    const pending = [...tree.children];
    while (pending.length) {
        const current = pending.pop();
        if (current.identifier === 'host') return current;
        pending.push(...current.children);
    }
    assert.fail('expected a retained aggregate host');
}
function assertAggregate(root) {
    const expected = reference(root);
    assert.deepEqual(direct(root), expected);
    const actual = parsedHost(root);
    assert.equal(actual.label, expected.label);
    assert.equal(actual[port.FULL_LABEL], expected.fullLabel);
    assert.deepEqual(actual.labelBox, expected.labelBox);
    return actual;
}

const cases = [
    ['text then content description, document order and first-occurrence geometry', [
        node({ text: '  A  ', 'content-desc': 'B', bounds: '[1,2][4,6]' }),
        node({ text: 'A', bounds: '[500,500][600,600]' }), node({ text: 'C', bounds: '[10,20][30,40]' })]],
    ['independent click targets skip only their own words, not descendants', [
        node({ text: 'Delete', clickable: 'true' }, [node({ text: 'Details' })]),
        node({ 'content-desc': 'Long', 'long-clickable': 'true' }, [node({ text: 'Tail' })])]],
    ['password nodes suppress their entire raw subtree', [
        node({ password: 'true', text: 'SECRET' }, [node({ text: 'CHILD_SECRET' })]), node({ text: 'Public' })]],
    ['password marker first suppresses literal marker geometry', [
        node({ password: 'true', text: 'SECRET' }), node({ text: '[password]', bounds: '[900,900][990,990]' }), node({ text: 'Public' })]],
    ['literal marker first retains its own geometry', [
        node({ text: '[password]', bounds: '[900,900][990,990]' }), node({ password: 'true', text: 'SECRET' }), node({ text: 'Public' })]],
    ['empty and invalid bounds contribute words without invented geometry', [
        node({ text: 'A', bounds: 'invalid' }), node({ text: 'B', bounds: '[20,30][10,25]' }), node({ text: 'Anchor' })]],
    ['raw aggregation does not acquire new noisy, offscreen or system pruning rules', [
        node({ text: 'Noisy', class: 'com.horcrux.svg.PathView' }), node({ text: 'Outside', bounds: '[3000,3000][3100,3100]' }),
        node({ text: 'Chrome', package: 'com.android.systemui' }), node({ text: 'Anchor' })]],
    ['tag filtering, separators, unicode and long-label truncation remain exact', [
        { tag: 'ignored', attrs: { text: 'Not a node' }, children: [node({ text: 'Not reachable' })] },
        node({ text: '😀'.repeat(80), 'content-desc': 'A / B' }), node({ text: 'e\u0301' })]],
];
for (const [name, children] of cases) test(name, () => { assertAggregate(host(children)); });

test('aggregate caches never escape across independent calls or raw-tree edits', () => {
    const root = host([node({ text: 'Before' })]);
    assertAggregate(root);
    root.children[0].attrs.text = 'After';
    const result = assertAggregate(root);
    assert.equal(result[port.FULL_LABEL], 'After');
});

test('ancestor duplicate replacement cannot mutate a previously materialized child labelBox or order', () => {
    const inner = node({ class: 'android.widget.Button', clickable: 'true', 'resource-id': 'inner', bounds: '[10,10][800,1800]' }, [
        node({ text: 'Duplicate', bounds: '[100,100][200,200]' }), node({ text: 'Unique', bounds: '[300,300][400,400]' }),
    ]);
    const root = host([node({ text: 'Duplicate', bounds: '[1,1][2,2]' }), inner]);
    const expectedInner = reference(inner);
    const outer = assertAggregate(root);
    const actualInner = outer.children.find(child => child.identifier === 'inner');
    assert.ok(actualInner);
    assert.equal(actualInner[port.FULL_LABEL], expectedInner.fullLabel);
    assert.deepEqual(actualInner.labelBox, expectedInner.labelBox);
    assert.notEqual(actualInner.labelBox, outer.labelBox);
});

function random(seed) {
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
}

test('deterministic varied raw forests agree with an independent preorder reference', () => {
    const next = random(0x41594152);
    const words = ['', 'A', 'B', ' A ', '[password]', '😀 / tail', 'X'.repeat(130)];
    function branch(depth) {
        const attrs = { text: words[next() % words.length], 'content-desc': words[next() % words.length],
            bounds: next() % 7 ? `[${next() % 100},${next() % 100}][500,900]` : 'invalid' };
        if (next() % 5 === 0) attrs.clickable = 'true';
        if (next() % 7 === 0) attrs['long-clickable'] = 'true';
        if (next() % 11 === 0) attrs.password = 'true';
        const children = depth ? Array.from({ length: next() % 4 }, () => branch(depth - 1)) : [];
        return node(attrs, children);
    }
    for (let i = 0; i < 300; i++) assertAggregate(host([branch(4), branch(3), node({ text: 'Anchor' })]));
});

for (const depth of [50, 100, 200]) {
    test(`production aggregation attribute work stays linear on a ${depth}-deep repeated-label chain`, () => {
        let reads = 0;
        let root = node({ text: 'A'.repeat(130) });
        for (let i = depth - 1; i >= 0; i--) {
            const attrs = { class: 'android.widget.Button', clickable: 'true', 'resource-id': `chain-${i}`, bounds: `[${i},${i}][${1000 - i},${2000 - i}]` };
            Object.defineProperty(attrs, 'text', { enumerable: true, get() { reads++; return ''; } });
            // Bypass node()'s spread so getter reads count production work, not test construction.
            root = { tag: 'node', attrs, children: [root] };
        }
        const output = port.parseUiAutomatorTree({ tag: 'hierarchy', attrs: {}, children: [root] }, 1000, 2000);
        assert.equal(output.children[0][port.FULL_LABEL], 'A'.repeat(130));
        assert.ok(reads <= depth * 20, `expected <= ${depth * 20} text reads, got ${reads}`);
    });
}
