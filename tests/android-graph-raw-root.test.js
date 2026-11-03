'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { parseUiAutomatorXml } = require('../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator');

const xml = `<hierarchy rotation="0">
    <node class="android.widget.FrameLayout" package="com.example" bounds="[0,0][400,800]" enabled="true">
        <node text="Go" resource-id="com.example:id/go" class="android.widget.Button" package="com.example" bounds="[0,0][100,50]" enabled="true" clickable="true" />
        <node text="Go" resource-id="com.example:id/go" class="android.widget.Button" package="com.example" bounds="[0,60][100,110]" enabled="false" clickable="true" />
        <node text="Go" resource-id="com.example:id/go" class="android.widget.Button" package="com.android.systemui" bounds="[0,120][100,170]" enabled="true" clickable="true" />
        <node text="private-password-value" resource-id="com.example:id/password" class="android.widget.EditText" package="com.example" bounds="[0,180][200,230]" enabled="true" password="true" />
    </node>
</hierarchy>`;

test('RPC target graph retains the unfiltered raw XML tree and duplicate identities', () => {
    const graph = parseUiGraph(xml, { rpcTarget: true });
    assert.deepEqual(graph.rawRoot, parseUiAutomatorXml(xml));
    const children = graph.rawRoot.children[0].children;
    const duplicates = children.filter(node => node.attrs['resource-id'] === 'com.example:id/go');
    assert.equal(duplicates.length, 3);
    assert.equal(duplicates[1].attrs.enabled, 'false');
    assert.equal(duplicates[2].attrs.package, 'com.android.systemui');
    assert.equal(graph.controls.filter(control => control.id === 'com.example:id/go').length, 1);
    assert.equal(children[3].attrs.text, 'private-password-value');
});

test('RPC raw root is non-enumerable and read-only without leaking password text in JSON', () => {
    const graph = parseUiGraph(xml, { rpcTarget: true });
    const descriptor = Object.getOwnPropertyDescriptor(graph, 'rawRoot');
    assert.ok(descriptor);
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.equal(Object.keys(graph).includes('rawRoot'), false);
    assert.equal(JSON.stringify(graph).includes('rawRoot'), false);
    assert.equal(JSON.stringify(graph).includes('private-password-value'), false);
    assert.throws(() => { graph.rawRoot = null; }, TypeError);
});

test('ordinary graphs omit rawRoot and RPC graphs preserve the same public graph', () => {
    const ordinary = parseUiGraph(xml);
    const rpc = parseUiGraph(xml, { rpcTarget: true });
    assert.equal(Object.hasOwn(ordinary, 'rawRoot'), false);
    assert.equal(Object.hasOwn(parseUiGraph(xml, { rpcTarget: false }), 'rawRoot'), false);
    assert.deepEqual(rpc, ordinary);
    assert.equal(JSON.stringify(rpc), JSON.stringify(ordinary));
});

test('RPC target graphs expose a null raw root for absent hierarchy without changing public output', () => {
    const rpc = parseUiGraph('', { rpcTarget: true });
    assert.equal(rpc.rawRoot, null);
    assert.deepEqual(rpc, parseUiGraph(''));
});
