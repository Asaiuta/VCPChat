'use strict';

/**
 * 采集脚本的序列号解析契约。
 *
 * 动机（2026-11-02 真机复采）：三个脚本的默认序列号都写死为某次热点会话的
 * `192.168.137.178:37109`。换网络后该地址失效，但脚本照常跑完、`--check`
 * 照常 pass，只有一行 adb 报错混在输出里 —— 静默账错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSerial, tryResolveSerial } = require('../scripts/lib/resolve-serial.cjs');

const LIST = [
    'List of devices attached',
    'adb-beca2585-utuYDs._adb-tls-connect._tcp\tdevice product:PJZ110',
    'R58M12345\tunauthorized',
    '',
].join('\n');

test('显式 PERF_SERIAL 优先于列表', () => {
    assert.equal(pickSerial(LIST, 'R58M99999'), 'R58M99999');
});

test('未给显式值时取第一台 device 状态的设备（含 mDNS 序列号）', () => {
    assert.equal(pickSerial(LIST, ''), 'adb-beca2585-utuYDs._adb-tls-connect._tcp');
});

test('unauthorized / offline 不算可用设备', () => {
    const only = 'List of devices attached\nR58M12345\tunauthorized\nR58M22222\toffline\n';
    assert.equal(pickSerial(only, ''), null);
});

test('空列表返回 null，由调用方报错退出而不是回退到历史地址', () => {
    assert.equal(pickSerial('List of devices attached\n\n', ''), null);
    assert.equal(pickSerial('', ''), null);
});

test('tryResolveSerial：显式值直接返回，不调用 adb', () => {
    let invoked = 0;
    const serial = tryResolveSerial({
        adbPath: 'unused',
        envSerial: 'R58M77777',
        execFileSync() { invoked += 1; return LIST; },
    });
    assert.equal(serial, 'R58M77777');
    assert.equal(invoked, 0, '有显式 PERF_SERIAL 时不该再去打 adb');
});

test('tryResolveSerial：adb 不可用或无设备时返回 null，不抛不退出', () => {
    assert.equal(tryResolveSerial({
        adbPath: 'no-such-adb.exe',
        execFileSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    }), null, '离线读产物时不得致命');
    assert.equal(tryResolveSerial({
        adbPath: 'adb',
        execFileSync() { return 'List of devices attached\n'; },
    }), null);
});
