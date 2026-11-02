'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const graph = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');

const screen = { width: 400, height: 800 };
const node = (attrs = '', children = '') => `<node package="com.demo" class="android.view.View" bounds="[0,0][400,100]" ${attrs}>${children}</node>`;
const parse = (children, options = {}) => graph.parseUiGraph(`<hierarchy>${children}</hierarchy>`, { screen, ...options });
async function focus(text) {
    const client = new AdbClient({ adbPath: 'unused-stub' });
    client.runText = async () => text;
    return client.currentFocus();
}

// Contracts: parse only the current line; derive package/component from the actual window.
test('perception: standard focus extracts package/component without mFocusedApp', async () => {
    const result = await focus('mCurrentFocus=Window{abc123 u0 com.demo/.MainActivity}');
    assert.equal(result.package, 'com.demo');
    assert.equal(result.component, 'com.demo/.MainActivity');
    assert.equal(result.window, 'Window{abc123');
});
test('perception: focused overlay package takes precedence over focused app', async () => {
    const result = await focus('mCurrentFocus=Window{abc u0 com.overlay/.Dialog}\nmFocusedApp=ActivityRecord{def u0 com.demo/.Main t1}');
    assert.equal(result.package, 'com.overlay');
    assert.equal(result.component, 'com.overlay/.Dialog');
});
test('perception: null focus cannot consume the next line', async () => {
    const result = await focus('mCurrentFocus=null\nOtherWindow{abc u0 com.unrelated/.Other}');
    assert.equal(result.window, null);
    assert.equal(result.component, null);
    assert.equal(result.package, null);
});
test('perception: last display wins and null focus retains app fallback', async () => {
    const result = await focus('mCurrentFocus=Window{abc u0 com.old/.Main}\nmCurrentFocus=null\nmFocusedApp=ActivityRecord{def u0 com.demo/.Main t1}');
    assert.equal(result.window, null);
    assert.equal(result.component, null);
    assert.equal(result.package, 'com.demo');
});

// Contract: repeated labels may remove decorative leaves, never interactive subtrees.
test('perception: duplicate wrapper label does not swallow interactive descendants', () => {
    const result = parse(node('clickable="true" text="Settings"',
        node('text="Settings"', node('clickable="true" text="Open" resource-id="com.demo:id/open"'))));
    assert.ok(result.controls.some((c) => c.id === 'com.demo:id/open'));
});
for (const flag of ['checkable', 'scrollable', 'focusable']) {
    test(`perception: duplicate ${flag} label remains independently addressable`, () => {
        const result = parse(node('clickable="true" text="Settings"', node(`text="Settings" ${flag}="true"`)));
        assert.equal(result.controls.length, 2);
    });
}
test('perception: redundant decorative label is still pruned', () => {
    const result = parse(node('clickable="true" text="Settings"', node('text="Settings"')));
    assert.equal(result.controls.length, 1);
});

// Contract: every generated selector is unique and resolves to its own control object.
test('perception: selectors round-trip empty labels, literal ordinals, percent and collisions', () => {
    const result = parse([
        node('text="First" clickable="true"'),
        node('clickable="true"'), node('clickable="true"'),
        node('text="Item#1" clickable="true"'),
        node('text="Item" clickable="true"'), node('text="Item" clickable="true"'),
        node('text="Item%23#1" clickable="true"'),
        node('resource-id="com.demo:id/key#1" clickable="true"'),
        node('resource-id="com.demo:id/key" clickable="true"'),
        node('resource-id="com.demo:id/key" clickable="true"'),
    ].join(''));
    assert.equal(new Set(result.controls.map((c) => c.selector)).size, result.controls.length);
    for (const control of result.controls) {
        assert.equal(graph.resolveSelector(result, control.selector), control, control.selector);
    }
    assert.deepEqual(graph.findControls(result, { text: '' }), result.controls.filter((c) => c.label === ''));
    assert.equal(graph.resolveSelector(result, 'text=First#0'), null);
    assert.equal(graph.resolveSelector(result, 'text=Missing'), null);
});

test('perception: scroll viewport clips direct children at its own level', () => {
    const result = parse('<node package="com.demo" class="android.widget.ScrollView" scrollable="true" bounds="[0,100][400,300]">'
        + node('text="Outside"') + '<node package="com.demo" class="android.widget.TextView" text="Inside" bounds="[0,120][400,160]" /></node>');
    assert.ok(!result.controls.some((c) => c.label === 'Outside'));
    assert.ok(result.controls.some((c) => c.label === 'Inside'));
    assert.equal(result.stats.hiddenInScroll, 1);
});
test('perception: SystemUI source remains observable after tree filtering', () => {
    const xml = '<node package="com.android.systemui" class="android.widget.FrameLayout" bounds="[0,0][400,800]"><node class="android.widget.TextView" text="Unlock" bounds="[0,0][400,100]" /></node>';
    const hidden = parse(xml);
    assert.equal(hidden.controls.length, 0);
    assert.ok(hidden.stats.droppedSystem > 0);
    assert.equal(hidden.keyguard, true);
    const visible = parse(xml, { includeSystem: true });
    assert.ok(visible.controls.some((c) => c.label === 'Unlock'));
    assert.equal(visible.keyguard, false);
    assert.equal(visible.stats.droppedSystem, 0);
});
test('perception: samePage observes checked and input value state without coordinate churn', () => {
    const checkbox = (checked) => parse(node(`text="Remember" checkable="true" checked="${checked}"`));
    assert.equal(graph.samePage(checkbox(false), checkbox(true)), false);
    const input = (value) => parse(`<node package="com.demo" class="android.widget.EditText" content-desc="Email" text="${value}" bounds="[0,0][400,100]" />`);
    assert.equal(graph.samePage(input('a@example.com'), input('b@example.com')), false);
    assert.equal(graph.samePage(input('a@example.com'), input('a@example.com')), true);
    assert.equal(graph.samePage(parse(node('text="Stable"')), parse(node('text="Stable"').replace('[0,0][400,100]', '[0,100][400,200]'))), true);
});
