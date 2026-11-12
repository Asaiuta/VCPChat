'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('../scripts/android-m4/protocol.cjs');
const { Evidence } = require('../scripts/android-m4/probe.cjs');
const A5 = require('../scripts/android-m4/a5.cjs');

const inst = (o = {}) => ({ session: 's-a', activity: 'SingleTaskActivity', displayId: 0, taskId: 10, destroyed: false, ...o });
test('A5 migration classifier distinguishes move, stay and new instance in both directions', () => {
    const from0 = [inst()];
    assert.equal(A5.classifyMigration(from0, [inst({ displayId: 50 })], { from: 0, to: 50, activity: 'SingleTaskActivity' }).kind, 'MOVED_TO_TARGET');
    assert.equal(A5.classifyMigration(from0, [inst()], { from: 0, to: 50, activity: 'SingleTaskActivity' }).kind, 'STAYED_ON_PHYSICAL');
    assert.equal(A5.classifyMigration(from0, [inst(), inst({ session: 's-b', displayId: 50, taskId: 11 })], { from: 0, to: 50, activity: 'SingleTaskActivity' }).kind, 'NEW_INSTANCE_ON_TARGET');
    const fromV = [inst({ displayId: 50 })];
    assert.equal(A5.classifyMigration(fromV, [inst({ displayId: 0 })], { from: 50, to: 0, activity: 'SingleTaskActivity' }).kind, 'PULLED_TO_PHYSICAL');
    assert.equal(A5.classifyMigration(fromV, [inst({ displayId: 50 })], { from: 50, to: 0, activity: 'SingleTaskActivity' }).kind, 'STAYED_ON_TARGET');
    assert.equal(A5.classifyMigration([], [inst()], { from: 0, to: 50, activity: 'SingleTaskActivity' }).kind, 'UNPROVEN');
    assert.equal(A5.classifyMigration(from0, [], { from: 0, to: 50, activity: 'SingleTaskActivity' }).kind, 'UNPROVEN');
});
test('A5 IME classifier needs both a consistent shown flag and a single display', () => {
    const win = d => `  Display: mDisplayId=0 (organized)\n  x\n  Display: mDisplayId=${d} (organized)\n  Window{1 u0 InputMethod}\n`;
    assert.equal(A5.classifyIme('mInputShown=false', win(50), 50).kind, 'IME_NOT_SHOWN');
    assert.equal(A5.classifyIme('mInputShown=true', win(50), 50).kind, 'IME_ON_TARGET');
    assert.equal(A5.classifyIme('mInputShown=true', win(0).replace('mDisplayId=0 (organized)\n  x', 'mDisplayId=7 (organized)\n  x'), 50).kind, 'IME_ON_PHYSICAL');
    assert.equal(A5.classifyIme('mInputShown=true mImeShowing=false', win(50), 50).kind, 'IME_UNPROVEN');
    assert.equal(A5.classifyIme('nothing', win(50), 50).kind, 'IME_UNPROVEN');
    assert.equal(A5.classifyIme('mInputShown=true', 'mImeLayeringTarget in display# 0\n' + win(50), 50).kind, 'IME_UNPROVEN');
});
test('A5 permission classifier uses per-display sections', () => {
    const win = (a, b) => `  Display: mDisplayId=0 (organized)\n${a}\n  Display: mDisplayId=50 (organized)\n${b}\n`;
    const g = '  Window{9 u0 com.android.permissioncontroller/.permission.ui.GrantPermissionsActivity}';
    assert.equal(A5.classifyPermission(win('', g), 50).kind, 'PERMISSION_ON_TARGET');
    assert.equal(A5.classifyPermission(win(g, ''), 50).kind, 'PERMISSION_ON_PHYSICAL');
    assert.equal(A5.classifyPermission(win('', ''), 50).kind, 'PERMISSION_NOT_SHOWN');
    assert.equal(A5.classifyPermission(win(g, g), 50).kind, 'UNPROVEN');
});
test('A5 CLI gates physical scenarios behind --allow-physical', () => {
    const base = ['--serial', 'A', '--output', 'x', '--apk', 'a', '--ffmpeg', 'f', '--use-installed-fixture'];
    assert.equal(A5.parseA5Args(base).allowPhysical, undefined);
    assert.equal(A5.parseA5Args([...base, '--allow-physical']).allowPhysical, true);
    assert.throws(() => A5.parseA5Args(base.slice(0, -1)), { code: 'A5_REQUIRES_INSTALLED_FIXTURE' });
});

const windowText = `  Display: mDisplayId=0 (organized)\n    cur=1440x3168\n  mCurrentFocus=Window{abc u0 com.demo/.Home}\n`;
const secondWindow = `  Display: mDisplayId=12\n    cur=720x1280\n  mCurrentFocus=null\n`;
const displayText = `  Display 0:\n    mPrimaryDisplayDevice=Built-in(local:1)\n  Display 12:\n    mPrimaryDisplayDevice=scrcpy(virtual:com.android.shell,2000,scrcpy,1)\n`;
async function simulate(t, changes = {}) {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm4-a5-')), 'out');
    t.after(() => fs.rmSync(path.dirname(output), { recursive: true, force: true }));
    const labels = [];
    const apkHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
    let instances = [];
    const all = P.inventory(windowText + secondWindow, displayText, '');
    all[1].flags = ['FLAG_TRUSTED', 'FLAG_OWN_FOCUS', 'FLAG_STEAL_TOP_FOCUS_DISABLED'];
    class FakeEvidence extends Evidence {
        async command(file, args, label) {
            labels.push(label);
            const cmd = args.at(-1);
            let stdout = '';
            if (label === 'fixture-path') stdout = 'package:/data/app/~~t==/com.vcpchat.m4fixture-t/base.apk\n';
            if (label === 'fixture-sha') stdout = apkHash + '  base.apk';
            if (label === 'device-epoch') stdout = '1793955671.000\n';
            if (label.endsWith('-top')) stdout = 'mTopFocusedDisplayId=0\n';
            if (label === 'events') stdout = '';
            if (label.startsWith('launch')) {
                const display = Number(/--display (\d+)/.exec(cmd)[1]);
                const activity = /SingleTask/.test(cmd) ? 'SingleTaskActivity' : /Permission/.test(cmd) ? 'PermissionActivity' : 'MainActivity';
                const existing = instances.find(s => s.activity === activity);
                if (activity === 'SingleTaskActivity' && existing) existing.displayId = changes.migrate === false ? existing.displayId : display;
                else if (activity === 'MainActivity' && existing && existing.displayId === display) existing.newIntentCount++;
                else instances.push({ session: 's' + instances.length, activity, displayId: display, taskId: 20 + instances.length, destroyed: false,
                    newIntentCount: 0, touchEventCount: 0, inputFocused: false, permissionRequested: activity === 'PermissionActivity',
                    inputBounds: { left: 39, top: 420, right: 681, bottom: 524 } });
            }
            if (label.startsWith('state') || label.startsWith('cleanup-')) {
                if (label === 'cleanup-force-stop') instances = [];
                stdout = 'Row: 0 json=' + JSON.stringify({ schemaVersion: 1, package: P.PACKAGE, processSession: 'p', captureStatus: 'fresh', capturedAtUptimeMs: 1, states: instances });
            }
            if (label === 'ime-dump') stdout = 'mInputShown=false';
            if (label === 'permission-window') stdout = `  Display: mDisplayId=0 (organized)\n${changes.permissionOnPhysical ? '  Window{9 u0 x/.GrantPermissionsActivity}' : ''}\n  Display: mDisplayId=12 (organized)\n${changes.permissionOnPhysical ? '' : '  Window{9 u0 x/.GrantPermissionsActivity}'}\n`;
            return { code: 0, stdout, stderr: '' };
        }
        async snapshot(label) {
            labels.push('snap-' + label);
            const displays = JSON.parse(JSON.stringify(label === 'before' || label === 'cleaned' ? [all[0]] : all));
            if (changes.residue && label === 'cleaned') displays[0].focus = 'Window{f u0 com.vcpchat.m4fixture/.SingleTaskActivity}';
            if (changes.permissionOnPhysical && label === 'permission-after-stop') displays[0].focus = 'Window{9 u0 com.android.permissioncontroller/.GrantPermissionsActivity}';
            return { displays, wakefulness: 'Awake' };
        }
    }
    class FakeSession {
        constructor() { this.scid = '1234abcd'; this.generation = 'g'; this.size = { width: 720, height: 1280 }; }
        async start() { this.control = { write: (b, cb) => { labels.push('control:' + b.readUInt8(1)); if (b.readUInt8(1) === 1) for (const s of instances) s.touchEventCount += 2; cb(); } }; return { scid: this.scid }; }
        async stop() { labels.push('session-stop'); }
    }
    const summary = await A5.runA5({ serial: 'A', useInstalledFixture: true, allowPhysical: changes.allowPhysical, output, adb: process.execPath, apk: __filename, ffmpeg: process.execPath },
        { EvidenceType: FakeEvidence, SessionType: FakeSession, log: () => {},
            resolveServer: () => ({ jar: require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub').LOCAL_JAR }) });
    return { summary, labels };
}
test('A5 without --allow-physical runs only S1 and S4 and never touches display 0', async t => {
    const { summary, labels } = await simulate(t);
    assert.deepEqual(summary.results.map(r => [r.scenario, r.status]), [['S1', 'PASSED'], ['S2', 'NOT_RUN'], ['S3', 'NOT_RUN'], ['S4', 'PASSED'], ['S5', 'NOT_RUN']]);
    assert.ok(!labels.includes('launch-from') && !labels.includes('launch-to'), 'no physical-display launch without --allow-physical');
    assert.ok(!labels.includes('dismiss-permission-back'));
    assert.equal(labels.filter(l => l.startsWith('control:')).length, 2);
    assert.equal(summary.results[0].classification.kind, 'REUSED_INSTANCE');
    assert.equal(summary.results[3].classification.kind, 'IME_NOT_SHOWN');
});
test('A5 with --allow-physical classifies migration both ways and permission placement, cleaning each', async t => {
    const { summary, labels } = await simulate(t, { allowPhysical: true });
    const byId = Object.fromEntries(summary.results.map(r => [r.scenario, r]));
    assert.equal(byId.S2.classification.kind, 'MOVED_TO_TARGET');
    assert.equal(byId.S3.classification.kind, 'PULLED_TO_PHYSICAL');
    assert.equal(byId.S5.classification.kind, 'PERMISSION_ON_TARGET');
    assert.equal(labels.filter(l => l === 'session-stop').length, 5);
    assert.ok(labels.includes('permission-revoke'));
});
test('A5 permission dialog left on physical gets exactly one BACK on display 0', async t => {
    const { summary, labels } = await simulate(t, { allowPhysical: true, permissionOnPhysical: true });
    const s5 = summary.results.find(r => r.scenario === 'S5');
    assert.equal(s5.classification.kind, 'PERMISSION_ON_PHYSICAL');
    assert.equal(labels.filter(l => l === 'dismiss-permission-back').length, 1);
});
test('A5 stops remaining scenarios after a cleanup failure', async t => {
    const { summary } = await simulate(t, { allowPhysical: true, residue: true });
    assert.equal(summary.results[0].cleanup, 'FAILED');
    assert.ok(summary.results.slice(1).every(r => r.status === 'NOT_RUN'));
    assert.equal(summary.status, 'FAILED');
});
