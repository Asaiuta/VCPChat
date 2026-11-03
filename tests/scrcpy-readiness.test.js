'use strict';

/**
 * scrcpy 启动就绪等待的契约。
 *
 * 背景（真机实测，2026-11-02，PJZ110）：
 *   adb forward 建立后，本地 TCP 在 145–209ms 就能「连上」—— 那是 forward
 *   自己的监听 socket，不是设备端服务。此时连接会在 93–108ms 被立即 reset，
 *   收到 0 字节。设备端 abstract socket（/proc/net/unix 里的 scrcpy_<scid>）
 *   在 482–733ms 才出现，握手字节在 923–1056ms 到达。
 *
 * 旧实现用 `setTimeout(resolve, 1800)` 盲等，比实测需要多等 750–880ms，
 * 且没有注释说明来源。这些用例锁住替代实现的行为。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const filename = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub.js');
const source = fs.readFileSync(filename, 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/**
 * @param {object} options
 *   remoteReady   —— 设备端 socket 何时出现：'immediately' | 'never' | number(第几次查询后)
 *   onPoll        —— 每次就绪查询的回调，用于测试在查询期间插入事件
 */
function setup(options = {}) {
    const calls = [];
    const sockets = [];
    const processes = [];
    const polls = [];
    let pollCount = 0;

    const module = { exports: {} };
    const childProcess = {
        execFile(_adb, args, _opts, callback) {
            calls.push(['adb', ...args]);
            const joined = args.join(' ');
            // 就绪查询：cat /proc/net/unix | grep -c scrcpy_<scid>
            if (joined.includes('/proc/net/unix')) {
                pollCount += 1;
                polls.push(pollCount);
                options.onPoll?.(pollCount, polls);
                const wanted = options.remoteReady ?? 'immediately';
                let count = '0';
                if (wanted === 'immediately') count = '1';
                else if (typeof wanted === 'number' && pollCount >= wanted) count = '1';
                queueMicrotask(() => callback(null, `${count}\n`, ''));
                return;
            }
            queueMicrotask(() => callback(null, args[0] === 'devices'
                ? 'List of devices attached\nUSB123 device\n10.0.0.2:5555 device\n'
                : 'PRESENT', ''));
        },
        spawn(_adb, args) {
            calls.push(['spawn', ...args]);
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.kill = () => { proc.killed = true; };
            processes.push(proc);
            return proc;
        },
    };
    const net = {
        createConnection() {
            calls.push(['connect']);
            const socket = new EventEmitter();
            socket.setNoDelay = () => {};
            socket.destroy = () => {
                socket.destroyed = true;
                socket.emit('close');
            };
            sockets.push(socket);
            queueMicrotask(() => {
                if (options.refuseConnect) socket.emit('error', new Error('ECONNRESET'));
                else socket.emit('connect');
            });
            return socket;
        },
    };

    vm.runInNewContext(source, {
        require(name) {
            if (name === 'child_process') return childProcess;
            if (name === 'net') return net;
            return require(name);
        },
        module, exports: module.exports, __dirname: path.dirname(filename), Buffer, console,
        setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 20)),
        clearTimeout,
    }, { filename });

    const { ScrcpyHub } = module.exports;
    ScrcpyHub.findFreePort = async () => 12345;
    const hub = new ScrcpyHub({
        adbPath: 'stub-adb',
        serial: options.serial,
        logger: {},
        readyPollMs: 1,
        readyDeadlineMs: options.readyDeadlineMs ?? 2000,
        ...options.hubOptions,
    });
    return { hub, calls, sockets, processes, polls, ScrcpyHub };
}

test('设备端 socket 立即就绪时不额外轮询，直接连', { timeout: 15000 }, async () => {
    const { hub, polls, calls } = setup({ remoteReady: 'immediately' });
    await hub.start();
    assert.equal(hub.state, 'streaming');
    assert.equal(polls.length, 1, '第一次查询就绪即返回，不该有第二次');
    assert.ok(calls.some((call) => call[0] === 'connect'));
    await hub.stop();
});

test('设备端 socket 迟到时按轮询等待，不在固定时长上盲等', { timeout: 15000 }, async () => {
    // 第 3 次查询才出现，模拟 482–733ms 的实测就绪点
    const { hub, polls } = setup({ remoteReady: 3 });
    await hub.start();
    assert.equal(hub.state, 'streaming');
    assert.equal(polls.length, 3, '应恰好轮询到就绪那一次为止');
    await hub.stop();
});

test('就绪查询自身失败不阻塞启动：超时后照常尝试连接', { timeout: 15000 }, async () => {
    const { hub } = setup({ remoteReady: 'never', readyDeadlineMs: 50 });
    // 设备端始终查不到 socket。启动不应因此失败 —— 查询只是加速手段，
    // 真正的判据是后续握手；查不到就把等待预算耗完然后直接连。
    await hub.start();
    assert.equal(hub.state, 'streaming');
    await hub.stop();
});

test('readyDeadlineMs 为 0 时完全跳过轮询', { timeout: 15000 }, async () => {
    const { hub, polls } = setup({ readyDeadlineMs: 0 });
    await hub.start();
    assert.equal(hub.state, 'streaming');
    assert.equal(polls.length, 0, '显式关闭轮询后不得产生就绪查询');
    await hub.stop();
});

test('轮询期间 stop 必须取消启动且不再产生连接', { timeout: 15000 }, async () => {
    const gate = deferred();
    const entered = deferred();
    const { hub, calls } = setup({
        remoteReady: 'never',
        onPoll(count) {
            if (count === 1) { entered.resolve(); }
            // 第一次查询挂起，让 stop 有机会介入
            if (count === 1) gate.promise.catch(() => {});
        },
    });
    const startResult = hub.start().then((value) => ({ value }), (error) => ({ error }));
    await entered.promise;
    const stop = hub.stop();
    gate.resolve();
    const result = await startResult;
    await stop;
    assert.ok(result.error, '被取消的启动必须 reject');
    assert.equal(hub.state, 'stopped');
    assert.equal(hub.socket, null);
    assert.equal(hub.serverProc, null);
    // 取消后不得再建立连接
    const connects = calls.filter((call) => call[0] === 'connect').length;
    await tick();
    assert.equal(calls.filter((call) => call[0] === 'connect').length, connects);
});

test('实现不得再用常量固定睡眠，就绪判定必须来自实测信号', () => {
    const text = fs.readFileSync(filename, 'utf8')
        // 扫描前先去掉行注释：注释里记录旧实现（1800ms）不算违规，
        // 否则这条判据会被自己的说明文字绊倒。
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    // 允许小退避（<=600ms），禁止 700ms 以上的匿名固定等待。
    // 旧实现是 setTimeout(resolve, 1800)。
    const literals = [...text.matchAll(/setTimeout\([^)]*?,\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
    const big = literals.filter((ms) => ms > 600);
    assert.deepEqual(big, [], `不得存在 >600ms 的匿名固定睡眠，实际发现 ${JSON.stringify(big)}`);
});

test('就绪轮询使用 SESSION 级 scid，不会误判其它会话或残留 socket', () => {
    const text = fs.readFileSync(filename, 'utf8');
    assert.ok(/scrcpy_\$\{/.test(text) || /scrcpy_\$/.test(text),
        '就绪查询必须按 scid 精确匹配，不能只 grep app_process');
});
