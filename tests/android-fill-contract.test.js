'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const field = (extra = '') => `<hierarchy rotation="0"><node class="android.widget.EditText" package="com.example" resource-id="com.example:id/editor" text="old" enabled="true" bounds="[0,0][100,40]" ${extra}/></hierarchy>`;
const fill = (h, text) => h.service.processToolCall({
    command: 'ExecuteStep',
    action: {
        command: 'Fill',
        id: 'com.example:id/editor',
        text
    }
});

for (const text of ['new', '']) {
    test(`Fill replaces and verifies ${JSON.stringify(text)}`, async () => {
        const h = await harness({
            uiServer: { ok: true, xml: field(), text }
        });
        const result = await fill(h, text);
        const rpc = h.calls.filter(call => call[0] === 'rpc');

        assert.equal(result.details.execution.outcome, 'verified');
        assert.deepEqual(rpc.map(call => call[1]), [
            text ? 'setText' : 'clearTextField',
            'getText'
        ]);
        if (text) {
            assert.equal(rpc[0][2][1], text);
        }
        assert.equal(rpc[0][2][0].className, 'android.widget.EditText');
        assert.equal(rpc[0][2][0].mask, 16 | 524288 | 2097152 | 16777216);
        assert.equal('text' in rpc[0][2][0], false);
    });
}

test('Fill mismatch cannot be washed green by outer expect', async () => {
    const h = await harness({
        uiServer: { ok: true, xml: field(), text: 'wrong' }
    });
    const result = await h.service.processToolCall({
        command: 'ExecuteStep',
        action: {
            command: 'Fill',
            id: 'com.example:id/editor',
            text: 'secret'
        },
        expect: { type: 'foreground', package: 'com.example' }
    });

    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('password does not read back or echo', async () => {
    const h = await harness({
        uiServer: { ok: true, xml: field('password="true"') }
    });
    const result = await fill(h, 'secret');

    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(h.calls.some(call => call[1] === 'getText'), false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('Fill refuses shell fallback', async () => {
    const h = await harness({ dump: () => field() });

    await assert.rejects(fill(h, 'secret'), error => error.execution.outcome === 'failed');
    assert.equal(
        h.calls.some(call => call[0] === 'adb' && call[1].includes('input')),
        false
    );
});
