'use strict';
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
const [serial, pkg] = process.argv.slice(2);
if (!serial || !pkg) throw new Error('Usage: node scripts/check-android-url.cjs SERIAL BROWSER_PACKAGE');
const logger = { log() {}, warn() {} };
(async () => {
    const client = new AdbClient({ serial, timeoutMs: 5000, logger });
    const probe = await client.probeScreen(serial);
    if (probe.wakefulness !== 'Awake') throw Object.assign(new Error(), { code: 'SCREEN_NOT_AWAKE' });
    try {
        await service.initialize({ config: { DEVICE_SERIAL: serial, DISPLAY_PORT: 0, AUTO_WAKE: false }, logger });
        const screen = await service.processToolCall({ command: 'Observe', serial, wake: 'never', timeoutMs: 20000 });
        if (screen.details.keyguard) throw Object.assign(new Error(), { code: 'DEVICE_LOCKED_OR_SEMANTICS_UNAVAILABLE' });
        const result = await service.processToolCall({ command: 'ExecuteStep', serial, action: { command: 'LaunchApp', package: pkg, url: 'https://example.com/' }, afterObserve: true, timeoutMs: 25000 });
        console.log(JSON.stringify({ outcome: result.details.execution.outcome, foregroundMatched: result.details.ok, pageLoaded: result.details.pageLoaded, observation: result.details.observation.status, controls: result.details.observation.controls?.length, durationMs: result.details.execution.timings.totalMs }));
        if (!result.details.ok || result.details.observation.status !== 'observed') process.exitCode = 1;
    } finally { await service.cleanup(); }
})().catch(error => { console.error(JSON.stringify({ code: error.code || 'LIVE_URL_FAILED', outcome: error.execution?.outcome || 'failed' })); process.exitCode = 1; });
