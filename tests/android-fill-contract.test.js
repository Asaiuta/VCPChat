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

test('无 resource-id 的输入框不被同 bounds 的包裹 View 误判为重复字段', async () => {
    // 真机复现（com.coloros.note 编辑页）：EditText 自身无 resource-id，
    // 外层 android.view.View 与它 bounds 完全相同。旧实现把包裹 View 也当成一个「输入框」，
    // id+pkg+bounds 命中 2 个就直接拒绝，导致无 id 的常见输入框永远无法 Fill。
    const nested = '<hierarchy rotation="0">'
        + '<node class="android.view.View" package="com.example" resource-id="" text="" enabled="true" bounds="[0,0][100,40]">'
        + '<node class="android.widget.EditText" package="com.example" resource-id="" text="old" enabled="true" bounds="[0,0][100,40]" />'
        + '</node></hierarchy>';
    const h = await harness({ uiServer: { ok: true, xml: nested, text: 'new' } });

    const observed = await h.service.processToolCall({ command: 'Observe', mode: 'ui', limit: 50 });
    const node = observed.details.controls.find(control => control.role === 'textfield');
    assert.ok(node, '必须能从无 resource-id 的 EditText 识别出 textfield');

    const result = await h.service.processToolCall({
        command: 'ExecuteStep',
        action: { command: 'Fill', index: node.index, snapshotId: observed.details.snapshotId, text: 'new' },
    });
    assert.equal(result.details.execution.outcome, 'verified');

    const rpc = h.calls.filter(call => call[0] === 'rpc');
    assert.equal(rpc[0][1], 'setText');
    assert.equal(rpc[0][2][0].className, 'android.widget.EditText',
        'RPC 目标必须是 EditText，不能是 bounds 相同的包裹容器');
});


test('非 ASCII 直接交给 setText：charset 修复后中文能原样往返', async () => {
    // 曾经在这里拒绝非 ASCII，理由是 setText 会把「绫织中文」写成 12 个 U+FFFD。
    // 真机追到底：根因是 RPC 请求头缺 charset，设备端按 ISO-8859-1 解码。
    // 补上 charset=utf-8 后，真机独立读回「绫织原生写入」与原串一致，
    // 所以现在的契约是「照常发」，而不是「本地拒绝」。
    const h = await harness({ uiServer: { ok: true, xml: field(), text: '绫织中文' } });

    const result = await fill(h, '绫织中文');
    assert.equal(result.details.execution.outcome, 'verified');
    const rpc = h.calls.filter(call => call[0] === 'rpc');
    assert.deepEqual(rpc.map(call => call[1]), ['setText', 'getText']);
    assert.equal(rpc[0][2][1], '绫织中文', '中文必须原样进入 RPC 参数');
});

test('清空后 getText 返回尾随换行仍判 verified', async () => {
    // 真机实测：clearTextField 后 getText 返回 "\\n"，不是空串。
    // 严格相等会把「已经清空」误判成 unknown，让调用方以为动作没生效。
    const h = await harness({ uiServer: { ok: true, xml: field(), text: '\n' } });
    const result = await fill(h, '');

    assert.equal(result.details.execution.outcome, 'verified');
});

