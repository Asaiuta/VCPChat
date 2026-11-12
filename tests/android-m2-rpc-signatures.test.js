'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
const { entry, validate, isExperimental, isWrite } = require('../VCPDistributedServer/Plugin/AndroidController/lib/rpc-methods');

// Independently established from the bundled APK, not imported from production selectors.
const PACKAGE_NAME = 524288;
const INSTANCE = 16777216;
const container = { mask: 16 | PACKAGE_NAME | 2097152, packageName: 'com.example', className: 'android.widget.ScrollView', resourceId: 'com.example:id/list' };
const target = { mask: 1 | PACKAGE_NAME, packageName: 'com.example', text: '目标%#' };

async function rpcHarness(t, result) {
    const calls = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const rpc = JSON.parse(body);
            calls.push(rpc);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    const client = new UiServer();
    client.transport.port = server.address().port;
    client.transport.ready = true;
    return { calls, client };
}

async function rejectsWithoutHttp({ calls, client }, method, params) {
    const before = calls.length;
    assert.equal(validate(method, params).ok, false, `${method} invalid signature`);
    await assert.rejects(client.invoke(method, params), error =>
        error.code === 'UI_SERVER_INVALID_ARGUMENT' && error.dispatched === false);
    assert.equal(calls.length, before, `${method} invalid request must not reach HTTP`);
}

test('M2 waitForIdle arity=1 accepts numeric safe integers 1–2000 and remains read-only experimental', async t => {
    assert.deepEqual(entry('waitForIdle').arity, [1]);
    assert.equal(isWrite('waitForIdle'), false);
    assert.equal(isExperimental('waitForIdle'), true);
    for (let milliseconds = 1; milliseconds <= 2000; milliseconds += 1) {
        assert.equal(validate('waitForIdle', [milliseconds]).ok, true);
    }
    const h = await rpcHarness(t, null);
    const invalid = [
        [], [1, 2], null, {}, 1500,
        [0], [-1], [2001], [Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER + 1],
        [0.5], [1.5], [NaN], [Infinity], [-Infinity],
        ['1'], ['1500'], ['2000'], ['1e3'], ['0x10'],
        [true], [false], [null], [undefined], [[]], [{}],
    ];
    for (const params of invalid) await rejectsWithoutHttp(h, 'waitForIdle', params);
    for (const milliseconds of [1, 1500, 2000]) {
        const before = h.calls.length;
        // A native void/null response is only a hint; this test asserts transport, not idle verification.
        assert.equal(await h.client.invoke('waitForIdle', [milliseconds]), null);
        assert.equal(h.calls.length, before + 1);
        assert.equal(h.calls.at(-1).method, 'waitForIdle');
        assert.deepEqual(h.calls.at(-1).params, [milliseconds]);
    }
    assert.equal(h.calls.length, 3);
});

test('M2 HTTP selector ABI uses PACKAGE_NAME=524288 and rejects legacy INSTANCE=16777216 package masks locally', async t => {
    assert.notEqual(PACKAGE_NAME, INSTANCE);
    const h = await rpcHarness(t, true);
    const valid = [
        ['dragTo', [container, 3, 4, 60]],
        ['pinchIn', [container, 1, 1]],
        ['pinchOut', [container, 100, 2000]],
        ['scrollTo', [container, target, true]],
        ['scrollTo', [container, target, false]],
    ];
    const wrongMasks = selector => [
        { ...selector, mask: (selector.mask & ~PACKAGE_NAME) | INSTANCE },
        { ...selector, mask: selector.mask | INSTANCE },
        { ...selector, mask: selector.mask & ~PACKAGE_NAME },
    ];
    for (const wrong of wrongMasks(container)) {
        for (const [method, params] of [
            ['dragTo', [wrong, 3, 4, 60]],
            ['pinchIn', [wrong, 50, 60]],
            ['pinchOut', [wrong, 50, 60]],
            ['scrollTo', [wrong, target, true]],
        ]) await rejectsWithoutHttp(h, method, params);
    }
    for (const wrong of wrongMasks(target)) {
        await rejectsWithoutHttp(h, 'scrollTo', [container, wrong, true]);
    }
    for (const [method, params] of valid) {
        assert.equal(validate(method, params).ok, true, method);
        const before = h.calls.length;
        assert.equal(await h.client.invoke(method, params), true);
        assert.equal(h.calls.length, before + 1);
        assert.equal(h.calls.at(-1).method, method);
        assert.deepEqual(h.calls.at(-1).params, params);
    }
    assert.equal(h.calls.length, valid.length);
});
