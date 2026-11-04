'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { parseSelector, MAX_CONDITION_LENGTH } = require('../VCPDistributedServer/Plugin/AndroidController/lib/selector');
const { harness } = require('./helpers/android-service-harness.cjs');

const escapeXml = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const button = (text, id = '', top = 0) => `<node class="android.widget.Button" package="com.example" resource-id="${escapeXml(id)}" text="${escapeXml(text)}" clickable="true" bounds="[0,${top}][100,${top + 30}]"/>`;
const tree = (...nodes) => `<hierarchy rotation="0">${nodes.join('')}</hierarchy>`;
const graphOf = xml => ui.parseUiGraph(xml, { screen: { width: 100, height: 200 }, limit: 500 });
const writes = h => h.calls.filter(([kind, args]) => kind === 'adb' && args.includes('input'));

function assertRoundTrips(graph) {
    assert.equal(graph.truncated, false);
    for (const control of graph.controls) {
        if (control.selector === null) continue;
        assert.equal(typeof control.selector, 'string');
        assert.ok(control.selector.length > 0);
        assert.doesNotThrow(() => parseSelector(control.selector));
        assert.equal(ui.resolveSelector(graph, control.selector), control,
            `generated selector must resolve its originating index ${control.index}`);
    }
}

for (const value of ['A'.repeat(MAX_CONDITION_LENGTH), '%'.repeat(MAX_CONDITION_LENGTH),
    '#'.repeat(MAX_CONDITION_LENGTH), '😀'.repeat(MAX_CONDITION_LENGTH / 2)]) {
    test(`generated selector accepts the decoded UTF-16 budget (${JSON.stringify(value.slice(0, 2))})`, () => {
        const graph = graphOf(tree(button(value), button(value, '', 40)));
        assertRoundTrips(graph);
        assert.equal(parseSelector(graph.controls[0].selector).text, value);
        assert.ok(graph.controls[1].selector.endsWith('#2'));
    });
}

for (const value of ['A'.repeat(MAX_CONDITION_LENGTH + 1), '%'.repeat(MAX_CONDITION_LENGTH + 1),
    '😀'.repeat(MAX_CONDITION_LENGTH / 2) + 'X']) {
    test(`unrepresentable no-id labels are explicitly snapshot-only (${JSON.stringify(value.slice(0, 2))})`, () => {
        const graph = graphOf(tree(button(value), button(value, '', 40), button('Normal', '', 80)));
        assertRoundTrips(graph);
        assert.deepEqual(graph.controls.slice(0, 2).map(control => control.selector), [null, null]);
        assert.deepEqual(graph.controls.slice(0, 2).map(control => control.index), [0, 1]);
        const rendered = ui.renderView(graph);
        assert.equal((rendered.match(/仅限本次快照 index\+snapshotId/g) || []).length, 2);
        assert.equal(rendered.includes('null'), false);
        assert.equal(rendered.includes('class=Button'), false);
    });
}

test('literal percent and ordinal delimiters round-trip once, including duplicate labels', () => {
    const labels = ['Item#1', 'Item%23#1', 'Item%2523#2', 'Item#1', ''];
    const graph = graphOf(tree(...labels.map((label, index) => button(label, '', index * 35))));
    assertRoundTrips(graph);
    for (let i = 0; i < labels.length; i++) assert.equal(parseSelector(graph.controls[i].selector).text, labels[i]);
});

test('a stable expressible id wins over a long label without generating a positional selector', () => {
    const graph = graphOf(tree(button('A'.repeat(MAX_CONDITION_LENGTH + 1), 'com.example:id/a%#1')));
    assertRoundTrips(graph);
    assert.equal(graph.controls[0].selector, 'id=com.example:id/a%25%231');
    assert.equal(ui.renderView(graph).includes('仅限本次快照'), false);
});

test('oversized or non-round-trippable ids are snapshot-only without silently switching condition kinds', () => {
    const graph = graphOf(tree(button('Short', 'I'.repeat(MAX_CONDITION_LENGTH + 1)), button('Other', 'id trailing ', 40)));
    assertRoundTrips(graph);
    assert.deepEqual(graph.controls.map(control => control.selector), [null, null]);
});

for (const label of ['Same', '%#'.repeat(MAX_CONDITION_LENGTH / 2), '']) {
    test(`generated text ordinals include id-backed controls in the matching universe (${JSON.stringify(label.slice(0, 4))})`, () => {
        const graph = graphOf(tree(button(label, 'com.example:id/first'), button(label, '', 40), button(label, 'com.example:id/third', 80), button(label, '', 120)));
        assertRoundTrips(graph);
        assert.ok(graph.controls[1].selector.endsWith('#2'));
        assert.ok(graph.controls[3].selector.endsWith('#4'));
    });
}


test('global indexes and generated ordinals do not depend on the presentation limit', () => {
    const xml = tree(button('Same'), button('Same', 'com.example:id/second', 40), button('Same', '', 80));
    const full = graphOf(xml);
    const limited = ui.parseUiGraph(xml, { screen: { width: 100, height: 200 }, limit: 1 });
    assertRoundTrips(full);
    assert.equal(limited.truncated, true);
    assert.equal(limited.controls[0].selector, 'text=Same#1');
    assert.deepEqual(limited.matchingControls.map(control => [control.index, control.selector]), full.controls.map(control => [control.index, control.selector]));
    for (const control of limited.matchingControls) assert.equal(ui.resolveSelector(limited, control.selector), control);
});

test('generated ordinals count the actionable matching universe, not disabled assertion-only controls', () => {
    const xml = tree(button('Same', 'com.example:id/disabled').replace('clickable="true"', 'clickable="true" enabled="false"'), button('Same', '', 40));
    const graph = graphOf(xml);
    assertRoundTrips(graph);
    assert.equal(graph.controls.length, 1);
    assert.equal(graph.controls[0].index, 0);
    assert.equal(graph.controls[0].selector, 'text=Same');
});


test('snapshot-only Observe rows reject null selectors and preserve guarded index actions', async t => {
    const xml = tree(button('A'.repeat(MAX_CONDITION_LENGTH + 1)), button('B'.repeat(MAX_CONDITION_LENGTH + 1), '', 40));
    const h = await harness({ dump: () => xml });
    t.after(() => h.service.cleanup());
    const observed = await h.service.processToolCall({ command: 'Observe', serial: 'A', wake: 'never' });
    const row = observed.details.controls[1];
    assert.equal(row.selector, null);
    assert.ok(observed.content[0].text.includes('仅限本次快照 index+snapshotId'));
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', selector: row.selector } }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', index: row.index } }), { code: 'SNAPSHOT_REQUIRED' });
    assert.equal(writes(h).length, 0);
    const fresh = await h.service.processToolCall({ command: 'Observe', serial: 'A', wake: 'never' });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
        action: { command: 'Tap', index: row.index, snapshotId: fresh.details.snapshotId } });
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(result.details.selector, null);
    assert.equal(writes(h).length, 1);
    assert.equal(writes(h)[0][1].at(-1), String(row.y));
});
