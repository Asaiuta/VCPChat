'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./helpers/android-service-harness.cjs');

const fieldXml = '<hierarchy rotation="0"><node class="android.widget.EditText" '
    + 'package="com.example" resource-id="com.example:id/editor" text="old" '
    + 'enabled="true" bounds="[0,0][100,40]"/></hierarchy>';

for (const duration of [300, 5000]) {
    test(`long press RPC budget preserves duration allowance: ${duration}ms`, async () => {
        const h = await harness({ uiServer: { ok: true } });
        await h.service.processToolCall({
            command: 'ExecuteStep',
            action: {
                command: 'LongPress',
                id: 'com.example:id/go',
                duration,
            },
        });
        const call = h.calls.find(([channel, method]) => channel === 'rpc' && method === 'click');
        assert.ok(call, 'long press must use RPC');
        assert.equal(call[3].timeoutMs, Math.max(4000, duration + 1000));
    });
}

test('readback transport failure retains mutation dispatch and never falls back', async () => {
    const h = await harness({
        uiServer: {
            ok: true,
            xml: fieldXml,
            invoke(method) {
                if (method === 'getText') {
                    throw Object.assign(new Error('read unavailable'), {
                        code: 'UI_SERVER_RPC_FAILED', dispatched: false,
                    });
                }
                return true;
            },
        },
    });
    const result = await h.service.processToolCall({
        command: 'ExecuteStep',
        action: { command: 'Fill', id: 'com.example:id/editor', text: 'replacement' },
    });
    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.execution.verification.error, 'UI_SERVER_RPC_FAILED');
    assert.deepEqual(
        Array.from(result.details.attempts, ({ method, status }) => ({ method, status })),
        [
            { method: 'setText', status: 'dispatched' },
            { method: 'getText', status: 'not-dispatched' },
        ],
    );
    assert.equal(h.calls.some(([channel, args]) => channel === 'adb' && args.includes('input')), false);
});
