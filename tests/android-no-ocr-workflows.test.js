'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const { parseUiGraph, resolveSelector } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { evaluateSelector, validateSelector } = require('../VCPDistributedServer/Plugin/AndroidController/lib/selector');
const item = (text, bounds = '[10,60][90,90]', id = 'item') => `<node package="com.example" class="android.widget.Button" resource-id="com.example:id/${id}" text="${text}" clickable="true" enabled="true" bounds="${bounds}"/>`;
const list = contents => `<hierarchy rotation="0"><node package="com.example" class="android.widget.ScrollView" resource-id="com.example:id/list" scrollable="true" enabled="true" bounds="[0,20][100,180]">${contents}</node></hierarchy>`;
const execute = (h, action, context = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action }, context);
const inputs = h => h.calls.filter(c => c[0] === 'adb' && c[1].includes('input'));

test('scrollUntil keeps scrolling past clipped edge slivers and reports its actual predicate', async () => {
    let swipes = 0;
    const h = await harness({ config: { UI_SERVER: false }, dump: () => list(item('Goal', swipes ? '[10,80][90,120]' : '[10,178][90,180]')),
        run: args => { if (args.includes('input')) swipes++; } });
    const result = await execute(h, { command: 'ScrollUntil', container: 'id=com.example:id/list', target: 'text=Goal', strategy: 'host' });
    assert.equal(swipes, 1);
    assert.equal(result.details.visibility.contract, 'scroll-axis-interior');
    assert.equal(result.details.visibility.reason, 'INTERIOR');
    assert.equal(result.details.actionVerified, true);
});

test('an edge-bound or viewport-sized target remains unknown, even with an outer visible assertion', async () => {
    const h = await harness({ config: { UI_SERVER: false }, dump: () => list(item('Goal', '[10,20][90,180]')) });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
        action: { command: 'ScrollUntil', container: 'id=com.example:id/list', target: 'text=Goal', strategy: 'host', maxSwipes: 1 },
        expect: { type: 'visible', selector: 'text=Goal' } });
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.visibility.reason, 'VIEWPORT_EDGE');
});

const relationTree = () => `<hierarchy rotation="0"><node package="com.example" class="android.widget.LinearLayout" resource-id="com.example:id/row" bounds="[0,0][100,180]">${item('Name', undefined, 'name')}${item('Open', '[10,100][90,120]', 'open')}<node package="com.example" class="android.widget.LinearLayout" resource-id="com.example:id/nested" bounds="[0,0][100,180]">${item('Nested', '[10,140][90,160]', 'nestedButton')}</node></node>${item('Open', '[10,181][90,199]', 'outside')}</hierarchy>`;

test('structural selectors use actual raw relationships after presentation pruning', () => {
    const graph = parseUiGraph(relationTree(), { rpcTarget: true, screen: { width: 100, height: 200 }, limit: 1 });
    assert.equal(resolveSelector(graph, { text: 'Open', siblingOf: 'text=Name' }).id, 'com.example:id/open');
    assert.equal(resolveSelector(graph, { text: 'Open', childOf: 'id=com.example:id/row' }).id, 'com.example:id/open');
    assert.equal(resolveSelector(graph, { text: 'Nested', childOf: 'id=com.example:id/row' }), null);
    assert.equal(resolveSelector(graph, { text: 'Nested', within: 'id=com.example:id/row' }).id, 'com.example:id/nestedButton');
    assert.equal(evaluateSelector(graph, { text: 'Open', siblingOf: 'text=Missing' }).complete, false);
    assert.equal(validateSelector({ text: 'Open', siblingOf: { text: 'Name', within: 'id=com.example:id/row' } }), false);
});

test('hasDescendant tests descendants of a retained control without flattening or text deduplication', () => {
    const tree = list(item('Same') + item('Same', '[10,100][90,120]', 'second'));
    const graph = parseUiGraph(tree, { rpcTarget: true, screen: { width: 100, height: 200 } });
    assert.equal(resolveSelector(graph, { id: 'com.example:id/list', hasDescendant: 'text=Same' }).id, 'com.example:id/list');
    assert.equal(resolveSelector(graph, { id: 'com.example:id/item', hasDescendant: 'text=Same' }), null);
});

test('structural selectors reach the production action and expectation paths', async () => {
    const h = await harness({ dump: relationTree });
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
        action: { command: 'Tap', selector: { text: 'Open', siblingOf: 'text=Name' } },
        expect: { type: 'visible', selector: { text: 'Nested', childOf: 'id=com.example:id/nested' } } });
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(inputs(h).length, 1);
});

test('Collect preserves legitimate duplicate rows and pages, and stops on declared evidence', async () => {
    let page = 0;
    const h = await harness({ dump: () => list(page ? item('Finish') : item('Same') + item('Same', '[10,100][90,120]', 'second')),
        run: args => { if (args.includes('input')) page++; } });
    const result = await execute(h, { command: 'Collect', container: 'id=com.example:id/list', maxPages: 3, until: 'text=Finish' });
    const data = result.details.collection;
    assert.equal(data.stopReason, 'UNTIL_MATCH'); assert.equal(data.pages.length, 2);
    assert.deepEqual(Array.from(data.pages[0].items, row => row.label), ['Same', 'Same']);
    assert.equal(data.deduplicated, false); assert.equal(data.listEndProven, false);
    assert.equal(data.partial, false); assert.equal(inputs(h).length, 1);
    const model = JSON.parse(result.content.find(part => part.type === 'text' && part.text.startsWith('{"collection":')).text);
    assert.deepEqual(model.collection.pages[0].items.map(row => row.label), ['Same', 'Same']);
});

test('Collect no-progress and page limit never claim full list coverage', async () => {
    for (const maxPages of [1, 4]) {
        const h = await harness({ dump: () => list(item('Same')) });
        const result = await execute(h, { command: 'Collect', container: 'id=com.example:id/list', maxPages });
        assert.equal(result.details.collection.stopReason, maxPages === 1 ? 'MAX_PAGES' : 'NO_PROGRESS');
        assert.equal(result.details.collection.partial, true);
        assert.equal(result.details.execution.outcome, 'unknown');
        assert.equal(inputs(h).length, maxPages === 1 ? 0 : 1);
    }
});

test('Collect cannot scroll through read-only policy or replay unknown input', async () => {
    const denied = await harness({ config: { INTERACTION_POLICY: { readOnlyPackages: ['com.example'] } }, dump: () => list(item('First')) });
    await assert.rejects(execute(denied, { command: 'Collect', container: 'id=com.example:id/list' }), { code: 'POLICY_DENIED' });
    assert.equal(inputs(denied).length, 0);
    const unknown = await harness({ dump: () => list(item('First')), run: args => { if (args.includes('input')) throw Error('Lost ACK'); } });
    await assert.rejects(execute(unknown, { command: 'Collect', container: 'id=com.example:id/list' }), error => {
        assert.equal(error.execution.outcome, 'unknown'); assert.equal(error.details.collection.pagesCollected, 1);
        assert.equal(error.details.collection.pages, undefined); return true;
    });
    assert.equal(inputs(unknown).length, 1);
});

test('Collect truncation and missing structural evidence cannot claim a complete declared range', async () => {
    const h = await harness({ dump: () => list(item('x'.repeat(150))) });
    const result = await execute(h, { command: 'Collect', container: 'id=com.example:id/list', until: 'id=com.example:id/item' });
    assert.equal(result.details.collection.stopReason, 'UNTIL_MATCH');
    assert.equal(result.details.collection.partial, true); assert.equal(result.details.collection.truncated, true);
    assert.equal(result.details.execution.outcome, 'unknown');
    await assert.rejects(execute(h, { command: 'Collect', container: 'id=com.example:id/list',
        until: { text: 'Finish', within: 'id=com.example:id/missing' } }), { code: 'COLLECT_EVIDENCE_INCOMPLETE' });
    assert.equal(inputs(h).length, 0);
});
