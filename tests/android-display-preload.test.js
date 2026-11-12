'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');

const filename = path.resolve(__dirname, '../preloads/android-display.js');
const source = fs.readFileSync(filename, 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { html = '<header><strong>安卓显示屏</strong><div class="header-actions"><button id="gear">设置</button></div></header>', invoke, url = 'http://127.0.0.1:34567/' } = {}) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const calls = [], exposed = {};
    const ipc = new EventEmitter();
    ipc.invoke = (...args) => {
        calls.push(args);
        return invoke ? invoke(...args) : Promise.resolve({ maximized: false });
    };
    const bridge = { exposeInMainWorld(name, api) { exposed[name] = api; } };
    vm.runInNewContext(source, {
        require(name) { assert.equal(name, 'electron'); return { contextBridge: bridge, ipcRenderer: ipc }; },
        window: dom.window, document: dom.window.document,
    }, { filename });
    t.after(() => {
        dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
        dom.window.close();
    });
    if (dom.window.document.readyState === 'loading') {
        await new Promise(resolve => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }
    await tick();
    return { dom, window: dom.window, document: dom.window.document, ipc, exposed, calls,
        buttons: () => [...dom.window.document.querySelectorAll('.title-bar-controls .title-bar-button')] };
}

test('renderer receives only the frozen narrow display bridge; controls invoke private fixed actions in preload', async t => {
    const f = await fixture(t);
    assert.deepEqual(Object.keys(f.exposed), ['androidDisplay']);
    assert.deepEqual(Object.keys(f.exposed.androidDisplay), ['fitWindow', 'openSettings', 'requestViewerAction',
        'readControllerSettings', 'saveControllerSettings', 'openSystemAuthorization']);
    assert.equal(Object.isFrozen(f.exposed.androidDisplay), true);
    assert.equal(f.window.ipcRenderer, undefined);
    assert.equal(f.window.utilityAPI, undefined);
    const controls = f.document.querySelector('header > .title-bar-controls');
    assert.ok(controls);
    assert.equal(controls.previousElementSibling.className, 'header-actions');
    const buttons = f.buttons();
    assert.equal(buttons.length, 3);
    assert.deepEqual(buttons.map(button => button.getAttribute('aria-label')), ['最小化', '最大化', '关闭']);
    assert.equal(buttons[2].classList.contains('close-button'), true);
    for (const button of buttons) {
        assert.equal(button.type, 'button');
        assert.equal(button.classList.contains('vcp-ui-button'), false);
        assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
        assert.equal(button.querySelector('svg').namespaceURI, 'http://www.w3.org/2000/svg');
        button.click();
    }
    await tick();
    assert.deepEqual(f.calls, [
        ['android-display:window-control', 'state'],
        ['android-display:window-control', 'minimize'],
        ['android-display:window-control', 'toggle-maximize'],
        ['android-display:window-control', 'close'],
    ]);
    const geometry = { width: 1080, height: 2400, chromeHeight: 48 };
    await f.exposed.androidDisplay.fitWindow(geometry);
    assert.deepEqual(f.calls.at(-1), ['android-display:fit-window', geometry]);
    f.document.dispatchEvent(new f.window.Event('DOMContentLoaded'));
    assert.equal(f.buttons().length, 3, 'DOMContentLoaded does not install duplicate controls');
});

test('maximize/unmaximize notifications update restore icon and labels without renderer callbacks', async t => {
    const f = await fixture(t);
    const button = f.buttons()[1];
    const maximizePath = button.querySelector('path').getAttribute('d');
    f.ipc.emit('android-display:window-state', {}, { maximized: true });
    assert.equal(button.title, '还原');
    assert.equal(button.getAttribute('aria-label'), '还原');
    assert.notEqual(button.querySelector('path').getAttribute('d'), maximizePath);
    f.ipc.emit('android-display:window-state', {}, { maximized: false });
    assert.equal(button.title, '最大化');
    assert.equal(button.querySelector('path').getAttribute('d'), maximizePath);
    f.ipc.emit('android-display:window-state', {}, { maximized: 'true' });
    assert.equal(button.title, '最大化');
    f.window.dispatchEvent(new f.window.Event('beforeunload'));
    assert.equal(f.ipc.listenerCount('android-display:window-state'), 0);
});

test('late initial state cannot overwrite newer OS maximize notification', async t => {
    let release;
    const state = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { invoke: () => state });
    f.ipc.emit('android-display:window-state', {}, { maximized: true });
    release({ maximized: false });
    await tick();
    assert.equal(f.buttons()[1].title, '还原');
});

test('loading/error status headers get controls and rejected invocations do not produce unhandled errors', async t => {
    const f = await fixture(t, { html: '<header><strong>安卓显示屏</strong><span>VCPChat</span></header><main>正在打开</main>',
        invoke: async () => { throw new Error('window closed'); } });
    assert.equal(f.buttons().length, 3);
    f.buttons()[2].click();
    await tick();
    assert.equal(f.calls.at(-1)[1], 'close');
});

test('settings bridge invokes fixed channels and defaults display section without exposing arbitrary IPC', async t => {
    const f = await fixture(t);
    await f.exposed.androidDisplay.openSettings();
    assert.deepEqual(f.calls.at(-1), ['android-display:open-settings', 'display']);
    for (const section of ['connection', 'status']) {
        await f.exposed.androidDisplay.openSettings(section);
        assert.deepEqual(f.calls.at(-1), ['android-display:open-settings', section]);
    }
    for (const action of ['fit', 'reconnect']) {
        await f.exposed.androidDisplay.requestViewerAction(action);
        assert.deepEqual(f.calls.at(-1), ['android-display:request-viewer-action', action]);
    }
    assert.equal(f.exposed.androidDisplay.invoke, undefined);
    assert.equal(f.exposed.androidDisplay.send, undefined);
    assert.equal(f.exposed.androidDisplay.on, undefined);
    assert.equal(f.exposed.androidDisplay.windowControl, undefined);
});

test('fixed viewer-action notifications become DOM CustomEvents and reject malformed payloads with owned cleanup', async t => {
    const f = await fixture(t);
    const events = [];
    f.window.addEventListener('android-display-viewer-action', event => events.push(event.detail.action));
    for (const action of ['fit', 'reconnect']) f.ipc.emit('android-display:viewer-action', {}, { action });
    assert.deepEqual(events, ['fit', 'reconnect']);
    for (const payload of [undefined, null, [], 'fit', {}, { action: 'reload' }, { action: 'fit', script: 'evil' }]) {
        f.ipc.emit('android-display:viewer-action', {}, payload);
    }
    assert.deepEqual(events, ['fit', 'reconnect']);
    f.window.dispatchEvent(new f.window.Event('beforeunload'));
    assert.equal(f.ipc.listenerCount('android-display:viewer-action'), 0);
    f.ipc.emit('android-display:viewer-action', {}, { action: 'fit' });
    assert.deepEqual(events, ['fit', 'reconnect']);
});

test('settings child installs the same three controls whose close stays in the private sender-bound channel', async t => {
    const f = await fixture(t, { url: 'http://127.0.0.1:34567/settings?section=connection',
        html: '<header><strong>安卓显示屏设置</strong></header><main>连接设置</main>' });
    assert.equal(f.buttons().length, 3);
    f.buttons()[2].click(); await tick();
    assert.deepEqual(f.calls.at(-1), ['android-display:window-control', 'close']);
    assert.equal(f.exposed.androidDisplay.close, undefined);
    assert.equal(f.exposed.androidDisplay.closeSettings, undefined);
});

test('documents without a header do not create controls or invoke window actions', async t => {
    const f = await fixture(t, { html: '<main>unrelated document</main>' });
    assert.equal(f.buttons().length, 0);
    assert.deepEqual(f.calls, []);
});

test('controller bridge exposes fixed read, save and authorization messages only', async t => {
    const f = await fixture(t);
    const api = f.exposed.androidDisplay;
    const payload = { revision: 'r', values: { AUTO_WAKE: false } };
    await api.readControllerSettings();
    await api.saveControllerSettings(payload);
    await api.openSystemAuthorization();
    assert.deepEqual(f.calls.slice(-3), [
        ['android-display:controller-settings', 'read'],
        ['android-display:controller-settings', 'save', payload],
        ['android-display:controller-settings', 'authorization'],
    ]);
});
