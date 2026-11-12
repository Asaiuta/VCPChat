'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function fixture(options = {}) {
    const client = new AdbClient({ timeoutMs: 2000, ...options });
    const gates = new Map();
    const calls = [];
    client.runRaw = async (args, request) => {
        const name = args.join(' ');
        calls.push({ name, ...request });
        if (gates.has(name)) await gates.get(name).promise;
        return { stdout: name };
    };
    return { client, calls, hold(name) { const gate = deferred(); gates.set(name, gate); return gate; } };
}

test('independent device B runs while A is blocked, but the next A stays FIFO', async () => {
    const { client, calls, hold } = fixture();
    const gate = hold('A1');
    const first = client.enqueue(['A1'], { serial: 'A' });
    const second = client.enqueue(['A2'], { serial: 'A' });
    const other = client.enqueue(['B1'], { serial: 'B' });
    try {
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1']);
        assert.equal((await other).stdout, 'B1');
        assert.equal(client.queueStats().running, true);
        assert.equal(client.queueStats().depth, 2);
    } finally { gate.resolve(); await Promise.all([first, second, other]); }
    assert.deepEqual(calls.map(call => call.name), ['A1', 'B1', 'A2']);
    assert.equal(client.queueStats().completed, 3);
});

test('diagnostics expose per-selector occupancy and show aliases as distinct, unserialized keys', async () => {
    const { client, calls, hold } = fixture();
    const usb = hold('A1');
    const wifi = hold('W1');
    const work = [
        client.enqueue(['A1'], { serial: 'A' }),
        client.enqueue(['A2'], { serial: 'A' }),
        client.enqueue(['W1'], { serial: '10.0.0.2:5555' }),
    ];
    try {
        await tick();
        // Same phone over USB and Wi-Fi: both run concurrently — the queue cannot see they alias.
        assert.deepEqual(calls.map(call => call.name), ['A1', 'W1']);
        const stats = client.queueStats();
        assert.equal(stats.keyNamespace, 'adb-selector');
        assert.deepEqual(stats.activeKeys, ['10.0.0.2:5555', 'A']);
        assert.deepEqual(stats.pendingByKey, { A: 1 });
        assert.equal(stats.exclusiveRunning, false);
        assert.equal(stats.pendingExclusive, 0);
        const snapshot = JSON.stringify(stats);
        assert.equal(JSON.stringify(client.queueStats()), snapshot, 'diagnostics must not mutate scheduling');
    } finally { usb.resolve(); wifi.resolve(); await Promise.all(work); }
    const idle = client.queueStats();
    assert.deepEqual(idle.activeKeys, []);
    assert.deepEqual(idle.pendingByKey, {});
});

test('host devices discovery is not blocked by a device command', async () => {
    const { client, calls, hold } = fixture({ serial: 'A' });
    const gate = hold('A1');
    const first = client.enqueue(['A1']);
    const discovery = client.devices();
    try {
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1', 'devices -l']);
        await discovery;
    } finally { gate.resolve(); await Promise.all([first, discovery]); }
});

test('a global management command fences all earlier work and every later device or host read', async () => {
    const { client, calls, hold } = fixture();
    const a = hold('A1');
    const b = hold('B1');
    const global = hold('disconnect');
    const tasks = [client.enqueue(['A1'], { serial: 'A' }), client.enqueue(['B1'], { serial: 'B' })];
    try {
        await tick();
        tasks.push(client.enqueue(['disconnect'], { noSelector: true }));
        tasks.push(client.enqueue(['B2'], { serial: 'B' }));
        tasks.push(client.devices());
        b.resolve();
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1']);
        a.resolve();
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1', 'disconnect']);
        global.resolve();
        await Promise.all(tasks);
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1', 'disconnect', 'B2', 'devices -l']);
    } finally { a.resolve(); b.resolve(); global.resolve(); await Promise.allSettled(tasks); }
});

for (const command of [['kill-server'], ['future-global-command'], ['shell', 'ambiguous-device']]) {
    test(`unknown or unbound command is an exclusive barrier: ${command.join(' ')}`, async () => {
        const { client, calls, hold } = fixture();
        const gate = hold('A1');
        const first = client.enqueue(['A1'], { serial: 'A' });
        const global = client.enqueue(command, { noSelector: command[0] !== 'shell' });
        const later = client.enqueue(['B1'], { serial: 'B' });
        try {
            await tick();
            assert.deepEqual(calls.map(call => call.name), ['A1']);
        } finally { gate.resolve(); await Promise.all([first, global, later]); }
        assert.deepEqual(calls.map(call => call.name), ['A1', command.join(' '), 'B1']);
    });
}

test('cancelling a queued global barrier releases unrelated work without draining A first', async () => {
    const { client, calls, hold } = fixture();
    const gate = hold('A1');
    const controller = new AbortController();
    const first = client.enqueue(['A1'], { serial: 'A' });
    const global = client.enqueue(['disconnect'], { noSelector: true, signal: controller.signal });
    const rejected = assert.rejects(global, { code: 'ADB_ABORTED' });
    const other = client.enqueue(['B1'], { serial: 'B' });
    try {
        await tick();
        controller.abort();
        await rejected;
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1']);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { gate.resolve(); await Promise.allSettled([first, global, other]); }
    assert.equal(client.queueStats().depth, 0);
});

test('capacity and peak depth are global, not multiplied by device count', async () => {
    const { client, hold } = fixture({ maxQueueSize: 2 });
    const a = hold('A1');
    const b = hold('B1');
    const tasks = [client.enqueue(['A1'], { serial: 'A' }), client.enqueue(['B1'], { serial: 'B' })];
    try {
        await tick();
        await assert.rejects(client.enqueue(['C1'], { serial: 'C' }), { code: 'ADB_QUEUE_FULL' });
        const stats = client.queueStats();
        assert.equal(stats.depth, 2);
        assert.equal(stats.pending, 0);
        assert.equal(stats.peakDepth, 2);
        assert.equal(stats.rejected.ADB_QUEUE_FULL, 1);
        assert.equal(stats.failed, 0);
    } finally { a.resolve(); b.resolve(); await Promise.all(tasks); }
});

test('in-flight abort does not release the device key until runRaw settles', async () => {
    const { client, calls, hold } = fixture();
    const gate = hold('A1');
    const controller = new AbortController();
    const first = client.enqueue(['A1'], { serial: 'A', signal: controller.signal });
    await tick();
    controller.abort();
    const next = client.enqueue(['A2'], { serial: 'A' });
    const other = client.enqueue(['B1'], { serial: 'B' });
    try {
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1']);
    } finally { gate.resolve(); await Promise.all([first, next, other]); }
    assert.equal(client.queueStats().depth, 0);
});

test('idle device keys do not accumulate across completed serials', async () => {
    const { client } = fixture();
    for (let i = 0; i < 100; i++) await client.enqueue(['read'], { serial: `device-${i}` });
    assert.equal(client.queueStats().depth, 0);
    assert.equal(client.queue.pending.length, 0);
    assert.equal(client.queue.activeKeys.size, 0);
    assert.equal(client.queueStats().completed, 100);
});

for (const failSync of [true, false]) {
    test(`a failed management barrier releases following work, sync=${failSync}`, async () => {
        const { client, hold, calls } = fixture();
        const gate = hold('A1');
        const first = client.enqueue(['A1'], { serial: 'A' });
        const failure = client.queue.push(() => { if (failSync) throw 0; return Promise.reject(0); });
        const observed = failure.then(() => ({ ok: true }), reason => ({ reason }));
        const next = client.enqueue(['B1'], { serial: 'B' });
        gate.resolve();
        await first;
        assert.deepEqual(await observed, { reason: 0 });
        assert.equal((await next).stdout, 'B1');
        await client.queue.tail;
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1']);
        assert.equal(client.queueStats().failedByCode.UNKNOWN, 1);
        assert.equal(client.queueStats().depth, 0);
    });
}

test('a timed-out pending barrier frees B while A remains in flight', async () => {
    const { client, calls, hold } = fixture();
    const gate = hold('A1');
    const first = client.enqueue(['A1'], { serial: 'A' });
    const expired = client.enqueue(['disconnect'], { noSelector: true, timeoutMs: 20 });
    const observed = assert.rejects(expired, { code: 'ADB_TIMEOUT' });
    const next = client.enqueue(['B1'], { serial: 'B' });
    try {
        await observed;
        assert.equal((await next).stdout, 'B1');
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1']);
        assert.equal(client.queueStats().depth, 1);
    } finally { gate.resolve(); await Promise.allSettled([first, expired, next]); }
});

test('normalizing the device key matches the selector passed to adb', async () => {
    const { client, calls, hold } = fixture();
    const gate = hold('A1');
    const first = client.enqueue(['A1'], { serial: ' A ' });
    const next = client.enqueue(['A2'], { serial: 'A' });
    try {
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1']);
        assert.equal(calls[0].serial, 'A');
    } finally { gate.resolve(); await Promise.all([first, next]); }
});

test('host-read classification is exact and cannot turn arbitrary noSelector commands into reads', async () => {
    const { client, calls, hold } = fixture({ serial: 'A' });
    const gate = hold('A1');
    const first = client.enqueue(['A1']);
    const version = client.version();
    const mdns = client.mdnsServices();
    const global = client.enqueue(['devices', '-l', 'unexpected'], { noSelector: true });
    const later = client.enqueue(['B1'], { serial: 'B' });
    try {
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1', 'version', 'mdns services']);
        assert.equal(calls[1].noSelector, true);
    } finally { gate.resolve(); await Promise.all([first, version, mdns, global, later]); }
    assert.deepEqual(calls.map(call => call.name).slice(-2), ['devices -l unexpected', 'B1']);
});

test('resetting counters does not release active keys or a queued management barrier', async () => {
    const { client, hold, calls } = fixture();
    const a = hold('A1');
    const b = hold('B1');
    const first = client.enqueue(['A1'], { serial: 'A' });
    const second = client.enqueue(['B1'], { serial: 'B' });
    const global = client.enqueue(['disconnect'], { noSelector: true });
    try {
        await tick();
        const before = client.queueStats();
        client.resetQueueStats();
        assert.equal(client.queueStats().depth, before.depth);
        assert.equal(client.queueStats().pending, before.pending);
        b.resolve();
        await second;
        assert.deepEqual(calls.map(call => call.name), ['A1', 'B1']);
    } finally { a.resolve(); b.resolve(); await Promise.all([first, second, global]); }
    assert.equal(client.queueStats().completed, 3);
});

test('Service Observe on B completes through real ADB scheduling while A sampling is blocked', async t => {
    const { harness, xml } = require('./helpers/android-service-harness.cjs');
    const client = new AdbClient({ serial: 'A', adbPath: 'never-execute-adb' });
    const entered = deferred();
    const gate = deferred();
    const calls = [];
    client.runRaw = async (args, request) => {
        calls.push({ args, serial: request.serial });
        if (args[0] === 'devices') return { stdout: 'A device\nB device\n' };
        if (args.includes('uiautomator')) {
            if (request.serial === 'A') { entered.resolve(); await gate.promise; }
            return { stdout: xml() };
        }
        if (args[0] === 'shell') return { stdout: 'mCurrentFocus=Window{a u0 com.example/.Main}\n@@VCP_SIZE@@\nPhysical size: 100x200\n@@VCP_POWER@@\nmWakefulness=Awake' };
        return { stdout: '' };
    };
    const methods = ['devices', 'probeScreen', 'screenSize', 'currentFocus', 'runText', 'enqueue', 'withContext'];
    const h = await harness({ config: { UI_SERVER: false }, client: Object.fromEntries(methods.map(key => [key, client[key].bind(client)])) });
    t.after(() => h.service.cleanup());
    const first = h.service.processToolCall({ command: 'Observe', serial: 'A', wake: 'never' });
    await entered.promise;
    let completed = false;
    const second = h.service.processToolCall({ command: 'Observe', serial: 'B', wake: 'never' }).then(result => { completed = true; return result; });
    let timer;
    try {
        // B must finish while A remains gated; asynchronous initialization need
        // not fit in one event-loop tick on a busy host.
        await Promise.race([second, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('B remained blocked by A')), 3000);
        })]);
        assert.equal(completed, true, 'device discovery and all B preparation must avoid the blocked A lane');
        assert.equal((await second).details.serial, 'B');
        assert.ok(calls.some(call => call.serial === 'B' && call.args.includes('uiautomator')));
    } finally { clearTimeout(timer); gate.resolve(); await Promise.allSettled([first, second]); }
    assert.equal(client.queueStats().depth, 0);
});


test('queued arguments are pinned so a host read cannot mutate into a management write', async () => {
    const { client, hold, calls } = fixture();
    const gate = hold('A1');
    const first = client.enqueue(['A1'], { serial: 'A' });
    const args = ['devices', '-l'];
    const read = client.enqueue(args, { noSelector: true });
    args.splice(0, args.length, 'kill-server');
    try {
        await tick();
        assert.deepEqual(calls.map(call => call.name), ['A1', 'devices -l']);
    } finally { gate.resolve(); await Promise.all([first, read]); }
});
