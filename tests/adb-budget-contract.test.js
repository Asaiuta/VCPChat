'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
function blockedClient(options = {}) {
    const client = new AdbClient(options);
    const gate = deferred();
    const head = client.queue.push(() => gate.promise);
    const calls = [];
    client.runRaw = async (args, request) => { calls.push({ args, ...request }); return { stdout: '' }; };
    return { client, calls, release: async () => { gate.resolve(); await head; await client.queue.tail; } };
}
function fakeExecClient(exec) {
    const filename = require.resolve('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
    const module = { exports: {} };
    const productionRequire = createRequire(filename);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: (name) => name === 'child_process' ? { execFile: exec } : productionRequire(name),
        console, Buffer, setTimeout, clearTimeout, AbortController, AbortSignal,
    }, { filename });
    return new module.exports.AdbClient({ adbPath: 'never-execute-adb' });
}

test('默认提交预算在队头未释放时到期，之后不执行且释放容量', async () => {
    const { client, calls, release } = blockedClient({ timeoutMs: 20 });
    try {
        const outcome = client.enqueue(['devices']).catch((error) => error);
        const error = await Promise.race([outcome, wait(250).then(() => null)]);
        assert.equal(error?.code, 'ADB_TIMEOUT');
        assert.equal(client.queue.depth, 1);
    } finally { await release(); }
    assert.equal(calls.length, 0);
});

test('执行只得到提交预算减去排队时间的剩余部分', async () => {
    const { client, calls, release } = blockedClient({ timeoutMs: 200 });
    const submitted = Date.now();
    const command = client.enqueue(['devices']);
    await wait(35);
    await release();
    await command;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].deadlineMs, submitted + 200);
    assert.ok(calls[0].timeoutMs > 0 && calls[0].timeoutMs <= 170);
});

test('显式更晚deadline不能延长默认预算，更早deadline收紧预算', async () => {
    const client = new AdbClient({ timeoutMs: 200 });
    const calls = [];
    client.runRaw = async (args, options) => { calls.push(options); return { stdout: '' }; };
    const start = Date.now();
    await client.enqueue(['devices'], { deadlineMs: start + 10000 });
    await client.enqueue(['devices'], { deadlineMs: start + 100 });
    assert.ok(calls[0].deadlineMs <= start + 210);
    assert.equal(calls[1].deadlineMs, start + 100);
    assert.ok(calls[1].timeoutMs <= 100);
});

test('提交时固定timeout和serial，configure不改变排队请求', async () => {
    const { client, calls, release } = blockedClient({ timeoutMs: 200, serial: 'A' });
    const command = client.enqueue(['devices']);
    client.configure({ timeoutMs: 10000, serial: 'B' });
    await release();
    await command;
    assert.equal(calls[0].serial, 'A');
    assert.ok(calls[0].timeoutMs <= 200);
});

test('容量包含执行中与排队任务，满载立即ADB_QUEUE_FULL', async () => {
    const { client, release } = blockedClient({ maxQueueSize: 2 });
    const queued = client.enqueue(['one']);
    const overflow = client.enqueue(['two']).catch((error) => error);
    try {
        const error = await Promise.race([overflow, wait(100).then(() => null)]);
        assert.equal(error?.code, 'ADB_QUEUE_FULL');
        assert.equal(client.queue.depth, 2);
    } finally { await release(); await queued; }
});

test('排队取消立即拒绝并释放容量，之后永不执行，可接纳替代请求', async () => {
    const { client, calls, release } = blockedClient({ maxQueueSize: 2 });
    const controller = new AbortController();
    const cancelled = client.enqueue(['cancelled'], { signal: controller.signal }).catch((error) => error);
    controller.abort();
    let replacement;
    try {
        const error = await Promise.race([cancelled, wait(100).then(() => null)]);
        assert.equal(error?.code, 'ADB_ABORTED');
        assert.equal(client.queue.depth, 1);
        replacement = client.enqueue(['replacement']);
    } finally { await release(); if (replacement) await replacement; }
    assert.deepEqual(calls.map((call) => call.args), [['replacement']]);
});

test('已取消信号不入队也不执行', async () => {
    const client = new AdbClient();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    client.runRaw = async () => { calls += 1; return { stdout: '' }; };
    await assert.rejects(client.enqueue(['devices'], { signal: controller.signal }), { code: 'ADB_ABORTED' });
    assert.equal(calls, 0);
    assert.equal(client.queue.depth, 0);
});

test('默认容量有限且configure可调整容量，无效容量保持已有配置', async () => {
    const { client, release } = blockedClient();
    const accepted = [];
    let full = false;
    try {
        for (let i = 0; i < 100; i += 1) {
            const command = client.enqueue([String(i)]);
            command.catch(() => {});
            accepted.push(command);
        }
        full = client.queue.depth <= 64;
    } finally { await release(); await Promise.allSettled(accepted); }
    assert.equal(full, true);
    client.configure({ maxQueueSize: 1 });
    client.configure({ maxQueueSize: 0 });
    const gate = deferred();
    const head = client.queue.push(() => gate.promise);
    const overflow = client.enqueue(['devices']).catch((error) => error);
    try {
        const error = await Promise.race([overflow, wait(100).then(() => null)]);
        assert.equal(error?.code, 'ADB_QUEUE_FULL');
    } finally { gate.resolve(); await head; }
});

test('执行期AbortSignal原样透传execFile并映射ADB_ABORTED', async () => {
    const controller = new AbortController();
    let seen;
    const client = fakeExecClient((file, argv, options, callback) => {
        seen = options;
        const fallback = setTimeout(() => callback(null, '', ''), 100);
        options.signal?.addEventListener('abort', () => {
            clearTimeout(fallback);
            callback(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }), '', '');
        }, { once: true });
        return new EventEmitter();
    });
    const command = client.enqueue(['devices'], { signal: controller.signal });
    await Promise.resolve();
    assert.equal(seen.signal, controller.signal);
    controller.abort();
    await assert.rejects(command, { code: 'ADB_ABORTED' });
});

test('execFile仍以参数数组执行，保留timeout、buffer、encoding和stdin', async () => {
    let seen;
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (input) => { seen.input = input; };
    const client = fakeExecClient((file, argv, options, callback) => {
        seen = { file, argv, options };
        queueMicrotask(() => callback(null, Buffer.from('ok'), ''));
        return child;
    });
    const result = await client.enqueue(['shell', 'literal;not-shell'], {
        serial: 'A', timeoutMs: 100, maxBuffer: 1234, encoding: 'buffer', input: 'code\n',
    });
    assert.deepEqual(Array.from(seen.argv), ['-s', 'A', 'shell', 'literal;not-shell']);
    assert.ok(seen.options.timeout > 0 && seen.options.timeout <= 100);
    assert.equal(seen.options.maxBuffer, 1234);
    assert.equal(seen.options.encoding, 'buffer');
    assert.equal(seen.options.shell, undefined);
    assert.equal(seen.input, 'code\n');
    assert.equal(result.stdout.toString(), 'ok');
});

test('withContext继承整步预算与信号，显式更晚deadline不能放宽', async () => {
    const client = new AdbClient({ timeoutMs: 1000 });
    const controller = new AbortController();
    const deadlineMs = Date.now() + 500;
    let seen;
    client.runRaw = async (args, options) => { seen = options; return { stdout: '' }; };
    await client.withContext({ deadlineMs, signal: controller.signal }, () => client.enqueue(['devices'], { deadlineMs: deadlineMs + 10000 }));
    assert.equal(seen.deadlineMs, deadlineMs);
    assert.equal(seen.signal, controller.signal);
});

test('withContext并发隔离，作用域结束不泄漏，嵌套只能收紧', async () => {
    const client = new AdbClient({ timeoutMs: 1000 });
    const seen = [];
    client.runRaw = async (args, options) => { seen.push({ name: args[0], ...options }); return { stdout: '' }; };
    const deadlineA = Date.now() + 500;
    const deadlineB = deadlineA + 100;
    await Promise.all([
        client.withContext({ deadlineMs: deadlineA }, async () => {
            await wait(10);
            await client.withContext({ deadlineMs: deadlineB }, () => client.enqueue(['A']));
        }),
        client.withContext({ deadlineMs: deadlineB }, () => client.enqueue(['B'])),
    ]);
    await client.enqueue(['outside']);
    assert.equal(seen.find((call) => call.name === 'A').deadlineMs, deadlineA);
    assert.equal(seen.find((call) => call.name === 'B').deadlineMs, deadlineB);
    assert.ok(seen.find((call) => call.name === 'outside').deadlineMs > deadlineB);
});

test('withContext和请求任一信号取消都能阻止排队执行', async () => {
    for (const abortContext of [true, false]) {
        const { client, calls, release } = blockedClient();
        const context = new AbortController();
        const request = new AbortController();
        let command;
        try {
            command = client.withContext({ signal: context.signal }, () => client.enqueue(['devices'], { signal: request.signal })).catch((error) => error);
            (abortContext ? context : request).abort();
            const error = await Promise.race([command, wait(100).then(() => null)]);
            assert.equal(error?.code, 'ADB_ABORTED');
        } finally { await release(); if (command) await command; }
        assert.equal(calls.length, 0);
    }
});



test('fake execFile按剩余预算超时，队列之后仍可执行', async () => {
    const seen = [];
    const client = fakeExecClient((file, argv, options, callback) => {
        seen.push(options.timeout);
        setTimeout(() => callback(Object.assign(new Error('timeout'), { killed: true }), '', ''), options.timeout);
        return new EventEmitter();
    });
    const gate = deferred();
    const head = client.queue.push(() => gate.promise);
    const command = client.enqueue(['devices'], { timeoutMs: 100 });
    const observed = command.catch((error) => error);
    await wait(30);
    gate.resolve();
    await head;
    assert.equal((await observed).code, 'ADB_TIMEOUT');
    assert.ok(seen[0] > 0 && seen[0] <= 75);
    client.runRaw = async () => ({ stdout: 'next' });
    assert.equal((await client.enqueue(['next'])).stdout, 'next');
    assert.equal(client.queue.depth, 0);
});

test('排队及执行完成后移除取消监听器', async () => {
    const { getEventListeners } = require('node:events');
    const { client, release } = blockedClient();
    const controller = new AbortController();
    const command = client.enqueue(['devices'], { signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    await release();
    await command;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('withContext同步异常后不泄漏上下文', async () => {
    const client = new AdbClient();
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => client.withContext({ signal: controller.signal }, () => { throw new Error('scope'); }), /scope/);
    client.runRaw = async () => ({ stdout: 'outside' });
    assert.equal((await client.enqueue(['devices'])).stdout, 'outside');
});