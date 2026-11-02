
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const entry = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
const realRequire = createRequire(entry);

async function harness({ serial = 'A', devices, cache = null, mdns = [], shotError = null } = {}) {
    const calls = [];
    let listed = devices || [{ serial: 'A', state: 'device' }, { serial: 'B', state: 'device' }];
    const client = {
        serial,
        adbPath: 'fake-adb',
        async devices() { calls.push(['devices']); return listed; },
        async version() { return 'fake'; },
        async mdnsServices(options) { calls.push(['mdns', options]); return mdns; },
        async probeScreen(target) { calls.push(['probe', target]); return { focus: {}, size: { width: 100, height: 200 }, wakefulness: 'Awake' }; },
        async screenSize(target) { calls.push(['size', target]); return { width: 100, height: 200 }; },
        async currentFocus(target) { calls.push(['focus', target]); return { package: 'com.example', component: 'com.example/.Main' }; },
        async runText(args, options = {}) {
            calls.push(['adb', args, options]);
            if (args[0] === 'connect') {
                listed = [...listed.filter((d) => d.serial !== args[1]), { serial: args[1], state: 'device' }];
                return `connected to ${args[1]}`;
            }
            if (args.includes('uiautomator')) return '<hierarchy><node class="android.widget.Button" package="com.example" text="Go" clickable="true" bounds="[0,0][100,100]" /></hierarchy>';
            if (args[0] === 'pair') return 'Successfully paired to 192.168.1.8:41001';
            if (args.includes('packages')) return 'package:com.example';
            if (args.includes('resolve-activity')) return 'com.example/.Main';
            return '';
        },
        async enqueue(args, options) { return { stdout: await this.runText(args, options), stderr: '' }; },
    };
    const hub = {
        serial,
        async stop() { calls.push(['scrcpy-stop']); },
        requestedSerial: serial,
        configure(options) { this.requestedSerial = options.serial || ''; },
        status() { return {}; },
    };
    const fakeFrame = {
        requireSharp() { return {}; },
        async captureOneShot(options) { calls.push(['shot', options]); if (shotError) throw shotError; return {}; },
        invalidateSelection() { calls.push(['invalidate']); },
        stop() {},
        status() { return {}; },
    };
    let api;
    const overrides = {
        './lib/adb': { AdbClient: function () { return client; }, AdbError: class extends Error {} },
        './lib/frame-hub': { FrameHub: function () { return fakeFrame; } },
        './lib/scrcpy-hub': { ScrcpyHub: function () { return hub; } },
        './lib/stream-server': { StreamServer: function (options) { api = options.deviceApi; return { async start() {}, async stop() {}, async changeDevice(select) { calls.push(['change-device']); await hub.stop(); return select(); }, url() { return null; } }; } },
        './lib/vision': { DEFAULT_MAX_WIDTH: 1080, async buildVisionFrame() { return { width: 100, height: 200, byteLength: 1, dataUrl: 'data:image/jpeg;base64,AA==', mapping: { region: {} } }; }, describeMapping() { return ''; } },
        'node:fs': {
            readFileSync() { if (cache) return JSON.stringify({ address: cache }); throw new Error('absent'); },
            mkdirSync() {}, writeFileSync() {}, unlinkSync() {},
        },
        'node:os': { networkInterfaces() { return { WiFi: [{ family: 'IPv4', internal: false, address: '10.2.3.4' }, { family: 'IPv4', internal: false, address: '172.20.1.2' }] }; } },
        os: { networkInterfaces() { return { WiFi: [{ family: 'IPv4', internal: false, address: '10.2.3.4' }, { family: 'IPv4', internal: false, address: '172.20.1.2' }] }; } },
        child_process: { execFileSync() { throw new Error('request path must not spawn sync processes'); } },
    };
    const networkEntry = path.resolve(path.dirname(entry), 'lib/device-network.js');
    const network = { exports: {} };
    vm.runInNewContext(fs.readFileSync(networkEntry, 'utf8'), {
        module: network, exports: network.exports,
        require(name) { return Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name); },
        setTimeout, clearTimeout,
    }, { filename: networkEntry });
    overrides['./lib/device-network'] = network.exports;
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
        module, exports: module.exports,
        require(name) { return Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name); },
        console, Buffer, process, setTimeout, clearTimeout,
    }, { filename: entry });
    const service = module.exports;
    await service.initialize({ config: { DEVICE_SERIAL: serial }, logger: { log() {}, warn() {} } });
    return { service, api, client, hub, calls };
}

test('Observe 显式 B 不被默认 A 覆盖，且不改变默认设备', async () => {
    const { service, client, calls } = await harness();
    const result = await service.processToolCall({ command: 'Observe', serial: 'B' });
    assert.equal(result.details.serial, 'B');
    assert.equal(calls.find(([kind]) => kind === 'probe')[1], 'B');
    assert.equal(calls.filter(([kind]) => kind === 'devices').length, 1);
    assert.equal(client.serial, 'A');
});

test('显式设备离线不静默观察另一台设备', async () => {
    const { service } = await harness({ devices: [{ serial: 'A', state: 'device' }, { serial: 'B', state: 'offline' }] });
    await assert.rejects(service.processToolCall({ command: 'Observe', serial: 'B' }), /B.*offline|B.*未就绪/);
});

test('Screenshot 及 Observe 的截图都贯穿显式 serial', async () => {
    const { service, calls } = await harness();
    await service.processToolCall({ command: 'Observe', mode: 'image', serial: 'B' });
    await service.processToolCall({ command: 'Observe', serial: 'B', screenshot: true });
    const shots = calls.filter(([kind]) => kind === 'shot');
    assert.equal(shots.length, 2);
    assert.ok(shots.every(([, options]) => options.serial === 'B'));
});

test('LaunchApp 前台确认检查本次设备，不检查默认设备', async () => {
    const { service, calls } = await harness();
    const result = await service.processToolCall({ command: 'ExecuteStep', serial: 'B', action: { command: 'LaunchApp', package: 'com.example' } });
    assert.equal(result.details.ok, true);
    assert.equal(calls.find(([kind]) => kind === 'focus')[1], 'B');
});

test('页面 Connect 和工具 Connect 都选择已就绪目标并同步投屏 serial', async () => {
    for (const fromPage of [false, true]) {
        const { service, api, client, hub, calls } = await harness({ serial: '', devices: [{ serial: 'B', state: 'device' }] });
        const result = fromPage ? await api.connect({}) : (await service.processToolCall({ command: 'Manage', operation: 'connect' })).details;
        assert.equal(result.ok, true);
        assert.equal(client.serial, 'B');
        assert.equal(hub.requestedSerial, 'B');
        assert.ok(calls.some(([kind]) => kind === 'change-device'));
        assert.ok(calls.some(([kind]) => kind === 'invalidate'));
    }
});

test('页面和工具连接共用缓存快路径，不进行端口扫描', async () => {
    for (const fromPage of [false, true]) {
        const { service, api, client, calls } = await harness({ serial: '', devices: [], cache: '192.168.1.8:41000' });
        const result = fromPage ? await api.connect({}) : (await service.processToolCall({ command: 'Manage', operation: 'connect' })).details;
        assert.equal(result.ok, true);
        assert.equal(client.serial, '192.168.1.8:41000');
        assert.equal(calls.filter(([kind, args]) => kind === 'adb' && args[0] === 'connect').length, 1);
        assert.equal(calls.filter(([kind]) => kind === 'mdns').length, 0);
    }
});

test('配对只配对，不把配对端口改成 5555 猜测连接', async () => {
    const { service, calls } = await harness();
    await service.processToolCall({ command: 'Manage', operation: 'connect', mode: 'pair', address: '192.168.1.8:41001', code: '123456' });
    assert.equal(calls.filter(([kind, args]) => kind === 'adb' && args[0] === 'connect').length, 0);
});

test('全局配对和断开不携带设备选择器；断开后清理默认选择', async () => {
    const { service, api, client, calls } = await harness();
    await service.processToolCall({ command: 'Manage', operation: 'connect', mode: 'pair', address: '192.168.1.8:41001', code: '123456' });
    await api.disconnect({ address: 'A:5555' });
    await service.processToolCall({ command: 'Manage', operation: 'disconnect', serial: 'A' });
    assert.equal(client.serial, '');
    const globalCalls = calls.filter(([kind, args]) => kind === 'adb' && ['pair', 'disconnect'].includes(args[0]));
    assert.ok(globalCalls.every(([, , options]) => options.noSelector === true));
});

test('有效 10.x 与 172.x 局域网地址不被启发式过滤', async () => {
    const { service } = await harness();
    const addresses = service._internals.localAddresses().map((item) => item.address);
    assert.ok(addresses.includes('10.2.3.4'));
    assert.ok(addresses.includes('172.20.1.2'));
});

test('默认设备离线时自动连接不接管另一台已在线手机', async () => {
    const { service, client } = await harness({ serial: 'A', devices: [{ serial: 'A', state: 'offline' }, { serial: 'B', state: 'device' }] });
    await assert.rejects(service._internals.autoConnectDevice(client, { discover: async () => ({ connect: [] }) }), /没有找到|未就绪/);
    assert.equal(client.serial, 'A');
});

test('自动连接向底层传递剩余预算，预算耗尽后不再 connect', async () => {
    const { service } = await harness({ serial: '', devices: [] });
    let connects = 0;
    const client = {
        serial: '',
        async devices(options) { assert.ok(options.timeoutMs <= 5); return []; },
        async runText() { connects += 1; return ''; },
    };
    await assert.rejects(service._internals.autoConnectDevice(client, {
        budgetMs: 5,
        discover: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return { connect: [{ address: '192.168.1.8:41000' }] }; },
    }), /无法连接|超时|预算/);
    assert.equal(connects, 0);
});


test('Screenshot 采集失败不在入口重复重试，PNG回退尺寸交给Hub统一处理', async () => {
    const { service, calls } = await harness({ shotError: new Error('device offline') });
    await assert.rejects(service.processToolCall({ command: 'Observe', mode: 'image', serial: 'B' }), /offline/);
    const shots = calls.filter(([kind]) => kind === 'shot');
    assert.equal(shots.length, 1);
    assert.equal(shots[0][1].serial, 'B');
    assert.equal(shots[0][1].maxWidth, 100);
    assert.equal(shots[0][1].format, 'png');
});