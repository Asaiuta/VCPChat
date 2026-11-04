'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { UiServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
const { validate, isExperimental, isWrite } = require('../VCPDistributedServer/Plugin/AndroidController/lib/rpc-methods');
// Bundled APK ABI: PACKAGE_NAME=524288; 16777216 is INSTANCE, not packageName.
const container = { mask: 16 | 524288 | 2097152, packageName: 'com.example', className: 'android.widget.ScrollView', resourceId: 'com.example:id/list' };
const target = { mask: 1 | 524288, packageName: 'com.example', text: '目标%#' };
const valid = [
    ['drag', [1, 2, 3, 4, 60]], ['dragTo', [container, 3, 4, 60]],
    ['pinchIn', [container, 1, 1]], ['pinchOut', [container, 100, 2000]],
    ['scrollTo', [container, target, true]], ['scrollTo', [container, target, false]],
    ['pressKeyCode', [66]], ['pressKeyCode', [29, 4096]],
];
const invalid = [
    ['drag', [1, 2, 3, 4]], ['drag', [true, 2, 3, 4, 60]], ['drag', [-1, 2, 3, 4, 60]],
    ['drag', [1, 2, 3, 4, 2001]], ['dragTo', [null, 3, 4, 60]],
    ['dragTo', [container, 3, 4.5, 60]], ['dragTo', [{ ...container, packageName: '' }, 3, 4, 60]],
    ['pinchIn', [container, 0, 60]], ['pinchOut', [container, 101, 60]],
    ['pinchIn', [container, 50, 0]], ['pinchIn', [container, '50', 60]],
    ['pinchIn', [{ ...container, className: 2 }, 50, 60]],
    ['scrollTo', [container, target, 1]], ['scrollTo', [container, 'text=目标', true]],
    ['scrollTo', [{}, target, true]], ['scrollTo', [container, { ...target, arbitrary: 'not allowed' }, true]],
    ['scrollTo', [{ mask: 1, packageName: 'com.example', resourceId: 'com.example:id/list' }, target, true]],
    ['scrollTo', [{ mask: 0x40000000, packageName: 'com.example', className: 'android.widget.ScrollView' }, target, true]],
    ['scrollTo', [{ ...container, mask: container.mask & ~524288 }, target, true]],
    ['pressKeyCode', []], ['pressKeyCode', [66, 0, 0]], ['pressKeyCode', ['66']],
    ['pressKeyCode', [401]], ['pressKeyCode', [66, -1]], ['pressKeyCode', [66, 0x80000000]],
    ['pressKeyCode', [66, 0x100]], ['pressKeyCode', [66, true]],
];

test('M1.5 新增RPC参数门禁在真实invoke入口本地拒绝，无HTTP副作用', async t => {
    const calls = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const rpc = JSON.parse(body); calls.push(rpc);
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: true }));
        });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
    const client = new UiServer(); client._port = server.address().port; client._ready = true;
    for (const [method, params] of invalid) {
        const before = calls.length;
        assert.equal(validate(method, params).ok, false, method);
        await assert.rejects(client.invoke(method, params), error => error.code === 'UI_SERVER_INVALID_ARGUMENT' && error.dispatched === false);
        assert.equal(calls.length, before);
    }
    for (const [method, params] of valid) {
        assert.equal(validate(method, params).ok, true, method);
        assert.equal(isWrite(method), true);
        assert.equal(isExperimental(method), true);
        assert.equal(await client.invoke(method, params), true);
        assert.deepEqual(calls.at(-1).params, params);
    }
    assert.equal(calls.length, valid.length);
});
