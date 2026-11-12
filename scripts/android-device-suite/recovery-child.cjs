'use strict';
// A separate host process must load the pending marker before any input/owner start.
const assert = require('node:assert/strict');
const service = require('../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
async function main() {
    const [dataDir, adb, serial] = process.argv.slice(2); assert.ok(dataDir && adb && serial);
    await service.initialize({ dataDir, config: { ADB_PATH: adb, DEVICE_SERIAL: serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0 }, logger: { log() {}, warn() {}, error() {} } });
    const codes = [];
    try {
        for (const request of [
            { command: 'Observe', serial, mode: 'ui', wake: 'never' },
            { command: 'ExecuteStep', serial, action: { command: 'LongPress', id: 'com.vcpchat.m15fixture:id/jd_touch', duration: 800 } },
            { command: 'Manage', serial, operation: 'recoverOwner' },
        ]) {
            let error; try { await service.processToolCall(request); } catch (e) { error = e; }
            assert.ok(error); codes.push(error.code);
        }
        assert.deepEqual(codes, ['DEVICE_STATE_UNCERTAIN', 'DEVICE_STATE_UNCERTAIN', 'DEVICE_INPUT_STATE_UNCERTAIN']);
        console.log(JSON.stringify({ codes, realModelRequests: 0 }));
    } finally { await service.cleanup(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
