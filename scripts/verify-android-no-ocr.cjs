'use strict';
// Fixed, already-installed fixture only. Human cases use the production native
// dialog adapter in an isolated Electron process, not a scripted approval answer.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const legacy = require('./verify-android-m15.cjs');
const m2 = require('./verify-android-m2.cjs');
const PACKAGE = legacy.PACKAGE;
const id = name => `${PACKAGE}:id/${name}`;
const fail = code => Object.assign(new Error(code), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function optionsOf(argv) {
    const human = argv.includes('--human');
    if (argv.filter(arg => arg === '--human').length > 1) throw fail('DUPLICATE_OPTION');
    const options = m2.parseArgs(argv.filter(arg => arg !== '--human'));
    if (human && options.mode !== 'suite') throw fail('HUMAN_REQUIRES_SUITE');
    return { ...options, human };
}

async function main(argv = process.argv.slice(2), deps = {}) {
    const options = optionsOf(argv);
    const emit = deps.emit || (value => console.log(JSON.stringify(value)));
    const spawn = deps.spawnSync || cp.spawnSync;
    const adb = options.adb || path.join(options.sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    function read(args, device = true) {
        const result = spawn(adb, [...(device ? ['-s', options.serial] : []), ...args],
            { encoding: 'utf8', timeout: 7000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        if (result.error || result.status !== 0) throw fail('ADB_READ_FAILED_STOP');
        return String(result.stdout);
    }
    if (!legacy.parseDevices(read(['devices', '-l'], false)).some(device => device.serial === options.serial && device.state === 'device')) throw fail('EXPLICIT_DEVICE_NOT_ONLINE');
    let session;
    const gate = () => {
        const safe = legacy.parseSafety(read(['shell', 'dumpsys', 'window', 'displays']), read(['shell', 'dumpsys', 'power']), read(['shell', 'dumpsys', 'window', 'policy']));
        if (!safe.safe) throw fail('UNSAFE_OR_UNPROVEN_TARGET_STOP');
        const state = m2.parseState(read(['shell', 'content', 'query', '--uri', `content://${PACKAGE}.state/state`]));
        if (session && state.session !== session) throw fail('FIXTURE_SESSION_CHANGED_STOP');
        session = state.session;
        return state;
    };
    gate();
    emit({ phase: 'probe', status: 'READY_NOT_RUN', serviceInitialized: false });
    if (options.mode === 'probe') return { exitCode: 0 };
    if (read(['shell', '[ -f /data/local/tmp/u2-server-0.5.0.apk ] && echo PRESENT || echo ABSENT']).trim() !== 'PRESENT') throw fail('PREPROVISIONED_RPC_APK_REQUIRED');
    if (options.human && !deps.humanInteraction) throw fail('NATIVE_ELECTRON_HOST_REQUIRED');
    const service = (deps.loadService || (() => require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService')))();
    const runtime = (deps.loadRuntime || (() => require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime')))();
    const policy = { confirmEveryWrite: false };
    let current = '', initialized = false, promptCount = 0;
    const humanInteraction = deps.humanInteraction && { async request(request) {
        gate(); promptCount++;
        emit({ phase: 'human-prompt', name: current, kind: request.kind });
        const answer = await deps.humanInteraction.request({ ...request,
            detail: `${current}：${current === 'ApprovalReject' ? '本项请点击“拒绝”。' : current === 'ApprovalAllow' ? '本项请点击“允许这一次”。' : current === 'HandoffStop' ? '本项请点击“停止”。' : '本项请点击“继续”，无需操作手机。'}\n仅测试隔离靶场。\n${request.detail}` });
        gate(); return answer;
    } };
    const drain = async () => {
        const end = Date.now() + 7000;
        for (;;) {
            try {
                runtime.assertManagementIdle();
                const queue = service.getRuntimeStatus()?.adbQueue;
                if (!queue || queue.depth !== 0 || queue.pending !== 0 || queue.running !== false) throw fail('RUNTIME_NOT_DRAINED_STOP');
                return;
            } catch (error) { if (Date.now() >= end) throw fail('RUNTIME_NOT_DRAINED_STOP'); }
            await pause(100);
        }
    };
    const call = async args => {
        gate();
        try {
            const result = await service.processToolCall({ serial: options.serial, timeoutMs: 60000, ...args });
            if (result.details?.execution?.serial !== options.serial) throw fail('ACTION_SERIAL_MISMATCH_STOP');
            await pause(250);
            emit({ phase: 'operation', name: current, command: args.command, outcome: result.details.execution.outcome,
                attempts: result.details.attempts?.map(a => ({ method: a.method, channel: a.channel, status: a.status })) });
            return result;
        } finally { gate(); }
    };
    const execute = (action, extra = {}) => call({ command: 'ExecuteStep', action, ...extra });
    const observe = () => call({ command: 'Observe', mode: 'ui', wake: 'never', limit: 500 });
    const reset = async mode => {
        policy.confirmEveryWrite = false;
        const result = await execute({ command: 'Tap', id: id(`nav_${mode}`) });
        legacy.checkReceipt(result, ['click']);
        const state = gate();
        assert.equal(state.mode, mode);
        // A detached ScrollView can publish its old offset during another page's
        // construction. Only the active mode owns its independent counters.
        if (mode === 'm2') {
            assert.equal(state.m2DynamicCounter, 0); assert.equal(state.m2ClicksA, 0); assert.equal(state.m2ClicksB, 0);
        } else if (mode === 'scroll') assert.equal(state.scrollY, 0);
    };
    const dynamic = { command: 'Tap', id: id('m2_dynamic') };
    const cases = options.human ? [
        ['ApprovalReject', 'm2', async () => {
            policy.confirmEveryWrite = true;
            await m2.expectFailure(() => execute(dynamic), ['POLICY_REJECTED']);
            assert.equal(gate().m2DynamicCounter, 0);
        }],
        ['ApprovalAllow', 'm2', async () => {
            policy.confirmEveryWrite = true;
            legacy.checkReceipt(await execute(dynamic), ['click']);
            assert.equal(gate().m2DynamicCounter, 1);
        }],
        ['HandoffContinue', 'm2', async () => {
            const result = await call({ command: 'ExecuteStep', timeoutMs: 120000, steps: [
                { action: dynamic, expect: { type: 'visible', selector: 'text=M2 DYNAMIC 1' } },
                { action: { command: 'Handoff', reason: '验收人工交还：请直接选择继续。' }, expect: { type: 'visible', selector: 'text=M2 DYNAMIC 1' } },
                { action: dynamic, expect: { type: 'visible', selector: 'text=M2 DYNAMIC 2' } },
            ] });
            assert.equal(result.details.sequence.status, 'completed'); assert.equal(gate().m2DynamicCounter, 2);
        }],
        ['HandoffStop', 'm2', async () => {
            const before = await observe();
            const result = await call({ command: 'ExecuteStep', timeoutMs: 120000, steps: [
                { action: { command: 'Handoff', reason: '验收停止：请直接选择停止。' }, expect: { type: 'visible', selector: 'text=M2 DYNAMIC 0' } },
                { action: dynamic },
            ] });
            assert.equal(result.details.sequence.status, 'stopped'); assert.equal(result.details.execution.outcome, 'unknown');
            assert.equal(gate().m2DynamicCounter, 0);
            const node = before.details.controls.find(item => item.id === id('m2_dynamic')); assert.ok(node);
            await m2.expectFailure(() => execute({ command: 'Tap', index: node.index, snapshotId: before.details.snapshotId }), ['STALE_SNAPSHOT']);
            assert.equal(gate().m2DynamicCounter, 0);
        }],
    ] : [
        ['ChildOf', 'm2', async () => {
            legacy.checkReceipt(await execute({ command: 'Tap', selector: { text: 'M2 SAME', childOf: `id=${id('m2_scope_b')}` } }), ['click']);
            assert.equal(gate().m2ClicksB, 1); assert.equal(gate().m2ClicksA, 0);
        }],
        ['SiblingOf', 'm2', async () => {
            legacy.checkReceipt(await execute({ command: 'Tap', selector: { id: id('nav_scroll'), siblingOf: `id=${id('nav_m2')}` } }), ['click']);
            assert.equal(gate().mode, 'scroll');
        }],
        ['HasDescendant', 'scroll', async () => {
            const selector = { id: id('scroll_container'), hasDescendant: 'text=Fixture row 0' };
            const result = await execute({ command: 'Wait' }, { expect: { type: 'visible', selector } });
            assert.equal(result.details.execution.outcome, 'verified');
            const absent = await execute({ command: 'Wait' }, { expect: { type: 'absent', selector: { id: id('scroll_container'), hasDescendant: 'text=NOT_IN_FIXTURE' } } });
            assert.equal(absent.details.execution.outcome, 'verified');
        }],
        ['CollectOnePage', 'scroll', async () => {
            const result = await execute({ command: 'Collect', container: `id=${id('scroll_container')}`, maxPages: 1 });
            const data = result.details.collection;
            assert.equal(data.pages.length, 1); assert.ok(data.pages[0].items.some(item => item.text === 'Fixture row 0'));
            assert.equal(data.stopReason, 'MAX_PAGES'); assert.equal(data.partial, true);
            assert.equal(data.listEndProven, false); assert.equal(gate().scrollY, 0);
        }],
        ['CollectUntil', 'scroll', async () => {
            const result = await execute({ command: 'Collect', container: `id=${id('scroll_container')}`, maxPages: 20, until: 'text=M15_SCROLL_TARGET' });
            const data = result.details.collection;
            assert.equal(data.stopReason, 'UNTIL_MATCH'); assert.equal(data.truncated, false);
            assert.equal(data.partial, false); assert.equal(data.deduplicated, false); assert.equal(data.listEndProven, false);
            assert.ok(data.pages.length > 1); assert.ok(gate().scrollY > 0); assert.equal(gate().targetClicks, 0);
            assert.ok(data.pages.at(-1).items.some(item => item.text === 'M15_SCROLL_TARGET'));
            assert.equal(JSON.parse(result.content.find(item => item.text?.startsWith('{"collection":')).text).collection.pages.length, data.pages.length);
            emit({ phase: 'evidence', name: current, pages: data.pages.length, items: data.pages.reduce((n,p) => n+p.items.length,0), stopReason: data.stopReason, inputAttempts: result.details.attempts.length });
        }],
    ];
    const results = [];
    try {
        initialized = true;
        await service.initialize({ config: { ADB_PATH: adb, DEVICE_SERIAL: options.serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0, INTERACTION_POLICY: policy },
            services: humanInteraction ? { humanInteraction } : {}, logger: { log() {}, warn() {}, error() {} } });
        for (const [name, mode, run] of cases) {
            current = name; emit({ phase: 'case-start', name });
            const promptsBefore = promptCount;
            try {
                await drain(); gate(); await reset(mode);
                await run(); await drain(); gate();
                if (options.human) assert.equal(promptCount - promptsBefore, 1);
                results.push({ name, status: 'PASS' }); emit({ phase: 'case', name, status: 'PASS', retried: false });
            } catch (error) {
                const code = error.code === 'ERR_ASSERTION' ? 'INDEPENDENT_ASSERTION_FAILED' : /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'CASE_FAILED';
                results.push({ name, status: 'NOT_PASSED', code }); emit({ phase: 'case', name, status: 'NOT_PASSED', code, retried: false });
                break;
            }
        }
    } finally { if (initialized) { await drain(); await service.cleanup(); emit({ phase: 'cleanup', status: 'DONE' }); } }
    const passed = results.filter(result => result.status === 'PASS').length;
    const summary = { phase: 'summary', matrix: options.human ? 'native-human' : 'structural-collect', total: cases.length, executed: results.length, passed, notExecuted: cases.length-results.length,
        deviceAcceptance: passed === cases.length ? 'PASSED' : 'NOT_PASSED', retried: false };
    emit(summary); return { exitCode: passed === cases.length ? 0 : 1, summary };
}

module.exports = { main, optionsOf };
if (require.main === module || (process.versions.electron && process.type === 'browser'
    && path.resolve(process.argv[1] || '') === __filename)) {
    const stopped = error => console.error(JSON.stringify({ phase: 'stopped', code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'NO_OCR_ACCEPTANCE_STOPPED' }));
    if (process.versions.electron) {
        const { app, BrowserWindow, dialog } = require('electron');
        const data = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'android-native-validation-'));
        app.setPath('userData', data); app.setPath('sessionData', data); app.setAppLogsPath(path.join(data, 'logs'));
        app.whenReady().then(async () => {
            const window = new BrowserWindow({ show: true, title: 'AndroidController 真机验收', width: 640, height: 240,
                webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
            window.show(); window.focus();
            const humanInteraction = require('../modules/services/humanInteraction').createHumanInteraction({ dialog, getWindow: () => window });
            try { const result = await main(process.argv.slice(2), { humanInteraction }); window.destroy(); app.exit(result.exitCode); }
            catch (error) { stopped(error); window.destroy(); app.exit(1); }
        });
    } else main().then(result => { process.exitCode = result.exitCode; }).catch(error => { stopped(error); process.exitCode = 1; });
}
