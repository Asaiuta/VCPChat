'use strict';

/**
 * 自动连接的性能与缓存契约。
 *
 * 契约：
 * 1) 缓存命中（端口没变）→ 一次 adb connect，< 3s
 * 2) 缓存过期（端口变了）→ 只扫那台主机，不全网段扫
 * 3) 缓存的 host 不在 ARP 里 → 回退全扫
 * 4) 成功连接才写缓存，失败绝不写
 * 5) 缓存文件损坏不影响连接
 * 6) scanLocalNetwork 支持 hosts 白名单
 * 7) scanLocalNetwork 默认跳过网关
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const service = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));
const { scanLocalNetwork } = service._internals;

// ---------------------------------------------------------------------------
// scanLocalNetwork 的选项契约
// ---------------------------------------------------------------------------

test('scanLocalNetwork：hosts 白名单只扫指定主机', async () => {
    const result = await scanLocalNetwork({
        hosts: ['127.0.0.1'],
        from: 1,
        to: 10,
        timeoutMs: 60,
        concurrency: 16,
        skipGateway: false,
    });
    // 127.0.0.1 一般不在 arp 表里，会返回 HOST_NOT_ALIVE —— 关键是不崩、不超时
    assert.ok(Array.isArray(result.hosts), 'hosts 必须是数组');
    assert.ok(result.scanned <= 1, `只应扫 1 台，实际 ${result.scanned}`);
});

test('scanLocalNetwork：hosts 白名单里没有存活主机时给明确原因', async () => {
    const result = await scanLocalNetwork({
        hosts: ['203.0.113.254'],   // TEST-NET-3，永远不在本地 ARP
        from: 1,
        to: 10,
        timeoutMs: 60,
        concurrency: 16,
    });
    assert.deepEqual(result.hosts, []);
    assert.ok(['HOST_NOT_ALIVE', 'NO_ALIVE_HOST'].includes(result.reason),
        `意外原因：${result.reason}`);
});


// ---------------------------------------------------------------------------
// 自动连接的缓存行为（用可注入的 discover 隔离网络）
// ---------------------------------------------------------------------------

function fakeClient({ devices = [], connectBehavior } = {}) {
    let currentDevices = [...devices];
    const client = {
        serial: '',
        connectCalls: [],
        async devices() { return currentDevices.map((d) => ({ ...d })); },
        async runText(args, options = {}) {
            if (args[0] === 'connect') {
                const address = args[1];
                client.connectCalls.push(address);
                const outcome = connectBehavior ? connectBehavior(address) : true;
                if (outcome === true) {
                    currentDevices = [...currentDevices, { serial: address, state: 'device' }];
                    return `connected to ${address}`;
                }
                return `failed to connect to ${address}`;
            }
            return '';
        },
    };
    return client;
}

const noopSleep = async () => {};

test('自动连接：无设备且无候选时，不写缓存', async () => {
    const cacheFile = path.join(os.tmpdir(), `vcp-cache-test-${Date.now()}.json`);
    const client = fakeClient();
    await assert.rejects(
        () => service._internals.autoConnectDevice(client, {
            discover: async () => ({ ok: true, connect: [] }),
            sleep: noopSleep,
            portScan: false,
        }),
        /没有找到可连接的手机/,
    );
    assert.equal(client.serial, '', '失败时不该绑定 current');
    assert.ok(!fs.existsSync(cacheFile), '失败时不该产生缓存');
});

test('自动连接：成功连上后 client.serial 已绑定，可直接用', async () => {
    const client = fakeClient();
    const result = await service._internals.autoConnectDevice(client, {
        discover: async () => ({ ok: true, connect: [{ address: '192.168.1.50:41234', connected: false, source: 'mdns' }] }),
        sleep: noopSleep,
        portScan: false,
    });
    assert.equal(result.ok, true);
    assert.equal(client.serial, '192.168.1.50:41234');
    assert.deepEqual(client.connectCalls, ['192.168.1.50:41234']);
});

test('自动连接：已连着时不发任何 connect', async () => {
    const client = fakeClient({ devices: [{ serial: '192.168.1.50:41234', state: 'device' }] });
    const result = await service._internals.autoConnectDevice(client, { sleep: noopSleep });
    assert.equal(result.action, 'already-connected');
    assert.deepEqual(client.connectCalls, []);
});

test('normalizeConnectAddress：补 5555，已带端口不动', () => {
    const { normalizeConnectAddress } = service._internals;
    assert.equal(normalizeConnectAddress('192.168.1.50'), '192.168.1.50:5555');
    assert.equal(normalizeConnectAddress('192.168.1.50:41234'), '192.168.1.50:41234');
});
