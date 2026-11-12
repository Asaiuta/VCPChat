'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController');
const entry = path.join(ROOT, 'AndroidControllerService.js');
const realRequire = createRequire(entry);
const { parseMdnsServices } = require(path.join(ROOT, 'lib/adb.js'));
const { encodeQr, qrSvg } = require(path.join(ROOT, 'lib/qr-svg.js'));
const { KnownDevices, createAutoConnector } = require(path.join(ROOT, 'lib/wireless-auto.js'));

function memoryFs(initial = {}) {
    const files = { ...initial };
    return {
        files,
        readFileSync(file) { if (!(file in files)) throw new Error('ENOENT'); return files[file]; },
        writeFileSync(file, text) { files[file] = text; },
        mkdirSync() {},
    };
}

test('mDNS 解析兼容 FQDN 形式的服务类型（结尾带点）', () => {
    const services = parseMdnsServices([
        'List of discovered mdns services',
        'adb-ABC-xyz\t_adb-tls-connect._tcp.\t192.168.1.20:37001',
        'studio-Q1w2E3r4T5\t_adb-tls-pairing._tcp\t192.168.1.20:41000',
        'adb-ABC\t_adb._tcp.\t192.168.1.20:5555',
    ].join('\n'));
    assert.deepEqual(services.map((s) => [s.name, s.kind, s.address]), [
        ['adb-ABC-xyz', 'connect', '192.168.1.20:37001'],
        ['studio-Q1w2E3r4T5', 'pairing', '192.168.1.20:41000'],
    ]);
});

test('二维码编码：版本随长度增长，三个定位图形完整，超长拒绝', () => {
    const small = encodeQr('WIFI:T:ADB;S:studio-Ab3dE5gH7k;P:Zx9Qw2Er7Ty1;;');
    assert.equal(small.version, 4);
    const size = small.modules.length;
    assert.equal(size, 33);
    for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
        for (let i = 0; i < 7; i++) {
            assert.equal(small.modules[y][x + i], true, 'finder top edge');
            assert.equal(small.modules[y + 6][x + i], true, 'finder bottom edge');
            assert.equal(small.modules[y + i][x], true, 'finder left edge');
        }
        assert.equal(small.modules[y + 1][x + 1], false, 'finder ring gap');
        assert.equal(small.modules[y + 3][x + 3], true, 'finder core');
    }
    assert.equal(encodeQr('x'.repeat(200)).version, 10);
    assert.throws(() => encodeQr('x'.repeat(300)), RangeError);
    assert.match(qrSvg('A'), /^<svg [^>]*viewBox="0 0 29 29"/);
});

test('已知设备：按序列号去重合并、MAC 次之，最多保留 8 台', () => {
    const memory = memoryFs();
    const known = new KnownDevices({ file: 'k.json', fs: memory });
    known.upsert({ id: 'S1', host: '192.168.1.5', port: 37001 });
    known.upsert({ id: 'S1', host: '192.168.1.9', mac: 'aa:bb:cc:dd:ee:ff' });
    known.upsert({ host: '10.0.0.2', mac: 'aa:bb:cc:dd:ee:ff' });
    assert.equal(known.list().length, 1);
    assert.deepEqual({ ...known.list()[0], at: 0 }, { id: 'S1', host: '10.0.0.2', port: 37001, mac: 'aa:bb:cc:dd:ee:ff', at: 0 });
    for (let i = 0; i < 12; i++) known.upsert({ id: `D${i}` });
    assert.equal(known.list().length, 8);
    assert.equal(known.list()[0].id, 'D11');
    memory.files['k.json'] = '{broken';
    assert.deepEqual(known.list(), []);
});

function fakeClock() {
    let time = 0;
    const timers = new Set();
    return {
        now: () => time,
        setTimer(fn, ms) { const timer = { at: time + ms, fn }; timers.add(timer); return timer; },
        clearTimer(timer) { timers.delete(timer); },
        async advance(ms) {
            const end = time + ms;
            for (;;) {
                const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
                if (!next) break;
                timers.delete(next);
                time = next.at;
                next.fn();
                for (let i = 0; i < 5; i++) await Promise.resolve();
            }
            time = end;
        },
    };
}

test('调度：网络变化后稳定期再试；忙碌保留变化标记；连上后降频；stop 等待在途尝试', async () => {
    const clock = fakeClock();
    let network = 'wifi=192.168.1.4';
    const calls = [];
    const results = [{ ok: false, busy: true }, { ok: false, deepScanned: true }, { ok: true, action: 'connected' }];
    const connector = createAutoConnector({
        ...clock, logger: {}, fingerprint: () => network,
        attempt: async (ctx) => { calls.push({ at: clock.now(), ...ctx }); return results.shift() || { ok: true, action: 'already-connected' }; },
        watchMs: 1000, settleMs: 500, fastMs: 2000, slowMs: 9000, connectedMs: 7000, fastWindowMs: 60000,
    });
    connector.start();
    await clock.advance(500);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].networkChanged, true);
    await clock.advance(2000);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].networkChanged, true, '忙碌跳过的轮次不能吞掉网络变化');
    assert.equal(calls[1].deepScan, true);
    await clock.advance(2000);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].networkChanged, false);
    assert.equal(calls[2].deepScan, false, '深扫后冷却期内不再深扫');
    assert.equal(connector.status().state, 'connected');
    await clock.advance(6999);
    assert.equal(calls.length, 3, '已连接后按 connectedMs 降频');
    network = 'hotspot=192.168.137.1';
    await clock.advance(1000);
    await clock.advance(500);
    assert.equal(calls.at(-1).networkChanged, true, '换网触发提前尝试');
    await connector.stop();

    let release;
    const slow = createAutoConnector({ ...clock, logger: {}, fingerprint: () => 'n',
        attempt: () => new Promise((resolve) => { release = resolve; }), settleMs: 0 });
    slow.start();
    await clock.advance(0);
    let stopped = false;
    const stopping = slow.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false, 'stop 必须等待在途尝试结束');
    release({ ok: false });
    await stopping;
    assert.equal(slow.status().enabled, false);
});

async function serviceHarness({ devices = [], mdns = [], known = [], open = [], arp = '', serial = '' } = {}) {
    const calls = { connect: [], select: [], probes: [] };
    let list = devices;
    const client = {
        serial, adbPath: 'fake-adb',
        async devices() { return list; },
        async mdnsServices() { return mdns; },
        async runText(args) {
            if (args[0] === 'connect') {
                calls.connect.push(args[1]);
                list = [...list, { serial: args[1], state: 'device' }];
                return `connected to ${args[1]}`;
            }
            if (args[0] === 'disconnect') return '';
            if (args[0] === 'shell' && args.includes('ro.serialno')) return 'SER123\n';
            throw new Error(`unexpected adb ${args.join(' ')}`);
        },
        async enqueue(args) { return { stdout: await this.runText(args), stderr: '' }; },
    };
    class Socket extends EventEmitter {
        setTimeout() {}
        destroy() { this.destroyed = true; }
        connect(port, host) {
            calls.probes.push(`${host}:${port}`);
            setImmediate(() => {
                if (this.destroyed) return;
                if (open.includes(`${host}:${port}`)) this.emit('connect');
                else this.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
            });
        }
    }
    const memory = memoryFs();
    const knownFile = path.join(process.cwd(), 'AppData', 'android-controller-known-devices.json');
    if (known.length) memory.files[knownFile] = JSON.stringify({ version: 1, devices: known });
    let api;
    const overrides = {
        './lib/adb': { AdbClient: function () { return client; } },
        './lib/frame-hub': { FrameHub: function () { return { invalidateSelection() {}, async stop() {} }; } },
        './lib/scrcpy-hub': { ScrcpyHub: function () { return { configure() {}, async stop() {} }; } },
        './lib/stream-server': { StreamServer: function (options) {
            api = options.deviceApi;
            return { async start() {}, async stop() {}, url() { return null; },
                async changeDevice(select) { calls.select.push(true); return select(); } };
        } },
        'node:fs': memory,
        net: { Socket },
        child_process: { execFile(command, args, options, callback) { setImmediate(() => callback(null, command === 'arp' ? arp : '')); } },
    };
    const load = (file) => {
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
            module, exports: module.exports, __dirname: path.dirname(file), __filename: file,
            require(name) { return Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name); },
            console, Buffer, process, setTimeout, clearTimeout, setImmediate, AbortController,
        }, { filename: file });
        return module.exports;
    };
    overrides['./lib/device-network'] = load(path.join(ROOT, 'lib/device-network.js'));
    const service = load(entry);
    await service.initialize({ config: { AUTO_CONNECT: false }, logger: { log() {}, warn() {} } });
    return { service, api, client, calls, memory, knownFile };
}

test('后台重连：已选设备在线时不做任何连接或扫描', async () => {
    const h = await serviceHarness({ serial: 'USB1', devices: [{ serial: 'USB1', state: 'device' }] });
    const result = await h.api.autoReconnect({ deepScan: true });
    assert.equal(result.action, 'already-connected');
    assert.deepEqual(h.calls.connect, []);
    assert.deepEqual(h.calls.probes, []);
    await h.service.cleanup();
});

test('后台重连：adb 自身 mDNS 连上的已知设备直接选用', async () => {
    const h = await serviceHarness({
        known: [{ id: 'SER123', host: '192.168.1.20', port: 37001 }],
        devices: [{ serial: 'adb-SER123-AbCd._adb-tls-connect._tcp', state: 'device' }],
    });
    const result = await h.api.autoReconnect({});
    assert.equal(result.action, 'selected');
    assert.equal(h.client.serial, 'adb-SER123-AbCd._adb-tls-connect._tcp');
    assert.deepEqual(h.calls.connect, []);
    await h.service.cleanup();
});

test('后台重连：mDNS 失效时按 MAC 找到换了 IP 的已知手机并连上，同时更新记忆', async () => {
    const h = await serviceHarness({
        known: [{ id: 'SER123', host: '192.168.1.20', port: 37001, mac: 'aa:bb:cc:dd:ee:ff' }],
        arp: '  192.168.137.181     aa-bb-cc-dd-ee-ff     动态\n',
        open: ['192.168.137.181:37001'],
    });
    const result = await h.api.autoReconnect({});
    assert.equal(result.ok, true);
    assert.equal(result.source, 'known');
    assert.deepEqual(h.calls.connect, ['192.168.137.181:37001']);
    assert.equal(h.client.serial, '192.168.137.181:37001');
    const saved = JSON.parse(h.memory.files[h.knownFile]).devices[0];
    assert.equal(saved.id, 'SER123');
    assert.equal(saved.host, '192.168.137.181');
    assert.equal(saved.mac, 'aa:bb:cc:dd:ee:ff');
    await h.service.cleanup();
});

test('后台重连：已知手机端口关闭且未允许深扫时不扫描、不连接', async () => {
    const h = await serviceHarness({ known: [{ id: 'SER123', host: '192.168.1.20', port: 37001 }] });
    const result = await h.api.autoReconnect({ deepScan: false });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_FOUND');
    assert.deepEqual(h.calls.probes, ['192.168.1.20:37001']);
    assert.deepEqual(h.calls.connect, []);
    await h.service.cleanup();
});

test('后台重连：没有任何配对记录时不探测局域网', async () => {
    const h = await serviceHarness({ arp: '  192.168.1.30   11-22-33-44-55-66   动态\n' });
    const result = await h.api.autoReconnect({ deepScan: true, networkChanged: true });
    assert.equal(result.code, 'NOT_FOUND');
    assert.deepEqual(h.calls.probes, []);
    await h.service.cleanup();
});

test('手动断开后暂停后台重连，显式连接后恢复', async () => {
    const h = await serviceHarness({ known: [{ id: 'SER123', host: '192.168.1.20', port: 37001 }] });
    await h.api.disconnect({});
    assert.equal((await h.api.autoReconnect({})).code, 'PAUSED');
    await h.api.connect({ address: '192.168.1.20:37001' });
    h.client.serial = '';
    const resumed = await h.api.autoReconnect({});
    assert.notEqual(resumed.code, 'PAUSED');
    await h.service.cleanup();
});

test('二维码配对：载荷符合 WIFI:T:ADB 格式，扫码后的配对服务用二维码密码配对', async () => {
    const h = await serviceHarness();
    const start = await h.api.pairQrStart();
    assert.match(start.name, /^studio-[A-Za-z0-9]{10}$/);
    assert.match(start.svg, /^<svg /);
    assert.equal((await h.api.pairQrPoll({ name: start.name })).state, 'waiting');
    assert.equal((await h.api.pairQrPoll({ name: 'studio-other' })).state, 'stale');

    const pairs = [];
    h.client.mdnsServices = async () => [{ kind: 'pairing', name: start.name, address: '192.168.1.20:41000' }];
    h.client.enqueue = async (args, options) => {
        pairs.push({ args, input: options.input });
        return { stdout: 'Successfully paired to 192.168.1.20:41000 [guid=adb-SER123]', stderr: '' };
    };
    const paired = await h.api.pairQrPoll({ name: start.name });
    assert.equal(paired.state, 'paired');
    assert.equal(pairs.length, 1);
    assert.deepEqual([...pairs[0].args], ['pair', '192.168.1.20:41000']);
    assert.match(pairs[0].input, /^[A-Za-z0-9]{12}\n$/, '密码经 stdin 传入，不出现在进程参数里');
    assert.equal((await h.api.pairQrPoll({ name: start.name })).state, 'stale', '配对会话一次性');
    await h.service.cleanup();
});
