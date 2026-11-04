'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const ID = 'com.example:id/editor';
const tick = () => new Promise(resolve => setImmediate(resolve));
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
const xml = (text = 'abc', extra = '', id = ID) => '<hierarchy rotation="0">'
    + `<node class="android.widget.EditText" package="com.example" resource-id="${id}" text="${text}" enabled="true" focused="true" bounds="[0,0][100,40]" ${extra}/>`
    + '</hierarchy>';
const rpc = h => h.calls.filter(call => call[0] === 'rpc');
const keys = h => rpc(h).filter(call => call[1] === 'pressKeyCode');
const shellInputs = h => h.calls.filter(call => call[0] === 'adb' && call[1].includes('input'));
const execute = (h, action, extra = {}, context = {}) => h.service.processToolCall({ command: 'ExecuteStep', action, ...extra }, context);
const erase = (h, count = 3, extra = {}, context = {}) => execute(h, { command: 'EraseText', id: ID, count }, extra, context);

async function editor(options = {}) {
    const state = { value: options.value ?? 'abc', writes: 0, reads: 0 };
    const spec = { ok: true, xml: options.xml ?? xml(state.value) };
    spec.invoke = async (method, params, request) => {
        if (method === 'getText') {
            state.reads += 1;
            if (options.read) return options.read(state, spec, request);
            return state.value;
        }
        state.writes += 1;
        if (options.write) return options.write(state, spec, params, request);
        state.value = Array.from(state.value).slice(0, -1).join('');
        spec.xml = xml(state.value);
        return true;
    };
    return { ...(await harness({ uiServer: spec, foreground: options.foreground })), state, spec };
}

for (const [imeAction, metaState, expected] of [
    ['enter', undefined, [66]], ['search', undefined, [84]], ['enter', 0, [66, 0]], ['search', 0x1001, [84, 0x1001]],
]) {
    test(`ImeAction ${imeAction}/${metaState}只显式映射RPC按键，不证明提交`, async () => {
        const h = await harness({ uiServer: { ok: true } });
        const result = await execute(h, { command: 'ImeAction', imeAction, ...(metaState === undefined ? {} : { metaState }) });
        assert.deepEqual(keys(h).map(call => Array.from(call[2])), [expected]);
        assert.equal(result.details.execution.outcome, 'dispatched');
        assert.equal(result.details.execution.verification, null);
        assert.equal(shellInputs(h).length, 0);
        assert.match(result.content[0].text, /不证明/);
    });
}

for (const imeAction of ['done', 'go', 'send', 'ENTER', 'toString', '', null, 66]) {
    test(`ImeAction拒绝非显式映射 ${String(imeAction)}`, async () => {
        const h = await harness({ uiServer: { ok: true } });
        await assert.rejects(execute(h, { command: 'ImeAction', imeAction }), { code: 'INVALID_ARGUMENT' });
        assert.equal(rpc(h).length, 0);
    });
}

test('KeyCombo双参透传metaState，组合键本身不verified', async () => {
    const h = await harness({ uiServer: { ok: true } });
    const result = await execute(h, { command: 'KeyCombo', keyCode: 29, metaState: 0x7001 });
    assert.deepEqual(Array.from(keys(h)[0][2]), [29, 0x7001]);
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(result.details.execution.verification, null);
});

for (const keyCode of [0, 3, 4, 26, 64, 65, 164, 279, 288, -1, 29.5, '29', Number.MAX_SAFE_INTEGER]) {
    test(`KeyCombo拒绝非文本导航安全keycode ${keyCode}`, async () => {
        const h = await harness({ uiServer: { ok: true } });
        await assert.rejects(execute(h, { command: 'KeyCombo', keyCode, metaState: 0 }), { code: 'INVALID_ARGUMENT' });
        assert.equal(keys(h).length, 0);
    });
}

for (const metaState of [undefined, -1, 1.5, '4096', 0x100, 0x800, 0x8000, 0x80000000, 0x100000001, Number.MAX_SAFE_INTEGER, NaN]) {
    test(`KeyCombo拒绝不安全metaState ${metaState}`, async () => {
        const h = await harness({ uiServer: { ok: true } });
        await assert.rejects(execute(h, { command: 'KeyCombo', keyCode: 29, metaState }), { code: 'INVALID_ARGUMENT' });
        assert.equal(keys(h).length, 0);
    });
}

for (const metaState of [-1, 0x100, 0x100000001, '0']) {
    test(`ImeAction也校验metaState ${metaState}`, async () => {
        const h = await harness({ uiServer: { ok: true } });
        await assert.rejects(execute(h, { command: 'ImeAction', imeAction: 'enter', metaState }), { code: 'INVALID_ARGUMENT' });
        assert.equal(keys(h).length, 0);
    });
}

for (const command of ['ImeAction', 'KeyCombo']) {
    for (const mode of ['false', 'timeout', 'local']) {
        test(`${command} ${mode}不shell回退，不重发`, async () => {
            const h = await harness({ uiServer: { ok: true, invoke() {
                if (mode === 'false') return false;
                throw Object.assign(new Error('private-body'), { code: mode === 'local' ? 'UI_SERVER_INVALID_ARGUMENT' : 'UI_SERVER_TIMEOUT', dispatched: mode !== 'local' });
            } } });
            const action = command === 'ImeAction' ? { command, imeAction: 'enter' } : { command, keyCode: 29, metaState: 0x1000 };
            await assert.rejects(execute(h, action), error => {
                assert.equal(error.execution.outcome, mode === 'local' ? 'failed' : 'unknown');
                assert.equal(error.execution.retryable, false);
                assert.equal(error.details.attempts.length, 1);
                assert.equal(error.details.attempts[0].status, mode === 'local' ? 'not-dispatched' : 'unknown');
                assert.doesNotMatch(error.message, /private-body/);
                return true;
            });
            assert.equal(keys(h).length, 1);
            assert.equal(shellInputs(h).length, 0);
        });
    }
}

test('EraseText最多count次DEL，逐击读回且到空立即停止', async () => {
    const h = await editor();
    const result = await erase(h, 100);
    assert.equal(h.state.value, '');
    assert.equal(keys(h).length, 3);
    assert.ok(keys(h).every(call => JSON.stringify(Array.from(call[2])) === '[67]'));
    assert.deepEqual(rpc(h).map(call => call[1]), ['getText', 'pressKeyCode', 'getText', 'getText', 'pressKeyCode', 'getText', 'getText', 'pressKeyCode', 'getText']);
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(result.details.keyboard.keyEvents, 3);
    assert.equal(shellInputs(h).length, 0);
});

test('EraseText硬上限100次且所有击使用同signal和递减预算', async () => {
    const h = await editor({ value: 'x'.repeat(110) });
    await erase(h, 100);
    assert.equal(keys(h).length, 100);
    assert.equal(h.state.value.length, 10);
    assert.equal(new Set(rpc(h).map(call => call[3].signal)).size, 1);
    assert.ok(rpc(h).every(call => call[3].timeoutMs > 0 && call[3].timeoutMs <= 4000));
});

test('EraseText选择区未知时只承诺按键数，一击删空不再补DEL', async () => {
    const h = await editor({ write(state, spec) { state.value = ''; spec.xml = xml(''); return true; } });
    const result = await erase(h, 100);
    assert.equal(keys(h).length, 1);
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(result.details.execution.verification, null);
});

test('EraseText不归一化空白，单个空格也能删除', async () => {
    const h = await editor({ value: ' ' });
    await erase(h, 2);
    assert.equal(keys(h).length, 1);
    assert.equal(h.state.value, '');
});

test('EraseText空字段零DEL，本地失败不冒充派发', async () => {
    const h = await editor({ value: '' });
    await assert.rejects(erase(h), error => error.code === 'ERASE_EMPTY' && error.execution.outcome === 'failed');
    assert.equal(keys(h).length, 0);
});

for (const count of [undefined, 0, -1, 101, 1.5, '2', Number.MAX_SAFE_INTEGER]) {
    test(`EraseText拒绝count ${count}`, async () => {
        const h = await editor();
        await assert.rejects(execute(h, { command: 'EraseText', id: ID, count }), { code: 'INVALID_ARGUMENT' });
        assert.equal(rpc(h).length, 0);
    });
}

for (const variant of ['password', 'disabled', 'offscreen', 'invisible', 'no-focus', 'duplicate', 'no-id', 'wrong-foreground']) {
    test(`EraseText ${variant}零DEL且失败脱敏`, async () => {
        let document = xml('private-value');
        if (variant === 'password') document = xml('private-value', 'password="true"');
        if (variant === 'disabled') document = document.replace('enabled="true"', 'enabled="false"');
        if (variant === 'offscreen') document = document.replace('[0,0][100,40]', '[0,300][100,340]');
        if (variant === 'invisible') document = xml('private-value', 'visible-to-user="false"');
        if (variant === 'no-focus') document = document.replace('focused="true"', 'focused="false"');
        if (variant === 'duplicate') document = document.replace('</hierarchy>', xml().replace(/<\/?hierarchy[^>]*>/g, '') + '</hierarchy>');
        if (variant === 'no-id') document = xml('private-value', '', '');
        const h = await editor({ xml: document, foreground: variant === 'wrong-foreground' ? 'com.other' : undefined });
        const action = variant === 'no-id' ? { command: 'EraseText', index: 0, count: 1 } : { command: 'EraseText', id: ID, count: 1 };
        if (variant === 'no-id') action.snapshotId = (await h.service.processToolCall({ command: 'Observe' })).details.snapshotId;
        await assert.rejects(execute(h, action), error => {
            assert.equal(error.execution.outcome, 'failed');
            assert.doesNotMatch(error.message, /private-value|com\.example:id\/editor/);
            return true;
        });
        assert.equal(keys(h).length, 0);
        assert.equal(rpc(h).some(call => call[1] === 'getText'), false);
    });
}

for (const change of ['focus', 'password', 'duplicate', 'hidden-duplicate', 'keyguard', 'class']) {
    test(`EraseText首击后${change}变化，不删除别的字段`, async () => {
        const h = await editor({ write(state, spec) {
            state.value = 'ab';
            spec.xml = xml(state.value);
            if (change === 'focus') spec.xml = spec.xml.replace('focused="true"', 'focused="false"');
            if (change === 'password') spec.xml = xml('private-value', 'password="true"');
            if (change === 'duplicate' || change === 'hidden-duplicate') {
                const duplicate = xml().replace(/<\/?hierarchy[^>]*>/g, '')
                    .replace('<node ', change === 'hidden-duplicate' ? '<node visible-to-user="false" ' : '<node ');
                spec.xml = spec.xml.replace('</hierarchy>', duplicate + '</hierarchy>');
            }
            if (change === 'keyguard') spec.xml = '<hierarchy><node package="com.android.systemui" class="android.widget.EditText" resource-id="com.android.systemui:id/keyguard" enabled="true" bounds="[0,0][100,40]"/></hierarchy>';
            if (change === 'class') spec.xml = spec.xml.replace('android.widget.EditText', 'android.widget.AutoCompleteTextView');
            return true;
        } });
        await assert.rejects(erase(h), error => {
            assert.equal(error.execution.outcome, 'unknown');
            assert.equal(error.execution.retryable, false);
            assert.equal(error.details.attempts.filter(item => item.method === 'pressKeyCode').length, 1);
            assert.doesNotMatch(error.message, /private-value/);
            return true;
        });
        assert.equal(keys(h).length, 1);
    });
}

test('EraseText在getText后派发前焦点改变也零DEL', async () => {
    const h = await editor({ read(state, spec) {
        spec.xml = xml(state.value).replace('focused="true"', 'focused="false"');
        return state.value;
    } });
    await assert.rejects(erase(h), error => error.code === 'ERASE_FOCUS_CHANGED' && error.execution.outcome === 'failed');
    assert.equal(keys(h).length, 0);
});

test('EraseText无进展停止unknown，外层expect不能洗绿', async () => {
    const h = await editor({ write() { return true; } });
    await assert.rejects(erase(h, 100, { expect: { type: 'foreground', package: 'com.example' } }), error => {
        assert.equal(error.code, 'ERASE_NO_PROGRESS');
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(error.execution.verification, null);
        return true;
    });
    assert.equal(keys(h).length, 1);
});

for (const mode of ['false', 'timeout', 'local']) {
    test(`EraseText第二击${mode}保留首击副作用和累计attempts`, async () => {
        const h = await editor({ write(state, spec) {
            if (state.writes === 1) { state.value = 'ab'; spec.xml = xml(state.value); return true; }
            if (mode === 'false') return false;
            throw Object.assign(new Error('private-value'), { code: mode === 'local' ? 'UI_SERVER_INVALID_ARGUMENT' : 'UI_SERVER_TIMEOUT', dispatched: mode !== 'local' });
        } });
        await assert.rejects(erase(h), error => {
            assert.equal(error.execution.outcome, 'unknown');
            assert.deepEqual(error.details.attempts.filter(item => item.method === 'pressKeyCode').map(item => item.status), ['dispatched', mode === 'local' ? 'not-dispatched' : 'unknown']);
            assert.doesNotMatch(error.message, /private-value/);
            return true;
        });
        assert.equal(keys(h).length, 2);
        assert.equal(shellInputs(h).length, 0);
    });
}

for (const boundary of ['abort', 'deadline']) {
    test(`EraseText在途${boundary}不续击，总预算到期仍保留租约直到RPC排干`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
        let release;
        const controller = new AbortController();
        const h = await editor({ write: () => new Promise(resolve => { release = resolve; }) });
        const work = settled(erase(h, 3, { timeoutMs: 100 }, { signal: controller.signal }));
        await tick();
        assert.equal(keys(h).length, 1);
        if (boundary === 'abort') controller.abort(); else t.mock.timers.tick(100);
        const { error } = await work;
        assert.equal(error.code, boundary === 'abort' ? 'STEP_ABORTED' : 'STEP_DEADLINE');
        assert.equal(error.execution.outcome, 'unknown');
        assert.equal(error.details.attempts.filter(item => item.method === 'pressKeyCode').length, 1);
        await assert.rejects(execute(h, { command: 'ImeAction', imeAction: 'enter' }), { code: 'DEVICE_BUSY' });
        release(true);
        await tick();
        assert.equal(keys(h).length, 1);
        await h.service.processToolCall({ command: 'Observe', mode: 'ui' });
    });
}

test('EraseText首击读回时取消不再发送第二击', async () => {
    const controller = new AbortController();
    const h = await editor({ read(state) { if (state.writes === 1) controller.abort(); return state.value; } });
    await assert.rejects(erase(h, 3, {}, { signal: controller.signal }), error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'unknown');
    await tick();
    assert.equal(keys(h).length, 1);
});

test('预取消键盘动作零RPC', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = await editor();
    await assert.rejects(erase(h, 3, {}, { signal: controller.signal }), { code: 'STEP_ABORTED' });
    assert.equal(rpc(h).length, 0);
});

test('EraseText getText异常脱敏，不发送DEL', async () => {
    const h = await editor({ read() { throw Object.assign(new Error('private-value'), { code: 'UI_SERVER_RPC_FAILED', dispatched: false }); } });
    await assert.rejects(erase(h), error => {
        assert.equal(error.execution.outcome, 'failed');
        assert.doesNotMatch(error.message, /private-value|com\.example:id\/editor/);
        return true;
    });
    assert.equal(keys(h).length, 0);
});

for (const mode of ['false', 'timeout', 'local']) {
    test(`EraseText首击${mode}保留真实派发状态，不重发`, async () => {
        const h = await editor({ write() {
            if (mode === 'false') return false;
            throw Object.assign(new Error('private-value'), { code: mode === 'local' ? 'UI_SERVER_INVALID_ARGUMENT' : 'UI_SERVER_TIMEOUT', dispatched: mode !== 'local' });
        } });
        await assert.rejects(erase(h), error => {
            assert.equal(error.execution.outcome, mode === 'local' ? 'failed' : 'unknown');
            assert.equal(error.execution.retryable, false);
            assert.deepEqual(error.details.attempts.filter(item => item.method === 'pressKeyCode').map(item => item.status), [mode === 'local' ? 'not-dispatched' : 'unknown']);
            assert.doesNotMatch(error.message, /private-value/);
            return true;
        });
        assert.equal(keys(h).length, 1);
        assert.equal(shellInputs(h).length, 0);
    });
}

test('键盘RPC服务未就绪本地失败，不退shell', async () => {
    const h = await harness();
    await assert.rejects(execute(h, { command: 'ImeAction', imeAction: 'enter' }), error => error.execution.outcome === 'failed');
    assert.equal(keys(h).length, 0);
    assert.equal(shellInputs(h).length, 0);
});

test('EraseText下一击前重新getText已空，不复用前一击旧值派发', async () => {
    const h = await editor({ read(state, spec) {
        if (state.reads === 3) { state.value = ''; spec.xml = xml(''); }
        return state.value;
    } });
    await erase(h, 3);
    assert.equal(keys(h).length, 1);
    assert.equal(h.state.value, '');
});

test('EraseText RPC readiness期间焦点换到另一个字段，最终派发闸门必须零DEL', async () => {
    const h = await editor();
    let moved = false;
    h.spec.start = calls => {
        if (calls === 5) {
            moved = true;
            h.spec.xml = xml('private-value').replace('focused="true"', 'focused="false"')
                .replace('</hierarchy>', '<node class="android.widget.EditText" package="com.example" resource-id="com.example:id/other" text="other-private" enabled="true" focused="true" bounds="[0,80][100,120]"/></hierarchy>');
        }
        return { ok: true };
    };
    await assert.rejects(erase(h, 1), error => {
        assert.equal(error.code, 'ERASE_FOCUS_CHANGED');
        assert.equal(error.execution.outcome, 'failed');
        assert.equal(error.execution.retryable, false);
        assert.doesNotMatch(error.message, /private-value|other-private/);
        return true;
    });
    assert.equal(moved, true, '必须命中最终prove之后的就绪边界');
    assert.equal(keys(h).length, 0, '不能先删除新焦点字段，再在读回时发现变化');
    assert.equal(h.state.writes, 0);
    assert.equal(shellInputs(h).length, 0);
});
