'use strict';

/**
 * UI 采集服务（u2 JSON-RPC）的契约。
 *
 * 背景（真机实测，PJZ110 / Android 17，2026-11-02）：
 *   CLI 路径 `exec-out uiautomator dump --compressed /dev/tty` 每次都要冷启
 *   一个 VM + 连 UiAutomation + 等 idle，实测 p50 ≈ 2300ms；动画密集页面上
 *   `waitForIdle` 会卡到 11 秒并输出 "ERROR: could not get idle state."。
 *
 *   把 openatx/android-uiautomator-server 的 u2.apk 推到 /data/local/tmp、
 *   用 app_process 当 classpath 起成常驻 JSON-RPC 服务（**不 install**）后，
 *   同一页面 dumpWindowHierarchy 实测 p50 61ms、p95 122ms、40/40 成功，
 *   输出的仍是同一份 uiautomator XML（121 节点，属性一致）。
 *
 * 这些用例锁住接入后的行为。全部走假 transport，不依赖真机。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const LIB = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js');
const source = fs.readFileSync(LIB, 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const XML_OK = '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?>\r\n'
    + '<hierarchy rotation="0">\r\n  <node index="0" text="Go" resource-id="btn" '
    + 'class="android.widget.Button" package="com.example" bounds="[0,0][100,50]" />\r\n</hierarchy>';

/**
 * 假世界：可控的 adb、HTTP、端口、进程。
 *   remoteJar     —— 设备上 /data/local/tmp/u2.apk 是否已存在
 *   readyAfter    —— 第几次 ping 起返回 pong（Infinity 表示永不就绪）
 *   portsInUse    —— 这些端口 listen 失败，用来验证动态挑端口
 */
function setup(options = {}) {
    const calls = [];
    const spawned = [];
    const forwards = new Set();
    const timers = [];
    let pingCount = 0;

    const childProcess = {
        execFile(file, args, opts, callback) {
            calls.push(['execFile', file, ...args]);
            const joined = args.join(' ');
            queueMicrotask(() => {
                if (args.includes('shell') && joined.includes('u2-server-')) {
                    // 复刻真实 adb 语义：`[ -f <remote> ] && echo PRESENT` 在文件不存在时
                    // 退出码是 **1**，而 execFile 把任何非零退出码当失败。
                    // 替身若一味返回成功，就测不出「首次接入静默回退 CLI」这个故障。
                    const hasFallback = joined.includes('||');
                    if (options.remoteJar === false && !hasFallback) {
                        callback(Object.assign(new Error('Command failed: adb shell'), { code: 1 }), '', '');
                        return;
                    }
                    callback(null, options.remoteJar === false ? 'ABSENT\n' : 'PRESENT\n', '');
                    return;
                }
                if (args.includes('push')) {
                    callback(null, '1 file pushed.\n', '');
                    return;
                }
                if (args[0] === 'devices') {
                    callback(null, 'List of devices attached\nUSB123\tdevice\n', '');
                    return;
                }
                callback(null, '', '');
            });
        },
        spawn(file, args) {
            calls.push(['spawn', file, ...args]);
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.killed = false;
            proc.kill = () => {
                proc.killed = true;
                if (!options.deferExit) queueMicrotask(() => proc.emit('exit', null));
            };
            spawned.push({ file, args, proc });
            return proc;
        },
    };

    const net = {
        createServer() {
            const server = new EventEmitter();
            let bound = null;
            server.listen = (port, host, cb) => {
                queueMicrotask(() => {
                    if (port === 0 && options.failEphemeral) {
                        server.emit('error', Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }));
                        return;
                    }
                    if (options.portsInUse?.includes(port)) {
                        server.emit('error', Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }));
                        return;
                    }
                    bound = { port: port === 0 ? (options.nextPort ?? 41000) : port };
                    cb?.();
                });
            };
            server.address = () => bound;
            server.close = (cb) => { queueMicrotask(() => cb?.()); };
            return server;
        },
    };

    function httpRequest(reqOptions, onResponse) {
        const req = new EventEmitter();
        const chunks = [];
        req.destroy = () => { req.destroyed = true; };
        req.write = (chunk) => { chunks.push(Buffer.from(chunk)); };
        req.end = () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            calls.push(['rpc', body.method, body.params]);
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            res.destroy = () => { res.destroyed = true; };
            let payload;
            if (body.method === 'ping') {
                pingCount += 1;
                const ready = pingCount >= (options.readyAfter ?? 1);
                payload = ready
                    ? { jsonrpc: '2.0', id: body.id, result: 'pong' }
                    : { jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'not ready' } };
            } else {
                payload = {
                    jsonrpc: '2.0', id: body.id,
                    result: body.method === 'dumpWindowHierarchy' ? (options.xml ?? XML_OK) : null,
                };
            }
            queueMicrotask(() => {
                if (req.destroyed) return;
                onResponse(res);
                if (options.silent) return;
                res.emit('data', JSON.stringify(payload));
                res.emit('end');
            });
        };
        return req;
    }

    const http = { request: httpRequest };

    const module = { exports: {} };
    vm.runInNewContext(source, {
        require(name) {
            if (name === 'child_process') return childProcess;
            if (name === 'net') return net;
            if (name === 'http') return http;
            // 库内相对依赖（如 ./rpc-methods）必须相对被测文件解析，
            // 不能落到测试文件自己的目录下 —— 那样只会报 MODULE_NOT_FOUND。
            if (name.startsWith('.')) return require(path.resolve(path.dirname(LIB), name));
            return require(name);
        },
        module, exports: module.exports, __dirname: path.dirname(LIB),
        Buffer, console, process: { platform: 'win32' },
        setTimeout: (cb, ms) => { const t = setTimeout(cb, Math.min(ms, 15)); timers.push(t); return t; },
        clearTimeout,
        Date,
        JSON,
        Promise,
        Number,
        String,
        Boolean,
        Object,
        Array,
        Error,
        Math,
    }, { filename: LIB });

    return { ...module.exports, calls, spawned, forwards, timers };
}

test('就绪前不会 dump：ping 成功后服务才可用', async () => {
    const api = setup({ readyAfter: 3 });
    const server = new api.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    const ready = await server.start();
    assert.equal(ready.ok, true, '应最终就绪');
    assert.equal(server.isReady(), true);
    const pings = api.calls.filter((c) => c[0] === 'rpc' && c[1] === 'ping');
    assert.equal(pings.length, 3, `应恰好 ping 到就绪为止，实际 ${pings.length}`);
    await server.stop();
});

test('端口动态挑选：内核分配的端口被 forward 与 -p 同时使用', async () => {
    const api = setup({ nextPort: 41234 });
    const server = new api.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    await server.start();
    const port = server.port;
    assert.equal(port, 41234, '应优先用内核分配的端口');
    const spawnArgs = api.spawned[0].args.join(' ');
    assert.ok(spawnArgs.includes(`-p ${port}`), `app_process 必须带同一个端口，实际：${spawnArgs}`);
    const fwd = api.calls.filter((c) => c[0] === 'execFile' && c.slice(2).includes('forward'));
    assert.ok(fwd.some((c) => c.join(' ').includes(`tcp:${port}`)), 'adb forward 必须指向同一端口');
    await server.stop();
});

test('端口回退：内核分配失败时跳过被占用候选，落到下一个空闲端口', async () => {
    const api = setup({ failEphemeral: true, portsInUse: [9008, 9009] });
    const server = new api.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    await server.start();
    const port = server.port;
    assert.equal(port, 9010, `应跳过被占用的 9008/9009，实际 ${port}`);
    const spawnArgs = api.spawned[0].args.join(' ');
    assert.ok(spawnArgs.includes(`-p ${port}`), `app_process 必须带同一个端口，实际：${spawnArgs}`);
    const fwd = api.calls.filter((c) => c[0] === 'execFile' && c.slice(2).includes('forward'));
    assert.ok(fwd.some((c) => c.join(' ').includes(`tcp:${port}`)), 'adb forward 必须指向同一端口');
    await server.stop();
});

test('不 install：只用 CLASSPATH + app_process，绝不调用 pm install', async () => {
    const api = setup();
    const server = new api.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    await server.start();
    const flat = api.calls.map((c) => c.join(' ')).join('\n');
    assert.ok(!/\bpm\s+install\b/.test(flat), '不得执行 pm install');
    assert.ok(!/\badb\b.*\binstall\b/.test(flat), '不得执行 adb install');
    const spawnLine = api.spawned[0].args.join(' ');
    assert.ok(spawnLine.includes('CLASSPATH='), `必须通过 CLASSPATH 加载，实际：${spawnLine}`);
    assert.ok(spawnLine.includes('com.github.uiautomator2.Console'), '必须启动 Console 入口');
    await server.stop();
});

test('设备上缺 apk 时先 push，已在则跳过', async () => {
    const pushes = (world) => world.calls.filter((c) => c[0] === 'execFile' && c.slice(2).includes('push'));

    const present = setup();
    const s1 = new present.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    await s1.start();
    assert.equal(pushes(present).length, 0,
        'apk 已存在时不得重复 push（3.7MB 每次都推太浪费）');
    await s1.stop();

    const missing = setup({ remoteJar: false });
    const s2 = new missing.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    const started2 = await s2.start();
    assert.equal(started2.ok, true,
        `缺 apk 时应先 push 再拉起服务，实际 ${JSON.stringify(started2)}`);
    assert.equal(pushes(missing).length, 1, 'apk 缺失时必须 push 一次');
    await s2.stop();
});

test('dump 返回的 XML 直接可用于 parseUiGraph', async () => {
    const api = setup();
    const server = new api.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    await server.start();
    const { xml } = await server.dump();
    assert.match(xml, /<hierarchy/, '必须返回 uiautomator 风格 XML');
    assert.match(xml, /<node/, '必须含节点');
    const { parseUiGraph } = require(path.resolve(__dirname,
        '../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph'));
    const graph = parseUiGraph(xml, { limit: 60, screen: { width: 1080, height: 2400 } });
    assert.ok(graph.total >= 1, `解析器必须能吃这份 XML，total=${graph.total}`);
    await server.stop();
});

test('dump 请求的 maxDepth 必须为正：0 或负数在 uiautomator2 下只返回根节点', async () => {
    // 真机实测（PJZ110 / Android 17 / u2-server-0.5.0）：maxDepth=0 与 -1 都只回 1 个 <node>，
    // 而同一屏 maxDepth>=60 返回完整树（130 节点）。传 0 会让 RPC 快路径拿到「成功但只有根」的树，
    // 上层以为界面是空的，于是永远不回退 CLI —— Observe 的 controls 全为 0。
    const api = setup();
    const server = new api.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    await server.start();

    await server.dump();
    const defaults = api.calls.filter(call => call[1] === 'dumpWindowHierarchy').at(-1);
    assert.ok(Number.isInteger(defaults[2][1]) && defaults[2][1] > 0,
        `默认 maxDepth 必须是正整数，实际 ${JSON.stringify(defaults[2][1])}`);

    for (const requested of [0, -1, 1.5, 'x']) {
        await server.dump({ maxDepth: requested });
        const call = api.calls.filter(item => item[1] === 'dumpWindowHierarchy').at(-1);
        assert.ok(Number.isInteger(call[2][1]) && call[2][1] > 0,
            `maxDepth=${JSON.stringify(requested)} 必须被校正为正整数，实际 ${JSON.stringify(call[2][1])}`);
    }

    await server.dump({ maxDepth: 75 });
    const explicit = api.calls.filter(call => call[1] === 'dumpWindowHierarchy').at(-1);
    assert.equal(explicit[2][1], 75, '显式正数必须原样透传');
    await server.stop();
});


test('服务未就绪时 dump 失败而不是返回半截数据', async () => {
    const api = setup({ readyAfter: Infinity });
    const server = new api.UiServer({
        adbPath: 'stub-adb', serial: 'USB123', readyTimeoutMs: 60,
    });
    const result = await server.start();
    assert.equal(result.ok, false, '一直等不到 pong 必须报未就绪');
    assert.ok(result.reason, '必须给出原因');
    await assert.rejects(() => server.dump(), /未就绪|not ready|UI_SERVER/i,
        '未就绪时 dump 必须抛错，不能返回空树让调用方误判「界面是空的」');
    await server.stop();
});

test('stop 后进程被回收、forward 被移除，且不残留端口', async () => {
    const api = setup();
    const server = new api.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    await server.start();
    const port = server.port;
    const proc = api.spawned[0].proc;
    await server.stop();
    assert.equal(proc.killed, true, '必须杀掉 app_process');
    assert.equal(server.isReady(), false);
    assert.equal(server.port, null);
    const removals = api.calls.filter((c) => c[0] === 'execFile'
        && c.join(' ').includes('forward') && c.join(' ').includes('--remove'));
    assert.ok(removals.some((c) => c.join(' ').includes(`tcp:${port}`)), '必须移除 forward');
});

test('重复 start 复用同一个服务，不重复拉进程', async () => {
    const api = setup();
    const server = new api.UiServer({ adbPath: 'stub-adb', serial: 'USB123' });
    await server.start();
    const spawnedBefore = api.spawned.length;
    await server.start();
    assert.equal(api.spawned.length, spawnedBefore, '已就绪时 start 不得再拉一次进程');
    await server.stop();
});

test('rpc 调用有超时：服务卡死不会让 Observe 永久挂住', async () => {
    const api = setup({ silent: true });
    const server = new api.UiServer({
        adbPath: 'stub-adb', serial: 'USB123', rpcTimeoutMs: 40, readyTimeoutMs: 40,
    });
    const at = Date.now();
    await server.start();
    await assert.rejects(() => server.dump(), /超时|timeout|未就绪|UI_SERVER/i);
    assert.ok(Date.now() - at < 3000, '超时必须生效，不能挂死');
    await server.stop();
});

test('vendor 里存在与实现约定一致的 apk 文件名', () => {
    const vendor = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/vendor');
    const files = fs.readdirSync(vendor);
    const apk = files.find((f) => /^u2-server-.*\.apk$/.test(f));
    assert.ok(apk, `vendor 下应有 u2-server-*.apk，实际 ${JSON.stringify(files)}`);
    const size = fs.statSync(path.join(vendor, apk)).size;
    assert.ok(size > 3 * 1024 * 1024, `apk 大小异常：${size}`);
    assert.match(source, /u2-server/, '实现必须引用该 vendor 资产');
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

for (const phase of ['_ensureApk', '_pickPort', '_forward', '_waitReady']) {
    test(`stop invalidates and drains startup blocked in ${phase}`, async () => {
        const api = setup({ deferExit: true });
        const server = new api.UiServer({ serial: 'USB123' });
        const entered = deferred();
        const release = deferred();
        const original = server[phase].bind(server);
        server[phase] = async (...args) => {
            entered.resolve();
            await release.promise;
            return original(...args);
        };
        const starting = server.start();
        await entered.promise;
        let stopped = false;
        const stopping = server.stop().then(() => { stopped = true; });
        await tick();
        const stoppedBeforeDrain = stopped;
        release.resolve();
        const result = await starting;
        await stopping;
        assert.equal(stoppedBeforeDrain, false, 'stop must drain pending startup');
        assert.equal(result.ok, false, 'invalidated startup must not report success');
        assert.equal(server.isReady(), false);
        assert.equal(server.port, null);
        assert.ok(api.spawned.every(({ proc }) => proc.killed), 'no live orphan process');
        const forwardCalls = api.calls.filter((c) => c[0] === 'execFile' && c.includes('forward'));
        const created = forwardCalls.filter((c) => !c.includes('--remove'));
        const removed = forwardCalls.filter((c) => c.includes('--remove'));
        for (const call of created) {
            assert.ok(removed.some((removal) => removal.at(-1) === call.at(-1)), 'no orphan forward');
        }
        if (phase === '_ensureApk' || phase === '_pickPort') {
            assert.equal(created.length, 0, 'cancelled preparation must not forward');
        }
    });
}

for (const event of ['exit', 'error']) {
    test(`late old-process ${event} cannot invalidate a new instance`, async () => {
        const api = setup({ deferExit: true });
        const server = new api.UiServer({ serial: 'USB123' });
        assert.equal((await server.start()).ok, true);
        const old = api.spawned[0].proc;
        await server.stop();
        assert.equal((await server.start()).ok, true);
        const current = server._proc;
        old.emit(event, event === 'error' ? new Error('late error') : 0);
        assert.equal(server._proc, current);
        assert.equal(server.isReady(), true);
        await server.stop();
    });
}

test('start during stop waits for old forward cleanup before creating new resources', async () => {
    const api = setup({ deferExit: true });
    const server = new api.UiServer({ serial: 'USB123' });
    await Promise.all([server.start(), server.start()]);
    assert.equal(api.spawned.length, 1, 'concurrent start must share startup');
    const entered = deferred();
    const release = deferred();
    const remove = server._removeForward.bind(server);
    server._removeForward = async (port) => {
        entered.resolve();
        await release.promise;
        return remove(port);
    };
    const stopping = server.stop();
    await entered.promise;
    const restarting = server.start();
    await tick();
    assert.equal(api.spawned.length, 1, 'new start must wait for cleanup');
    release.resolve();
    await stopping;
    assert.equal((await restarting).ok, true);
    assert.equal(api.spawned.length, 2);
    assert.equal(server.isReady(), true);
    await server.stop();
});

