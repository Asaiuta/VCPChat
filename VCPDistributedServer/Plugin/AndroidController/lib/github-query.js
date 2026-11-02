'use strict';

const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { withBudget } = require('./request-budget');
const MAX_BYTES = 256 * 1024;
const capability = Object.freeze({
    name: 'github-public-issue', readOnly: true, idempotent: true, permission: 'public-anonymous',
    parameters: { type: 'object', additionalProperties: false, required: ['owner', 'repo', 'number'], properties: {
        owner: { type: 'string', maxLength: 39, pattern: '^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$' },
        repo: { type: 'string', maxLength: 100, pattern: '^[A-Za-z0-9_.-]+$' },
        number: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9]\\d*$' }] },
    } },
    query: 'Repeat GET /repos/{owner}/{repo}/issues/{number}; no cache or automatic retry',
    failures: ['denied', 'not_found', 'gone', 'rate_limited', 'invalid_request', 'unavailable', 'timeout', 'aborted', 'network', 'invalid_response', 'response_too_large'],
});
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });

function validate(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some(key => !['owner', 'repo', 'number'].includes(key))) throw invalid('Expected only owner, repo, number');
    const { owner, repo } = params;
    const number = typeof params.number === 'string' && /^[1-9]\d*$/.test(params.number) ? Number(params.number) : params.number;
    if (typeof owner !== 'string' || owner.length > 39 || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(owner)
        || typeof repo !== 'string' || repo.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(repo) || /^\.+$/.test(repo)
        || !Number.isSafeInteger(number) || number < 1) throw invalid('Invalid GitHub owner, repo or positive issue number');
    return { owner, repo, number };
}

function cancelBody(body) {
    try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {}
}

async function readBody(response, signal) {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        cancelBody(response.body);
        throw Object.assign(new Error('Response too large'), { code: 'response_too_large' });
    }
    if (!response.body) throw new Error('Missing body');
    const reader = response.body.getReader();
    const abort = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            if (signal.aborted) throw signal.reason;
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_BYTES) {
                cancelBody(reader);
                throw Object.assign(new Error('Response too large'), { code: 'response_too_large' });
            }
            chunks.push(Buffer.from(value));
        }
        return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } finally {
        signal.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}

async function queryGitHub(params, { fetch = globalThis.fetch, timeoutMs = 5000, signal } = {}) {
    const { owner, repo, number } = validate(params);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw invalid('API timeout must be 1–15000ms');
    const started = performance.now();
    const endpoint = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
    const requestId = randomUUID();
    const finish = (receipt, failure = null) => ({
        outcome: receipt ? 'verified' : failure.code === 'timeout' || failure.code === 'network' ? 'unknown' : 'failed',
        receipt, failure, fallbackEligible: false, modelCalls: 0, sideEffects: 0,
        requestId, endpoint, fetchedAt: new Date().toISOString(), timings: { totalMs: performance.now() - started },
    });
    try {
        return await withBudget(timeoutMs, signal, async requestSignal => {
            let response;
            try {
                response = await fetch(endpoint, { method: 'GET', redirect: 'error', signal: requestSignal,
                    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'VCPChat-AndroidController' } });
            } catch (error) {
                if (requestSignal.aborted) throw requestSignal.reason;
                return finish(null, { code: 'network' });
            }
            if (requestSignal.aborted) { cancelBody(response.body); throw requestSignal.reason; }
            if (response.status !== 200) {
                cancelBody(response.body);
                const status = response.status;
                const code = status === 429 || (status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) ? 'rate_limited'
                    : status === 401 || status === 403 ? 'denied' : status === 404 ? 'not_found' : status === 410 ? 'gone'
                        : status === 422 || status === 400 ? 'invalid_request' : 'unavailable';
                return finish(null, { code, httpStatus: status });
            }
            try {
                const data = await readBody(response, requestSignal);
                const hasPR = data && Object.hasOwn(data, 'pull_request');
                if (hasPR && (!data.pull_request || typeof data.pull_request !== 'object' || Array.isArray(data.pull_request)
                    || data.pull_request.url !== `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`)) throw new Error('Invalid PR reference');
                const kind = hasPR ? 'pr' : 'issue';
                const htmlUrl = `https://github.com/${owner}/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`;
                const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
                if (!data || data.number !== number || !['open', 'closed'].includes(data.state)
                    || typeof data.title !== 'string' || data.title.length > 1024
                    || typeof data.html_url !== 'string' || data.html_url.toLowerCase() !== htmlUrl.toLowerCase()
                    || !date(data.updated_at) || (data.closed_at !== null && !date(data.closed_at))) throw new Error('Invalid receipt');
                return finish({ repository: `${owner}/${repo}`, number, kind, state: data.state, title: data.title,
                    htmlUrl: data.html_url, updatedAt: data.updated_at, closedAt: data.closed_at,
                    ...(kind === 'pr' ? { merged: null } : {}), httpStatus: 200,
                    githubRequestId: response.headers.get('x-github-request-id') });
            } catch (error) {
                if (requestSignal.aborted) throw requestSignal.reason;
                return finish(null, { code: error.code === 'response_too_large' ? error.code : 'invalid_response', httpStatus: 200 });
            }
        });
    } catch (error) {
        return finish(null, { code: error.code === 'TIMEOUT' ? 'timeout' : error.code === 'ABORTED' ? 'aborted' : 'network' });
    }
}

module.exports = { queryGitHub, capability };
