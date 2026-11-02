'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test('ADB 排队时固定serial，后续切换默认设备不改变已提交命令', async () => {
    const client = new AdbClient({ serial: 'A' });
    const blocker = deferred();
    const before = client.queue.push(() => blocker.promise);
    const calls = [];
    client.runRaw = async (args, options) => { calls.push(options); return { stdout: '' }; };
    const command = client.runText(['shell', 'input', 'tap', '1', '2']);
    client.serial = 'B';
    blocker.resolve();
    await Promise.all([before, command]);
    assert.equal(calls[0].serial, 'A');
});

test('ADB 排队消耗完连接预算后不启动子进程', async () => {
    const client = new AdbClient({ serial: 'A' });
    const blocker = deferred();
    const before = client.queue.push(() => blocker.promise);
    let calls = 0;
    client.runRaw = async () => { calls += 1; return { stdout: '' }; };
    const command = client.runText(['connect', '10.0.0.1:40000'], { noSelector: true, deadlineMs: Date.now() - 1 });
    blocker.resolve();
    await before;
    await assert.rejects(command, (error) => error.code === 'ADB_TIMEOUT');
    assert.equal(calls, 0);
});

test('devices和mdns向队列传递预算及全局命令标记', async () => {
    const client = new AdbClient();
    const calls = [];
    client.runText = async (args, options) => { calls.push(options); return ''; };
    const options = { timeoutMs: 17, deadlineMs: Date.now() + 100 };
    await client.devices(options);
    await client.mdnsServices(options);
    assert.ok(calls.every((call) => call.noSelector && call.timeoutMs === 17 && call.deadlineMs === options.deadlineMs));
});

test('ADB deadline 在排队时到期即返回，之后释放队头也不执行过期任务', async () => {
    const client = new AdbClient();
    const blocker = deferred();
    const head = client.queue.push(() => blocker.promise);
    let calls = 0;
    client.runRaw = async () => { calls += 1; return { stdout: '' }; };
    let rejected = false;
    const command = client.runText(['devices'], { deadlineMs: Date.now() + 10 });
    const observed = command.then(() => null, (error) => { rejected = true; return error; });
    await new Promise((resolve) => setTimeout(resolve, 35));
    const returnedBeforeHead = rejected;
    blocker.resolve();
    await head;
    const error = await observed;
    await client.queue.tail;
    assert.equal(returnedBeforeHead, true);
    assert.equal(error.code, 'ADB_TIMEOUT');
    assert.equal(calls, 0);
});


test('ADB 队列失败不污染后续FIFO，保留falsy拒绝原因', async () => {
    const client = new AdbClient();
    const order = [];
    const first = client.queue.push(() => { order.push('first'); return Promise.reject(0); });
    const observed = first.then(() => ({ resolved: true }), (reason) => ({ reason }));
    const second = client.queue.push(() => { order.push('second'); return 'ok'; });
    assert.deepEqual(await observed, { reason: 0 });
    assert.equal(await second, 'ok');
    await client.queue.tail;
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(client.queue.depth, 0);
});
