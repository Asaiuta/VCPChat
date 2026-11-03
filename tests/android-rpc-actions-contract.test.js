'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const run = (h, action) => h.service.processToolCall({
    command: 'ExecuteStep',
    action
});

for (const [command, method, params] of [
    ['Tap', 'click', [50, 20]],
    ['LongPress', 'click', [50, 20, 800]]
]) {
    test(command + ' RPC first', async () => {
        const h = await harness({ uiServer: { ok: true } });
        const result = await run(h, { command, id: 'com.example:id/go' });
        const rpc = h.calls.find(call => call[0] === 'rpc');

        assert.equal(rpc[1], method);
        assert.deepEqual(Array.from(rpc[2]), params);
        assert.equal(result.details.channels[0], 'rpc');
    });
}

for (const dispatched of [false, true]) {
    test('RPC rejection fallback dispatched=' + dispatched, async () => {
        const h = await harness({
            uiServer: {
                ok: true,
                invoke() {
                    throw Object.assign(new Error('private'), {
                        code: 'UI_SERVER_RPC_ERROR',
                        dispatched
                    });
                }
            }
        });

        if (dispatched) {
            await assert.rejects(
                run(h, { command: 'Tap', id: 'com.example:id/go' }),
                error => error.execution.outcome === 'unknown'
                    && !error.message.includes('private')
            );
        } else {
            const result = await run(h, { command: 'Tap', id: 'com.example:id/go' });
            assert.deepEqual(Array.from(result.details.channels), ['rpc', 'shell']);
        }

        assert.equal(
            h.calls.some(call => call[0] === 'adb' && call[1].includes('tap')),
            !dispatched
        );
    });
}

test('Unicode clipboard inserts without IME and records side effect', async () => {
    const h = await harness({ uiServer: { ok: true } });
    const result = await run(h, { command: 'InputText', text: '秘密' });
    const calls = h.calls.filter(call => call[0] === 'rpc');

    assert.deepEqual(calls.map(call => call[1]), ['setClipboard', 'pasteClipboard']);
    assert.deepEqual(Array.from(calls[0][2]), ['AndroidController', '秘密']);
    assert.equal(result.details.clipboard, 'replaced');
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(JSON.stringify(result).includes('秘密'), false);
});

test('shell fallback failure retains ordered channels', async () => {
    const h = await harness({
        run(args) {
            if (args.includes('tap')) {
                throw Object.assign(new Error('private'), { code: 'SHELL_FAILED' });
            }
        }
    });

    await assert.rejects(
        run(h, { command: 'Tap', id: 'com.example:id/go' }),
        error => {
            assert.deepEqual(Array.from(error.details.channels), ['rpc', 'shell']);
            assert.equal(error.details.attempts.at(-1).code, 'SHELL_FAILED');
            assert.equal(error.execution.outcome, 'unknown');
            return true;
        }
    );
});

test('unknown paste never broadcasts', async () => {
    const h = await harness({
        uiServer: {
            ok: true,
            invoke(method) {
                if (method === 'pasteClipboard') {
                    throw Object.assign(new Error('秘密'), {
                        code: 'UI_SERVER_TIMEOUT',
                        dispatched: true
                    });
                }
                return true;
            }
        }
    });

    await assert.rejects(
        run(h, { command: 'InputText', text: '秘密' }),
        error => error.execution.outcome === 'unknown' && !error.message.includes('秘密')
    );
    assert.equal(
        h.calls.some(call => call[0] === 'adb' && call[1].includes('ADB_INPUT_B64')),
        false
    );
});
