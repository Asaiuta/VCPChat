'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('../scripts/android-m4/protocol.cjs');
const { Evidence } = require('../scripts/android-m4/probe.cjs');
const F2 = require('../scripts/android-m4/f2.cjs');

test('F2 touch message matches scrcpy 5.0.1 ControlMessageReader layout', () => {
    const down = F2.encodeTouch({ action: F2.ACTION_DOWN, x: 360, y: 309, width: 720, height: 1280 });
    assert.equal(down.length, 32);
    assert.equal(down.readUInt8(0), 2);
    assert.equal(down.readUInt8(1), 0);
    assert.equal(down.readBigInt64BE(2), -2n);
    assert.equal(down.readInt32BE(10), 360);
    assert.equal(down.readInt32BE(14), 309);
    assert.equal(down.readUInt16BE(18), 720);
    assert.equal(down.readUInt16BE(20), 1280);
    assert.equal(down.readUInt16BE(22), 0xffff);
    assert.equal(down.readInt32BE(24), 0);
    assert.equal(down.readInt32BE(28), 0);
    const up = F2.encodeTouch({ action: F2.ACTION_UP, x: 360, y: 309, width: 720, height: 1280 });
    assert.equal(up.readUInt8(1), 1);
    assert.equal(up.readUInt16BE(22), 0);
});
test('F2 touch encoder refuses out-of-screen points and non-touch actions', () => {
    const ok = { action: 0, x: 1, y: 1, width: 720, height: 1280 };
    for (const patch of [{ x: 720 }, { y: -1 }, { width: 0 }, { height: 70000 }, { action: 2 }, { x: 1.5 }]) {
        assert.throws(() => F2.encodeTouch({ ...ok, ...patch }), /CONTROL_/);
    }
});

const ID = 'com.vcpchat.m4fixture:id/tap_button';
const state = { taps: 0, buttonBounds: { left: 39, top: 244, right: 681, bottom: 374 } };
const node = (text = 'M4 TAP 0', bounds = '[39,244][681,374]') => `<node index="1" text="${text}" resource-id="${ID}" bounds="${bounds}" />`;
const dump = body => ({ code: 0, stdout: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${body}</hierarchy>UI hierchary dumped to: /dev/tty` });
test('F2 A3 attributes the button only through an explicit display grouping', () => {
    const r = F2.classifyDump(dump(`<display id="0"><node text="home" /></display><display id="139"><node index="0">${node()}</node></display>`), 139, state);
    assert.equal(r.kind, 'ATTRIBUTED');
    assert.equal(F2.classifyDump(dump(`<window display-id="139"><node>${node()}</node></window>`), 139, state).kind, 'ATTRIBUTED');
});
test('F2 A3 separates ungrouped, wrong-display, stale, ambiguous, absent and failed dumps', () => {
    assert.equal(F2.classifyDump(dump(`<node>${node()}</node>`), 139, state).kind, 'UNATTRIBUTED');
    assert.equal(F2.classifyDump(dump(`<display id="0">${node()}</display>`), 139, state).kind, 'WRONG_DISPLAY');
    assert.equal(F2.classifyDump(dump(`<display id="139">${node('M4 TAP 1')}</display>`), 139, state).kind, 'MISMATCHED');
    assert.equal(F2.classifyDump(dump(`<display id="139">${node('M4 TAP 0', '[0,0][1,1]')}</display>`), 139, state).kind, 'MISMATCHED');
    assert.equal(F2.classifyDump(dump(node() + node()), 139, state).kind, 'AMBIGUOUS');
    assert.equal(F2.classifyDump(dump('<node text="home" />'), 139, state).kind, 'ABSENT');
    assert.equal(F2.classifyDump({ code: 1, stdout: 'ERROR: null root node' }, 139, state).kind, 'DUMP_FAILED');
    assert.equal(F2.classifyDump(dump(`<display id="x">${node()}</display>`), 139, state).kind, 'WRONG_DISPLAY');
});
test('F2W parses AOSP `uiautomator dump --windows` (<displays>/<display id>/<window>/<hierarchy>)', () => {
    const win = (body, id) => `<window index="0" title="t" bounds="[0,0][720,1280]" active="true" focused="true" accessibility-focused="false" id="${id}" layer="1" type="TYPE_APPLICATION"><hierarchy rotation="0">${body}</hierarchy></window>`;
    const xml = s => ({ code: 0, stdout: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><displays>${s}</displays>\nUI hierchary dumped to: /dev/tty` });
    const both = `<display id="0">${win('<node text="mail" resource-id="x" bounds="[0,0][1,1]" />', 5)}</display><display id="139">${win(`<node index="0">${node()}</node>`, 9)}</display>`;
    assert.equal(F2.classifyDump(xml(both), 139, state).kind, 'ATTRIBUTED');
    assert.equal(F2.classifyDump(xml(`<display id="0">${win(node(), 5)}</display>`), 139, state).kind, 'WRONG_DISPLAY');
    assert.equal(F2.classifyDump(xml(`<display id="0">${win('<node text="mail" />', 5)}</display>`), 139, state).kind, 'ABSENT');
    assert.equal(F2.classifyDump({ code: 0, stdout: '' }, 139, state).kind, 'DUMP_FAILED');
    const parsed = F2.parseF2Args(['--serial', 'A', '--output', 'x', '--apk', 'a', '--ffmpeg', 'f', '--use-installed-fixture', '--a3-windows']);
    assert.equal(parsed.options.a3Windows, true);
});
test('F2 A3 gate requires attribution on both sides; ungrouped is only partial', () => {
    assert.equal(F2.a3Status('ATTRIBUTED', 'ATTRIBUTED'), 'PASSED');
    assert.equal(F2.a3Status('UNATTRIBUTED', 'ATTRIBUTED'), 'PARTIAL');
    assert.equal(F2.a3Status('ATTRIBUTED', 'MISMATCHED'), 'NOT_SUPPORTED');
    assert.equal(F2.a3Status('ABSENT', 'ABSENT'), 'NOT_SUPPORTED');
});
test('F2 CLI forces focus1 and requires the preinstalled exact fixture', () => {
    const base = ['--serial', 'A', '--output', 'x', '--apk', 'a', '--ffmpeg', 'f'];
    assert.throws(() => F2.parseF2Args(base), { code: 'F2_REQUIRES_FOCUS1_INSTALLED_FIXTURE' });
    const parsed = F2.parseF2Args([...base, '--use-installed-fixture', '--campaign']);
    assert.equal(parsed.options.mode, 'focus1'); assert.equal(parsed.isCampaign, true);
    assert.throws(() => F2.parseF2Args([...base, '--use-installed-fixture', '--mode', 'overlay']), { code: 'INVALID_OPTION' });
});

const windowText = `  Display: mDisplayId=0 (organized)\n    cur=1440x3168\n  mCurrentFocus=Window{abc u0 com.demo/.Home}\n`;
const secondWindow = `  Display: mDisplayId=12\n    cur=720x1280\n  mCurrentFocus=null\n`;
const displayText = `  Display 0:\n    mPrimaryDisplayDevice=Built-in(local:1)\n  Display 12:\n    mPrimaryDisplayDevice=scrcpy(virtual:com.android.shell,2000,scrcpy,1)\n`;
const fixture = (taps, extra = {}) => 'Row: 0 json=' + JSON.stringify({ schemaVersion: 1, package: P.PACKAGE,
    processSession: 'abcdefab-1234-1234-1234-123456789abc', captureStatus: 'fresh', capturedAtUptimeMs: 100 + taps,
    states: [{ session: '12345678-1234-1234-1234-123456789abc', displayId: 12, destroyed: false, resumed: true, taskId: 30,
        width: 720, height: 1280, touchEventCount: taps * 2, deliveredDisplayIds: taps ? [12] : [], taps, touchDisplayIds: [],
        buttonBounds: { left: 39, top: 244, right: 681, bottom: 374 }, ...extra }] });

async function simulate(t, changes = {}) {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm4-f2-')), 'evidence');
    t.after(() => fs.rmSync(path.dirname(output), { recursive: true, force: true }));
    const labels = [], sent = [];
    let taps = 0;
    const all = P.inventory(windowText + secondWindow, displayText, '');
    all[1].flags = ['FLAG_TRUSTED', 'FLAG_OWN_FOCUS', 'FLAG_STEAL_TOP_FOCUS_DISABLED'];
    const apkHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
    class FakeEvidence extends Evidence {
        async command(file, args, label) {
            labels.push(label);
            let stdout = '', code = 0;
            if (label === 'devices') stdout = 'A device model:x\n';
            if (label === 'sdk') stdout = '37\n';
            if (label === 'keyguard') stdout = ' showing=false\n inputRestricted=false\n';
            if (label === 'overlay-before') stdout = 'null\n';
            if (label === 'fixture-before') stdout = 'package:/data/app/~~t==/com.vcpchat.m4fixture-t/base.apk\n';
            if (label === 'installed-fixture-hash') stdout = apkHash + '  base.apk';
            if (label === 'fixture-state') stdout = fixture(taps, changes.dumpTaps && labels.filter(l => l.startsWith('a3-dump')).length ? { taps: 5 } : {});
            if (label.startsWith('a3-dump')) stdout = dump(`<display id="12">${node('M4 TAP ' + taps)}</display>`).stdout;
            return { code, stdout, stderr: '' };
        }
        async snapshot(label) {
            labels.push('snap-' + label);
            const displays = JSON.parse(JSON.stringify(['before', 'cleaned'].includes(label) ? [all[0]] : all));
            if (label === changes.focusChangedAt) displays[0].focus = 'Window{zzz u0 other/.X}';
            return { displays, wakefulness: 'Awake' };
        }
    }
    class FakeSession {
        constructor() { this.frames = 0; this.generation = 'g'; this.scid = '1234abcd'; this.size = changes.size || { width: 720, height: 1280 }; this.error = null; }
        async start() {
            this.control = { write: (buf, cb) => { sent.push(buf); labels.push('control-write');
                if (buf.readUInt8(1) === 1 && !changes.noEffect) taps++; cb(changes.writeFails ? new Error('EPIPE') : undefined); } };
            return { scid: this.scid, generation: 'g', size: this.size };
        }
        async image() { return { nonblackRatio: 0.9 }; }
        async stop() { labels.push('session-stop'); }
    }
    const result = await F2.runF2({ serial: 'A', mode: 'focus1', useInstalledFixture: true, output, adb: process.execPath, apk: __filename, ffmpeg: process.execPath },
        { EvidenceType: FakeEvidence, SessionType: FakeSession, pollMs: 300,
            resolveServer: () => ({ jar: require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub').LOCAL_JAR }) });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')), result);
    return { result, labels, sent };
}
test('F2 passes with one down/up control tap, fresh attributed trees before and after, and cleanup', async t => {
    const { result, labels, sent } = await simulate(t);
    assert.equal(result.status, 'PASSED', JSON.stringify(result.errors));
    assert.equal(result.gates.A4, 'CONTROL_TOUCH_PASSED'); assert.equal(result.gates.A3, 'PASSED');
    assert.equal(result.a3.after.text, 'M4 TAP 1');
    assert.equal(result.writes, 1); assert.equal(sent.length, 2);
    assert.deepEqual(sent.map(b => b.readUInt8(1)), [0, 1]);
    assert.ok(labels.indexOf('a3-dump-before') < labels.indexOf('control-write'));
    assert.ok(labels.indexOf('control-write') < labels.indexOf('a3-dump-after'));
    assert.ok(!labels.includes('single-display-tap'));
    assert.equal(result.cleanup.status, 'PASSED');
});
test('F2 no-effect control touch fails without any resend', async t => {
    const { result, sent } = await simulate(t, { noEffect: true });
    assert.equal(result.status, 'FAILED'); assert.ok(result.errors.includes('CONTROL_TAP_UNPROVEN'));
    assert.equal(sent.length, 2); assert.equal(result.control, 'DISPATCHED'); assert.equal(result.gates.A4, 'FAILED');
});
test('F2 refuses to write when video geometry differs from the target display', async t => {
    const { result, sent } = await simulate(t, { size: { width: 704, height: 1280 } });
    assert.ok(result.errors.includes('CONTROL_GEOMETRY_MISMATCH')); assert.equal(sent.length, 0); assert.equal(result.writes, 0);
});
test('F2 physical focus change before input stops before any control write', async t => {
    const { result, sent, labels } = await simulate(t, { focusChangedAt: 'after-dump-before' });
    assert.equal(result.status, 'FAILED'); assert.equal(sent.length, 0);
    assert.ok(labels.includes('session-stop'));
});
test('F2 a dump that changes the target state is a failure, not a semantic result', async t => {
    const { result, sent } = await simulate(t, { dumpTaps: true });
    assert.ok(result.errors.includes('A3_DUMP_CHANGED_TARGET')); assert.equal(sent.length, 0);
});
test('F2 failed socket write records partial dispatch and never retries', async t => {
    const { result, sent } = await simulate(t, { writeFails: true });
    assert.equal(result.status, 'FAILED'); assert.equal(sent.length, 1); assert.equal(result.control, 'PARTIAL');
});
