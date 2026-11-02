'use strict';
/**
 * 契约：分布式服务器的 tool_result 错误分支必须保留插件的机器可读字段。
 *
 * 背景：AndroidController 的 failure() 会挂 code，step-runtime 会挂 execution
 * (outcome/timings/verification)。如果主机侧只转发 message，模型与上层就只能
 * 拿到一句中文，无法区分「已派发但未证实(unknown)」「参数非法」「快照过期」。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const PLUGIN_PATH = path.join(REPO, 'VCPDistributedServer', 'Plugin.js');
const SERVER_PATH = path.join(REPO, 'VCPDistributedServer', 'VCPDistributedServer.js');

// 用假 Plugin.js 顶掉真实插件管理器，避免测试拉起全部插件。
const controller = { impl: async () => ({ content: [] }) };
const stub = new Module(PLUGIN_PATH, null);
stub.filename = PLUGIN_PATH;
stub.loaded = true;
stub.exports = { processToolCall: (...args) => controller.impl(...args) };
require.cache[PLUGIN_PATH] = stub;

const DistributedServer = require(SERVER_PATH);

function makeServer() {
    const server = new DistributedServer({ serverName: 'test-server' });
    const sent = [];
    server.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
    return { server, sent };
}

async function runWith(thrown) {
    controller.impl = async () => { throw thrown; };
    const { server, sent } = makeServer();
    await server.handleToolExecutionRequest({
        requestId: 'req-1', toolName: 'AndroidController', toolArgs: {},
    });
    assert.equal(sent.length, 1, '应当恰好回一条 tool_result');
    return sent[0];
}

test('错误分支保留 code 与 execution', async () => {
    const err = Object.assign(new Error('[AndroidController] 快照不匹配或已过期，请重新 Observe。'), {
        code: 'STALE_SNAPSHOT',
        execution: {
            requestId: 'req-1', outcome: 'unknown',
            timings: { prepareMs: 12, actionMs: 3, totalMs: 15 },
        },
    });
    const payload = await runWith(err);

    assert.equal(payload.type, 'tool_result');
    assert.equal(payload.data.requestId, 'req-1');
    assert.equal(payload.data.status, 'error');
    assert.match(payload.data.error, /快照不匹配/);
    assert.equal(payload.data.code, 'STALE_SNAPSHOT');
    assert.deepEqual(payload.data.execution, {
        requestId: 'req-1', outcome: 'unknown',
        timings: { prepareMs: 12, actionMs: 3, totalMs: 15 },
    });
});

test('没有 code/execution 的普通错误不引入多余字段', async () => {
    const payload = await runWith(new Error('boom'));
    assert.equal(payload.data.status, 'error');
    assert.equal(payload.data.error, 'boom');
    assert.deepEqual(Object.keys(payload.data).sort(), ['error', 'requestId', 'status']);
});

test('execution 含循环引用时不炸掉整条响应', async () => {
    const err = Object.assign(new Error('weird'), { code: 'X' });
    err.execution = { outcome: 'unknown' };
    err.execution.self = err.execution;   // 循环
    const payload = await runWith(err);

    assert.equal(payload.data.status, 'error');
    assert.equal(payload.data.error, 'weird');
    assert.equal(payload.data.code, 'X', 'code 仍应保留');
    // execution 无法序列化时宁可丢弃，也不能让 ws.send 抛错
    assert.equal(payload.data.execution, undefined);
});
