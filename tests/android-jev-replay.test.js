'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('./fixtures/android-jev/replay.json');
const { FAMILIES, PRIVATE, validateCatalog, coverage, replay } = require('./helpers/android-jev-replay.cjs');

test('replay catalog is closed, traceable and covers every family boundary', () => {
    validateCatalog(catalog);
    assert.deepEqual(coverage(catalog), []);
    const broken = structuredClone(catalog); broken.cases[0].script = 'state.page = "results"';
    assert.throws(() => validateCatalog(broken), /unknown case key script/);
    const vocabulary = structuredClone(catalog); vocabulary.cases[0].transitions = [{ on: 'write', index: 1, effect: 'teleport' }];
    assert.throws(() => validateCatalog(vocabulary), /transition vocabulary/);
    const untraced = structuredClone(catalog); untraced.cases[0].source.derivedFrom = 'tests/missing.test.js';
    assert.throws(() => validateCatalog(untraced), /existing handwritten derivation/);
    const thin = structuredClone(catalog); thin.cases = thin.cases.filter(c => c.family !== 'route' || !(c.expect.receipts || []).includes('unknown'));
    assert.deepEqual(coverage(thin), ['route:unknownWrite']);
});

for (const c of catalog.cases) test(`replay ${c.family}/${c.name}`, async () => {
    const { result, rows, models, observed } = await replay(c);
    const e = c.expect;
    assert.equal(observed.status, e.status, JSON.stringify(observed));
    if (e.code) assert.equal(observed.code, e.code);
    else if (e.status === 'stopped') assert.ok(observed.code, 'a stop must carry a code');
    assert.deepEqual(observed.writes, e.writes, 'device-side writes, in order');
    assert.deepEqual(observed.effect, e.effect, 'independent world effect');
    for (const key of ['receipts', 'modelCalls', 'staleEvents', 'replanCalls']) {
        if (e[key] !== undefined) assert.deepEqual(observed[key], e[key], key);
    }
    assert.equal(rows[0]?.policyVersion, FAMILIES[c.family].policy);
    assert.equal(result.decisionPolicy.calibrated, false);
    assert.ok(['completed', 'stopped'].includes(rows.at(-1).type));
    // Generic mode intentionally sends bounded labels/inputs to its decision
    // service; durable records still exclude those values.
    assert.doesNotMatch(JSON.stringify(c.family === 'ui_task' ? [result, rows] : [result, rows, models]), PRIVATE);
});

// Discrimination control: if refusing every decision still produced the same
// writes and effect, the expectation would not depend on the replayed answers.
for (const c of catalog.cases.filter(c => c.expect.status === 'completed' && c.expect.writes.length)) {
    test(`counterfactual ${c.family}/${c.name} diverges without the injected decisions`, async () => {
        const { observed } = await replay(c, { answers: Array(16).fill('escalate'), assistance: null,
            task: { ...(c.task || {}), assistance: undefined } });
        // A rejected task differs from any expectation for the wrong reason.
        assert.ok(['completed', 'stopped'].includes(observed.status), observed.code);
        assert.notDeepEqual(observed.writes, c.expect.writes);
        assert.notDeepEqual(observed.effect, c.expect.effect);
    });
}
