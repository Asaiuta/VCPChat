'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const { RemoteOwner } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-owner');
const root = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController');
const entry = path.join(root, 'lib/ui-transport.js');
let serialSeq = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
    const state = { serial: `owner-offline-${++serialSeq}`, calls: [], spawned: [], commands: [], forwards: new Set(),
        alive: true, ownerOpen: true, rpcOpen: true, rpcOwned: true, stopWorks: true, readable: true,
        startTime: '77123', announcement: true, pid: 13742, uid: 2000, rpcCalls: 0, infoCalls: 0, ...options };
    const sockets = new Set();
    const forwardTargets = new Map();
    const proxies = new Map();
    const listen = server => new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
    const rpc = http.createServer((req, res) => {
        state.rpcCalls++;
        assert.ok(state.infoCalls > 0, 'never ping an endpoint before authenticated owner evidence');
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const request = JSON.parse(body);
            if (request.method !== 'ping' && state.hangRpc) { state.onRpc?.(); return; }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'ping' ? 'pong' : true }));
        });
    });
    rpc.on('connection', track);
    state.rpcPort = await listen(rpc);
    const control = net.createServer(socket => {
        track(socket);
        let data = '';
        socket.on('data', chunk => {
            data += chunk;
            if (!data.includes('\n')) return;
            const [command, nonce] = data.trim().split(' ');
            state.commands.push(command);
            if (nonce !== state.nonce || !state.alive) return socket.end('DENIED\n');
            if (command === 'INFO') {
                state.infoCalls++;
                const info = { ...state.identity, nonce, rpcPort: state.rpcPort, rpcOwned: state.rpcOwned,
                    rpcInode: state.rpcOwned ? '887711' : null, ...state.infoOverride };
                socket.end(JSON.stringify(info) + '\n');
            } else if (command === 'STOP') {
                if (state.stopWorks) { state.alive = false; state.ownerOpen = false; if (state.rpcOwned) state.rpcOpen = false; }
                socket.end('STOPPING\n');
            } else socket.end('DENIED\n');
        });
    });
    state.ownerPort = await listen(control);
    state.loseOwnerForwards = async ({ keepMapping = false } = {}) => {
        for (const [port, proxy] of proxies) {
            for (const socket of proxy.sockets) socket.destroy();
            await new Promise(resolve => proxy.server.close(resolve));
            proxies.delete(port);
            if (!keepMapping) { state.forwards.delete(`tcp:${port}`); forwardTargets.delete(`tcp:${port}`); }
        }
    };
    state.forwardTargets = forwardTargets;
    const child = {
        execFile() { throw Error('Real adb execution is forbidden in this test'); },
        spawn(file, args, opts) {
            const proc = new EventEmitter();
            proc.stdout = new PassThrough();
            proc.killed = false;
            proc.kill = () => { proc.killed = true; return true; };
            state.spawned.push({ file, args, opts, proc });
            state.nonce = /VCP_OWNER_NONCE='([a-f0-9]{64})'/.exec(args.at(-1))?.[1];
            state.identity = { nonce: state.nonce, port: state.ownerPort, pid: state.pid, uid: state.uid,
                startTime: state.startTime, cmdline: ['app_process', '/', 'com.vcpchat.uiautomator.Owner', String(state.rpcPort)] };
            state.announce = (override = {}) => proc.stdout.write('VCP_OWNER_V1 ' + JSON.stringify({ ...state.identity, ...override }) + '\n');
            if (state.announcement) queueMicrotask(() => state.announce(state.announcementOverride));
            state.onSpawn?.(proc);
            return proc;
        },
    };
    const realRequire = createRequire(entry);
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(entry, 'utf8'))(
        name => name === 'child_process' ? child : realRequire(name), mod, mod.exports, path.dirname(entry));
    const { AdbTransport } = mod.exports;
    const makeTransport = () => {
        const transport = new AdbTransport({ serial: state.serial, readyTimeoutMs: state.readyTimeoutMs || 15000,
            ownerCleanupTimeoutMs: 1, rpcTimeoutMs: 4000 });
        transport._pickPort = async () => state.rpcPort;
        transport._exec = async args => {
            state.calls.push(args);
            await state.onExec?.(args);
            if (args[0] === 'forward') {
                if (args[1] === '--list') return { stdout: [...forwardTargets].map(([local, remote]) => `${state.serial} ${local} ${remote}`).join('\n'), stderr: '' };
                if (args[1] === '--remove') {
                    state.forwards.delete(args[2]);
                    forwardTargets.delete(args[2]);
                    const port = Number(args[2].slice(4));
                    const proxy = proxies.get(port);
                    if (proxy) {
                        for (const socket of proxy.sockets) socket.destroy();
                        await new Promise(resolve => proxy.server.close(resolve));
                        proxies.delete(port);
                    }
                }
                else {
                    if (state.forwardConflict && args[2] !== 'tcp:0') throw Error('another forward owns this port');
                    let selected = Number(args[2].slice(4));
                    if (args[2] === 'tcp:0') {
                        const localSockets = new Set();
                        const server = net.createServer(socket => {
                            const upstream = net.connect(state.ownerPort, '127.0.0.1');
                            for (const peer of [socket, upstream]) {
                                localSockets.add(peer);
                                peer.on('error', () => { socket.destroy(); upstream.destroy(); });
                                peer.on('close', () => { localSockets.delete(peer); });
                            }
                            socket.pipe(upstream).pipe(socket);
                        });
                        selected = await listen(server);
                        proxies.set(selected, { server, sockets: localSockets });
                    }
                    state.forwards.add(`tcp:${selected}`);
                    forwardTargets.set(`tcp:${selected}`, args[3]);
                    return { stdout: args[2] === 'tcp:0' ? String(selected) + '\n' : '', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            }
            if (args[0] === 'shell' && args[1].includes('VCP_PROC_')) {
                if (!state.readable) return { stdout: 'VCP_PROC_UNKNOWN\nVCP_NET_UNKNOWN\n', stderr: '' };
                const fields = ['S', ...Array(18).fill('0'), state.startTime, '0'];
                const proc = state.alive ? `VCP_PROC_STAT ${state.pid} (app process (worker)) ${fields.join(' ')}` : 'VCP_PROC_ABSENT';
                const header = '  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
                const row = (port, inode) => `0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 2000 0 ${inode}`;
                const rows = [state.ownerOpen ? row(state.ownerPort, '123') : null,
                    state.rpcOpen ? row(state.rpcPort, '887711') : null].filter(Boolean);
                return { stdout: [proc, 'VCP_TCP4', header, ...rows, 'VCP_TCP6', header, state.truncated ? '' : 'VCP_END', ''].join('\n'), stderr: '' };
            }
            if (args[0] === 'shell') {
                const artifact = /'(\/data\/local\/tmp\/vcp-(?:owner|u2)-([a-f0-9]{64})\.(?:jar|apk))'/.exec(args[1]);
                if (artifact) return { stdout: `${artifact[2]}  ${artifact[1]}\n`, stderr: '' };
            }
            return { stdout: '', stderr: '' };
        };
        return transport;
    };
    const transport = makeTransport();
    t.after(async () => {
        state.onExec = null;
        state.alive = false; state.ownerOpen = false; state.rpcOpen = false; state.readable = true; state.truncated = false;
        await transport.stop();
        await RemoteOwner.recover(state.serial);
        await state.loseOwnerForwards();
        for (const socket of sockets) socket.destroy();
        await Promise.all([new Promise(resolve => control.close(resolve)), new Promise(resolve => rpc.close(resolve))]);
    });
    return { state, transport, makeTransport };
}

test('default transport launches same-JVM owner bootstrap, authenticates inode then admits real HTTP RPC', async t => {
    const { state, transport } = await fixture(t);
    const result = await transport.start();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.owner.status, 'bound');
    assert.equal(result.owner.binding.endpointProof, 'socket_inode');
    assert.equal(result.owner.binding.pid, state.pid);
    assert.ok(state.infoCalls >= 2, 'reattest after ping and immediately before admission');
    assert.equal(state.rpcCalls, 1);
    assert.equal(transport.isReady(), true);
    const command = state.spawned[0].args.at(-1);
    assert.match(command, /CLASSPATH='\/data\/local\/tmp\/vcp-owner-[a-f0-9]{64}\.jar:\/data\/local\/tmp\/vcp-u2-[a-f0-9]{64}\.apk'/);
    assert.match(command, /app_process \/ com\.vcpchat\.uiautomator\.Owner \d+$/);
    assert.deepEqual(state.spawned[0].opts.stdio, ['ignore', 'pipe', 'ignore']);
    assert.ok(state.calls.some(args => args[0] === 'forward' && args[2] === 'tcp:0'), 'owner has an independent dynamically allocated forward');
    assert.equal(JSON.stringify(result).includes(state.nonce), false);
    assert.equal(JSON.stringify(transport.ownerIdentity).includes(state.nonce), false);
    const released = await transport.stop();
    assert.equal(released.status, 'released');
    assert.equal(state.commands.at(-1), 'STOP');
    assert.ok(state.calls.some(args => args[0] === 'shell' && args[1].includes(`/proc/${state.pid}/stat`)));
    assert.equal(state.spawned[0].proc.killed, true, 'only local adb client is disposed after independent proof');
    assert.equal(state.forwards.size, 0);
    assert.equal(state.calls.some(args => /killall|pkill|\bkill\s+\d+/.test(args.join(' '))), false);
    assert.equal(transport.port, null);
});

test('foreign RPC socket never gets pinged and its remaining endpoint quarantines the owner', async t => {
    const { state, transport, makeTransport } = await fixture(t, { rpcOwned: false, readyTimeoutMs: 60 });
    const result = await transport.start();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UI_SERVER_OWNER_QUARANTINED');
    assert.equal(state.rpcCalls, 0);
    assert.equal(state.alive, false, 'authenticated owner self-exits even when RPC inode is foreign');
    assert.equal(state.rpcOpen, true, 'foreign endpoint is never killed');
    assert.equal(state.spawned[0].proc.killed, false, 'quarantine retains late evidence/control resources');
    const replacement = makeTransport();
    assert.equal((await replacement.start()).code, 'UI_SERVER_OWNER_QUARANTINED');
    assert.equal(state.spawned.length, 1, 'cross-instance tombstone blocks replacement launch');

    state.rpcOpen = false;
    assert.equal((await replacement.recoverOwner()).status, 'released');
    assert.equal(state.forwards.size, 0);
});

test('STOP acknowledgement alone cannot release a live original PID even when both endpoints close', async t => {
    const { state, transport } = await fixture(t);
    assert.equal((await transport.start()).ok, true);
    state.stopWorks = false;
    state.ownerOpen = false; state.rpcOpen = false;
    const owner = await transport.stop();
    assert.equal(owner.status, 'quarantined');
    assert.equal(state.alive, true);
    assert.equal(state.spawned[0].proc.killed, false);
    state.startTime = '99999';
    assert.equal((await transport.recoverOwner()).status, 'released', 'PID reuse permits release only after independent starttime change and closed endpoints');
});

for (const bad of ['readable', 'truncated']) {
    test(`missing independent ${bad} evidence cannot release despite STOP`, async t => {
        const { state, transport } = await fixture(t);
        assert.equal((await transport.start()).ok, true);
        state[bad] = bad === 'truncated';
        assert.equal((await transport.stop()).status, 'quarantined');
        state[bad] = bad !== 'truncated';
        assert.equal((await transport.recoverOwner()).status, 'released');
    });
}

test('a healthy active owner cannot be terminated by contender start or stop', async t => {
    const { state, transport, makeTransport } = await fixture(t);
    assert.equal((await transport.start()).ok, true);
    const contender = makeTransport();
    assert.equal((await contender.start()).code, 'UI_SERVER_OWNER_QUARANTINED');
    assert.equal((await contender.stop()).status, 'quarantined');
    assert.equal(state.commands.includes('STOP'), false);
    assert.equal(state.alive, true);
    assert.equal(state.spawned.length, 1);
    assert.equal(transport.isReady(), true);
});

test('an old released receipt cannot recover or report release of a newer active cross-instance owner', async t => {
    const { state, transport, makeTransport } = await fixture(t);
    assert.equal((await transport.start()).ok, true);
    assert.equal((await transport.stop()).status, 'released');
    state.alive = true; state.ownerOpen = true; state.rpcOpen = true;
    const replacement = makeTransport();
    assert.equal((await replacement.start()).ok, true);
    assert.equal(transport.ownerIdentity.status, 'bound');
    const stops = state.commands.filter(command => command === 'STOP').length;
    assert.equal((await transport.recoverOwner()).status, 'quarantined');
    assert.equal(state.commands.filter(command => command === 'STOP').length, stops, 'historical holder cannot terminate a healthy successor');
    replacement.quarantineOwner('OUTCOME_UNKNOWN');
    assert.equal((await transport.recoverOwner()).status, 'released', 'explicit recovery may resolve the current quarantined tombstone');
    assert.equal(state.alive, false);
    assert.equal(replacement.port, null);
    assert.equal(replacement.isReady(), false);
    assert.equal(state.forwards.size, 0);
});

test('foreign adb forward conflict is not removed and no owner is launched', async t => {
    const { state, transport } = await fixture(t, { forwardConflict: true });
    const result = await transport.start();
    assert.equal(result.ok, false);
    assert.equal(result.owner.status, 'released');
    assert.equal(state.spawned.length, 0);
    assert.equal(state.calls.some(args => args[0] === 'forward' && args[1] === '--remove'), false);
});

test('stop during late RPC-forward acquisition drains it without spawning and a waiting start uses a fresh owner', async t => {
    const { state, transport } = await fixture(t);
    const entered = deferred(), gate = deferred();
    let block = true;
    state.onExec = async args => {
        if (block && args[0] === 'forward' && args[1] !== '--remove') { entered.resolve(); await gate.promise; }
    };
    const starting = transport.start();
    await entered.promise;
    const stopping = transport.stop();
    const next = transport.start();
    block = false;
    gate.resolve();
    assert.equal((await starting).ok, false);
    assert.equal((await stopping).status, 'released');
    const replacement = await next;
    assert.equal(replacement.ok, true, JSON.stringify(replacement));
    assert.equal(state.spawned.length, 1);
    assert.equal(state.forwards.size, 2);
});

test('stop while wrapper stdout is late authenticates then self-stops without ever publishing ready', async t => {
    const spawned = deferred();
    const { state, transport } = await fixture(t, { announcement: false, onSpawn: () => spawned.resolve() });
    const starting = transport.start();
    await spawned.promise;
    const stopping = transport.stop();
    state.announce();
    const result = await starting;
    assert.equal(result.ok, false);
    assert.equal((await stopping).status, 'released');
    assert.equal(state.rpcCalls, 0);
    assert.equal(transport.isReady(), false);
    assert.equal(state.alive, false);
    assert.equal(state.forwards.size, 0);
});

test('missing announcement quarantines across instances; late original evidence enables explicit recovery', async t => {
    const { state, transport, makeTransport } = await fixture(t, { announcement: false, readyTimeoutMs: 60 });
    assert.equal((await transport.start()).owner.status, 'quarantined');
    assert.equal(state.commands.length, 0);
    const replacement = makeTransport();
    assert.equal((await replacement.start()).code, 'UI_SERVER_OWNER_QUARANTINED');
    state.announce();
    await tick();
    assert.equal((await replacement.recoverOwner()).status, 'released');
    assert.equal(state.alive, false);
    assert.equal(state.spawned.length, 1);
});

test('spoofed INFO nonce or process identity never admits RPC', async t => {
    const { state, transport } = await fixture(t, { infoOverride: { pid: 13743 } });
    const result = await transport.start();
    assert.equal(result.ok, false);
    assert.equal(result.owner.status, 'quarantined');
    assert.equal(state.rpcCalls, 0);
    assert.equal(state.commands.includes('STOP'), false, 'cannot STOP when authenticated INFO identity mismatches');
    state.infoOverride = null;
    assert.equal((await transport.recoverOwner()).status, 'released');
});

for (const event of ['exit', 'error']) {
    test(`unexpected adb ${event} must release original owner before restarting`, async t => {
        const { state, transport } = await fixture(t);
        assert.equal((await transport.start()).ok, true);
        const previous = state.spawned[0].proc;
        previous.emit(event, event === 'error' ? new Error('carrier broke') : 1);
        assert.equal(transport.isReady(), false);
        state.onSpawn = () => { state.alive = true; state.ownerOpen = true; state.rpcOpen = true; };
        assert.equal((await transport.start()).ok, true);
        assert.equal(previous.killed, true);
        assert.equal(state.spawned.length, 2);
        assert.ok(state.commands.includes('STOP'));
        assert.equal(state.forwards.size, 2);
    });
}

for (const keepMapping of [false, true]) {
    test(`wireless forward loss (mapping retained=${keepMapping}) rebuilds authenticated control before rebind`, async t => {
        const { state, transport } = await fixture(t);
        assert.equal((await transport.start()).ok, true);
        const previous = state.spawned[0].proc;
        await state.loseOwnerForwards({ keepMapping });
        previous.emit('exit', 1);
        state.onSpawn = () => { state.alive = true; state.ownerOpen = true; state.rpcOpen = true; };
        assert.equal((await transport.start()).ok, true);
        assert.ok(state.commands.includes('STOP'));
        assert.equal(previous.killed, true);
        assert.equal(state.forwards.size, 2);
        assert.equal(state.spawned.length, 2);
    });
}

test('reassigned local owner and RPC ports are not removed during recovery', async t => {
    const { state, transport } = await fixture(t);
    assert.equal((await transport.start()).ok, true);
    const previousPort = transport._owner.backend.ownerForward;
    await state.loseOwnerForwards({ keepMapping: true });
    state.forwardTargets.set(`tcp:${previousPort}`, 'tcp:1');
    state.forwardTargets.set(`tcp:${state.rpcPort}`, 'tcp:2');
    state.spawned[0].proc.emit('exit', 1);
    assert.equal((await transport.recoverOwner()).status, 'released');
    assert.equal(state.forwardTargets.get(`tcp:${previousPort}`), 'tcp:1');
    assert.equal(state.calls.some(args => args[1] === '--remove' && args[2] === `tcp:${previousPort}`), false);
    assert.equal(state.forwardTargets.get(`tcp:${state.rpcPort}`), 'tcp:2');
    assert.equal(state.calls.some(args => args[1] === '--remove' && args[2] === `tcp:${state.rpcPort}`), false);
});

test('heartbeat loss quarantines without replay and recovery waits for the renewal to drain', async t => {
    const { state, transport } = await fixture(t);
    assert.equal((await transport.start()).ok, true);
    const entered = deferred(), gate = deferred();
    let blocked = true;
    state.onExec = async args => {
        if (blocked && args[1] === '--list') { entered.resolve(); await gate.promise; throw Error('wireless offline'); }
    };
    transport._owner.backend.stopHeartbeat();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    transport._owner.backend.keepAlive(transport._owner._context());
    t.mock.timers.tick(5000);
    await entered.promise;
    t.mock.timers.reset();
    gate.resolve();
    await transport._owner.backend._heartbeat;
    assert.equal(transport.isReady(), false);
    assert.equal(transport.ownerIdentity.reason, 'OWNER_HEARTBEAT_LOST');
    assert.equal(transport._owner.backend._heartbeatTimer, null);
    assert.equal(state.rpcCalls, 1, 'only startup ping; no action replay');
    blocked = false;
    assert.equal((await transport.recoverOwner()).status, 'released');
});

test('stop drains an in-flight heartbeat and cannot resurrect its timer or ready state', async t => {
    const { state, transport } = await fixture(t);
    assert.equal((await transport.start()).ok, true);
    const backend = transport._owner.backend;
    const entered = deferred(), gate = deferred();
    let blocked = true;
    state.onExec = async args => {
        if (blocked && args[1] === '--list') { entered.resolve(); await gate.promise; }
    };
    backend.stopHeartbeat();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    backend.keepAlive(transport._owner._context());
    t.mock.timers.tick(5000);
    await entered.promise;
    t.mock.timers.reset();
    let stopped = false;
    const stopping = transport.stop().then(value => { stopped = true; return value; });
    await tick();
    assert.equal(stopped, false);
    assert.equal(state.commands.includes('STOP'), false);
    blocked = false;
    gate.resolve();
    assert.equal((await stopping).status, 'released');
    assert.equal(backend._heartbeatTimer, null);
    assert.equal(transport.isReady(), false);
    assert.equal(state.forwards.size, 0);
});

test('admitted undrained HTTP timeout quarantines owner and explicit recovery releases it', async t => {
    const { state, transport } = await fixture(t);
    assert.equal((await transport.start()).ok, true);
    state.hangRpc = true;
    await assert.rejects(transport.call('click', [1, 2], 20), cause => cause.dispatched === true && cause.drained === false);
    assert.equal(transport.isReady(), false);
    assert.equal(transport.ownerIdentity.status, 'quarantined');
    assert.equal(transport.ownerIdentity.reason, 'UI_SERVER_TIMEOUT');
    assert.equal(state.alive, true, 'quarantine is not a blind PID termination');
    assert.equal((await transport.recoverOwner()).status, 'released');
});

test('late unknown RPC from a stopped generation cannot quarantine the replacement', async t => {
    const { state, transport } = await fixture(t);
    assert.equal((await transport.start()).ok, true);
    state.hangRpc = true;
    const entered = deferred();
    state.onRpc = () => entered.resolve();
    const controller = new AbortController();
    const old = transport.call('click', [1, 2], 5000, controller.signal).catch(cause => cause);
    await entered.promise;
    await transport.stop();
    state.alive = true; state.ownerOpen = true; state.rpcOpen = true; state.hangRpc = false;
    assert.equal((await transport.start()).ok, true);
    controller.abort();
    assert.equal((await old).dispatched, true);
    assert.equal(transport.isReady(), true);
    assert.equal(transport.ownerIdentity.status, 'bound');
});

test('owner Java source and bundled DEX preserve self-exit/authentication contract', () => {
    const java = fs.readFileSync(path.resolve(__dirname, '../scripts/android-owner/src/com/vcpchat/uiautomator/Owner.java'), 'utf8');
    assert.match(java, /new ServerSocket\(0, 8, InetAddress.getByName\("127\.0\.0\.1"\)\)/);
    assert.match(java, /Os\.readlink\(fd\.getPath\(\)\)/);
    assert.match(java, /sockets\.contains\(f\[9\]\)/);
    assert.match(java, /MessageDigest\.isEqual/);
    assert.match(java, /Class\.forName\("com\.github\.uiautomator2\.Console"\)/);
    assert.match(java, /if \("STOP"\.equals\(command\[0\]\)\) \{\s*out\.println\("STOPPING"\);\s*System\.exit\(0\);/);
    const jar = fs.readFileSync(path.join(root, 'vendor/vcp-ui-owner.jar'));
    assert.equal(jar.readUInt32LE(0), 0x04034b50);
    assert.ok(jar.includes(Buffer.from('classes.dex')));
});
