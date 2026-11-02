'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queryGitHub, capability } = require('../VCPDistributedServer/Plugin/AndroidController/lib/github-query');
const params = { owner: 'nodejs', repo: 'node', number: 1 };
const item = () => ({ number: 1, title: 'A real issue shape', state: 'closed', html_url: 'https://github.com/nodejs/node/issues/1', updated_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-01T00:00:00Z' });
function reply(data = item(), status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers }); }

test('capability declares anonymous public read, strict parameters and repeatable query', () => {
    assert.equal(capability.readOnly, true); assert.equal(capability.idempotent, true);
    assert.equal(capability.parameters.additionalProperties, false);
    assert.deepEqual(capability.parameters.required, ['owner', 'repo', 'number']);
    assert.equal(capability.permission, 'public-anonymous');
});
test('one anonymous GET produces a minimal business receipt, no body/comments or model', async () => {
    const calls = [];
    const result = await queryGitHub(params, { fetch: async (...args) => { calls.push(args); return reply({ ...item(), body: 'PRIVATE_EXTRA', comments: 123 }); } });
    assert.equal(result.outcome, 'verified'); assert.equal(result.receipt.kind, 'issue');
    assert.equal(result.receipt.state, 'closed'); assert.equal(result.receipt.number, 1);
    assert.equal(result.modelCalls, 0); assert.equal(result.sideEffects, 0);
    assert.equal(calls.length, 1); assert.equal(calls[0][0], 'https://api.github.com/repos/nodejs/node/issues/1');
    assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[0][1].method, 'GET');
    assert.equal(Object.keys(calls[0][1].headers).some(k => k.toLowerCase() === 'authorization'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_EXTRA'), false);
    assert.ok(result.timings.totalMs >= 0); assert.equal(result.fallbackEligible, false);
});
test('PR is marked as PR; closed never implies merged', async () => {
    const result = await queryGitHub(params, { fetch: async () => reply({ ...item(), html_url: 'https://github.com/nodejs/node/pull/1', pull_request: { url: 'https://api.github.com/repos/nodejs/node/pulls/1' } }) });
    assert.equal(result.receipt.kind, 'pr'); assert.equal(result.receipt.merged, null);
});
test('invalid path arguments and extra credentials are rejected before fetch', async () => {
    let calls = 0;
    for (const bad of [{ ...params, owner: '../x' }, { ...params, repo: '..' }, { ...params, number: '1;id' }, { ...params, number: 0 }, { ...params, number: 1.2 }, { ...params, token: 'no' }, { ...params, url: 'http://localhost/' }]) {
        await assert.rejects(queryGitHub(bad, { fetch: async () => { calls++; } }), e => e.code === 'INVALID_ARGUMENT');
    }
    assert.equal(calls, 0);
});
test('strict tool-string number is accepted', async () => {
    assert.equal((await queryGitHub({ ...params, number: '1' }, { fetch: async () => reply() })).outcome, 'verified');
});
test('HTTP failures are classified without retry or automatic GUI fallback', async () => {
    for (const [status, headers, code] of [[401, {}, 'denied'], [403, {}, 'denied'], [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'], [404, {}, 'not_found'], [410, {}, 'gone'], [429, {}, 'rate_limited'], [500, {}, 'unavailable'], [422, {}, 'invalid_request']]) {
        let calls = 0;
        const result = await queryGitHub(params, { fetch: async () => { calls++; return reply({}, status, headers); } });
        assert.equal(result.outcome, 'failed'); assert.equal(result.failure.code, code);
        assert.equal(result.fallbackEligible, false); assert.equal(calls, 1);
    }
});
test('mismatched identity, malformed payload and invalid state cannot verify business success', async () => {
    for (const data of [{}, { ...item(), number: 2 }, { ...item(), state: 'merged' }, { ...item(), html_url: 'https://evil.test/issues/1' }, { ...item(), updated_at: 'yesterday' }]) {
        const result = await queryGitHub(params, { fetch: async () => reply(data) });
        assert.equal(result.failure.code, 'invalid_response'); assert.equal(result.receipt, null);
    }
});
test('response body has a fixed byte ceiling even without Content-Length', async () => {
    const result = await queryGitHub(params, { fetch: async () => new Response('x'.repeat(300000)) });
    assert.equal(result.failure.code, 'response_too_large');
});
test('timeout covers uncooperative fetch and body read, late results cannot become success', async () => {
    for (const fetch of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }))]) {
        const result = await queryGitHub(params, { fetch, timeoutMs: 10 });
        assert.equal(result.failure.code, 'timeout'); assert.equal(result.receipt, null);
    }
});
test('trusted abort and network error are classified without retries', async () => {
    const c = new AbortController(); c.abort();
    let calls = 0;
    const result = await queryGitHub(params, { signal: c.signal, fetch: async () => { calls++; return reply(); } });
    assert.equal(result.failure.code, 'aborted'); assert.equal(calls, 0);
    const failed = await queryGitHub(params, { fetch: async () => { throw new Error('network details'); } });
    assert.equal(failed.failure.code, 'network'); assert.equal(JSON.stringify(failed).includes('network details'), false);
});

test('PR reference metadata must be a valid object matching this repository and number', async () => {
    for (const pull_request of [true, 'pr', [], {}, { url: 'https://evil.test/pulls/1' }]) {
        const result = await queryGitHub(params, { fetch: async () => reply({ ...item(), html_url: 'https://github.com/nodejs/node/pull/1', pull_request }) });
        assert.equal(result.outcome, 'failed'); assert.equal(result.failure.code, 'invalid_response');
    }
});
test('body cleanup failure cannot erase a known permission failure', async () => {
    const result = await queryGitHub(params, { fetch: async () => ({ status: 403, headers: new Headers(), body: { cancel() { return Promise.reject(new Error('cleanup')); } } }) });
    assert.equal(result.failure.code, 'denied');
});
