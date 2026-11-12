'use strict';

// Offline only. Run from any directory: node scripts/benchmark-android-labels.cjs
const { performance } = require('node:perf_hooks');
const port = require('../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const screen = { width: 1000, height: 2000 };
const makeNode = (attrs, children = []) => ({ tag: 'node', attrs: { class: 'android.widget.TextView', package: 'com.example', bounds: '[10,10][30,30]', ...attrs }, children });

function chain(depth, unique = false) {
    let root = makeNode({ text: 'A'.repeat(130) });
    for (let i = depth - 1; i >= 0; i--) root = makeNode({ class: 'android.widget.Button', clickable: 'true', 'resource-id': `chain-${i}`,
        bounds: `[${i},${i}][${1000 - i},${2000 - i}]` }, unique ? [makeNode({ text: `Word-${i}` }), root] : [root]);
    return root;
}
function wide(aggregate) {
    return makeNode({ class: 'android.widget.Button', clickable: 'true', ...(aggregate ? {} : { text: 'Own label' }), bounds: '[0,0][1000,2000]' },
        Array.from({ length: 256 }, (_, i) => makeNode({ text: `Item-${i}`, bounds: `[1,${i}][100,${i + 1}]` })));
}
const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function serialize(node) {
    return `<node ${Object.entries(node.attrs).map(([key, value]) => `${key}="${escapeXml(value)}"`).join(' ')}>${node.children.map(serialize).join('')}</node>`;
}
function countTextReads(root) {
    let reads = 0;
    const pending = [root];
    while (pending.length) {
        const current = pending.pop();
        const value = current.attrs.text;
        Object.defineProperty(current.attrs, 'text', { enumerable: true, get() { reads++; return value; } });
        pending.push(...current.children);
    }
    port.parseUiAutomatorTree({ tag: 'hierarchy', attrs: {}, children: [root] }, screen.width, screen.height);
    return reads;
}
function timing(run) {
    for (let i = 0; i < 30; i++) run();
    const samples = [];
    for (let sample = 0; sample < 7; sample++) {
        const start = performance.now();
        for (let i = 0; i < 40; i++) run();
        samples.push((performance.now() - start) / 40);
    }
    samples.sort((a, b) => a - b);
    return Number(samples[3].toFixed(4));
}
const cases = [
    ['chain-50', () => chain(50)], ['chain-100', () => chain(100)], ['chain-200', () => chain(200)],
    ['unique-chain-80', () => chain(80, true)], ['wide-256-aggregate', () => wide(true)], ['wide-256-own-label', () => wide(false)],
];
const results = cases.map(([name, create]) => {
    const xml = `<hierarchy>${serialize(create())}</hierarchy>`;
    const output = port.parseUiAutomatorDump(xml, screen.width, screen.height);
    let controls = 0;
    let fullLabelChars = 0;
    const pending = [...output.children];
    while (pending.length) {
        const current = pending.pop();
        controls++;
        fullLabelChars += (current[port.FULL_LABEL] ?? current.label ?? '').length;
        pending.push(...current.children);
    }
    return { name, controls, fullLabelChars, textReads: countTextReads(create()),
        portMedianMs: timing(() => port.parseUiAutomatorDump(xml, screen.width, screen.height)),
        graphMedianMs: timing(() => parseUiGraph(xml, { screen, limit: 1 })) };
});
console.log(JSON.stringify({ runtime: process.version, samples: 7, iterationsPerSample: 40, results }, null, 2));
