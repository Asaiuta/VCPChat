'use strict';
const http = require('node:http');
const assert = require('node:assert/strict');

// Loopback only. Forward the original bytes once; never retry an upstream request.
async function createFaultProxy({ upstreamPort, mode, delayMs = 7000, emit = () => {} }) {
    assert.ok(Number.isInteger(upstreamPort) && upstreamPort > 0 && upstreamPort < 65536);
    assert.ok(['pass', 'delay', 'drop'].includes(mode));
    const sockets = new Set(), upstream = new Set(), timers = new Set();
    let writes = 0, delayed = 0, dropped = 0;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('error', () => res.destroy());
        req.on('data', b => chunks.push(b));
        req.on('end', () => {
            const body = Buffer.concat(chunks); let rpc;
            try { rpc = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
            const write = rpc.method === 'click';
            if (write) writes++;
            emit('wire-request', { method: rpc.method, id: rpc.id, write, writes });
            const out = http.request({ hostname: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url,
                headers: req.headers, agent: false }, remote => {
                const bytes = [];
                remote.on('error', () => res.destroy());
                remote.on('data', b => bytes.push(b));
                remote.on('end', () => {
                    upstream.delete(out);
                    const payload = Buffer.concat(bytes);
                    emit('wire-response', { method: rpc.method, id: rpc.id, status: remote.statusCode, bytes: payload.length });
                    const deliver = () => { emit('wire-deliver', { method: rpc.method, clientClosed: res.destroyed });
                        if (!res.destroyed) { res.writeHead(remote.statusCode, remote.headers); res.end(payload); } };
                    if (write && mode === 'drop') { dropped++; emit('wire-drop', { id: rpc.id }); res.destroy(); }
                    else if (write && mode === 'delay') { delayed++; const timer = setTimeout(() => { timers.delete(timer); deliver(); }, delayMs); timers.add(timer); }
                    else deliver();
                });
            });
            upstream.add(out);
            out.on('error', error => { upstream.delete(out); emit('wire-error', { code: error.code }); res.destroy(); });
            out.end(body);
        });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { port: server.address().port, stats: () => ({ writes, delayed, dropped, pendingTimers: timers.size, upstream: upstream.size }),
        async close() { for (const t of timers) clearTimeout(t); timers.clear(); for (const r of upstream) r.destroy();
            for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createFaultProxy };
