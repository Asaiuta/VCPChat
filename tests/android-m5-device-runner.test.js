'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const runner = require('../scripts/verify-android-m5.cjs');
const PACKAGE = 'com.vcpchat.m15fixture';
function state(variant = 'home') {
    return { ready: true, resumed: true, package: PACKAGE, protocol: 1, session: randomUUID(), mode: 'm5',
        rotation: 0, width: 100, height: 200, m5: { version: 1, variant, stage: variant === 'home' ? 'home' : 'form',
            entries: 0, submissions: 0, textChanges: 0, query: 'M5_SEED_OLD', lastQuery: '',
            resultVisible: variant === 'preexisting', passwordField: variant === 'password' } };
}
const provider = value => `Row: 0 state=${JSON.stringify(value)}\n`;
const windows = `mCurrentFocus=Window{abc u0 ${PACKAGE}/.MainActivity}`;
const power = 'mWakefulness=Awake\nmWakefulness=1';
const policy = 'mKeyguardShowing=false\ninputRestricted=false';

test('M5 runner is probe by default, requires explicit serial and rejects ambiguous options', () => {
    assert.equal(runner.parseArgs(['--serial', 'A']).mode, 'probe');
    for (const argv of [[], ['--suite'], ['--serial', '../A'], ['--serial', 'A', '--probe', '--suite'], ['--serial', 'A', '--only', 'x']]) {
        assert.throws(() => runner.parseArgs(argv));
    }
});

test('Provider evidence requires positive ready/resumed, exact package and complete M5 counters', () => {
    assert.equal(runner.parseState(provider(state())).m5.variant, 'home');
    for (const patch of [{ resumed: false }, { package: 'com.personal' }, { mode: 'gestures' }, { m5: null },
        { m5: { ...state().m5, query: 'x'.repeat(129) } }, { m5: { ...state().m5, submissions: -1 } }]) {
        assert.throws(() => runner.parseState(provider({ ...state(), ...patch })));
    }
});

test('default probe only makes fixed reads and never initializes a service', async () => {
    const calls = []; let loaded = false;
    const result = await runner.main(['--serial', 'A'], { emit() {}, loadService() { loaded = true; throw Error('must not load'); },
        spawnSync(file, args) {
            calls.push(args);
            const command = args.join(' ');
            return { status: 0, stdout: args[0] === 'devices' ? 'List of devices attached\nA device\n'
                : command.includes('window displays') ? windows : command.includes('dumpsys power') ? power
                    : command.includes('window policy') ? policy : provider(state()) };
        } });
    assert.equal(result.exitCode, 0); assert.equal(loaded, false);
    assert.equal(calls.length, 5); assert.ok(calls.every(args => !args.includes('am')));
});

test('unsafe foreground stops suite before Provider, filesystem trace or plugin load', async () => {
    let loaded = false, queried = false;
    await assert.rejects(runner.main(['--suite', '--serial', 'A'], { emit() {}, loadService() { loaded = true; },
        spawnSync(file, args) {
            const command = args.join(' '); if (args.includes('content')) queried = true;
            return { status: 0, stdout: args[0] === 'devices' ? 'List of devices attached\nA device\n'
                : command.includes('window displays') ? windows.replace(PACKAGE, 'com.personal')
                    : command.includes('dumpsys power') ? power : policy };
        } }), { code: 'UNSAFE_OR_UNPROVEN_TARGET_STOP' });
    assert.equal(loaded, false); assert.equal(queried, false);
});

function matrixFixture({ lie = false, unknown = false } = {}) {
    let current; const messages = [], traces = new Map(); let resets = 0;
    const ctx = { serial: 'A', policy: {}, emit: value => messages.push(value), drain: async () => {},
        async reset(variant) { resets++; current = state(variant); }, gate: () => structuredClone(current),
        trace: id => traces.get(id), async run(task, signal) {
            if (signal.aborted) throw Object.assign(Error(), { code: 'STEP_ABORTED' });
            if (unknown) throw Object.assign(Error(), { code: 'DEVICE_STATE_UNCERTAIN' });
            const variant = current.m5.variant;
            const code = ctx.policy.readOnlyPackages?.length ? 'POLICY_DENIED' : ({ duplicate: 'TASK_TARGET_AMBIGUOUS',
                password: 'TASK_TARGET_UNSAFE', preexisting: 'TASK_COMPLETION_PREEXISTS', 'no-result': 'TASK_BUDGET_EXHAUSTED' })[variant] || null;
            const changes = !code || variant === 'no-result';
            if (changes && !lie) Object.assign(current.m5, { entries: variant === 'home' ? 1 : 0,
                submissions: 1, textChanges: 1, query: task.inputs.query, lastQuery: task.inputs.query,
                stage: code ? 'form' : 'results', resultVisible: !code });
            const taskId = randomUUID();
            const receipt = { taskId, serial: 'A', status: code ? 'stopped' : 'completed', code, retryable: false,
                counts: { mainModelCalls: 0, modelCalls: 0, observations: variant === 'no-result' ? 8 : 12 }, receipts: changes
                    ? Array.from({ length: variant === 'home' ? 3 : 2 }, (_, index) => ({ requestId: randomUUID(),
                        outcome: variant === 'no-result' && index === 1 ? 'unknown' : 'verified' })) : [] };
            traces.set(taskId, [{ type: 'task', seq: 0, taskId }, ...receipt.receipts.map((row, index) => ({ type: 'action', phase: 'settled', seq: index + 1, ...row })),
                { type: code ? 'stopped' : 'completed', seq: receipt.receipts.length + 1 }]);
            return { details: { task: receipt, execution: { serial: 'A', outcome: !code ? 'verified' : variant === 'no-result' ? 'unknown' : 'failed' } } };
        } };
    return { ctx, messages, get resets() { return resets; } };
}

test('complete independent matrix accounts for all cases including deliberate stops', async () => {
    const f = matrixFixture(); const result = await runner.runMatrix(f.ctx);
    assert.equal(result.exitCode, 0); assert.equal(result.summary.passed, runner.CASES.length);
    assert.equal(result.summary.notExecuted, 0);
    assert.equal(f.ctx.policy.readOnlyPackages.length, 0);
});

test('self-reported task success without independent App effect fails and retains full matrix denominator', async () => {
    const f = matrixFixture({ lie: true }); const result = await runner.runMatrix(f.ctx);
    assert.equal(result.exitCode, 1); assert.equal(result.summary.passed, 0);
    assert.equal(result.summary.executed, 1); assert.equal(result.summary.notExecuted, runner.CASES.length - 1);
    assert.equal(f.resets, 1);
});

test('unknown transport stops the entire suite without resetting the next case', async () => {
    const f = matrixFixture({ unknown: true }); const result = await runner.runMatrix(f.ctx);
    assert.equal(result.exitCode, 1); assert.equal(f.resets, 1);
    assert.ok(f.messages.some(row => row.code === 'DEVICE_STATE_UNCERTAIN'));
});

test('trace checker rejects leaked inputs, missing atomic receipts and false terminal states', () => {
    const receipt = { taskId: randomUUID(), receipts: [], status: 'stopped' };
    const rows = [{ type: 'task', seq: 0, taskId: receipt.taskId }, { type: 'stopped', seq: 1 }];
    runner.checkTrace(rows, receipt, 'PRIVATE_QUERY');
    assert.throws(() => runner.checkTrace([{ ...rows[0], query: 'PRIVATE_QUERY' }, rows[1]], receipt, 'PRIVATE_QUERY'));
    assert.throws(() => runner.checkTrace([rows[0], { ...rows[1], type: 'completed' }], receipt, 'PRIVATE_QUERY'));
});
