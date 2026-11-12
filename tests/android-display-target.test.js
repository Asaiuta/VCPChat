'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../VCPDistributedServer/Plugin/AndroidController/lib/display-target');
const context = require('../VCPDistributedServer/Plugin/AndroidController/lib/context');
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const { displayScopedGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/window-evidence');

// Reduced from PJZ110 / Android 17 F3W case-05 (2026-11-06): the virtual display is dumped first.
const MULTI_WINDOW = `WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  Display: mDisplayId=191 (organized)
    init=720x1280 260dpi mMinSizeOfResizeableTaskDp=220 cur=720x1280 app=720x1280 rng=720x720-1280x1280
  mCurrentFocus=Window{17090a3 u0 com.vcpchat.m4fixture/com.vcpchat.m4fixture.MainActivity}
  mFocusedApp=null
  DisplayRotation
    mRotation=0 mDeferredRotationPauseCount=0
  Display: mDisplayId=0 (organized)
    init=1440x3168 640dpi mMinSizeOfResizeableTaskDp=220 cur=1440x3168 app=1440x3168 rng=1440x1440-3168x3168
  mCurrentFocus=Window{ce92517 u0 com.mihoyo.hyperion/com.mihoyo.hyperion.web2.MiHoYoWebActivity}
  mFocusedApp=ActivityRecord{6364018 u0 com.mihoyo.hyperion/.web2.MiHoYoWebActivity t49217}
  DisplayRotation
    mRotation=0 mDeferredRotationPauseCount=0
`;
const DISPLAY_DUMP = `DISPLAY MANAGER (dumpsys display)
  Logical Displays: size=2
  Display 0:
    mDisplayId=0
    mPrimaryDisplayDevice=内置屏幕(local:4630946756802996883)
  Display 191:
    mDisplayId=191
    mPrimaryDisplayDevice=scrcpy(virtual:com.android.shell,2000,scrcpy,187)
`;
const POLICY = `WINDOW MANAGER POLICY STATE (dumpsys window policy)
    KeyguardServiceDelegate
      showing=false
      inputRestricted=false
`;
const TARGET = { displayId: 191, uniqueId: 'virtual:com.android.shell,2000,scrcpy,187', generation: '504754a7-5c1b-4c7a-8f54-7bb5cbe8cdd3' };
const scopedResponse = (win = MULTI_WINDOW, disp = DISPLAY_DUMP) =>
    `${win}\n@@VCP_POLICY@@\n${POLICY}\n@@VCP_POWER@@\n  mWakefulness=Awake\nmWakefulness=1\n@@VCP_DISPLAY@@\n${disp}\n@@VCP_END@@\n`;
const defaultResponse = win => `${win}\n@@VCP_POLICY@@\n${POLICY}\n@@VCP_POWER@@\n  mWakefulness=Awake\n@@VCP_END@@\n`;
function stub(text) {
    const client = new AdbClient({ adbPath: 'must-not-execute', serial: 'default' });
    const calls = [];
    client.runText = async (args, options) => { calls.push({ args, options }); return text; };
    return { client, calls };
}

test('P1 display target: default is the bare legacy target; non-default needs uniqueId and generation', () => {
    for (const input of [undefined, null, 0, { displayId: 0 }]) assert.equal(D.displayTarget(input).isDefault, true);
    assert.equal(D.displayTarget(TARGET).displayId, 191);
    for (const bad of [{ displayId: 191 }, { displayId: 191, uniqueId: TARGET.uniqueId }, { displayId: -1 }, { displayId: 1.5 }, 'x', [1]]) {
        assert.throws(() => D.displayTarget(bad), { code: /^DISPLAY_TARGET_/ });
    }
    assert.equal(D.displayKey('A'), 'A');
    assert.equal(D.displayKey('A', 0), 'A');
    assert.notEqual(D.displayKey('A', TARGET), D.displayKey('A', { ...TARGET, generation: 'aaaaaaaa-0000' }));
});
test('P1 dump sections and uniqueId mapping follow the real multi-display layout', () => {
    const parts = D.windowDisplaySections(MULTI_WINDOW);
    assert.deepEqual(parts.map(p => p.displayId), [191, 0]);
    assert.match(parts[0].text, /m4fixture/); assert.doesNotMatch(parts[0].text, /mihoyo/);
    assert.equal(D.displayUniqueId(DISPLAY_DUMP, 191), TARGET.uniqueId);
    assert.equal(D.displayUniqueId(DISPLAY_DUMP, 0), 'local:4630946756802996883');
    assert.equal(D.displayUniqueId(DISPLAY_DUMP, 7), null);
    assert.throws(() => D.windowDisplaySections(MULTI_WINDOW + MULTI_WINDOW), { code: 'DISPLAY_SECTION_AMBIGUOUS' });
    // A5-r2: raw adb stdout on Windows was CRLF and every header parsed as displayId=null.
    assert.deepEqual(D.windowDisplaySections(MULTI_WINDOW.replace(/\n/g, '\r\n')).map(p => p.displayId), [191, 0]);
});

test('P1 default fresh probe is unchanged: a second display still makes context unproven', async () => {
    const { client, calls } = stub(defaultResponse(MULTI_WINDOW));
    const probe = await client.probeScreen('A', { fresh: true });
    assert.equal(probe.displayId, null);
    assert.equal(context.frameContext(probe), null);
    assert.ok(!calls[0].args[1].includes('dumpsys display'));
    assert.deepEqual(Object.keys(probe).sort(), ['awake', 'displayId', 'focus', 'keyguard', 'rotation', 'size', 'wakefulness']);
    // Explicit default target takes the exact legacy path.
    const again = stub(defaultResponse(MULTI_WINDOW));
    assert.deepEqual(await again.client.probeScreen('A', { fresh: true, display: 0 }), probe);
});
test('P1 scoped probe reads only the target display and proves its uniqueId', async () => {
    const { client, calls } = stub(scopedResponse());
    const probe = await client.probeScreen('A', { fresh: true, display: TARGET });
    assert.ok(calls[0].args[1].includes('@@VCP_DISPLAY@@; dumpsys display'));
    assert.equal(probe.displayId, 191);
    assert.equal(probe.uniqueId, TARGET.uniqueId);
    assert.deepEqual(probe.size, { width: 720, height: 1280 });
    assert.equal(probe.focus.package, 'com.vcpchat.m4fixture');
    assert.equal(probe.rotation, 0);
    assert.equal(probe.wakefulness, 'Awake');
    const ctx = context.frameContext(probe, TARGET);
    assert.equal(ctx.displayId, 191); assert.equal(ctx.package, 'com.vcpchat.m4fixture');
    assert.equal(ctx.generation, TARGET.generation);
    assert.equal(context.frameContext(probe), null, 'a scoped probe is never a default-display context');
});
test('P1 scoped probe fails closed on reused id, missing section or malformed framing', async () => {
    const reused = await stub(scopedResponse(MULTI_WINDOW, DISPLAY_DUMP.replace('scrcpy,187', 'scrcpy,999'))).client.probeScreen('A', { fresh: true, display: TARGET });
    assert.equal(reused.displayId, null); assert.equal(reused.uniqueId, 'virtual:com.android.shell,2000,scrcpy,999');
    assert.equal(context.frameContext(reused, TARGET), null);
    const missing = await stub(scopedResponse(MULTI_WINDOW.replace('mDisplayId=191', 'mDisplayId=192'))).client.probeScreen('A', { fresh: true, display: TARGET });
    assert.equal(missing.displayId, null);
    const framing = await stub(defaultResponse(MULTI_WINDOW)).client.probeScreen('A', { fresh: true, display: TARGET });
    assert.equal(framing.displayId, null);
    const dup = await stub(scopedResponse(MULTI_WINDOW + MULTI_WINDOW)).client.probeScreen('A', { fresh: true, display: TARGET });
    assert.equal(dup.displayId, null);
    await assert.rejects(() => stub(scopedResponse()).client.probeScreen('A', { fresh: true, display: { displayId: 191 } }), { code: 'DISPLAY_TARGET_IDENTITY_REQUIRED' });
});
test('P1 frame context binds generation: same logical display under a new generation is a different context', async () => {
    const probe = await stub(scopedResponse()).client.probeScreen('A', { fresh: true, display: TARGET });
    const ctx = context.frameContext(probe, TARGET);
    const other = { ...TARGET, generation: 'ffffffff-0000-0000-0000-000000000000' };
    assert.equal(context.frameContext(probe, other), null);
    assert.equal(context.sameContext(ctx, { ...ctx, generation: other.generation }), false);
    assert.equal(context.sameContext(ctx, { ...ctx }), true);
    assert.notEqual(context.contextKey(ctx), context.contextKey({ ...ctx, generation: other.generation }));
});

test('P1 tracker: displays have independent epochs; device invalidation advances all; default unchanged', async () => {
    const tracker = context.createContextTracker();
    const scoped = await stub(scopedResponse()).client.probeScreen('A', { fresh: true, display: TARGET });
    assert.equal(tracker.observe('A', scoped, TARGET).epoch, 1);
    assert.equal(tracker.epoch('A'), 0, 'virtual display observation must not touch the default epoch');
    assert.equal(tracker.observe('A', scoped, TARGET).changed, false);
    assert.equal(tracker.invalidate('A', TARGET), 2);
    assert.equal(tracker.epoch('A'), 0);
    assert.equal(tracker.invalidate('A'), 1);
    assert.equal(tracker.epoch('A', TARGET), 3, 'device-level invalidation reaches every display of the serial');
    assert.equal(tracker.epoch('B', TARGET), 0);
    assert.equal(tracker.forget('A', TARGET), true);
    assert.equal(tracker.epoch('A', TARGET), 0);
    assert.equal(tracker.forget('A'), false, 'the default display cannot be forgotten');
    assert.equal(tracker.invalidate('A'), 2);
});

const u2 = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" display-id="0" package="com.mihoyo.hyperion" bounds="[0,0][1440,3168]"><node index="0" text="网页" package="com.mihoyo.hyperion" bounds="[0,0][10,10]" /></node><node index="0" text="" display-id="191" package="com.vcpchat.m4fixture" bounds="[0,0][720,1280]"><node index="1" text="M4 TAP 0" resource-id="com.vcpchat.m4fixture:id/tap_button" package="com.vcpchat.m4fixture" clickable="true" bounds="[39,244][681,374]" /></node><node index="0" display-id="0" package="com.android.systemui" bounds="[0,0][1440,100]" /></hierarchy>`;
test('P1 carrier XML is cut to the target display before parsing', () => {
    const cut = D.filterHierarchyByDisplay(u2, 191);
    assert.equal(cut.roots, 3); assert.equal(cut.kept, 1);
    assert.match(cut.xml, /M4 TAP 0/); assert.doesNotMatch(cut.xml, /mihoyo|systemui/);
    assert.match(cut.xml, /^<hierarchy rotation="0">[\s\S]*<\/hierarchy>$/);
    assert.equal(D.filterHierarchyByDisplay(u2, 0).kept, 2);
    assert.equal(D.filterHierarchyByDisplay(u2, 5).kept, 0);
    assert.equal(D.filterHierarchyByDisplay(`<hierarchy rotation="0" />`, 191).kept, 0);
});
test('P1 carrier filter fails closed on unattributed roots or broken trees', () => {
    assert.throws(() => D.filterHierarchyByDisplay(u2.replace('display-id="191" ', ''), 191), { code: 'DISPLAY_ATTRIBUTION_UNPROVEN' });
    assert.throws(() => D.filterHierarchyByDisplay(u2.replace('display-id="0" package="com.android.systemui"', 'display-id="x" package="s"'), 191), { code: 'DISPLAY_ATTRIBUTION_UNPROVEN' });
    const unbalanced = u2.replace('</node><node index="0" text="" display-id="191"', '<node index="0" text="" display-id="191"');
    assert.notEqual(unbalanced, u2);
    assert.throws(() => D.filterHierarchyByDisplay(unbalanced, 191), { code: 'DISPLAY_TREE_INVALID' });
    assert.throws(() => D.filterHierarchyByDisplay('not xml', 191), { code: 'DISPLAY_TREE_INVALID' });
});
test('P1 display-scoped graph parses only target nodes and refuses to replace the default path', () => {
    const { graph, keptRoots, displayId } = displayScopedGraph(u2, TARGET, { limit: 500, screen: { width: 720, height: 1280 } });
    assert.equal(displayId, 191); assert.equal(keptRoots, 1);
    assert.deepEqual(graph.controls.map(c => c.text).filter(Boolean), ['M4 TAP 0']);
    assert.ok(graph.controls.every(c => c.package === 'com.vcpchat.m4fixture'));
    assert.throws(() => displayScopedGraph(u2, 0), { code: 'DISPLAY_SCOPE_DEFAULT_UNCHANGED' });
});
