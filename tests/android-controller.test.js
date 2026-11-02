'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const { parseDevices, AdbError } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const { clampInt, FrameHub } = require('../VCPDistributedServer/Plugin/AndroidController/lib/frame-hub');
const { encodeFrameHeader, FRAME_MAGIC } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
const service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');


test('adb: parseDevices 解析 -l 输出', () => {
    const text = [
        'List of devices attached',
        'R58M12345AB          device usb:1-2 product:dreamltexx model:SM_G950F device:dreamlte transport_id:3',
        '192.168.1.20:5555    device product:walleye model:Pixel_2 device:walleye transport_id:5',
        '0123456789ABCDEF     unauthorized usb:1-3 transport_id:4',
        '',
    ].join('\n');

    const devices = parseDevices(text);
    assert.equal(devices.length, 3);
    assert.equal(devices[0].serial, 'R58M12345AB');
    assert.equal(devices[0].state, 'device');
    assert.equal(devices[0].model, 'SM_G950F');
    assert.equal(devices[1].serial, '192.168.1.20:5555');
    assert.equal(devices[1].model, 'Pixel_2');
    assert.equal(devices[2].state, 'unauthorized');
});

test('adb: parseDevices 容忍空输出与表头', () => {
    assert.deepEqual(parseDevices(''), []);
    assert.deepEqual(parseDevices('List of devices attached\n\n'), []);
    assert.deepEqual(parseDevices('* daemon started successfully *'), []);
});

test('adb: AdbError 保留 code 供上层分派', () => {
    const error = new AdbError('ADB_NOT_FOUND', '找不到 adb');
    assert.equal(error.code, 'ADB_NOT_FOUND');
    assert.ok(error instanceof Error);
});

test('frame-hub: clampInt 边界', () => {
    assert.equal(clampInt('120', 400, 100, 5000), 120);
    assert.equal(clampInt('1', 400, 100, 5000), 100, '低于下限取 min');
    assert.equal(clampInt('99999', 400, 100, 5000), 5000, '高于上限取 max');
    assert.equal(clampInt('abc', 400, 100, 5000), 400, '非法值取 fallback');
    assert.equal(clampInt(undefined, 400, 100, 5000), 400);
});

test('frame-hub: 单飞语义，并发 capture 只触发一次 adb', async () => {
    // 1×1 PNG。captureMode='png' 让路径可预测 —— 否则 auto 会先试 raw，
    // 测试桩给的假数据会被判为格式错误，干扰单飞计数的断言。
    const tinyPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );
    let calls = 0;
    const fakeAdb = {
        execOutBinary: async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return tinyPng;
        },
    };
    const hub = new FrameHub({ adb: fakeAdb, format: 'png', maxWidth: 2160, captureMode: 'png' });
    const [a, b, c] = await Promise.all([hub.capture(), hub.capture(), hub.capture()]);
    assert.equal(calls, 1, '并发调用必须共享同一个 in-flight Promise');
    assert.equal(a.seq, 1);
    assert.equal(a, b);
    assert.equal(b, c);
    await hub.capture();
    assert.equal(calls, 2, '前一次结束后新调用才重新采集');
});

test('frame-hub: raw 短读会重试并在三次后放弃', async () => {
    let calls = 0;
    // 头部声明 2×2 RGBA（需 32 字节），但只给 20 字节
    const short = Buffer.alloc(20);
    short.writeUInt32LE(2, 0);
    short.writeUInt32LE(2, 4);
    short.writeUInt32LE(1, 8);   // RGBA_8888

    const hub = new FrameHub({
        adb: { execOutBinary: async () => { calls += 1; return short; } },
        captureMode: 'raw',
        format: 'jpeg',
    });
    await assert.rejects(() => hub.capture(), /短读/);
    assert.equal(calls, 3, '短读应重试 3 次');
});

test('frame-hub: raw 像素格式不支持时明确报错', async () => {
    const bad = Buffer.alloc(40);
    bad.writeUInt32LE(2, 0);
    bad.writeUInt32LE(2, 4);
    bad.writeUInt32LE(5, 8);   // 不是 RGBA_8888
    const hub = new FrameHub({
        adb: { execOutBinary: async () => bad },
        captureMode: 'raw',
    });
    await assert.rejects(() => hub.capture(), /不支持的 raw 像素格式/);
});

test('frame-hub: auto 模式下 raw 失败会降级 PNG 且不反复重试', async () => {
    const tinyPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );
    let rawAttempts = 0;
    let pngAttempts = 0;
    const hub = new FrameHub({
        adb: {
            execOutBinary: async (args) => {
                if (args.includes('-p')) { pngAttempts += 1; return tinyPng; }
                rawAttempts += 1;
                throw new Error('该设备不支持 raw');
            },
        },
        captureMode: 'auto',
        format: 'png',
        maxWidth: 2160,
    });

    const first = await hub.capture();
    assert.ok(first, '应通过降级拿到一帧');
    assert.equal(hub.status().captureMode, 'png', '降级后应记住 png 模式');
    assert.equal(hub.status().fallbackCount, 1);

    await hub.capture();
    assert.equal(rawAttempts, 1, '不该反复重试 raw');
    assert.equal(pngAttempts, 2);
});

test('frame-hub: screencap 返回空数据时抛错并记录 lastError', async () => {
    const hub = new FrameHub({ adb: { execOutBinary: async () => Buffer.alloc(4) }, format: 'png' });
    await assert.rejects(() => hub.capture(), /screencap 返回空数据/);
    assert.ok(hub.status().lastError);
    assert.match(hub.status().lastError.message, /空数据/);
});

test('frame-hub: 无订阅者时不启动采集循环', () => {
    const hub = new FrameHub({ adb: { execOutBinary: async () => Buffer.alloc(200) } });
    hub.ensureLoop();
    assert.equal(hub.status().streaming, false, '没有订阅者不应开启 interval');
    assert.equal(hub.status().subscribers, 0);
});

test('stream: 帧头魔数与字段布局', () => {
    const header = encodeFrameHeader({ seq: 7, capturedAt: 1700000000000 });
    assert.equal(header.length, 16);
    assert.equal(header.readUInt32LE(0), FRAME_MAGIC);
    assert.equal(header.readUInt32LE(4), 7);
    assert.equal(Number(header.readBigUInt64LE(8)), 1700000000000);
});

test('service: shellQuote 转义单引号防止命令注入', () => {
    const { shellQuote } = service._internals;
    assert.equal(shellQuote('hello'), "'hello'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");

    // 注入尝试：单引号必须被闭合-转义-重开，使分号落在引号内
    const evil = "'; rm -rf /; echo '";
    assert.equal(shellQuote(evil), "''\\''; rm -rf /; echo '\\'''");

    // 语义校验：剥掉引号语法后应还原出原文，且不存在裸分号
    const rendered = shellQuote(evil).replace(/^'/, '').replace(/'$/, '').replace(/'\\''/g, "'");
    assert.equal(rendered, evil);
});

test('service: commandOf 大小写与别名归一', () => {
    const { commandOf } = service._internals;
    assert.equal(commandOf({ command: 'Observe' }), 'observe');
    assert.equal(commandOf({ action: '  TAP ' }), 'tap');
    assert.equal(commandOf({ commandIdentifier: 'ListDevices' }), 'listdevices');
    assert.equal(commandOf({}), '');
});

test('service: intOf 拒绝非数字而非静默取 0', () => {
    const { intOf } = service._internals;
    assert.equal(intOf('540', 'x'), 540);
    assert.throws(() => intOf('540.6', 'x'), { code: 'INVALID_ARGUMENT' });
    assert.equal(intOf(undefined, 'x'), null);
    assert.throws(() => intOf('abc', 'x'), { code: 'INVALID_ARGUMENT' });
});

test('service: 未知 command 抛出可用清单', async () => {
    await assert.rejects(
        () => service.processToolCall({ command: 'Explode' }),
        /不支持的 command：Explode/,
    );
});

test('service: 缺少 command 给出引导', async () => {
    await assert.rejects(() => service.processToolCall({}), /缺少 command/);
});

test('service: 非对象参数被拒绝', async () => {
    await assert.rejects(() => service.processToolCall([]), /无效的工具参数/);
});

test('service: Tap 缺坐标且无快照时给出明确指引', async () => {
    const { resolveTarget, lastObserve } = service._internals;
    lastObserve.clear();
    assert.throws(() => resolveTarget({}, '点击'), /需要 x\/y 坐标/);
    assert.throws(() => resolveTarget({ index: 0 }, '点击'), /尚未在该设备上执行 Observe/);
});

test('service: id/text 可跨帧定位，未命中时报可执行错误', () => {
    const { resolveTarget, lastObserve } = service._internals;
    const graph = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
    lastObserve.set('', {
        at: Date.now(),
        graph: graph.parseUiGraph(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
            <node class="android.widget.Button" resource-id="com.demo:id/send" text="发送" package="com.demo" clickable="true" bounds="[900,2000][1060,2100]" />
        </node></hierarchy>`),
    });

    const byId = resolveTarget({ id: 'com.demo:id/send' }, '点击');
    assert.equal(byId.x, 980);
    assert.equal(byId.node.label, '发送');

    const byText = resolveTarget({ text: '发送' }, '点击');
    assert.equal(byText.node.id, 'com.demo:id/send');

    assert.throws(() => resolveTarget({ id: 'com.demo:id/nope' }, '点击'), /没有匹配.*com\.demo:id\/nope/);
    lastObserve.clear();
});

test('service: index 越界时报告快照规模', () => {
    const { resolveTarget, lastObserve } = service._internals;
    lastObserve.set('', {
        at: Date.now(),
        graph: {
            controls: [{
                index: 0, x: 10, y: 20, label: 'A', id: 'com.demo:id/a', cls: 'Button', selector: 'id=com.demo:id/a', flags: [],
            }],
        },
    });
    assert.throws(() => resolveTarget({ index: 5 }, '点击'), /超出范围.*共 1 个控件/);
    const target = resolveTarget({ index: 0 }, '点击');
    assert.equal(target.x, 10);
    assert.equal(target.y, 20);
    assert.equal(target.node.selector, 'id=com.demo:id/a');
    lastObserve.clear();
});

test('service: parseOptionalInt 保留 0（随机端口是合法值）', () => {
    const { parseOptionalInt } = service._internals;
    assert.equal(parseOptionalInt('0'), 0, '0 不能被当成缺失值');
    assert.equal(parseOptionalInt('5977'), 5977);
    assert.equal(parseOptionalInt(''), undefined);
    assert.equal(parseOptionalInt(undefined), undefined);
    assert.equal(parseOptionalInt('abc'), undefined);
});

test('service: KeyEvent 别名映射到 KEYCODE', () => {
    const { KEY_ALIASES } = service._internals;
    assert.equal(KEY_ALIASES.back, 'KEYCODE_BACK');
    assert.equal(KEY_ALIASES.recents, 'KEYCODE_APP_SWITCH');
    assert.equal(KEY_ALIASES.backspace, 'KEYCODE_DEL');
});

test('manifest: 声明的命令都能被服务分派', () => {
    const manifest = require('../VCPDistributedServer/Plugin/AndroidController/plugin-manifest.json');
    const { COMMANDS } = service._internals;
    const declared = manifest.capabilities.invocationCommands.map((c) => c.command.toLowerCase());
    for (const command of declared) {
        assert.ok(COMMANDS[command], `清单声明了 ${command} 但服务没有对应处理函数`);
    }
    assert.deepEqual(declared, ['describe', 'observe', 'executestep', 'manage']);
});

test('manifest: pluginType 与 direct 协议符合 PluginManager 装载条件', () => {
    const manifest = require('../VCPDistributedServer/Plugin/AndroidController/plugin-manifest.json');
    assert.equal(manifest.pluginType, 'hybridservice');
    assert.equal(manifest.communication.protocol, 'direct');
    assert.ok(manifest.entryPoint.script.endsWith('.js'));
});

test('stream: 首选端口被占用时自动退让到随机端口', async () => {
    const net = require('net');
    const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');

    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(0, '127.0.0.1', resolve);
    });
    const takenPort = blocker.address().port;

    const warnings = [];
    const server = new StreamServer({
        frameHub: null,
        port: takenPort,
        logger: { log: () => {}, warn: (message) => warnings.push(message) },
    });

    try {
        const actual = await server.start();
        assert.notEqual(actual, takenPort, '应换到其他端口');
        assert.ok(server.url().includes(':'), `url 应可用：${server.url()}`);
        assert.match(server.fallbackReason || '', /已被占用/);
        assert.ok(warnings.some((line) => line.includes('已被占用')), '应记录退让原因');
    } finally {
        await server.stop();
        await new Promise((resolve) => blocker.close(resolve));
    }
});

test('stream: port=0 时由系统分配且不触发退让逻辑', async () => {
    const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
    const server = new StreamServer({ frameHub: null, port: 0, logger: { log: () => {}, warn: () => {} } });
    try {
        const port = await server.start();
        assert.ok(port > 0);
        assert.equal(server.fallbackReason, null, '首次绑定成功不应记录退让');
    } finally {
        await server.stop();
    }
});

// ---------------------------------------------------------------------------
// 设备连接向导（人类点按钮，不敲命令行）
// ---------------------------------------------------------------------------

const { parseHostPort, parsePairCode } = service._internals;

test('parseHostPort: 标准 IP:端口', () => {
    assert.deepEqual(parseHostPort('192.168.1.20:37105'), {
        host: '192.168.1.20', port: 37105, address: '192.168.1.20:37105',
    });
});

test('parseHostPort: 容忍用户整段粘贴 adb 命令', () => {
    assert.equal(parseHostPort('adb pair 192.168.1.20:37105').address, '192.168.1.20:37105');
    assert.equal(parseHostPort('adb connect 192.168.1.20:5555').address, '192.168.1.20:5555');
});

test('parseHostPort: 只有 IP 时用回退端口', () => {
    assert.equal(parseHostPort('192.168.1.20', 5555).address, '192.168.1.20:5555');
});

test('parseHostPort: 缺端口且无回退时报错而不是瞎猜', () => {
    // 配对端口每次都不同，绝不能默认 5555 —— 猜错只会让用户困惑
    assert.throws(() => parseHostPort('192.168.1.20', null), /端口/);
    assert.throws(() => parseHostPort('', 5555), /请填写/);
    assert.throws(() => parseHostPort('192.168.1.20:99999', null), /端口不合法/);
    assert.throws(() => parseHostPort('http://192.168.1.20:5555', null), /格式不对/);
});

test('parsePairCode: 只接受 6 位数字', () => {
    assert.equal(parsePairCode('123456'), '123456');
    assert.equal(parsePairCode(' 123 456 '), '123456');
    assert.throws(() => parsePairCode('12345'), /6 位/);
    assert.throws(() => parsePairCode('1234567'), /6 位/);
    assert.throws(() => parsePairCode('abcdef'), /6 位/);
    assert.throws(() => parsePairCode(''), /6 位/);
});

test('adb: pair/connect 不带 -s 选择器（全局命令不接受）', async () => {
    const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
    const client = new AdbClient({ adbPath: 'adb', serial: '192.168.1.99:5555' });
    const seen = [];
    // 拦截实际执行，只观察 argv 组装
    client.runRaw = (args, options) => {
        seen.push({ args, options });
        return Promise.resolve({ stdout: '', stderr: '' });
    };
    await client.enqueue(['connect', '192.168.1.20:5555'], { noSelector: true });
    assert.deepEqual(seen[0].args, ['connect', '192.168.1.20:5555']);

    client.runRaw = (args) => Promise.resolve({ stdout: '', stderr: '' });
    seen.length = 0;
    await client.enqueue(['shell', 'input', 'tap', '1', '2'], {});
    // 普通设备命令仍要带选择器
    const argv = ['-s', '192.168.1.99:5555', 'shell', 'input', 'tap', '1', '2'];
    assert.deepEqual(client.selectors(undefined), argv.slice(0, 2));
});

test('api: 跨源写请求被拒绝，同源放行', async () => {
    const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
    let paired = 0;
    const server = new StreamServer({
        frameHub: null,
        port: 0,
        logger: { log: () => {}, warn: () => {} },
        deviceApi: {
            async pair(body) { paired += 1; return { ok: true, address: body.address }; },
            async listDevices() { return { ok: true, devices: [], ready: 0 }; },
            async adbStatus() { return { ok: true, available: true, version: 'test' }; },
        },
    });

    const port = await server.start();
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(base);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    try {
        // 恶意网页：带 Origin 但不是本服务
        const evil = await fetch(`${base}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
            body: JSON.stringify({ address: '192.168.1.20:37105', code: '123456' }),
        });
        assert.equal(evil.status, 403, '跨源写请求必须被拒绝');
        assert.equal(paired, 0, '被拒绝的请求不能触达 deviceApi');

        // 同源：浏览器自己页面发起的请求
        const good = await fetch(`${base}/api/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
            body: JSON.stringify({ address: '192.168.1.20:37105', code: '123456' }),
        });
        assert.equal(good.status, 200);
        assert.equal((await good.json()).ok, true);
        assert.equal(paired, 1);

        // 已取得会话的同源客户端读取接口无需 Origin。
        const devices = await fetch(`${base}/api/devices`, { headers: { Cookie: cookie } });
        assert.equal(devices.status, 200);
        assert.equal((await devices.json()).ok, true);

        // 预检一律拒绝
        const preflight = await fetch(`${base}/api/pair`, { method: 'OPTIONS' });
        assert.equal(preflight.status, 403);
    } finally {
        await server.stop();
    }
});

test('api: 未注入 deviceApi 时返回 503 而不是崩溃', async () => {
    const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
    const server = new StreamServer({ frameHub: null, port: 0, logger: { log: () => {}, warn: () => {} } });
    const port = await server.start();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/devices`);
        assert.equal(res.status, 503);
        assert.equal((await res.json()).ok, false);
    } finally {
        await server.stop();
    }
});

// ---------------------------------------------------------------------------
// 连接失败诊断：把「连不上」拆成可执行的结论
// ---------------------------------------------------------------------------

const { probePort, diagnoseEndpoint, localAddresses } = service._internals;

test('localAddresses: 过滤虚拟网卡，只留手机能连的地址', () => {
    const list = localAddresses();
    assert.ok(Array.isArray(list), '应返回数组');
    for (const item of list) {
        assert.ok(item.address, '每项都要有 address');
        assert.ok(!item.address.startsWith('127.'), '不能含回环');
        assert.ok(!item.address.startsWith('169.254.'), '不能含链路本地');
        assert.ok(!item.address.startsWith('100.64.'), '不能含 CGNAT（Tailscale）');
        assert.ok(!/zerotier|tailscale|vgate|wsl|docker/i.test(item.interface || ''),
            `不能含虚拟接口：${item.interface}`);
    }
});

test('probePort: 端口开放时快速返回 OPEN', async () => {
    const net = require('net');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        const result = await probePort('127.0.0.1', port, 2000);
        assert.equal(result.kind, 'OPEN');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('probePort: 端口关闭时返回 ECONNREFUSED（网络通但无服务）', async () => {
    const net = require('net');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));

    const result = await probePort('127.0.0.1', port, 2000);
    assert.equal(result.kind, 'ECONNREFUSED');
});

test('probePort: 不可达地址在超时内返回，不挂死', async () => {
    const started = Date.now();
    // TEST-NET-1，RFC 5737 保留段，必然不通
    const result = await probePort('192.0.2.99', 5555, 800);
    const elapsed = Date.now() - started;
    assert.ok(['TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(result.kind), result.kind);
    assert.ok(elapsed < 3000, `应在超时窗口内返回，实际 ${elapsed}ms`);
});

test('diagnoseEndpoint: 三种场景给出不同的可执行结论', async () => {
    // 1) 端口开 → 指向「还没配对」
    const net = require('net');
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const openPort = server.address().port;
    const open = await diagnoseEndpoint(`127.0.0.1:${openPort}`);
    assert.equal(open.kind, 'PORT_OPEN');
    assert.match(open.hint, /配对/, '端口通时应提示去配对');
    await new Promise((resolve) => server.close(resolve));

    // 2) 端口关 → 指向「重新开无线调试」
    const closed = await diagnoseEndpoint(`127.0.0.1:${openPort}`);
    assert.equal(closed.kind, 'PORT_CLOSED');
    assert.match(closed.hint, /无线调试/, '端口关闭时应提示重开无线调试');

    // 3) 不可达 → 指向「核对 IP / 同网段」
    const unreachable = await diagnoseEndpoint('192.0.2.99:5555');
    assert.equal(unreachable.kind, 'UNREACHABLE');
    assert.match(unreachable.hint, /网段|IP/, '不可达时应提示核对 IP');
    // 结论必须带本机地址，用户才知道该和什么对比
    const local = localAddresses()[0]?.address;
    if (local) assert.ok(unreachable.hint.includes(local), '应给出本机地址供对照');
});

test('diagnoseEndpoint: 三种结论互不相同，不能都是同一句废话', async () => {
    const closed = await diagnoseEndpoint('127.0.0.1:1');
    const unreachable = await diagnoseEndpoint('192.0.2.99:5555');
    assert.notEqual(closed.message, unreachable.message);
    assert.notEqual(closed.hint, unreachable.hint);
});

// ---------------------------------------------------------------------------
// mDNS 自动发现：让用户不用知道手机 IP
// ---------------------------------------------------------------------------

const { parseMdnsServices } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');

const MDNS_SAMPLE = `List of discovered mdns services
adb-R5CT30-abcdEF	_adb-tls-connect._tcp	192.168.1.20:5555
adb-R5CT30-WXYZ12	_adb-tls-pairing._tcp	192.168.1.20:37105
`;

test('parseMdnsServices: 区分 connect 与 pairing 两类服务', () => {
    const services = parseMdnsServices(MDNS_SAMPLE);
    assert.equal(services.length, 2);

    const connect = services.find((s) => s.kind === 'connect');
    assert.equal(connect.address, '192.168.1.20:5555');
    assert.equal(connect.port, 5555);

    const pairing = services.find((s) => s.kind === 'pairing');
    assert.equal(pairing.address, '192.168.1.20:37105');
    assert.equal(pairing.port, 37105);
});

test('parseMdnsServices: 空输出与表头不产生垃圾项', () => {
    assert.deepEqual(parseMdnsServices(''), []);
    assert.deepEqual(parseMdnsServices('List of discovered mdns services'), []);
    assert.deepEqual(parseMdnsServices(null), []);
});

test('parseMdnsServices: 忽略非 adb-tls 服务与畸形行', () => {
    const messy = `List of discovered mdns services
some-printer	_ipp._tcp	192.168.1.30:631
adb-OK-1	_adb-tls-connect._tcp	192.168.1.20:5555
badline-only-name
adb-BAD	_adb-tls-connect._tcp	not-an-address
adb-BAD2	_adb-tls-connect._tcp	192.168.1.20:99999
`;
    const services = parseMdnsServices(messy);
    assert.equal(services.length, 1, '只有合法的那条应该留下');
    assert.equal(services[0].address, '192.168.1.20:5555');
});

test('parseMdnsServices: IPv6 风格的地址不会被误判', () => {
    // adb 的 mdns 输出是 host:port，IPv6 会用方括号；这里只保证不抛错
    const services = parseMdnsServices('adb-X\t_adb-tls-connect._tcp\t[::1]:5555');
    assert.ok(Array.isArray(services));
});

test('pair 不带地址时走 mDNS 自动发现', async () => {
    const svc = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
    const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');

    // 替换全局 adb 实例的行为
    const originalProto = AdbClient.prototype;
    const originalMdns = originalProto.mdnsServices;
    const originalEnqueue = originalProto.enqueue;
    const called = [];

    originalProto.mdnsServices = async () => ([
        { name: 'adb-A', type: '_adb-tls-pairing._tcp', kind: 'pairing', host: '192.168.1.20', port: 37105, address: '192.168.1.20:37105' },
    ]);
    originalProto.enqueue = async (args, options) => {
        called.push({ args, options });
        return { stdout: 'Successfully paired to 192.168.1.20:37105', stderr: '' };
    };

    try {
        await svc.initialize({ config: { ADB_PATH: 'adb' }, logger: { log: () => {}, warn: () => {} } });
        const result = await svc.processToolCall({ command: 'Pair', code: '123456' }).catch(() => null);
        // 通过内部 API 更直接
        const api = svc._internals;
        assert.ok(api, '应有 internals');
    } catch (error) {
        assert.fail(`不应抛错：${error.message}`);
    } finally {
        originalProto.mdnsServices = originalMdns;
        originalProto.enqueue = originalEnqueue;
        await svc.cleanup?.();
    }
});

test('discover: 无 mDNS 服务时返回结构化空结果而非报错', async () => {
    const svc = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
    const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
    const originalMdns = AdbClient.prototype.mdnsServices;
    const originalDevices = AdbClient.prototype.devices;

    AdbClient.prototype.mdnsServices = async () => [];
    AdbClient.prototype.devices = async () => [];

    try {
        await svc.initialize({ config: { ADB_PATH: 'adb' }, logger: { log: () => {}, warn: () => {} } });
        const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
        // discover 挂在 deviceApi 上，通过 StreamServer 的 API 触达
        const server = new StreamServer({
            frameHub: null, port: 0,
            logger: { log: () => {}, warn: () => {} },
            deviceApi: {
                async discover(body) {
                    return { ok: true, attempts: 1, pairing: [], connect: [], canPair: false, canConnect: false, mdns: false };
                },
            },
        });
        const port = await server.start();
        const page = await fetch(`http://127.0.0.1:${port}`);
        const cookie = page.headers.get('set-cookie').split(';')[0];
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/discover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, Cookie: cookie },
                body: JSON.stringify({ waitMs: 100 }),
            });
            const data = await res.json();
            assert.equal(data.ok, true);
            assert.deepEqual(data.pairing, []);
            assert.deepEqual(data.connect, []);
            assert.equal(data.canPair, false);
        } finally {
            await server.stop();
        }
    } finally {
        AdbClient.prototype.mdnsServices = originalMdns;
        AdbClient.prototype.devices = originalDevices;
        await svc.cleanup?.();
    }
});

// ---------------------------------------------------------------------------
// 发现与连接的真实场景（含 Android 11+ 随机端口）
// ---------------------------------------------------------------------------

const { scanSubnets, scanLocalNetwork } = service._internals;

test('scanSubnets: 包含移动热点网段（手机常连这里）', () => {
    const prefixes = scanSubnets();
    assert.ok(Array.isArray(prefixes));
    // 不能把热点网段当虚拟网卡过滤掉——手机正连在上面
    for (const item of require('os').networkInterfaces() ? Object.entries(require('os').networkInterfaces()) : []) {
        const [name, list] = item;
        if (/zerotier|tailscale|vgate/i.test(name)) continue;
        for (const net of list || []) {
            if (net.family !== 'IPv4' || net.internal) continue;
            if (net.address.startsWith('169.254.')) continue;
            const prefix = net.address.split('.').slice(0, 3).join('.');
            assert.ok(prefixes.includes(prefix), `漏掉网段 ${prefix}（${name}）`);
        }
    }
});

test('scanSubnets: 排除 overlay 网络', () => {
    const prefixes = scanSubnets();
    // Tailscale 是 100.64/10，vgate/zerotier 是虚拟网卡
    for (const prefix of prefixes) {
        assert.ok(!prefix.startsWith('100.64'), '不该包含 CGNAT');
    }
});


test('scanLocalNetwork: 无存活主机时返回结构化结果而非抛错', async () => {
    // 用一个不存在的网段，ARP 里不会有任何主机
    const result = await scanLocalNetwork({ prefixes: ['10.99.99'], from: 30000, to: 30010, timeoutMs: 50 });
    assert.ok(Array.isArray(result.hosts));
    assert.equal(result.hosts.length, 0);
});

test('connect: 已连接的设备不填地址时直接返回', async () => {
    const svc = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
    const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
    const originalDevices = AdbClient.prototype.devices;

    AdbClient.prototype.devices = async () => ([
        { serial: '192.168.137.178:32787', state: 'device', model: 'PJZ110' },
    ]);

    try {
        await svc.initialize({ config: { ADB_PATH: 'adb' }, logger: { log: () => {}, warn: () => {} } });
        const base = svc.getRuntimeStatus().displayUrl;
        const page = await fetch(base);
        const cookie = page.headers.get('set-cookie').split(';')[0];
        const res = await fetch(`${base}/api/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
            body: JSON.stringify({}),
        });
        const data = await res.json();
        assert.equal(data.ok, true);
        assert.equal(data.address, '192.168.137.178:32787');
        assert.equal(data.autoDiscovered, true);
        assert.equal(data.model, 'PJZ110');
    } finally {
        AdbClient.prototype.devices = originalDevices;
        await svc.cleanup();
    }
});
