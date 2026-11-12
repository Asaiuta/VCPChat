'use strict';

// Research-only M4-A5 characterisation: task migration, IME and permission-dialog placement.
// Frozen protocol: a5-protocol.md. One fresh virtual display per scenario; no retries.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./protocol.cjs');
const C = require('./causal.cjs');
const { Evidence, Session, waitUntil, resolveServerArtifact } = require('./probe.cjs');
const { encodeTouch, ACTION_DOWN, ACTION_UP } = require('./f2.cjs');
const { windowDisplaySections } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/display-target');

const PROTOCOL = 'M4-A5';
const SOURCES = ['a5.cjs', 'a5-protocol.md', 'causal.cjs', 'probe.cjs', 'protocol.cjs', 'f2.cjs'];
const PHYSICAL_SCENARIOS = new Set(['S2', 'S3', 'S5']);
const SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5'];
const COMPONENT = { main: `${P.PACKAGE}/.MainActivity`, single: `${P.PACKAGE}/.SingleTaskActivity`, permission: `${P.PACKAGE}/.PermissionActivity` };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** All live fixture instances; unlike P.fixtureState this allows several displays. */
function fixtureStates(text) {
    const match = /^Row: 0 json=(\{[^\r\n]*\})\s*$/.exec(String(text).trim());
    let data;
    try { data = JSON.parse(match?.[1]); } catch { throw P.fail('FIXTURE_UNREADABLE'); }
    if (data.schemaVersion !== 1 || data.package !== P.PACKAGE || !Array.isArray(data.states)) throw P.fail('FIXTURE_INVALID');
    if (data.captureStatus !== 'fresh') throw P.fail('FIXTURE_CAPTURE_STALE');
    return data.states.filter(s => s.destroyed === false).map(s => ({ ...s, processSession: data.processSession }));
}

function classifyMigration(before, after, { from, to, activity }) {
    const pick = (list, display) => list.filter(s => s.activity === activity && s.displayId === display);
    const [b] = pick(before, from);
    if (!b || pick(before, from).length !== 1) return { kind: 'UNPROVEN', reason: 'source_instance' };
    const onFrom = pick(after, from), onTo = pick(after, to);
    const sameOn = list => list.some(s => s.session === b.session);
    if (onTo.length === 1 && sameOn(onTo) && onFrom.length === 0) return { kind: to === 0 ? 'PULLED_TO_PHYSICAL' : 'MOVED_TO_TARGET', taskId: onTo[0].taskId };
    if (onFrom.length === 1 && sameOn(onFrom) && onTo.length === 0) return { kind: from === 0 ? 'STAYED_ON_PHYSICAL' : 'STAYED_ON_TARGET', taskId: onFrom[0].taskId };
    if (onFrom.length === 1 && sameOn(onFrom) && onTo.length === 1 && !sameOn(onTo)) return { kind: to === 0 ? 'NEW_INSTANCE_ON_PHYSICAL' : 'NEW_INSTANCE_ON_TARGET', taskIds: [onFrom[0].taskId, onTo[0].taskId] };
    return { kind: 'UNPROVEN', reason: `from=${onFrom.length},to=${onTo.length}` };
}

function classifyIme(imeText, windowText, targetId) {
    const shownValues = [...String(imeText).matchAll(/\b(?:mInputShown|isInputShown|mImeShowing)=(true|false)\b/g)].map(m => m[1]);
    const shown = shownValues.length && shownValues.every(v => v === shownValues[0]) ? shownValues[0] === 'true' : null;
    if (shown === null) return { kind: 'IME_UNPROVEN', reason: shownValues.length ? 'conflicting_shown' : 'no_shown_field' };
    if (!shown) return { kind: 'IME_NOT_SHOWN' };
    const layering = [...String(windowText).matchAll(/mImeLayeringTarget in display# (\d+)/g)].map(m => Number(m[1]));
    let sections = [];
    try { sections = windowDisplaySections(windowText).filter(s => s.displayId !== null && /\bInputMethod\b/.test(s.text)).map(s => s.displayId); } catch { /* ambiguous dump */ }
    const candidates = [...new Set([...layering, ...sections])];
    if (candidates.length !== 1) return { kind: 'IME_UNPROVEN', reason: 'display', candidates };
    return { kind: candidates[0] === targetId ? 'IME_ON_TARGET' : candidates[0] === 0 ? 'IME_ON_PHYSICAL' : 'IME_UNPROVEN', displayId: candidates[0] };
}

function classifyPermission(windowText, targetId) {
    let sections;
    try { sections = windowDisplaySections(windowText); } catch { return { kind: 'UNPROVEN', reason: 'ambiguous_dump' }; }
    const hits = sections.filter(s => /GrantPermissionsActivity/.test(s.text)).map(s => s.displayId);
    if (!hits.length) return { kind: 'PERMISSION_NOT_SHOWN' };
    if (hits.length > 1) return { kind: 'UNPROVEN', reason: 'multiple', displays: hits };
    return { kind: hits[0] === targetId ? 'PERMISSION_ON_TARGET' : hits[0] === 0 ? 'PERMISSION_ON_PHYSICAL' : 'UNPROVEN', displayId: hits[0] };
}

async function runScenario(id, options, base, { EvidenceType, SessionType, pollMs }) {
    const e = new EvidenceType({ ...options, output: path.join(base, id) });
    const out = { scenario: id, status: 'RUNNING', classification: null, invariants: [], cleanup: { status: 'NOT_NEEDED', errors: [] }, writes: 0, errors: [] };
    let session, target, original;
    const fixture = async label => fixtureStates((await e.shell(`content query --uri content://${P.PACKAGE}.state/state`, label)).stdout);
    const topFocus = async label => C.parseTopFocused((await e.shell('dumpsys window | grep -E "^ *mTopFocusedDisplayId="', label + '-top')).stdout);
    const epochText = (await e.shell('date +%s.%N', 'device-epoch')).stdout.trim().replace(/^(\d+\.\d{3})\d*$/, '$1');
    const physicalOk = async (label, { causal }) => {
        const snap = await e.snapshot(label);
        const now = snap.displays.find(d => d.logicalId === 0);
        if (!now || now.uniqueId !== original.uniqueId || now.size.width !== original.size.width || now.size.height !== original.size.height) throw P.fail('PHYSICAL_IDENTITY_CHANGED');
        if (causal) {
            const check = C.physicalCheck(original, snap, { targetId: target.logicalId, topFocused: await topFocus(label) });
            if (!check.ok && !check.retry) throw P.fail('CAUSAL_' + check.code);
        }
        return snap;
    };
    try {
        const baseline = await e.snapshot('before');
        if (baseline.displays.length !== 1) throw P.fail('SINGLE_DISPLAY_REQUIRED');
        original = baseline.displays.find(d => d.logicalId === 0);
        if (!original?.uniqueId) throw P.fail('PHYSICAL_CONTEXT_UNPROVEN');
        await e.shell(`am force-stop ${P.PACKAGE}`, 'cold-fixture');
        session = new SessionType(e, null);
        out.session = await session.start();
        const created = await e.snapshot('created');
        target = P.newDisplay(baseline.displays, created.displays);
        P.requireFocusFlags(target);
        out.target = { logicalId: target.logicalId, uniqueId: target.uniqueId, generation: session.generation };
        const launch = async (component, display, label) => {
            const r = await e.shell(`am start --display ${display} -n ${component}`, label);
            if (/Error:|Exception/i.test(r.stdout + r.stderr)) throw P.fail('LAUNCH_FAILED_' + label);
            await pause(1500);
            return r.stdout.trim();
        };
        if (id === 'S1') {
            await launch(COMPONENT.main, target.logicalId, 'launch-1');
            const first = await fixture('state-1');
            await launch(COMPONENT.main, target.logicalId, 'launch-2');
            const second = await fixture('state-2');
            const onTarget = second.filter(s => s.displayId === target.logicalId);
            out.classification = { kind: onTarget.length === 1 && onTarget[0].session === first[0]?.session ? 'REUSED_INSTANCE' : onTarget.length > 1 ? 'NEW_INSTANCE' : 'UNPROVEN',
                instancesOnTarget: onTarget.length, newIntentCount: onTarget.map(s => s.newIntentCount), tasks: [...new Set(onTarget.map(s => s.taskId))] };
            if (second.some(s => s.displayId === 0)) out.invariants.push('FIXTURE_ON_PHYSICAL');
            await physicalOk('after-relaunch', { causal: true });
        } else if (id === 'S2' || id === 'S3') {
            const [from, to] = id === 'S2' ? [0, target.logicalId] : [target.logicalId, 0];
            await launch(COMPONENT.single, from, 'launch-from');
            const before = await fixture('state-from');
            await launch(COMPONENT.single, to, 'launch-to');
            const after = await fixture('state-to');
            await e.snapshot('after-migration');
            out.classification = classifyMigration(before, after, { from, to, activity: 'SingleTaskActivity' });
        } else if (id === 'S4') {
            await launch(COMPONENT.main, target.logicalId, 'launch');
            const [state] = (await fixture('state-before')).filter(s => s.displayId === target.logicalId);
            const b = state?.inputBounds;
            if (!b || !session.size || session.size.width !== target.size.width) throw P.fail('IME_TARGET_UNPROVEN');
            const point = { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) };
            out.writes++;
            for (const action of [ACTION_DOWN, ACTION_UP]) {
                await new Promise((resolve, reject) => session.control.write(encodeTouch({ action, ...point, ...session.size }), err => err ? reject(P.fail('CONTROL_WRITE_FAILED')) : resolve()));
                await pause(50);
            }
            await pause(1500);
            const [after] = (await fixture('state-after')).filter(s => s.displayId === target.logicalId);
            const ime = await e.shell('dumpsys input_method', 'ime-dump');
            const win = await e.shell('dumpsys window', 'window-dump');
            out.classification = { ...classifyIme(ime.stdout, win.stdout, target.logicalId), inputFocused: after?.inputFocused ?? null, touched: (after?.touchEventCount ?? 0) > (state.touchEventCount ?? 0) };
            if (!after || after.displayId !== target.logicalId) out.invariants.push('FIXTURE_LEFT_TARGET');
            await physicalOk('after-ime', { causal: true });
        } else if (id === 'S5') {
            await launch(COMPONENT.permission, target.logicalId, 'launch');
            await pause(1500);
            const win = await e.shell('dumpsys window displays', 'permission-window');
            out.classification = classifyPermission(win.stdout, target.logicalId);
            const states = await fixture('state');
            out.classification.permissionRequested = states.some(s => s.permissionRequested === true);
        }
        if (id === 'S1' || id === 'S4') {
            const log = await e.shell(`logcat -b events -d -v epoch -T ${epochText}`, 'events');
            const fixtureTasks = (await fixture('state-final')).map(s => s.taskId);
            const judged = C.judgeEvents(C.parseEvents(log.stdout), { targetId: target.logicalId, taskIds: fixtureTasks });
            e.write('events.json', judged);
            out.invariants.push(...judged.violations.map(v => v.code));
        }
        out.status = out.invariants.length ? 'FAILED' : 'PASSED';
    } catch (error) { out.errors.push(error.code || error.message); out.status = 'FAILED'; }
    finally {
        const step = async (label, action) => { try { await action(); } catch (error) { out.cleanup.errors.push(`${label}:${error.code || error.message}`); } };
        if (session) {
            await step('force-stop', () => e.shell(`am force-stop ${P.PACKAGE}`, 'cleanup-force-stop'));
            if (id === 'S5') await step('permission', async () => {
                await pause(800);
                const snap = await e.snapshot('permission-after-stop');
                const phys = snap.displays.find(d => d.logicalId === 0);
                if (/GrantPermissionsActivity/.test(phys?.focus || '')) {
                    await e.shell('input -d 0 keyevent 4', 'dismiss-permission-back');
                    out.cleanup.backSent = true;
                    await pause(800);
                }
                await e.shell(`pm revoke ${P.PACKAGE} android.permission.POST_NOTIFICATIONS`, 'permission-revoke', true);
                await e.shell(`pm clear-permission-flags ${P.PACKAGE} android.permission.POST_NOTIFICATIONS user-set user-fixed`, 'permission-flags', true);
            });
            await step('session', () => session.stop());
            await step('verify', async () => {
                const snap = await e.snapshot('cleaned');
                if (snap.displays.some(d => d.logicalId === target?.logicalId)) throw P.fail('TARGET_DISPLAY_REMAINS');
                const phys = snap.displays.find(d => d.logicalId === 0);
                if (!phys || phys.uniqueId !== original.uniqueId) throw P.fail('PHYSICAL_IDENTITY_CHANGED');
                if (/com\.vcpchat\.m4fixture\//.test(phys.focus) || /GrantPermissionsActivity/.test(phys.focus)) throw P.fail('RESIDUE_ON_PHYSICAL');
                const forwards = await e.command(options.adb, ['forward', '--list'], 'forwards-after');
                if (forwards.stdout.includes(`scrcpy_${session.scid}`)) throw P.fail('FORWARD_REMAINS');
            });
            out.cleanup.status = out.cleanup.errors.length ? 'FAILED' : 'PASSED';
        }
        if (out.cleanup.errors.length) out.status = 'FAILED';
        e.write('result.json', out);
    }
    return out;
}

async function runA5(options, { EvidenceType = Evidence, SessionType = Session, resolveServer = resolveServerArtifact, pollMs = 3000, log = console.log } = {}) {
    if (!options.useInstalledFixture) throw P.fail('A5_REQUIRES_INSTALLED_FIXTURE');
    const artifact = resolveServer({ ...options, mode: 'focus1' });
    options = { ...options, mode: 'focus1', serverArtifact: artifact };
    const root = path.resolve(options.output);
    fs.mkdirSync(root, { recursive: false });
    const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
    const files = [...SOURCES.map(n => path.join(__dirname, n)), options.apk, artifact.jar];
    write('freeze.json', { protocol: PROTOCOL, candidate: artifact.build?.candidate ?? null, allowPhysical: !!options.allowPhysical,
        hashes: Object.fromEntries(files.map(f => [f, sha(f)])) });
    const setup = new EvidenceType({ ...options, output: path.join(root, 'setup') });
    const remote = P.installedApkPath(await setup.shell(`pm path ${P.PACKAGE}`, 'fixture-path', true));
    if ((await setup.shell(`sha256sum ${remote}`, 'fixture-sha')).stdout.trim().split(/\s/)[0] !== sha(options.apk)) throw P.fail('INSTALLED_FIXTURE_MISMATCH');
    const results = [];
    for (const id of SCENARIOS) {
        if (PHYSICAL_SCENARIOS.has(id) && !options.allowPhysical) { results.push({ scenario: id, status: 'NOT_RUN', reason: 'PHYSICAL_NOT_ALLOWED' }); continue; }
        const r = await runScenario(id, options, root, { EvidenceType, SessionType, pollMs });
        results.push(r);
        log(JSON.stringify({ scenario: id, status: r.status, classification: r.classification?.kind ?? null, invariants: r.invariants, errors: r.errors, cleanup: r.cleanup.status }));
        if (r.cleanup.status === 'FAILED') break;
    }
    for (const id of SCENARIOS) if (!results.some(r => r.scenario === id)) results.push({ scenario: id, status: 'NOT_RUN', reason: 'STOPPED_AFTER_CLEANUP_FAILURE' });
    const summary = { protocol: PROTOCOL, finishedAt: new Date().toISOString(), results: results.map(r => ({ scenario: r.scenario, status: r.status, classification: r.classification ?? null, invariants: r.invariants ?? [], errors: r.errors ?? [], cleanup: r.cleanup?.status ?? null, reason: r.reason })),
        sourceChanged: files.filter(f => sha(f) !== JSON.parse(fs.readFileSync(path.join(root, 'freeze.json'), 'utf8')).hashes[f]) };
    summary.status = summary.results.every(r => r.status === 'PASSED' || r.status === 'NOT_RUN') && !summary.sourceChanged.length ? 'PASSED' : 'FAILED';
    write('summary.json', summary);
    return summary;
}

function parseA5Args(argv) {
    if (argv.indexOf('--allow-physical') !== argv.lastIndexOf('--allow-physical')) throw P.fail('INVALID_OPTION');
    const options = P.parseArgs([...argv.filter(a => a !== '--allow-physical'), '--mode', 'focus1']);
    if (argv.includes('--allow-physical')) options.allowPhysical = true;
    if (!options.useInstalledFixture) throw P.fail('A5_REQUIRES_INSTALLED_FIXTURE');
    return options;
}

if (require.main === module) {
    runA5(parseA5Args(process.argv.slice(2))).then(s => { console.log(JSON.stringify(s, null, 2)); process.exitCode = s.status === 'PASSED' ? 0 : 1; })
        .catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
module.exports = { fixtureStates, classifyMigration, classifyIme, classifyPermission, runA5, parseA5Args, SCENARIOS };
