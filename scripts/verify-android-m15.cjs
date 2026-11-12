'use strict';

// Default: read-only adb probe. Service is loaded only after all --run safety gates pass.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const PACKAGE = 'com.vcpchat.m15fixture';
const STATE_URI = 'content://com.vcpchat.m15fixture.state/state';
const RPC_APK = '/data/local/tmp/u2-server-0.5.0.apk';
const ROOT = path.resolve(__dirname, '..');
const id = name => `${PACKAGE}:id/${name}`;
const SEED = 'M15_LOCAL_ABCD';
const ERASE_METHODS = Object.freeze(['getText', 'pressKeyCode', 'getText', 'getText', 'pressKeyCode', 'getText']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = code => Object.assign(new Error(code), { code });
const SUITE_CASE_NAMES = Object.freeze(['LongPress800', 'DoubleTap', 'DragSemantic', 'DragPixels', 'PinchIn', 'PinchOut',
    'ImeActionEnter', 'ImeActionSearch', 'KeyComboCtrlA', 'KeyComboMOVE_END', 'EraseText2', 'ScrollUntilHost', 'ScrollUntilRpc', 'ActionHistoryPure']);

function parseArgs(argv) {
    const options = { mode: 'probe', sdk: process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || 'F:/AndroidSdk', strategy: 'host' };
    const modes = new Set();
    const seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (seen.has(arg)) throw failure('DUPLICATE_OPTION');
        seen.add(arg);
        if (['--probe', '--run', '--suite', '--build', '--help'].includes(arg)) {
            modes.add(arg.slice(2)); options.mode = arg.slice(2);
        } else if (['--serial', '--adb', '--sdk', '--jdk', '--scroll-strategy', '--only'].includes(arg)) {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw failure('MISSING_OPTION_VALUE');
            options[{ '--serial': 'serial', '--adb': 'adb', '--sdk': 'sdk', '--jdk': 'jdk', '--scroll-strategy': 'strategy', '--only': 'only' }[arg]] = value;
        } else throw failure('UNKNOWN_OPTION');
    }
    if (modes.size > 1) throw failure('CONFLICTING_MODES');
    if (options.serial !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.serial)) throw failure('INVALID_SERIAL');
    if (['run', 'suite'].includes(options.mode) && !options.serial) throw failure('EXPLICIT_SERIAL_REQUIRED');
    if (!['host', 'rpc'].includes(options.strategy)) throw failure('INVALID_SCROLL_STRATEGY');
    if (options.mode !== 'run' && seen.has('--scroll-strategy')) throw failure('RUN_OPTION_WITHOUT_RUN');
    if (options.only !== undefined) {
        if (options.mode !== 'suite') throw failure('ONLY_REQUIRES_SUITE');
        options.only = options.only.split(',');
        if (!options.only.length || new Set(options.only).size !== options.only.length
            || options.only.some(name => !SUITE_CASE_NAMES.includes(name))) throw failure('INVALID_SUITE_CASE');
    }
    return options;
}

function parseDevices(text) {
    if (!/^List of devices attached\b/m.test(text)) throw failure('DEVICE_LIST_UNREADABLE');
    return text.split(/\r?\n/).map(line => /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\s+(device|offline|unauthorized)\b/.exec(line))
        .filter(Boolean).map(match => ({ serial: match[1], state: match[2] }));
}

function parseSafety(windowText, powerText, policyText) {
    const focusLines = windowText.split(/\r?\n/).filter(line => /mCurrentFocus=/.test(line));
    const focuses = focusLines.map(line => /mCurrentFocus=Window\{[^\r\n{}]*?\bu(\d+)[ \t]+([^ /\t{}]+)\/([^ \t{}]+)/.exec(line));
    // No fallback to mFocusedApp: null/ambiguous focus never authorizes input.
    const foreground = focuses.length > 0 && focuses.every(match => match && match[1] === '0' && match[2] === PACKAGE);
    const wake = [...powerText.matchAll(/mWakefulness=(\w+)/g)].map(match => match[1]);
    // Android WAKEFULNESS_AWAKE=1 may accompany the named state in vendor dump sections.
    // Still require positive named evidence; numeric-only or contradictory dumps fail closed.
    const awake = wake.includes('Awake') && wake.every(value => value === 'Awake' || value === '1');
    const showing = [...policyText.matchAll(/(?:mKeyguardShowing|isKeyguardShowing|mShowingLockscreen|mKeyguardShowingAndNotOccluded)=(true|false)\b/g)].map(match => match[1]);
    const delegate = /KeyguardServiceDelegate[\s\S]{0,3000}?\n[ \t]*showing=(true|false)\b/.exec(policyText);
    if (delegate) showing.push(delegate[1]);
    const unlocked = showing.length > 0 && showing.every(value => value === 'false');
    const restricted = /(?:mInputRestricted|inputRestricted)=(true)\b/.test(policyText);
    return { foreground, awake, unlocked: unlocked && !restricted, safe: foreground && awake && unlocked && !restricted };
}

function parseState(text) {
    const match = /^Row: 0 state=(\{[^\r\n]*\})$/.exec(text.trim());
    if (!match) throw failure('FIXTURE_STATE_UNREADABLE');
    let state;
    try { state = JSON.parse(match[1]); } catch { throw failure('FIXTURE_STATE_UNREADABLE'); }
    if (!state || state.ready !== true || state.resumed !== true || state.package !== PACKAGE || state.protocol !== 1
        || typeof state.session !== 'string' || !/^[a-f0-9-]{36}$/i.test(state.session)
        || !['gestures', 'keyboard', 'scroll'].includes(state.mode)
        || typeof state.text !== 'string' || state.text.length > 128 || typeof state.focused !== 'boolean'
        || typeof state.targetVisible !== 'boolean') throw failure('FIXTURE_STATE_INVALID');
    for (const key of ['longPress', 'doubleTap', 'dragDrops', 'scaleMilli', 'imeActions', 'keyCombos',
        'pinchBegins', 'pinchUpdates', 'deleteEvents', 'lastImeKey', 'comboKey', 'comboMeta', 'scrollY', 'targetClicks']) {
        if (!Number.isSafeInteger(state[key]) || state[key] < 0) throw failure('FIXTURE_STATE_INVALID');
    }
    for (const key of ['selectionStart', 'selectionEnd']) {
        if (!Number.isSafeInteger(state[key]) || state[key] < -1 || state[key] > state.text.length) throw failure('FIXTURE_STATE_INVALID');
    }
    return state;
}

function checkReceipt(result, methods) {
    const execution = result?.details?.execution;
    if (!execution || !['dispatched', 'verified', 'observed'].includes(execution.outcome)
        || result.details.actionVerified === false) throw failure('ACTION_NOT_CONFIRMED_STOP');
    if (execution.sequence?.steps.some(step => !['verified', 'dispatched', 'observed'].includes(step.outcome))) throw failure('SEQUENCE_NOT_CONFIRMED_STOP');
    if (methods) {
        const attempts = result.details.attempts;
        if (!Array.isArray(attempts) || attempts.length !== methods.length
            || attempts.some((attempt, index) => attempt.channel !== 'rpc' || attempt.method !== methods[index] || attempt.status !== 'dispatched')) {
            throw failure('UNEXPECTED_CHANNEL_OR_FALLBACK_STOP');
        }
    }
    return execution;
}

function checkHostScroll(result) {
    const attempts = result?.details?.attempts;
    const swipes = result?.details?.swipes;
    if (!Number.isInteger(swipes) || swipes < 1 || swipes > 20 || !Array.isArray(attempts)
        || attempts.length !== swipes || attempts.some(attempt => attempt.channel !== 'shell'
            || attempt.method !== 'swipe' || attempt.status !== 'dispatched')) {
        throw failure('UNEXPECTED_CHANNEL_OR_FALLBACK_STOP');
    }
    return true;
}

// Whitelists deliberately exclude messages, parameters, selectors, editor text and image payloads.
function safeMetadata(value) {
    const details = value?.details || {};
    const execution = details.execution || value?.execution || {};
    const methods = new Set(['click', 'dragTo', 'drag', 'pinchIn', 'pinchOut', 'setText', 'getText', 'pressKeyCode', 'swipe', 'scrollTo']);
    const channels = new Set(['rpc', 'shell', 'keyevent', 'adbkeyboard']);
    const statuses = new Set(['starting', 'invoking', 'dispatched', 'not-dispatched', 'unknown', 'failed']);
    const metadata = { attempts: [] };
    if (Array.isArray(details.attempts)) metadata.attempts = details.attempts.slice(0, 100).map(attempt => ({
        channel: channels.has(attempt?.channel) ? attempt.channel : 'unrecognized',
        method: methods.has(attempt?.method) ? attempt.method : 'unrecognized',
        status: statuses.has(attempt?.status) ? attempt.status : 'unrecognized',
    }));
    if (typeof details.experimental === 'boolean') metadata.experimental = details.experimental;
    const timings = {};
    for (const key of ['prepareMs', 'actionMs', 'verificationMs', 'totalMs']) {
        if (Number.isFinite(execution.timings?.[key]) && execution.timings[key] >= 0) timings[key] = execution.timings[key];
    }
    if (Object.keys(timings).length) metadata.timings = timings;
    return metadata;
}

const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'M15_CASE_FAILED';

// A failed state predicate must say which allowlisted counter moved and to what, otherwise the stop is
// unattributable after the device is gone. Only bounded non-text fixture scalars are exported.
const READBACK_KEYS = Object.freeze(['mode', 'focused', 'targetVisible', 'longPress', 'doubleTap', 'dragDrops',
    'scaleMilli', 'imeActions', 'keyCombos', 'pinchBegins', 'pinchUpdates', 'deleteEvents', 'lastImeKey',
    'comboKey', 'comboMeta', 'scrollY', 'targetClicks', 'selectionStart', 'selectionEnd']);

function readbackSnapshot(state) {
    const snapshot = {};
    for (const key of READBACK_KEYS) {
        const value = state?.[key];
        if (typeof value === 'number' || typeof value === 'boolean') snapshot[key] = value;
        else if (key === 'mode' && ['gestures', 'keyboard', 'scroll'].includes(value)) snapshot[key] = value;
    }
    return snapshot;
}

function readbackDelta(before, after) {
    const from = readbackSnapshot(before), to = readbackSnapshot(after);
    const changed = Object.keys(from).filter(key => from[key] !== to[key]).slice(0, 12)
        .map(key => ({ key, before: from[key], after: to[key] }));
    return { changed, before: from, after: to };
}

function createSuiteCases() {
    const single = (name, mode, action, predicate, methods, keyboard = false) => ({ name, mode, async run(ctx) {
        if (keyboard) await ctx.keyboard();
        await ctx.perform(action, predicate, methods);
    } });
    const cases = [
        single('LongPress800', 'gestures', { command: 'LongPress', id: id('gesture_pad'), duration: 800 }, (a, b) => b.longPress === a.longPress + 1, ['click']),
        single('DoubleTap', 'gestures', { command: 'DoubleTap', id: id('gesture_pad') }, (a, b) => b.doubleTap === a.doubleTap + 1, ['click', 'click']),
        single('DragSemantic', 'gestures', { command: 'Drag', id: id('drag_source'), target: { id: id('drag_target') }, steps: 80 }, (a, b) => b.dragDrops === a.dragDrops + 1, ['dragTo']),
        { name: 'DragPixels', mode: 'gestures', async run(ctx) {
            const ui = await ctx.observe('ui');
            const center = resource => {
                const nodes = ui.details?.controls?.filter(node => node.id === id(resource));
                const node = nodes?.length === 1 && nodes[0];
                const box = node?.clipped;
                const screen = ui.details?.screen;
                if (!node || node.enabled !== true || node.inViewport !== true || !box || !screen
                    || ![box.left, box.top, box.right, box.bottom, screen.width, screen.height].every(Number.isFinite)
                    || box.left < 0 || box.top < 0 || box.right > screen.width || box.bottom > screen.height
                    || box.right <= box.left || box.bottom <= box.top) throw failure('PIXEL_TARGET_NOT_PROVEN');
                return { x: Math.floor((box.left + box.right) / 2), y: Math.floor((box.top + box.bottom) / 2) };
            };
            const source = center('drag_source'), destination = center('drag_target');
            const image = await ctx.observe('image');
            const frameId = image.details?.frameId;
            if (typeof frameId !== 'string' || !frameId || JSON.stringify(image.details?.screen) !== JSON.stringify(ui.details?.screen)) throw failure('PIXEL_FRAME_NOT_PROVEN');
            await ctx.perform({ command: 'Drag', ...source, x2: destination.x, y2: destination.y, frameId, steps: 80 },
                (a, b) => b.dragDrops === a.dragDrops + 1, ['drag']);
        } },
    ];
    for (const direction of ['in', 'out']) cases.push(single(direction === 'in' ? 'PinchIn' : 'PinchOut', 'gestures',
        { command: 'Pinch', id: id('pinch_pad'), direction, percent: 60, steps: 80 },
        (a, b) => b.pinchBegins > a.pinchBegins && b.pinchUpdates > a.pinchUpdates && (direction === 'in' ? b.scaleMilli < a.scaleMilli : b.scaleMilli > a.scaleMilli), [direction === 'in' ? 'pinchIn' : 'pinchOut']));
    for (const imeAction of ['enter', 'search']) cases.push(single(imeAction === 'enter' ? 'ImeActionEnter' : 'ImeActionSearch', 'keyboard',
        { command: 'ImeAction', imeAction }, (a, b) => b.focused && b.imeActions === a.imeActions + 1
            && b.lastImeKey === (imeAction === 'enter' ? 66 : 84) && b.text === a.text, ['pressKeyCode'], true));
    cases.push(single('KeyComboCtrlA', 'keyboard', { command: 'KeyCombo', keyCode: 29, metaState: 4096 },
        (a, b) => b.focused && b.keyCombos === a.keyCombos + 1 && b.comboKey === 29 && (b.comboMeta & 4096) !== 0
            && Math.min(b.selectionStart, b.selectionEnd) === 0 && Math.max(b.selectionStart, b.selectionEnd) === b.text.length, ['pressKeyCode'], true));
    cases.push({ name: 'KeyComboMOVE_END', mode: 'keyboard', async run(ctx) {
        await ctx.keyboard();
        await ctx.perform({ command: 'KeyCombo', keyCode: 29, metaState: 4096 }, (_, b) => b.focused
            && Math.min(b.selectionStart, b.selectionEnd) === 0 && Math.max(b.selectionStart, b.selectionEnd) === b.text.length, ['pressKeyCode'], 'prepare');
        await ctx.perform({ command: 'KeyCombo', keyCode: 123, metaState: 0 }, (_, b) => b.focused
            && b.selectionStart === b.text.length && b.selectionEnd === b.text.length, ['pressKeyCode']);
    } });
    cases.push({ name: 'EraseText2', mode: 'keyboard', async run(ctx) {
        await ctx.keyboard();
        await ctx.perform({ command: 'KeyCombo', keyCode: 123, metaState: 0 }, (_, b) => b.focused
            && b.selectionStart === b.text.length && b.selectionEnd === b.text.length, ['pressKeyCode'], 'prepare');
        await ctx.perform({ command: 'EraseText', id: id('input'), count: 2 }, (a, b) => b.focused
            && b.deleteEvents === a.deleteEvents + 2 && b.text === a.text.slice(0, -2), ERASE_METHODS);
    } });
    for (const strategy of ['host', 'rpc']) cases.push(single(strategy === 'host' ? 'ScrollUntilHost' : 'ScrollUntilRpc', 'scroll',
        { command: 'ScrollUntil', container: `id=${id('scroll_container')}`, target: 'text=M15_SCROLL_TARGET', strategy, ...(strategy === 'host' ? { maxSwipes: 20 } : {}) },
        (a, b, response) => (strategy !== 'host' || checkHostScroll(response)) && !a.targetVisible && b.targetVisible && b.scrollY > a.scrollY && b.targetClicks === 0,
        strategy === 'rpc' ? ['scrollTo'] : undefined));
    cases.push({ name: 'ActionHistoryPure', mode: 'keyboard', async run(ctx) {
        await ctx.keyboard();
        const history = await ctx.history();
        const entries = history.details?.entries;
        const keys = new Set(['requestId', 'command', 'outcome', 'durationMs', 'stepIndex', 'channel', 'method', 'status', 'code']);
        if (!Array.isArray(entries) || ctx.requestIds.length < 3 || ctx.requestIds.some(requestId => !entries.some(entry => entry.requestId === requestId))
            || entries.some(entry => Object.keys(entry).some(key => !keys.has(key))
                || !(ctx.requestIds.includes(entry.requestId) ? ['observed', 'dispatched', 'verified']
                    : ['observed', 'dispatched', 'verified', 'failed', 'unknown']).includes(entry.outcome))
            || JSON.stringify(entries).includes(SEED)) throw failure('HISTORY_CONTRACT_MISMATCH_STOP');
        const again = await ctx.history();
        if (JSON.stringify(again.details) !== JSON.stringify(history.details)) throw failure('HISTORY_QUERY_NOT_PURE_STOP');
    } });
    return cases;
}

async function runSuite({ service, serial, gate, initialize, assertIdle, settle = () => sleep(250),
    drainPause = () => sleep(100), drainTimeoutMs = 5000, cleanupTimeoutMs = 7000, emit = () => {}, only }) {
    const results = [];
    const selected = createSuiteCases().filter(item => !only || only.includes(item.name));
    let stopped = false;
    const safety = () => { try { return gate(); } catch (error) { error.suiteStop = true; throw error; } };
    async function drain(requireQueue = true) {
        const deadline = Date.now() + drainTimeoutMs;
        do {
            try {
                assertIdle();
                const queue = service.getRuntimeStatus?.()?.adbQueue;
                if ((!queue && requireQueue) || (queue && (queue.depth !== 0 || queue.pending !== 0 || queue.running !== false))) throw failure('RUNTIME_NOT_DRAINED_STOP');
                return;
            } catch (error) {
                if (error.code !== 'DEVICE_BUSY' && error.code !== 'RUNTIME_NOT_DRAINED_STOP') throw failure('RUNTIME_IDLE_UNPROVEN_STOP');
                if (Date.now() >= deadline) throw failure('RUNTIME_NOT_DRAINED_STOP');
                await drainPause();
            }
        } while (true);
    }
    async function cleanup() {
        let timer;
        try {
            await Promise.race([service.cleanup(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(failure('CLEANUP_DEADLINE_STOP')), cleanupTimeoutMs);
            })]);
        } catch (error) {
            throw failure(error.code === 'CLEANUP_DEADLINE_STOP' ? error.code : 'CLEANUP_FAILED_STOP');
        } finally { clearTimeout(timer); }
    }
    for (const item of selected) {
        const operations = [], requestIds = [];
        let initialized = false, problem, terminal, stage = 'initialize';
        const record = (kind, value) => operations.push({ stage: kind, ...safeMetadata(value) });
        const ctx = {
            requestIds,
            async perform(action, predicate, methods, kind = 'test') {
                stage = kind;
                const before = safety();
                let response;
                try { response = await service.processToolCall({ command: 'ExecuteStep', serial, timeoutMs: 20000, action }); }
                catch (error) { record(kind, error); throw error; }
                record(kind, response);
                const execution = checkReceipt(response, methods);
                if (execution.serial !== serial) { const error = failure('ACTION_SERIAL_MISMATCH_STOP'); error.suiteStop = true; throw error; }
                await settle();
                const after = safety();
                if (!predicate(before, after, response)) {
                    const error = failure('INDEPENDENT_READBACK_MISMATCH_STOP');
                    error.readback = readbackDelta(before, after);
                    throw error;
                }
                if (typeof execution.requestId !== 'string' || !execution.requestId) throw failure('ACTION_REQUEST_ID_MISSING');
                requestIds.push(execution.requestId);
                return response;
            },
            async keyboard() {
                await ctx.perform({ command: 'Tap', id: id('input') }, (_, b) => b.focused, ['click'], 'prepare');
                await ctx.perform({ command: 'Fill', id: id('input'), text: SEED }, (_, b) => b.text === SEED && b.focused, ['setText', 'getText'], 'prepare');
            },
            async observe(mode) {
                stage = 'observe'; safety();
                let response;
                try { response = await service.processToolCall({ command: 'Observe', mode, serial, wake: 'never', timeoutMs: 20000,
                    ...(mode === 'ui' ? { includeCoordinates: true } : {}) }); }
                catch (error) { record('observe', error); throw error; }
                record('observe', response);
                const execution = checkReceipt(response);
                if (execution.serial !== serial || response.details?.serial !== serial) { const error = failure('ACTION_SERIAL_MISMATCH_STOP'); error.suiteStop = true; throw error; }
                safety(); return response;
            },
            async history() {
                stage = 'history'; safety();
                const response = await service.processToolCall({ command: 'Manage', operation: 'actionHistory', serial, limit: 100 });
                safety(); return response;
            },
        };
        try {
            safety();
            await drain(false);
            initialized = true;
            await initialize();
            await drain();
            await ctx.perform({ command: 'Tap', id: id(`nav_${item.mode}`) }, (_, b) => b.mode === item.mode
                && ['longPress', 'doubleTap', 'dragDrops', 'imeActions', 'keyCombos', 'pinchBegins', 'pinchUpdates', 'deleteEvents', 'scrollY', 'targetClicks'].every(key => b[key] === 0)
                && b.scaleMilli === 1000 && b.text === '' && !b.targetVisible, ['click'], 'reset');
            await item.run(ctx);
        } catch (error) {
            problem = error;
            if (error.suiteStop || stage === 'initialize') terminal = error;
        } finally {
            if (initialized) {
                try {
                    // A returned/failed tool call may still own a lease. Never tear down or reset over it.
                    await drain();
                    safety();
                    await cleanup();
                    await drain();
                    safety();
                } catch (error) { terminal = error; }
            }
        }
        const result = { phase: 'case', name: item.name, status: problem || terminal ? 'NOT_PASSED' : 'PASS',
            code: safeCode(terminal || problem || { code: 'OK' }), operations, retried: false };
        if (problem?.readback) result.readback = problem.readback;
        if (terminal && problem && terminal !== problem) result.caseCode = safeCode(problem);
        if (terminal) { result.stopped = true; stopped = true; }
        results.push(result); emit(result);
        if (stopped) break;
    }
    const passed = results.filter(result => result.status === 'PASS').length;
    const allPassed = !stopped && results.length === SUITE_CASE_NAMES.length && passed === SUITE_CASE_NAMES.length;
    const summary = { phase: 'summary', status: allPassed ? 'PASS' : 'NOT_PASSED', deviceAcceptance: allPassed ? 'PASSED' : 'NOT_PASSED',
        matrixTotal: SUITE_CASE_NAMES.length, selected: selected.map(item => item.name), explicitSelection: Boolean(only),
        executed: results.length, passed, failed: results.length - passed, notExecuted: selected.length - results.length,
        stopped, retried: false };
    emit(summary);
    return { exitCode: stopped || passed !== selected.length ? 1 : 0, results, summary };
}

async function main(argv = process.argv.slice(2), deps = {}) {
    const options = parseArgs(argv);
    const emit = deps.emit || (item => console.log(JSON.stringify(item)));


    const spawnSync = deps.spawnSync || cp.spawnSync;
    const settle = deps.settle || (() => sleep(250));
    if (options.mode === 'help') {
        emit({ usage: 'node scripts/verify-android-m15.cjs [--probe | --build | --run --serial SERIAL | --suite --serial SERIAL [--only DoubleTap,DragSemantic]] [--sdk SDK] [--adb ADB] [--jdk JDK] [--scroll-strategy host|rpc]',
            suiteCases: SUITE_CASE_NAMES, safety: 'Default probe never loads Service. No discovery/connect/install/launch/wake/unlock/retry. --run/--suite require a manually opened isolated fixture and explicit serial; --run remains failfast. --only is an explicit partial verification, never full acceptance.' });
        return { exitCode: 0 };
    }
    if (options.mode === 'build') {
        const args = [path.join(__dirname, 'android-m15-fixture/build.cjs'), '--sdk', options.sdk, '--build-tools', '36.0.0', '--platform', 'android-35'];
        if (options.jdk) args.push('--jdk', options.jdk);
        const built = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', timeout: 120000, windowsHide: true });
        if (built.error || built.status !== 0) throw failure('LOCAL_BUILD_FAILED');
        emit({ phase: 'build', status: 'BUILT', deviceAcceptance: 'NOT_RUN' });
        return { exitCode: 0 };
    }
    const adb = options.adb || process.env.ADB_PATH || path.join(options.sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    if ((path.isAbsolute(adb) || adb.includes('/') || adb.includes('\\')) && !fs.statSync(adb, { throwIfNoEntry: false })?.isFile()) throw failure('LOCAL_ADB_MISSING');
    function exec(args, device = true) {
        const actual = device ? ['-s', options.serial, ...args] : args;
        const value = spawnSync(adb, actual, { cwd: ROOT, encoding: 'utf8', timeout: 7000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        if (value.error || value.status !== 0) throw failure('ADB_READ_FAILED_STOP');
        return String(value.stdout || '');
    }
    const devices = parseDevices(exec(['devices', '-l'], false));
    const selected = options.serial && devices.find(device => device.serial === options.serial && device.state === 'device');
    emit({ phase: 'devices', status: 'NOT_RUN', authorizedDevices: devices.filter(device => device.state === 'device').length,
        explicitSerial: Boolean(options.serial), selectedOnline: Boolean(selected), deviceAcceptance: 'NOT_RUN' });
    if (!selected) {
        if (['run', 'suite'].includes(options.mode)) throw failure('EXPLICIT_DEVICE_NOT_ONLINE');
        emit({ phase: 'probe', status: 'NOT_RUN', reason: options.serial ? 'EXPLICIT_DEVICE_NOT_ONLINE' : 'EXPLICIT_SERIAL_REQUIRED_FOR_TARGET_PROBE', serviceInitialized: false });
        return { exitCode: 2 };
    }
    let session;
    function gate() {
        const safety = parseSafety(exec(['shell', 'dumpsys', 'window', 'displays']), exec(['shell', 'dumpsys', 'power']), exec(['shell', 'dumpsys', 'window', 'policy']));
        if (!safety.safe) throw failure('UNSAFE_OR_UNPROVEN_TARGET_STOP');
        const state = parseState(exec(['shell', 'content', 'query', '--uri', STATE_URI]));
        if (session && state.session !== session) throw failure('FIXTURE_SESSION_CHANGED_STOP');
        session = state.session;
        return state;
    }
    const initial = gate();
    emit({ phase: 'probe', status: 'READY_NOT_RUN', package: PACKAGE, mode: initial.mode, foreground: true, awake: true, unlocked: true, serviceInitialized: false, deviceAcceptance: 'NOT_RUN' });
    if (!['run', 'suite'].includes(options.mode)) return { exitCode: 0 };
    if (exec(['shell', `[ -f ${RPC_APK} ] && echo PRESENT || echo ABSENT`]).trim() !== 'PRESENT') throw failure('PREPROVISIONED_RPC_APK_REQUIRED');
    // Explicit --run may start the existing app_process RPC transport. No APK push/install is authorized here.
    const service = (deps.loadService || (() => require(path.join(ROOT, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'))))();
    const log = { log() {}, warn() {}, error() {} };
    if (options.mode === 'suite') {
        const runtime = (deps.loadRuntime || (() => require(path.join(ROOT, 'VCPDistributedServer/Plugin/AndroidController/lib/step-runtime'))))();
        return runSuite({ service, serial: options.serial, gate,
            initialize: () => service.initialize({ config: { ADB_PATH: adb, DEVICE_SERIAL: options.serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0 }, logger: log }),
            assertIdle: () => runtime.assertManagementIdle(), settle, emit, only: options.only,
            ...(deps.drainPause ? { drainPause: deps.drainPause } : {}), ...(deps.drainTimeoutMs !== undefined ? { drainTimeoutMs: deps.drainTimeoutMs } : {}) });
    }
    const performed = [];
    const requestIds = [];
    let initialized = false;
    async function perform(name, action, predicate, methods, extra = {}) {
        const before = gate();
        const response = await service.processToolCall({ command: 'ExecuteStep', serial: options.serial, timeoutMs: 20000, action, ...extra });
        const execution = checkReceipt(response, methods);
        if (execution.serial !== options.serial) throw failure('ACTION_SERIAL_MISMATCH_STOP');
        await settle();
        const after = gate();
        if (!predicate(before, after, response)) throw failure('INDEPENDENT_READBACK_MISMATCH_STOP');
        requestIds.push(execution.requestId);
        performed.push(name);
        emit({ phase: 'action', name, status: 'PASS', independentReadback: true, outcome: execution.outcome });
        return response;
    }
    const navigate = mode => perform(`fixture:${mode}`, { command: 'Tap', id: id(`nav_${mode}`) }, (_, after) => after.mode === mode, ['click']);
    try {
        // The safety probe above precedes even local Service initialization.
        initialized = true;
        await service.initialize({ config: { ADB_PATH: adb, DEVICE_SERIAL: options.serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0 }, logger: log });
        await navigate('gestures');
        await perform('LongPress', { command: 'LongPress', id: id('gesture_pad'), duration: 800 }, (a, b) => b.longPress === a.longPress + 1, ['click']);
        await perform('DoubleTap', { command: 'DoubleTap', id: id('gesture_pad') }, (a, b) => b.doubleTap === a.doubleTap + 1, ['click', 'click']);
        await perform('Drag', { command: 'Drag', id: id('drag_source'), target: { id: id('drag_target') }, steps: 80 }, (a, b) => b.dragDrops === a.dragDrops + 1, ['dragTo']);
        for (const direction of ['in', 'out']) await perform(`Pinch:${direction}`, { command: 'Pinch', id: id('pinch_pad'), direction, percent: 60, steps: 80 },
            (a, b) => b.pinchBegins > a.pinchBegins && b.pinchUpdates > a.pinchUpdates && (direction === 'in' ? b.scaleMilli < a.scaleMilli : b.scaleMilli > a.scaleMilli), [direction === 'in' ? 'pinchIn' : 'pinchOut']);
        await navigate('keyboard');
        await perform('Focus editor', { command: 'Tap', id: id('input') }, (_, b) => b.focused, ['click']);
        await perform('Fill setup', { command: 'Fill', id: id('input'), text: SEED }, (_, b) => b.text === SEED && b.focused, ['setText', 'getText']);
        for (const imeAction of ['enter', 'search']) await perform(`ImeAction:${imeAction}`, { command: 'ImeAction', imeAction },
            (a, b) => b.focused && b.imeActions === a.imeActions + 1 && b.lastImeKey === (imeAction === 'enter' ? 66 : 84) && b.text === a.text, ['pressKeyCode']);
        await perform('KeyCombo:CTRL+A', { command: 'KeyCombo', keyCode: 29, metaState: 4096 },
            (a, b) => b.focused && b.keyCombos === a.keyCombos + 1 && b.comboKey === 29 && (b.comboMeta & 4096) !== 0
                && Math.min(b.selectionStart, b.selectionEnd) === 0 && Math.max(b.selectionStart, b.selectionEnd) === b.text.length, ['pressKeyCode']);
        await perform('KeyCombo:MOVE_END', { command: 'KeyCombo', keyCode: 123, metaState: 0 },
            (_, b) => b.focused && b.selectionStart === b.text.length && b.selectionEnd === b.text.length, ['pressKeyCode']);
        await perform('EraseText', { command: 'EraseText', id: id('input'), count: 2 },
            (a, b) => b.focused && b.deleteEvents === a.deleteEvents + 2 && b.text === a.text.slice(0, -2), ERASE_METHODS);
        await navigate('scroll');
        const scrollAction = { command: 'ScrollUntil', container: `id=${id('scroll_container')}`, target: 'text=M15_SCROLL_TARGET', strategy: options.strategy };
        if (options.strategy === 'host') scrollAction.maxSwipes = 20;
        await perform(`ScrollUntil:${options.strategy}`, scrollAction, (a, b, response) => (options.strategy !== 'host' || checkHostScroll(response))
            && !a.targetVisible && b.targetVisible && b.scrollY > a.scrollY && b.targetClicks === 0,
            options.strategy === 'rpc' ? ['scrollTo'] : undefined);
        // History is queried only after the independent readback of every action succeeded.
        gate();
        const historyResult = await service.processToolCall({ command: 'Manage', operation: 'actionHistory', serial: options.serial, limit: 100 });
        const entries = historyResult.details?.entries;
        const keys = new Set(['requestId', 'command', 'outcome', 'durationMs', 'stepIndex', 'channel', 'method', 'status', 'code']);
        if (!Array.isArray(entries) || requestIds.some(requestId => !entries.some(entry => entry.requestId === requestId))
            || entries.some(entry => Object.keys(entry).some(key => !keys.has(key))
                || !(requestIds.includes(entry.requestId) ? ['observed', 'dispatched', 'verified']
                    : ['observed', 'dispatched', 'verified', 'failed', 'unknown']).includes(entry.outcome))
            || JSON.stringify(entries).includes(SEED)) throw failure('HISTORY_CONTRACT_MISMATCH_STOP');
        const again = await service.processToolCall({ command: 'Manage', operation: 'actionHistory', serial: options.serial, limit: 100 });
        if (JSON.stringify(again.details) !== JSON.stringify(historyResult.details)) throw failure('HISTORY_QUERY_NOT_PURE_STOP');
        gate();
        emit({ phase: 'summary', status: 'PASS', deviceAcceptance: 'PASSED', package: PACKAGE, actions: performed.length, historyEntries: entries.length, retried: false });
        return { exitCode: 0 };
    } finally {
        // Cleanup is transport teardown, never a retry or another test action.
        if (initialized) await service.cleanup();
    }
}

module.exports = { PACKAGE, ERASE_METHODS, SUITE_CASE_NAMES, parseArgs, parseDevices, parseSafety, parseState, checkReceipt, checkHostScroll, safeMetadata, createSuiteCases, runSuite, main };
if (require.main === module) main().then(result => { process.exitCode = result.exitCode; }).catch(error => {
    console.error(JSON.stringify({ phase: 'stopped', status: 'NOT_PASSED', code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'M15_ACCEPTANCE_STOPPED', retried: false }));
    process.exitCode = 1;
});
