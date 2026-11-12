'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const field = '<hierarchy rotation="0"><node class="android.widget.EditText" package="com.example" resource-id="com.example:id/editor" text="old" enabled="true" bounds="[0,0][100,40]" /></hierarchy>';

for (const [expected, actual] of [['', null], ['17', 17], ['text', ' text '], [' text ', 'text'], ['', '\t'], ['', '\r\n']]) {
    test(`Fill does not normalize a different or invalid value into verified: ${JSON.stringify([expected, actual])}`, async () => {
        let reads = 0;
        const h = await harness({ uiServer: { ok: true, xml: field, invoke(method) {
            if (method !== 'getText') return true;
            if (++reads === 1) return actual;
            throw Object.assign(new Error('read unavailable'), { code: 'UI_SERVER_NOT_READY', dispatched: false });
        } } });
        try {
            const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
                action: { command: 'Fill', id: 'com.example:id/editor', text: expected },
                expect: { type: 'foreground', package: 'com.example' } });
            assert.equal(result.details.execution.outcome, 'unknown');
            assert.equal(result.details.fillVerified, false);
            assert.equal(h.calls.filter(call => call[0] === 'rpc' && ['setText', 'clearTextField'].includes(call[1])).length, 1);
        } finally { await h.service.cleanup(); }
    });
}

for (const value of [' text ', '\t', '\r\n']) {
    test(`Fill preserves exact requested whitespace: ${JSON.stringify(value)}`, async () => {
        const h = await harness({ uiServer: { ok: true, xml: field, text: value } });
        try {
            const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
                action: { command: 'Fill', id: 'com.example:id/editor', text: value } });
            assert.equal(result.details.execution.outcome, 'verified');
        } finally { await h.service.cleanup(); }
    });
}

test('reused UI evidence retains acquisition provenance instead of relabeling an old tree with a new foreground', async () => {
    let focusReads = 0;
    const h = await harness({ client: { async currentFocus() {
        focusReads++;
        return { package: 'com.other', component: 'com.other/.Later' };
    } } });
    try {
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
            action: { command: 'KeyEvent', key: 'back' }, expect: { type: 'visible', selector: 'text=Go' }, afterObserve: true });
        const observation = result.details.observation;
        assert.equal(result.details.execution.outcome, 'verified');
        assert.equal(observation.focus.package, observation.controls[0].package);
        assert.equal(observation.focus.component ?? null, null, 'tree evidence does not establish a component');
        assert.equal(h.dumpCount, 2, '一次policy gate加一次验证；afterObserve复用验证样本，不再采树');
        assert.equal(focusReads, 0, 'do not graft a later foreground onto earlier evidence');
        assert.ok(observation.observedAt <= Date.now());
    } finally { await h.service.cleanup(); }
});



test('idle plus foreground expectation keeps the successful idle sample for afterObserve', async () => {
    const h = await harness({ client: { async probeScreen() {
        return { wakefulness: 'Awake', rotation: 0, displayId: 0,
            keyguard: { showing: false, inputRestricted: false },
            focus: { package: 'com.example', component: 'com.example/.Main', window: 'Window{test u0 com.example/.Main}' },
            size: { width: 100, height: 200 } };
    } }, uiServer: { ok: true } });
    try {
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
            action: { command: 'Wait', mode: 'idle' }, expect: { type: 'foreground', package: 'com.example' },
            waitTimeoutMs: 1500, afterObserve: true });
        assert.equal(result.details.execution.outcome, 'verified');
        assert.equal(result.details.observation.focus.component, 'com.example/.Main');
        assert.equal(h.uiServer.dumped, 2, 'foreground verification must not discard the successful idle sample');
    } finally { await h.service.cleanup(); }
});