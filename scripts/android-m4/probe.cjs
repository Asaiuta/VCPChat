'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { StreamParser, LOCAL_JAR } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub');
const P = require('./protocol.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function resolveServerArtifact(options) {
    if (options.mode !== 'focus1') return { jar: LOCAL_JAR };
    const directory = path.join(__dirname, '../android-m4-focus-server/.build');
    const jar = path.join(directory, 'scrcpy-server-focus1.jar');
    const build = JSON.parse(fs.readFileSync(path.join(directory, 'build-evidence.json'), 'utf8'));
    P.validateFocusBuild(build, sha(jar));
    return { jar, build };
}

class Evidence {
    constructor(options) {
        this.options = options;
        this.output = path.resolve(options.output);
        fs.mkdirSync(this.output, { recursive: false });
        this.index = 0;
        this.commands = [];
        this.cancelled = false;
    }
    write(name, value) { fs.writeFileSync(path.join(this.output, name), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n'); }
    async command(file, args, label, allowFailure = false) {
        const prefix = `${String(++this.index).padStart(3, '0')}-${label}`;
        const startedAt = new Date().toISOString();
        const result = await new Promise(resolve => cp.execFile(file, args,
            { encoding: 'utf8', timeout: 12000, maxBuffer: 12 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => resolve({ code: error ? error.code ?? null : 0, signal: error?.signal || null, stdout, stderr, error: error?.message || null })));
        this.write(`${prefix}.stdout.txt`, result.stdout);
        this.write(`${prefix}.stderr.txt`, result.stderr);
        this.commands.push({ file, args, label, startedAt, finishedAt: new Date().toISOString(), code: result.code,
            signal: result.signal, error: result.error, stdout: `${prefix}.stdout.txt`, stderr: `${prefix}.stderr.txt` });
        this.write('commands.json', this.commands);
        if (!allowFailure && result.code !== 0) {
            throw Object.assign(P.fail('COMMAND_FAILED_' + label), { transport: { code: result.code, signal: result.signal } });
        }
        return result;
    }
    adb(args, label, allowFailure = false) { return this.command(this.options.adb, ['-s', this.options.serial, ...args], label, allowFailure); }
    async shell(command, label, allowFailure = false) { return this.adb(['shell', command], label, allowFailure); }
    async snapshot(label) {
        const window = await this.shell('dumpsys window displays', label + '-window');
        const display = await this.shell('dumpsys display', label + '-display');
        const sf = await this.shell('dumpsys SurfaceFlinger --display-id', label + '-sf');
        const power = await this.shell('dumpsys power', label + '-power');
        const states = [...power.stdout.matchAll(/^\s*mWakefulness=(Awake|Asleep|Dozing|Dreaming)\s*$/gm)].map(m => m[1]);
        if (states.length !== 1) throw P.fail('POWER_STATE_UNPROVEN');
        const result = { displays: P.inventory(window.stdout, display.stdout, sf.stdout), wakefulness: states[0] };
        this.write(label + '.json', result);
        return result;
    }
    check() { if (this.cancelled) throw P.fail('PROBE_CANCELLED'); }
}

async function waitUntil(check, timeoutMs, code, evidence) {
    const deadline = Date.now() + timeoutMs;
    do {
        evidence?.check();
        const value = await check();
        if (value) return value;
        await pause(100);
    } while (Date.now() < deadline);
    throw P.fail(code);
}

// Both sockets must connect before the server emits device metadata/video.
class Session {
    constructor(evidence, displayId, { spawn = cp.spawn } = {}) {
        this.e = evidence;
        this.displayId = displayId;
        this.scid = crypto.randomInt(0x80000000).toString(16).padStart(8, '0');
        this.generation = crypto.randomUUID();
        this.remoteJar = `/data/local/tmp/vcp-m4-${this.scid}.jar`;
        this.port = null;
        this.proc = null;
        this.video = null;
        this.control = null;
        this.frames = 0;
        this.bytes = 0;
        this.size = null;
        this.error = null;
        this.stopping = false;
        this.chunks = [];
        this.log = '';
        this.jarAttempted = false;
        this.forwardAttempted = false;
        this.spawn = spawn;
        this.localJar = evidence.options.serverArtifact?.jar || LOCAL_JAR;
    }
    async start() {
        this.jarAttempted = true;
        await this.e.adb(['push', this.localJar, this.remoteJar], 'push-scrcpy');
        const remote = await this.e.shell(`sha256sum ${this.remoteJar}`, 'scrcpy-hash');
        if (remote.stdout.trim().split(/\s/)[0] !== sha(this.localJar)) throw P.fail('REMOTE_JAR_MISMATCH');
        this.forwardAttempted = true;
        const forward = await this.e.adb(['forward', 'tcp:0', `localabstract:scrcpy_${this.scid}`], 'forward');
        this.port = Number(forward.stdout.trim());
        if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw P.fail('FORWARD_PORT_INVALID');
        const command = `CLASSPATH=${this.remoteJar} app_process / com.genymobile.scrcpy.Server ${P.serverOptions(this.scid, this.displayId).join(' ')}`;
        this.e.write('session.json', { scid: this.scid, generation: this.generation, port: this.port, remoteJar: this.remoteJar, command });
        this.proc = this.spawn(this.e.options.adb, ['-s', this.e.options.serial, 'shell', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const append = chunk => { this.log += chunk.toString(); this.e.write('scrcpy.log', this.log); };
        this.proc.stdout.on('data', append);
        this.proc.stderr.on('data', append);
        this.proc.on('error', error => { this.error = error.message; });
        this.proc.on('exit', (code, signal) => { this.exit = { code, signal }; if (!this.stopping) this.error = `SERVER_EXIT_${code}`; });
        await waitUntil(async () => {
            if (this.error) throw P.fail(this.error);
            return (await this.e.shell('cat /proc/net/unix', 'socket-ready')).stdout.includes(`@scrcpy_${this.scid}`);
        }, 8000, 'REMOTE_SOCKET_TIMEOUT', this.e);
        const parser = new StreamParser({
            onSession: (width, height) => { this.size = { width, height }; },
            onConfig: data => this.record(data),
            onFrame: data => { this.record(data); this.frames++; },
        });
        this.video = net.createConnection({ host: '127.0.0.1', port: this.port });
        this.video.on('error', error => { this.error = error.message; });
        this.video.on('close', () => { if (!this.stopping) this.error ||= 'VIDEO_SOCKET_CLOSED'; });
        let dummy = false;
        this.video.on('data', chunk => {
            try {
                if (!dummy) { if (chunk[0] !== 0) throw P.fail('BAD_DUMMY_BYTE'); dummy = true; }
                parser.push(chunk);
            } catch (error) { this.error = error.message; this.video.destroy(); }
        });
        await waitUntil(() => { if (this.error) throw P.fail(this.error); return dummy; }, 5000, 'VIDEO_SOCKET_TIMEOUT', this.e);
        this.control = net.createConnection({ host: '127.0.0.1', port: this.port });
        this.control.on('error', error => { this.error = error.message; });
        this.control.on('close', () => { if (!this.stopping) this.error ||= 'CONTROL_SOCKET_CLOSED'; });
        this.control.on('data', data => { this.e.write('control-received.bin', data); });
        await waitUntil(() => { if (this.error) throw P.fail(this.error); return this.size; }, 8000, 'VIDEO_METADATA_TIMEOUT', this.e);
        return { scid: this.scid, generation: this.generation, size: this.size };
    }
    record(data) {
        this.bytes += data.length;
        if (this.bytes > 32 * 1024 * 1024) { this.error = 'VIDEO_BUDGET_EXCEEDED'; this.video?.destroy(); return; }
        this.chunks.push(Buffer.from(data));
    }
    async image(framesBeforeLaunch = 0) {
        await waitUntil(() => { if (this.error) throw P.fail(this.error); return this.frames > framesBeforeLaunch; }, 10000, 'FIRST_FRAME_TIMEOUT', this.e);
        const h264 = path.join(this.e.output, 'video.h264');
        this.e.write('video.h264', Buffer.concat(this.chunks));
        // Decode all received frames and keep the latest, not an initial empty display.
        await this.e.command(this.e.options.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'h264', '-i', h264,
            '-update', '1', path.join(this.e.output, 'frame.png')], 'decode-frame');
        const { data, info } = await sharp(path.join(this.e.output, 'frame.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let nonblack = 0;
        for (let i = 0; i < data.length; i += info.channels) if (Math.max(...data.subarray(i, i + info.channels)) > 24) nonblack++;
        const result = { frames: this.frames, size: this.size, pngSize: { width: info.width, height: info.height },
            nonblackRatio: nonblack / (info.width * info.height), videoSha256: sha(h264), pngSha256: sha(path.join(this.e.output, 'frame.png')) };
        if (result.nonblackRatio < 0.05) throw P.fail('BLACK_FRAME');
        this.e.write('video-evidence.json', result);
        return result;
    }
    async stop() {
        this.stopping = true;
        this.video?.destroy(); this.control?.destroy();
        const errors = [];
        // Query and kill only the exact session. Never kill unrelated scrcpy instances.
        if (this.proc) {
            try {
                await waitUntil(async () => {
                    const list = await this.e.shell('ps -A -o PID,ARGS', 'cleanup-processes');
                    const lines = list.stdout.split(/\r?\n/).filter(line => line.includes('com.genymobile.scrcpy.Server') && new RegExp(`(?:^| )scid=${this.scid}(?: |$)`).test(line));
                    if (!lines.length) return true;
                    for (const line of lines) {
                        const pid = /^\s*(\d+)\s/.exec(line)?.[1];
                        if (!pid) throw P.fail('OWNED_PID_UNPROVEN');
                        await this.e.shell(`kill ${pid}`, 'kill-owned-server', true);
                    }
                    return false;
                }, 5000, 'SERVER_CLEANUP_UNPROVEN');
            } catch (error) { errors.push(error.message); }
            this.proc.kill();
        }
        if (this.forwardAttempted) {
            try {
                const owned = text => text.split(/\r?\n/).map(line => line.trim().split(/\s+/))
                    .filter(parts => parts[0] === this.e.options.serial && parts[2] === `localabstract:scrcpy_${this.scid}`);
                const list = await this.e.command(this.e.options.adb, ['forward', '--list'], 'owned-forwards');
                for (const parts of owned(list.stdout)) {
                    if (parts.length !== 3 || !/^tcp:[1-9][0-9]{0,4}$/.test(parts[1])) throw P.fail('FORWARD_IDENTITY_UNPROVEN');
                    await this.e.adb(['forward', '--remove', parts[1]], 'remove-forward');
                }
                const after = await this.e.command(this.e.options.adb, ['forward', '--list'], 'owned-forwards-removed');
                if (owned(after.stdout).length) throw P.fail('FORWARD_REMAINS');
            }
            catch (error) { errors.push(error.message); }
        }
        if (this.jarAttempted) {
            try {
                await this.e.shell(`rm -f ${this.remoteJar}`, 'remove-owned-jar');
                await this.e.shell(`test ! -e ${this.remoteJar}`, 'owned-jar-removed');
            }
            catch (error) { errors.push(error.message); }
        }
        this.e.write('session-stop.json', { serverExit: this.exit || null, errors });
        if (errors.length) throw P.fail('SESSION_CLEANUP_UNPROVEN');
    }
}

async function runProbe(options, { EvidenceType = Evidence, SessionType = Session, resolveServer = resolveServerArtifact } = {}) {
    const serverArtifact = resolveServer(options);
    options = { ...options, serverArtifact };
    for (const file of [options.adb, ...(options.mode === 'baseline' ? [] : [options.apk, options.ffmpeg, serverArtifact.jar])]) {
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw P.fail('LOCAL_DEPENDENCY_MISSING_' + file);
    }
    const e = new EvidenceType(options);
    const abort = () => { e.cancelled = true; };
    process.on('SIGINT', abort); process.on('SIGTERM', abort);
    const result = { protocol: options.mode === 'focus1' ? 'M4-focus-F1' : 'P0-r1', mode: options.mode, serial: options.serial, startedAt: new Date().toISOString(),
        status: 'RUNNING', gates: { A1: 'NOT_RUN', A2: 'NOT_RUN', A3: 'NOT_RUN', A4: 'NOT_RUN', A5: 'NOT_RUN' },
        cleanup: { status: 'NOT_NEEDED', errors: [] }, writes: 0, errors: [] };
    let baseline, session;
    let overlayAttempted = false, installAttempted = false;
    const remember = error => result.errors.push(error.code || error.message);
    try {
        e.write('input-hashes.json', Object.fromEntries([__filename, path.join(__dirname, 'protocol.cjs'), path.join(__dirname, 'README.md'),
            ...(options.mode === 'focus1' ? [path.join(__dirname, 'focus-protocol.md')] : []),
            ...(options.mode === 'baseline' ? [] : [options.apk, options.ffmpeg, serverArtifact.jar])].map(file => [file, sha(file)])));
        if (serverArtifact.build) { e.write('server-build.json', serverArtifact.build); result.candidate = serverArtifact.build.candidate; }
        for (const name of ['probe.cjs','protocol.cjs','README.md']) e.write('source-' + name, fs.readFileSync(path.join(__dirname, name)));
        if (options.mode === 'focus1') e.write('source-focus-protocol.md', fs.readFileSync(path.join(__dirname, 'focus-protocol.md')));
        const devices = await e.command(options.adb, ['devices', '-l'], 'devices');
        if (!devices.stdout.split(/\r?\n/).some(line => line.startsWith(options.serial + ' ') && /\sdevice\s/.test(line))) throw P.fail('DEVICE_NOT_ONLINE');
        await e.shell('getprop ro.build.fingerprint', 'build-fingerprint');
        baseline = await e.snapshot('before');
        const original = P.physical(baseline.displays);
        result.baseline = baseline;
        result.gates.A1 = 'BASELINE_CAPTURED';
        if (options.mode === 'baseline') { result.status = 'PASSED'; return result; }
        if (options.mode === 'focus1') {
            const sdk = (await e.shell('getprop ro.build.version.sdk', 'sdk')).stdout.trim();
            if (!/^\d+$/.test(sdk) || Number(sdk) < 34) throw P.fail('FOCUS_FLAG_PLATFORM_UNSUPPORTED');
        }
        if (baseline.displays.length !== 1 || baseline.wakefulness !== 'Awake') throw P.fail('SINGLE_AWAKE_DISPLAY_REQUIRED');
        const policy = await e.shell('dumpsys window policy', 'keyguard');
        if (!/^\s*(?:showing|mIsShowing)=false\s*$/m.test(policy.stdout) || !/^\s*(?:inputRestricted|mInputRestricted)=false\s*$/m.test(policy.stdout)
            || /^\s*(?:showing|mIsShowing|inputRestricted|mInputRestricted)=true\s*$/m.test(policy.stdout)) throw P.fail('UNLOCKED_DEVICE_REQUIRED');
        const processes = await e.shell('ps -A -o PID,ARGS', 'preflight-processes');
        if (/com\.genymobile\.scrcpy\.Server|com\.github\.uiautomator2|com\.wetest\.uia|com\.vcpchat\.(uiautomator|validation)/.test(processes.stdout)) throw P.fail('OTHER_AUTOMATION_ACTIVE');
        const overlay = await e.shell('settings get global overlay_display_devices', 'overlay-before');
        if (overlay.stdout.trim() !== 'null') throw P.fail('EXISTING_OVERLAY_SETTING');
        const installed = await e.shell(`pm path ${P.PACKAGE}`, 'fixture-before', true);
        if (options.useInstalledFixture) {
            const remote = P.installedApkPath(installed);
            const digest = await e.shell(`sha256sum ${remote}`, 'installed-fixture-hash');
            if (digest.stdout.trim().split(/\s/)[0] !== sha(options.apk)) throw P.fail('INSTALLED_FIXTURE_MISMATCH');
            result.fixtureSource = 'EXACT_INSTALLED_APK_PRESERVED';
        } else {
            if (installed.stdout.includes('package:')) throw P.fail('FIXTURE_ALREADY_INSTALLED');
            if (installed.code !== 1 || installed.stdout.trim() || installed.stderr.trim()) throw P.fail('FIXTURE_ABSENCE_UNPROVEN');
            e.check();
            installAttempted = true;
            result.fixtureInstallation = 'UNKNOWN';
            try {
                await e.adb(['install', options.apk], 'install-fixture');
                result.fixtureInstallation = 'COMPLETED';
            } catch (error) {
                if (Number.isInteger(error.transport?.code) && !error.transport.signal) result.fixtureInstallation = 'FAILED';
                throw error;
            }
            result.fixtureSource = 'INSTALLED_BY_THIS_RUN';
            const prepared = await e.snapshot('prepared');
            if (!P.samePhysical(original, P.physical(prepared.displays)) || prepared.wakefulness !== baseline.wakefulness
                || prepared.displays.length !== 1) throw P.fail('SETUP_CHANGED_PHYSICAL_CONTEXT');
        }
        let target;
        if (options.mode === 'overlay') {
            result.gates.A2 = 'RUNNING';
            overlayAttempted = true;
            await e.shell('settings put global overlay_display_devices 720x1280/260', 'create-overlay');
            const created = await e.snapshot('created');
            target = P.newDisplay(baseline.displays, created.displays);
            result.target = { ...target, generation: crypto.randomUUID() };
            if (!P.samePhysical(original, P.physical(created.displays)) || baseline.wakefulness !== created.wakefulness) throw P.fail('PHYSICAL_CONTEXT_CHANGED_ON_CREATE');
        }
        if (options.mode === 'new-display' || options.mode === 'focus1') result.gates.A4 = 'RUNNING';
        session = new SessionType(e, target?.logicalId ?? null);
        result.session = await session.start();
        if (!target) {
            const created = await e.snapshot('created');
            target = P.newDisplay(baseline.displays, created.displays);
            result.target = { ...target, generation: session.generation };
            if (options.mode === 'focus1') P.requireFocusFlags(target);
            if (!P.samePhysical(original, P.physical(created.displays)) || baseline.wakefulness !== created.wakefulness) throw P.fail('PHYSICAL_CONTEXT_CHANGED_ON_CREATE');
        }
        e.check();
        // Dedicated new package: no existing user task can be moved by this cold launch.
        const framesBeforeLaunch = session.frames;
        const launched = await e.shell(`am start --display ${target.logicalId} -n ${P.PACKAGE}/.MainActivity`, 'launch-fixture');
        if (/Error:|Exception|Warning: Activity not started/i.test(launched.stdout + launched.stderr)) throw P.fail('FIXTURE_LAUNCH_FAILED');
        const query = () => e.shell(`content query --uri content://${P.PACKAGE}.state/state`, 'fixture-state');
        const before = await waitUntil(async () => {
            try { return P.fixtureState((await query()).stdout, target.logicalId); }
            catch (error) { if (['FIXTURE_UNREADABLE','FIXTURE_AMBIGUOUS','FIXTURE_STATE_UNPROVEN'].includes(error.code)) return false; throw error; }
        }, 5000, 'FIXTURE_READY_TIMEOUT', e);
        result.fixtureBefore = before;
        result.video = await session.image(framesBeforeLaunch);
        const ready = await e.snapshot('ready');
        if (!P.samePhysical(original, P.physical(ready.displays)) || baseline.wakefulness !== ready.wakefulness) throw P.fail('PHYSICAL_CONTEXT_CHANGED_ON_LAUNCH');
        if (!P.sameTarget(target, ready.displays) || session.error) throw P.fail('TARGET_SESSION_CHANGED');
        if (options.mode === 'focus1') P.requireFocusFlags(ready.displays.find(d => d.logicalId === target.logicalId));
        if (options.mode === 'overlay' || options.mode === 'focus1') {
            const point = P.buttonCenter(before, target);
            e.check();
            result.writes++;
            await e.shell(`input -d ${target.logicalId} tap ${point.x} ${point.y}`, 'single-display-tap');
            const after = P.fixtureState((await query()).stdout, target.logicalId);
            result.fixtureAfter = after;
            if (!P.verifyTap(before, after)) throw P.fail('TARGET_TAP_UNPROVEN');
            const final = await e.snapshot('after-tap');
            if (!P.samePhysical(original, P.physical(final.displays)) || baseline.wakefulness !== final.wakefulness) throw P.fail('PHYSICAL_CONTEXT_CHANGED_ON_TAP');
            if (!P.sameTarget(target, final.displays) || session.error) throw P.fail('TARGET_SESSION_CHANGED');
            if (options.mode === 'focus1') {
                P.requireFocusFlags(final.displays.find(d => d.logicalId === target.logicalId));
                result.gates.A4 = 'FOCUS1_LAUNCH_ADB_TAP_PASSED_CONTROL_NOT_RUN';
            } else result.gates.A2 = 'AUTOMATED_CHECKS_PASSED_HUMAN_CONCURRENCY_NOT_RUN';
        } else result.gates.A4 = 'READ_ONLY_CHECKS_PASSED_CONTROL_INPUT_NOT_RUN';
        result.status = 'PASSED';
    } catch (error) { remember(error); result.status = 'FAILED'; }
    finally {
        const cleanup = async action => { try { await action(); } catch (error) { result.cleanup.errors.push(error.code || error.message); } };
        if (session) await cleanup(() => session.stop());
        if (overlayAttempted) await cleanup(async () => {
            const current = await e.shell('settings get global overlay_display_devices', 'overlay-before-restore');
            if (current.stdout.trim() !== '720x1280/260') throw P.fail('OVERLAY_CHANGED_EXTERNALLY');
            await e.shell('settings delete global overlay_display_devices', 'restore-overlay');
            if ((await e.shell('settings get global overlay_display_devices', 'overlay-restored')).stdout.trim() !== 'null') throw P.fail('OVERLAY_RESTORE_UNPROVEN');
        });
        if (installAttempted) await cleanup(async () => {
            await e.shell(`am force-stop ${P.PACKAGE}`, 'stop-fixture');
            const uninstall = await e.adb(['uninstall', P.PACKAGE], 'uninstall-fixture', true);
            const remaining = await e.shell(`pm path ${P.PACKAGE}`, 'fixture-removed', true);
            if (remaining.code !== 1 || remaining.stdout.trim() || remaining.stderr.trim()) throw P.fail('FIXTURE_CLEANUP_UNPROVEN');
        });
        // Killing the host adb process does not settle a pending OEM install dialog.
        // Package absence at this instant cannot prove that it will not install later.
        if (result.fixtureInstallation === 'UNKNOWN') result.cleanup.errors.push('INSTALL_RESULT_UNKNOWN');
        if (installAttempted || overlayAttempted || session) {
            await cleanup(async () => {
                const after = await e.snapshot('cleaned');
                result.cleanup.displays = after.displays;
                result.cleanup.physicalRestored = P.samePhysical(P.physical(baseline.displays), P.physical(after.displays)) && baseline.wakefulness === after.wakefulness;
                if (after.displays.length !== baseline.displays.length || !result.cleanup.physicalRestored) throw P.fail('DEVICE_RESTORE_UNPROVEN');
                const forwards = await e.command(options.adb, ['forward', '--list'], 'forwards-after');
                if (session?.scid && forwards.stdout.split(/\r?\n/).some(line => {
                    const parts = line.trim().split(/\s+/);
                    return parts[0] === options.serial && parts[2] === `localabstract:scrcpy_${session.scid}`;
                })) throw P.fail('FORWARD_REMAINS');
            });
            result.cleanup.status = result.cleanup.errors.length ? 'FAILED' : 'PASSED';
        }
        if (result.cleanup.errors.length) result.status = 'FAILED';
        if (result.status === 'FAILED' && options.mode !== 'baseline') {
            const key = options.mode === 'overlay' ? 'A2' : 'A4';
            if (result.gates[key] !== 'NOT_RUN') result.gates[key] = 'FAILED';
        }
        result.finishedAt = new Date().toISOString();
        e.write('result.json', result);
        process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    }
    return result;
}

if (require.main === module) {
    runProbe(P.parseArgs(process.argv.slice(2))).then(result => {
        console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'PASSED' ? 0 : 1;
    }).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
module.exports = { Evidence, Session, waitUntil, resolveServerArtifact, runProbe };
