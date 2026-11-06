'use strict';

// Production RemoteOwner + AdbOwnerBackend are never stubbed. Only adb and the TCP
// wire are modeled; the real bootstrap tests separately exercise real loopback TCP.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const ownerFile = path.resolve(__dirname, '../../VCPDistributedServer/Plugin/AndroidController/lib/ui-owner.js');
const jarFile = path.resolve(path.dirname(ownerFile), '../vendor/vcp-ui-owner.jar');
const jarHash = createHash('sha256').update(fs.readFileSync(jarFile)).digest('hex');

function ownerWorld(options = {}) {
    const generations = new Map();
    const forwards = new Map();
    const rpcForwards = new Map();
    let sequence = 0;
    let serial;
    const net = {
        createConnection({ port }) {
            const socket = new EventEmitter();
            socket.destroy = () => { socket.destroyed = true; };
            socket.write = text => {
                const record = generations.get(forwards.get(port));
                const [command, nonce] = text.trim().split(' ');
                let output = 'DENIED';
                if (record?.alive && nonce === record.identity.nonce) {
                    if (command === 'INFO') output = JSON.stringify({ ...record.identity, rpcPort: record.rpcPort,
                        rpcOwned: true, rpcInode: String(record.identity.pid * 10) });
                    if (command === 'STOP') {
                        record.alive = false;
                        output = 'STOPPING';
                        options.onStop?.(record);
                    }
                }
                queueMicrotask(() => { if (!socket.destroyed) socket.emit('data', Buffer.from(output + '\n')); });
            };
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        },
    };
    function launch(proc, rpcPort, nonce) {
        proc.stdout ||= new EventEmitter();
        const identity = { nonce, port: 51000 + (++sequence), pid: 22000 + sequence,
            uid: 2000, startTime: String(70000 + sequence), cmdline: ['app_process', '/', 'com.vcpchat.uiautomator.Owner', String(rpcPort)] };
        const record = { identity, rpcPort, alive: true };
        generations.set(identity.port, record);
        queueMicrotask(() => proc.stdout.emit('data', Buffer.from('VCP_OWNER_V1 ' + JSON.stringify(identity) + '\n')));
        return proc;
    }
    function spawn(proc, args) {
        serial = args[1];
        const command = args.at(-1);
        const nonce = /VCP_OWNER_NONCE='([a-f0-9]{64})'/.exec(command)?.[1];
        const port = Number(command.match(/ (\d+)$/)?.[1]);
        return launch(proc, port, nonce);
    }
    function exec(args, transportSerial) {
        if (transportSerial) serial = transportSerial;
        if (args[0] === 'forward' && args[1] === '--list') {
            return { stdout: [...forwards, ...rpcForwards].map(([local, remote]) => `${serial} tcp:${local} tcp:${remote}`).join('\n'), stderr: '' };
        }
        if (args[0] === 'shell' && args[1].includes('vcp-owner-')) {
            const file = /'(\/data\/local\/tmp\/vcp-owner-[a-f0-9]{64}\.jar)'/.exec(args[1])?.[1];
            return { stdout: `${jarHash}  ${file}\n`, stderr: '' };
        }
        if (args[0] === 'forward' && args[2] === 'tcp:0') {
            const remote = Number(args[3].slice(4));
            const local = 53000 + sequence;
            forwards.set(local, remote);
            options.onForward?.(`tcp:${local}`);
            return { stdout: String(local) + '\n', stderr: '' };
        }
        if (args[0] === 'forward' && args[1] === '--remove' && forwards.has(Number(args[2].slice(4)))) {
            forwards.delete(Number(args[2].slice(4)));
            options.onRemove?.(args[2]);
            return { stdout: '', stderr: '' };
        }
        if (args[0] === 'forward' && args[1] === '--no-rebind') rpcForwards.set(Number(args[2].slice(4)), Number(args[3].slice(4)));
        if (args[0] === 'forward' && args[1] === '--remove') rpcForwards.delete(Number(args[2].slice(4)));
        if (args[0] === 'shell' && args[1].includes('VCP_PROC_')) {
            const pid = Number(/\/proc\/(\d+)/.exec(args[1])?.[1]);
            const record = [...generations.values()].find(g => g.identity.pid === pid);
            const header = '  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
            const fields = ['S', ...Array(18).fill('0'), record?.identity.startTime, '0'];
            const stat = record?.alive ? `VCP_PROC_STAT ${pid} (app_process) ${fields.join(' ')}` : 'VCP_PROC_ABSENT';
            const row = (port, inode) => `0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 2000 0 ${inode}`;
            const rows = record?.alive ? [row(record.identity.port, '11'), row(record.rpcPort, String(pid * 10))] : [];
            return { stdout: [stat, 'VCP_TCP4', header, ...rows, 'VCP_TCP6', header, 'VCP_END', ''].join('\n'), stderr: '' };
        }
        return null;
    }
    const mod = { exports: {} };
    const req = createRequire(ownerFile);
    new Function('require', 'module', 'exports', fs.readFileSync(ownerFile, 'utf8'))(
        name => name === 'node:net' ? net : req(name), mod, mod.exports);
    return { net, launch, spawn, exec,
        backendFactory: transport => { serial = transport.serial; return new mod.exports.AdbOwnerBackend(transport); },
        currentForward: () => [...forwards.keys()].at(-1),
    };
}
module.exports = { ownerWorld };
