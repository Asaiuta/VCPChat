'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { questionsFor, select, modelElements } = require('../modules/services/androidUiTaskDecision');
const { response } = require('./helpers/android-ui-task-world.cjs');
const task = { goal: 'Search for a named book', completion: null, inputs: { query: 'Named book' } };
const sample = { observation: { id: randomUUID() }, ui: { completion: null } };
const candidates = [
    { candidateId: 'c0', action: { command: 'Tap', nodeRef: 'n0' }, description: 'Search' },
    { candidateId: 'c1', action: { command: 'Tap', nodeRef: 'n1' }, description: 'Settings' },
    { candidateId: 'c2', action: { command: 'Fill', nodeRef: 'n2', inputRef: 'query' }, description: 'Enter named query' }];

test('every speculative question is bound to the goal and observation', () => {
    const space = questionsFor(task, sample, candidates);
    assert.ok(Object.keys(space.questions).every(k => k.includes(sample.observation.id.replaceAll('-', ''))));
    assert.ok(Object.values(space.questions).every(q => q.instructions.includes(task.goal)));
    assert.equal(Object.hasOwn(space.questions[space.key + '_Tap'].criteria, 'c2'), false);
    assert.ok(space.questions[space.key].criteria.Fill.includes('Named book'));
});

test('shared contexts preserve ordered ancestry without duplicating labels or field values', () => {
    const parent = { contextId: 'a0', resourceId: 'com.example:id/history', role: 'List', label: 'History' };
    const source = [{ nodeRef: 'n0', ancestors: [parent], value: '', valueTruncated: false },
        { nodeRef: 'n1', ancestors: [{ ...parent }], value: 'existing', valueTruncated: false }];
    const projected = modelElements(source);
    assert.equal(projected.contexts.length, 1);
    assert.deepEqual(projected.elements.map(e => e.contextRefs), [['p0'], ['p0']]);
    assert.deepEqual(projected.elements.map(e => e.value), ['', 'existing']);
    assert.deepEqual(source[0].ancestors, [parent]);
});

test('strong operation cannot authorize a weak target; head scores are not multiplied', () => {
    const space = questionsFor(task, sample, candidates), r = response(space.questions, 'c0');
    const p = r.answers[space.key + '_Tap'].probabilities;
    p.c0 = 0.89; p.c1 = 0.11;
    assert.throws(() => select(r, space, candidates), e => e.code === 'TASK_JEV_UNCERTAIN' && e.heads[1].probability === 0.89);
    p.c0 = 0.95; p.c1 = 0.05;
    const operation = r.answers[space.key].probabilities;
    operation.Tap = 0.95; operation.Fill = 0.05;
    const result = select(r, space, candidates);
    assert.equal(result.choice, 'c0'); assert.equal(result.probability, 0.95); assert.equal(result.heads.length, 2);
});

test('unselected branch is never executed or used to override the selected branch', () => {
    const space = questionsFor(task, sample, candidates), r = response(space.questions, 'c0');
    r.answers[space.key + '_Fill'] = { malformed: 'unused response' };
    assert.equal(select(r, space, candidates).choice, 'c0');
    r.answers[space.key + '_Tap'].probabilities = { c2: 1, escalate: 0 };
    assert.throws(() => select(r, space, candidates), { code: 'TASK_JEV_INVALID' });
});

test('response cannot smuggle an arbitrary action, a new input key or a foreign observation head', () => {
    const space = questionsFor(task, sample, candidates);
    for (const corrupt of [r => { r.action = 'tap'; }, r => { r.answers.foreign = {}; },
        r => { r.answers[space.key + '_Tap'].inputRef = 'generated'; }]) {
        const r = response(space.questions, 'c0'); corrupt(r);
        assert.throws(() => select(r, space, candidates), { code: 'TASK_JEV_INVALID' });
    }
});
