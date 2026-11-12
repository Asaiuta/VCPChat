'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AdbClient, AdbError } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');

// Source-derived, reduced fixtures, NOT device captures. AOSP android-14.0.0_r1:
// https://github.com/aosp-mirror/platform_frameworks_base/blob/android-14.0.0_r1/services/core/java/com/android/server/wm/DisplayContent.java
// DisplayContent.dump prints cur from mDisplayInfo.logicalWidth/logicalHeight.
// https://github.com/aosp-mirror/platform_frameworks_base/blob/android-14.0.0_r1/services/core/java/com/android/server/wm/DisplayRotation.java
// DisplayRotation.dump prints mRotation, distinct from requested/user/sensor rotation.
// https://github.com/aosp-mirror/platform_frameworks_base/blob/android-14.0.0_r1/services/core/java/com/android/server/policy/keyguard/KeyguardStateMonitor.java
const PORTRAIT = `WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  Display: mDisplayId=0
    init=1080x2400 420dpi cur=1080x2400 app=1080x2250 rng=1080x950-2400x2250
  mCurrentFocus=Window{abc123 u0 com.example/.Main}
  mFocusedApp=ActivityRecord{def u0 com.other/.Other t1}
  DisplayRotation
    mCurrentAppOrientation=SCREEN_ORIENTATION_UNSPECIFIED
    mLastOrientation=-1
    mRotation=0 mDeferredRotationPauseCount=0
    mUserRotationMode=USER_ROTATION_FREE mUserRotation=ROTATION_90 mCameraRotationMode=0
  Input monitor:
    mRotation=3
`;
const LANDSCAPE = `  Display: mDisplayId=0 (organized)
    init=1080x2400 420dpi base=720x1600 320dpi cur=1600x720 app=1600x650 rng=720x650-1600x1500
  mCurrentFocus=Window{land u0 com.example/.Video}
  DisplayRotation
    mRotation=1 mDeferredRotationPauseCount=0
`;
const UPSIDE_DOWN = `  Display: mDisplayId=0
    init=1080x2400 420dpi cur=1080x2400 app=1080x2250 rng=1080x950-2400x2250
  mCurrentFocus=Window{up u0 com.example/.Main}
  DisplayRotation
    mRotation=2 mDeferredRotationPauseCount=0
`;
const POLICY = `WINDOW MANAGER POLICY STATE (dumpsys window policy)
  KeyguardServiceDelegate
    showing=true
    inputRestricted=true
    KeyguardStateMonitor
      mIsShowing=false
      mSimSecure=false
      mInputRestricted=false
      mTrusted=false
      mCurrentUserId=0
`;
function response(windowText = PORTRAIT, policy = POLICY, power = '  mWakefulness=Awake') {
    return `${windowText}\n@@VCP_POLICY@@\n${policy}\n@@VCP_POWER@@\n${power}\n@@VCP_END@@\n`;
}
function stub(text) {
    const client = new AdbClient({ adbPath: 'must-not-execute', serial: 'default' });
    const calls = [];
    client.runText = async (args, options) => { calls.push({ args, options }); return text; };
    return { client, calls };
}

// Reduced fields captured on PJZ110 / Android 17 during the 2026-11-05 fixture run.
const PJZ110_POLICY = `WINDOW MANAGER POLICY STATE (dumpsys window policy)
    KeyguardServiceDelegate
      showing=false
      inputRestricted=false
`;
test('fresh probe: real PJZ110 delegate and agreeing numeric wake state establish context', async () => {
    const { client } = stub(response(PORTRAIT, PJZ110_POLICY, '  mWakefulness=Awake\nmWakefulness=1'));
    const result = await client.probeScreen('A', { fresh: true });
    assert.equal(result.wakefulness, 'Awake');
    assert.deepEqual(result.keyguard, { showing: false, inputRestricted: false });
});

test('fresh probe: vendor wake state must agree with one authoritative named state', async () => {
    for (const power of ['mWakefulness=1', 'mWakefulness=Awake\nmWakefulness=0',
        'mWakefulness=Awake\nmWakefulness=4', 'mWakefulness=Awake\nmWakefulness=1\nmWakefulness=1',
        'mWakefulness=Awake\nmWakefulness=Awake']) {
        const { client } = stub(response(PORTRAIT, PJZ110_POLICY, power));
        assert.equal((await client.probeScreen('A', { fresh: true })).wakefulness, null, power);
    }
});

test('fresh probe: delegate evidence cannot replace an incomplete monitor or ambiguous delegate', async () => {
    for (const policy of [PJZ110_POLICY + PJZ110_POLICY,
        PJZ110_POLICY + '      KeyguardStateMonitor\n        mIsShowing=false\n',
        PJZ110_POLICY.replace('showing=false', 'showing=false\n      showing=true')]) {
        const { client } = stub(response(PORTRAIT, policy));
        const { keyguard } = await client.probeScreen('A', { fresh: true });
        assert.ok(keyguard.showing !== false || keyguard.inputRestricted !== false);
    }
});
for (const [name, fixture, rotation, size] of [
    ['portrait', PORTRAIT, 0, { width: 1080, height: 2400 }],
    ['landscape with override', LANDSCAPE, 1, { width: 1600, height: 720 }],
    ['180 degrees (same dimensions)', UPSIDE_DOWN, 2, { width: 1080, height: 2400 }],
    ['270 degrees', LANDSCAPE.replace('mRotation=1', 'mRotation=3'), 3, { width: 1600, height: 720 }],
]) {
    test(`fresh probe: ${name}`, async () => {
        const { client, calls } = stub(response(fixture));
        client.sizeCache.set('A', { width: 1, height: 2 });
        const result = await client.probeScreen('A', { fresh: true });
        assert.equal(result.rotation, rotation);
        assert.deepEqual(result.size, size);
        assert.equal(result.displayId, 0);
        assert.equal(result.awake, true);
        assert.equal(result.wakefulness, 'Awake');
        assert.equal(result.focus.package, 'com.example');
        assert.match(result.focus.component, /^com.example\//);
        assert.match(result.focus.window, /^Window\{/);
        assert.deepEqual(result.keyguard, { showing: false, inputRestricted: false });
        assert.deepEqual(client.sizeCache.get('A'), { width: 1, height: 2 });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].args[0], 'shell');
        assert.doesNotMatch(calls[0].args[1], /wm size|uiautomator|input |screencap/);
        assert.match(calls[0].args[1], /dumpsys window displays/);
        assert.match(calls[0].args[1], /dumpsys window policy/);
        assert.match(calls[0].args[1], /dumpsys power/);
        assert.equal(calls[0].options.serial, 'A');
    });
}

test('fresh probe: unknown output never uses cached or physical dimensions', async () => {
    const { client } = stub(response('Physical size: 1080x2400\nmCurrentFocus=Window{abc u0 com.example/.Main}', '', 'mWakefulness=Unknown'));
    client.sizeCache.set('A', { width: 1080, height: 2400 });
    const result = await client.probeScreen('A', { fresh: true });
    for (const key of ['size', 'rotation', 'displayId', 'wakefulness', 'awake']) assert.equal(result[key], null);
    assert.equal(result.focus.component, null);
    assert.deepEqual(result.keyguard, { showing: null, inputRestricted: null });
});

for (const extra of ['  Display: mDisplayId=1\n  mCurrentFocus=Window{other u0 com.other/.Main}', '  Display: mDisplayId=0', '  Display: unknown']) {
    test(`fresh probe: ambiguous display rejects all coordinate fields: ${extra}`, async () => {
        const { client } = stub(response(PORTRAIT + extra));
        const result = await client.probeScreen('A', { fresh: true });
        assert.equal(result.displayId, null);
        assert.equal(result.size, null);
        assert.equal(result.rotation, null);
        assert.equal(result.focus.window, null);
    });
}

test('fresh probe: null/unknown/duplicate focus does not fall back to focused app', async () => {
    for (const focus of ['mCurrentFocus=null', 'mCurrentFocus=Window{abc StatusBar}', 'mCurrentFocus=Window{abc u0 com.example/.Main}\n  mCurrentFocus=null']) {
        const { client } = stub(response(PORTRAIT.replace('mCurrentFocus=Window{abc123 u0 com.example/.Main}', focus)));
        const result = await client.probeScreen('A', { fresh: true });
        assert.equal(result.focus.window, null);
        assert.equal(result.focus.component, null);
        assert.equal(result.focus.package, null);
    }
});

test('fresh probe: requested/sensor/history rotation cannot replace current display rotation', async () => {
    for (const replacement of ['mUserRotation=1', 'mRotation=90', 'mRotation=ROTATION_90', 'mRotation=4', 'mRotation=-1', 'mRotation=0\n    mRotation=1']) {
        const { client } = stub(response(PORTRAIT.replace('mRotation=0', replacement)));
        assert.equal((await client.probeScreen('A', { fresh: true })).rotation, null);
    }
});

test('fresh probe: dimensions require positive safe current logical size, not init/base/app', async () => {
    for (const replacement of ['', 'cur=0x2400 ', 'cur=999999999999999999999x2400 ']) {
        const { client } = stub(response(PORTRAIT.replace('cur=1080x2400 ', replacement)));
        assert.equal((await client.probeScreen('A', { fresh: true })).size, null);
    }
});

test('fresh probe: keyguard monitor missing, conflicting or scoped elsewhere stays unknown', async () => {
    for (const policy of ['', 'showing=false\ninputRestricted=false', 'KeyguardStateMonitor\nOtherSection\n  mIsShowing=false\n  mInputRestricted=false', POLICY + POLICY]) {
        const { client } = stub(response(PORTRAIT, policy));
        assert.deepEqual((await client.probeScreen('A', { fresh: true })).keyguard, { showing: null, inputRestricted: null });
    }
    const { client } = stub(response(PORTRAIT, POLICY.replace('mIsShowing=false', 'mIsShowing=true')));
    assert.deepEqual((await client.probeScreen('A', { fresh: true })).keyguard, { showing: true, inputRestricted: false });
});

test('fresh probe: CRLF accepted; missing/duplicate delimiter or truncated sample invalidates all evidence', async () => {
    const normal = response();
    const { client } = stub(normal.replace(/\n/g, '\r\n'));
    assert.equal((await client.probeScreen('A', { fresh: true })).rotation, 0);
    for (const text of [normal.replace('@@VCP_END@@', ''), normal + '@@VCP_END@@\n', normal.replace('@@VCP_POLICY@@', '')]) {
        const { client: broken } = stub(text);
        const result = await broken.probeScreen('A', { fresh: true });
        assert.equal(result.rotation, null);
        assert.equal(result.awake, null);
        assert.equal(result.focus.window, null);
    }
});

test('fresh probe: dumpsys internal timeout is not a valid partial sample', async () => {
    const { client } = stub(response(PORTRAIT + '\n*** SERVICE DUMP TIMEOUT EXPIRED ***\n'));
    await assert.rejects(client.probeScreen('A', { fresh: true }), { code: 'ADB_TIMEOUT' });
    assert.equal(client.sizeCache.size, 0);
});

test('fresh probe: non-awake and conflicting power evidence remain distinct', async () => {
    for (const state of ['Asleep', 'Dozing', 'Dreaming']) {
        const { client } = stub(response(PORTRAIT, POLICY, `mWakefulness=${state}`));
        const result = await client.probeScreen('A', { fresh: true });
        assert.equal(result.awake, false);
        assert.equal(result.wakefulness, state);
    }
    const { client } = stub(response(PORTRAIT, POLICY, 'mWakefulness=Awake\nmWakefulness=Asleep'));
    assert.equal((await client.probeScreen('A', { fresh: true })).awake, null);
});

test('fresh probe: every invocation samples anew and forwards explicit cancellation/deadline', async () => {
    const { client, calls } = stub(response());
    const signal = new AbortController().signal;
    const options = { fresh: true, signal, timeoutMs: 1234, deadlineMs: Date.now() + 999 };
    await client.probeScreen('A', options);
    await client.probeScreen('A', options);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.signal, signal);
    assert.equal(calls[0].options.deadlineMs, options.deadlineMs);
    assert.equal(calls[0].options.timeoutMs, 1234);
    assert.equal(client.sizeCache.size, 0);
});

for (const code of ['ADB_ABORTED', 'ADB_TIMEOUT', 'ADB_FAILED']) {
    test(`fresh probe: ${code} propagates unchanged without cache poisoning`, async () => {
        const client = new AdbClient({ adbPath: 'must-not-execute' });
        const error = new AdbError(code, 'fixture failure');
        client.runText = async () => { throw error; };
        await assert.rejects(client.probeScreen('A', { fresh: true }), (caught) => caught === error);
        assert.equal(client.sizeCache.size, 0);
        client.runText = async () => response(LANDSCAPE);
        assert.equal((await client.probeScreen('A', { fresh: true })).rotation, 1);
    });
}

test('fresh probe: inherited context abort/deadline rejects before any subprocess', async () => {
    const client = new AdbClient({ adbPath: 'must-not-execute' });
    let executions = 0;
    client.runRaw = async () => { executions += 1; return { stdout: response() }; };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.withContext({ signal: controller.signal }, () => client.probeScreen('A', { fresh: true })), { code: 'ADB_ABORTED' });
    await assert.rejects(client.withContext({ deadlineMs: Date.now() - 10 }, () => client.probeScreen('A', { fresh: true })), { code: 'ADB_TIMEOUT' });
    assert.equal(executions, 0);
});

test('default probe and screenSize preserve existing shape, override preference, serial cache and permissive failure', async () => {
    const text = 'mCurrentFocus=Window{old u0 com.example/.Main}\n@@VCP_SIZE@@\nPhysical size: 1080x2400\nOverride size: 720x1600\n@@VCP_POWER@@\nmWakefulness=Awake';
    const { client, calls } = stub(text);
    const first = await client.probeScreen('A');
    assert.deepEqual(Object.keys(first).sort(), ['focus', 'size', 'wakefulness']);
    assert.deepEqual(first.size, { width: 720, height: 1600 });
    await client.probeScreen('A', { fresh: false });
    assert.match(calls[0].args[1], /wm size/);
    assert.doesNotMatch(calls[1].args[1], /wm size/);
    assert.deepEqual(await client.screenSize('A'), first.size);
    assert.equal(calls.length, 2);
    await client.probeScreen('B');
    assert.match(calls[2].args[1], /wm size/);
    client.runText = async () => { throw new AdbError('ADB_FAILED', 'legacy fixture'); };
    assert.deepEqual((await client.probeScreen('A')).size, first.size);
    assert.equal((await client.probeScreen('C')).size, null);
    assert.equal(client.sizeCache.has('C'), false);
});
