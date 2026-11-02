'use strict';
const service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
const serial = process.argv[2];
if (!serial) throw new Error('Usage: node scripts/check-android-snapshot.cjs SERIAL');
(async () => {
    try {
        await service.initialize({ config: { DEVICE_SERIAL: serial, DISPLAY_PORT: 0, AUTO_WAKE: false }, logger: { log() {}, warn() {} } });
        const read = async () => (await service.processToolCall({ command: 'Observe', serial, wake: 'never', limit: 500, timeoutMs: 20000 })).details;
        const before = await read();
        const after = await read();
        const changes = [];
        for (let i = 0; i < Math.max(before.controls.length, after.controls.length); i++) {
            const a = before.controls[i], b = after.controls[i];
            const fields = ['id', 'label', 'value', 'flags', 'x', 'y', 'bounds'].filter(key => JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key]));
            if (fields.length) changes.push({ index: i, fields });
        }
        console.log(JSON.stringify({ beforeCount: before.controls.length, afterCount: after.controls.length, sameSignature: before.signature === after.signature, sameScreen: JSON.stringify(before.screen) === JSON.stringify(after.screen), intervalMs: after.observedAt - before.observedAt, changes }));
    } finally { await service.cleanup(); }
})().catch(error => { console.error(JSON.stringify({ code: error.code || 'DIAGNOSTIC_FAILED' })); process.exitCode = 1; });
