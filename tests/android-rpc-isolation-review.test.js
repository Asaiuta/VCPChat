'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const observe = (h, serial = 'A') => h.service.processToolCall({ command: 'Observe', serial });
const tap = h => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', id: 'com.example:id/go' } });
const fault = (code, details = {}) => Object.assign(new Error('private transport payload'), { code, dispatched: true, ...details });
const unknownCodes = ['UI_SERVER_TIMEOUT', 'UI_SERVER_ABORTED', 'UI_SERVER_RPC_FAILED', 'UI_SERVER_BAD_JSON', 'UI_SERVER_BAD_RESPONSE', 'UI_SERVER_RESPONSE_TOO_LARGE', 'UI_SERVER_HTTP_ERROR'];

async function assertIsolated(h) {
    const calls = h.calls.length;
    const dumps = h.uiServer.dumped;
    const starts = h.uiServer.started;
    for (const args of [
        { command: 'Observe', serial: 'A' },
        { command: 'ExecuteStep', serial: 'A', action: { command: 'KeyEvent', key: 'back' } },
        { command: 'Manage', operation: 'reconnect', serial: 'A' },
    ]) await assert.rejects(h.service.processToolCall(args), { code: 'DEVICE_STATE_UNCERTAIN' });
    assert.equal(h.calls.length, calls);
    assert.equal(h.uiServer.dumped, dumps);
    assert.equal(h.uiServer.started, starts);
    await h.service.processToolCall({ command: 'Manage', operation: 'displayStatus' });
}

for (const code of unknownCodes) {
    test(`ordinary Observe ${code} stops without CLI fallback and isolates future device operations`, async () => {
        const h = await harness({ uiServer: { ok: true, xml() { throw fault(code); } } });
        try {
            await assert.rejects(observe(h), { code });
            assert.equal(h.dumpCount, 0);
            assert.equal(h.uiServer.dumped, 1);
            assert.equal(h.uiServer.stopped, 0, 'do not restart an owner whose remote request is unresolved');
            await assertIsolated(h);
        } finally { await h.service.cleanup(); }
    });
    test(`write RPC ${code} is not replayed and isolates subsequent requests`, async () => {
        const h = await harness({ uiServer: { ok: true, invoke() { throw fault(code); } } });
        try {
            await assert.rejects(tap(h), error => error.code === code && error.execution.outcome === 'unknown' && !error.message.includes('private'));
            assert.equal(h.calls.filter(call => call[0] === 'rpc').length, 1);
            assert.equal(h.calls.some(call => call[0] === 'adb' && call[1].includes('input')), false);
            await assertIsolated(h);
        } finally { await h.service.cleanup(); }
    });
}

const field = '<hierarchy><node class="android.widget.EditText" package="com.example" resource-id="com.example:id/editor" text="old" enabled="true" bounds="[0,0][100,40]"/></hierarchy>';
test('Fill readback transport unknown blocks same-call afterObserve and later calls', async () => {
    const h = await harness({ uiServer: { ok: true, xml: field, invoke(method) {
        if (method === 'getText') throw fault('UI_SERVER_RPC_FAILED');
        return true;
    } } });
    try {
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
            action: { command: 'Fill', id: 'com.example:id/editor', text: 'replacement' }, afterObserve: true });
        assert.equal(result.details.execution.outcome, 'unknown');
        assert.equal(result.details.observation.status, 'failed');
        assert.equal(result.details.attempts.find(attempt => attempt.method === 'getText').status, 'unknown');
        assert.equal(h.uiServer.dumped, 1, 'no observation request after uncertain readback');
        assert.equal(h.calls.filter(call => call[0] === 'rpc' && call[1] === 'getText').length, 1);
        await assertIsolated(h);
    } finally { await h.service.cleanup(); }
});

for (const details of [{ dispatched: false }, { drained: true }]) {
    test(`known settled ordinary read failure preserves CLI fallback ${JSON.stringify(details)}`, async () => {
        const h = await harness({ uiServer: { ok: true, xml() { throw fault('UI_SERVER_TIMEOUT', details); } } });
        try {
            assert.equal((await observe(h)).details.execution.outcome, 'observed');
            assert.equal(h.dumpCount, 1);
            assert.equal((await observe(h)).details.execution.outcome, 'observed');
        } finally { await h.service.cleanup(); }
    });
}

for (const outcome of ['false-result', 'device-error']) {
    test(`completed write ${outcome} remains unknown but does not quarantine a drained device`, async () => {
        const h = await harness({ uiServer: { ok: true, invoke() {
            if (outcome === 'false-result') return false;
            throw fault('UI_SERVER_RPC_ERROR', { rpcCode: -32001, drained: true });
        } } });
        try {
            await assert.rejects(tap(h), error => error.execution.outcome === 'unknown');
            assert.equal((await observe(h)).details.execution.outcome, 'observed');
            assert.equal(h.calls.filter(call => call[0] === 'rpc').length, 1);
        } finally { await h.service.cleanup(); }
    });
}

test('unclassified exception after invocation is conservative, not a new fallback permission', async () => {
    const h = await harness({ uiServer: { ok: true, invoke() { throw new Error('private transport payload'); } } });
    try { await assert.rejects(tap(h)); await assertIsolated(h); }
    finally { await h.service.cleanup(); }
});

test('one uncertain device does not quarantine another explicitly selected device', async () => {
    let first = true;
    const h = await harness({ uiServer: { ok: true, invoke() {
        if (first) { first = false; throw fault('UI_SERVER_TIMEOUT'); }
        return true;
    } } });
    try { await assert.rejects(tap(h)); assert.equal((await observe(h, 'B')).details.execution.serial, 'B'); await assertIsolated(h); }
    finally { await h.service.cleanup(); }
});


test('action targeting cannot turn an uncertain dump into CLI evidence and dispatch input', async () => {
    const h = await harness({ uiServer: { ok: true, xml() { throw fault('UI_SERVER_TIMEOUT'); } } });
    try {
        await assert.rejects(tap(h), error => error.code === 'UI_SERVER_TIMEOUT' && error.execution.outcome === 'failed');
        assert.equal(h.dumpCount, 0);
        assert.equal(h.calls.some(call => call[0] === 'rpc' || (call[0] === 'adb' && call[1].includes('input'))), false);
        await assertIsolated(h);
    } finally { await h.service.cleanup(); }
});

test('stable Observe does not swallow uncertain second dump and start a screenshot', async () => {
    let captures = 0;
    const h = await harness({ uiServer: { ok: true, xml(index) {
        if (index === 2) throw fault('UI_SERVER_RPC_FAILED');
        return field;
    } }, frames: { async captureOneShot() { captures++; return {}; } } });
    try {
        await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A', stable: true, screenshot: true }), { code: 'UI_SERVER_RPC_FAILED' });
        assert.equal(captures, 0);
        assert.equal(h.dumpCount, 0);
        assert.equal(h.uiServer.dumped, 2);
        await assertIsolated(h);
    } finally { await h.service.cleanup(); }
});

for (const command of ['Tap', 'LongPress']) test(`${command} definitely unexecuted RPC can still use shell without quarantine`, async () => {
    const h = await harness({ uiServer: { ok: true, invoke() {
        throw fault('UI_SERVER_RPC_ERROR', { rpcCode: -32601, dispatched: false, drained: true });
    } } });
    try {
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command, id: 'com.example:id/go' } });
        assert.equal(result.details.execution.outcome, 'dispatched');
        assert.equal(h.calls.filter(call => call[0] === 'adb' && call[1].includes('input')).length, 1);
        assert.equal((await observe(h)).details.execution.outcome, 'observed');
    } finally { await h.service.cleanup(); }
});

test('trusted abort of an in-flight RPC keeps isolation after the local step drains', async () => {
    const controller = new AbortController();
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const h = await harness({ uiServer: { ok: true, invoke(method, params, request) {
        entered();
        return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(fault('UI_SERVER_ABORTED')), { once: true }));
    } } });
    try {
        const pending = h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', id: 'com.example:id/go' } }, { signal: controller.signal });
        const rejection = assert.rejects(pending, { code: 'STEP_ABORTED' });
        await started;
        controller.abort();
        await rejection;
        await new Promise(resolve => setImmediate(resolve));
        await assertIsolated(h);
    } finally { await h.service.cleanup(); }
});


for (const code of ['STEP_ABORTED', 'STEP_DEADLINE']) test(`post-response ${code} retains drain evidence in the RPC error wrapper`, async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const entry = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
    const realRequire = createRequire(entry);
    const runtime = realRequire('./lib/step-runtime');
    let completed = false;
    const module = { exports: {} };
    // Expose lexical bindings only in this VM; the production function body is unchanged.
    vm.runInNewContext(fs.readFileSync(entry, 'utf8') + '\nmodule.exports.review = { rpcAction, uiServers };', {
        module, exports: module.exports, console, Buffer, process, Date, setTimeout, clearTimeout, AbortController,
        require(name) {
            return name === './lib/step-runtime' ? { ...runtime, check() {
                if (completed) throw runtime.failure(code, 'post-response boundary');
            } } : realRequire(name);
        },
    }, { filename: entry });
    const { rpcAction, uiServers } = module.exports.review;
    let calls = 0;
    uiServers.set('A', { async start() { return { ok: true }; }, async invoke() { calls++; completed = true; return true; } });
    await assert.rejects(rpcAction('A', 'click', [1, 2], [], 'write'), error => {
        assert.equal(error.code, code);
        assert.equal(error.dispatched, true);
        assert.equal(error.drained, true, 'a later step cancellation cannot erase a completed response');
        return true;
    });
    assert.equal(calls, 1);
});
