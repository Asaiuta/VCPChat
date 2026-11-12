'use strict';

const assert = require('node:assert/strict');
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const { autoConnectDevice } = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService')._internals;

async function main() {
    const client = new AdbClient({ adbPath: process.argv[2] || process.env.ADB_PATH || 'adb' });
    console.log('Before:', JSON.stringify({ devices: await client.devices(), mdns: await client.mdnsServices() }));
    const started = Date.now();
    const result = await autoConnectDevice(client);
    assert.equal(result.ok, true);
    const devices = await client.devices();
    assert.ok(devices.some((device) => device.serial === result.serial && device.state === 'device'));
    console.log('Result:', JSON.stringify({ ...result, elapsedMs: Date.now() - started, devices }, null, 2));
}

main().catch((error) => {
    console.error(error.code || 'ERROR', error.message, error.hint || '');
    process.exitCode = 1;
});
