'use strict';

// node scripts/check-android-p2.cjs OWNER REPO NUMBER [SERIAL]
// Does not navigate, click, wake, submit, load credentials or invoke a real model.
const service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
async function main() {
    const [owner, repo, number, serial] = process.argv.slice(2);
    if (!owner || !repo || !number) throw new Error('Usage: OWNER REPO NUMBER [SERIAL]');
    await service.initialize({ config: { DISPLAY_PORT: 0, DEVICE_SERIAL: serial || '', AUTO_WAKE: false }, logger: { log() {}, warn() {} } });
    try {
        const result = await service.processToolCall({ command: 'Observe', mode: 'api', capability: 'github-public-issue', params: { owner, repo, number } });
        console.log(JSON.stringify({ kind: 'api', ...result.details.api }));
        if (serial) {
            const observed = await service.processToolCall({ command: 'Observe', serial, limit: 60, timeoutMs: 30000 });
            const { snapshotId, observedAt, controls, total, truncated, stability, focus, execution } = observed.details;
            console.log(JSON.stringify({ kind: 'observe', serial, snapshotId, observedAt, package: focus?.package, controls: controls.length, total, truncated, stability, timings: execution.timings }));
            const advice = await service.processToolCall({ command: 'Observe', mode: 'arbitrate', serial, arbitration: { snapshotId, mode: 'recovery' }, timeoutMs: 5000 });
            console.log(JSON.stringify({ kind: 'recovery-no-jev', ...advice.details.arbitration }));
        }
    } finally { await service.cleanup(); }
}
main().catch(error => { console.error(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1; });
