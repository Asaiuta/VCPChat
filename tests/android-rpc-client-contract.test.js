'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');

async function fixture(t, respond) {
    const calls = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });
        req.on('end', () => {
            const rpc = JSON.parse(body);
            calls.push(rpc);
            respond(rpc, res);
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise(resolve => server.close(resolve));
    });

    const client = new UiServer();
    client._port = server.address().port;
    client._ready = true;
    return { client, calls };
}

const ok = (rpc, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }));

const fails = (code, dispatched) => error => {
    assert.equal(error.code, code);
    assert.equal(error.dispatched, dispatched);
    return true;
};

function deadlineTransport(t, { createCost = 0, parseCost = 0 } = {}) {
    let now = 1000;
    const writes = [];
    const requests = [];
    const parse = JSON.parse;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(JSON, 'parse', (text, ...args) => {
        const value = parse(text, ...args);
        if (value && Object.prototype.hasOwnProperty.call(value, 'result')) {
            now += parseCost;
        }
        return value;
    });
    t.mock.method(http, 'request', (options, onResponse) => {
        now += createCost;
        const req = new EventEmitter();
        requests.push(req);
        let body = '';
        req.write = chunk => {
            writes.push(chunk);
            body += chunk;
            return true;
        };
        req.destroy = () => {
            req.destroyed = true;
            return req;
        };
        req.end = () => {
            queueMicrotask(() => {
                if (req.destroyed) {
                    return;
                }
                const rpc = parse(body);
                const res = new EventEmitter();
                res.statusCode = 200;
                res.headers = {};
                res.destroy = () => {
                    res.destroyed = true;
                    return res;
                };
                onResponse(res);
                if (res.destroyed) {
                    return;
                }
                res.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true })));
                res.emit('end');
            });
            return req;
        };
        return req;
    });

    const client = new UiServer();
    client._port = 12345;
    client._ready = true;
    return {
        client,
        writes,
        requests,
        advance: ms => {
            now += ms;
        },
    };
}

test('entry deadline includes synchronous parameter serialization without dispatch', async t => {
    const { client, writes, requests, advance } = deadlineTransport(t);
    const params = [{
        toJSON() {
            advance(1001);
            return 'serialized';
        },
    }];
    const outcome = client.invoke('click', params, { timeoutMs: 1000 });
    await assert.rejects(outcome, fails('UI_SERVER_TIMEOUT', false));
    assert.equal(writes.length, 0, 'expired serialization must never write a request body');
    assert.ok(requests.every(req => req.destroyed), 'any allocated request must be destroyed');
});

test('entry deadline includes synchronous request creation without dispatch', async t => {
    const { client, writes, requests } = deadlineTransport(t, { createCost: 1001 });
    const outcome = client.invoke('click', [], { timeoutMs: 1000 });
    await assert.rejects(outcome, fails('UI_SERVER_TIMEOUT', false));
    assert.equal(requests.length, 1);
    assert.equal(writes.length, 0, 'expired request creation must never write a request body');
    assert.equal(requests[0].destroyed, true, 'expired request must be destroyed');
});

test('success settlement beyond the entry deadline fails after dispatch', async t => {
    const { client, writes } = deadlineTransport(t, { parseCost: 1001 });
    await assert.rejects(
        client.invoke('click', [], { timeoutMs: 1000 }),
        fails('UI_SERVER_TIMEOUT', true),
    );
    assert.equal(writes.length, 1, 'response settlement follows one dispatched request');
});

test('entry deadline includes synchronous option access before RPC preparation', async t => {
    const { client, writes, advance } = deadlineTransport(t);
    const options = {
        get timeoutMs() {
            advance(1001);
            return 1000;
        },
    };
    await assert.rejects(client.invoke('click', [], options), fails('UI_SERVER_TIMEOUT', false));
    assert.equal(writes.length, 0);
});

test('preparation expires exactly at the absolute deadline', async t => {
    const { client, writes, advance } = deadlineTransport(t);
    const params = [{
        toJSON() {
            advance(1000);
            return null;
        },
    }];
    await assert.rejects(
        client.invoke('click', params, { timeoutMs: 1000 }),
        fails('UI_SERVER_TIMEOUT', false),
    );
    assert.equal(writes.length, 0);
});

test('preparation and settlement share one budget rather than resetting it', async t => {
    const { client, writes, advance } = deadlineTransport(t, { createCost: 300, parseCost: 301 });
    const params = [{
        toJSON() {
            advance(400);
            return null;
        },
    }];
    await assert.rejects(
        client.invoke('click', params, { timeoutMs: 1000 }),
        fails('UI_SERVER_TIMEOUT', true),
    );
    assert.equal(writes.length, 1);
});

test('success remains valid strictly within the shared entry budget', async t => {
    const { client, writes, advance } = deadlineTransport(t, { createCost: 300, parseCost: 299 });
    const params = [{
        toJSON() {
            advance(400);
            return null;
        },
    }];
    assert.equal(await client.invoke('click', params, { timeoutMs: 1000 }), true);
    assert.equal(writes.length, 1);
});

test('whitelist, array parameters, unique IDs and raw results', async t => {
    const { client, calls } = await fixture(t, ok);
    const methods = [
        'click',
        'longClick',
        'swipe',
        'setText',
        'clearTextField',
        'getText',
        'getClipboard',
        'setClipboard',
        'pasteClipboard',
    ];
    for (const method of methods) {
        assert.equal(await client.invoke(method, [1, 'text'], { timeoutMs: 1000 }), true);
    }
    assert.equal(calls.length, 9);
    assert.deepEqual(calls[0].params, [1, 'text']);
    assert.equal(new Set(calls.map(c => c.id)).size, 9);
    await client.invoke('click');
    assert.deepEqual(calls.at(-1).params, []);
});

test('local rejection never dispatches HTTP', async t => {
    const { client, calls } = await fixture(t, ok);
    for (const method of ['shell', '__proto__', 'constructor', '', null]) {
        await assert.rejects(
            () => client.invoke(method),
            fails('UI_SERVER_INVALID_ARGUMENT', false),
        );
    }
    for (const params of [{}, null, 'text']) {
        await assert.rejects(
            () => client.invoke('click', params),
            fails('UI_SERVER_INVALID_ARGUMENT', false),
        );
    }
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, '100', 120001]) {
        await assert.rejects(
            () => client.invoke('click', [], { timeoutMs }),
            fails('UI_SERVER_INVALID_ARGUMENT', false),
        );
    }
    for (const options of [null, [], { signal: {} }]) {
        await assert.rejects(
            () => client.invoke('click', [], options),
            fails('UI_SERVER_INVALID_ARGUMENT', false),
        );
    }
    const cyclic = [];
    cyclic.push(cyclic);
    for (const params of [cyclic, [1n]]) {
        await assert.rejects(
            () => client.invoke('click', params),
            fails('UI_SERVER_INVALID_ARGUMENT', false),
        );
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        () => client.invoke('click', [], { signal: controller.signal }),
        fails('UI_SERVER_ABORTED', false),
    );
    client._ready = false;
    await assert.rejects(
        () => client.invoke('click'),
        fails('UI_SERVER_NOT_READY', false),
    );
    assert.equal(calls.length, 0);
});

test('invalid HTTP/envelope/body produce unknown outcome', async t => {
    const cases = [
        ['HTTP_ERROR', (rpc, res) => {
            res.statusCode = 503;
            ok(rpc, res);
        }],
        ['BAD_JSON', (rpc, res) => res.end('{')],
        ['BAD_RESPONSE', (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '1.0',
            id: rpc.id,
            result: true,
        }))],
        ['BAD_RESPONSE', (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: 'wrong',
            result: true,
        }))],
        ['BAD_RESPONSE', (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
        }))],
        ['BAD_RESPONSE', (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: true,
            error: { code: -32602, message: 'bad' },
        }))],
        ['BAD_RESPONSE', (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            error: { message: 'bad' },
        }))],
        ['BAD_RESPONSE', (rpc, res) => res.end('null')],
        ['BAD_RESPONSE', (rpc, res) => res.end('[]')],
        ['BAD_RESPONSE', (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: Number(rpc.id),
            result: true,
        }))],
        ['BAD_RESPONSE', (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            error: null,
        }))],
        ['RESPONSE_TOO_LARGE', (rpc, res) => {
            res.setHeader('Content-Length', 8 * 1024 * 1024 + 1);
            res.write('x');
        }],
        ['RESPONSE_TOO_LARGE', (rpc, res) => res.end('x'.repeat(8 * 1024 * 1024 + 1))],
    ];
    for (const [suffix, respond] of cases) {
        await t.test(suffix, async t => {
            const { client } = await fixture(t, respond);
            await assert.rejects(
                () => client.invoke('click'),
                fails('UI_SERVER_' + suffix, true),
            );
        });
    }
});

test('only method/argument rejection is known not dispatched', async t => {
    const cases = [
        [-32601, false],
        [-32602, false],
        [-32603, true],
        [1, true],
    ];
    for (const [code, dispatched] of cases) {
        const { client } = await fixture(t, (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code, message: 'rejected' },
        })));
        await assert.rejects(() => client.invoke('click'), error => {
            fails('UI_SERVER_RPC_ERROR', dispatched)(error);
            assert.equal(error.rpcCode, code);
            return true;
        });
    }
});

test('timeout is total step budget even with response trickling', async t => {
    const { client } = await fixture(t, (rpc, res) => {
        res.write('{');
        const interval = setInterval(() => res.write(' '), 5);
        res.on('close', () => clearInterval(interval));
    });
    const at = Date.now();
    await assert.rejects(
        () => client.invoke('click', [], { timeoutMs: 40 }),
        fails('UI_SERVER_TIMEOUT', true),
    );
    assert.ok(Date.now() - at < 1000);
});

test('in-flight abort and transport loss retain unknown outcome', async t => {
    const controller = new AbortController();
    const { client } = await fixture(t, (rpc, res) => {
        res.write('{');
        controller.abort();
    });
    await assert.rejects(
        () => client.invoke('click', [], { signal: controller.signal }),
        fails('UI_SERVER_ABORTED', true),
    );
    const other = await fixture(t, (rpc, res) => {
        res.write('{');
        res.destroy();
    });
    await assert.rejects(
        () => other.client.invoke('click'),
        fails('UI_SERVER_RPC_FAILED', true),
    );
});

test('default budget and AbortSignal listeners are cleaned after completion', async t => {
    const { client } = await fixture(t, ok);
    const controller = new AbortController();
    let listeners = 0;
    const signal = {
        get aborted() {
            return controller.signal.aborted;
        },
        addEventListener(...args) {
            listeners++;
            controller.signal.addEventListener(...args);
        },
        removeEventListener(...args) {
            listeners--;
            controller.signal.removeEventListener(...args);
        },
    };
    await client.invoke('click', [], { signal });
    assert.equal(listeners, 0);
    controller.abort();
    const silent = await fixture(t, () => {});
    silent.client.rpcTimeoutMs = 25;
    await assert.rejects(
        () => silent.client.invoke('click'),
        fails('UI_SERVER_TIMEOUT', true),
    );
});

test('falsy and structured results are valid', async t => {
    for (const result of [false, null, 0, '', [], { text: 'value' }]) {
        const { client } = await fixture(t, (rpc, res) => res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result,
        })));
        assert.deepEqual(await client.invoke('getText'), result);
    }
});
