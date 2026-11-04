'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const tree = (attrs = '') => `<hierarchy rotation="0"><node class="android.widget.Button" package="com.example" resource-id="com.example:id/go" text="Go" clickable="true" bounds="[0,0][100,40]" ${attrs}/></hierarchy>`;
const execute = (h, value) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', ...value });
const writes = h => h.calls.filter(call => call[0] === 'adb' && call[1].includes('input'));

for (const attr of ['visible-to-user="false"', 'displayed="false"']) test(`public visible assertion rejects ${attr} and action remains blocked`, async () => {
    const h = await harness({ dump: () => tree(attr) });
    try {
        const result = await execute(h, { action: { command: 'Wait' }, expect: { type: 'visible', selector: 'text=Go' }, waitTimeoutMs: 5 });
        assert.equal(result.details.execution.outcome, 'unknown');
        await assert.rejects(execute(h, { action: { command: 'Tap', selector: 'text=Go' } }), { code: 'TARGET_NOT_UNIQUE' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('disabled remains present for assertions but absent cannot unblock the next sequence action', async () => {
    const h = await harness({ dump: () => tree('enabled="false"') });
    try {
        const present = await execute(h, { action: { command: 'Wait' }, expect: { type: 'visible', selector: 'text=Go' }, waitTimeoutMs: 1000 });
        assert.equal(present.details.execution.outcome, 'verified');
        const absent = await execute(h, { steps: [
            { action: { command: 'Wait' }, expect: { type: 'absent', selector: 'text=Go' }, waitTimeoutMs: 5 },
            { action: { command: 'Tap', id: 'com.example:id/go' } },
        ] });
        assert.equal(absent.details.execution.outcome, 'unknown');
        assert.equal(writes(h).length, 0);
        await assert.rejects(execute(h, { action: { command: 'Tap', selector: 'text=Go' } }), { code: 'TARGET_NOT_UNIQUE' });
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});

test('long text suffix is visible evidence, never false absence after display truncation', async () => {
    const full = 'A'.repeat(120) + 'TAIL';
    const h = await harness({ dump: () => tree().replace('text="Go"', `text="${full}"`) });
    try {
        for (const selector of [{ text: full }, { contains: 'TAIL' }, { regex: 'TAIL$' }]) {
            const visible = await execute(h, { action: { command: 'Wait' }, expect: { type: 'visible', selector }, waitTimeoutMs: 1000 });
            assert.equal(visible.details.execution.outcome, 'verified');
            const absent = await execute(h, { action: { command: 'Wait' }, expect: { type: 'absent', selector }, waitTimeoutMs: 5 });
            assert.equal(absent.details.execution.outcome, 'unknown');
        }
        assert.equal(writes(h).length, 0);
    } finally { await h.service.cleanup(); }
});
