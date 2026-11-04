'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const input = h => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'InputText', text: '文本' } });
for (const dispatched of [false, true]) test(`setClipboard failure does not disable pasteClipboard (dispatched=${dispatched})`, async t => {
    let fail = true;
    const h = await harness({ config: { CLIPBOARD_PASTE: 'rpc' }, uiServer: { ok: true, invoke(method) {
        if (method === 'setClipboard' && fail) throw Object.assign(new Error('private'), {
            code: 'UI_SERVER_RPC_ERROR', rpcCode: -32001, dispatched, drained: true,
        });
        return true;
    } } });
    t.after(() => h.service.cleanup());
    await assert.rejects(input(h));
    assert.equal(h.calls.filter(call => call[0] === 'rpc' && call[1] === 'pasteClipboard').length, 0);
    fail = false;
    const result = await input(h);
    assert.equal(result.details.pasteStrategy, 'rpc');
    assert.equal(h.calls.filter(call => call[0] === 'rpc' && call[1] === 'pasteClipboard').length, 1);
    assert.equal(h.calls.some(call => call[0] === 'adb' && call[1].includes('279')), false);
});
test('completed paste rejection changes the next request, never retries the current write', async t => {
    const h = await harness({ config: { CLIPBOARD_PASTE: 'rpc' }, uiServer: { ok: true, invoke(method) {
        if (method === 'pasteClipboard') throw Object.assign(new Error('private'), {
            code: 'UI_SERVER_RPC_ERROR', rpcCode: -32001, dispatched: true, drained: true,
        });
        return true;
    } } });
    t.after(() => h.service.cleanup());
    await assert.rejects(input(h), error => error.execution.outcome === 'unknown');
    assert.equal(h.calls.some(call => call[0] === 'adb' && call[1].includes('279')), false);
    assert.equal((await input(h)).details.pasteStrategy, 'keyevent');
    assert.equal(h.calls.filter(call => call[0] === 'rpc' && call[1] === 'pasteClipboard').length, 1);
});
