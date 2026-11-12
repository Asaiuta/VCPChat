'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

// Test environment control only. Production recovery never restarts devices.
function restartDevice(device, options, emit, run = execFileSync) {
    if (!options.mumuManager) { device.exec(['reboot']); return; }
    const invoke = args => run(options.mumuManager, args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const info = JSON.parse(invoke(['info', '-v', options.mumuInstance]));
    assert.equal(info.error_code, 0, 'MuMu instance query failed');
    assert.equal(String(info.index), options.mumuInstance, 'MuMu instance mismatch');
    assert.equal(info.adb_host_ip, '127.0.0.1', 'MuMu must expose a local endpoint');
    assert.ok(Number.isInteger(info.adb_port) && info.adb_port > 0 && info.adb_port <= 65535);
    assert.equal(options.serial, `127.0.0.1:${info.adb_port}`, 'MuMu instance does not own the selected serial');
    emit('instance-restart', { instance: options.mumuInstance, serial: options.serial, previousPid: info.pid });
    const output = invoke(['control', '-v', options.mumuInstance, 'restart']);
    emit('instance-restart-command', { output: String(output).trim() });
    assert.equal(JSON.parse(output).errcode, 0, 'MuMu restart rejected');
}
module.exports = { restartDevice };
