'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const pluginPath = path.resolve(__dirname, '../VCPDistributedServer/Plugin.js');
const control = { process: null };
const stub = new Module(pluginPath);
stub.filename = pluginPath; stub.loaded = true;
stub.exports = { processToolCall: (...args) => control.process(...args), shutdownAllPlugins: async () => {},
    getAllPluginManifests: () => [], getPlugin: () => ({ pluginType: 'hybridservice' }) };
require.cache[pluginPath] = stub;
const Server = require('../VCPDistributedServer/VCPDistributedServer');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function socket() {
    const ws = new EventEmitter(); ws.readyState = 1; ws.sent = [];
    ws.send = raw => ws.sent.push(JSON.parse(raw)); ws.close = () => { ws.readyState = 3; };
    return ws;
}
function fixture() { const server = new Server({ serverName: 'cancellation-test' }); server.ws = socket(); return server; }
const call = (server, requestId, toolArgs = {}) => server.handleToolExecutionRequest({ requestId, toolName: 'AndroidController', toolArgs });
const cancel = (server, requestId, ws) => server.handleMainServerMessage(JSON.stringify({ type: 'cancel_tool', data: { requestId } }), ws);

test('only matching request is cancelled; tool args cannot replace signal and duplicate IDs cannot replace ownership', async () => {
    const server = fixture(), pending = deferred(), contexts = new Map();
    control.process = async (_, args, context) => { contexts.set(context.requestId, context); await pending.promise; return { content: [] }; };
    const first = call(server, 'a', { signal: 'forged', requestId: 'b' }), second = call(server, 'b');
    await call(server, 'a');
    assert.equal(contexts.size, 2);
    assert.ok(contexts.get('a').signal instanceof AbortSignal);
    await cancel(server, 'unknown'); assert.equal(contexts.get('a').signal.aborted, false);
    await cancel(server, 'a');
    assert.equal(contexts.get('a').signal.aborted, true); assert.equal(contexts.get('b').signal.aborted, false);
    pending.resolve(); await Promise.all([first, second]);
    assert.equal(server.activeToolCalls.size, 0);
    assert.equal(server.ws.sent.length, 2);
    assert.equal(server.ws.sent.find(message => message.data.requestId === 'a').data.status, 'error');
    assert.equal(server.ws.sent.find(message => message.data.requestId === 'b').data.status, 'success');
});

test('disconnect cancellation and late old-session replies never reach a replacement connection', async () => {
    const server = fixture(), old = server.ws, pending = deferred(); let signal;
    control.process = async (_, args, context) => { signal = context.signal; await pending.promise; return { content: [] }; };
    const task = call(server, 'old');
    server.cancelActiveToolCalls(old); old.readyState = 3; server.ws = socket();
    assert.equal(signal.aborted, true);
    await server.handleMainServerMessage(JSON.stringify({ type: 'execute_tool', data: { requestId: 'stale', toolName: 'AndroidController' } }), old);
    assert.equal(server.activeToolCalls.size, 1);
    pending.resolve(); await task;
    assert.equal(server.ws.sent.length, 0); assert.equal(old.sent.length, 0);
});

test('a stale socket cannot cancel requests on the current connection', async () => {
    const server = fixture(), old = server.ws, pending = deferred(); let signal;
    server.ws = socket();
    control.process = async (_, args, context) => { signal = context.signal; await pending.promise; return { content: [] }; };
    const task = call(server, 'current');
    server.cancelActiveToolCalls(old); await cancel(server, 'current', old);
    assert.equal(signal.aborted, false);
    await cancel(server, 'current'); assert.equal(signal.aborted, true);
    pending.resolve(); await task;
});

test('server stop cancels active trusted signals and does not publish late success', async () => {
    const server = fixture(), ws = server.ws, pending = deferred(); let signal;
    control.process = async (_, args, context) => { signal = context.signal; await pending.promise; return { content: [] }; };
    const task = call(server, 'stop'); await server.stop();
    assert.equal(signal.aborted, true);
    pending.resolve(); await task;
    assert.equal(ws.sent.length, 0); assert.equal(server.activeToolCalls.size, 0);
});
