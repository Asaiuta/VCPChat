'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { UiServer, UiServerError } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');

function readyClient() {
    const client = new UiServer();
    client._ready = true;
    client._port = 12345;
    return client;
}

function localFailure(code) {
    return error => {
        assert.ok(error instanceof UiServerError);
        assert.equal(error.code, code);
        assert.equal(error.dispatched, false);
        assert.equal(error.drained, true);
        return true;
    };
}

for (const [label, options] of [
    ['null options', null],
    ['array options', []],
    ['primitive options', true],
    ['null signal', { signal: null }],
    ['incomplete signal', { signal: { aborted: false, addEventListener() {} } }],
    ['invalid timeout', { timeoutMs: 0 }],
    ['excessive timeout', { timeoutMs: 120001 }],
]) {
    test(`dump and invoke reject ${label} before transport allocation`, async t => {
        let requests = 0;
        t.mock.method(http, 'request', () => {
            requests++;
            throw new Error('transport must not be allocated');
        });
        const client = readyClient();
        for (const call of [() => client.dump(options), () => client.invoke('getClipboard', [], options)]) {
            await assert.rejects(call, localFailure('UI_SERVER_INVALID_ARGUMENT'));
        }
        assert.equal(requests, 0);
    });
}

test('dump preparation shares the entry deadline instead of resetting the timeout', async t => {
    let now = 1000;
    let requests = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(http, 'request', () => {
        requests++;
        throw new Error('expired preparation must not allocate transport');
    });
    await assert.rejects(readyClient().dump({
        timeoutMs: 1000,
        get maxDepth() {
            now += 1000;
            return 60;
        },
    }), localFailure('UI_SERVER_TIMEOUT'));
    assert.equal(requests, 0);
});

test('dump preserves normalization and forwards validated signal and total deadline', async t => {
    t.mock.method(Date, 'now', () => 1000);
    const client = readyClient();
    const controller = new AbortController();
    const calls = [];
    t.mock.method(client, '_rpc', async (...args) => {
        calls.push(args);
        return '<hierarchy />';
    });
    assert.deepEqual(await client.dump(), { xml: '<hierarchy />' });
    await client.dump({ compressed: true, maxDepth: 60.9, rootInActive: false, timeoutMs: 120000, signal: controller.signal });
    await client.dump({ maxDepth: 0, timeoutMs: 1 });
    assert.deepEqual(calls, [
        ['dumpWindowHierarchy', [false, 200, true], 4000, undefined, 5000],
        ['dumpWindowHierarchy', [true, 60, false], 120000, controller.signal, 121000],
        ['dumpWindowHierarchy', [false, 200, true], 1, undefined, 1001],
    ]);
});

test('dump pre-abort remains a clean local rejection', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readyClient().dump({ signal: controller.signal }), localFailure('UI_SERVER_ABORTED'));
});