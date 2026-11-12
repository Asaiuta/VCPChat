'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('../scripts/android-m4/protocol.cjs');
const C = require('../scripts/android-m4/causal.cjs');
const { Evidence } = require('../scripts/android-m4/probe.cjs');
const F2 = require('../scripts/android-m4/f2.cjs');

// Shapes copied from PJZ110 events buffer (R1/R2 logcat, -v epoch layout).
const ev = (tag, fields, t = '1793955671.100') => `${t}  3936  3936 I ${tag}: [${fields}]`;
const launch = ev('wm_task_moved', '49379,49379,164,1,0');
const userHome = ev('wm_focused_root_task', '0,0,1,-1,startExistingRecents');
const userBili = ev('wm_set_resumed_activity', '0,tv.danmaku.bili/.MainActivityV2,resumeTopActivity - onActivityStateChanged');

test('F3 event parser reads epoch-format WM events and ignores others', () => {
    const events = C.parseEvents([launch, userHome, '1793955671.2  3936  3936 I am_kill: [0,1,x,900,stop]', 'garbage'].join('\n'));
    assert.deepEqual(events.map(e => e.tag), ['wm_task_moved', 'wm_focused_root_task']);
    assert.deepEqual(events[0].fields, ['49379', '49379', '164', '1', '0']);
});
test('F3 accepts human use of the physical display (R1 case 6 / R2 case 16 pattern)', () => {
    const r = C.judgeEvents(C.parseEvents([launch, userHome, userBili].join('\n')), { targetId: 164, taskIds: [49379] });
    assert.deepEqual(r.violations, []);
    assert.equal(r.coverage, true);
    assert.equal(r.external.length, 2);
});
test('F3 attributes focus theft, migration and top-resume to the session', () => {
    const cases = [
        [ev('wm_task_moved', '49379,49379,0,1,25'), 'FIXTURE_TASK_LEFT_TARGET'],
        [ev('wm_task_moved', '49311,49311,164,1,0'), 'FOREIGN_TASK_ON_TARGET'],
        [ev('wm_focused_root_task', '0,164,49379,-1,setFocusedTask'), 'TARGET_TOOK_TOP_FOCUS'],
        [ev('wm_focused_root_task', '0,0,49379,1,moveTaskToFront'), 'FIXTURE_TOOK_PHYSICAL_FOCUS'],
        [ev('wm_set_resumed_activity', '0,com.vcpchat.m4fixture/.MainActivity,x'), 'FIXTURE_BECAME_TOP_RESUMED'],
    ];
    for (const [line, code] of cases) {
        const r = C.judgeEvents(C.parseEvents(launch + '\n' + line), { targetId: 164, taskIds: [49379] });
        assert.equal(r.violations[0]?.code, code, line);
    }
});
test('F3 coverage is false when the log window misses the launch', () => {
    assert.equal(C.judgeEvents(C.parseEvents(userHome), { targetId: 164, taskIds: [49379] }).coverage, false);
});
test('F3 physical check: identity strict, foreign focus change allowed, null/fixture/top-focus rejected', () => {
    const original = { logicalId: 0, uniqueId: 'local:1', size: { width: 1440, height: 3168 }, focus: 'Window{a u0 com.android.settings/.X}' };
    const snap = focus => ({ displays: [{ ...original, focus }] });
    assert.deepEqual(C.physicalCheck(original, snap('Window{b u0 tv.danmaku.bili/.Main}'), { targetId: 164, topFocused: 0 }),
        { ok: true, changed: true, focus: 'Window{b u0 tv.danmaku.bili/.Main}' });
    assert.equal(C.physicalCheck(original, snap('null'), { targetId: 164, topFocused: 0 }).code, 'PHYSICAL_FOCUS_NULL');
    assert.equal(C.physicalCheck(original, snap('null'), { targetId: 164, topFocused: 0 }).retry, true);
    assert.equal(C.physicalCheck(original, snap('Window{c u0 com.vcpchat.m4fixture/.MainActivity}'), { targetId: 164, topFocused: 0 }).code, 'FIXTURE_ON_PHYSICAL');
    assert.equal(C.physicalCheck(original, snap(original.focus), { targetId: 164, topFocused: 164 }).code, 'TARGET_TOOK_TOP_FOCUS');
    assert.equal(C.physicalCheck(original, { displays: [{ ...original, uniqueId: 'local:2' }] }, { targetId: 164, topFocused: 0 }).code, 'PHYSICAL_IDENTITY_CHANGED');
    assert.throws(() => C.parseTopFocused('mTopFocusedDisplayId=0\nmTopFocusedDisplayId=1'), { code: 'TOP_FOCUS_UNPROVEN' });
    assert.equal(C.parseTopFocused('  mTopFocusedDisplayId=0\n'), 0);
});
test('F3 CLI selects causal criterion and protocol identity', () => {
    const base = ['--serial', 'A', '--output', 'x', '--apk', 'a', '--ffmpeg', 'f', '--use-installed-fixture'];
    const { options } = F2.parseF2Args([...base, '--criterion', 'causal', '--a3-windows']);
    assert.equal(options.criterion, 'causal'); assert.equal(F2.protocolId(options), 'M4-F3W');
    assert.equal(F2.protocolId(F2.parseF2Args(base).options), 'M4-F2');
    assert.throws(() => F2.parseF2Args([...base, '--criterion', 'loose']), { code: 'INVALID_CRITERION' });
});

const windowText = `  Display: mDisplayId=0 (organized)\n    cur=1440x3168\n  mCurrentFocus=Window{abc u0 com.demo/.Home}\n`;
const secondWindow = `  Display: mDisplayId=12\n    cur=720x1280\n  mCurrentFocus=null\n`;
const displayText = `  Display 0:\n    mPrimaryDisplayDevice=Built-in(local:1)\n  Display 12:\n    mPrimaryDisplayDevice=scrcpy(virtual:com.android.shell,2000,scrcpy,1)\n`;
const ID = 'com.vcpchat.m4fixture:id/tap_button';
const fixture = taps => 'Row: 0 json=' + JSON.stringify({ schemaVersion: 1, package: P.PACKAGE,
    processSession: 'abcdefab-1234-1234-1234-123456789abc', captureStatus: 'fresh', capturedAtUptimeMs: 100 + taps,
    states: [{ session: '12345678-1234-1234-1234-123456789abc', displayId: 12, destroyed: false, resumed: true, taskId: 30,
        width: 720, height: 1280, touchEventCount: taps * 2, deliveredDisplayIds: taps ? [12] : [], taps, touchDisplayIds: [],
        buttonBounds: { left: 39, top: 244, right: 681, bottom: 374 } }] });

async function simulate(t, changes = {}) {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm4-f3-')), 'evidence');
    t.after(() => fs.rmSync(path.dirname(output), { recursive: true, force: true }));
    const labels = [], sent = [];
    let taps = 0, nullLeft = changes.nullFocusSamples || 0;
    const all = P.inventory(windowText + secondWindow, displayText, '');
    all[1].flags = ['FLAG_TRUSTED', 'FLAG_OWN_FOCUS', 'FLAG_STEAL_TOP_FOCUS_DISABLED'];
    const apkHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
    class FakeEvidence extends Evidence {
        async command(file, args, label) {
            labels.push(label);
            let stdout = '';
            if (label === 'devices') stdout = 'A device model:x\n';
            if (label === 'sdk') stdout = '37\n';
            if (label === 'keyguard') stdout = changes.locked ? ' showing=true\n inputRestricted=true\n' : ' showing=false\n inputRestricted=false\n';
            if (label === 'overlay-before') stdout = 'null\n';
            if (label === 'fixture-before') stdout = 'package:/data/app/~~t==/com.vcpchat.m4fixture-t/base.apk\n';
            if (label === 'installed-fixture-hash') stdout = apkHash + '  base.apk';
            if (label === 'device-epoch') stdout = '1793955671.000123456\n';
            if (label.endsWith('-top')) stdout = `  mTopFocusedDisplayId=${changes.topFocusTarget && label.startsWith('after-control') ? 12 : 0}\n`;
            if (label.endsWith('-events')) stdout = [changes.noCoverage ? '' : ev('wm_task_moved', '30,30,12,1,0'), userHome, userBili, ...(changes.extraEvent ? [changes.extraEvent] : [])].join('\n');
            if (label === 'fixture-state') stdout = fixture(taps);
            if (label.startsWith('a3-dump')) stdout = `<displays><display id="12"><window id="1"><hierarchy rotation="0"><node text="M4 TAP ${taps}" resource-id="${ID}" bounds="[39,244][681,374]" /></hierarchy></window></display></displays>`;
            return { code: 0, stdout, stderr: '' };
        }
        async snapshot(label) {
            labels.push('snap-' + label);
            const displays = JSON.parse(JSON.stringify(label.startsWith('before') || label.startsWith('cleaned') ? [all[0]] : all));
            if (changes.userSwitchesAt && label.startsWith(changes.userSwitchesAt)) displays[0].focus = 'Window{zzz u0 tv.danmaku.bili/.MainActivityV2}';
            if (label.startsWith('after-dump-before') && nullLeft > 0) { nullLeft--; displays[0].focus = 'null'; }
            if (changes.fixtureOnPhysical && label === 'ready') displays[0].focus = 'Window{f u0 com.vcpchat.m4fixture/com.vcpchat.m4fixture.MainActivity}';
            return { displays, wakefulness: changes.asleep ? 'Asleep' : 'Awake' };
        }
    }
    class FakeSession {
        constructor() { this.frames = 0; this.generation = 'g'; this.scid = '1234abcd'; this.size = { width: 720, height: 1280 }; this.error = null; }
        async start() {
            this.control = { write: (buf, cb) => { sent.push(buf); if (buf.readUInt8(1) === 1) taps++; cb(); } };
            return { scid: this.scid, generation: 'g', size: this.size };
        }
        async image() { return { nonblackRatio: 0.9 }; }
        async stop() { labels.push('session-stop'); }
    }
    if (changes.carrierXml) changes.CarrierType = class {
        async start() { labels.push('carrier-start'); return changes.carrierStartFails ? { ok: false, reason: 'UI_SERVER_START_FAILED' } : { ok: true }; }
        async dump(opts) {
            labels.push('carrier-dump:' + opts.rootInActive);
            if (changes.emptyFirst > 0) { changes.emptyFirst--; return { xml: `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0" />` }; }
            return { xml: changes.carrierXml(taps) };
        }
        async stop() { labels.push('carrier-stop'); return { status: 'released' }; }
    };
    const result = await F2.runF2({ serial: 'A', mode: 'focus1', useInstalledFixture: true, criterion: 'causal', a3Windows: true, a3Carrier: !!changes.CarrierType, output,
        adb: process.execPath, apk: __filename, ffmpeg: process.execPath },
        { EvidenceType: FakeEvidence, SessionType: FakeSession, pollMs: 300, CarrierType: changes.CarrierType,
            resolveServer: () => ({ jar: require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub').LOCAL_JAR }) });
    return { result, labels, sent };
}
test('F3 passes while the user switches apps on the physical display mid-run', async t => {
    const { result, sent } = await simulate(t, { userSwitchesAt: 'after-dump-before' });
    assert.equal(result.status, 'PASSED', JSON.stringify(result.errors));
    assert.equal(result.protocol, 'M4-F3W'); assert.equal(result.gates.A4, 'CONTROL_TOUCH_PASSED'); assert.equal(result.gates.A3, 'PASSED');
    assert.equal(sent.length, 2);
    assert.ok(result.external.some(x => x.focus.includes('tv.danmaku.bili')));
    assert.equal(result.cleanup.status, 'PASSED');
});
test('F3 tolerates locked/asleep physical display at start', async t => {
    const { result } = await simulate(t, { locked: true, asleep: true });
    assert.equal(result.status, 'PASSED', JSON.stringify(result.errors));
    assert.deepEqual(result.physicalAtStart, { wakefulness: 'Asleep', unlocked: false });
});
test('F3 retries a transient null physical focus but fails a persistent one', async t => {
    assert.equal((await simulate(t, { nullFocusSamples: 2 })).result.status, 'PASSED');
    const { result, sent } = await simulate(t, { nullFocusSamples: 99 });
    assert.ok(result.errors.includes('CAUSAL_PHYSICAL_FOCUS_NULL')); assert.equal(sent.length, 0);
});
test('F3 fails on session-caused violations even though the physical identity is intact', async t => {
    for (const [change, code, wrote] of [
        [{ fixtureOnPhysical: true }, 'CAUSAL_FIXTURE_ON_PHYSICAL', 0],
        [{ topFocusTarget: true }, 'CAUSAL_TARGET_TOOK_TOP_FOCUS', 2],
        [{ extraEvent: ev('wm_set_resumed_activity', '0,com.vcpchat.m4fixture/.MainActivity,x') }, 'CAUSAL_FIXTURE_BECAME_TOP_RESUMED', 0],
        [{ noCoverage: true }, 'CAUSAL_LOGCAT_WINDOW_UNPROVEN', 0],
    ]) {
        const { result, sent, labels } = await simulate(t, change);
        assert.ok(result.errors.includes(code), JSON.stringify([change, result.errors]));
        assert.equal(sent.length, wrote); assert.ok(labels.includes('session-stop'));
    }
});
const u2Xml = (display, taps) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" display-id="0" package="com.android.launcher" bounds="[0,0][1440,3168]" /><node index="0" text="" display-id="${display}" package="${P.PACKAGE}" bounds="[0,0][720,1280]"><node index="1" text="M4 TAP ${taps}" resource-id="${ID}" display-id="${display}" bounds="[39,244][681,374]" /></node></hierarchy>`;
test('F3 A3_CARRIER attributes via node display-id, records warm latency, and releases the carrier', async t => {
    const { result, labels } = await simulate(t, { carrierXml: taps => u2Xml(12, taps) });
    assert.equal(result.status, 'PASSED', JSON.stringify(result.errors));
    assert.equal(result.gates.A3_CARRIER, 'PASSED');
    assert.equal(result.perf.carrierMs.length, 6); assert.equal(result.perf.cliMs, undefined);
    assert.equal(result.gates.A3, 'NOT_RUN_CARRIER_EXCLUSIVE'); assert.ok(!labels.some(l => l.startsWith('a3-dump')));
    assert.equal(labels.filter(l => l === 'carrier-dump:false').length, 7);
    assert.ok(labels.indexOf('carrier-stop') < labels.indexOf('session-stop'));
});
test('F3 A3_CARRIER waits out empty trees after start before attributing; never-ready fails closed', async t => {
    const ok = await simulate(t, { carrierXml: taps => u2Xml(12, taps), emptyFirst: 3 });
    assert.equal(ok.result.status, 'PASSED', JSON.stringify(ok.result.errors));
    assert.equal(ok.result.perf.carrierReadyAttempts, 4); assert.equal(ok.result.a3.carrierBefore.kind, 'ATTRIBUTED');
    const never = await simulate(t, { carrierXml: taps => u2Xml(12, taps), emptyFirst: 1e9 });
    assert.ok(never.result.errors.includes('A3_CARRIER_NEVER_READY')); assert.equal(never.sent.length, 0);
    assert.ok(never.labels.includes('carrier-stop'));
    assert.equal(F2.classifyDump({ code: 0, stdout: `<hierarchy rotation="0" />` }, 12, { taps: 0, buttonBounds: { left: 0, top: 0, right: 1, bottom: 1 } }).kind, 'EMPTY');
});
test('F3 A3_CARRIER wrong display or start failure fails the carrier case but still records A4 and cleans up', async t => {
    const wrong = await simulate(t, { carrierXml: taps => u2Xml(0, taps) });
    assert.equal(wrong.result.gates.A3_CARRIER, 'NOT_SUPPORTED'); assert.equal(wrong.result.gates.A4, 'CONTROL_TOUCH_PASSED');
    assert.equal(wrong.result.status, 'FAILED'); assert.ok(wrong.result.errors.includes('A3_CARRIER_NOT_SUPPORTED'));
    assert.ok(wrong.labels.includes('carrier-stop')); assert.equal(wrong.result.cleanup.status, 'PASSED');
    const failed = await simulate(t, { carrierXml: taps => u2Xml(12, taps), carrierStartFails: true });
    assert.equal(failed.result.gates.A3_CARRIER, 'NOT_SUPPORTED'); assert.equal(failed.result.status, 'FAILED');
    assert.equal(failed.result.a3.carrierStart, 'UI_SERVER_START_FAILED');
});
test('F3 pinned evidence ignores physical focus but rejects a different physical display', async () => {
    const expected = { logicalId: 0, uniqueId: 'local:1', size: { width: 1440, height: 3168 }, focus: 'Window{a u0 x/.A}' };
    class Base { async snapshot() { return this.value; } }
    const Pinned = F2.pinnedEvidence(expected, Base, true);
    const p = new Pinned();
    p.value = { displays: [{ ...expected, focus: 'Window{z u0 tv.danmaku.bili/.Main}' }], wakefulness: 'Asleep' };
    await p.snapshot('before');
    p.value = { displays: [{ ...expected, uniqueId: 'local:9' }], wakefulness: 'Awake' };
    await assert.rejects(() => p.snapshot('before'), { code: 'F3_PHYSICAL_IDENTITY_CHANGED' });
});
