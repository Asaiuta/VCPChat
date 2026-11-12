'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { layoutEvidence, m2IdleDiagnostic } = require('../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence');
const { waitForIdle } = require('../VCPDistributedServer/Plugin/AndroidController/lib/idle-wait');
const { harness } = require('./helpers/android-service-harness.cjs');
const PACKAGE = 'com.vcpchat.m15fixture';
const SECRET = 'PAGE_OR_USER_TEXT_MUST_NOT_ESCAPE';
const screen = { width: 100, height: 200 };
const probe = { wakefulness: 'Awake', focus: { package: PACKAGE, component: PACKAGE + '/.MainActivity', window: SECRET },
    size: screen, displayId: 0, rotation: 0, keyguard: { showing: false, inputRestricted: false } };
const node = (index, left = 0, extra = '') => `<node package="${PACKAGE}" class="${SECRET}" resource-id="${PACKAGE}:id/${index === 'color' ? 'm2_color' : SECRET + index}" text="${SECRET}" content-desc="${SECRET}" bounds="[${left},0][${left + 10},20]" ${extra}/>`;
const tree = (left = 0, count = 0, colorExtra = '') => `<hierarchy rotation="0">${Array.from({ length: count }, (_, i) => node(i)).join('')}${node('color', left, colorExtra)}</hierarchy>`;
const graphOf = xml => parseUiGraph(xml, { limit: 1, screen, rpcTarget: true });
function diagnostic(xml, p = probe) { const graph = graphOf(xml); return m2IdleDiagnostic(graph, p, layoutEvidence(graph, p)); }
const plain = value => JSON.parse(JSON.stringify(value));

test('fixture geometry diagnostics contain no page text, id, class or foreground strings', () => {
    const d = diagnostic(tree(5));
    assert.equal(d.complete, true);
    assert.match(d.digest, /^[a-f0-9]{64}$/);
    assert.match(d.geometryDigest, /^[a-f0-9]{64}$/);
    assert.equal(d.rawNodeCount, 1);
    assert.equal(d.visibleNodeCount, 1);
    assert.equal(d.colorNodeCount, 1);
    assert.deepEqual(d.colorGeometry[0].bounds, { left: 5, top: 0, right: 15, bottom: 20 });
    for (const sensitive of [SECRET, PACKAGE, 'm2_color', 'resource-id', 'content-desc']) assert.equal(JSON.stringify(d).includes(sensitive), false);
});

test('full layout and raw geometry digests cover motion beyond public limit and diagnostic geometry cap', () => {
    const first = diagnostic(tree(1, 180)), moved = diagnostic(tree(7, 180));
    assert.equal(first.rawNodeCount, 181);
    assert.equal(first.geometry.length, 128);
    assert.equal(first.geometryTruncated, true);
    assert.equal(first.colorGeometry.length, 1);
    assert.equal(first.colorGeometryTruncated, false);
    assert.notEqual(first.digest, moved.digest);
    assert.notEqual(first.geometryDigest, moved.geometryDigest);
    assert.notDeepEqual(first.colorGeometry, moved.colorGeometry);
    assert.deepEqual(first.geometry, moved.geometry);
});

test('diagnostics disclose hidden/excluded target geometry without changing visible-layout contract', () => {
    const first = diagnostic(tree(1, 1, 'visible-to-user="false"'));
    const moved = diagnostic(tree(7, 1, 'visible-to-user="false"'));
    assert.equal(first.complete, true);
    assert.equal(first.visibleNodeCount, 1);
    assert.equal(first.colorGeometry[0].visibleBounds, null);
    assert.equal(first.digest, moved.digest);
    assert.notEqual(first.geometryDigest, moved.geometryDigest);
});

test('duplicate fixture targets remain explicit and target evidence is separately bounded', () => {
    const d = diagnostic('<hierarchy rotation="0">' + node(0) + node('color').repeat(12) + '</hierarchy>');
    assert.equal(d.colorNodeCount, 12);
    assert.equal(d.colorGeometry.length, 8);
    assert.equal(d.colorGeometryTruncated, true);
});

test('fixed diagnostics refuse other foregrounds, components and locked contexts', () => {
    for (const p of [{ ...probe, focus: { ...probe.focus, package: 'com.other' } },
        { ...probe, focus: { ...probe.focus, component: PACKAGE + '/.Other' } },
        { ...probe, keyguard: { showing: true } }, { ...probe, wakefulness: 'Asleep' }]) assert.equal(diagnostic(tree(), p), null);
});

async function serviceFor(options = {}) {
    return harness({ config: { UI_SERVER: 'false' }, dump: () => tree(5),
        client: { async probeScreen() { return plain(probe); } }, ...options });
}
const idle = (h, context, extra = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
    action: { command: 'Wait', mode: 'idle' }, waitTimeoutMs: 1000, timeoutMs: 5000, ...extra }, context);

test('trusted hook receives monotonic dump boundaries, full digest and geometry; receipt/history stay clean', async () => {
    const h = await serviceFor(), samples = [];
    try {
        const r = await idle(h, { onM2IdleSample: sample => samples.push(sample) });
        assert.equal(r.details.execution.outcome, 'verified');
        assert.equal(r.details.idleMode, 'layout_stable');
        assert.equal(samples.length, 2);
        assert.equal(h.dumpCount, 2);
        for (const [i, d] of samples.entries()) {
            assert.equal(d.sampleIndex, i + 1);
            assert.equal(d.clock, 'host-performance.now-ms');
            assert.equal(d.phase, 'complete');
            assert.equal(d.diagnosticAvailable, true);
            assert.equal(d.completedWithinRequestDeadline, true);
            assert.ok(d.startedAtMs <= d.dumpStartedAtMs && d.dumpStartedAtMs <= d.dumpCompletedAtMs && d.dumpCompletedAtMs <= d.completedAtMs);
            assert.match(d.digest, /^[a-f0-9]{64}$/);
            assert.equal(JSON.stringify(d).includes(SECRET), false);
        }
        assert.ok(samples[1].startedAtMs - samples[0].completedAtMs >= 190);
        assert.equal(samples[0].digest, samples[1].digest);
        assert.equal(JSON.stringify(r).includes('idleSample'), false);
        assert.equal(JSON.stringify(r).includes('geometryDigest'), false);
        assert.equal(JSON.stringify(r).includes(SECRET), false);
        const history = await h.service.processToolCall({ command: 'Manage', operation: 'actionHistory', serial: 'A' });
        assert.equal(JSON.stringify(history).includes('geometryDigest'), false);
        assert.equal(JSON.stringify(history).includes(SECRET), false);
    } finally { await h.service.cleanup(); }
});

test('public tool arguments cannot enable hooks and a nonfixture context never invokes one', async () => {
    let calls = 0;
    const h = await serviceFor();
    try { await idle(h, undefined, { onM2IdleSample() { calls++; }, debug: true }); assert.equal(calls, 0); }
    finally { await h.service.cleanup(); }
    const other = await serviceFor({ dump: () => tree().replaceAll(PACKAGE, 'com.example'),
        client: { async probeScreen() { return { ...plain(probe), focus: { package: 'com.example', component: 'com.example/.Main', window: 'Main' } }; } } });
    try { assert.equal((await idle(other, { onM2IdleSample() { calls++; } })).details.idleMode, 'layout_stable'); assert.equal(calls, 0); }
    finally { await other.service.cleanup(); }
});

for (const hook of [() => { throw new Error(SECRET); }, () => Promise.reject(new Error(SECRET))]) {
    test('throwing or rejected diagnostic collectors cannot change production idle result', async () => {
        const h = await serviceFor();
        try { assert.equal((await idle(h, { onM2IdleSample: hook })).details.idleMode, 'layout_stable'); assert.equal(h.dumpCount, 2); }
        finally { await h.service.cleanup(); }
    });
}

test('failed dump emits timing-only evidence without copying exception/page content or retrying', async () => {
    const error = Object.assign(new Error(SECRET), { code: 'ADB_FAILED' });
    const h = await serviceFor({ dump: () => error }), samples = [];
    try {
        await assert.rejects(idle(h, { onM2IdleSample: d => samples.push(d) }), { code: 'ADB_FAILED' });
        assert.equal(samples.length, 1);
        assert.equal(samples[0].phase, 'sample-error');
        assert.equal(samples[0].diagnosticAvailable, false);
        assert.equal(samples[0].dumpCompletedAtMs, null);
        assert.equal(JSON.stringify(samples).includes(SECRET), false);
        assert.equal(h.dumpCount, 1);
    } finally { await h.service.cleanup(); }
});

test('two equal periodic positions and a stale dump are observationally indistinguishable without independent sample-time geometry', async () => {
    let time = 0, count = 0;
    const runtime = { now: () => time, check() {}, async pause(ms) { time += ms; } };
    const evidence = layoutEvidence(graphOf(tree(5)), probe);
    const result = await waitForIdle({ runtime, timeoutMs: 4500, sample: async () => { count++; return evidence; } });
    assert.deepEqual(result, { matched: true, idleMode: 'layout_stable' });
    assert.equal(count, 2);
    assert.equal(time, 200);
    assert.deepEqual(diagnostic(tree(5)), diagnostic(tree(5)));
});

test('diagnostics at the 4500ms deadline preserve unknown and native 1500ms cap without another sample', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let probes = 0;
    const samples = [];
    const h = await serviceFor({ config: { UI_SERVER: 'true' }, uiServer: { ok: true, xml: tree(5), invoke: () => null },
        client: { async probeScreen() { if (++probes === 3) t.mock.timers.tick(4500); return plain(probe); } } });
    try {
        const started = Date.now();
        const r = await idle(h, { onM2IdleSample: d => samples.push(d) }, { waitTimeoutMs: 4500, timeoutMs: 10000 });
        assert.equal(Date.now() - started, 4500);
        assert.equal(r.details.execution.outcome, 'unknown');
        assert.equal(r.details.execution.verification.error, 'IDLE_TIMEOUT');
        assert.equal(r.details.idleMode, null);
        assert.equal(samples.length, 1);
        assert.equal(samples[0].phase, 'complete');
        assert.equal(samples[0].completedWithinRequestDeadline, false);
        assert.equal(samples[0].requestDeadlineUnixMs, started + 4500);
        assert.equal(h.uiServer.dumped, 1);
        const native = h.calls.filter(call => call[0] === 'rpc');
        assert.equal(native.length, 1);
        assert.equal(native[0][1], 'waitForIdle');
        assert.deepEqual(plain(native[0][2]), [1500]);
    } finally { await h.service.cleanup(); }
});


for (const rejectIdle of [false, true]) test(`runner scopes diagnostics to each idle call and flushes on ${rejectIdle ? 'failure' : 'completion'}`, async () => {
    const { main } = require('../scripts/verify-android-m2.cjs');
    const logs = [], contexts = [];
    const state = { ready: true, resumed: true, package: PACKAGE, protocol: 1,
        session: '11111111-1111-4111-8111-111111111111', mode: 'm2', m2ClicksA: 0, m2ClicksB: 0,
        m2DynamicCounter: 0, m2Ticks: 0, m2Motion: false, m2Label: 'M2 DYNAMIC 0' };
    const service = { async initialize() {}, async cleanup() {}, getRuntimeStatus: () => ({ adbQueue: { depth: 0, pending: 0, running: false } }),
        async processToolCall(args, context) {
            if (args.action?.mode === 'idle') {
                contexts.push(context);
                context.onM2IdleSample({ sampleIndex: 1, clock: 'host-performance.now-ms', digest: 'a'.repeat(64) });
                if (rejectIdle) throw Object.assign(new Error(SECRET), { code: 'UI_SERVER_TIMEOUT' });
                return { details: { execution: { serial: 'A', outcome: 'verified' }, idleMode: 'layout_stable' } };
            }
            assert.equal(context, undefined);
            return { details: { execution: { serial: 'A', outcome: 'dispatched' },
                controls: [{ id: PACKAGE + ':id/m2_color', index: 0 }], snapshotId: 'snap',
                attempts: [{ method: 'click', channel: 'rpc', status: 'dispatched' }] } };
        } };
    const result = await main(['--suite', '--serial', 'A', '--adb', process.execPath], {
        emit: value => logs.push(value), loadService: () => service, loadRuntime: () => ({ assertManagementIdle() {} }),
        spawnSync(file, args) {
            let stdout;
            if (args[0] === 'devices') stdout = 'List of devices attached\nA device\n';
            else if (args.includes('displays')) stdout = `mCurrentFocus=Window{a u0 ${PACKAGE}/.MainActivity}`;
            else if (args.includes('power')) stdout = 'mWakefulness=Awake';
            else if (args.includes('policy')) stdout = 'KeyguardServiceDelegate\n  showing=false\n  inputRestricted=false';
            else if (args.includes('content')) stdout = 'Row: 0 state=' + JSON.stringify(state);
            else if (args.some(a => a.includes('echo PRESENT'))) stdout = 'PRESENT';
            else assert.fail('unexpected device request');
            return { status: 0, stdout };
        },
    });
    assert.equal(result.summary.deviceAcceptance, 'NOT_PASSED');
    assert.equal(contexts.length, rejectIdle ? 1 : 2);
    if (!rejectIdle) assert.notEqual(contexts[0], contexts[1]);
    const samples = logs.filter(value => value.idleSample), summaries = logs.filter(value => value.idleDiagnostic);
    assert.equal(samples.length, contexts.length);
    assert.equal(summaries.length, contexts.length);
    assert.ok(summaries.every(value => value.idleDiagnostic.dumpFreshness === 'unproven'
        && value.idleDiagnostic.stabilityContract === 'two-complete-layout-samples-equal'));
    assert.equal(JSON.stringify(logs).includes(SECRET), false);
});
