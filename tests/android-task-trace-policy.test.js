'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { headerSnapshot, eventForTask } = require('../modules/services/androidTaskTraceSchema');
const id = name => `com.example:id/${name}`;
const base = () => ({ schemaVersion: 1, taskId: randomUUID(), serial: 'A', package: 'com.example',
    intent: 'search', inputRefs: ['query'], decision: 'jev', policyVersion: 'search-v9',
    completionPolicyVersion: 'search-completion-v2', budget: { timeoutMs: 60000, maxActions: 6, maxObservations: 96, maxModelCalls: 8 } });
function candidateEvent() {
    const observation = { id: randomUUID(), digest: 'a'.repeat(64), contextDigest: 'b'.repeat(64), controls: 1 };
    const candidate = { candidateId: 'c0', targetId: id('field'), command: 'Fill', evidenceSources: ['id'], postcondition: 'input_readback' };
    const decisionContext = { version: 'search-feedback-v4', observationId: observation.id,
        round: 1, queryVerified: false, screenChanged: null, consecutiveStale: 0, waits: 0, recentActions: [], lastEvent: 'initial',
        remaining: { timeoutMs: 60000, actions: 6, observations: 96, modelCalls: 8, rounds: 8, waits: 2 } };
    return { type: 'candidates', step: 'fill', observation, decisionContext,
        candidates: [{ ...candidate, inputRef: 'query', semantics: { role: 'textfield', hints: ['search'], fieldRelation: 'none' } }] };
}

test('current search accepts declared capabilities and bound candidates', () => {
    const header = base();
    for (const extra of [{ loading: { id: id('loading') } }, { assistance: 'main_agent' },
        { searchActions: { imeAction: 'search' } }, { searchActions: { scroll: {
            command: 'Scroll', container: id('list'), target: id('target'), direction: 'down', maxSwipes: 2 } } },
        { searchActions: { back: { from: id('panel'), target: id('target') } } }]) {
        assert.equal(headerSnapshot({ ...header, ...extra }).policyVersion, 'search-v9');
    }
    const event = candidateEvent();
    assert.deepEqual(eventForTask(event, headerSnapshot(header)), event);
});

for (let version = 1; version < 9; version++) test(`new traces reject retired search-v${version}`, () => {
    assert.throws(() => headerSnapshot({ ...base(), policyVersion: `search-v${version}` }), { code: 'TRACE_INVALID_ARGUMENT' });
});

test('unknown policies and missing completion identity are rejected without coercion', () => {
    let reads = 0;
    for (const version of ['search-v0', 'search-v10', 'search-v9-extra', '__proto__', 'constructor', null, 8,
        { toString() { reads++; return 'search-v9'; } }]) {
        assert.throws(() => headerSnapshot({ ...base(), policyVersion: version }), { code: 'TRACE_INVALID_ARGUMENT' });
    }
    const header = base(); delete header.completionPolicyVersion;
    assert.throws(() => headerSnapshot(header), { code: 'TRACE_INVALID_ARGUMENT' });
    assert.equal(reads, 0);
});

test('current candidates require semantics, input binding and current feedback', () => {
    const snapshot = headerSnapshot(base());
    for (const key of ['semantics', 'inputRef']) {
        const event = candidateEvent(); delete event.candidates[0][key];
        assert.throws(() => eventForTask(event, snapshot), { code: 'TRACE_INVALID_ARGUMENT' });
    }
    for (const version of ['search-feedback-v1', 'search-feedback-v2', 'search-feedback-v3', 'search-feedback-v99']) {
        const event = candidateEvent(); event.decisionContext.version = version;
        assert.throws(() => eventForTask(event, snapshot), { code: 'TRACE_INVALID_ARGUMENT' });
    }
});
