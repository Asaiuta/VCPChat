'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const legacy = require('./verify-android-m15.cjs');
const PACKAGE = legacy.PACKAGE;
const id = name => `${PACKAGE}:id/m5_${name}`;
const fail = code => Object.assign(new Error(code), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const CASES = Object.freeze(['SearchFromHome', 'SearchFromForm', 'DuplicateTargetStop', 'PasswordTargetStop',
    'PreexistingCompletionStop', 'ReadOnlyPolicyStop', 'ObservationBudgetStop', 'PreCancelledTask']);

function parseArgs(argv) {
    const result = { mode: 'probe', adb: 'D:/AI/tools/platform-tools/adb.exe', output: 'artifacts/android-m5-device-2026-11-05' };
    const seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (seen.has(arg)) throw fail('DUPLICATE_OPTION'); seen.add(arg);
        if (arg === '--probe' || arg === '--suite') {
            if (seen.has(arg === '--probe' ? '--suite' : '--probe')) throw fail('CONFLICTING_MODES');
            result.mode = arg.slice(2);
        } else if (['--serial', '--adb', '--output'].includes(arg)) {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw fail('MISSING_OPTION_VALUE');
            result[arg.slice(2)] = value;
        } else throw fail('UNKNOWN_OPTION');
    }
    if (typeof result.serial !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.serial)) throw fail('EXPLICIT_SERIAL_REQUIRED');
    return result;
}

function parseState(text) {
    const match = /^Row: 0 state=(\{[^\r\n]*\})$/.exec(text.trim());
    let state;
    try { state = JSON.parse(match?.[1]); } catch { throw fail('FIXTURE_STATE_UNREADABLE'); }
    if (state?.ready !== true || state.resumed !== true || state.package !== PACKAGE || state.protocol !== 1
        || !/^[a-f0-9-]{36}$/i.test(state.session || '') || state.mode !== 'm5'
        || ![0, 1, 2, 3].includes(state.rotation) || !Number.isSafeInteger(state.width) || state.width < 1
        || !Number.isSafeInteger(state.height) || state.height < 1) throw fail('FIXTURE_STATE_INVALID');
    const s = state.m5;
    if (s?.version !== 1 || !['home', 'form', 'duplicate', 'password', 'preexisting', 'no-result'].includes(s.variant)
        || !['home', 'form', 'results'].includes(s.stage) || typeof s.resultVisible !== 'boolean'
                || typeof s.passwordField !== 'boolean') throw fail('FIXTURE_M5_REQUIRED');
    for (const key of ['entries', 'submissions', 'textChanges']) {
        if (!Number.isSafeInteger(s[key]) || s[key] < 0) throw fail('FIXTURE_STATE_INVALID');
    }
    for (const key of ['query', 'lastQuery']) if (typeof s[key] !== 'string' || s[key].length > 128) throw fail('FIXTURE_STATE_INVALID');
    return state;
}

function taskOf(serial, entry, query, budget = {}) {
    return { serial, package: PACKAGE, intent: 'search', inputs: { query },
        targets: { ...(entry ? { entry: id('entry') } : {}), field: id('query'), submit: id('search_go') },
        completion: { type: 'visible', id: id('results') }, decision: 'rules',
        budget: { timeoutMs: 120000, maxActions: entry ? 3 : 2, maxObservations: 64, maxModelCalls: 0, ...budget } };
}

function checkTrace(rows, receipt, query) {
    assert.ok(rows.length > 1 && rows[0].type === 'task');
    assert.equal(rows[0].taskId, receipt.taskId);
    assert.deepEqual(rows.map(row => row.seq), rows.map((_, index) => index));
    const settled = rows.filter(row => row.type === 'action' && row.phase === 'settled');
    assert.deepEqual(settled.map(row => [row.requestId, row.outcome]), receipt.receipts.map(row => [row.requestId, row.outcome]));
    assert.ok(!JSON.stringify(rows).includes(query), 'input values must not enter persistent trace');
    assert.ok(rows.every(row => !['text', 'query', 'label', 'xml', 'rawError', 'message'].some(key => Object.hasOwn(row, key))));
    assert.equal(rows.at(-1).type, receipt.status === 'completed' ? 'completed' : 'stopped');
}

async function runMatrix(ctx) {
    const definitions = [
        ['SearchFromHome', 'home', true, 'M5_中文_第一轮', null],
        ['SearchFromForm', 'form', false, 'M5_second_value', null],
        ['DuplicateTargetStop', 'duplicate', false, 'M5_DUPLICATE', 'TASK_TARGET_AMBIGUOUS'],
        ['PasswordTargetStop', 'password', false, 'M5_NOT_A_PASSWORD', 'TASK_TARGET_UNSAFE'],
        ['PreexistingCompletionStop', 'preexisting', false, 'M5_OLD_MARKER', 'TASK_COMPLETION_PREEXISTS'],
        ['ReadOnlyPolicyStop', 'form', false, 'M5_POLICY', 'POLICY_DENIED'],
        ['ObservationBudgetStop', 'no-result', false, 'M5_BUDGET', 'TASK_BUDGET_EXHAUSTED'],
        ['PreCancelledTask', 'form', false, 'M5_CANCELLED', 'STEP_ABORTED'],
    ];
    assert.deepEqual(definitions.map(row => row[0]), CASES);
    const results = [];
    for (const [name, variant, entry, query, expectedCode] of definitions) {
        ctx.emit({ phase: 'case-start', name });
        try {
            await ctx.drain();
            await ctx.reset(variant);
            const before = ctx.gate();
            assert.equal(before.m5.submissions, 0); assert.equal(before.m5.entries, 0);
            assert.equal(before.m5.textChanges, 0);
            assert.equal(before.m5.passwordField, variant === 'password', 'fixture must prove its actual field transformation');
            ctx.policy.readOnlyPackages = name === 'ReadOnlyPolicyStop' ? [PACKAGE] : [];
            const task = taskOf(ctx.serial, entry, query, name === 'ObservationBudgetStop' ? { maxObservations: 8 } : {});
            const controller = new AbortController();
            if (name === 'PreCancelledTask') controller.abort();
            let result;
            if (name === 'PreCancelledTask') {
                await assert.rejects(ctx.run(task, controller.signal), { code: 'STEP_ABORTED' });
            } else {
                result = await ctx.run(task, controller.signal);
                const receipt = result.details.task;
                assert.equal(receipt.serial, ctx.serial); assert.equal(result.details.execution.serial, ctx.serial);
                assert.equal(receipt.counts.modelCalls, 0); assert.equal(receipt.counts.mainModelCalls, 0);
                assert.equal(receipt.retryable, false);
                if (expectedCode === null) {
                    assert.equal(receipt.status, 'completed'); assert.equal(result.details.execution.outcome, 'verified');
                    assert.equal(receipt.receipts.length, entry ? 3 : 2);
                    assert.ok(receipt.receipts.every(row => row.outcome === 'verified'));
                } else {
                    assert.equal(receipt.status, 'stopped'); assert.equal(receipt.code, expectedCode);
                    assert.equal(result.details.execution.outcome, name === 'ObservationBudgetStop' ? 'unknown' : 'failed');
                    if (name === 'ObservationBudgetStop') {
                        assert.equal(receipt.receipts.length, 2); assert.equal(receipt.receipts.at(-1).outcome, 'unknown');
                        assert.equal(receipt.counts.observations, 8);
                    } else assert.ok(receipt.receipts.every(row => row.outcome === 'failed'));
                }
                checkTrace(ctx.trace(receipt.taskId), receipt, query);
            }
            await ctx.drain();
            const after = ctx.gate();
            assert.equal(after.session, before.session);
            if (expectedCode === null || name === 'ObservationBudgetStop') {
                assert.equal(after.m5.submissions, 1); assert.equal(after.m5.entries, entry ? 1 : 0);
                assert.equal(after.m5.query, query); assert.equal(after.m5.lastQuery, query); assert.ok(after.m5.textChanges > 0);
                assert.equal(after.m5.resultVisible, expectedCode === null);
                assert.equal(after.m5.stage, expectedCode === null ? 'results' : 'form');
            } else {
                assert.deepEqual(after.m5, before.m5, 'rejected task must not change independent fixture state');
            }
            ctx.emit({ phase: 'evidence', name, independent: { entries: after.m5.entries, submissions: after.m5.submissions,
                textChanges: after.m5.textChanges, resultVisible: after.m5.resultVisible, stateUnchanged: expectedCode !== null && name !== 'ObservationBudgetStop' },
                taskId: result?.details.task.taskId, counts: result?.details.task.counts });
            const row = { name, status: 'PASS', retried: false }; results.push(row); ctx.emit({ phase: 'case', ...row });
        } catch (error) {
            const code = error.code === 'ERR_ASSERTION' ? 'INDEPENDENT_ASSERTION_FAILED' : /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'CASE_FAILED';
            const row = { name, status: 'NOT_PASSED', code, retried: false }; results.push(row); ctx.emit({ phase: 'case', ...row });
            break;
        } finally { ctx.policy.readOnlyPackages = []; }
    }
    const passed = results.filter(row => row.status === 'PASS').length;
    const summary = { phase: 'summary', matrix: 'm5-search', matrixTotal: CASES.length, executed: results.length,
        passed, failed: results.length - passed, notExecuted: CASES.length - results.length,
        deviceAcceptance: passed === CASES.length ? 'PASSED' : 'NOT_PASSED', retried: false };
    ctx.emit(summary);
    return { exitCode: passed === CASES.length ? 0 : 1, summary };
}

async function main(argv = process.argv.slice(2), deps = {}) {
    const options = parseArgs(argv);
    const emit = deps.emit || (value => console.log(JSON.stringify(value)));
    const spawnSync = deps.spawnSync || cp.spawnSync;
    const adb = (args, device = true) => {
        const result = spawnSync(options.adb, [...(device ? ['-s', options.serial] : []), ...args],
            { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        if (result.error || result.status !== 0) throw fail('ADB_FAILED_STOP');
        return String(result.stdout);
    };
    if (!legacy.parseDevices(adb(['devices', '-l'], false)).some(device => device.serial === options.serial && device.state === 'device')) throw fail('EXPLICIT_DEVICE_NOT_ONLINE');
    let session;
    const gate = () => {
        const safety = legacy.parseSafety(adb(['shell', 'dumpsys', 'window', 'displays']), adb(['shell', 'dumpsys', 'power']), adb(['shell', 'dumpsys', 'window', 'policy']));
        if (!safety.safe) throw fail('UNSAFE_OR_UNPROVEN_TARGET_STOP');
        const state = parseState(adb(['shell', 'content', 'query', '--uri', `content://${PACKAGE}.state/state`]));
        if (session && session !== state.session) throw fail('FIXTURE_SESSION_CHANGED_STOP');
        session = state.session;
        return state;
    };
    const initial = gate();
    emit({ phase: 'probe', status: 'READY_NOT_RUN', variant: initial.m5.variant, serviceInitialized: false });
    if (options.mode === 'probe') return { exitCode: 0 };
    const output = path.resolve(options.output);
    fs.mkdirSync(path.join(output, 'traces'), { recursive: true });
    const service = (deps.loadService || (() => require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService')))();
    const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
    const { createAndroidTaskExecutor } = require('../modules/services/androidTaskExecutor');
    const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
    const policy = {};
    const drain = async () => {
        const deadline = Date.now() + 10000;
        for (;;) {
            try {
                runtime.assertManagementIdle();
                const queue = service.getRuntimeStatus()?.adbQueue;
                if (!queue || queue.depth !== 0 || queue.pending !== 0 || queue.running !== false) throw fail('RUNTIME_NOT_DRAINED_STOP');
                return;
            } catch { if (Date.now() >= deadline) throw fail('RUNTIME_NOT_DRAINED_STOP'); }
            await pause(100);
        }
    };
    try {
        await service.initialize({ config: { ADB_PATH: options.adb, DEVICE_SERIAL: options.serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0, INTERACTION_POLICY: policy },
            services: { androidTaskExecutor: createAndroidTaskExecutor({ traceStore: createTaskTraceStore({ directory: path.join(output, 'traces') }) }) },
            logger: { log() {}, warn() {}, error() {} } });
        const ctx = { serial: options.serial, gate, drain, emit, policy,
            trace: taskId => {
                if (!/^[a-f0-9-]{36}$/.test(taskId || '')) throw fail('TASK_ID_INVALID');
                return fs.readFileSync(path.join(output, 'traces', `${taskId}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
            },
            async reset(variant) {
                gate();
                adb(['shell', 'am', 'force-stop', PACKAGE]);
                session = null;
                adb(['shell', 'am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`, '--es', 'fixtureMode', 'm5', '--es', 'm5Variant', variant]);
                await pause(250);
                assert.equal(gate().m5.variant, variant);
            },
            async run(task, signal) {
                gate();
                const result = await service.processToolCall({ command: 'RunTask', task }, { signal });
                emit({ phase: 'operation', taskId: result.details.task.taskId, status: result.details.task.status,
                    code: result.details.task.code, outcome: result.details.execution.outcome,
                    totalMs: result.details.execution.timings.totalMs, receipts: result.details.task.receipts });
                return result;
            },
        };
        return await runMatrix(ctx);
    } finally {
        await drain();
        await service.cleanup();
        emit({ phase: 'cleanup', status: 'DONE' });
    }
}
module.exports = { CASES, parseArgs, parseState, taskOf, checkTrace, runMatrix, main };
if (require.main === module) main().then(result => { process.exitCode = result.exitCode; }).catch(error => {
    console.error(JSON.stringify({ phase: 'stopped', status: 'NOT_PASSED', code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'M5_ACCEPTANCE_STOPPED', retried: false }));
    process.exitCode = 1;
});
