'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const vision = require('../VCPDistributedServer/Plugin/AndroidController/lib/vision');
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const { harness } = require('./helpers/android-service-harness.cjs');
// Reduced AOSP dump format, not a captured device/ROM compatibility claim.
const dump = rotation => `  Display: mDisplayId=0
    init=100x200 420dpi cur=100x200 app=100x180 rng=100x80-200x180
  mCurrentFocus=Window{abc u0 com.example/.Main}
  DisplayRotation
    mRotation=${rotation} mDeferredRotationPauseCount=0
@@VCP_POLICY@@
  KeyguardStateMonitor
    mIsShowing=false
    mInputRestricted=false
@@VCP_POWER@@
  mWakefulness=Awake
@@VCP_END@@
`;
for (const changed of [false, true]) test(`real parser and image encoder ${changed ? 'reject rotation change' : 'authorize stable context'}`, async () => {
    let rotation = 0;
    const parser = new AdbClient({ adbPath: 'must-not-execute' });
    parser.runText = async () => dump(rotation);
    const h = await harness({ uiServer: { ok: true }, vision,
        client: { probeScreen: parser.probeScreen.bind(parser) },
        frames: { requireSharp: () => sharp, async captureOneShot() {
            return { raw: { data: Buffer.alloc(100 * 200 * 4, 100), width: 100, height: 200, channels: 4 } };
        } } });
    try {
        const shot = await h.service.processToolCall({ command: 'Observe', mode: 'image', serial: 'A', grid: false });
        assert.equal(shot.details.image.actionable, true);
        assert.equal(shot.details.image.sourceWidth, 100);
        assert.equal(shot.details.image.sourceHeight, 200);
        assert.equal((await sharp(Buffer.from(shot.details.image.dataUrl.split(',')[1], 'base64')).metadata()).width, shot.details.image.width);
        rotation = changed ? 2 : 0;
        const action = h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', x: 10, y: 20, frameId: shot.details.frameId } });
        if (changed) await assert.rejects(action, { code: 'STALE_FRAME' });
        else assert.equal((await action).details.execution.outcome, 'dispatched');
        assert.equal(h.calls.filter(call => call[0] === 'rpc').length, changed ? 0 : 1);
    } finally { await h.service.cleanup(); }
});
