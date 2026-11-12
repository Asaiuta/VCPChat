'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PACKAGE, ERASE_METHODS, SUITE_CASE_NAMES, parseArgs, parseSafety, parseState, checkReceipt, checkHostScroll, safeMetadata, createSuiteCases, runSuite, main } = require('../verify-android-m15.cjs');
const { harness } = require('../../tests/helpers/android-service-harness.cjs');
const windowText = `mCurrentFocus=Window{a1 u0 ${PACKAGE}/.MainActivity}`;
const powerText = 'mWakefulness=Awake';
const policyText = 'KeyguardServiceDelegate\n  showing=false\n  inputRestricted=false';
const state = { ready: true, resumed: true, package: PACKAGE, protocol: 1,
    session: '11111111-1111-4111-8111-111111111111', mode: 'gestures', text: '', focused: false,
    targetVisible: false, longPress: 0, doubleTap: 0, dragDrops: 0, scaleMilli: 1000,
    imeActions: 0, keyCombos: 0, pinchBegins: 0, pinchUpdates: 0, deleteEvents: 0,
    lastImeKey: 0, comboKey: 0, comboMeta: 0, scrollY: 0, targetClicks: 0,
    selectionStart: -1, selectionEnd: -1 };
const row = value => `Row: 0 state=${JSON.stringify(value)}\n`;

test('CLI defaults to probe and requires explicit serial for run', () => {
    assert.equal(parseArgs([]).mode, 'probe');
    for (const args of [['--run'], ['A'], ['--run', '--probe'], ['--serial', 'A\nB'], ['--run', '--serial', 'A', '--scroll-strategy', 'auto'], ['--run', '--run'], ['--unknown']]) {
        assert.throws(() => parseArgs(args));
    }
    assert.equal(parseArgs(['--run', '--serial', 'A', '--scroll-strategy', 'rpc']).strategy, 'rpc');
});

test('safety requires exact foreground user0, Awake and positive unlocked evidence', () => {
    assert.equal(parseSafety(windowText, powerText, policyText).safe, true);
    for (const [window, power, policy] of [
        [windowText.replace(PACKAGE, `${PACKAGE}.other`), powerText, policyText],
        [windowText.replace('u0', 'u10'), powerText, policyText],
        ['mCurrentFocus=null\nmFocusedApp=com.vcpchat.m15fixture/.MainActivity', powerText, policyText],
        [windowText, 'mWakefulness=Asleep', policyText],
        [windowText, '', policyText], [windowText, powerText, ''],
        [windowText, powerText, policyText.replace('showing=false', 'showing=true')],
        [windowText, powerText, policyText.replace('inputRestricted=false', 'inputRestricted=true')],
        [`${windowText}\nmCurrentFocus=Window{b2 u0 com.other/.Main}`, powerText, policyText],
    ]) assert.equal(parseSafety(window, power, policy).safe, false);
});

test('vendor numeric awake corroboration requires named Awake and rejects every conflicting state', () => {
    assert.equal(parseSafety(windowText, '  mWakefulness=Awake\nmWakefulness=1', policyText).safe, true);
    for (const power of ['mWakefulness=1', 'mWakefulness=0', 'mWakefulness=Awake\nmWakefulness=0',
        'mWakefulness=Awake\nmWakefulness=2', 'mWakefulness=Awake\nmWakefulness=3',
        'mWakefulness=Awake\nmWakefulness=Asleep', 'mWakefulness=Awake\nmWakefulness=Unknown']) {
        assert.equal(parseSafety(windowText, power, policyText).safe, false, power);
    }
});

test('provider parser accepts only a canonical ready foreground in-memory fixture snapshot', () => {
    assert.equal(parseState(row(state)).session, state.session);
    for (const patch of [{ ready: false }, { resumed: false }, { package: 'com.other' }, { protocol: 2 }, { text: 'x'.repeat(129) }, { focused: undefined }, { deleteEvents: -1 }]) {
        assert.throws(() => parseState(row({ ...state, ...patch })));
    }
    assert.throws(() => parseState(`noise\n${row(state)}`));
});

test('unknown/failed outcomes and fallback receipts are terminal failures', () => {
    for (const outcome of ['unknown', 'failed', undefined]) assert.throws(() => checkReceipt({ details: { execution: { outcome } } }));
    assert.throws(() => checkReceipt({ details: { execution: { outcome: 'dispatched' }, attempts: [{ channel: 'shell', method: 'click', status: 'dispatched' }] } }, ['click']));
});

test('Fill/EraseText and host ScrollUntil reject mismatched attempt channels, methods and counts', () => {
    const response = methods => ({ details: { execution: { outcome: 'verified' }, attempts: methods.map(method => ({ channel: 'rpc', method, status: 'dispatched' })) } });
    for (const methods of [['setText', 'getText'], ERASE_METHODS]) {
        assert.equal(checkReceipt(response(methods), methods).outcome, 'verified');
        const fallback = response(methods); fallback.details.attempts[0].channel = 'shell';
        assert.throws(() => checkReceipt(fallback, methods), { code: 'UNEXPECTED_CHANNEL_OR_FALLBACK_STOP' });
        const unknown = response(methods); unknown.details.attempts.at(-1).status = 'unknown';
        assert.throws(() => checkReceipt(unknown, methods), { code: 'UNEXPECTED_CHANNEL_OR_FALLBACK_STOP' });
    }
    const host = { details: { swipes: 2, attempts: [0, 1].map(() => ({ channel: 'shell', method: 'swipe', status: 'dispatched' })) } };
    assert.equal(checkHostScroll(host), true);
    for (const swipes of [0, 1, 21, '2']) assert.throws(() => checkHostScroll({ details: { ...host.details, swipes } }));
    for (const patch of [{ channel: 'rpc' }, { method: 'scrollTo' }, { status: 'unknown' }]) {
        assert.throws(() => checkHostScroll({ details: { swipes: 2, attempts: [{ ...host.details.attempts[0], ...patch }, host.details.attempts[1]] } }));
    }
});

test('real Service EraseText count2 emits fresh pre-DEL reads accepted by the CLI', async () => {
    let text = 'ABCD';
    const xml = () => '<hierarchy rotation="0"><node class="android.widget.EditText" package="com.example" resource-id="com.example:id/editor"'
        + ` text="${text}" enabled="true" focused="true" bounds="[0,0][100,40]" /></hierarchy>`;
    const spec = { ok: true, xml: xml(), invoke(method) {
        if (method === 'getText') return text;
        assert.equal(method, 'pressKeyCode');
        text = text.slice(0, -1); spec.xml = xml(); return true;
    } };
    const h = await harness({ uiServer: spec });
    try {
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'EraseText', id: 'com.example:id/editor', count: 2 } });
        assert.equal(text, 'AB');
        assert.deepEqual(Array.from(result.details.attempts, attempt => attempt.method), ['getText', 'pressKeyCode', 'getText', 'getText', 'pressKeyCode', 'getText']);
        assert.equal(checkReceipt(result, ERASE_METHODS).outcome, 'dispatched');
        assert.throws(() => checkReceipt(result, ['getText', 'pressKeyCode', 'getText', 'pressKeyCode', 'getText']), { code: 'UNEXPECTED_CHANNEL_OR_FALLBACK_STOP' });
    } finally { await h.service.cleanup(); }
});

test('default no-device probe runs only devices and never loads or initializes Service', async () => {
    const calls = [], logs = [];
    const result = await main(['--adb', process.execPath], {
        spawnSync(file, args) { calls.push(args); return { status: 0, stdout: 'List of devices attached\n\n' }; },
        emit(item) { logs.push(item); }, loadService() { throw new Error('Service must not load'); },
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(calls, [['devices', '-l']]);
    assert.ok(logs.every(item => item.status !== 'PASS'));
    const servicePath = path.resolve(__dirname, '../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
    assert.equal(require.cache[servicePath], undefined);
});

test('unsafe --run never queries provider, loads Service or schedules any action', async () => {
    const calls = [];
    await assert.rejects(main(['--run', '--serial', 'A', '--adb', process.execPath], {
        spawnSync(file, args) {
            calls.push(args);
            if (args[0] === 'devices') return { status: 0, stdout: 'List of devices attached\nA device\n' };
            if (args.includes('content')) throw new Error('provider must not be queried');
            return { status: 0, stdout: '' };
        }, emit() {}, loadService() { throw new Error('Service must not load'); },
    }), { code: 'UNSAFE_OR_UNPROVEN_TARGET_STOP' });
    assert.equal(calls.length, 4);
});

test('first unknown action immediately stops the entire run, with cleanup but no replay', async () => {
    let initialized = 0, actions = 0, cleaned = 0;
    const mock = {
        async initialize() { initialized++; }, async cleanup() { cleaned++; },
        async processToolCall() { actions++; return { details: { execution: { serial: 'A', outcome: 'unknown' } } }; },
    };
    await assert.rejects(main(['--run', '--serial', 'A', '--adb', process.execPath], {
        spawnSync(file, args) {
            let stdout;
            if (args[0] === 'devices') stdout = 'List of devices attached\nA device\n';
            else if (args.includes('content')) stdout = row(state);
            else if (args.includes('power')) stdout = powerText;
            else if (args.includes('policy')) stdout = policyText;
            else if (args.includes('displays')) stdout = windowText;
            else if (args.some(arg => arg.includes('echo PRESENT'))) stdout = 'PRESENT\n';
            else throw new Error('Unexpected adb operation');
            return { status: 0, stdout };
        }, loadService: () => mock, emit() {}, settle: async () => {},
    }), { code: 'ACTION_NOT_CONFIRMED_STOP' });
    assert.equal(initialized, 1); assert.equal(actions, 1); assert.equal(cleaned, 1);
});

function suiteHarness(options = {}) {
    let current = structuredClone(state), initialized = 0, cleaned = 0, request = 0, currentName;
    let blocked = false, unsafe = false;
    const actions = [], events = [], logs = [], history = [];
    const selected = SUITE_CASE_NAMES.filter(name => !options.only || options.only.includes(name));
    const receipt = (methods, extra = {}) => ({ details: { serial: 'A',
        execution: { serial: 'A', requestId: `request-${++request}`, outcome: 'dispatched',
            timings: { prepareMs: 1, actionMs: 2, verificationMs: 0, totalMs: 3 } },
        attempts: methods.map(method => ({ channel: method === 'swipe' ? 'shell' : 'rpc', method, status: 'dispatched', params: ['private payload'] })), ...extra } });
    const service = {
        async initialize() {
            currentName = selected[initialized++]; history.length = 0;
            events.push(`initialize:${currentName}`);
        },
        async cleanup() {
            events.push(`cleanup:${currentName}`); cleaned++;
            if (options.cleanup) await options.cleanup({ name: currentName, block: () => { blocked = true; } });
        },
        getRuntimeStatus() {
            if (!initialized) events.push('queue:uninitialized');
            return { adbQueue: options.queue?.(currentName) || (initialized ? { depth: 0, pending: 0, running: false } : null) };
        },
        async processToolCall(args) {
            if (args.command === 'Manage') {
                events.push(`history:${currentName}`);
                const result = { details: { entries: structuredClone(history) } };
                if (options.history) options.history(result, events.filter(event => event === `history:${currentName}`).length);
                return result;
            }
            if (args.command === 'Observe') {
                events.push(`observe:${args.mode}`);
                const result = receipt([], { screen: { width: 400, height: 800 }, serial: 'A' });
                result.details.execution.outcome = 'observed';
                if (args.mode === 'ui') result.details.controls = ['drag_source', 'drag_target'].map((resource, index) => ({
                    id: `${PACKAGE}:id/${resource}`, enabled: true, inViewport: true,
                    ...(args.includeCoordinates === true ? { clipped: { left: 10 + index * 200, top: 300, right: 100 + index * 200, bottom: 400 } } : {}) }));
                else result.details.frameId = 'fixture-frame';
                return result;
            }
            assert.equal(args.command, 'ExecuteStep'); assert.equal(args.serial, 'A');
            const action = args.action, before = structuredClone(current);
            actions.push({ name: currentName, action: structuredClone(action) });
            events.push(`${currentName}:${action.command}`);
            const helpers = { name: currentName, action, before, state: current,
                block: () => { blocked = true; }, unsafe: () => { unsafe = true; } };
            if (options.beforeAction) await options.beforeAction(helpers);
            let methods;
            if (action.command === 'Tap' && action.id.includes(':id/nav_')) {
                current = { ...structuredClone(state), mode: action.id.split(':id/nav_')[1] };
                methods = ['click'];
            } else if (action.command === 'Tap') { current.focused = true; methods = ['click']; }
            else if (action.command === 'Fill') {
                current.text = action.text; current.selectionStart = current.selectionEnd = action.text.length;
                methods = ['setText', 'getText'];
            } else if (action.command === 'LongPress') { current.longPress++; methods = ['click']; }
            else if (action.command === 'DoubleTap') { current.doubleTap++; methods = ['click', 'click']; }
            else if (action.command === 'Drag') { current.dragDrops++; methods = [action.id ? 'dragTo' : 'drag']; }
            else if (action.command === 'Pinch') {
                current.pinchBegins++; current.pinchUpdates++; current.scaleMilli = action.direction === 'in' ? 500 : 1500;
                methods = [action.direction === 'in' ? 'pinchIn' : 'pinchOut'];
            } else if (action.command === 'ImeAction') {
                current.imeActions++; current.lastImeKey = action.imeAction === 'enter' ? 66 : 84; methods = ['pressKeyCode'];
            } else if (action.command === 'KeyCombo') {
                methods = ['pressKeyCode'];
                if (action.keyCode === 29) {
                    current.keyCombos++; current.comboKey = 29; current.comboMeta = 4096;
                    current.selectionStart = 0; current.selectionEnd = current.text.length;
                } else current.selectionStart = current.selectionEnd = current.text.length;
            } else if (action.command === 'EraseText') {
                current.deleteEvents += 2; current.text = current.text.slice(0, -2);
                current.selectionStart = current.selectionEnd = current.text.length; methods = ERASE_METHODS;
            } else if (action.command === 'ScrollUntil') {
                current.scrollY = 1000; current.targetVisible = true; methods = [action.strategy === 'host' ? 'swipe' : 'scrollTo'];
            } else assert.fail('Unexpected fake action');
            const result = receipt(methods, action.command === 'ScrollUntil' && action.strategy === 'host' ? { swipes: 1 } : {});
            if (['Drag', 'Pinch'].includes(action.command)) result.details.experimental = true;
            history.push({ requestId: result.details.execution.requestId, command: action.command, outcome: 'dispatched', durationMs: 3 });
            if (options.afterAction) await options.afterAction({ ...helpers, state: current, result });
            return result;
        },
    };
    const gate = () => {
        events.push(`gate:${currentName || 'initial'}`);
        if (unsafe) throw Object.assign(new Error('private focus/selector'), { code: 'UNSAFE_OR_UNPROVEN_TARGET_STOP' });
        return structuredClone(current);
    };
    const deps = { service, serial: 'A', gate, initialize: () => service.initialize(),
        assertIdle() { if (blocked) throw Object.assign(new Error('private pending operation'), { code: 'DEVICE_BUSY' }); },
        settle: async () => {}, drainPause: async () => {}, drainTimeoutMs: 0, emit: item => logs.push(item), only: options.only };
    return { deps, service, logs, actions, events, get state() { return current; }, get initialized() { return initialized; }, get cleaned() { return cleaned; } };
}

test('suite argument parsing requires explicit serial and validates explicit-only selection', () => {
    assert.equal(parseArgs(['--suite', '--serial', 'A']).mode, 'suite');
    assert.deepEqual(parseArgs(['--suite', '--serial', 'A', '--only', 'DoubleTap,DragSemantic']).only, ['DoubleTap', 'DragSemantic']);
    for (const args of [['--suite'], ['--suite', '--run', '--serial', 'A'], ['--only', 'DoubleTap'],
        ['--run', '--serial', 'A', '--only', 'DoubleTap'], ['--suite', '--serial', 'A', '--only', 'Unknown'],
        ['--suite', '--serial', 'A', '--only', 'DoubleTap,DoubleTap'], ['--suite', '--serial', 'A', '--only', 'DoubleTap,'],
        ['--suite', '--serial', 'A', '--scroll-strategy', 'rpc']]) assert.throws(() => parseArgs(args));
});

test('suite covers the complete matrix with independent reset, initialization, cleanup and native channels', async () => {
    const h = suiteHarness();
    assert.deepEqual(createSuiteCases().map(item => item.name), SUITE_CASE_NAMES);
    const result = await runSuite(h.deps);
    assert.equal(result.exitCode, 0); assert.equal(result.summary.deviceAcceptance, 'PASSED');
    assert.equal(result.results.length, 14); assert.equal(h.initialized, 14); assert.equal(h.cleaned, 14);
    assert.ok(h.events.includes('queue:uninitialized'));
    assert.ok(result.results.every(item => item.status === 'PASS' && item.code === 'OK'));
    for (const name of SUITE_CASE_NAMES) {
        const actions = h.actions.filter(item => item.name === name);
        assert.match(actions[0].action.id, /:id\/nav_/);
        assert.equal(result.results.find(item => item.name === name).operations[0].stage, 'reset');
    }
    const pixel = h.actions.find(item => item.name === 'DragPixels' && item.action.command === 'Drag').action;
    assert.deepEqual(pixel, { command: 'Drag', x: 55, y: 350, x2: 255, y2: 350, frameId: 'fixture-frame', steps: 80 });
    assert.ok(h.events.indexOf('observe:ui') < h.events.indexOf('observe:image'));
    const longPress = h.actions.find(item => item.action.command === 'LongPress').action;
    assert.equal(longPress.duration, 800);
    assert.deepEqual(result.results.find(item => item.name === 'DoubleTap').operations.at(-1).attempts.map(item => item.method), ['click', 'click']);
    assert.ok(!JSON.stringify(h.logs).includes('private payload'));
    assert.ok(!JSON.stringify(h.logs).includes('M15_LOCAL_ABCD'));
});

test('unknown DoubleTap fails only its case, never replays, then independently resets and verifies Drag', async () => {
    let callbacks = 0;
    const h = suiteHarness({ afterAction({ action, state, result }) {
        callbacks++;
        if (action.command !== 'DoubleTap') return;
        state.doubleTap = 0; state.longPress = 1;
        throw Object.assign(new Error('private text selector params'), { code: 'DOUBLE_TAP_WINDOW_MISSED',
            execution: result.details.execution, details: { ...result.details, attempts: result.details.attempts.slice(0, 1) } });
    } });
    const result = await runSuite(h.deps);
    assert.equal(result.results.length, 14); assert.equal(result.summary.passed, 13);
    assert.equal(result.summary.deviceAcceptance, 'NOT_PASSED'); assert.equal(result.exitCode, 1);
    assert.equal(result.results[1].code, 'DOUBLE_TAP_WINDOW_MISSED');
    assert.equal(result.results[2].status, 'PASS'); assert.equal(h.cleaned, 14);
    assert.equal(h.actions.filter(item => item.action.command === 'DoubleTap').length, 1);
    assert.equal(callbacks, h.actions.length);
    assert.ok(!JSON.stringify(h.logs).includes('private'));
    assert.ok(result.results[1].operations.at(-1).timings);
});

test('independent provider delta failure does not pass from preparation and does not skip next case', async () => {
    const h = suiteHarness({ afterAction({ action, before, state }) {
        if (action.command === 'LongPress') state.longPress = before.longPress;
    } });
    const result = await runSuite(h.deps);
    assert.equal(result.results[0].code, 'INDEPENDENT_READBACK_MISMATCH_STOP');
    assert.equal(result.results[1].status, 'PASS'); assert.equal(result.results.length, 14);
    assert.equal(result.summary.deviceAcceptance, 'NOT_PASSED');
});

test('readback mismatch reports only allowlisted fixture counters so the stop stays attributable', async () => {
    const cases = [
        { label: 'device registered nothing', mutate: ({ before, state }) => { state.doubleTap = before.doubleTap; state.text = 'private payload'; },
            changed: [], before: 0, after: 0 },
        { label: 'device counted twice', mutate: ({ before, state }) => { state.doubleTap = before.doubleTap + 2; },
            changed: ['doubleTap'], before: 0, after: 2 },
    ];
    for (const item of cases) {
        const h = suiteHarness({ afterAction(helpers) {
            if (helpers.action.command === 'DoubleTap') item.mutate(helpers);
        } });
        const result = await runSuite(h.deps);
        const failed = result.results.find(entry => entry.name === 'DoubleTap');
        assert.equal(failed.code, 'INDEPENDENT_READBACK_MISMATCH_STOP', item.label);
        assert.deepEqual(failed.readback.changed.map(entry => entry.key), item.changed, item.label);
        assert.equal(failed.readback.before.doubleTap, item.before, item.label);
        assert.equal(failed.readback.after.doubleTap, item.after, item.label);
        assert.equal(JSON.stringify(failed).includes('private'), false, item.label);
        assert.equal(result.summary.deviceAcceptance, 'NOT_PASSED', item.label);
    }
});

test('suite safety loss stops all subsequent cases without resetting over an unsafe foreground', async () => {
    const h = suiteHarness({ afterAction({ action, unsafe }) { if (action.command === 'DoubleTap') unsafe(); } });
    const result = await runSuite(h.deps);
    assert.equal(result.results.length, 2); assert.equal(result.summary.stopped, true);
    assert.equal(result.results[1].code, 'UNSAFE_OR_UNPROVEN_TARGET_STOP');
    assert.equal(h.actions.filter(item => item.action.id?.includes(':id/nav_')).length, 2);
    assert.equal(h.initialized, 2); assert.equal(h.cleaned, 1);
});

test('unknown action with a retained real-operation lease stops before cleanup or the next reset', async () => {
    const h = suiteHarness({ afterAction({ action, block, result }) {
        if (action.command !== 'DoubleTap') return;
        block(); result.details.execution.outcome = 'unknown';
    } });
    const result = await runSuite(h.deps);
    assert.equal(result.results.length, 2); assert.equal(result.summary.stopped, true);
    assert.equal(result.results[1].code, 'RUNTIME_NOT_DRAINED_STOP'); assert.equal(h.cleaned, 1);
    assert.equal(h.actions.filter(item => item.action.command === 'DoubleTap').length, 1);
});

test('runtime queue evidence is mandatory and cleanup rejection or newly busy lease is terminal', async () => {
    for (const options of [
        { queue: () => ({ depth: 1, pending: 0, running: true }) },
        { queue: () => ({}) },
        { cleanup() { throw new Error('private cleanup transport'); } },
        { cleanup({ block }) { block(); } },
    ]) {
        const h = suiteHarness(options), result = await runSuite(h.deps);
        assert.equal(result.results.length, 1); assert.equal(result.summary.stopped, true);
        assert.equal(result.summary.deviceAcceptance, 'NOT_PASSED');
        assert.equal(h.initialized, options.queue ? 0 : 1);
        assert.ok(!JSON.stringify(h.logs).includes('private'));
    }
});

test('suite only is explicit partial evidence and never claims full device acceptance', async () => {
    const h = suiteHarness({ only: ['DoubleTap', 'DragPixels'] });
    const result = await runSuite(h.deps);
    assert.equal(result.exitCode, 0); assert.equal(result.summary.explicitSelection, true);
    assert.equal(result.summary.deviceAcceptance, 'NOT_PASSED');
    assert.deepEqual(result.results.map(item => item.name), ['DoubleTap', 'DragPixels']);
    assert.equal(h.initialized, 2); assert.equal(h.cleaned, 2);
});

test('safe metadata exports only bounded allowlisted fields, including thrown-error timings', () => {
    const result = safeMetadata({ message: 'private', execution: { timings: { totalMs: 2, prepareMs: -1, actionMs: Infinity, verificationMs: 1, selector: 'private' } },
        details: { text: 'private', experimental: true, attempts: [
            { channel: 'rpc', method: 'click', status: 'dispatched', params: ['private'] },
            { channel: 'private', method: 'private', status: 'private' },
        ] } });
    assert.deepEqual(result, { attempts: [{ channel: 'rpc', method: 'click', status: 'dispatched' },
        { channel: 'unrecognized', method: 'unrecognized', status: 'unrecognized' }], experimental: true, timings: { verificationMs: 1, totalMs: 2 } });
    assert.equal(JSON.stringify(result).includes('private'), false);
});

test('fallback still fails its case while serial mismatch remains a global safety stop', async () => {
    for (const serialMismatch of [false, true]) {
        const h = suiteHarness({ afterAction({ action, result }) {
            if (action.command !== 'LongPress') return;
            if (serialMismatch) result.details.execution.serial = 'OTHER';
            else result.details.attempts[0].channel = 'shell';
        } });
        const result = await runSuite(h.deps);
        assert.equal(result.results[0].code, serialMismatch ? 'ACTION_SERIAL_MISMATCH_STOP' : 'UNEXPECTED_CHANNEL_OR_FALLBACK_STOP');
        assert.equal(result.results.length, serialMismatch ? 1 : 14);
        assert.equal(result.summary.deviceAcceptance, 'NOT_PASSED');
    }
});

test('history case checks current initialization preparation requestIds and query purity', async () => {
    for (const history of [
        result => { result.details.entries = []; },
        (result, count) => { if (count === 2) result.details.entries.push({ requestId: 'extra', command: 'Tap', outcome: 'dispatched' }); },
        result => { result.details.entries[0].selector = 'private'; },
        result => { result.details.entries[0].outcome = 'failed'; },
        result => { result.details.entries[0].outcome = 'unknown'; },
    ]) {
        const h = suiteHarness({ only: ['ActionHistoryPure'], history });
        const result = await runSuite(h.deps);
        assert.equal(result.results[0].status, 'NOT_PASSED');
        assert.match(result.results[0].code, /^HISTORY_/);
        assert.equal(h.cleaned, 1);
        assert.ok(!JSON.stringify(h.logs).includes('private'));
    }
});

test('history case preserves earlier failures while verifying only its own preparation receipts', async () => {
    const h = suiteHarness({ only: ['ActionHistoryPure'], history(result) {
        result.details.entries.unshift({ requestId: 'previous-case', command: 'scrolluntil', outcome: 'failed', durationMs: 1 });
    } });
    const result = await runSuite(h.deps);
    assert.equal(result.results[0].status, 'PASS');
});

test('main suite wires real safety/provider probes to injectable runtime and never invokes non-readonly adb commands', async () => {
    const h = suiteHarness({ only: ['DoubleTap', 'DragSemantic'] });
    const calls = [];
    const result = await main(['--suite', '--serial', 'A', '--adb', process.execPath, '--only', 'DoubleTap,DragSemantic'], {
        spawnSync(file, args) {
            calls.push(args);
            let stdout;
            if (args[0] === 'devices') stdout = 'List of devices attached\nA device\n';
            else if (args.includes('content')) stdout = row(h.state);
            else if (args.includes('power')) stdout = powerText;
            else if (args.includes('policy')) stdout = policyText;
            else if (args.includes('displays')) stdout = windowText;
            else if (args.some(arg => arg.includes('echo PRESENT'))) stdout = 'PRESENT\n';
            else assert.fail('Non-readonly adb call');
            return { status: 0, stdout };
        }, loadService: () => h.service, loadRuntime: () => ({ assertManagementIdle: h.deps.assertIdle }),
        emit: item => h.logs.push(item), settle: async () => {}, drainTimeoutMs: 0,
    });
    assert.equal(result.exitCode, 0); assert.equal(result.results.length, 2);
    assert.equal(h.initialized, 2); assert.equal(h.cleaned, 2);
    assert.ok(calls.every(args => args[0] === 'devices' || args[0] === '-s' && args[1] === 'A'));
});
