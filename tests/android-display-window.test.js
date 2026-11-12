'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { createAndroidDisplayWindow, createAndroidDisplayResolver, displayUrl } = require('../modules/services/androidDisplayWindow');
const { compilePalettes } = require('../modules/services/androidDisplayTheme');
const cssTree = require('css-tree');
const { vendorPath } = require('../VCPDistributedServer/Plugin/AndroidController/lib/vendor-path');
const { harness } = require('./helpers/android-service-harness.cjs');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture(t, resolveDisplayUrl = async () => 'http://127.0.0.1:34567/', options = {}) {
    const windows = [], children = [], ready = [], logs = [];
    const theme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true });
    const handlers = new Map();
    const ipcMain = {
        handle(name, fn) { assert.equal(handlers.has(name), false); handlers.set(name, fn); },
        removeHandler(name) { handlers.delete(name); },
    };
    const workArea = { x: -1600, y: 0, width: 1600, height: 1000 };
    const screen = { getDisplayMatching: () => ({ workArea }) };
    const isolated = {};
    const session = { fromPartition(name) { assert.equal(name, 'android-display'); return {
        setPermissionRequestHandler(fn) { isolated.permissionRequest = fn; },
        setPermissionCheckHandler(fn) { isolated.permissionCheck = fn; },
    }; } };
    class Window extends EventEmitter {
        constructor(config) {
            super(); this.config = config; this.destroyed = false; this.history = []; this.focused = 0; this.minimized = false;
            this.bounds = { x: -1500, y: 100, width: config.width, height: config.height };
            this.resizes = [];
            this.webContents = new EventEmitter();
            Object.assign(this.webContents, {
                id: windows.length + 1, css: [], cssOptions: [], removedCss: [], messages: [], mainFrame: { detached: false },
                send(channel, payload) { this.messages.push([channel, payload]); },
                getURL: () => this.url || '',
                setWindowOpenHandler(fn) { this.popup = fn; },
                async insertCSS(css, options) { this.css.push(css); this.cssOptions.push(options); return `css-${this.css.length}`; },
                async removeInsertedCSS(key) { this.removedCss.push(key); },
            });
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isMinimized() { return this.minimized; }
        isMaximized() { return Boolean(this.maximized); }
        isFullScreen() { return Boolean(this.fullScreen); }
        getBounds() { return { ...this.bounds }; }
        getContentBounds() { return { ...this.bounds, width: this.bounds.width - 16, height: this.bounds.height - 8 }; }
        setBounds(bounds) { this.bounds = bounds; this.resizes.push(bounds); }
        setMinimumSize(width, height) { this.minimum = [width, height]; }
        restore() { this.minimized = false; }
        minimize() { this.minimized = true; }
        maximize() { this.maximized = true; this.emit('maximize'); }
        unmaximize() { this.maximized = false; this.emit('unmaximize'); }
        close() { this.destroy(); }
        show() { this.visible = true; }
        focus() { this.focused++; }
        setMenu(value) { assert.equal(value, null); }
        setTitleBarOverlay() { assert.fail('frameless VCPChat windows must not use native titlebar overlay'); }
        async loadFile(file, { query } = {}) {
            const url = pathToFileURL(file);
            for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
            await this.load(url.href);
        }
        async loadURL(url) { await this.load(url); }
        async load(url) {
            this.webContents.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: true });
            if (options.beforeLoad) await options.beforeLoad(this, url);
            this.url = url; this.history.push(url);
            this.webContents.emit('did-finish-load');
        }
        destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    }
    const windowService = {
        register(appId, config) { assert.equal(appId, 'android-display'); this.entry = config; },
        attachWindow(appId, win) { assert.equal(appId, 'android-display'); this.attached = win; },
        markReady(appId, context) { ready.push([appId, context]); },
    };
    const host = createAndroidDisplayWindow({
        BrowserWindow: Window, session, nativeTheme: theme, windowService, ipcMain, screen,
        projectRoot: root, openChildWindows: children, resolveDisplayUrl,
        logger: { warn(...args) { logs.push(args); } }, ...options,
    });
    t.after(() => host.dispose());
    const navigate = (win, url, eventName = 'will-navigate') => {
        let prevented = false;
        win.webContents.emit(eventName, { url, isMainFrame: true, preventDefault() { prevented = true; } });
        return prevented;
    };
    const fit = (win, geometry, event = {}) => handlers.get('android-display:fit-window')({
        sender: win.webContents, senderFrame: win.webContents.mainFrame, ...event,
    }, geometry);
    const control = (win, action, event = {}) => handlers.get('android-display:window-control')({
        sender: win.webContents, senderFrame: win.webContents.mainFrame, ...event,
    }, action);
    const openSettings = (win, section, event = {}) => handlers.get('android-display:open-settings')({
        sender: win.webContents, senderFrame: win.webContents.mainFrame, ...event,
    }, section);
    const viewerAction = (win, action, event = {}) => handlers.get('android-display:request-viewer-action')({
        sender: win.webContents, senderFrame: win.webContents.mainFrame, ...event,
    }, action);
    return { host, windows, children, ready, logs, theme, isolated, windowService, navigate, fit, control, openSettings, viewerAction, handlers, workArea };
}

test('display URL accepts only the actual loopback viewer origin and root page', () => {
    assert.equal(displayUrl('http://127.0.0.1:34567/'), 'http://127.0.0.1:34567/');
    for (const raw of [null, '', 'file:///main.html', 'https://127.0.0.1:34567/',
        'http://localhost:34567/', 'http://example.com:34567/', 'http://127.0.0.1/',
        'http://u:p@127.0.0.1:34567/', 'http://127.0.0.1:34567/?token=x',
        'http://127.0.0.1:34567/#x', 'http://127.0.0.1:34567/frame']) {
        assert.throws(() => displayUrl(raw), undefined, String(raw));
    }
});

test('controller settings use only the current native settings main frame and invalidate queued writes on closure', async t => {
    const calls = [];
    let pendingCheck;
    const f = fixture(t, undefined, { getControllerService: () => ({
        async readControllerSettings() { calls.push('read'); return { ok: true, revision: 'r' }; },
        async saveControllerSettings(payload, options) { calls.push(payload); pendingCheck = options.assertCurrent; return { ok: true }; },
    }), openSystemAuthorization() { calls.push('authorization'); } });
    const main = await f.host.open();
    await f.openSettings(main, 'controller');
    const child = f.host.getSettingsWindow();
    const request = (win, op, payload, override = {}) => f.handlers.get('android-display:controller-settings')({
        sender: win.webContents, senderFrame: win.webContents.mainFrame, ...override,
    }, op, payload);
    for (const op of ['read', 'save', 'authorization']) {
        assert.equal((await request(main, op)).ok, false);
        assert.equal((await request(child, op, {}, { senderFrame: {} })).ok, false);
    }
    assert.deepEqual(calls, []);
    assert.equal((await request(child, 'read')).revision, 'r');
    const payload = { revision: 'r', values: { AUTO_WAKE: false } };
    assert.equal((await request(child, 'save', payload)).ok, true);
    assert.equal((await request(child, 'authorization')).ok, true);
    assert.equal((await request(child, 'arbitrary')).ok, false);
    assert.deepEqual(calls, ['read', payload, 'authorization']);
    child.destroy();
    assert.throws(pendingCheck, /设置窗口/);
    assert.equal((await request(child, 'read')).ok, false);
});

test('parallel opens share readiness and one isolated window; subsequent opens restore and focus', async t => {
    const gate = deferred(); let resolutions = 0;
    const f = fixture(t, () => { resolutions++; return gate.promise; });
    const first = f.host.open(), second = f.host.open();
    await tick();
    assert.equal(f.windows.length, 1); assert.equal(resolutions, 1);
    const win = f.windows[0];
    assert.equal(new URL(win.url).searchParams.get('state'), 'loading');
    gate.resolve('http://127.0.0.1:45678/');
    assert.equal(await first, await second);
    assert.equal(win.url, 'http://127.0.0.1:45678/');
    assert.equal(f.children.length, 1); assert.equal(f.windowService.attached, win);
    assert.equal(f.ready.at(-1)[0], 'android-display');
    assert.equal(win.config.frame, false);
    assert.equal(Object.hasOwn(win.config, 'titleBarStyle'), false);
    assert.equal(Object.hasOwn(win.config, 'titleBarOverlay'), false);
    const preferences = win.config.webPreferences;
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.webSecurity, true);
    assert.equal(preferences.preload, path.join(root, 'preloads/android-display.js'));
    win.minimized = true;
    assert.equal(await f.host.open(), win);
    assert.equal(win.minimized, false); assert.equal(win.focused, 1);
    assert.equal(resolutions, 1);
});

test('foreign origins, popup windows, redirects, API documents, and webview attachment are blocked', async t => {
    const f = fixture(t); const win = await f.host.open();
    assert.deepEqual(win.webContents.popup({ url: 'https://example.com' }), { action: 'deny' });
    for (const url of ['https://example.com/', 'http://127.0.0.1:34568/', 'http://localhost:34567/',
        'http://127.0.0.1:34567/api/devices', 'http://127.0.0.1:34567/?x=1', 'file:///main.html',
        'vcp-android-display://retry', 'javascript:alert(1)']) {
        assert.equal(f.navigate(win, url), true, url);
        assert.equal(f.navigate(win, url, 'will-redirect'), true, url);
    }
    assert.equal(f.navigate(win, 'http://127.0.0.1:34567/'), false);
    assert.equal(f.navigate(win, 'http://127.0.0.1:34567/index.html'), false);
    let prevented = false;
    win.webContents.emit('will-attach-webview', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    let permission;
    f.isolated.permissionRequest(null, 'camera', value => { permission = value; });
    assert.equal(permission, false); assert.equal(f.isolated.permissionCheck(), false);
});

test('service errors stay in the themed local surface and retry only on an explicit local link', async t => {
    let fail = true, calls = 0;
    const f = fixture(t, async () => { calls++; if (fail) throw new Error('插件未启用 <img onerror=evil()>'); return 'http://127.0.0.1:45678/'; });
    const win = await f.host.open();
    assert.equal(new URL(win.url).searchParams.get('state'), 'error');
    assert.match(new URL(win.url).searchParams.get('message'), /插件未启用/);
    assert.equal(calls, 1);
    fail = false;
    assert.equal(f.navigate(win, new URL('?state=retry', win.url).href), true);
    for (let i = 0; i < 10 && win.url !== 'http://127.0.0.1:45678/'; i++) await tick();
    assert.equal(win.url, 'http://127.0.0.1:45678/'); assert.equal(calls, 2);
});

test('readiness timeout does not navigate later or repeat initialization without retry', async t => {
    const gate = deferred(); let calls = 0;
    const f = fixture(t, () => { calls++; return gate.promise; }, { timeoutMs: 15 });
    const win = await f.host.open();
    assert.equal(new URL(win.url).searchParams.get('state'), 'error');
    assert.match(new URL(win.url).searchParams.get('message'), /初始化/);
    gate.resolve('http://127.0.0.1:45678/'); await tick();
    assert.equal(new URL(win.url).protocol, 'file:'); assert.equal(calls, 1);
});

test('closing a window aborts its wait without stopping the service; late readiness cannot resurrect it', async t => {
    const gate = deferred(); const f = fixture(t, () => gate.promise);
    const opening = f.host.open(); await tick();
    const old = f.windows[0]; old.destroy();
    assert.equal(await opening, null); assert.equal(f.children.length, 0);
    gate.resolve('http://127.0.0.1:45678/'); await tick();
    assert.equal(old.history.some(url => url.startsWith('http:')), false);
    const next = await f.host.open();
    assert.notEqual(next, old); assert.equal(next.url, 'http://127.0.0.1:45678/');
    assert.equal(f.children.length, 1);
});

test('dispose releases its theme listener and prevents new windows even while initialization is pending', async t => {
    const gate = deferred(); const f = fixture(t, () => gate.promise);
    const opening = f.host.open(); await tick();
    assert.equal(f.theme.listenerCount('updated'), 1);
    f.host.dispose();
    assert.equal(await opening, null);
    assert.equal(f.theme.listenerCount('updated'), 0);
    assert.equal(f.handlers.size, 0);
    assert.equal(f.windows[0].destroyed, true);
    await assert.rejects(f.host.open(), /已退出/);
    gate.resolve('http://127.0.0.1:34567/');
});

test('fit follows actual content aspect, including native borders, wraps and monitor edges', async t => {
    const f = fixture(t); const win = await f.host.open();
    for (const [width, height, chromeHeight] of [[1080, 2400, 160], [1080, 2400, 210], [2400, 1080, 160]]) {
        assert.equal(f.fit(win, { width, height, chromeHeight }), true);
        const b = win.getBounds(), c = win.getContentBounds(), w = f.workArea;
        assert.ok(Math.abs(c.width / (c.height - chromeHeight) - width / height) < 0.005);
        assert.ok(b.x >= w.x && b.y >= w.y && b.x + b.width <= w.x + w.width && b.y + b.height <= w.y + w.height);
    }
    f.workArea.width = 320; f.workArea.height = 450;
    f.fit(win, { width: 1080, height: 2400, chromeHeight: 160 });
    assert.ok(win.bounds.width <= 320 && win.bounds.height <= 450);
    assert.deepEqual(win.minimum, [320, 450]);
});

test('fit rejects foreign frames, invalid geometry, status pages and maximized windows', async t => {
    const f = fixture(t); const win = await f.host.open();
    const geometry = { width: 1080, height: 2400, chromeHeight: 160 };
    for (const value of [null, [], {}, { ...geometry, width: 0 }, { ...geometry, width: 1.5 },
        { ...geometry, chromeHeight: 481 }, { ...geometry, x: 0 }, { ...geometry, width: 16385 },
        { ...geometry, width: 1 }]) assert.equal(f.fit(win, value), false);
    assert.equal(f.fit(win, geometry, { sender: new EventEmitter() }), false);
    assert.equal(f.fit(win, geometry, { senderFrame: {} }), false);
    win.webContents.mainFrame.detached = true;
    assert.equal(f.fit(win, geometry), false);
    win.webContents.mainFrame.detached = false;
    for (const flag of ['maximized', 'fullScreen']) {
        win[flag] = true; assert.equal(f.fit(win, geometry), false); win[flag] = false;
    }
    win.url = pathToFileURL(path.join(root, 'modules/android-display/status.html')).href;
    assert.equal(f.fit(win, geometry), false);
    assert.equal(win.resizes.length, 0);
});

test('theme changes replace the previous injected palette without privileging page scripts', async t => {
    const f = fixture(t); const win = await f.host.open();
    await f.host.refreshTheme();
    assert.match(win.webContents.css.at(-1), /color-scheme:dark !important/);
    f.theme.shouldUseDarkColors = false;
    await f.host.refreshTheme();
    assert.match(win.webContents.css.at(-1), /color-scheme:light !important/);
    assert.ok(win.webContents.removedCss.length > 0);
    const css = compilePalettes([':root{--primary-bg:#123456;--button-bg:#345678}body.light-theme{--primary-bg:#fafafa}', '', '', '']).light;
    assert.match(css, /--bg:#fafafa !important/);
    assert.doesNotMatch(css, /padding-left:80px|padding-right:152px/);
    assert.doesNotMatch(compilePalettes(['', '', '', '']).dark, /padding-left:80px|padding-right:152px/);
    assert.ok(win.webContents.cssOptions.every(options => options.cssOrigin === 'author'));
    assert.match(win.webContents.css.at(-1), /\.title-bar-button/);
    assert.match(win.webContents.css.at(-1), /\.vcp-ui-native-select/);
    assert.match(css, /header button,header a,header input,header details,header summary\{app-region:no-drag;/);
    assert.doesNotMatch(css, /background-image|wallpaper|url\(/);
});

test('repeated theme refresh does not reinsert identical CSS, while navigation installs it in the new document', async t => {
    const f = fixture(t); const win = await f.host.open();
    await f.host.refreshTheme();
    const count = win.webContents.css.length;
    await Promise.all([f.host.refreshTheme(), f.host.refreshTheme()]);
    assert.equal(win.webContents.css.length, count);
    await win.loadURL(win.url);
    await f.host.refreshTheme();
    assert.equal(win.webContents.css.length, count + 1);
});

test('window controls use only the strict allowlist and publish OS maximize changes', async t => {
    const f = fixture(t); const win = await f.host.open();
    assert.deepEqual(f.control(win, 'state'), { maximized: false });
    assert.deepEqual(f.control(win, 'minimize'), { maximized: false });
    assert.equal(win.minimized, true);
    assert.deepEqual(f.control(win, 'toggle-maximize'), { maximized: true });
    assert.deepEqual(win.webContents.messages.at(-1), ['android-display:window-state', { maximized: true }]);
    assert.deepEqual(f.control(win, 'toggle-maximize'), { maximized: false });
    assert.deepEqual(win.webContents.messages.at(-1), ['android-display:window-state', { maximized: false }]);
    win.maximize();
    assert.deepEqual(win.webContents.messages.at(-1), ['android-display:window-state', { maximized: true }]);
    win.unmaximize();
    assert.deepEqual(win.webContents.messages.at(-1), ['android-display:window-state', { maximized: false }]);
    assert.deepEqual(f.control(win, 'close'), { maximized: false });
    assert.equal(win.destroyed, true);
    assert.equal(f.control(win, 'state'), false);
    assert.equal(f.children.length, 0);
});

test('window-control rejects foreign/stale senders, detached subframes, unrelated pages and unknown actions', async t => {
    const f = fixture(t); const win = await f.host.open();
    const count = win.webContents.messages.length;
    for (const action of [undefined, null, '', [], {}, 'maximize', 'unmaximize', 'destroy', 'reload', '__proto__']) {
        assert.equal(f.control(win, action), false);
    }
    assert.equal(f.control(win, 'close', { sender: new EventEmitter() }), false);
    assert.equal(f.control(win, 'close', { senderFrame: {} }), false);
    win.webContents.mainFrame.detached = true;
    assert.equal(f.control(win, 'close'), false);
    win.webContents.mainFrame.detached = false;
    for (const url of ['https://example.com/', 'http://127.0.0.1:34568/', 'http://127.0.0.1:34567/api/devices',
        'http://127.0.0.1:34567/?other=1', 'file:///unrelated.html']) {
        win.url = url;
        assert.equal(f.control(win, 'close'), false);
        win.emit('maximize');
    }
    assert.equal(win.webContents.messages.length, count, 'untrusted pages receive no native state notifications');
    assert.equal(win.destroyed, false);
    win.url = 'http://127.0.0.1:34567/';
    win.destroy();
    const replacement = await f.host.open();
    assert.equal(f.control(win, 'close'), false);
    assert.equal(replacement.destroyed, false);
});

test('window controls remain available on loading and error status pages without a resolved viewer', async t => {
    const gate = deferred(); const f = fixture(t, () => gate.promise);
    const opening = f.host.open(); await tick();
    const win = f.windows[0];
    assert.equal(new URL(win.url).searchParams.get('state'), 'loading');
    assert.deepEqual(f.control(win, 'toggle-maximize'), { maximized: true });
    gate.reject(new Error('service unavailable'));
    await opening;
    assert.equal(new URL(win.url).searchParams.get('state'), 'error');
    assert.deepEqual(f.control(win, 'minimize'), { maximized: true });
    assert.deepEqual(f.control(win, 'close'), { maximized: true });
    assert.equal(win.destroyed, true);
});

test('chrome extracts Scriptorium rounded controls, semantic accent hover and danger close without classic overrides', () => {
    const scriptorium = fs.readFileSync(path.join(root, 'ScriptoriumModules/scriptorium.css'), 'utf8');
    const css = compilePalettes(['', '', '', scriptorium]).dark;
    const rules = cssTree.parse(css).children.toArray().filter(node => node.type === 'Rule');
    const declarations = selector => rules.filter(node => cssTree.generate(node.prelude) === selector).flatMap(node => node.block.children.toArray());
    const value = (selector, property) => cssTree.generate(declarations(selector).find(item => item.property === property).value);
    for (const selector of ['.title-bar-button', '.title-bar-button:hover', '.title-bar-button:active', '.title-bar-button.close-button:hover']) {
        assert.ok(declarations(selector).every(item => item.type !== 'Declaration' || item.important));
    }
    assert.equal(value('.title-bar-button', 'width'), '34px');
    assert.equal(value('.title-bar-button', 'height'), '32px');
    assert.equal(value('.title-bar-button', 'border-radius'), '7px');
    assert.equal(value('.title-bar-button:hover', 'background'), 'var(--scriptorium-accent-soft)');
    assert.equal(value('.title-bar-button:hover', 'color'), 'var(--highlight-text)');
    assert.equal(value('.title-bar-button.close-button:hover', 'background'), 'var(--danger-color)');
    assert.equal(value('.title-bar-button.close-button:hover', 'color'), 'white');
    assert.equal(value(':root', '--scriptorium-accent-soft').replace(/\s+/g, ''), 'color-mix(insrgb,var(--highlight-text)14%,transparent)');
    assert.match(css, /gap:2px!important/);
    assert.match(css, /app-region:no-drag!important/);
    assert.match(css, /prefers-reduced-motion:reduce/);
    const chromeRules = rules.filter(node => cssTree.generate(node.prelude) !== ':root').map(node => cssTree.generate(node)).join('');
    assert.doesNotMatch(chromeRules, /border-radius:0|\.icon-button|\.window-button|\.sidebar|\.scriptorium|@import|#EF5350|#2563EB/i);
});

test('presentation injects project primitives without layers/imports or unrelated components and maps current token mode to root', () => {
    const tokens = fs.readFileSync(path.join(root, 'styles/ui-system/tokens.css'), 'utf8');
    const components = fs.readFileSync(path.join(root, 'styles/ui-system/components.css'), 'utf8');
    const css = compilePalettes(['', tokens, components, '']).light;
    const ast = cssTree.parse(css);
    assert.doesNotMatch(css, /@layer|@import|\.vcp-ui-modal|\.vcp-ui-tabs|\.vcp-ui-range|\.vcp-ui-async-boundary/);
    for (const name of ['button', 'icon-button', 'native-input', 'native-select']) assert.match(css, new RegExp(`\\.vcp-ui-${name}`));
    assert.ok(ast.children.toArray().some(node => node.type === 'Rule' && cssTree.generate(node.prelude).includes('[data-size="sm"]')));
    const sample = '@layer vcp-ui.tokens{:root{--size:28px;--surface:var(--primary-bg)}body[data-vcp-theme="light"]{--surface:var(--secondary-bg)}}';
    const palette = compilePalettes(['', sample, '', '']);
    assert.match(palette.dark, /--surface:var\(--primary-bg\)/);
    assert.doesNotMatch(palette.dark, /--surface:var\(--secondary-bg\)/);
    const light = palette.light;
    assert.match(light, /:root\{--surface:var\(--secondary-bg\)\}/);
    assert.doesNotMatch(light, /body\[/);
    const themed = compilePalettes([':root{--input-bg:#111;--secondary-bg:#222;--button-hover-bg:var(--highlight-text);--highlight-text:#f00}body.light-theme{--input-bg:#fff;--secondary-bg:#eee}', sample, '', '']).light;
    assert.match(themed, /--secondary-bg:#eee !important/);
    assert.match(themed, /--input-bg:#fff !important/);
    assert.match(themed, /--highlight-text:#f00 !important/);
});

test('settings opens a single isolated non-modal child without replacing or reinitializing the viewer', async t => {
    let resolves = 0;
    const f = fixture(t, async () => { resolves++; return 'http://127.0.0.1:34567/'; });
    const main = await f.host.open();
    const history = [...main.history];
    assert.equal(await f.openSettings(main), true);
    const child = f.windows[1];
    assert.equal(child.config.parent, main);
    assert.equal(child.config.modal, false);
    assert.equal(child.config.frame, false);
    assert.equal(child.config.title, '安卓显示屏设置');
    assert.equal(child.config.width, 500);
    assert.equal(child.config.height, 680);
    assert.equal(child.config.minWidth, 360);
    const { backgroundThrottling, ...mainIsolation } = main.config.webPreferences;
    assert.equal(backgroundThrottling, false, 'video keeps rendering while settings covers the main window');
    assert.deepEqual(child.config.webPreferences, mainIsolation);
    assert.equal(child.config.webPreferences.session, main.config.webPreferences.session);
    assert.equal(Object.hasOwn(child.config, 'titleBarOverlay'), false);
    assert.equal(Object.hasOwn(child.config, 'titleBarStyle'), false);
    assert.equal(child.url, 'http://127.0.0.1:34567/settings?section=display');
    child.minimized = true;
    const loads = child.history.length;
    assert.equal(await f.openSettings(main, 'display'), true);
    assert.equal(child.minimized, false);
    assert.equal(child.history.length, loads);
    assert.equal(await f.openSettings(main, 'connection'), true);
    assert.equal(child.url, 'http://127.0.0.1:34567/settings?section=connection');
    assert.equal(await f.openSettings(main, 'status'), true);
    assert.equal(child.url, 'http://127.0.0.1:34567/settings?section=status');
    assert.equal(f.windows.length, 2);
    assert.equal(f.children.length, 2);
    assert.equal(f.windowService.attached, main);
    assert.ok(f.ready.every(([, context]) => context.sender === main.webContents));
    assert.deepEqual(main.history, history);
    assert.equal(resolves, 1);
});

test('settings open is main-frame/main-viewer only and sections cannot become URLs or query injection', async t => {
    const f = fixture(t); const main = await f.host.open();
    for (const section of [null, '', [], {}, 'DISPLAY', 'unknown', '/settings', 'https://example.com/', 'display&x=1', 'connection#x']) {
        assert.equal(await f.openSettings(main, section), false);
    }
    assert.equal(await f.openSettings(main, 'display', { sender: new EventEmitter() }), false);
    assert.equal(await f.openSettings(main, 'display', { senderFrame: {} }), false);
    main.webContents.mainFrame.detached = true;
    assert.equal(await f.openSettings(main, 'display'), false);
    main.webContents.mainFrame.detached = false;
    for (const url of ['http://127.0.0.1:34567/settings?section=display', 'https://example.com/', 'http://127.0.0.1:34568/',
        pathToFileURL(path.join(root, 'modules/android-display/status.html')).href]) {
        main.url = url;
        assert.equal(await f.openSettings(main, 'display'), false, url);
    }
    assert.equal(f.windows.length, 1);
    main.url = 'http://127.0.0.1:34567/';
    assert.equal(await f.openSettings(main), true);
    assert.equal(await f.openSettings(f.windows[1], 'connection'), false);
    main.destroy();
    assert.equal(await f.openSettings(main), false);
});

test('settings navigation permits only canonical section queries and rejects viewer/API/status/popups/webviews/subframes', async t => {
    const f = fixture(t); const main = await f.host.open();
    await f.openSettings(main);
    const child = f.windows[1], origin = 'http://127.0.0.1:34567';
    const status = pathToFileURL(path.join(root, 'modules/android-display/status.html')).href;
    for (const url of [origin + '/', origin + '/index.html', origin + '/api/devices', origin + '/settings',
        origin + '/settings?section=display&x=1', origin + '/settings?section=display&section=connection',
        origin + '/settings?section=%64isplay', origin + '/settings?section=display#x', origin + '/settings?section=bogus',
        'http://u:p@127.0.0.1:34567/settings?section=display', 'https://example.com/',
        'http://127.0.0.1:34568/settings?section=display', 'http://localhost:34567/settings?section=display',
        'javascript:alert(1)', status, status + '?state=retry']) {
        for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) assert.equal(f.navigate(child, url, event), true, url);
    }
    for (const section of ['display', 'connection', 'status']) {
        assert.equal(f.navigate(child, `${origin}/settings?section=${section}`), false);
        assert.equal(f.navigate(main, `${origin}/settings?section=${section}`), true, 'main cannot navigate to its settings child page');
    }
    assert.deepEqual(child.webContents.popup({ url: origin + '/' }), { action: 'deny' });
    for (const event of ['will-attach-webview', 'will-frame-navigate']) {
        let prevented = false;
        child.webContents.emit(event, { url: child.url, isMainFrame: false, preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
    }
});

test('child controls address only child; fit is main-only, and native state/theme updates stay per-window', async t => {
    const f = fixture(t); const main = await f.host.open();
    await f.openSettings(main);
    const child = f.windows[1], history = [...main.history];
    assert.equal(f.fit(child, { width: 1080, height: 2400, chromeHeight: 48 }), false);
    assert.deepEqual(f.control(child, 'minimize'), { maximized: false });
    assert.equal(child.minimized, true);
    assert.equal(main.minimized, false);
    const mainMessages = main.webContents.messages.length;
    assert.deepEqual(f.control(child, 'toggle-maximize'), { maximized: true });
    assert.equal(main.isMaximized(), false);
    assert.equal(main.webContents.messages.length, mainMessages);
    assert.deepEqual(child.webContents.messages.at(-1), ['android-display:window-state', { maximized: true }]);
    assert.deepEqual(f.control(child, 'close', { senderFrame: {} }), false);
    const childUrl = child.url, childCount = child.webContents.messages.length;
    for (const url of ['http://127.0.0.1:34567/', 'http://127.0.0.1:34567/settings?section=display&extra=1',
        'https://example.com/', pathToFileURL(path.join(root, 'modules/android-display/status.html')).href]) {
        child.url = url;
        assert.equal(f.control(child, 'close'), false);
        child.emit('maximize');
    }
    assert.equal(child.webContents.messages.length, childCount, 'untrusted child documents receive no native state');
    child.url = childUrl;
    child.webContents.mainFrame.detached = true;
    assert.equal(f.control(child, 'close'), false);
    child.webContents.mainFrame.detached = false;
    await f.host.refreshTheme();
    f.theme.shouldUseDarkColors = false;
    await f.host.refreshTheme();
    for (const win of [main, child]) {
        assert.match(win.webContents.css.at(-1), /color-scheme:light !important/);
        assert.match(win.webContents.css.at(-1), /border-radius:7px!important/);
        assert.match(win.webContents.css.at(-1), /\.vcp-ui-native-select/);
        assert.ok(win.webContents.cssOptions.every(options => options.cssOrigin === 'author'));
        assert.ok(win.webContents.removedCss.length > 0);
    }
    assert.deepEqual(f.control(child, 'close'), { maximized: true });
    assert.equal(child.destroyed, true);
    assert.equal(main.destroyed, false);
    assert.equal(f.host.getWindow(), main);
    assert.deepEqual(main.history, history);
    assert.deepEqual(f.children, [main]);
    assert.equal(f.control(child, 'close'), false);
    assert.equal(await f.openSettings(main), true);
    assert.equal(f.windows.length, 3);
    assert.notEqual(f.windows[2], child);
});

test('child-to-viewer actions have fixed enum, child main-frame authorization and never relay into child', async t => {
    const f = fixture(t); const main = await f.host.open();
    assert.equal(f.viewerAction(main, 'fit'), false);
    await f.openSettings(main);
    const child = f.windows[1];
    const childCount = child.webContents.messages.length;
    for (const action of ['fit', 'reconnect']) {
        assert.equal(f.viewerAction(child, action), true);
        assert.deepEqual(main.webContents.messages.at(-1), ['android-display:viewer-action', { action }]);
    }
    const mainCount = main.webContents.messages.length;
    for (const action of [undefined, null, {}, [], 'reload', 'fitWindow', 'close', 'javascript:alert(1)']) assert.equal(f.viewerAction(child, action), false);
    assert.equal(f.viewerAction(main, 'fit'), false);
    assert.equal(f.viewerAction(child, 'fit', { sender: main.webContents }), false);
    assert.equal(f.viewerAction(child, 'fit', { senderFrame: main.webContents.mainFrame }), false);
    child.webContents.mainFrame.detached = true;
    assert.equal(f.viewerAction(child, 'fit'), false);
    child.webContents.mainFrame.detached = false;
    const childUrl = child.url;
    child.url = 'http://127.0.0.1:34567/';
    assert.equal(f.viewerAction(child, 'fit'), false);
    child.url = childUrl;
    for (const url of ['https://example.com/', pathToFileURL(path.join(root, 'modules/android-display/status.html')).href]) {
        main.url = url;
        assert.equal(f.viewerAction(child, 'fit'), false);
    }
    assert.equal(main.webContents.messages.length, mainCount);
    assert.equal(child.webContents.messages.length, childCount);
});

test('concurrent settings opens reuse a pending child and last section wins without touching main', async t => {
    const gate = deferred(); let loads = 0;
    const f = fixture(t, undefined, { beforeLoad(_win, url) { if (url.includes('/settings') && ++loads === 1) return gate.promise; } });
    const main = await f.host.open(), history = [...main.history];
    const first = f.openSettings(main, 'display');
    const second = f.openSettings(main, 'connection');
    assert.equal(f.windows.length, 2);
    gate.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(f.windows[1].url, 'http://127.0.0.1:34567/settings?section=connection');
    assert.deepEqual(main.history, history);
    assert.equal(loads, 2);
});

test('parent closure and disposal destroy child and release every owned IPC and event listener', async t => {
    for (const dispose of [false, true]) {
        const f = fixture(t); const main = await f.host.open();
        await f.openSettings(main);
        const child = f.windows[1];
        if (dispose) f.host.dispose(); else main.close();
        assert.equal(main.destroyed, true);
        assert.equal(child.destroyed, true);
        assert.equal(f.children.length, 0);
        for (const win of [main, child]) {
            assert.deepEqual(win.eventNames(), []);
            assert.deepEqual(win.webContents.eventNames(), []);
        }
        if (dispose) { assert.equal(f.handlers.size, 0); assert.equal(f.theme.listenerCount('updated'), 0); }
    }
});

test('closing parent aborts an in-flight settings load and cannot resurrect child or main', async t => {
    const gate = deferred();
    const f = fixture(t, undefined, { beforeLoad(_win, url) { if (url.includes('/settings')) return gate.promise; } });
    const main = await f.host.open();
    const pending = f.openSettings(main, 'display');
    const child = f.windows[1];
    main.destroy();
    assert.equal(await pending, false);
    assert.equal(child.destroyed, true);
    assert.equal(f.children.length, 0);
    gate.resolve(); await tick();
    assert.equal(f.host.getWindow(), null);
    assert.equal(f.children.length, 0);
});

test('closing a loading child aborts only its own pending load and preserves main', async t => {
    const gate = deferred();
    const f = fixture(t, undefined, { beforeLoad(_win, url) { if (url.includes('/settings')) return gate.promise; } });
    const main = await f.host.open(), history = [...main.history];
    const pending = f.openSettings(main);
    const child = f.windows[1];
    child.close();
    assert.equal(await pending, false);
    assert.equal(f.host.getSettingsWindow(), null);
    assert.equal(f.host.getWindow(), main);
    assert.equal(main.destroyed, false);
    assert.deepEqual(main.history, history);
    gate.resolve(); await tick();
    assert.equal(f.host.getSettingsWindow(), null);
});

test('settings timeout bounds its own pending load without changing the main viewer', async t => {
    const gate = deferred();
    const f = fixture(t, undefined, { timeoutMs: 15, beforeLoad(_win, url) { if (url.includes('/settings')) return gate.promise; } });
    const main = await f.host.open(), history = [...main.history];
    assert.equal(await f.openSettings(main), false);
    assert.equal(f.windows[1].destroyed, true);
    assert.equal(main.destroyed, false);
    assert.deepEqual(main.history, history);
    assert.equal(f.host.getSettingsWindow(), null);
    gate.resolve(); await tick();
    assert.equal(f.host.getSettingsWindow(), null);
});

test('settings load failures close only child while main remains ready', async t => {
    const f = fixture(t, undefined, { beforeLoad(_win, url) { if (url.includes('/settings')) throw new Error('settings unavailable'); } });
    const main = await f.host.open(), history = [...main.history];
    assert.equal(await f.openSettings(main), false);
    assert.equal(main.destroyed, false);
    assert.equal(f.windows[1].destroyed, true);
    assert.deepEqual(main.history, history);
    assert.deepEqual(f.children, [main]);
});

test('runtime resolver awaits the existing host and never requires or initializes another controller', async () => {
    const gate = deferred(); let gets = 0, ensures = 0;
    const resolve = createAndroidDisplayResolver({ ensureServer: () => gate.promise, getServiceModule(name) {
        gets++; assert.equal(name, 'AndroidController'); return { async ensureDisplayUrl() { ensures++; return 'http://127.0.0.1:12345/'; } };
    } });
    const pending = resolve(); await tick(); assert.equal(gets, 0);
    gate.resolve({}); assert.equal(await pending, 'http://127.0.0.1:12345/');
    assert.equal(gets, 1); assert.equal(ensures, 1);
    await assert.rejects(createAndroidDisplayResolver({ ensureServer: async () => null, getServiceModule: () => assert.fail() })(), /分布式服务/);
    await assert.rejects(createAndroidDisplayResolver({ ensureServer: async () => ({}), getServiceModule: () => null })(), /插件未加载/);
});

test('host display readiness binds a viewer without device discovery, screenshot prewarm, or tool dispatch', async () => {
    let starts = 0, captures = 0;
    const f = await harness({ frames: { async capture() { captures++; throw new Error('must not prewarm'); } },
        streamServer: { async start() { starts++; }, async stop() {}, url: () => 'http://127.0.0.1:34567/' } });
    const before = f.calls.length;
    assert.equal(await f.service.ensureDisplayUrl(), 'http://127.0.0.1:34567/');
    assert.equal(captures, 0); assert.equal(f.calls.length, before);
    assert.ok(starts >= 1);
    await f.service.cleanup();
});

test('vendor paths use real unpacked files only in packaged app.asar directories', () => {
    const dev = path.join(root, 'VCPDistributedServer', 'Plugin', 'AndroidController', 'lib');
    assert.equal(vendorPath('scrcpy-server-v5.0.1', dev), path.resolve(dev, '../vendor/scrcpy-server-v5.0.1'));
    const packed = path.join(root, 'resources', 'app.asar', 'VCPDistributedServer', 'Plugin', 'AndroidController', 'lib');
    assert.match(vendorPath('u2-server-0.5.0.apk', packed), /app\.asar\.unpacked[\\/]/);
    assert.match(vendorPath('vcp-ui-owner.jar', packed), /app\.asar\.unpacked[\\/]/);
    assert.doesNotMatch(vendorPath('vcp-ui-owner.jar', path.join(root, 'app.asar-source', 'lib')), /app\.asar\.unpacked/);
});

test('status page errors are plain text and no privileged APIs or external resources are exposed', () => {
    const file = path.join(root, 'modules/android-display/status.html');
    const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { url: `${pathToFileURL(file)}?state=error&message=${encodeURIComponent('<img src=x onerror=evil()>')}`, runScripts: 'outside-only' });
    try {
        dom.window.eval(fs.readFileSync(path.join(root, 'modules/android-display/status.js'), 'utf8'));
        assert.equal(dom.window.document.getElementById('message').textContent, '<img src=x onerror=evil()>');
        assert.equal(dom.window.document.querySelector('main img'), null);
        assert.equal(dom.window.document.getElementById('retry').hidden, false);
        assert.equal(dom.window.document.querySelectorAll('script').length, 1);
        assert.equal(dom.window.document.querySelector('script').getAttribute('src'), 'status.js');
    } finally { dom.window.close(); }
});
