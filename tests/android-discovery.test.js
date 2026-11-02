'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const entry = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
const realRequire = createRequire(entry);

async function harness({ mdns = [], ready = [], stall = false } = {}) {
    const calls = { tables: [], probes: [], sockets: [], sync: 0 };
    let devices = ready;
    const client = {
        serial: '', adbPath: 'fake-adb',
        async devices() { return devices; },
        async mdnsServices() { return mdns; },
        async runText(args) {
            if (args[0] !== 'connect') throw new Error('unexpected adb command');
            devices = [{ serial: args[1], state: 'device' }];
            return `connected to ${args[1]}`;
        },
    };
    class Socket extends EventEmitter {
        constructor() { super(); calls.sockets.push(this); }
        setTimeout(ms) { this.timeout = ms; }
        destroy() { this.destroyed = true; clearTimeout(this.timer); }
        connect(port, host) {
            calls.probes.push({ host, port });
            this.timer = setTimeout(() => {
                if (this.destroyed) return;
                this.emit(stall ? 'timeout' : port === 32787 ? 'connect' : 'error');
            }, stall ? this.timeout : 0);
        }
    }
    const interfaces = { 'Local hotspot': [{ family: 'IPv4', address: '192.168.137.1', internal: false }] };
    let api;
    const overrides = {
        './lib/adb': { AdbClient: function () { return client; } },
        './lib/frame-hub': { FrameHub: function () { return { invalidateSelection() {} }; } },
        './lib/scrcpy-hub': { ScrcpyHub: function () { return { configure() {} }; } },
        './lib/stream-server': { StreamServer: function (options) {
            api = options.deviceApi;
            return { async start() {}, url() { return null; }, async changeDevice(select) { return select(); } };
        } },
        'node:fs': { readFileSync() { throw new Error('no cache'); }, mkdirSync() {}, writeFileSync() {} },
        os: { networkInterfaces: () => interfaces },
        'node:os': { networkInterfaces: () => interfaces },
        net: { Socket },
        child_process: {
            execFile(command, args, options, callback) {
                calls.tables.push({ command, options });
                setImmediate(() => callback(null, command === 'arp'
                    ? '  192.168.137.178  86-db-d5-5c-f1-84  dynamic\n'
                    : '  0.0.0.0  0.0.0.0  192.168.1.1  192.168.1.4  25\n'));
            },
            execFileSync() { calls.sync += 1; throw new Error('sync network query forbidden'); },
        },
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
    await module.exports.initialize({ config: {}, logger: { log() {}, warn() {} } });
    return { service: module.exports, client, api, calls };
}

test('页面发现：空 mDNS 默认兜底扫描热点网段，返回真实开放端口', async () => {
    const { api, calls } = await harness();
    const result = await api.discover({ waitMs: 0 });
    assert.ok(result.connect.some((item) => item.address === '192.168.137.178:32787' && item.source === 'portscan'));
    assert.equal(calls.sync, 0, 'HTTP 请求中不能同步执行 arp/route');
});

test('页面和工具空参数连接：无 mDNS 时扫描并连接同网手机', async () => {
    for (const fromPage of [true, false]) {
        const { api, service, client } = await harness();
        const result = fromPage ? await api.connect({})
            : (await service.processToolCall({ command: 'Manage', operation: 'connect' })).details;
        assert.equal(result.ok, true);
        assert.equal(result.source, 'portscan');
        assert.equal(client.serial, '192.168.137.178:32787');
    }
});

test('自动连接默认启用兜底；显式 portScan:false 仍然关闭', async () => {
    const { service, client } = await harness();
    for (const [options, expected] of [[{}, true], [{ portScan: false }, false]]) {
        let request;
        await assert.rejects(service._internals.autoConnectDevice(client, {
            ...options,
            discover: async (options) => { request = options; return { connect: [] }; },
        }), (error) => error.code === 'NO_DEVICE');
        assert.equal(request.fallbackScan, expected);
    }
});

test('页面发现显式禁用、mDNS 命中或已有就绪设备，不启动 LAN 扫描', async () => {
    for (const options of [
        { body: { fallbackScan: false } },
        { mdns: [{ kind: 'connect', address: '192.168.137.178:32787' }] },
        { ready: [{ serial: 'USB', state: 'device' }] },
    ]) {
        const { api, calls } = await harness(options);
        await api.discover({ waitMs: 0, ...options.body });
        assert.equal(calls.tables.length, 0);
        assert.equal(calls.probes.length, 0);
    }
});

test('LAN 扫描预算耗尽后不查询邻居表、不创建 socket', async () => {
    const { service, calls } = await harness();
    const result = await service._internals.scanLocalNetwork({ deadlineMs: Date.now() - 1 });
    assert.equal(result.hosts.length, 0);
    assert.equal(calls.tables.length, 0);
    assert.equal(calls.sync, 0);
    assert.equal(calls.probes.length, 0);
});

test('LAN 扫描使用异步网络表，未完成探测受截止时间约束并销毁 socket', async () => {
    const { service, calls } = await harness({ stall: true });
    const started = Date.now();
    await service._internals.scanLocalNetwork({
        from: 32780, to: 32790, concurrency: 2, timeoutMs: 1000,
        deadlineMs: started + 150,
    });
    assert.ok(calls.probes.length > 0, '必须确实启动过探测');
    assert.ok(calls.probes.length <= 2, '到期后不能继续派发端口');
    assert.ok(Date.now() - started < 800, '单次探测不能越过总预算');
    assert.ok(calls.sockets.every((socket) => socket.destroyed));
    assert.equal(calls.sync, 0);
});
