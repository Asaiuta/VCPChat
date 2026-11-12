'use strict';
// Acceptance for M2.5.3 rotation/layout-context: the fixture rotates itself (no system
// settings), the harness asserts context/epoch/credential invalidation independently of
// the plugin's own receipts. Portrait-only ROM/display coverage is recorded separately.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const legacy = require('./verify-android-m15.cjs');
const PACKAGE = legacy.PACKAGE;
const id = name => `${PACKAGE}:id/${name}`;
const fail = code => Object.assign(new Error(code), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const CASES = Object.freeze(['PortraitContext', 'RotateToLandscape', 'LandscapeContext',
    'StaleIndexAfterRotation', 'StaleFrameAfterRotation', 'LandscapeScroll', 'LandscapeIdleStable',
    'RotateBackRejectsOldCredential']);
const LANDSCAPE = [1, 3];

async function expectFailure(task, codes) {
    let caught;
    try { await task(); } catch (error) { caught = error; }
    if (!caught) throw fail('EXPECTED_REJECTION_MISSING');
    if (!codes.includes(caught.code)) throw caught;
    return caught.code;
}

function parseArgs(argv) {
    const o = { mode: 'probe', sdk: 'F:/AndroidSdk' }, seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]; if (seen.has(a)) throw fail('DUPLICATE_OPTION'); seen.add(a);
        if (a === '--probe' || a === '--suite') {
            if (seen.has(a === '--probe' ? '--suite' : '--probe')) throw fail('CONFLICTING_MODES');
            o.mode = a.slice(2);
        } else if (['--serial', '--sdk', '--adb'].includes(a)) {
            const v = argv[++i]; if (!v || v.startsWith('--')) throw fail('MISSING_OPTION_VALUE'); o[a.slice(2)] = v;
        } else throw fail('UNKNOWN_OPTION');
    }
    if (!o.serial || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(o.serial)) throw fail('EXPLICIT_SERIAL_REQUIRED');
    return o;
}

// The fixture's own rotation/size report is the independent witness: it never reads the
// plugin's context, so agreement between them is real corroboration, not a tautology.
function parseState(text) {
    const m = /^Row: 0 state=(\{[^\r\n]*\})$/.exec(text.trim());
    let s; try { s = JSON.parse(m?.[1]); } catch { throw fail('FIXTURE_STATE_UNREADABLE'); }
    if (s.ready !== true || s.resumed !== true || s.package !== PACKAGE || s.protocol !== 1
        || !/^[a-f0-9-]{36}$/i.test(s.session)
        || !['gestures', 'keyboard', 'scroll', 'm2'].includes(s.mode)) throw fail('FIXTURE_STATE_INVALID');
    if (![0, 1, 2, 3].includes(s.rotation) || !Number.isSafeInteger(s.rotateRequests) || s.rotateRequests < 0
        || !Number.isSafeInteger(s.width) || !Number.isSafeInteger(s.height)
        || s.width <= 0 || s.height <= 0) throw fail('FIXTURE_ROTATION_STATE_INVALID');
    for (const k of ['longPress', 'doubleTap', 'dragDrops', 'm2ClicksA', 'm2ClicksB']) {
        if (!Number.isSafeInteger(s[k]) || s[k] < 0) throw fail('FIXTURE_STATE_INVALID');
    }
    return s;
}

const isLandscape = state => LANDSCAPE.includes(state.rotation);
// The fixture is rotated by tapping its own button, so rotation coverage never needs
// `settings put system` and cannot leave the device's user rotation changed.
const orientation = state => isLandscape(state) ? 'landscape' : 'portrait';

async function runMatrix(ctx) {
    const results = [];
    const saved = {};
    for (const name of CASES) {
        ctx.current = name;
        ctx.emit({ phase: 'case-start', name });
        try {
            await ctx.reset(); await ctx.drain(); ctx.gate();
            await CASES_RUN[name](ctx, saved);
            await ctx.drain(); ctx.gate();
            results.push({ name, status: 'PASS' });
            ctx.emit({ phase: 'case', name, status: 'PASS', retried: false });
        } catch (error) {
            const code = error.code === 'ERR_ASSERTION' ? 'INDEPENDENT_ASSERTION_FAILED'
                : /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'ROTATION_CASE_FAILED';
            results.push({ name, status: 'NOT_PASSED', code });
            ctx.emit({ phase: 'case', name, status: 'NOT_PASSED', code, retried: false,
                detail: String(error.message || '').slice(0, 300) });
            if (error.terminal || /^UI_SERVER_|DEVICE_STATE_UNCERTAIN|STEP_DEADLINE|STEP_ABORTED|UNSAFE_|FIXTURE_|RUNTIME_|ACTION_NOT_CONFIRMED|ACTION_SERIAL_MISMATCH|UNEXPECTED_CHANNEL/.test(code)) break;
        }
    }
    const passed = results.filter(r => r.status === 'PASS').length;
    const ok = passed === CASES.length && results.length === CASES.length;
    const summary = { phase: 'summary', matrix: 'rotation', deviceAcceptance: ok ? 'PASSED' : 'NOT_PASSED',
        matrixTotal: CASES.length, executed: results.length, passed, failed: results.length - passed,
        notExecuted: CASES.length - results.length, retried: false };
    ctx.emit(summary);
    return { exitCode: ok ? 0 : 1, summary, results };
}

const CASES_RUN = {
    async PortraitContext(ctx, saved) {
        // Normalise to portrait first: a previous aborted run may have left it rotated.
        if (isLandscape(ctx.gate())) { await ctx.rotate(); await ctx.waitFor(state => !isLandscape(state)); }
        const ui = await ctx.observe();
        const state = ctx.gate();
        const context = ui.details?.context;
        assert.ok(context, 'Observe must expose a context');
        assert.equal(orientation(state), 'portrait');
        assert.equal(context.rotation, state.rotation);
        assert.deepEqual([context.size.width, context.size.height], [state.width, state.height]);
        assert.ok(context.size.width < context.size.height, 'portrait width must be smaller than height');
        const rotateNode = ui.details.controls?.find(node => node.id === id('nav_rotate'));
        assert.ok(rotateNode && Number.isSafeInteger(rotateNode.index), 'fixture rotate control must be addressable');
        saved.snapshotId = ui.details.snapshotId;
        saved.index = rotateNode.index;
        saved.context = context;
        const image = await ctx.image({ region: { left: 40, top: 60, width: 400, height: 300 } });
        assert.equal(image.details?.actionable === false, false);
        saved.frameId = image.details.frameId;
        saved.imageScreen = image.details.screen;
        assert.deepEqual([saved.imageScreen.width, saved.imageScreen.height], [state.width, state.height]);
        ctx.evidence({ orientation: 'portrait', rotation: state.rotation, width: state.width, height: state.height,
            epoch: context.epoch ?? null, frameId: 'captured' });
    },

    async RotateToLandscape(ctx, saved) {
        await ctx.rotate();
        const state = await ctx.waitFor(s => isLandscape(s), 'ROTATION_NOT_APPLIED');
        assert.ok(state.width > state.height, 'landscape width must exceed height');
        assert.equal(state.session, ctx.session, 'fixture instance must survive rotation (configChanges)');
        ctx.evidence({ rotation: state.rotation, width: state.width, height: state.height,
            rotateRequests: state.rotateRequests, session: 'unchanged' });
    },

    async LandscapeContext(ctx, saved) {
        const ui = await ctx.observe();
        const state = ctx.gate();
        const context = ui.details.context;
        assert.ok(context, 'Observe must expose a context after rotation');
        assert.equal(orientation(state), 'landscape');
        assert.equal(context.rotation, state.rotation);
        assert.deepEqual([context.size.width, context.size.height], [state.width, state.height]);
        assert.ok(context.size.width > context.size.height);
        assert.notEqual(context.epoch, saved.context.epoch, 'rotation must advance the context epoch');
        const image = await ctx.image({ region: { left: 120, top: 80, width: 640, height: 360 } });
        assert.deepEqual(image.details.screen, { width: state.width, height: state.height });
        assert.deepEqual(image.details.region, { left: 120, top: 80, width: 640, height: 360 });
        assert.equal(image.details.mapping.screen.width, state.width);
        // A landscape crop must keep the device-coordinate region intact, not swap axes.
        assert.ok(Math.abs(image.details.mapping.region.width / image.details.mapping.region.height - 640 / 360) < 0.01);
        ctx.evidence({ rotation: context.rotation, epoch: context.epoch, region: image.details.region,
            image: `${image.details.mapping.imageWidth}x${image.details.mapping.imageHeight}` });
    },

    async StaleIndexAfterRotation(ctx, saved) {
        const code = await expectFailure(() => ctx.execute({ action: { command: 'Tap', index: saved.index, snapshotId: saved.snapshotId } }),
            ['STALE_SNAPSHOT']);
        const state = ctx.gate();
        assert.equal(state.rotateRequests >= 1, true);
        ctx.evidence({ rejected: code });
    },

    async StaleFrameAfterRotation(ctx, saved) {
        const code = await expectFailure(() => ctx.execute({ action: { command: 'Tap', x: 200, y: 300, frameId: saved.frameId } }),
            ['STALE_FRAME', 'STALE_SNAPSHOT']);
        ctx.evidence({ rejected: code });
    },

    async LandscapeScroll(ctx) {
        await ctx.tap({ id: id('nav_scroll') }, (_, b) => b.mode === 'scroll');
        const state = ctx.gate();
        assert.ok(isLandscape(state), 'scroll case must run in landscape');
        const before = state.scrollY;
        const result = await ctx.execute({ action: { command: 'Scroll', id: id('scroll_container'), direction: 'down', distance: 0.6 } });
        assert.equal(result.details.execution.outcome, 'dispatched');
        const after = await ctx.waitFor(s => s.scrollY > before, 'LANDSCAPE_SCROLL_NOT_APPLIED');
        ctx.evidence({ orientation: 'landscape', scrollYBefore: before, scrollYAfter: after.scrollY,
            attempts: result.details.attempts?.map(a => a.channel) || [] });
    },

    async LandscapeIdleStable(ctx) {
        // Every case starts from gestures; navigate here rather than inheriting the
        // previous case's leftover mode.
        await ctx.tap({ id: id('nav_scroll') }, (_, b) => b.mode === 'scroll');
        const state = ctx.gate();
        assert.ok(isLandscape(state) && state.mode === 'scroll');
        const result = await ctx.idle(6500);
        assert.equal(result.details.execution.outcome, 'verified');
        assert.equal(result.details.idleMode, 'layout_stable');
        const after = ctx.gate();
        assert.ok(isLandscape(after));
        ctx.evidence({ orientation: 'landscape', idleMode: result.details.idleMode });
    },

    async RotateBackRejectsOldCredential(ctx, saved) {
        await ctx.rotate();
        const state = await ctx.waitFor(s => !isLandscape(s), 'ROTATION_BACK_NOT_APPLIED');
        assert.ok(state.width < state.height);
        assert.equal(state.session, ctx.session);
        // Back at the same rotation/size the original credential was issued for: the epoch,
        // not the visible geometry, must be what keeps it dead.
        const code = await expectFailure(() => ctx.execute({ action: { command: 'Tap', index: saved.index, snapshotId: saved.snapshotId } }),
            ['STALE_SNAPSHOT']);
        const ui = await ctx.observe();
        assert.ok(ui.details.context, 'portrait context must be recoverable after rotating back');
        assert.ok(ui.details.context.epoch > saved.context.epoch);
        ctx.evidence({ rotation: state.rotation, rejected: code, epochBefore: saved.context.epoch,
            epochAfter: ui.details.context.epoch });
    },
};

async function main(argv = process.argv.slice(2), deps = {}) {
    const o = parseArgs(argv), emit = deps.emit || (v => console.log(JSON.stringify(v)));
    const spawnSync = deps.spawnSync || cp.spawnSync;
    const adb = o.adb || path.join(o.sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    if (!fs.statSync(adb, { throwIfNoEntry: false })?.isFile()) throw fail('LOCAL_ADB_MISSING');
    const exec = (args, device = true) => {
        const q = spawnSync(adb, [...(device ? ['-s', o.serial] : []), ...args],
            { encoding: 'utf8', timeout: 12000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        if (q.error || q.status !== 0) throw fail('ADB_READ_FAILED_STOP');
        return q.stdout;
    };
    const devices = legacy.parseDevices(exec(['devices', '-l'], false));
    if (!devices.some(d => d.serial === o.serial && d.state === 'device')) throw fail('EXPLICIT_DEVICE_NOT_ONLINE');
    let session;
    const gate = () => {
        const safe = legacy.parseSafety(exec(['shell', 'dumpsys', 'window', 'displays']), exec(['shell', 'dumpsys', 'power']),
            exec(['shell', 'dumpsys', 'window', 'policy']));
        if (!safe.safe) throw fail('UNSAFE_OR_UNPROVEN_TARGET_STOP');
        const s = parseState(exec(['shell', 'content', 'query', '--uri', `content://${PACKAGE}.state/state`]));
        if (session && s.session !== session) throw fail('FIXTURE_SESSION_CHANGED_STOP');
        session = s.session;
        return s;
    };
    const first = gate();
    emit({ phase: 'probe', status: 'READY_NOT_RUN', mode: first.mode, rotation: first.rotation,
        size: `${first.width}x${first.height}`, serviceInitialized: false });
    if (o.mode === 'probe') return { exitCode: 0 };
    const service = (deps.loadService || (() => require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService')))();
    let initialized = false;
    const drain = async () => {
        const until = Date.now() + 15000;
        for (;;) {
            const q = service.getRuntimeStatus()?.adbQueue;
            if (q && q.depth === 0 && q.pending === 0 && q.running === false) return;
            if (Date.now() >= until) throw fail('RUNTIME_NOT_DRAINED_STOP');
            await pause(150);
        }
    };
    await service.initialize({ config: { ADB_PATH: adb, DEVICE_SERIAL: o.serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0 },
        logger: { log() {}, warn() {}, error() {} } });
    initialized = true;
    const call = async args => {
        gate();
        const r = await service.processToolCall({ serial: o.serial, timeoutMs: 30000, ...args });
        if (r.details?.execution?.serial !== o.serial) throw fail('ACTION_SERIAL_MISMATCH_STOP');
        emit({ phase: 'operation', name: ctx.current, command: args.command, outcome: r.details.execution.outcome,
            totalMs: r.details.execution.timings?.totalMs, error: r.details.execution.verification?.error });
        gate();
        return r;
    };
    const ctx = {
        gate, drain, emit, current: '', get session() { return session; },
        evidence(v) { emit({ phase: 'evidence', name: this.current, ...v }); },
        execute: a => call({ command: 'ExecuteStep', ...a }),
        observe: () => call({ command: 'Observe', mode: 'ui', wake: 'never', limit: 500, includeCoordinates: true }),
        image: extra => call({ command: 'Observe', mode: 'image', wake: 'never', grid: false, format: 'png', ...extra }),
        async tap(selector, predicate) {
            const a = gate();
            const r = await this.execute({ action: { command: 'Tap', selector } });
            legacy.checkReceipt(r, ['click']);
            await pause(150);
            await this.waitFor(state => predicate(a, state), 'FIXTURE_TAP_PREDICATE_FAILED');
            return r;
        },
        // The fixture rotates itself; the harness only taps its own control and then waits
        // for the independent state to agree.
        async rotate() { await this.execute({ action: { command: 'Tap', id: id('nav_rotate') } }); },
        async waitFor(predicate, code = 'FIXTURE_STATE_TIMEOUT') {
            const until = Date.now() + 45000;
            for (;;) {
                const state = gate();
                if (predicate(state)) return state;
                if (Date.now() >= until) throw fail(code);
                await pause(500);
            }
        },
        async idle(ms) {
            return this.execute({ action: { command: 'Wait', mode: 'idle' }, waitTimeoutMs: ms });
        },
        async reset() {
            const state = gate();
            if (state.mode !== 'gestures') await this.tap({ id: id('nav_gestures') }, (_, b) => b.mode === 'gestures');
        },
    };
    try {
        return await runMatrix(ctx);
    } finally {
        if (initialized) {
            try { await drain(); await service.cleanup(); } catch { /* cleanup failure is reported by the case that owns it */ }
        }
    }
}

module.exports = { CASES, parseArgs, parseState, runMatrix, main, expectFailure, isLandscape };
if (require.main === module) {
    main().then(r => { process.exitCode = r.exitCode; }).catch(e => {
        console.error(JSON.stringify({ phase: 'stopped', status: 'NOT_PASSED',
            code: /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code || '') ? e.code : 'ROTATION_ACCEPTANCE_STOPPED', retried: false }));
        process.exitCode = 1;
    });
}
