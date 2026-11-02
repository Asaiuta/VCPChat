'use strict';

const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
const serial = process.argv[2];
const move = process.argv[3] === '--scroll';
if (!serial || process.argv.slice(3).some(arg => arg !== '--scroll')) throw new Error('Usage: node scripts/check-android-scroll.cjs SERIAL [--scroll]');
const quiet = { log() {}, warn() {}, error() {} };

(async () => {
    const client = new AdbClient({ serial, timeoutMs: 5000, logger: quiet });
    const probe = await client.probeScreen(serial);
    console.log(JSON.stringify({ phase: 'probe', package: probe.focus?.package, wakefulness: probe.wakefulness, screen: probe.size }));
    if (probe.wakefulness !== 'Awake') throw Object.assign(new Error(), { code: 'SCREEN_NOT_AWAKE' });
    try {
        await service.initialize({ config: { DEVICE_SERIAL: serial, DISPLAY_PORT: 0, AUTO_WAKE: false }, logger: quiet });
        const observed = await service.processToolCall({ command: 'Observe', serial, wake: 'never', limit: 500, timeoutMs: 20000 });
        const before = observed.details;
        const candidates = before.controls.filter(node => node.enabled && node.inViewport && node.flags.includes('scroll') && node.clipped && node.clipped.right - node.clipped.left >= 16 && node.clipped.bottom - node.clipped.top >= 16);
        console.log(JSON.stringify({ phase: 'observe', controls: before.controls.length, scrollTargets: candidates.length, keyguard: before.keyguard, outcome: before.execution.outcome }));
        if (!move) return;
        if (before.keyguard || candidates.length !== 1) throw Object.assign(new Error(), { code: 'NEED_UNAMBIGUOUS_SCROLL_TARGET' });
        if (before.focus?.package !== probe.focus?.package) throw Object.assign(new Error(), { code: 'FOREGROUND_CHANGED' });
        const current = await client.probeScreen(serial);
        if (current.wakefulness !== 'Awake' || current.focus?.package !== before.focus?.package) throw Object.assign(new Error(), { code: 'DEVICE_STATE_CHANGED' });
        const result = await service.processToolCall({
            command: 'ExecuteStep', serial, timeoutMs: 25000,
            action: { command: 'Scroll', index: candidates[0].index, snapshotId: before.snapshotId, direction: 'down', distance: 0.4, duration: 400 },
            afterObserve: true,
        });
        const after = result.details.observation;
        console.log(JSON.stringify({ phase: 'scroll', outcome: result.details.execution.outcome, durationMs: result.details.execution.timings.totalMs, observation: after.status, controls: after.controls?.length, pageChanged: after.signature ? after.signature !== before.signature : null, newSnapshot: after.snapshotId ? after.snapshotId !== before.snapshotId : false, samePackage: after.focus?.package === before.focus?.package }));
        if (after.status !== 'observed') process.exitCode = 1;
    } finally { await service.cleanup(); }
})().catch(error => { console.error(JSON.stringify({ code: error.code || 'LIVE_CHECK_FAILED', outcome: error.execution?.outcome || 'failed' })); process.exitCode = 1; });
