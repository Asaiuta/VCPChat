'use strict';

/**
 * 指纹截断时的信息保全契约。
 *
 * 真实回归（2026-11-02）：设备改用无线调试后，serial 从 `192.168.137.178`
 * 变成 mDNS 形态 `adb-beca2585-utuYDs._adb-tls-connect._tcp`。后者归一化后
 * 有 39 个字符，把 120 长度的 key 撑爆，截断恰好切在 `-adb.1.0.41` 中间，
 * 于是文件名变成 `...-node.v24.22.2-adb-h.6902cc70.json` ——
 * adb 版本从文件名里消失了，而它正是排查「换 adb 版本后性能变了」的第一线索。
 *
 * mDNS 尾缀 `_adb-tls-connect._tcp` / `_adb-tls-pairing._tcp` 对所有无线设备
 * 都相同，零区分度，属于可无损剥除的噪音。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const MOD = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/perf-baseline.js');
const { buildFingerprint } = require(MOD);

const base = {
    hostTag: 'laptopnhfk78o3',
    platform: 'win32',
    arch: 'x64',
    nodeVersion: 'v24.22.2',
    adbVersion: '1.0.41',
    manufacturer: 'OnePlus',
    model: 'PJZ110',
    androidRelease: '17',
    sdk: '37',
};

test('mDNS 无线序列号不得挤掉 adb 版本段', () => {
    const { key } = buildFingerprint({ ...base, serialTag: 'adb-beca2585-utuYDs._adb-tls-connect._tcp' });
    assert.ok(key.includes('adb.1.0.41'),
        `截断不得吞掉 adb 版本段，实际 key: ${key}`);
});

test('mDNS 协议尾缀被剥除，且设备标识仍在 key 里', () => {
    const { key } = buildFingerprint({ ...base, serialTag: 'adb-beca2585-utuYDs._adb-tls-connect._tcp' });
    assert.ok(!key.includes('tls.connect'), `协议尾缀无区分度，应剥除: ${key}`);
    assert.ok(key.includes('beca2585'), `设备标识必须保留，否则无法区分设备: ${key}`);
});

test('IP 形态序列号的指纹不受影响（向后兼容）', () => {
    const { key } = buildFingerprint({ ...base, serialTag: '192.168.137.178' });
    assert.ok(key.includes('192.168.137.178'), `IP 形态必须原样保留: ${key}`);
    assert.ok(key.includes('adb.1.0.41'), `IP 形态本来就没问题，不得因改动而退化: ${key}`);
});

test('两种连接形态得到不同指纹（同一台设备换连接方式应可区分）', () => {
    const a = buildFingerprint({ ...base, serialTag: 'adb-beca2585-utuYDs._adb-tls-connect._tcp' });
    const b = buildFingerprint({ ...base, serialTag: '192.168.137.178' });
    assert.notEqual(a.key, b.key, '连接形态不同必须落到不同基线文件，否则会互相污染');
});

test('超长 serial 仍然安全：key 合法、唯一、不超长', () => {
    const long = 'x'.repeat(200);
    const { key } = buildFingerprint({ ...base, serialTag: long });
    assert.ok(key.length <= 120, `key 不得超长，实际 ${key.length}`);
    assert.match(key, /^[a-z0-9][a-z0-9.-]*$/, `key 必须是合法文件名片段: ${key}`);
    const other = buildFingerprint({ ...base, serialTag: `${long}y` });
    assert.notEqual(key, other.key, '超长截断后仍必须靠哈希保持区分度');
});
