'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const selector = require('../VCPDistributedServer/Plugin/AndroidController/lib/selector');

test('ordinary retrieval acquires graph matching evidence once', () => {
    const controls = [{ text: 'Open' }, { text: 'Open' }];
    let reads = 0;
    const graph = { get controls() { reads++; return controls; } };
    assert.deepEqual(selector.findControls(graph, 'text=Open'), controls);
    assert.equal(reads, 1);
});

test('retrieval agrees with evidence evaluation, including invalid empty-text queries', () => {
    const parent = {};
    const controls = [
        { text: 'Open', id: 'open', index: 0, rawNode: { parent }, bounds: { top: 40 } },
        { text: 'Open', id: 'open', index: 1, rawNode: { parent }, bounds: { top: 10 } },
        { text: '', index: 2, rawNode: { parent } },
    ];
    const graph = { controls, scopeControls: [{ id: 'parent', rawNode: parent }] };
    const sources = [controls, graph, { ...graph, truncated: true },
        { ...graph, truncated: true, matchingControls: controls }, null, {}];
    const queries = ['text=Open', 'text=Missing', 'text=Open#2', { text: 'Open', nth: 0 },
        { text: 'Open', within: 'id=parent' }, { text: 'Open', within: 'id=missing' },
        { regex: '^Open$' }, { regex: '[' }, { text: 'Open', extra: true }];
    for (const source of sources) for (const query of queries) {
        assert.deepEqual(selector.findControls(source, query), selector.evaluateSelector(source, query).hits);
    }
    assert.deepEqual(selector.findControls(graph, { text: '' }), []);
    assert.equal(selector.evaluateSelector(graph, { text: '' }).complete, false);
    assert.deepEqual(selector.findControls({ ...graph, truncated: true }, { text: '' }), []);
    assert.equal(selector.resolveSelector(graph, 'text=Open'), null);
    assert.equal(selector.resolveSelector(graph, { text: 'Open', nth: 0 }), controls[1]);
});

test('retrieval preserves selector accessor rejection and regex-budget uncertainty', () => {
    let reads = 0;
    const query = Object.defineProperty({}, 'text', { get() { reads++; return 'Open'; } });
    assert.deepEqual(selector.findControls([{ text: 'Open' }], query), []);
    assert.equal(reads, 0);
    const controls = [{ text: 'a' }, { text: 'a'.repeat(selector.MAX_REGEX_TEXT_LENGTH + 1) }];
    assert.deepEqual(selector.findControls(controls, { regex: '^a+$' }), []);
    assert.deepEqual(selector.evaluateSelector(controls, { regex: '^a+$' }), {
        hits: [], complete: false, ambiguous: false,
    });
});
