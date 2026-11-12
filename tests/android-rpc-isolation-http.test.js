'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
const { harness, xml } = require('./helpers/android-service-harness.cjs');

async function setup(t, respond) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            requests.push(request);
            respond(request, res);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const client = new UiServer();
    client.transport.port = server.address().port;
    client.transport.ready = true;
    const h = await harness({ uiServer: { ok: true,
        async xml() { return (await client.dump()).xml; },
        invoke: (method, params, options) => client.invoke(method, params, options),
    } });
    t.after(() => h.service.cleanup());
    return { h, requests };
}
const observe = h => h.service.processToolCall({ command: 'Observe', serial: 'A' });
const tap = h => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', id: 'com.example:id/go' } });
const success = (request, res, result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));

for (const phase of ['dumpWindowHierarchy', 'click']) {
    for (const kind of ['disconnect', 'invalid-json', 'wrong-id-rejection']) {
        test(`real ${kind} during ${phase} cannot escape quarantine`, async t => {
            const { h, requests } = await setup(t, (request, res) => {
                if (request.method !== phase) return success(request, res, xml());
                if (kind === 'disconnect') return res.destroy();
                if (kind === 'invalid-json') return res.end('not json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: 'other-request', error: { code: -32601, message: 'missing' } }));
            });
            await assert.rejects(phase === 'click' ? tap(h) : observe(h), {
                code: kind === 'disconnect' ? 'UI_SERVER_RPC_FAILED' : kind === 'invalid-json' ? 'UI_SERVER_BAD_JSON' : 'UI_SERVER_BAD_RESPONSE',
            });
            const count = requests.length;
            await assert.rejects(observe(h), { code: 'DEVICE_STATE_UNCERTAIN' });
            await assert.rejects(tap(h), { code: 'DEVICE_STATE_UNCERTAIN' });
            assert.equal(requests.length, count);
            assert.equal(h.dumpCount, 0);
            assert.equal(h.uiServer.stopped, 0);
            assert.equal(h.calls.some(call => call[0] === 'adb' && call[1].includes('input')), false);
        });
    }
}

for (const kind of ['invalid-payload', 'device-error']) {
    test(`real completed ${kind} during dump permits safe read fallback, not quarantine`, async t => {
        const { h, requests } = await setup(t, (request, res) => {
            if (kind === 'invalid-payload') return success(request, res, { not: 'xml' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'device read failed' } }));
        });
        assert.equal((await observe(h)).details.execution.outcome, 'observed');
        assert.equal((await observe(h)).details.execution.outcome, 'observed');
        assert.equal(h.dumpCount, 2);
        assert.equal(requests.length, 2);
    });
}

for (const code of [-32601, -32001]) {
    test(`real completed click error ${code} preserves write replay policy independently of drained`, async t => {
        const { h, requests } = await setup(t, (request, res) => {
            if (request.method === 'dumpWindowHierarchy') return success(request, res, xml());
            res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message: 'device error private content' } }));
        });
        if (code === -32601) assert.equal((await tap(h)).details.execution.outcome, 'dispatched');
        else await assert.rejects(tap(h), error => error.execution.outcome === 'unknown' && !error.message.includes('private content'));
        assert.equal(requests.filter(request => request.method === 'click').length, 1);
        assert.equal(h.calls.filter(call => call[0] === 'adb' && call[1].includes('input')).length, code === -32601 ? 1 : 0);
        if (code === -32601) assert.equal((await observe(h)).details.execution.outcome, 'observed');
        else await assert.rejects(observe(h), { code: 'DEVICE_STATE_UNCERTAIN' });
    });
}
