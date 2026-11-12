'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const filename = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub.js');
const source = fs.readFileSync(filename, 'utf8');
const productionRequire = createRequire(filename);
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(control) {
    const calls = [], sockets = [];
    const module = { exports: {} };
    const childProcess = {
        execFile(_adb, args, _opts, callback) {
            calls.push(['adb', ...args]);
            if (args.join(' ').includes('/proc/net/unix')) { queueMicrotask(() => callback(null, '1\n', '')); return; }
            queueMicrotask(() => callback(null, args[0] === 'devices' ? 'List of devices attached\nA device\n' : 'PRESENT', ''));
        },
        spawn(_adb, args) {
            calls.push(['spawn', ...args]);
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
            return proc;
        },
    };
    const net = {
        createConnection() {
            const socket = new EventEmitter();
            socket.written = [];
            socket.setNoDelay = () => {};
            socket.write = buffer => { socket.written.push(Buffer.from(buffer)); return true; };
            socket.destroy = () => { if (socket.destroyed) return; socket.destroyed = true; socket.emit('close'); };
            sockets.push(socket);
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        },
    };
    vm.runInNewContext(source, {
        require(name) { return name === 'child_process' ? childProcess : name === 'net' ? net : productionRequire(name); },
        module, exports: module.exports, __dirname: path.dirname(filename), Buffer, console, setTimeout, clearTimeout,
    }, { filename });
    const { ScrcpyHub } = module.exports;
    ScrcpyHub.findFreePort = async () => 12345;
    const hub = new ScrcpyHub({ adbPath: 'stub-adb', serial: 'A', logger: {}, control });
    return { hub, calls, sockets };
}

function handshake(width = 540, height = 1200) {
    const name = Buffer.alloc(64); name.write('Phone');
    const codec = Buffer.from([0x68, 0x32, 0x36, 0x34]);
    const session = Buffer.alloc(12); session[0] = 0x80; session.writeUInt32BE(width, 4); session.writeUInt32BE(height, 8);
    return Buffer.concat([name, codec, session]);
}

test('control=false keeps the single video socket and command line unchanged', async () => {
    const { hub, calls, sockets } = setup(false);
    await hub.start();
    sockets[0].emit('data', Buffer.from([0]));
    await tick();
    assert.equal(sockets.length, 1);
    assert.match(calls.find(c => c[0] === 'spawn').join(' '), /control=false cleanup=false video_codec/);
    assert.equal(hub.controlReady(), false);
    assert.throws(() => hub.injectKeycode(0, 4), { code: 'SCRCPY_CONTROL_UNAVAILABLE' });
    await hub.stop();
});

test('control socket connects only after the video dummy byte, then device meta parses normally', async () => {
    const { hub, calls, sockets } = setup(true);
    await hub.start();
    assert.match(calls.find(c => c[0] === 'spawn').join(' '), /control=true cleanup=false clipboard_autosync=false /);
    assert.equal(sockets.length, 1, 'control waits for the dummy byte');
    sockets[0].emit('data', Buffer.from([0]));
    await tick();
    assert.equal(sockets.length, 2);
    sockets[0].emit('data', handshake());
    assert.deepEqual([hub.width, hub.height], [540, 1200]);
    assert.equal(hub.controlReady(), true);
    assert.equal(hub.status().control, true);
    await hub.stop();
    assert.equal(sockets[1].destroyed, true);
});

test('touch and key messages use the scrcpy v3+ wire layout', async () => {
    const { hub, sockets } = setup(true);
    await hub.start();
    sockets[0].emit('data', Buffer.concat([Buffer.from([0]), handshake()]));
    await tick();
    hub.injectTouch({ action: 0, x: 10, y: 20, width: 540, height: 1200 });
    hub.injectTouch({ action: 1, x: 11, y: 21, width: 540, height: 1200 });
    hub.injectKeycode(0, 187);
    const [down, up, key] = sockets[1].written;
    assert.equal(down.length, 32);
    assert.deepEqual([down[0], down[1]], [2, 0]);
    assert.equal(down.readBigInt64BE(2), -2n);
    assert.deepEqual([down.readInt32BE(10), down.readInt32BE(14), down.readUInt16BE(18), down.readUInt16BE(20)], [10, 20, 540, 1200]);
    assert.equal(down.readUInt16BE(22), 0xffff);
    assert.equal(up[1], 1); assert.equal(up.readUInt16BE(22), 0);
    assert.equal(key.length, 14);
    assert.deepEqual([key[0], key[1], key.readInt32BE(2), key.readInt32BE(6), key.readInt32BE(10)], [0, 0, 187, 0, 0]);
    await hub.stop();
});

test('losing the control socket tears down the video socket so normal stream recovery restarts both', async () => {
    const { hub, sockets } = setup(true);
    await hub.start();
    const closed = [];
    hub.subscribe(packet => closed.push(packet.type));
    sockets[0].emit('data', Buffer.concat([Buffer.from([0]), handshake()]));
    await tick();
    sockets[1].destroy();
    assert.equal(sockets[0].destroyed, true);
    assert.equal(hub.controlReady(), false);
    assert.ok(closed.includes('closed'));
    await hub.stop();
});
