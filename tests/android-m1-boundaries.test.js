'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const field = extra => `<hierarchy><node class="android.widget.EditText" package="com.example" resource-id="com.example:id/editor" text="old" enabled="true" bounds="[0,0][100,40]" ${extra || ''}/></hierarchy>`;
const input = {
    command: 'ExecuteStep',
    action: {
        command: 'InputText',
        text: '机密文本',
        enter: true
    }
};
const fillRequest = text => ({
    command: 'ExecuteStep',
    action: {
        command: 'Fill',
        id: 'com.example:id/editor',
        text
    }
});

for (const boundary of ['abort', 'deadline']) {
    test(`pending RPC ${boundary} holds lease and never falls back or enters`, async () => {
        let release;
        let entered;
        const enteredRpc = new Promise(resolve => {
            entered = resolve;
        });
        const gate = new Promise(resolve => {
            release = resolve;
        });
        const controller = new AbortController();
        const h = await harness({
            uiServer: {
                ok: true,
                invoke: async (method, params, options) => {
                    entered(options);
                    return gate;
                }
            }
        });
        const work = h.service.processToolCall(
            { ...input, timeoutMs: boundary === 'deadline' ? 60 : 1000 },
            { signal: controller.signal }
        );
        const rejected = assert.rejects(work, error => {
            assert.equal(error.code, boundary === 'abort' ? 'STEP_ABORTED' : 'STEP_DEADLINE');
            assert.equal(error.execution.outcome, 'unknown');
            assert.ok(error.message.includes('channels'));
            assert.equal(error.message.includes('机密文本'), false);
            return true;
        });
        const options = await enteredRpc;

        assert.ok(options.signal);
        assert.ok(options.timeoutMs > 0);
        if (boundary === 'abort') {
            controller.abort();
        }
        await rejected;
        await assert.rejects(
            h.service.processToolCall({
                command: 'ExecuteStep',
                action: { command: 'KeyEvent', key: 'back' }
            }),
            { code: 'DEVICE_BUSY' }
        );
        assert.equal(options.signal.aborted, true);

        release(true);
        await tick();
        await tick();

        assert.deepEqual(
            h.calls.filter(call => call[0] === 'rpc').map(call => call[1]),
            ['setClipboard']
        );
        assert.equal(
            h.calls.some(call => call[0] === 'adb'
                && (call[1].includes('input') || call[1].includes('broadcast'))),
            false
        );
        await h.service.processToolCall({
            command: 'ExecuteStep',
            action: { command: 'KeyEvent', key: 'back' }
        });
    });
}

test('password Fill outer expect never verifies a secret value', async () => {
    const h = await harness({
        uiServer: { ok: true, xml: field('password="true"') }
    });
    const result = await h.service.processToolCall({
        ...fillRequest('private-secret'),
        expect: { type: 'foreground', package: 'com.example' }
    });

    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(h.calls.some(call => call[0] === 'rpc' && call[1] === 'getText'), false);
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
});

test('Fill rejects invalid fields before mutation', async () => {
    for (const attrs of [
        'enabled="false" bounds="[0,0][100,40]"',
        'enabled="true" bounds="[0,220][100,260]"'
    ]) {
        const xml = `<hierarchy><node class="android.widget.EditText" package="com.example" resource-id="com.example:id/editor" text="old" ${attrs}/></hierarchy>`;
        const h = await harness({ uiServer: { ok: true, xml } });

        await assert.rejects(
            h.service.processToolCall(fillRequest('new')),
            error => error.execution.outcome === 'failed'
        );
        assert.equal(h.calls.some(call => call[0] === 'rpc'), false);
    }

    const h = await harness({
        uiServer: {
            ok: true,
            xml: field().replace('android.widget.EditText', 'android.widget.Button')
        }
    });

    await assert.rejects(
        h.service.processToolCall(fillRequest('new')),
        error => error.code === 'INVALID_FILL_TARGET'
    );
    assert.equal(h.calls.some(call => call[0] === 'rpc'), false);
});

test('Fill index requires fresh snapshot and attaches refreshed raw identity', async () => {
    const h = await harness({ uiServer: { ok: true, xml: field(), text: 'new' } });
    const observed = await h.service.processToolCall({ command: 'Observe' });
    const index = observed.details.controls[0].index;

    for (const snapshotId of [undefined, 'wrong']) {
        await assert.rejects(
            h.service.processToolCall({
                command: 'ExecuteStep',
                action: { command: 'Fill', index, snapshotId, text: 'new' }
            }),
            error => ['SNAPSHOT_REQUIRED', 'STALE_SNAPSHOT'].includes(error.code)
        );
    }
    assert.equal(h.calls.some(call => call[0] === 'rpc'), false);

    const result = await h.service.processToolCall({
        command: 'ExecuteStep',
        action: {
            command: 'Fill',
            index,
            snapshotId: observed.details.snapshotId,
            text: 'new'
        }
    });
    assert.equal(result.details.execution.outcome, 'verified');
});

test('Fill rejects a raw duplicate identity even if only one field is visible', async () => {
    const xml = field().replace(
        '</hierarchy>',
        '<node class="android.widget.EditText" package="com.example" resource-id="com.example:id/editor" text="hidden" enabled="true" bounds="[0,220][100,260]"/></hierarchy>'
    );
    const h = await harness({ uiServer: { ok: true, xml } });

    await assert.rejects(
        h.service.processToolCall(fillRequest('new')),
        error => error.code === 'INVALID_FILL_TARGET' && error.execution.outcome === 'failed'
    );
    assert.equal(h.calls.some(call => call[0] === 'rpc'), false);
});

test('Fill readback failure stays unknown and redacts transport text', async () => {
    const h = await harness({
        uiServer: {
            ok: true,
            xml: field(),
            invoke: async method => {
                if (method === 'getText') {
                    throw Object.assign(new Error('private-secret'), {
                        code: 'UI_SERVER_TIMEOUT',
                        dispatched: true
                    });
                }
                return true;
            }
        }
    });
    const result = await h.service.processToolCall({
        ...fillRequest('private-secret'),
        expect: { type: 'foreground', package: 'com.example' }
    });

    assert.equal(result.details.execution.outcome, 'unknown');
    assert.equal(result.details.execution.verification.matched, false);
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
});

test('Scroll converts milliseconds to u2 steps and never shells after RPC success', async () => {
    const xml = '<hierarchy><node class="android.widget.ScrollView" package="com.example" resource-id="com.example:id/list" scrollable="true" enabled="true" bounds="[0,0][100,180]"/></hierarchy>';
    const h = await harness({ uiServer: { ok: true, xml } });

    await h.service.processToolCall({
        command: 'ExecuteStep',
        action: {
            command: 'Scroll',
            id: 'com.example:id/list',
            direction: 'down',
            duration: 305
        }
    });
    const calls = h.calls.filter(call => call[0] === 'rpc');

    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'swipe');
    assert.equal(calls[0][2][4], 61);
    assert.ok(calls[0][2][1] > calls[0][2][3]);
    assert.equal(
        h.calls.some(call => call[0] === 'adb' && call[1].includes('input')),
        false
    );
});

test('clipboard write then paste rejection and unavailable IME retains unknown side effect receipt', async () => {
    const h = await harness({
        uiServer: {
            ok: true,
            invoke: async method => {
                if (method === 'pasteClipboard') {
                    throw Object.assign(new Error('private-secret'), {
                        code: 'UI_SERVER_RPC_ERROR',
                        dispatched: false
                    });
                }
                return true;
            }
        }
    });

    await assert.rejects(h.service.processToolCall(input), error => {
        assert.equal(error.code, 'ADB_KEYBOARD_NOT_ACTIVE');
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(error.details.clipboard, 'replaced');
        assert.equal(error.message.includes('机密文本'), false);
        assert.equal(error.message.includes('private-secret'), false);
        assert.ok(error.message.includes('replaced'));
        return true;
    });
    assert.deepEqual(
        h.calls.filter(call => call[0] === 'rpc').map(call => call[1]),
        ['setClipboard', 'pasteClipboard']
    );
    assert.equal(
        h.calls.some(call => call[0] === 'adb'
            && (call[1].includes('broadcast')
                || call[1].includes('KEYCODE_ENTER')
                || call[1].includes('set'))),
        false
    );
});
