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
    test(`password intermediate Fill is blocked before Enter: ${packageName}`, async () => {
        const h = await harness({ uiServer: { ok: true, xml: field(true) } });
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', steps: [
            { action: fill, expect: { ...expect, package: packageName }, waitTimeoutMs: 10 },
            { action: enter },
        ] }), error => {
            assert.equal(error.code, 'POLICY_CONFIRMATION_REQUIRED');
            assert.equal(error.needsConfirmation, true);
            assert.equal(error.execution.sequence.status, 'stopped');
            assert.equal(error.execution.sequence.steps.length, 1);
            assert.equal(error.execution.sequence.steps[0].outcome, 'failed');
            assert.equal(JSON.stringify(error).includes('secret'), false);
            return true;
        });
        assert.equal(enters(h.calls).length, 0);
        assert.equal(h.calls.some(c => c[0] === 'rpc'), false);
    });
}

for (const expected of [undefined, expect, { ...expect, package: 'com.never' }]) {
    test(`password single Fill cannot be authorized by an outer expectation: ${expected?.package}`, async () => {
        const h = await harness({ uiServer: { ok: true, xml: field(true) } });
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action: fill, expect: expected }), error => {
            assert.equal(error.code, 'POLICY_CONFIRMATION_REQUIRED');
            assert.equal(error.execution.outcome, 'failed');
            assert.equal(error.execution.verification, null);
            assert.equal(JSON.stringify(error).includes('secret'), false);
            return true;
        });
        assert.equal(h.calls.some(c => c[0] === 'rpc'), false);
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

test('verified prefix cannot authorize a newly appearing password field', async () => {
    let protectedField = false;
    const h = await harness({ uiServer: { ok: true, xml: () => field(protectedField) },
        run(args) { if (args.includes('KEYCODE_TAB')) protectedField = true; } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', steps: [
        { action: { command: 'KeyEvent', key: 'tab' }, expect },
        { action: fill, expect },
        { action: enter },
    ] }), error => {
        assert.equal(error.code, 'POLICY_CONFIRMATION_REQUIRED');
        assert.equal(error.execution.sequence.status, 'stopped');
        assert.deepEqual(Array.from(error.execution.sequence.steps, step => step.outcome), ['verified', 'failed']);
        return true;
    });
    assert.equal(enters(h.calls).length, 0);
    assert.equal(h.calls.some(c => c[0] === 'rpc'), false);
});

test('single-item password sequence refuses without readback or input', async () => {
    const h = await harness({ uiServer: { ok: true, xml: field(true) } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', steps: [{ action: fill }] }), { code: 'POLICY_CONFIRMATION_REQUIRED' });
    assert.equal(h.calls.some(c => c[0] === 'rpc'), false);
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