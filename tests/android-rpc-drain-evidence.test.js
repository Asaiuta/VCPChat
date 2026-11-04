'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');

const evidence = (code, dispatched, drained) => error => {
    assert.equal(error.code, `UI_SERVER_${code}`);
    assert.equal(error.dispatched, dispatched);
    assert.equal(error.drained, drained);
    return true;
};

// Only in-process HTTP events are used; no sockets, adb or device lifecycle.
function transport(t, respond, { createCost = 0, creationError = false, writeError = false } = {}) {
    let now = 1000;
    const writes = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(http, 'request', (_options, callback) => {
        now += createCost;
        if (creationError) throw new Error('creation failed');
        const req = new EventEmitter();
        req.destroy = () => { req.destroyed = true; };
        req.write = body => {
            writes.push(body);
            if (writeError) throw new Error('write failed');
        };
        req.end = () => queueMicrotask(() => {
            if (req.destroyed) return;
            const rpc = JSON.parse(writes.at(-1));
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            res.destroy = () => { res.destroyed = true; };
            const send = value => {
                res.emit('data', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
                res.emit('end');
            };
            respond({ rpc, req, res, send, open: () => callback(res), advance: ms => { now += ms; } });
        });
        return req;
    });
    const client = new UiServer();
    client._ready = true;
    client._port = 12345;
    return { client, writes, advance: ms => { now += ms; } };
}

test('local invocation and dump rejections have no outstanding protocol request', async t => {
    const { client, writes } = transport(t, () => assert.fail('must not dispatch'));
    for (const invoke of [
        () => client.invoke('unknown'),
        () => client.invoke('click', {}),
        () => client.invoke('click', [1]),
        () => client.invoke('click', [1, 2], null),
        () => client.invoke('click', [1, 2], { timeoutMs: 0 }),
        () => client.invoke('click', [1, 2], { signal: {} }),
        () => client.dump({ timeoutMs: 0 }),
        () => client._rpc('click', [1n]),
    ]) await assert.rejects(invoke, evidence('INVALID_ARGUMENT', false, true));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client.invoke('click', [1, 2], { signal: controller.signal }), evidence('ABORTED', false, true));
    await assert.rejects(client._rpc('click', [], 1000, undefined, 1000), evidence('TIMEOUT', false, true));
    client._ready = false;
    await assert.rejects(client.invoke('click', [1, 2]), evidence('NOT_READY', false, true));
    await assert.rejects(client.dump(), evidence('NOT_READY', false, true));
    client._port = null;
    await assert.rejects(client._rpc('click', []), evidence('NOT_READY', false, true));
    assert.equal(writes.length, 0);
});

test('request preparation failures are drained without dispatch', async t => {
    for (const [name, options, code] of [
        ['creation throws', { creationError: true }, 'RPC_FAILED'],
        ['creation exhausts budget', { createCost: 1000 }, 'TIMEOUT'],
    ]) await t.test(name, async t => {
        const { client, writes } = transport(t, () => assert.fail('must not dispatch'), options);
        await assert.rejects(client.invoke('click', [1, 2], { timeoutMs: 1000 }), evidence(code, false, true));
        assert.equal(writes.length, 0);
    });
});

test('only a complete matched valid JSON-RPC error proves drain', async t => {
    for (const code of [-32601, -32602, -32603, 1]) await t.test(String(code), async t => {
        const { client } = transport(t, ({ rpc, open, send }) => {
            open();
            send({ jsonrpc: '2.0', id: rpc.id, error: { code, message: 'failure' } });
        });
        await assert.rejects(client.invoke('click', [1, 2]), error => {
            evidence('RPC_ERROR', ![-32601, -32602].includes(code), true)(error);
            assert.equal(error.rpcCode, code);
            return true;
        });
    });
});

test('invalid responses cannot establish drain', async t => {
    const cases = [
        ['invalid JSON', 'BAD_JSON', () => '{'],
        ['null', 'BAD_RESPONSE', () => 'null'],
        ['array', 'BAD_RESPONSE', () => '[]'],
        ['wrong version', 'BAD_RESPONSE', id => ({ jsonrpc: '1.0', id, result: true })],
        ['wrong id', 'BAD_RESPONSE', () => ({ jsonrpc: '2.0', id: 'wrong', result: true })],
        ['numeric id', 'BAD_RESPONSE', id => ({ jsonrpc: '2.0', id: Number(id), result: true })],
        ['missing outcome', 'BAD_RESPONSE', id => ({ jsonrpc: '2.0', id })],
        ['both outcomes', 'BAD_RESPONSE', id => ({ jsonrpc: '2.0', id, result: true, error: { code: -32602, message: 'bad' } })],
        ...[null, [], {}, { code: -32602 }, { code: '-32602', message: 'bad' }, { code: 1.5, message: 'bad' }, { code: -32602, message: 0 }]
            .map((error, index) => [`bad error ${index}`, 'BAD_RESPONSE', id => ({ jsonrpc: '2.0', id, error })]),
    ];
    for (const [name, code, payload] of cases) await t.test(name, async t => {
        const { client } = transport(t, ({ rpc, open, send }) => { open(); send(payload(rpc.id)); });
        await assert.rejects(client.invoke('click', [1, 2]), evidence(code, true, false));
    });
});

test('transport failures and incomplete responses remain undrained', async t => {
    const cases = [
        ['HTTP', 'HTTP_ERROR', ({ res, open }) => { res.statusCode = 503; open(); }],
        ['declared oversized', 'RESPONSE_TOO_LARGE', ({ res, open }) => { res.headers['content-length'] = 8388609; open(); }],
        ['stream oversized', 'RESPONSE_TOO_LARGE', ({ res, open }) => { open(); res.emit('data', Buffer.alloc(8388609)); }],
        ['request error', 'RPC_FAILED', ({ req }) => req.emit('error', new Error('lost'))],
        ['response error', 'RPC_FAILED', ({ res, open }) => { open(); res.emit('error', new Error('lost')); }],
        ['response aborted', 'RPC_FAILED', ({ res, open }) => { open(); res.emit('aborted'); }],
        ['complete bytes without end', 'RPC_FAILED', ({ rpc, res, open }) => {
            open(); res.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }))); res.emit('close');
        }],
        ['timeout', 'TIMEOUT', ({ res, open }) => { open(); res.emit('data', Buffer.from('{')); }],
    ];
    for (const [name, code, respond] of cases) await t.test(name, async t => {
        const { client } = transport(t, respond);
        await assert.rejects(client.invoke('click', [1, 2], { timeoutMs: 30 }), evidence(code, true, false));
    });
    await t.test('abort after write', async t => {
        const controller = new AbortController();
        const { client } = transport(t, ({ open }) => { open(); controller.abort(); });
        await assert.rejects(client.invoke('click', [1, 2], { signal: controller.signal }), evidence('ABORTED', true, false));
    });
    await t.test('write throws', async t => {
        const { client } = transport(t, () => {}, { writeError: true });
        await assert.rejects(client.invoke('click', [1, 2]), evidence('RPC_FAILED', true, false));
    });
});

test('valid result parsed beyond budget is drained but still times out', async t => {
    const parse = JSON.parse;
    const { client, advance } = transport(t, ({ rpc, open, send }) => {
        open(); send({ jsonrpc: '2.0', id: rpc.id, result: false });
    });
    t.mock.method(JSON, 'parse', (...args) => {
        const result = parse(...args);
        if (Object.hasOwn(result, 'result')) advance(1001);
        return result;
    });
    await assert.rejects(client.invoke('click', [1, 2], { timeoutMs: 1000 }), evidence('TIMEOUT', true, true));
});

test('dump payload rejection follows a drained valid result', async t => {
    for (const result of [null, false, {}, '<wrong/>']) await t.test(JSON.stringify(result), async t => {
        const { client } = transport(t, ({ rpc, open, send }) => { open(); send({ jsonrpc: '2.0', id: rpc.id, result }); });
        await assert.rejects(client.dump(), evidence('BAD_PAYLOAD', true, true));
    });
});
