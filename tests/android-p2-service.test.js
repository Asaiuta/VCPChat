'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness, xml } = require('./helpers/android-service-harness.cjs');

test('Arbitrate reuses Observe evidence and returns advisory ID without any input', async () => {
    const h = await harness();
    const observed = await h.service.processToolCall({ command: 'Observe' });
    const before = h.calls.length;
    const result = await h.service.processToolCall({ command: 'Observe', mode: 'arbitrate', arbitration: { mode: 'target', goal: 'Go', candidates: '[0]', snapshotId: observed.details.snapshotId } });
    assert.equal(result.details.arbitration.candidateId, 'c0');
    assert.equal(result.details.arbitration.advisory, true);
    assert.equal(result.details.arbitration.target.index, 0);
    assert.equal(result.details.arbitration.target.snapshotId, observed.details.snapshotId);
    assert.equal(h.calls.filter(([kind, args]) => kind === 'adb' && args.includes('input')).length, 0);
    assert.equal(h.dumpCount, 1);
    assert.ok(h.calls.length >= before);
});
test('Arbitrate rejects absent, foreign and expired snapshot before calling Jev', async () => {
    let calls = 0;
    const h = await harness({ services: { jevService: { async decide() { calls++; } } } });
    await assert.rejects(h.service.processToolCall({ command: 'Observe', mode: 'arbitrate', arbitration: { mode: 'page', goal: 'Go', snapshotId: 'bad' } }), e => e.code === 'STALE_SNAPSHOT');
    const observed = await h.service.processToolCall({ command: 'Observe' });
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'B', mode: 'arbitrate', arbitration: { mode: 'page', goal: 'Go', snapshotId: observed.details.snapshotId } }), e => e.code === 'STALE_SNAPSHOT');
    assert.equal(calls, 0);
});
test('page target rule is derived from a validated selector, not user-supplied targetVisible', async () => {
    let calls = 0;
    const h = await harness({ services: { jevService: { async decide() { calls++; throw new Error('disabled'); } } } });
    const observed = await h.service.processToolCall({ command: 'Observe' });
    const args = { mode: 'page', goal: 'Go', snapshotId: observed.details.snapshotId };
    const matched = await h.service.processToolCall({ command: 'Observe', mode: 'arbitrate', arbitration: { ...args, targetSelector: 'text=Go' } });
    assert.equal(matched.details.arbitration.decision, 'target'); assert.equal(calls, 0);
    await assert.rejects(h.service.processToolCall({ command: 'Observe', mode: 'arbitrate', arbitration: { ...args, targetVisible: true } }), { code: 'INVALID_ARGUMENT' });
    assert.equal(calls, 0);
});
test('injected Jev is used once for duplicate labels, with current candidate mapping', async () => {
    let calls = 0;
    const dump = '<hierarchy rotation="0">' + xml().match(/<node.*\/>/)[0] + xml('Other', 80).match(/<node.*\/>/)[0] + '</hierarchy>';
    const h = await harness({ dump: () => dump, services: { jevService: { async decide() { calls++; return { answers: { target: { probabilities: { c0: 0.01, c1: 0.98, none: 0.01 } } } }; } } } });
    const observed = await h.service.processToolCall({ command: 'Observe' });
    const result = await h.service.processToolCall({ command: 'Observe', mode: 'arbitrate', arbitration: { mode: 'target', goal: 'Other', candidates: [0, 1], snapshotId: observed.details.snapshotId } });
    assert.equal(result.details.arbitration.candidateId, 'c1'); assert.equal(calls, 1);
});
test('API capability is discoverable without device work and rejects unsupported or injected endpoints', async () => {
    const h = await harness();
    const before = h.calls.length;
    const caps = await h.service.processToolCall({ command: 'Describe', topic: 'api' });
    assert.equal(caps.details.capabilities[0].name, 'github-public-issue');
    await assert.rejects(h.service.processToolCall({ command: 'Observe', mode: 'api', capability: 'raw-http', params: {} }), e => e.code === 'UNSUPPORTED_CAPABILITY');
    await assert.rejects(h.service.processToolCall({ command: 'Observe', mode: 'api', capability: 'github-public-issue', params: { owner: 'nodejs', repo: 'node', number: 1, url: 'http://localhost' } }), e => e.code === 'INVALID_ARGUMENT');
    assert.equal(h.calls.length, before);
});
test('global Jev is threaded from main through distributed server into direct plugin services', () => {
    const root = path.resolve(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'VCPDistributedServer/VCPDistributedServer.js'), 'utf8');
    assert.match(main.slice(main.indexOf('server = new DistributedServer('), main.indexOf('distributedServer = server;')), /jevService:\s*globalJevService/);
    assert.match(server, /this\.jevService\s*=\s*config\.jevService/);
    assert.match(server, /jevService:\s*this\.jevService/);
});

test('arbitration holds the same device lease and the step deadline cancels its request', async () => {
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let signal;
    const h = await harness({ services: { jevService: { async decide(_s, _q, options) { signal = options.signal; entered(); return new Promise(() => {}); } } } });
    const observed = await h.service.processToolCall({ command: 'Observe' });
    const pending = h.service.processToolCall({ command: 'Observe', mode: 'arbitrate', timeoutMs: 100, arbitration: { mode: 'page', goal: 'details', snapshotId: observed.details.snapshotId } });
    const rejected = assert.rejects(pending, error => error.code === 'STEP_DEADLINE');
    await started;
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'home' } }), error => error.code === 'DEVICE_BUSY');
    await rejected;
    assert.equal(signal.aborted, true);
});

test('observed changing stability reaches the rule-only recovery path', async () => {
    let calls = 0;
    const h = await harness({ dump: n => xml(n ? 'Changed' : 'Go'), services: { jevService: { async decide() { calls++; } } } });
    const observed = await h.service.processToolCall({ command: 'Observe', stable: true });
    assert.equal(observed.details.stability, 'changing');
    const result = await h.service.processToolCall({ command: 'Observe', mode: 'arbitrate', arbitration: { mode: 'recovery', snapshotId: observed.details.snapshotId } });
    assert.equal(result.details.arbitration.route, 'reobserve'); assert.equal(calls, 0);
});

test('an explicit non-default device can arbitrate its own snapshot without switching default', async () => {
    const h = await harness();
    const observed = await h.service.processToolCall({ command: 'Observe', serial: 'B' });
    const result = await h.service.processToolCall({ command: 'Observe', serial: 'B', mode: 'arbitrate', arbitration: { mode: 'target', goal: 'Go', candidates: [0], snapshotId: observed.details.snapshotId } });
    assert.equal(result.details.arbitration.candidateId, 'c0');
    assert.equal(result.details.arbitration.target.serial, 'B'); assert.equal(h.client.serial, 'A');
});
