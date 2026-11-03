'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const field = password => `
    <hierarchy rotation="0">
        <node class="android.widget.EditText" package="com.example"
            resource-id="com.example:id/editor" text="old" enabled="true"
            bounds="[0,0][100,40]" password="${password}"/>
    </hierarchy>`;
const fill = {
    command: 'Fill',
    id: 'com.example:id/editor',
    text: 'secret',
};
const enter = { command: 'KeyEvent', key: 'enter' };
const expect = { type: 'foreground', package: 'com.example' };
const enters = calls => calls.filter(([kind, args]) => (
    kind === 'adb' && args.includes('KEYCODE_ENTER')
));

function sequences(result, status, count) {
    for (const sequence of [result.details.sequence, result.details.execution.sequence]) {
        assert.equal(sequence.status, status);
        assert.equal(sequence.steps.length, count);
    }
}

for (const packageName of ['com.never', 'com.example']) {
    test(`password intermediate Fill stops before Enter: ${packageName}`, async () => {
        const h = await harness({ uiServer: { ok: true, xml: field(true) } });
        const result = await h.service.processToolCall({
            command: 'ExecuteStep',
            steps: [
                {
                    action: fill,
                    expect: { ...expect, package: packageName },
                    waitTimeoutMs: 10,
                },
                { action: enter },
            ],
        });
        assert.equal(enters(h.calls).length, 0);
        sequences(result, 'stopped', 1);
        assert.equal(result.details.sequence.steps[0].outcome, 'dispatched');
        assert.equal(result.details.sequence.steps[0].verification, null);
        assert.equal(h.calls.some(c => c[1] === 'getText'), false);
        assert.equal(JSON.stringify(result).includes('secret'), false);
    });
}

for (const expected of [undefined, expect, { ...expect, package: 'com.never' }]) {
    test(`password single Fill preserves null verification: ${expected?.package}`, async () => {
        const h = await harness({ uiServer: { ok: true, xml: field(true) } });
        const result = await h.service.processToolCall({
            command: 'ExecuteStep',
            action: fill,
            expect: expected,
        });
        assert.equal(result.details.execution.outcome, 'dispatched');
        assert.equal(result.details.execution.verification, null);
        assert.equal(h.calls.some(c => c[1] === 'getText'), false);
        assert.equal(JSON.stringify(result).includes('secret'), false);
    });
}

test('verified intermediate Fill advances and final dispatched Enter completes', async () => {
    const h = await harness({
        uiServer: { ok: true, xml: field(false), text: 'secret' },
    });
    const result = await h.service.processToolCall({
        command: 'ExecuteStep',
        steps: [{ action: fill, expect }, { action: enter }],
    });
    assert.equal(enters(h.calls).length, 1);
    sequences(result, 'completed', 2);
    assert.deepEqual(
        Array.from(result.details.sequence.steps, step => step.outcome),
        ['verified', 'dispatched'],
    );
});

test('verified prefix cannot authorize an unverified password intermediate step', async () => {
    const h = await harness({ uiServer: { ok: true, xml: field(true) } });
    const result = await h.service.processToolCall({
        command: 'ExecuteStep',
        steps: [
            { action: { command: 'KeyEvent', key: 'tab' }, expect },
            { action: fill, expect },
            { action: enter },
        ],
    });
    assert.equal(enters(h.calls).length, 0);
    sequences(result, 'stopped', 2);
});

test('single-item password sequence completes without readback', async () => {
    const h = await harness({ uiServer: { ok: true, xml: field(true) } });
    const result = await h.service.processToolCall({
        command: 'ExecuteStep',
        steps: [{ action: fill }],
    });
    sequences(result, 'completed', 1);
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(result.details.execution.verification, null);
});

test('final unknown still stops the sequence', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({
        command: 'ExecuteStep',
        steps: [{
            action: enter,
            expect: { ...expect, package: 'com.never' },
            waitTimeoutMs: 10,
        }],
    });
    sequences(result, 'stopped', 1);
    assert.equal(result.details.execution.outcome, 'unknown');
});