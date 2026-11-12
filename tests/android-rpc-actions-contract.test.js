'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const run = (h, action) => h.service.processToolCall({
    command: 'ExecuteStep',
    action
});

// 随包 APK 已确认：click(x,y,ms) 是原生长按；只有明确未执行才降级。
test('Tap 走 RPC 且参数是纯坐标', async () => {
    const h = await harness({ uiServer: { ok: true } });
    const result = await run(h, { command: 'Tap', id: 'com.example:id/go' });
    const rpc = h.calls.find(call => call[0] === 'rpc' && call[1] === 'click');

    assert.equal(rpc[2].length, 2, 'Tap 不传按压时长');
    assert.equal(result.details.channels[0], 'rpc');
});

test('LongPress 优先原生三参 click，毫秒不转 steps', async () => {
    const h = await harness({ uiServer: { ok: true } });
    const result = await run(h, { command: 'LongPress', id: 'com.example:id/go', duration: 803 });
    const rpc = h.calls.filter(call => call[0] === 'rpc');

    assert.equal(rpc.length, 1);
    assert.equal(rpc[0][1], 'click');
    assert.deepEqual(Array.from(rpc[0][2]), [50, 20, 803]);
    assert.deepEqual(Array.from(result.details.channels), ['rpc']);
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(h.calls.some(call => call[0] === 'adb' && call[1].includes('input')), false);
});

test('LongPress 原生明确未执行才降级同点 RPC swipe', async () => {
    const h = await harness({ uiServer: { ok: true, invoke(method) {
        if (method === 'click') throw Object.assign(new Error('unsupported overload'), {
            code: 'UI_SERVER_RPC_ERROR', dispatched: false,
        });
        return true;
    } } });
    const result = await run(h, { command: 'LongPress', id: 'com.example:id/go', duration: 805 });
    const rpc = h.calls.filter(call => call[0] === 'rpc');
    assert.deepEqual(rpc.map(call => call[1]), ['click', 'swipe']);
    assert.deepEqual(Array.from(rpc[1][2]), [50, 20, 50, 20, 161]);
    assert.deepEqual(Array.from(result.details.attempts, item => item.status), ['not-dispatched', 'dispatched']);
    assert.equal(h.calls.some(call => call[0] === 'adb' && call[1].includes('input')), false);
});

test('LongPress 两个 RPC 均未执行才降级一次 shell', async () => {
    const h = await harness({ uiServer: { ok: true, invoke() {
        throw Object.assign(new Error('unsupported'), { code: 'UI_SERVER_RPC_ERROR', dispatched: false });
    } } });
    const result = await run(h, { command: 'LongPress', id: 'com.example:id/go', duration: 805 });
    assert.deepEqual(Array.from(result.details.channels), ['rpc', 'rpc', 'shell']);
    const shell = h.calls.filter(call => call[0] === 'adb' && call[1].includes('input'));
    assert.equal(shell.length, 1);
    assert.deepEqual(Array.from(shell[0][1]), ['shell', 'input', 'swipe', '50', '20', '50', '20', '805']);
});

for (const failedMethod of ['click', 'swipe']) {
    for (const mode of ['timeout', 'disconnect', 'false', 'unclassified']) {
        test(`LongPress ${failedMethod} ${mode} 未知结果不重放`, async () => {
            const h = await harness({ uiServer: { ok: true, invoke(method) {
                if (method !== failedMethod) throw Object.assign(new Error('unsupported'), {
                    code: 'UI_SERVER_RPC_ERROR', dispatched: false,
                });
                if (mode === 'false') return false;
                throw Object.assign(new Error('private'), {
                    code: mode === 'timeout' ? 'UI_SERVER_TIMEOUT' : 'UI_SERVER_RPC_FAILED',
                    ...(mode === 'unclassified' ? {} : { dispatched: true }),
                });
            } } });
            await assert.rejects(run(h, { command: 'LongPress', id: 'com.example:id/go' }), error => {
                assert.equal(error.execution.outcome, 'unknown');
                assert.equal(error.execution.retryable, false);
                assert.equal(error.message.includes('private'), false);
                return true;
            });
            assert.deepEqual(h.calls.filter(call => call[0] === 'rpc').map(call => call[1]),
                failedMethod === 'click' ? ['click'] : ['click', 'swipe']);
            assert.equal(h.calls.some(call => call[0] === 'adb' && call[1].includes('input')), false);
        });
    }
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

test('Unicode 默认走 setClipboard + KEYCODE_PASTE，没有前置探针也不碰 pasteClipboard', async () => {
    const h = await harness({ uiServer: { ok: true } });
    const result = await run(h, { command: 'InputText', text: '秘密' });
    const calls = h.calls.filter(call => call[0] === 'rpc');

    // 真机上 getClipboard 是活的、pasteClipboard 是死的：拿 get 去“探” paste 会得出
    // 相反的结论，而直接试 paste 每次都要先牺牲一次。所以默认根本不碰它。
    assert.deepEqual(calls.map(call => call[1]), ['setClipboard']);
    assert.deepEqual(Array.from(calls[0][2]), ['AndroidController', '秘密']);
    assert.equal(result.details.clipboard, 'replaced');
    assert.equal(result.details.pasteStrategy, 'keyevent');
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(
        h.calls.some(call => call[0] === 'adb' && call[1].includes('279')),
        true,
        '默认粘贴原语必须是 KEYCODE_PASTE',
    );
    assert.equal(JSON.stringify(result).includes('秘密'), false);
});

test('CLIPBOARD_PASTE=rpc 时先试设备端 paste，被拒后不冒充可用', async () => {
    const h = await harness({ config: { CLIPBOARD_PASTE: 'rpc' }, uiServer: { ok: true } });
    const result = await run(h, { command: 'InputText', text: '秘密' });
    assert.deepEqual(
        h.calls.filter(call => call[0] === 'rpc').map(call => call[1]),
        ['setClipboard', 'pasteClipboard'],
    );
    assert.equal(result.details.pasteStrategy, 'rpc');
});

test('pasteClipboard 失败一次后，同世代内改走 KEYCODE_PASTE 而不再敲死通道', async () => {
    let failPaste = true;
    const h = await harness({
        config: { CLIPBOARD_PASTE: 'rpc' },
        uiServer: {
            ok: true,
            invoke: async method => {
                if (method === 'pasteClipboard' && failPaste) {
                    throw Object.assign(new Error('镜像失配'), {
                        code: 'UI_SERVER_RPC_ERROR', rpcCode: -32001,
                        dispatched: true, drained: true
                    });
                }
                return true;
            }
        }
    });

    // 第一次：撞上 AssertionError。已派发不许重试，回执必须是失败，不能自称可用。
    await assert.rejects(run(h, { command: 'InputText', text: '秘密' }));
    failPaste = false;

    const second = await run(h, { command: 'InputText', text: '秘密' });
    assert.equal(
        h.calls.filter(call => call[0] === 'rpc' && call[1] === 'pasteClipboard').length,
        1,
        '能力已判定不可用后，不得再次尝试同一条死通道',
    );
    assert.equal(second.details.pasteStrategy, 'keyevent');
    assert.equal(
        h.calls.some(call => call[0] === 'adb' && call[1].includes('279')),
        true,
        '改走 KEYCODE_PASTE',
    );
    // set 族不受 paste 判死影响：它们不是同一条命。
    assert.equal(
        h.calls.filter(call => call[0] === 'rpc' && call[1] === 'setClipboard').length,
        2,
        'setClipboard 不得被 paste 的结论连坐',
    );
});


test('CLIPBOARD_PASTE=off 时宁可失败也不发散入按键', async () => {
    const h = await harness({
        config: { CLIPBOARD_PASTE: 'off' },
        uiServer: {
            ok: true,
            invoke: async method => {
                if (method === 'pasteClipboard') {
                    throw Object.assign(new Error('镜像失配'), {
                        code: 'UI_SERVER_RPC_ERROR',
                        dispatched: false
                    });
                }
                return true;
            }
        }
    });

    // off：不粘贴。剪贴板已经被写过（副作用如实记账），但不得再发散入事件去赌一个粘贴。
    await assert.rejects(run(h, { command: 'InputText', text: '秘密' }));
    assert.equal(
        h.calls.some(call => call[0] === 'adb' && call[1].includes('279')),
        false,
        '关掉粘贴后不得悄悄按粘贴键',
    );
    assert.equal(
        h.calls.some(call => call[0] === 'rpc' && call[1] === 'pasteClipboard'),
        false,
        'off 是「不粘贴」，不是「再试一次 rpc」',
    );
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
        config: { CLIPBOARD_PASTE: 'rpc' },
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
