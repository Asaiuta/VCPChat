'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const entry = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js');
const realRequire = createRequire(entry);

function fixture(t, options = {}) {
    const forwards = new Set();
    const owners = new Map();
    const calls = [];
    const processes = [];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(entry),
        Buffer, setTimeout, clearTimeout,
        require(name) {
            if (name !== 'child_process') return realRequire(name);
            return {
                execFile(file, args, execOptions, callback) {
                    const command = args.slice(2);
                    calls.push(command);
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
                    queueMicrotask(() => callback(null, command[0] === 'shell' ? 'PRESENT' : '', ''));
                },
                spawn() {
                    const proc = new EventEmitter();
                    proc.killed = false;
                    proc.kill = () => { proc.killed = true; return true; };
                    processes.push(proc);
                    return proc;
                },
            };
        },
    }, { filename: entry });
    const server = new module.exports.UiServer({ serial: 'offline-only' });
    let port = 41000;
    server._probePort = async () => {
        const selected = port++;
        if (options.claimOnProbe) {
            forwards.add(`tcp:${selected}`);
            owners.set(`tcp:${selected}`, 'other-owner');
        }
        return selected;
    };
    server._waitReady = async () => true;
    t.after(() => server.stop());
    return { server, forwards, owners, calls, processes };
}

for (const event of ['exit', 'error']) {
    test(`restart after unexpected ${event} removes the previous forward before replacing it`, async t => {
        const { server, forwards, calls, processes } = fixture(t);
        assert.equal((await server.start()).ok, true);
        const previousPort = server.port;
        processes[0].emit(event, event === 'error' ? new Error('transport failed') : 1);
        assert.equal(server.isReady(), false);

        assert.equal((await server.start()).ok, true);
        assert.notEqual(server.port, previousPort);
        assert.deepEqual([...forwards], [`tcp:${server.port}`], 'only the current generation may own a forward');
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
    const remove = server._removeForward.bind(server);
    server._removeForward = async port => {
        entered();
        await gate;
        return remove(port);
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
