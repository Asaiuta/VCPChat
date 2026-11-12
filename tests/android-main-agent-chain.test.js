'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { searchWorld, spec, response } = require('./helpers/android-search-world.cjs');
const { world: uiWorld, spec: uiSpec, response: uiResponse } = require('./helpers/android-ui-task-world.cjs');
const toolbox = path.resolve(__dirname, '../../VCPToolBox');
function stub(file, exports) {
    const module = new Module(file); module.filename = file; module.loaded = true; module.exports = exports; require.cache[file] = module;
}
const control = {};
stub(path.resolve(__dirname, '../VCPDistributedServer/Plugin.js'), {
    processToolCall: (...args) => control.process(...args), getAllPluginManifests: () => [], getPlugin: () => ({ pluginType: 'hybridservice' })
});
stub(path.join(toolbox, 'modules/toolCallRecordStore.js'), { beginRecord: () => null, finishRecord() {} });
const Server = require('../VCPDistributedServer/VCPDistributedServer');
const upstream = require(path.join(toolbox, 'WebSocketServer'));
const { createTaskExecutionOptions } = require(path.join(toolbox, 'modules/androidTaskReplanner'));
const { createDefaultExecutionBridgeRegistry } = require(path.join(toolbox, 'modules/pluginBridgeRegistry'));
const ToolExecutor = require(path.join(toolbox, 'modules/vcpLoop/toolExecutor'));
const StreamHandler = require(path.join(toolbox, 'modules/handlers/streamHandler'));
const NonStreamHandler = require(path.join(toolbox, 'modules/handlers/nonStreamHandler'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function connect(world) {
    const down = new Server({ serverName: 'j52-offline' }), messages = [], jobs = [];
    const downstreamSocket = new EventEmitter(), upstreamSocket = new EventEmitter();
    downstreamSocket.readyState = upstreamSocket.readyState = 1;
    downstreamSocket.send = raw => { const message = JSON.parse(raw); messages.push(message);
        jobs.push(upstream.handleDistributedServerMessage('offline', message, upstreamSocket)); };
    upstreamSocket.send = raw => { messages.push(JSON.parse(raw)); jobs.push(down.handleMainServerMessage(raw, downstreamSocket)); };
    down.ws = downstreamSocket;
    upstream.__testing.distributedServers.set('offline', { ws: upstreamSocket, capabilities: { cancelTool: true } });
    const plugin = { name: 'AndroidController', isDistributed: true, serverId: 'offline', communication: { timeout: 60000 } };
    const bridge = createDefaultExecutionBridgeRegistry();
    const manager = { getPlugin: () => plugin, async processToolCall(toolName, args, _ip, _source, executionOptions) {
        return (await bridge.execute(plugin, args, { toolName, executionOptions, webSocketServer: upstream, debugLog() {} })).result;
    } };
    upstream.setPluginManager(manager);
    control.process = (_name, args, context) => world.service.processToolCall(args, context);
    return { messages, down, jobs, upstreamSocket, downstreamSocket,
        executor: new ToolExecutor({ pluginManager: manager, webSocketServer: { broadcast() {} } }),
        async close() {
            down.cancelActiveToolCalls(); upstream.__testing.rejectPendingToolRequestsForServer('offline', upstreamSocket);
            upstream.__testing.distributedServers.clear(); await Promise.all(jobs);
        } };
}
function aiResponse(text, stream) {
    if (!stream) return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })) };
    const body = new PassThrough();
    setImmediate(() => body.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
    return { ok: true, body };
}
function httpResponse() {
    const res = new EventEmitter(); res.writableEnded = false; res.destroyed = false;
    res.write = (_chunk, done) => { done?.(); return true; }; res.end = () => { res.writableEnded = true; res.emit('finish'); }; res.send = () => res.end();
    return res;
}

for (const stream of [false, true]) test(`${stream ? 'stream' : 'non-stream'} handler -> tool executor -> bridge -> both WS peers -> real task -> originating model`, async t => {
    const world = await searchWorld({ decide: (state, questions) => response(questions, state.step === 'entry' ? 'escalate' : state.candidates[0].candidateId) });
    t.after(world.close);
    const link = connect(world); t.after(() => link.close());
    const requests = [];
    const options = createTaskExecutionOptions({ apiUrl: 'https://offline.invalid', apiKey: 'offline-only', model: stream ? 'actual-stream-model' : 'actual-json-model',
        async fetch(url, request) {
            requests.push({ url, request }); const body = JSON.parse(request.body), packet = JSON.parse(body.messages[1].content);
            assert.equal(body.stream, false); assert.equal(body.messages.length, 2); assert.ok(!request.body.includes(spec().inputs.query));
            return { ok: true, text: async () => JSON.stringify({ model: 'returned-version', usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
                choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ schemaVersion: 1, taskId: packet.taskId,
                    observationId: packet.observationId, action: 'select', candidateId: 'c0' }) } }] }) };
        } });
    const ctx = { originalBody: { model: 'unresolved-alias', messages: [] }, abortController: new AbortController(),
        isToolResultError: result => result?.success === false, formatToolResult: result => JSON.stringify(result),
        pluginManager: { messagePreprocessors: new Map() }, toolExecutor: link.executor,
        ToolCallParser: { parse: text => text.includes('TOOL') ? [{ name: 'AndroidController', args: { command: 'RunTask', task: spec({ assistance: 'main_agent' }) } }] : [],
            separate: calls => ({ normal: calls, archery: [] }) },
        androidTaskExecutionOptions: () => options, apiRetries: 1, apiRetryDelay: 0, maxVCPLoopStream: 2, maxVCPLoopNonStream: 2,
        fetchWithRetry: async () => aiResponse('Done', stream) };
    const result = await new (stream ? StreamHandler : NonStreamHandler)(ctx).handle({}, httpResponse(), aiResponse('TOOL', stream));
    assert.equal(result.completed, true); assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].request.body).model, stream ? 'actual-stream-model' : 'actual-json-model');
    assert.deepEqual(world.actions.map(a => a.target), ['open', 'query', 'search_go']);
    const receipt = link.messages.find(m => m.type === 'tool_result').data.result;
    assert.equal(receipt.details.task.status, 'completed');
    assert.equal(receipt.details.task.counts.mainModelCalls, 1); assert.equal(receipt.details.task.counts.mainModelRequests, 1);
    const evidence = world.events.find(e => e.type === 'assistance' && e.assistance.phase === 'settled');
    assert.equal(evidence.modelEvidence.returnedModel, 'returned-version'); assert.equal(evidence.modelEvidence.usage.totalTokens, 30);
    assert.equal(link.messages.filter(m => m.type === 'android_task_replan').length, 1);
});

for (const generic of [false, true]) test(`cancel propagates upstream while task lease stays held until drain, generic=${generic}`, async t => {
    const world = generic ? await uiWorld({ decide: (_, q) => uiResponse(q, 'escalate') })
        : await searchWorld({ decide: (_, questions) => response(questions, 'escalate') }); t.after(world.close);
    const link = connect(world); t.after(() => link.close());
    const entered = deferred(), release = deferred(), controller = new AbortController(); let signal;
    const options = createTaskExecutionOptions({ apiUrl: 'https://offline.invalid', apiKey: 'offline-only', model: 'model', signal: controller.signal,
        async fetch(_url, request) { signal = request.signal; entered.resolve(); await release.promise; throw Error('late failure'); } });
    const execution = link.executor.execute({ name: 'AndroidController', args: { command: 'RunTask', task: (generic ? uiSpec : spec)({ assistance: 'main_agent' }) } }, null, [], options);
    try {
        await entered.promise; controller.abort(); await tick();
        assert.equal(signal.aborted, true);
        await assert.rejects(world.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
        assert.equal(link.messages.some(m => m.type === 'android_task_replan_result'), false);
    } finally { release.resolve(); await execution; await tick(); await tick(); }
    assert.equal((generic ? world.writes : world.actions).length, 0);
    assert.equal(link.messages.filter(m => m.type === 'android_task_replan_result').length, 1);
    assert.equal(world.events.at(-1).type, 'stopped');
});

test('generic task selects through both distributed peers and the originating main model', async t => {
    const world = await uiWorld({ decide: (s, q) => uiResponse(q, s.hostCompletionMatched ? 'Done' : 'escalate'),
        invoke(method, _p, state) { if (method === 'click') { state.page = 'results'; return true; } } }); t.after(world.close);
    const link = connect(world); t.after(() => link.close());
    let calls = 0;
    const options = createTaskExecutionOptions({ apiUrl: 'https://offline.invalid', apiKey: 'offline-only', model: 'actual-ui-main',
        fetch: async (_url, request) => {
            calls++; const body = JSON.parse(request.body), p = JSON.parse(body.messages[1].content);
            assert.equal(body.model, 'actual-ui-main'); assert.equal(p.intent, 'ui_task');
            return { ok: true, text: async () => JSON.stringify({ model: 'actual-ui-returned', choices: [{ finish_reason: 'stop',
                message: { content: JSON.stringify({ schemaVersion: 1, taskId: p.taskId, observationId: p.observationId,
                    action: 'select', candidateId: p.candidates[0].candidateId }) } }] }) };
        } });
    await link.executor.execute({ name: 'AndroidController', args: { command: 'RunTask', task: uiSpec({ assistance: 'main_agent' }) } }, null, [], options);
    const receipt = link.messages.find(m => m.type === 'tool_result').data.result.details.task;
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt)); assert.equal(calls, 1);
    assert.equal(world.writes.length, 1); assert.equal(receipt.counts.mainModelRequests, 1);
    assert.equal(link.messages.filter(m => m.type === 'android_task_replan').length, 1);
});
