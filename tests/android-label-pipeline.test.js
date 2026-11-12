'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const port = require('../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator');
const graphApi = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { MATCH_LABEL } = require('../VCPDistributedServer/Plugin/AndroidController/lib/selector');

const screen = { width: 1000, height: 2000 };
const longLabel = `${'A'.repeat(130)} / LONG_SUFFIX`;
const leaf = (text, extra = '') => `<node class="android.widget.TextView" package="com.example" text="${text}" bounds="[100,200][300,300]" ${extra}/>`;
const graphOf = xml => graphApi.parseUiGraph(xml, { screen, rpcTarget: true });

function countedGraphApi() {
    const entry = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph.js');
    const realRequire = createRequire(entry);
    let calls = 0;
    let visits = 0;
    const instrumented = { ...port, descendantText(...args) {
        calls++;
        const stack = [args[0]];
        while (stack.length) { const node = stack.pop(); visits++; stack.push(...node.children); }
        return port.descendantText(...args);
    } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(entry, 'utf8'), { module, exports: module.exports,
        require(name) { return name === './argent-uiautomator' ? instrumented : realRequire(name); },
    }, { filename: entry });
    return { api: module.exports, counts: () => ({ calls, visits }) };
}

test('long aggregate matching reuses the port label without a second descendant traversal, even with limit one', () => {
    const depth = 40;
    let xml = '<hierarchy>';
    for (let i = 0; i < depth; i++) xml += `<node class="android.widget.Button" package="com.example" clickable="true" bounds="[${i},${i}][${1000 - i},${2000 - i}]">`;
    xml += leaf(longLabel) + '</node>'.repeat(depth) + '</hierarchy>';
    const counted = countedGraphApi();
    const graph = counted.api.parseUiGraph(xml, { screen, limit: 1 });
    assert.equal(graph.controls.length, 1);
    assert.equal(counted.api.findControls(graph, { class: 'Button', any: longLabel }).length, depth);
    assert.deepEqual(counted.counts(), { calls: 0, visits: 0 });
});

test('descendantText exposes the already-computed full aggregate through its out parameter', () => {
    const root = port.parseUiAutomatorXml(`<hierarchy>${leaf(longLabel)}</hierarchy>`);
    const out = {};
    assert.equal(port.descendantText(root, 120, out), `${longLabel.slice(0, 120)}…`);
    assert.equal(out.fullLabel, longLabel);
    assert.deepEqual(out.labelBox, { x: 100, y: 200, w: 200, h: 100 });
});

test('aggregate full-label metadata reaches DescribeNode non-enumerably without widening the display label', () => {
    const tree = port.parseUiAutomatorDump(`<hierarchy><node class="android.widget.Button" package="com.example" clickable="true" bounds="[0,0][1000,2000]">${leaf(longLabel)}</node></hierarchy>`, screen.width, screen.height);
    const host = tree.children[0];
    assert.equal(host.label, `${longLabel.slice(0, 120)}…`);
    assert.equal(host[port.FULL_LABEL], longLabel);
    assert.equal(Object.getOwnPropertyDescriptor(host, port.FULL_LABEL).enumerable, false);
    const publicCopy = JSON.parse(JSON.stringify(host));
    assert.deepEqual(Reflect.ownKeys(publicCopy), Object.keys(host));
    assert.equal(Object.hasOwn(publicCopy, 'fullLabel'), false);
});

test('folding carries the source aggregate long tail instead of rebuilding it from the bare inner control', () => {
    const xml = `<hierarchy><node class="android.widget.FrameLayout" package="com.example" resource-id="host" clickable="true" bounds="[0,0][1000,2000]"><node class="android.widget.Button" package="com.example" clickable="true" bounds="[0,0][1000,2000]"/><node class="com.horcrux.svg.PathView" package="com.example" text="${longLabel}" bounds="[100,200][300,300]"/></node></hierarchy>`;
    const graph = graphOf(xml);
    assert.equal(graph.controls.length, 1);
    const host = graph.controls[0];
    assert.equal(host.rawNode.attrs.class, 'android.widget.Button');
    assert.equal(host.label, longLabel);
    assert.equal(graphApi.projectUiGraph(graph).controls[0].label, `${longLabel.slice(0, 120)}…`);
    assert.equal(host[MATCH_LABEL], longLabel);
    assert.equal(graphApi.resolveSelector(graph, { contains: 'LONG_SUFFIX' }), null, 'folded inner raw text is empty');
    assert.equal(graphApi.resolveSelector(graph, { any: longLabel }), host);
    assert.equal(graphApi.resolveSelector(graph, host.selector), host);
});

test('folding a long own label ending in a literal ellipsis preserves its source text', () => {
    const ownLabel = `${longLabel}…`;
    const graph = graphOf(`<hierarchy><node class="android.widget.FrameLayout" package="com.example" text="${ownLabel}" clickable="true" bounds="[0,0][1000,2000]"><node class="android.widget.Button" package="com.example" clickable="true" bounds="[0,0][1000,2000]"/></node></hierarchy>`);
    assert.equal(graph.controls.length, 1);
    const host = graph.controls[0];
    assert.equal(host[MATCH_LABEL], ownLabel);
    assert.equal(graphApi.resolveSelector(graph, host.selector), host);
    assert.equal(graphApi.resolveSelector(graph, { contains: 'LONG_SUFFIX' }), null, 'inherited label is not original inner text');
    assert.equal(graphApi.resolveSelector(graph, { any: ownLabel }), host);
});

test('private aggregate metadata preserves hidden, password, duplicate and independent-click-target rules', () => {
    const graph = graphOf(`<hierarchy><node class="android.widget.Button" package="com.example" resource-id="host" clickable="true" bounds="[0,0][1000,2000]">${leaf(longLabel)}${leaf(longLabel)}${leaf('HIDDEN_SECRET', 'visible-to-user="false"')}<node class="android.widget.EditText" package="com.example" text="PASSWORD_SECRET" password="true" bounds="[100,400][300,500]"/><node class="android.widget.Button" package="com.example" text="Independent" clickable="true" bounds="[100,600][300,700]"/></node></hierarchy>`);
    const host = graphApi.resolveSelector(graph, { id: 'host' });
    assert.equal(host[MATCH_LABEL], `${longLabel} / [password]`);
    assert.equal(graphApi.findControls(graph, { contains: 'HIDDEN_SECRET' }).length, 0);
    assert.equal(graphApi.findControls(graph, { contains: 'PASSWORD_SECRET' }).length, 0);
    assert.equal(graphApi.findControls(graph, { text: 'Independent' }).length, 1);
    assert.equal(JSON.stringify(graph).includes('HIDDEN_SECRET'), false);
    assert.equal(JSON.stringify(graph).includes('PASSWORD_SECRET'), false);
    assert.equal(Object.getOwnPropertyDescriptor(host, MATCH_LABEL).enumerable, false);
});
