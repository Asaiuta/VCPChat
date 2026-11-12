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
    client.transport.port = server.address().port;
    client.transport.ready = true;
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
    client.transport.port = 12345;
    client.transport.ready = true;
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
    }, 0];
    const outcome = client.invoke('click', params, { timeoutMs: 1000 });
    await assert.rejects(outcome, fails('UI_SERVER_TIMEOUT', false));
    assert.equal(writes.length, 0, 'expired serialization must never write a request body');
    assert.ok(requests.every(req => req.destroyed), 'any allocated request must be destroyed');
});

test('entry deadline includes synchronous request creation without dispatch', async t => {
    const { client, writes, requests } = deadlineTransport(t, { createCost: 1001 });
    const outcome = client.invoke('click', [1, 2], { timeoutMs: 1000 });
    await assert.rejects(outcome, fails('UI_SERVER_TIMEOUT', false));
    assert.equal(requests.length, 1);
    assert.equal(writes.length, 0, 'expired request creation must never write a request body');
    assert.equal(requests[0].destroyed, true, 'expired request must be destroyed');
});

test('success settlement beyond the entry deadline fails after dispatch', async t => {
    const { client, writes } = deadlineTransport(t, { parseCost: 1001 });
    await assert.rejects(
        client.invoke('click', [1, 2], { timeoutMs: 1000 }),
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
    await assert.rejects(client.invoke('click', [1, 2], options), fails('UI_SERVER_TIMEOUT', false));
    assert.equal(writes.length, 0);
});

test('preparation expires exactly at the absolute deadline', async t => {
    const { client, writes, advance } = deadlineTransport(t);
    const params = [{
        toJSON() {
            advance(1000);
            return null;
        },
    }, 0];
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
    }, 0];
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
    }, 0];
    assert.equal(await client.invoke('click', params, { timeoutMs: 1000 }), true);
    assert.equal(writes.length, 1);
});

test('whitelist, array parameters, unique IDs and raw results', async t => {
    const { client, calls } = await fixture(t, ok);
    const methods = [
        ['click', [1, 'text']],
        ['click', [1, 2, 800]],
        ['longClick', [{ mask: 1, text: 'Go' }]],
        ['swipe', [1, 'text', 3, 4, 5]],
        ['setText', [1, 'text']],
        ['clearTextField', [1]],
        ['getText', [1]],
        ['getClipboard', []],
        ['setClipboard', [1, 'text']],
        ['pasteClipboard', []],
    ];
    for (const [method, params] of methods) {
        assert.equal(await client.invoke(method, params, { timeoutMs: 1000 }), true);
    }
    assert.equal(calls.length, methods.length);
    assert.deepEqual(calls[0].params, [1, 'text']);
    assert.equal(new Set(calls.map(c => c.id)).size, methods.length);
    await client.invoke('click', [1, 2]);
    assert.deepEqual(calls.at(-1).params, [1, 2]);
});

test('参数形状错误的调用在本地就变红灯，绝不发到设备', async t => {
    // 随包 APK 已确认 click(x,y,ms)，四参才是形状错误；longClick 没有坐标重载。
    const { client, calls } = await fixture(t, ok);
    for (const [method, params] of [
        ['click', [1, 2, 800, 0]],
        ['click', [1]],
        ['longClick', [1, 2]],
        ['swipe', [1, 2, 3, 4]],
        ['setText', [1]],
        ['getClipboard', ['x']],
        ['pasteClipboard', ['x']],
        ['getText', []],
    ]) {
        await assert.rejects(
            () => client.invoke(method, params),
            error => {
                assert.equal(error.code, 'UI_SERVER_INVALID_ARGUMENT');
                assert.equal(error.dispatched, false);
                assert.match(error.message, /参数|parameter/i);
                return true;
            },
            `${method}(${JSON.stringify(params)}) 应当本地拒绝`,
        );
    }
    assert.equal(calls.length, 0, '形状错误不得产生任何设备调用');
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
            () => client.invoke('click', [1, 2], { timeoutMs }),
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
        () => client.invoke('click', [1, 2], { signal: controller.signal }),
        fails('UI_SERVER_ABORTED', false),
    );
    client.transport.ready = false;
    await assert.rejects(
        () => client.invoke('click', [1, 2]),
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
                () => client.invoke('click', [1, 2]),
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
        await assert.rejects(() => client.invoke('click', [1, 2]), error => {
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
        () => client.invoke('click', [1, 2], { timeoutMs: 40 }),
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
        () => client.invoke('click', [1, 2], { signal: controller.signal }),
        fails('UI_SERVER_ABORTED', true),
    );
    const other = await fixture(t, (rpc, res) => {
        res.write('{');
        res.destroy();
    });
    await assert.rejects(
        () => other.client.invoke('click', [1, 2]),
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
    await client.invoke('click', [1, 2], { signal });
    assert.equal(listeners, 0);
    controller.abort();
    const silent = await fixture(t, () => {});
    silent.client.rpcTimeoutMs = 25;
    await assert.rejects(
        () => silent.client.invoke('click', [1, 2]),
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
        assert.deepEqual(await client.invoke('getText', [1]), result);
    }
});

test('能力默认 unknown，且不会因为「没失败过」就被当成可用', async t => {
    const { client } = await fixture(t, ok);
    // paste 是写通道，没有只读探针：没观测到失败就只能是 unknown，不能拿 get 族的
    // 成功去推断它可用（真机上 getClipboard 活、pasteClipboard 死，正好构反例）。
    assert.equal(client.capability('pasteClipboard'), 'unknown');
    assert.equal(client.capability('getClipboard'), 'unknown', '按方法记账，各管各的');
});

test('观测到的失败才能把通道降级为不可用，反向不成立', async t => {
    const { client } = await fixture(t, ok);
    client.noteCapability('pasteClipboard', 'available');
    assert.equal(client.capability('pasteClipboard'), 'unknown', '只接受 unavailable，可用不能凭记一笔就成立');
    client.noteCapability('pasteClipboard', 'unavailable');
    assert.equal(client.capability('pasteClipboard'), 'unavailable');
    client.noteCapability('pasteClipboard', 'available');
    assert.equal(client.capability('pasteClipboard'), 'unavailable', '不允许把已判死的通道改回可用');
    assert.equal(client.capability('setClipboard'), 'unknown', '不按组连坐：set 与 paste 是两条命');
});

test('服务端报错是能力结论，传输失败不是', async t => {
    // 超时/断连只能说明「这次没问成」，不能据此封掉通道。
    const flaky = await fixture(t, () => {});
    flaky.client.rpcTimeoutMs = 25;
    await assert.rejects(() => flaky.client.invoke('pasteClipboard', []), fails('UI_SERVER_TIMEOUT', true));
    assert.equal(flaky.client.capability('pasteClipboard'), 'unknown', '超时不得被判成不可用');
});

test('停服会作废能力结论：重装 APK 后不能沿用旧判定', async t => {
    const { client } = await fixture(t, ok);
    client.noteCapability('pasteClipboard', 'unavailable');
    assert.equal(client.capability('pasteClipboard'), 'unavailable');
    client.transport.ready = false;
    // 不要真去跑 adb forward --remove：这里验证的是能力缓存的作废，不是 adb。
    client.transport._removeForward = async () => undefined;
    await client.stop();
    assert.equal(client.capability('pasteClipboard'), 'unknown', '新进程可能来自不同的 APK / ROM');
});
