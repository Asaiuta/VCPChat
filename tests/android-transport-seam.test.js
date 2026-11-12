'use strict';

/**
 * 传输层可替换性。
 *
 * 抽取传输层的唯一目的是：将来换掉 adb（改成已安装 App 自监听）时，
 * 会话层一行不动。这个主张必须能被独立验证，否则「缝」只是装饰。
 *
 * 这里用一个完全假的传输（不碰 adb、不碰 HTTP），验证四件事：
 * 1. start/stop 被真正转发到注入的传输上；
 * 2. invoke 的白名单与参数形状校验发生在传输之前（dispatched=false 且传输零调用）；
 * 3. 就绪判定取自传输，而不是会话层自己另存一份；
 * 4. 能力记账跟随 stop() 作废 —— 换传输等于换一代，旧结论不得沿用。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    UiServer,
    UiServerError,
} = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');

/** 假传输：只记录被问了什么，不产生任何 I/O。 */
function fakeTransport(options = {}) {
    const calls = [];
    return {
        ready: options.ready !== false,
        port: options.port === undefined ? 4242 : options.port,
        calls,
        started: 0,
        stopped: 0,
        async start() { this.started += 1; return { ok: true, port: this.port }; },
        async stop() { this.stopped += 1; this.ready = false; },
        isReady() { return this.ready === true && Number.isInteger(this.port); },
        async call(method, params, timeoutMs, signal, deadline) {
            calls.push({ method, params, timeoutMs, signal, deadline });
            return options.result === undefined ? 'ok' : options.result;
        },
    };
}

test('会话层把 start/stop 转发给注入的传输，不自己碰 adb', async () => {
    const transport = fakeTransport();
    const server = new UiServer({ transport });
    assert.deepEqual(await server.start(), { ok: true, port: 4242 });
    assert.equal(transport.started, 1);
    assert.equal(server.port, 4242, 'port 必须来自传输，不得在会话层另存');
    await server.stop();
    assert.equal(transport.stopped, 1);
});

test('白名单与参数形状在传输之前拒绝，且不留任何派发痕迹', async () => {
    const transport = fakeTransport();
    const server = new UiServer({ transport });
    const rejects = [
        ['未知方法', () => server.invoke('nope', [])],
        ['参数不是数组', () => server.invoke('click', {})],
        ['参数个数不符', () => server.invoke('click', [1])],
        ['第四参未声明', () => server.invoke('click', [1, 2, 3, 4])],
    ];
    for (const [label, run] of rejects) {
        await assert.rejects(run, (error) => {
            assert.ok(error instanceof UiServerError, `${label} 必须是 UiServerError`);
            assert.equal(error.code, 'UI_SERVER_INVALID_ARGUMENT', label);
            assert.equal(error.dispatched, false, `${label} 不得声称已派发`);
            assert.equal(error.drained, true, `${label} 必须已排干`);
            return true;
        });
    }
    assert.deepEqual(transport.calls, [], '本地拒绝绝不能到达传输层');
});

test('就绪状态取自传输：传输未就绪时会话层直接拒派', async () => {
    const transport = fakeTransport({ ready: false });
    const server = new UiServer({ transport });
    assert.equal(server.isReady(), false);
    await assert.rejects(server.invoke('click', [1, 2]), (error) => {
        assert.equal(error.code, 'UI_SERVER_NOT_READY');
        assert.equal(error.dispatched, false);
        return true;
    });
    await assert.rejects(server.dump(), (error) => error.code === 'UI_SERVER_NOT_READY');
    assert.deepEqual(transport.calls, [], '未就绪不得写出任何字节');
});

test('换传输等于换一代：stop 之后能力结论作废', async () => {
    const transport = fakeTransport();
    const server = new UiServer({ transport });
    assert.equal(server.capability('pasteClipboard'), 'unknown', '无证据时如实说未知');
    server.noteCapability('pasteClipboard', 'unavailable');
    assert.equal(server.capability('pasteClipboard'), 'unavailable');
    await server.stop();
    assert.equal(
        server.capability('pasteClipboard'),
        'unknown',
        '新进程可能来自不同 APK / ROM / 传输实现，旧结论不得沿用',
    );
});

test('dump 仍按设备端原样下传三参，maxDepth 非法值被校正为正整数', async () => {
    const transport = fakeTransport({ result: '<hierarchy rotation="0" />' });
    const server = new UiServer({ transport });
    await server.dump({ maxDepth: 0, compressed: true });
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].method, 'dumpWindowHierarchy');
    assert.deepEqual(
        transport.calls[0].params,
        [true, 200, true],
        'maxDepth<=0 在 uiautomator2 下只回根节点，必须校正为正深度',
    );
});

test('dump 拿到非 XML 时抛 BAD_PAYLOAD，绝不让空树冒充成功', async () => {
    const transport = fakeTransport({ result: '<html>not a tree</html>' });
    const server = new UiServer({ transport });
    await assert.rejects(server.dump(), (error) => {
        assert.equal(error.code, 'UI_SERVER_BAD_PAYLOAD');
        assert.equal(error.dispatched, true);
        assert.equal(error.drained, true);
        return true;
    });
});
