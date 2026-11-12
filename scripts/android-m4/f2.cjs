'use strict';

// Research-only M4-F2 probe: A3 shell semantic tree on a virtual display, A4 scrcpy control-socket touch.
// Frozen protocol: f2-protocol.md. Reuses the F1 candidate server and the exact preinstalled fixture.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./protocol.cjs');
const { Evidence, Session, waitUntil, resolveServerArtifact } = require('./probe.cjs');
const { executeMatrix } = require('./focus-matrix.cjs');
const C = require('./causal.cjs');

const PROTOCOL = 'M4-F2';
const protocolId = options => options.criterion === 'causal' ? 'M4-F3' + (options.a3Windows ? 'W' : '') : PROTOCOL + (options.a3Windows ? 'W' : '');
// F3 pins only the physical display identity; its focused window belongs to the user.
function physicalIdentity(infos) {
    const found = infos.filter(d => d.logicalId === 0);
    if (found.length !== 1 || !found[0].uniqueId) throw P.fail('PHYSICAL_CONTEXT_UNPROVEN');
    return found[0];
}
const BUTTON_ID = `${P.PACKAGE}:id/tap_button`;
const ACTION_DOWN = 0, ACTION_UP = 1;
const POINTER_GENERIC_FINGER = -2n;
const TYPE_INJECT_TOUCH_EVENT = 2;
const SOURCES = ['f2.cjs', 'f2-protocol.md', 'f3-protocol.md', 'causal.cjs', 'probe.cjs', 'protocol.cjs', 'focus-matrix.cjs'];
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function encodeTouch({ action, x, y, width, height }) {
    if (action !== ACTION_DOWN && action !== ACTION_UP) throw P.fail('CONTROL_ACTION_INVALID');
    for (const v of [width, height]) if (!Number.isSafeInteger(v) || v < 1 || v > 0xffff) throw P.fail('CONTROL_SCREEN_INVALID');
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw P.fail('CONTROL_POSITION_INVALID');
    const b = Buffer.alloc(32);
    b.writeUInt8(TYPE_INJECT_TOUCH_EVENT, 0);
    b.writeUInt8(action, 1);
    b.writeBigInt64BE(POINTER_GENERIC_FINGER, 2);
    b.writeInt32BE(x, 10);
    b.writeInt32BE(y, 14);
    b.writeUInt16BE(width, 18);
    b.writeUInt16BE(height, 20);
    b.writeUInt16BE(action === ACTION_DOWN ? 0xffff : 0, 22);
    b.writeInt32BE(0, 24);
    b.writeInt32BE(0, 28);
    return b;
}

const decode = value => value.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function attributes(body) {
    const out = {};
    for (const m of body.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = decode(m[2]);
    return out;
}

// Display attribution comes only from explicit <display id> or window display-id groupings, never from bounds.
function classifyDump(result, targetId, state) {
    const text = result.stdout || '';
    if (result.code === 0 && /<(hierarchy|displays)\b[^>]*\/>/.test(text) && !/<node\b/.test(text)) return { kind: 'EMPTY' };
    const multi = text.indexOf('<displays');
    const start = multi >= 0 ? multi : text.indexOf('<hierarchy');
    const end = multi >= 0 ? text.lastIndexOf('</displays>') : text.lastIndexOf('</hierarchy>');
    if (result.code !== 0 || start < 0 || end < start) return { kind: 'DUMP_FAILED', code: result.code };
    const xml = text.slice(start, end);
    if (!/<node\b/.test(xml)) return { kind: 'EMPTY' };
    const stack = [];
    let grouped = false;
    const matches = [];
    for (const m of xml.matchAll(/<(\/?)(display|window|node)\b([^>]*?)(\/?)>/g)) {
        const [, close, name, body, selfClosing] = m;
        if (name === 'display' || name === 'window') {
            if (close) { stack.pop(); continue; }
            const raw = attributes(body)[name === 'display' ? 'id' : 'display-id'];
            let value = stack.length ? stack[stack.length - 1] : null;
            if (raw !== undefined) { grouped = true; value = /^\d+$/.test(raw) ? Number(raw) : NaN; }
            if (!selfClosing) stack.push(value);
            continue;
        }
        if (close) continue;
        const a = attributes(body);
        const own = a['display-id'];
        if (own !== undefined) grouped = true;
        const display = own !== undefined ? (/^\d+$/.test(own) ? Number(own) : NaN) : (stack.length ? stack[stack.length - 1] : null);
        if (a['resource-id'] === BUTTON_ID) matches.push({ text: a.text, bounds: a.bounds, display });
    }
    if (!matches.length) return { kind: 'ABSENT', grouped };
    if (matches.length > 1) return { kind: 'AMBIGUOUS', grouped, count: matches.length };
    const node = matches[0], b = state.buttonBounds;
    const evidence = { grouped, display: node.display, text: node.text, bounds: node.bounds,
        expectedText: `M4 TAP ${state.taps}`, expectedBounds: `[${b.left},${b.top}][${b.right},${b.bottom}]` };
    if (node.display !== null && node.display !== targetId) return { kind: 'WRONG_DISPLAY', ...evidence };
    if (node.text !== evidence.expectedText || node.bounds !== evidence.expectedBounds) return { kind: 'MISMATCHED', ...evidence };
    return { kind: node.display === targetId ? 'ATTRIBUTED' : 'UNATTRIBUTED', ...evidence };
}
function a3Status(before, after) {
    if (before === 'ATTRIBUTED' && after === 'ATTRIBUTED') return 'PASSED';
    const usable = new Set(['ATTRIBUTED', 'UNATTRIBUTED']);
    return usable.has(before) && usable.has(after) ? 'PARTIAL' : 'NOT_SUPPORTED';
}

function sendControl(session, buffer) {
    return new Promise((resolve, reject) => {
        if (!session.control || session.error) return reject(P.fail('CONTROL_SOCKET_UNAVAILABLE'));
        session.control.write(buffer, error => error ? reject(P.fail('CONTROL_WRITE_FAILED')) : resolve());
    });
}

function frozenFiles(options, artifact) {
    return [...SOURCES.map(name => path.join(__dirname, name)), options.apk, options.ffmpeg, artifact.jar];
}

async function runF2(options, { EvidenceType = Evidence, SessionType = Session, resolveServer = resolveServerArtifact, pollMs = 3000,
    CarrierType = require('../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server').UiServer } = {}) {
    if (options.mode !== 'focus1' || !options.useInstalledFixture) throw P.fail('F2_REQUIRES_FOCUS1_INSTALLED_FIXTURE');
    const serverArtifact = resolveServer(options);
    options = { ...options, serverArtifact };
    for (const file of [options.adb, options.apk, options.ffmpeg, serverArtifact.jar]) {
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw P.fail('LOCAL_DEPENDENCY_MISSING_' + file);
    }
    const e = new EvidenceType(options);
    const abort = () => { e.cancelled = true; };
    process.on('SIGINT', abort); process.on('SIGTERM', abort);
    const causal = options.criterion === 'causal';
    const result = { protocol: protocolId(options), serial: options.serial, startedAt: new Date().toISOString(), status: 'RUNNING',
        candidate: serverArtifact.build?.candidate ?? null, gates: { A3: 'NOT_RUN', A3_CARRIER: 'NOT_RUN', A4: 'NOT_RUN' },
        a3: {}, control: 'NOT_SENT', cleanup: { status: 'NOT_NEEDED', errors: [] }, writes: 0, errors: [],
        criterion: causal ? 'causal' : 'frozen-physical', external: [] };
    let baseline, session, target, original, epoch = null, carrier = null;
    result.perf = {};
    const taskIds = new Set();
    const topFocus = async label => C.parseTopFocused((await e.shell('dumpsys window | grep -E "^ *mTopFocusedDisplayId="', label + '-top')).stdout);
    // F3: physical identity must hold; a focus change is accepted only when WM events do not tie it to our session.
    const causalSnapshot = async (label, { requireCoverage = false } = {}) => {
        let snap, check;
        for (let attempt = 0; ; attempt++) {
            snap = await e.snapshot(attempt ? `${label}-retry${attempt}` : label);
            check = C.physicalCheck(original, snap, { targetId: target?.logicalId ?? -1, topFocused: await topFocus(label) });
            if (check.ok || !check.retry || attempt >= 4) break;
            await pause(500);
        }
        if (!check.ok) throw P.fail('CAUSAL_' + check.code);
        if (check.changed) result.external.push({ stage: label, focus: check.focus });
        if (taskIds.size) {
            const log = await e.shell(`logcat -b events -d -v epoch -T ${epoch}`, label + '-events');
            const judged = C.judgeEvents(C.parseEvents(log.stdout), { targetId: target.logicalId, taskIds: [...taskIds] });
            e.write(label + '-events.json', judged);
            if (judged.violations.length) throw P.fail('CAUSAL_' + judged.violations[0].code);
            if (requireCoverage && !judged.coverage) throw P.fail('CAUSAL_LOGCAT_WINDOW_UNPROVEN');
            result.externalEvents = judged.external;
        }
        return snap;
    };
    try {
        e.write('input-hashes.json', Object.fromEntries(frozenFiles(options, serverArtifact).map(file => [file, sha(file)])));
        for (const name of SOURCES) e.write('source-' + name, fs.readFileSync(path.join(__dirname, name)));
        if (serverArtifact.build) e.write('server-build.json', serverArtifact.build);
        const devices = await e.command(options.adb, ['devices', '-l'], 'devices');
        if (!devices.stdout.split(/\r?\n/).some(line => line.startsWith(options.serial + ' ') && /\sdevice\s/.test(line))) throw P.fail('DEVICE_NOT_ONLINE');
        await e.shell('getprop ro.build.fingerprint', 'build-fingerprint');
        const sdk = (await e.shell('getprop ro.build.version.sdk', 'sdk')).stdout.trim();
        if (!/^\d+$/.test(sdk) || Number(sdk) < 34) throw P.fail('FOCUS_FLAG_PLATFORM_UNSUPPORTED');
        baseline = await e.snapshot('before');
        result.baseline = baseline;
        original = causal ? physicalIdentity(baseline.displays) : P.physical(baseline.displays);
        if (baseline.displays.length !== 1 || (!causal && baseline.wakefulness !== 'Awake')) throw P.fail('SINGLE_AWAKE_DISPLAY_REQUIRED');
        const policy = await e.shell('dumpsys window policy', 'keyguard');
        const unlocked = /^\s*(?:showing|mIsShowing)=false\s*$/m.test(policy.stdout) && /^\s*(?:inputRestricted|mInputRestricted)=false\s*$/m.test(policy.stdout)
            && !/^\s*(?:showing|mIsShowing|inputRestricted|mInputRestricted)=true\s*$/m.test(policy.stdout);
        result.physicalAtStart = { wakefulness: baseline.wakefulness, unlocked };
        if (!causal && !unlocked) throw P.fail('UNLOCKED_DEVICE_REQUIRED');
        const processes = await e.shell('ps -A -o PID,ARGS', 'preflight-processes');
        if (/com\.genymobile\.scrcpy\.Server|com\.github\.uiautomator2|com\.wetest\.uia|com\.vcpchat\.(uiautomator|validation)|uiautomator dump/.test(processes.stdout)) throw P.fail('OTHER_AUTOMATION_ACTIVE');
        if ((await e.shell('settings get global overlay_display_devices', 'overlay-before')).stdout.trim() !== 'null') throw P.fail('EXISTING_OVERLAY_SETTING');
        const remoteApk = P.installedApkPath(await e.shell(`pm path ${P.PACKAGE}`, 'fixture-before', true));
        if ((await e.shell(`sha256sum ${remoteApk}`, 'installed-fixture-hash')).stdout.trim().split(/\s/)[0] !== sha(options.apk)) throw P.fail('INSTALLED_FIXTURE_MISMATCH');
        result.fixtureSource = 'EXACT_INSTALLED_APK_PRESERVED';

        const assertTarget = snap => {
            if (!P.sameTarget(target, snap.displays) || session.error) throw P.fail('TARGET_SESSION_CHANGED');
            P.requireFocusFlags(snap.displays.find(d => d.logicalId === target.logicalId));
        };
        const assertContext = (snap, stage) => {
            if (!P.samePhysical(original, P.physical(snap.displays)) || snap.wakefulness !== baseline.wakefulness) throw P.fail('PHYSICAL_CONTEXT_CHANGED_ON_' + stage);
            assertTarget(snap);
        };
        // Frozen-physical (F1/F2) samples once; causal (F3) samples, retries transient null focus and judges WM events.
        const sample = async (label, stage, opts) => {
            if (!causal) { const snap = await e.snapshot(label); assertContext(snap, stage); return snap; }
            const snap = await causalSnapshot(label, opts); assertTarget(snap); return snap;
        };
        if (causal) epoch = (await e.shell('date +%s.%N', 'device-epoch')).stdout.trim().replace(/^(\d+\.\d{3})\d*$/, '$1');
        if (causal && !/^\d+\.\d{3}$/.test(epoch)) throw P.fail('DEVICE_EPOCH_UNPROVEN');
        result.gates.A4 = 'RUNNING';
        session = new SessionType(e, null);
        result.session = await session.start();
        const created = causal ? await causalSnapshot('created') : await e.snapshot('created');
        target = P.newDisplay(baseline.displays, created.displays);
        result.target = { ...target, generation: session.generation };
        causal ? assertTarget(created) : assertContext(created, 'CREATE');
        e.check();
        const framesBeforeLaunch = session.frames;
        const launched = await e.shell(`am start --display ${target.logicalId} -n ${P.PACKAGE}/.MainActivity`, 'launch-fixture');
        if (/Error:|Exception|Warning: Activity not started/i.test(launched.stdout + launched.stderr)) throw P.fail('FIXTURE_LAUNCH_FAILED');
        const query = async () => P.fixtureState((await e.shell(`content query --uri content://${P.PACKAGE}.state/state`, 'fixture-state')).stdout, target.logicalId);
        const before = await waitUntil(async () => {
            try { return await query(); }
            catch (error) { if (['FIXTURE_UNREADABLE', 'FIXTURE_AMBIGUOUS', 'FIXTURE_STATE_UNPROVEN'].includes(error.code)) return false; throw error; }
        }, 5000, 'FIXTURE_READY_TIMEOUT', e);
        result.fixtureBefore = before;
        taskIds.add(before.taskId);
        result.video = await session.image(framesBeforeLaunch);
        await sample('ready', 'LAUNCH', { requireCoverage: true });

        // Resident production carrier (u2 server): same classifier, no JVM cold start per dump.
        const carrierDump = async (phase, state) => {
            e.check();
            const startedAt = Date.now();
            let raw;
            try { raw = { code: 0, stdout: (await carrier.dump({ compressed: false, rootInActive: false, timeoutMs: 8000 })).xml }; }
            catch (error) { raw = { code: 1, stdout: '', error: error.code || error.message }; }
            (result.perf.carrierMs ||= []).push(Date.now() - startedAt);
            e.write(`a3-carrier-${phase}.xml`, raw.stdout);
            const classified = { ...classifyDump(raw, target.logicalId, state), ...(raw.error ? { error: raw.error } : {}) };
            e.write(`a3-carrier-${phase}.json`, classified);
            const unchanged = await query();
            if (unchanged.session !== state.session || unchanged.taps !== state.taps || unchanged.taskId !== state.taskId) throw P.fail('A3_CARRIER_CHANGED_TARGET');
            await sample('after-carrier-' + phase, 'DUMP');
            return classified;
        };
        const dump = async (phase, state) => {
            e.check();
            const cliStartedAt = Date.now();
            const raw = await e.adb(['exec-out', options.a3Windows ? 'uiautomator dump --windows /dev/tty' : 'uiautomator dump --compressed /dev/tty'], 'a3-dump-' + phase, true);
            (result.perf.cliMs ||= []).push(Date.now() - cliStartedAt);
            const classified = classifyDump(raw, target.logicalId, state);
            e.write(`a3-${phase}.json`, classified);
            const unchanged = await query();
            if (unchanged.session !== state.session || unchanged.taps !== state.taps || unchanged.taskId !== state.taskId) throw P.fail('A3_DUMP_CHANGED_TARGET');
            await sample('after-dump-' + phase, 'DUMP');
            return classified;
        };
        // UiAutomation is single-owner: with the resident carrier the shell CLI dump silently returns nothing (F3W-q2).
        if (options.a3Carrier) result.gates.A3 = 'NOT_RUN_CARRIER_EXCLUSIVE';
        else { result.gates.A3 = 'RUNNING'; result.a3.before = await dump('before', before); }
        if (options.a3Carrier) {
            result.gates.A3_CARRIER = 'RUNNING';
            carrier = new CarrierType({ adbPath: options.adb, serial: options.serial });
            const startedAt = Date.now();
            const started = await carrier.start();
            result.perf.carrierStartMs = Date.now() - startedAt;
            e.write('carrier-start.json', { ...started, identity: carrier.carrierIdentity ?? null });
            if (!started?.ok) { result.a3.carrierStart = started?.reason || 'START_FAILED'; result.gates.A3_CARRIER = 'NOT_SUPPORTED'; }
            else {
                // F3W-m20 qualification: first dump 13ms after start was `<hierarchy rotation="0" />`. Readiness, not attribution.
                const readyAt = Date.now();
                let attempts = 0;
                await waitUntil(async () => {
                    attempts++;
                    try { return /<node\b/.test((await carrier.dump({ compressed: false, rootInActive: false, timeoutMs: 4000 })).xml); }
                    catch { return false; }
                }, 5000, 'A3_CARRIER_NEVER_READY', e);
                result.perf.carrierReadyMs = Date.now() - readyAt;
                result.perf.carrierReadyAttempts = attempts;
                await sample('after-carrier-start', 'DUMP');
                result.a3.carrierBefore = await carrierDump('before', before);
                // Warm-path latency sample; state is unchanged so attribution must repeat.
                for (let i = 0; i < 4; i++) await carrierDump('warm' + i, before);
            }
        }

        const point = P.buttonCenter(before, target);
        if (!session.size || session.size.width !== target.size.width || session.size.height !== target.size.height) throw P.fail('CONTROL_GEOMETRY_MISMATCH');
        const messages = [ACTION_DOWN, ACTION_UP].map(action => encodeTouch({ action, ...point, ...session.size }));
        e.write('control-sent.json', { point, size: session.size, messages: messages.map(m => m.toString('hex')) });
        e.check();
        result.writes++;
        result.control = 'PARTIAL';
        await sendControl(session, messages[0]);
        await pause(50);
        await sendControl(session, messages[1]);
        result.control = 'DISPATCHED';
        // No touch ACK exists; read back only, never resend.
        const after = await waitUntil(async () => { const s = await query(); return s.taps !== before.taps ? s : false; }, pollMs, 'CONTROL_TAP_UNPROVEN', e);
        result.fixtureAfter = after;
        if (!P.verifyTap(before, after)) throw P.fail('CONTROL_TAP_UNPROVEN');
        await sample('after-control', 'CONTROL');
        result.gates.A4 = 'CONTROL_TOUCH_PASSED';

        if (!options.a3Carrier) {
            result.a3.after = await dump('after', after);
            result.gates.A3 = a3Status(result.a3.before.kind, result.a3.after.kind);
        }
        if (result.gates.A3_CARRIER === 'RUNNING') {
            result.a3.carrierAfter = await carrierDump('after', after);
            result.gates.A3_CARRIER = a3Status(result.a3.carrierBefore.kind, result.a3.carrierAfter.kind);
        }
        if (options.a3Carrier && result.gates.A3_CARRIER !== 'PASSED') throw P.fail('A3_CARRIER_' + result.gates.A3_CARRIER);
        result.status = 'PASSED';
    } catch (error) { result.errors.push(error.code || error.message); result.status = 'FAILED'; }
    finally {
        const cleanup = async action => { try { await action(); } catch (error) { result.cleanup.errors.push(error.code || error.message); } };
        if (carrier) await cleanup(async () => {
            const owner = await carrier.stop();
            e.write('carrier-stop.json', owner || null);
            if (owner && owner.status && owner.status !== 'released') throw P.fail('CARRIER_OWNER_NOT_RELEASED');
            const ps = await e.shell('ps -A -o PID,ARGS', 'carrier-processes-after');
            if (/com\.github\.uiautomator2|com\.vcpchat\.uiautomator\.Owner/.test(ps.stdout)) throw P.fail('CARRIER_PROCESS_REMAINS');
        });
        if (session) {
            await cleanup(() => session.stop());
            await cleanup(async () => {
                let after;
                if (causal) {
                    after = await causalSnapshot('cleaned');
                    if (after.displays.some(d => d.logicalId === target?.logicalId)) throw P.fail('TARGET_DISPLAY_REMAINS');
                    result.cleanup.physicalRestored = true;
                } else {
                    after = await e.snapshot('cleaned');
                    result.cleanup.physicalRestored = P.samePhysical(P.physical(baseline.displays), P.physical(after.displays)) && baseline.wakefulness === after.wakefulness;
                }
                result.cleanup.displays = after.displays;
                if (after.displays.length !== baseline.displays.length || !result.cleanup.physicalRestored) throw P.fail('DEVICE_RESTORE_UNPROVEN');
                const forwards = await e.command(options.adb, ['forward', '--list'], 'forwards-after');
                if (session.scid && forwards.stdout.split(/\r?\n/).some(line => {
                    const parts = line.trim().split(/\s+/);
                    return parts[0] === options.serial && parts[2] === `localabstract:scrcpy_${session.scid}`;
                })) throw P.fail('FORWARD_REMAINS');
            });
            result.cleanup.status = result.cleanup.errors.length ? 'FAILED' : 'PASSED';
        }
        if (result.cleanup.errors.length) result.status = 'FAILED';
        if (result.status === 'FAILED') for (const key of ['A3', 'A3_CARRIER', 'A4']) if (result.gates[key] === 'RUNNING') result.gates[key] = 'FAILED';
        result.finishedAt = new Date().toISOString();
        e.write('result.json', result);
        process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    }
    return result;
}

// Physical baseline is pinned to the qualification before every case, like the F1 matrix.
function pinnedEvidence(expected, BaseEvidence = Evidence, causal = false) {
    return class PinnedEvidence extends BaseEvidence {
        async snapshot(label) {
            const value = await super.snapshot(label);
            if (label !== 'before') return value;
            if (causal) {
                const now = value.displays.length === 1 ? physicalIdentity(value.displays) : null;
                if (!now || now.uniqueId !== expected.uniqueId || now.size.width !== expected.size.width || now.size.height !== expected.size.height) throw P.fail('F3_PHYSICAL_IDENTITY_CHANGED');
                return value;
            }
            if (value.displays.length !== 1 || value.wakefulness !== 'Awake'
                || !P.samePhysical(expected, P.physical(value.displays))) throw P.fail('F2_PHYSICAL_BASELINE_CHANGED');
            return value;
        }
    };
}

async function coldFixture(setup, apk) {
    const remote = P.installedApkPath(await setup.shell('pm path ' + P.PACKAGE, 'fixture-path', true));
    if ((await setup.shell('sha256sum ' + remote, 'fixture-sha')).stdout.trim().split(/\s/)[0] !== sha(apk)) throw P.fail('FIXTURE_IDENTITY_CHANGED');
    await setup.shell('am force-stop ' + P.PACKAGE, 'cold-fixture');
    const absent = await setup.shell('pidof ' + P.PACKAGE, 'fixture-process-absent', true);
    if (absent.code !== 1 || absent.stdout.trim() || absent.stderr.trim()) throw P.fail('FIXTURE_COLD_START_UNPROVEN');
}

async function campaign(options, { EvidenceType = Evidence, run = runF2, resolveServer = resolveServerArtifact, log = console.log } = {}) {
    const root = path.resolve(options.output);
    fs.mkdirSync(root, { recursive: false });
    const artifact = resolveServer(options);
    const frozen = Object.fromEntries(frozenFiles(options, artifact).map(file => [file, sha(file)]));
    const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
    const causal = options.criterion === 'causal';
    write('freeze.json', { protocol: protocolId(options), candidate: artifact.build?.candidate ?? null, planned: 20, hashes: frozen });
    const startedAt = new Date().toISOString();
    const qSetup = new EvidenceType({ ...options, output: path.join(root, 'setup-qualification') });
    const qBefore = await qSetup.snapshot('before');
    if (qBefore.displays.length !== 1 || (!causal && qBefore.wakefulness !== 'Awake')) throw P.fail('SINGLE_AWAKE_DISPLAY_REQUIRED');
    const expected = causal ? physicalIdentity(qBefore.displays) : P.physical(qBefore.displays);
    await coldFixture(qSetup, options.apk);
    const Pinned = pinnedEvidence(expected, EvidenceType, causal);
    const qualification = await run({ ...options, output: path.join(root, 'qualification') }, { EvidenceType: Pinned, resolveServer });
    log(JSON.stringify({ protocol: protocolId(options), qualification: qualification.status, a3: options.a3Carrier ? qualification.gates.A3_CARRIER : qualification.gates.A3, a4: qualification.gates.A4, errors: qualification.errors }));
    const a3 = {};
    let rows = Array.from({ length: 20 }, (_, i) => ({ case: i + 1, status: 'NOT_RUN' }));
    if (qualification.status === 'PASSED') {
        rows = await executeMatrix({
            check: async () => { for (const [file, digest] of Object.entries(frozen)) if (sha(file) !== digest) throw P.fail('FROZEN_SOURCE_CHANGED'); },
            execute: async number => {
                const label = String(number).padStart(2, '0');
                const setup = new Pinned({ ...options, output: path.join(root, 'setup-' + label) });
                await setup.snapshot('before');
                await coldFixture(setup, options.apk);
                const result = await run({ ...options, output: path.join(root, 'case-' + label) }, { EvidenceType: Pinned, resolveServer });
                a3[number] = options.a3Carrier ? result.gates.A3_CARRIER : result.gates.A3;
                log(JSON.stringify({ case: number, status: result.status, a3: result.gates.A3, a4: result.gates.A4, displayId: result.target?.logicalId, errors: result.errors, cleanup: result.cleanup.status, external: result.external?.length || 0 }));
                return result;
            },
            save: async current => write('progress.json', current.map(row => ({ ...row, a3: a3[row.case] ?? 'NOT_RUN' }))),
        });
    }
    const a3Counts = {};
    for (const row of rows) { const k = a3[row.case] ?? 'NOT_RUN'; a3Counts[k] = (a3Counts[k] || 0) + 1; }
    const summary = { protocol: protocolId(options), candidate: artifact.build?.candidate ?? null, startedAt, finishedAt: new Date().toISOString(),
        qualification: { status: qualification.status, a3: options.a3Carrier ? qualification.gates.A3_CARRIER : qualification.gates.A3, a4: qualification.gates.A4, errors: qualification.errors },
        planned: 20, pass: rows.filter(r => r.status === 'PASSED').length, fail: rows.filter(r => r.status === 'FAILED').length,
        notRun: rows.filter(r => r.status === 'NOT_RUN').length, a3Counts,
        sourceChanged: Object.entries(frozen).filter(([file, digest]) => sha(file) !== digest).map(([file]) => file),
        rows: rows.map(row => ({ ...row, a3: a3[row.case] ?? 'NOT_RUN' })) };
    summary.status = qualification.status === 'PASSED' && summary.pass === 20 && !summary.sourceChanged.length ? 'PASSED' : 'FAILED';
    write('summary.json', summary);
    return summary;
}

function parseF2Args(argv) {
    for (const flag of ['--campaign', '--a3-windows', '--a3-carrier', '--criterion']) if (argv.indexOf(flag) !== argv.lastIndexOf(flag)) throw P.fail('INVALID_OPTION');
    const isCampaign = argv.includes('--campaign');
    const ci = argv.indexOf('--criterion');
    let criterion;
    if (ci >= 0) { criterion = argv[ci + 1]; if (criterion !== 'causal') throw P.fail('INVALID_CRITERION'); }
    const rest = argv.filter((a, i) => !['--campaign', '--a3-windows', '--a3-carrier'].includes(a) && (ci < 0 || (i !== ci && i !== ci + 1)));
    const options = P.parseArgs([...rest, '--mode', 'focus1']);
    if (argv.includes('--a3-windows')) options.a3Windows = true;
    if (argv.includes('--a3-carrier')) options.a3Carrier = true;
    if (criterion) options.criterion = criterion;
    if (!options.useInstalledFixture) throw P.fail('F2_REQUIRES_FOCUS1_INSTALLED_FIXTURE');
    return { options, isCampaign };
}

if (require.main === module) {
    (async () => {
        const { options, isCampaign } = parseF2Args(process.argv.slice(2));
        const result = isCampaign ? await campaign(options) : await runF2(options);
        console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
        process.exitCode = result.status === 'PASSED' ? 0 : 1;
    })().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
module.exports = { encodeTouch, classifyDump, a3Status, runF2, campaign, parseF2Args, pinnedEvidence, protocolId, ACTION_DOWN, ACTION_UP };
