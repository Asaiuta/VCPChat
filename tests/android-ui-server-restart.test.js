'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { ownerWorld } = require('./helpers/android-owner-world.cjs');
const carrierHash = createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,
    '../VCPDistributedServer/Plugin/AndroidController/vendor/u2-server-0.5.0.apk'))).digest('hex');

const entry = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js');
const realRequire = createRequire(entry);

function fixture(t, options = {}) {
    const forwards = new Set();
    const owners = new Map();
    const calls = [];
    const processes = [];
    const owner = ownerWorld({
        onForward: port => { forwards.add(port); owners.set(port, 'offline-only'); },
        onRemove: port => { forwards.delete(port); owners.delete(port); },
    });
    // 替身必须同时供给 ui-server 与 ui-transport：传输层拆分后，child_process
    // 只在 ui-transport 里被引用。若这里对相对依赖直接走真实 require，
    // 拿到的就是真实 child_process，测试会去跑真 adb。
    const childProcess = {
        execFile(file, args, execOptions, callback) {
            const command = args.slice(2);
            calls.push(command);
            const ownerResponse = owner.exec(command, args[1]);
            if (ownerResponse) { queueMicrotask(() => callback(null, ownerResponse.stdout, ownerResponse.stderr)); return; }
            if (command[0] === 'forward') {
                const port = command.at(-1);
                if (command[1] === '--remove') {
                    forwards.delete(port);
                    owners.delete(port);
                } else {
                    if (command.includes('--no-rebind') && forwards.has(port)) {
                        queueMicrotask(() => callback(new Error('cannot rebind existing socket'), '', 'cannot rebind existing socket'));
                        return;
                    }
                    forwards.add(port);
                    owners.set(port, args[1]);
                }
            }
            const remoteFile = command[0] === 'shell' ? /'(\/data\/local\/tmp\/vcp-u2-[a-f0-9]{64}\.apk)'/.exec(command[1])?.[1] : null;
            queueMicrotask(() => callback(null, remoteFile ? `${carrierHash}  ${remoteFile}\n` : '', ''));
        },
        spawn(file, args) {
            const proc = new EventEmitter();
            proc.killed = false;
            proc.kill = () => { proc.killed = true; return true; };
            processes.push(proc);
            return owner.spawn(proc, args);
        },
    };
    // 函数包装的迷你 CommonJS 加载器：两个文件都有顶层 const（UiServerError /
    // rpcOptions / AdbTransport 等），脚本级词法声明在同一 context 里会互相撞名。
    const context = vm.createContext({ Buffer, setTimeout, clearTimeout });
    const cache = new Map();
    function loadModule(file) {
        const resolved = file.endsWith('.js') ? file : `${file}.js`;
        if (cache.has(resolved)) return cache.get(resolved).exports;
        const mod = { exports: {} };
        cache.set(resolved, mod);
        const req = (name) => {
            if (name === 'child_process') return childProcess;
            if (name === 'node:net') return owner.net;
            if (name.startsWith('.')) return loadModule(path.resolve(path.dirname(resolved), name));
            return realRequire(name);
        };
        const wrapped = `(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(resolved, 'utf8')}\n})`;
        vm.runInContext(wrapped, context, { filename: resolved })(mod.exports, req, mod, resolved, path.dirname(resolved));
        return mod.exports;
    }
    const api = loadModule(entry);
    const server = new api.UiServer({ serial: 'offline-only' });
    let port = 41000;
    server.transport._probePort = async () => {
        const selected = port++;
        if (options.claimOnProbe) {
            forwards.add(`tcp:${selected}`);
            owners.set(`tcp:${selected}`, 'other-owner');
        }
        return selected;
    };
    server.transport._waitReady = async () => true;
    t.after(() => server.stop());
    return { server, forwards, owners, calls, processes, owner };
}

for (const event of ['exit', 'error']) {
    test(`restart after unexpected ${event} removes the previous forward before replacing it`, async t => {
        const { server, forwards, calls, processes, owner } = fixture(t);
        assert.equal((await server.start()).ok, true);
        const previousPort = server.port;
        processes[0].emit(event, event === 'error' ? new Error('transport failed') : 1);
        assert.equal(server.isReady(), false);

        assert.equal((await server.start()).ok, true);
        assert.notEqual(server.port, previousPort);
        assert.deepEqual([...forwards].sort(), [`tcp:${server.port}`, `tcp:${owner.currentForward()}`].sort(),
            'only current generation RPC and independent owner forwards may remain');
        const removal = calls.findIndex(args => args[0] === 'forward' && args[1] === '--remove' && args[2] === `tcp:${previousPort}`);
        const replacement = calls.findIndex(args => args[0] === 'forward' && args[1] !== '--remove' && args.includes(`tcp:${server.port}`));
        assert.ok(removal >= 0 && removal < replacement, 'old forward cleanup must finish before replacement');
        assert.equal(processes[0].killed, true, 'a failed transport must be disposed before replacement');
        await server.stop();
        assert.equal(forwards.size, 0, 'final stop must leave no forward from any generation');
    });
}

test('stop during stale-forward cleanup prevents replacement startup and drains cleanup', async t => {
    const { server, forwards, processes } = fixture(t);
    assert.equal((await server.start()).ok, true);
    processes[0].emit('exit', 1);
    let entered;
    let release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const remove = server.transport._removeForward.bind(server.transport);
    server.transport._removeForward = async (...args) => {
        entered();
        await gate;
        return remove(...args);
    };
    const restarting = server.start();
    const phase = await Promise.race([ready.then(() => 'cleanup'), restarting.then(() => 'restarted')]);
    if (phase !== 'cleanup') {
        release();
        assert.fail('restart bypassed cleanup of the previous generation');
    }
    const stopping = server.stop();
    release();
    assert.equal((await restarting).ok, false, 'invalidated restart must not report success');
    await stopping;
    assert.equal(processes.length, 1, 'stop must prevent spawning a replacement');
    assert.equal(forwards.size, 0);
    assert.equal(server.port, null);
});


test('a forward claimed after probing cannot be rebound by startup', async t => {
    const { server, owners, calls, processes } = fixture(t, { claimOnProbe: true });
    const result = await server.start();
    assert.equal(result.ok, false, 'startup must reject a forward owned by another caller');
    assert.equal(owners.get('tcp:41000'), 'other-owner', 'startup must not route its RPC to another owner');
    assert.equal(processes.length, 0, 'a rejected forward must not spawn the UI service');
    assert.equal(calls.some(args => args[0] === 'forward' && args[1] === '--remove'), false,
        'failed acquisition must not remove another caller\'s forward');
    assert.equal(server.port, null);
});
