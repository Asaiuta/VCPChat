'use strict';

/**
 * 自动连接的契约测试。
 *
 * 背景：页面点「连接」时发的是空 body，而 connectDevice 的无线分支
 * 强制要求 address，于是自动连接 100% 失败 —— 用户必须手点一次。
 * 这里把「无参数 = 自动接管」的行为钉死。
 *
 * 契约：
 * 1) 已有 device 状态的设备 → 直接选中，不发 connect 命令
 * 2) 无设备但有可连候选 → 自动 connect，轮询到 device 才返回成功
 * 3) connect 命令失败 → 抛错，绝不谎报成功
 * 4) 连上了但是 unauthorized → 抛错并提示去手机点允许
 * 5) 什么都没发现 → 抛错，带可执行的 hint
 * 6) 多个候选时跳过已连接的，不重复 connect
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const service = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService'));
const { autoConnectDevice } = service._internals;

/** 造一个假 adb 客户端 */
function fakeClient({ devices = [], connectResult = 'connected to 192.168.1.20:5555', connectDelay = 0 } = {}) {
    const calls = [];
    let currentDevices = [...devices];
    const client = {
        serial: '',
        calls,
        async devices() {
            calls.push({ cmd: 'devices' });
            return currentDevices.map((d) => ({ ...d }));
        },
        async runText(args, options = {}) {
            calls.push({ cmd: 'runText', args, serial: options.serial });
            if (args[0] === 'connect') {
                if (connectDelay) await new Promise((r) => setTimeout(r, connectDelay));
                const address = args[1];
                // 连接成功后设备才出现在列表里
                if (/^connected to/i.test(connectResult) && !/cannot|failed|refused/i.test(connectResult)) {
                    currentDevices = [...currentDevices, { serial: address, state: 'device' }];
                } else if (/unauthorized/i.test(connectResult)) {
                    currentDevices = [...currentDevices, { serial: address, state: 'unauthorized' }];
                }
                return connectResult;
            }
            return '';
        },
        /** 测试里直接改设备表，模拟连接后状态变化 */
        setDevices(next) { currentDevices = [...next]; },
    };
    return client;
}

const noopSleep = async () => {};

test('自动连接：已有 device 设备直接选中，不执行 connect', async () => {
    const client = fakeClient({ devices: [{ serial: '192.168.1.20:5555', state: 'device', model: 'PJZ110' }] });
    const result = await autoConnectDevice(client, {
        discover: async () => { throw new Error('不该走到 discover'); },
        sleep: noopSleep,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'already-connected');
    assert.equal(result.serial, '192.168.1.20:5555');
    assert.equal(client.serial, '192.168.1.20:5555', '必须把 serial 绑定到客户端');
    assert.equal(client.calls.filter((c) => c.cmd === 'runText').length, 0, '不该发任何 adb 命令');
});

test('自动连接：offline 设备不算可用，继续走发现流程', async () => {
    const client = fakeClient({ devices: [{ serial: '192.168.1.20:5555', state: 'offline' }] });
    await assert.rejects(
        () => autoConnectDevice(client, {
            discover: async () => ({ ok: true, connect: [] }),
            sleep: noopSleep,
            portScan: false,
        }),
        (error) => {
            assert.equal(error.code, 'NO_DEVICE', '离线设备不应被当成连上');
            assert.equal(client.serial, '', '不该把离线设备绑成 current');
            return true;
        },
    );
});

test('自动连接：发现候选后自动 connect，轮询到 device 才成功', async () => {
    const client = fakeClient({ devices: [] });
    const result = await autoConnectDevice(client, {
        discover: async () => ({
            ok: true,
            connect: [{ address: '192.168.1.20:37105', connected: false, source: 'mdns' }],
        }),
        sleep: noopSleep,
        portScan: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'connected');
    assert.equal(result.serial, '192.168.1.20:37105');
    const connectCalls = client.calls.filter((c) => c.cmd === 'runText' && c.args[0] === 'connect');
    assert.equal(connectCalls.length, 1);
    assert.equal(connectCalls[0].args[1], '192.168.1.20:37105');
});

test('自动连接：connect 命令报失败时抛错，不谎报成功', async () => {
    const client = fakeClient({ devices: [], connectResult: 'failed to connect to 192.168.1.20:37105' });
    await assert.rejects(
        () => autoConnectDevice(client, {
            discover: async () => ({ ok: true, connect: [{ address: '192.168.1.20:37105', connected: false }] }),
            sleep: noopSleep,
            portScan: false,
        }),
        (error) => {
            assert.match(error.message, /无法连接/);
            assert.equal(error.code, 'CONNECT_FAILED');
            return true;
        },
    );
});

test('自动连接：连上但未授权时提示去手机点允许', async () => {
    const client = fakeClient({ devices: [], connectResult: 'connected to 192.168.1.20:37105' });
    // 连接成功后把设备状态改成 unauthorized，模拟手机弹窗未确认
    const originalDevices = client.devices.bind(client);
    client.devices = async () => {
        const list = await originalDevices();
        return list.map((d) => ({ ...d, state: 'unauthorized' }));
    };

    await assert.rejects(
        () => autoConnectDevice(client, {
            discover: async () => ({ ok: true, connect: [{ address: '192.168.1.20:37105', connected: false }] }),
            sleep: noopSleep,
            portScan: false,
        }),
        (error) => {
            assert.equal(error.code, 'UNAUTHORIZED');
            assert.match(error.hint, /允许/);
            return true;
        },
    );
});

test('自动连接：什么都没发现时抛错并给出可执行 hint', async () => {
    const client = fakeClient({ devices: [] });
    await assert.rejects(
        () => autoConnectDevice(client, {
            discover: async () => ({ ok: true, connect: [] }),
            sleep: noopSleep,
            portScan: false,
        }),
        (error) => {
            assert.equal(error.code, 'NO_DEVICE');
            assert.match(error.hint, /无线调试|配对|WiFi/);
            return true;
        },
    );
});

test('自动连接：跳过已连接的候选，不重复 connect', async () => {
    const client = fakeClient({ devices: [] });
    const result = await autoConnectDevice(client, {
        discover: async () => ({
            ok: true,
            connect: [
                { address: '192.168.1.20:5555', connected: true },   // 已连
                { address: '192.168.1.21:37105', connected: false },  // 待连
            ],
        }),
        sleep: noopSleep,
        portScan: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.serial, '192.168.1.21:37105');
    const connectCalls = client.calls.filter((c) => c.cmd === 'runText' && c.args[0] === 'connect');
    assert.equal(connectCalls.length, 1, '只应对未连接的候选发一次 connect');
    assert.equal(connectCalls[0].args[1], '192.168.1.21:37105');
});

test('自动连接：优先选已配对过的候选（source=connected 排前面）', async () => {
    const client = fakeClient({ devices: [] });
    const result = await autoConnectDevice(client, {
        discover: async () => ({
            ok: true,
            connect: [
                { address: '192.168.1.99:40000', connected: false, source: 'portscan' },
                { address: '192.168.1.20:37105', connected: false, source: 'mdns' },
            ],
        }),
        sleep: noopSleep,
        portScan: false,
    });
    assert.equal(result.serial, '192.168.1.20:37105', 'mdns 来源比 portscan 更可信');
});

test('自动连接：discover 本身抛错时不崩，按无候选处理', async () => {
    const client = fakeClient({ devices: [] });
    await assert.rejects(
        () => autoConnectDevice(client, {
            discover: async () => { throw new Error('mDNS 炸了'); },
            sleep: noopSleep,
            portScan: false,
        }),
        (error) => {
            assert.equal(error.code, 'NO_DEVICE');
            return true;
        },
    );
});

test('自动连接：总耗时受预算约束', async () => {
    const client = fakeClient({ devices: [{ serial: '192.168.1.20:5555', state: 'device' }] });
    const startedAt = Date.now();
    await autoConnectDevice(client, { sleep: noopSleep, budgetMs: 5000 });
    assert.ok(Date.now() - startedAt < 1000, '已有设备时必须走快路径');
});
