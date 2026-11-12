'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAndroidTaskReplanChannel } = require('../modules/services/androidTaskReplanChannel');
const upstream = require('../../VCPToolBox/WebSocketServer');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function socket() { return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } }; }

test('node binds replies to both parent and original socket; abort waits for receipt; duplicates cannot settle again', async () => {
    const channel = createAndroidTaskReplanChannel(), ws = socket(), wrong = socket(), controller = new AbortController();
    const bound = channel.bind(ws, 'parent'); let settled = false;
    const pending = bound({}, { signal: controller.signal, timeoutMs: 10000 }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    const data = { ...ws.sent[0].data, status: 'success', answer: { action: 'stop' } };
    channel.receive(wrong, data); channel.receive(ws, { ...data, requestId: 'wrong' }); await tick(); assert.equal(settled, false);
    controller.abort(); await tick(); assert.equal(settled, false); assert.equal(ws.sent.at(-1).type, 'cancel_android_task_replan');
    channel.receive(ws, data); assert.equal((await pending).code, 'TASK_ASSISTANCE_TIMEOUT'); channel.receive(ws, data);
    await assert.rejects(bound({}, { signal: new AbortController().signal, timeoutMs: 1 }), { code: 'TASK_ASSISTANCE_LIMIT' });
});

test('node connection close ends its transport and rejects late responses', async () => {
    const channel = createAndroidTaskReplanChannel(), ws = socket();
    const pending = channel.bind(ws, 'p')({}, { signal: new AbortController().signal, timeoutMs: 10000 });
    channel.close(socket()); channel.close(ws);
    await assert.rejects(pending, { code: 'TASK_ASSISTANCE_UNAVAILABLE' });
    channel.receive(ws, { ...ws.sent[0].data, status: 'success', answer: {} });
});

test('upstream rejects wrong or replaced socket, deduplicates callbacks, and sends cancellation receipt only after drain', async () => {
    const { distributedServers, pendingToolRequests, rejectPendingToolRequestsForServer } = upstream.__testing;
    const ws = socket(), other = socket(), entered = deferred(), release = deferred(); let calls = 0, signal;
    upstream.setPluginManager({ getPlugin: () => ({ communication: { timeout: 10000 } }) });
    distributedServers.set('node', { ws, capabilities: { cancelTool: true } }); distributedServers.set('other', { ws: other });
    const execution = upstream.executeDistributedTool('node', 'AndroidController', {}, 10000, { androidTaskReplan: async (_packet, opts) => {
        calls++; signal = opts.signal; entered.resolve(); await release.promise; return { action: 'stop' };
    } }).catch(error => error);
    const requestId = ws.sent[0].data.requestId, data = { requestId, replanId: randomUUID(), timeoutMs: 10000, packet: {} };
    const msg = { type: 'android_task_replan', data };
    await upstream.handleDistributedServerMessage('node', msg, other);
    await upstream.handleDistributedServerMessage('other', msg, other); assert.equal(calls, 0);
    const running = upstream.handleDistributedServerMessage('node', msg, ws); await entered.promise;
    await upstream.handleDistributedServerMessage('node', msg, ws); assert.equal(calls, 1);
    await upstream.handleDistributedServerMessage('node', { type: 'cancel_android_task_replan', data: { ...data, replanId: randomUUID() } }, ws);
    assert.equal(signal.aborted, false);
    await upstream.handleDistributedServerMessage('node', { type: 'cancel_android_task_replan', data }, ws);
    assert.equal(signal.aborted, true); assert.equal(ws.sent.some(m => m.type === 'android_task_replan_result'), false);
    release.resolve(); await running; assert.equal(ws.sent.at(-1).data.status, 'error');
    distributedServers.set('node', { ws: other });
    await upstream.handleDistributedServerMessage('node', { type: 'tool_result', data: { requestId, status: 'success', result: 'forged' } }, other);
    assert.equal(pendingToolRequests.has(requestId), true);
    rejectPendingToolRequestsForServer('node', other); assert.equal(pendingToolRequests.has(requestId), true);
    rejectPendingToolRequestsForServer('node', ws); await execution; distributedServers.clear();
});
