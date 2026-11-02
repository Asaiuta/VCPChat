'use strict';

/**
 * 设备级重连契约。
 *
 * 这是「一段时间后自动失效」最根本的一环：
 * 无线调试的端口是随机的，手机息屏/切网/重启无线调试后会换成新端口。
 * 旧 serial 就那么一直 offline 着，scrcpy 重启必然失败，
 * 于是「回退兼容模式」变成一句空话 —— 根本没有可用设备可推流。
 *
 * 契约：
 * 1) 掉线后能自己把设备连回来（含端口变化）
 * 2) adb reconnect 能救的先用它（快），救不了再重新发现
 * 3) 恢复流程在重启 scrcpy 失败时会调用它
 * 4) 连不回来时给出可操作的原因，不静默
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const service = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));
const { reconnectDevice } = service._internals;

/** 造一个可编程的假 adb client */
function fakeClient({ devices = [], onReconnect } = {}) {
    const calls = [];
    return {
        calls,
        serial: null,
        async devices() { return typeof devices === 'function' ? devices() : devices; },
        async reconnect(serial) {
            calls.push(['reconnect', serial]);
            if (onReconnect) return onReconnect(serial);
            return true;
        },
    };
}

test('reconnectDevice：设备已经就绪时直接返回，不做多余动作', async () => {
    const client = fakeClient({ devices: [{ serial: '192.168.1.5:40001', state: 'device' }] });
    const result = await reconnectDevice(client, { serial: '192.168.1.5:40001' });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'already-ready');
    assert.equal(result.serial, '192.168.1.5:40001');
    assert.equal(client.calls.length, 0, '不需要重连');
});

test('reconnectDevice：offline 设备用 adb reconnect 救回来', async () => {
    let state = 'offline';
    const client = fakeClient({
        devices: () => [{ serial: '192.168.1.5:40001', state }],
        onReconnect: () => { state = 'device'; return true; },
    });

    const result = await reconnectDevice(client, { serial: '192.168.1.5:40001' });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'reconnect');
    assert.ok(client.calls.some(([c]) => c === 'reconnect'), '应该试过 adb reconnect');
});

test('reconnectDevice：端口变了 —— adb reconnect 救不了，改走重新发现', async () => {
    // 旧端口一直 offline；新端口上有设备
    const client = fakeClient({
        devices: () => [
            { serial: '192.168.1.5:40001', state: 'offline' },
            ...(global.__newPortUp ? [{ serial: '192.168.1.5:41999', state: 'device' }] : []),
        ],
        onReconnect: () => false,
    });

    let discoverCalls = 0;
    const discover = async () => {
        discoverCalls += 1;
        global.__newPortUp = true;   // 发现之后设备以新端口出现
        return {
            connect: [{ address: '192.168.1.5:41999', host: '192.168.1.5', port: 41999, source: 'portscan' }],
        };
    };
    const connect = async (address) => {
        client.calls.push(['connect', address]);
        return { ok: true, address };
    };

    try {
        const result = await reconnectDevice(client, {
            serial: '192.168.1.5:40001', discover, connect, portScanAttempts: 2,
        });
        assert.equal(result.ok, true, `没能连回来：${result.message}`);
        assert.equal(result.serial, '192.168.1.5:41999', '必须用发现到的新端口');
        assert.ok(discoverCalls >= 1, '应该重新发现过');
    } finally {
        global.__newPortUp = false;
    }
});

test('reconnectDevice：什么都连不上时明确报错，附可操作原因', async () => {
    const client = fakeClient({
        devices: [{ serial: '192.168.1.5:40001', state: 'offline' }],
        onReconnect: () => false,
    });
    const result = await reconnectDevice(client, {
        serial: '192.168.1.5:40001',
        discover: async () => ({ connect: [] }),
        connect: async () => ({ ok: false }),
        portScanAttempts: 1,
        budgetMs: 1200,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /无线调试|配对|同一/, `信息不够可操作：${result.message}`);
    assert.equal(result.action, 'failed');
});

test('reconnectDevice：没有已知 serial 时也能重新发现', async () => {
    // 连上之后 devices() 必须能看到它，否则 waitForDeviceState 会一直等
    let connected = null;
    const client = {
        calls: [],
        serial: null,
        async devices() {
            return connected ? [{ serial: connected, state: 'device' }] : [];
        },
        async reconnect() { return false; },
    };
    const connect = async (address) => {
        client.calls.push(['connect', address]);
        client.serial = address;
        connected = address;
        return { ok: true, address };
    };
    const result = await reconnectDevice(client, {
        serial: null,
        discover: async () => ({ connect: [{ address: '192.168.1.9:50000', host: '192.168.1.9', port: 50000 }] }),
        connect,
    });
    assert.equal(result.ok, true, `没能连回来：${result.message}`);
    assert.equal(result.serial, '192.168.1.9:50000');
});
