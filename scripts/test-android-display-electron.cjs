'use strict';

// Run with Electron directly. No controller initialization or ADB is performed.
const { app, BrowserWindow, session, nativeTheme, ipcMain, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createAndroidDisplayWindow } = require('../modules/services/androidDisplayWindow');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
const { DisplayPreferences } = require('../VCPDistributedServer/Plugin/AndroidController/lib/display-preferences');
const { ControllerSettings } = require('../VCPDistributedServer/Plugin/AndroidController/lib/controller-settings');
const windowService = require('../modules/services/windowService');

const root = path.resolve(__dirname, '..');
const output = process.env.ANDROID_DISPLAY_TEST_OUTPUT || path.join(root, 'artifacts', 'android-display-settings');
const profile = path.join(os.tmpdir(), `vcp-android-display-smoke-${process.pid}`);
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
let host, server, win;
const settings = () => host.getSettingsWindow();
const settingsCode = code => settings().webContents.executeJavaScript(code);
async function openSettings() {
    await win.webContents.executeJavaScript("document.getElementById('openSettings').click()");
    await waitFor(() => !!settings() && settings().webContents.getURL().includes('/settings?section=display'), 'settings child URL');
    await waitFor(() => settingsCode("!!document.getElementById('applyQuality') && !document.getElementById('applyQuality').disabled"), 'child quality read');
    await host.refreshTheme();
}
async function closeSettings() {
    await settingsCode("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitFor(() => !settings(), 'settings child closed');
}
let failed = false;

async function waitFor(check, label, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${label}`);
}
async function captureSettled(target = win) {
    await target.webContents.executeJavaScript(`Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            .then(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
                .map(animation => animation.finished.catch(() => {})))),
        new Promise(resolve => setTimeout(resolve, 600))
    ])`);
    return (await target.webContents.capturePage()).toPNG();
}
async function observe() {
    return win.webContents.executeJavaScript(`(() => {
        const rect = selector => {
            const r = document.querySelector(selector)?.getBoundingClientRect();
            return r ? { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom, right:r.right } : null;
        };
        const style = getComputedStyle(document.documentElement);
        return {
            title:document.title, url:location.href, bg:style.getPropertyValue('--bg').trim(), scheme:style.colorScheme,
            width:innerWidth, height:innerHeight, scrollWidth:document.documentElement.scrollWidth,
            header:rect('header'), titleLabel:rect('header .title'), headerActions:rect('header .header-actions'),
            settingsButton:rect('#openSettings'), windowControls:rect('header > .title-bar-controls'),
            chromeButtons:document.querySelectorAll('header > .title-bar-controls > .title-bar-button').length,
            stage:rect('#stage'), navigation:rect('#deviceNavigation'), settings:rect('#settingsPage'), quality:rect('#qualityPanel'),
            streamState:document.getElementById('stage')?.dataset.streamState,
            settingsHidden:document.getElementById('settingsPage')?.classList.contains('hidden'),
            fitting:document.getElementById('fitWindow')?.disabled,
            guide:rect('.guide-layout'), body:document.body.innerText,
            retry:document.querySelector('#retry')?.hidden,
            bridge:typeof window.electronAPI, require:typeof window.require, native:Object.keys(window.androidDisplay || {}),
            controls:[...document.querySelectorAll('.toolbar button')].map(node=>({text:node.textContent,rect:(()=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}})()})),
        };
    })()`);
}

app.whenReady().then(async () => {
    await fs.mkdir(output, { recursive: true });
    const calls = [];
    const qualityCalls = [];
    let deviceReady = false;
    let framesAvailable = false;
    const png = await require('sharp')({ create: { width: 360, height: 720, channels: 3, background: '#24313f' } }).png().toBuffer();
    let frame = { seq: 1, capturedAt: Date.now(), mime: 'image/png', buffer: png };
    const sinks = new Set();
    const frameHub = {
        latestOrNull: () => framesAvailable ? frame : null,
        status: () => ({ streaming: sinks.size > 0, subscribers: sinks.size }),
        subscribe(sink) { sinks.add(sink); return () => sinks.delete(sink); },
        pauseLoop() {},
    };
    const scrcpyHub = {
        config: { maxFps: 30, bitRate: 2000000, maxSize: 720, maxShortEdge: null,
            sourceWidth: 1080, sourceHeight: 2160 }, state: 'stopped',
        status() { return { ...this.config, state: this.state }; },
        configure(config) { qualityCalls.push(config); Object.assign(this.config, config);
            if (Object.hasOwn(config, 'maxSize')) this.config.maxShortEdge = null; },
        async start() { throw new Error('隔离验收：没有手机编码器'); },
        async stop() { this.state = 'stopped'; },
    };
    const preferencesFile = path.join(profile, 'android-display-preferences.json');
    const displayPreferences = new DisplayPreferences({ file: preferencesFile, defaults: { maxFps: 30, bitRate: 2000000, maxSize: 720, fitWidth: false } });
    await displayPreferences.load();
    server = new StreamServer({ port: 0, frameHub, scrcpyHub, displayPreferences, logger: { log() {}, warn() {} }, deviceApi: {
        async adbStatus() { calls.push('adb-status'); return { ok: true, available: true, addresses: [{ address:'192.168.1.20', interface:'fixture' }] }; },
        async listDevices() { calls.push('devices'); return { ok: true, devices: deviceReady ? [{ serial: 'fixture-device', state: 'device', model: '隔离靶场' }] : [] }; },
        async connect() { throw new Error('Opening a viewer must not connect a device'); },
        async discover() { throw new Error('Opening a viewer must not scan the LAN'); },
    } });
    await server.start();

    const asar = require('@electron/asar');
    const packedSource = path.join(profile, 'packed-source');
    const packagedLib = path.join(packedSource, 'lib');
    await fs.mkdir(packagedLib, { recursive: true });
    await fs.mkdir(path.join(packedSource, 'vendor'), { recursive: true });
    const controllerRoot = path.join(root, 'VCPDistributedServer/Plugin/AndroidController');
    await fs.copyFile(path.join(controllerRoot, 'lib/vendor-path.js'), path.join(packagedLib, 'vendor-path.js'));
    const carriers = ['scrcpy-server-v5.0.1', 'u2-server-0.5.0.apk', 'vcp-ui-owner.jar'];
    for (const name of carriers) await fs.copyFile(path.join(controllerRoot, 'vendor', name), path.join(packedSource, 'vendor', name));
    const archive = path.join(profile, 'app.asar');
    await asar.createPackageWithOptions(packedSource, archive, { unpack: '**/vendor/*' });
    const packedResolver = require(path.join(archive, 'lib/vendor-path.js'));
    for (const name of carriers) {
        const realPath = packedResolver.vendorPath(name);
        assert.ok(realPath.includes('app.asar.unpacked'));
        assert.ok((await fs.stat(realPath)).size > 0);
    }
    let available = false;
    await fs.mkdir(profile, { recursive: true });
    const controllerFile = path.join(profile, 'config.env');
    await fs.writeFile(controllerFile, '# isolated controller settings\nLOOM_APP_ID=untouched\n');
    const controllerStore = new ControllerSettings({ file: controllerFile });
    let authorizationOpens = 0;
    host = createAndroidDisplayWindow({ BrowserWindow, session, nativeTheme, windowService, ipcMain, screen,
        projectRoot: root, openChildWindows: [],
        getControllerService: () => ({ readControllerSettings: () => controllerStore.read(),
            saveControllerSettings: (request, options) => controllerStore.save(request, options) }),
        openSystemAuthorization: () => { authorizationOpens++; },
        resolveDisplayUrl: async () => { if (!available) throw new Error('隔离验收：服务未就绪，点击重试。'); return server.url(); },
    });
    nativeTheme.themeSource = 'dark';
    win = await host.open();
    await host.refreshTheme();
    const state = await observe();
    assert.equal(state.bridge, 'undefined'); assert.equal(state.require, 'undefined');
    assert.equal(state.retry, false); assert.match(state.body, /隔离验收/);
    await fs.writeFile(path.join(output, 'status.png'), await captureSettled());
    available = true;

    await win.webContents.executeJavaScript("document.getElementById('retry').click()");
    await waitFor(() => win.webContents.getURL() === new URL(server.url()).href, 'native retry navigation');
    await waitFor(() => calls.includes('devices'), 'same-origin authenticated device read');
    await host.refreshTheme();
    let view = await observe();
    assert.match(view.title, /安卓显示屏/);
    assert.equal(view.scheme, 'dark');
    assert.equal(view.bridge, 'undefined'); assert.equal(view.require, 'undefined');
    assert.equal(view.scrollWidth <= view.width, true);
    assert.ok(view.header.height >= 48 && view.header.height <= 50);
    assert.deepEqual(view.native.sort(), ['fitWindow', 'openSettings', 'requestViewerAction',
        'readControllerSettings', 'saveControllerSettings', 'openSystemAuthorization'].sort());
    assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('.title-bar-button')).borderRadius"), '7px', 'Scriptorium hover shape');
    assert.ok(view.stage.height > 400, 'hidden quality panel must not displace the flexible screen row');
    assert.ok(Math.abs(view.stage.bottom - view.height) <= 1, 'video extends to the bottom without a footer');
    assert.ok(Math.abs(view.stage.y - view.header.bottom) <= 1, 'video starts directly below titlebar');
    assert.equal(view.settingsHidden, true);
    assert.equal(view.chromeButtons, 3, 'VCPChat supplies minimize, maximize and close');
    assert.ok(view.settingsButton.y >= 0 && view.settingsButton.right <= view.windowControls.x, 'settings and custom controls do not overlap');
    assert.ok(view.windowControls.right <= view.width);
    assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('header > .header-actions > button, header > .title-bar-controls > button')].length"), 4);
    await win.webContents.executeJavaScript("document.querySelector('.title-bar-button[aria-label=\"最大化\"]').click()");
    await waitFor(() => win.isMaximized(), 'custom maximize control');
    await waitFor(() => win.webContents.executeJavaScript("!!document.querySelector('.title-bar-button[aria-label=\"还原\"]')"), 'restored action label');
    await win.webContents.executeJavaScript("document.querySelector('.title-bar-button[aria-label=\"还原\"]').click()");
    await waitFor(() => !win.isMaximized(), 'custom restore control');
    await win.webContents.executeJavaScript("document.querySelector('.title-bar-button[aria-label=\"最小化\"]').click()");
    await waitFor(() => win.isMinimized(), 'custom minimize control');
    win.restore();
    await waitFor(() => !win.isMinimized(), 'restore minimized window');
    assert.deepEqual([...new Set(calls)].sort(), ['adb-status', 'devices']);
    await fs.writeFile(path.join(output, 'viewer-dark.png'), await captureSettled());
    await openSettings();
    const firstSettings = settings();
    await win.webContents.executeJavaScript("document.getElementById('openSettings').click()");
    assert.equal(settings(), firstSettings, 'settings is a singleton child');
    assert.equal(settings().getParentWindow(), win);
    assert.equal((await observe()).settingsHidden, true, 'main page never swaps to settings');
    assert.equal(await settingsCode("document.getElementById('qualityFps').value"), '30');
    assert.equal(await settingsCode("getComputedStyle(document.getElementById('qualitySize')).borderRadius"), '10px');
    assert.ok(await settingsCode("document.getElementById('qualitySize').clientWidth > 200"));
    await settingsCode(`document.getElementById('qualityFps').value='60';
        document.getElementById('qualityBitRate').value='8000000';
        document.getElementById('qualitySize').value='short:1080'; document.getElementById('applyQuality').click()`);
    await waitFor(() => settingsCode("document.getElementById('qualityMessage').textContent.includes('下次启动')"), 'save without a device');
    assert.deepEqual(JSON.parse(await fs.readFile(preferencesFile, 'utf8')), { maxFps: 60, bitRate: 8000000, fitWidth: false, maxShortEdge: 1080 });
    assert.deepEqual(qualityCalls, [{ maxFps: 60, bitRate: 8000000, maxShortEdge: 1080 }]);
    await fs.writeFile(path.join(output, 'viewer-quality-dark.png'), await captureSettled(settings()));
    await settingsCode("document.getElementById('controllerTab').click()");
    await waitFor(() => settingsCode("!document.getElementById('controllerFields').disabled"), 'native controller preferences');
    await settingsCode(`document.getElementById('controllerAutoWake').checked=false;
        document.getElementById('controllerDenyPackages').value='com.example.private';
        document.getElementById('controllerConfirmWrite').checked=true;
        document.getElementById('saveController').click()`);
    await waitFor(() => settingsCode("document.getElementById('controllerMessage').textContent.includes('设置已保存')"), 'durable native config save');
    const controllerSaved = await new ControllerSettings({ file: controllerFile }).read();
    assert.equal(controllerSaved.values.AUTO_WAKE, false);
    assert.deepEqual(JSON.parse(controllerSaved.values.INTERACTION_POLICY).denyPackages, ['com.example.private']);
    assert.ok((await fs.readFile(controllerFile, 'utf8')).includes('LOOM_APP_ID=untouched'));
    await settingsCode("document.getElementById('openSystemAuthorization').click()");
    await waitFor(() => authorizationOpens === 1, 'native authorization handoff');
    await settingsCode("document.getElementById('settingsPage').scrollTop=0");
    await fs.writeFile(path.join(output, 'controller-dark.png'), await captureSettled(settings()));
    await closeSettings();
    nativeTheme.themeSource = 'light';
    await waitFor(() => !nativeTheme.shouldUseDarkColors, 'native light theme');
    await host.refreshTheme();
    await waitFor(async () => (await observe()).scheme === 'light', 'applied light palette');
    await openSettings();
    await settingsCode("document.getElementById('controllerTab').click()");
    await waitFor(() => settingsCode("!document.getElementById('controllerFields').disabled"), 'reopened controller values');
    assert.equal(await settingsCode("document.getElementById('controllerAutoWake').checked"), false);
    assert.equal(await settingsCode("document.getElementById('controllerDenyPackages').value"), 'com.example.private');
    await fs.writeFile(path.join(output, 'controller-light.png'), await captureSettled(settings()));
    settings().setSize(360, 680);
    await waitFor(() => settingsCode('innerWidth === 360'), 'narrow settings viewport');
    await settingsCode("document.querySelectorAll('#controllerFields details').forEach(node=>node.open=true)");
    await settingsCode("new Promise(resolve=>requestAnimationFrame(()=>{document.getElementById('controllerWidth').scrollIntoView({block:'center'});resolve()}))");
    await waitFor(() => settingsCode("document.getElementById('settingsPage').scrollTop > 500 && document.getElementById('controllerWidth').getBoundingClientRect().bottom < innerHeight"), 'visible advanced preferences');
    assert.ok(await settingsCode("document.getElementById('settingsPage').scrollWidth <= document.getElementById('settingsPage').clientWidth"), 'narrow controller has no horizontal overflow');
    await fs.writeFile(path.join(output, 'controller-advanced-narrow.png'), await captureSettled(settings()));
    await closeSettings();
    win.setSize(720, 720);
    await waitFor(async () => (await observe()).width <= 720, 'narrow layout');
    view = await observe();
    assert.equal(view.scheme, 'light');
    assert.equal(view.scrollWidth <= view.width, true);
    await fs.writeFile(path.join(output, 'viewer-light.png'), await captureSettled());
    const cookies = await win.webContents.session.cookies.get({ url: server.url() });
    assert.ok(cookies.some(cookie => cookie.httpOnly && cookie.name.startsWith('android_display_')));
    deviceReady = true;
    await win.reload();
    await waitFor(async () => win.webContents.executeJavaScript("document.getElementById('stage')?.dataset.streamState === 'loading'"), 'loading transition');
    assert.ok(await win.webContents.executeJavaScript("!document.getElementById('screen').hasAttribute('src') && getComputedStyle(document.getElementById('screen')).display === 'none'"), 'never show a broken image before frame');
    await fs.writeFile(path.join(output, 'viewer-loading.png'), await captureSettled());
    framesAvailable = true;
    await waitFor(() => sinks.size === 1, 'JPEG subscribed');
    for (const sink of sinks) sink(frame);
    await waitFor(async () => win.webContents.executeJavaScript("document.getElementById('stage')?.dataset.streamState === 'ready' && document.getElementById('screen')?.naturalWidth === 360"), 'decoded first frame reveals video');
    assert.equal(server.metrics().jpegViewers, 1);
    const fits = [];
    async function checkFit(ratio, name) {
        await waitFor(async () => {
            const v = await observe();
            return !v.fitting && v.stage.height > 100 && Math.abs(v.stage.width / v.stage.height - ratio) < 0.006;
        }, name);
        const v = await observe();
        assert.ok(Math.abs(v.stage.bottom - v.navigation.y) <= 1);
        assert.ok(Math.abs(v.navigation.bottom - v.height) <= 1);
        assert.ok(v.navigation.height >= 44, 'separate bottom navigation never overlays video');
        assert.ok(Math.abs(v.stage.y - v.header.bottom) <= 1);
        assert.equal(v.settingsHidden, true);
        assert.equal(v.chromeButtons, 3);
        assert.ok(v.titleLabel.height < 24, 'compact title must stay on a single line');
        assert.ok(v.titleLabel.right <= v.headerActions.x, 'title must not overlap actions');
        assert.ok(v.headerActions.right <= v.windowControls.x, 'actions must not overlap the sole custom control set');
        assert.ok(v.windowControls.right <= v.width);
        assert.ok(v.scrollWidth <= v.width);
        const work = screen.getDisplayMatching(win.getBounds()).workArea;
        const b = win.getBounds();
        assert.ok(b.x >= work.x && b.y >= work.y && b.x + b.width <= work.x + work.width && b.y + b.height <= work.y + work.height);
        fits.push({ name, stage: v.stage, bounds: b });
    }
    await checkFit(0.5, 'automatic portrait fit');
    const saved = win.getBounds();
    await openSettings();
    assert.equal(await settingsCode("document.getElementById('qualityFps').value"), '60', 'reopened settings preserve saved frame rate');
    assert.equal(await settingsCode("document.getElementById('qualitySize').value"), 'short:1080');
    assert.equal(server.metrics().jpegViewers, 1, 'settings child never subscribes');
    await settingsCode("document.getElementById('applyQuality').click()");
    await waitFor(() => settingsCode("document.getElementById('qualityMessage').textContent.includes('没有手机编码器')"), 'truthful restart failure');
    assert.ok(await settingsCode("document.getElementById('qualityMessage').textContent.includes('配置已保存')"));
    assert.equal(qualityCalls.length, 2, 'configuration is never replayed after fallback');
    assert.equal(server.metrics().jpegViewers, 1);
    await fs.writeFile(path.join(output, 'viewer-quality-light.png'), await captureSettled(settings()));
    await closeSettings();
    await checkFit(0.5, 'closing settings restores screen area');
    win.setSize(600, 700);
    await waitFor(async () => (await observe()).width >= 580, 'manual resize');
    for (const sink of sinks) sink({ ...frame, seq: 2, capturedAt: Date.now() });
    await waitFor(() => win.webContents.executeJavaScript("document.getElementById('seq').textContent === '2'"), 'second frame');
    assert.equal(win.getBounds().width, 600, 'same-aspect frames preserve manual resizing');
    await openSettings();
    await settingsCode("document.getElementById('fitWindow').click()");
    await checkFit(0.5, 'explicit fit from child after manual resizing');
    await closeSettings();
    win.setBounds(saved);
    await checkFit(0.5, 'restore compact portrait');
    await fs.writeFile(path.join(output, 'viewer-stream.png'), await captureSettled());
    frame = { ...frame, seq: 3, capturedAt: Date.now(), buffer: await require('sharp')({ create: {
        width: 720, height: 360, channels: 3, background: '#24313f',
    } }).png().toBuffer() };
    for (const sink of sinks) sink(frame);
    await waitFor(() => win.webContents.executeJavaScript("document.getElementById('screen').naturalWidth === 720"), 'landscape frame');
    await checkFit(2, 'automatic landscape fit');
    await fs.writeFile(path.join(output, 'viewer-landscape.png'), await captureSettled());
    const before = win.webContents.getURL();
    await win.webContents.executeJavaScript("location.href='https://example.invalid/'");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(win.webContents.getURL(), before, 'external renderer navigation must not escape');
    const endpoint = new URL(server.url()).href;
    await win.webContents.executeJavaScript("document.querySelector('.title-bar-button.close-button').click()");
    await waitFor(() => host.getWindow() === null, 'custom close releases only its window');
    assert.equal((await fetch(`${endpoint}health`)).status, 200, 'closing viewer keeps shared service alive');
    await waitFor(() => server.metrics().jpegViewers === 0, 'viewer closes only its own subscription');
    win = await host.open();
    await waitFor(() => win.webContents.getURL() === endpoint, 'reopen');
    await host.refreshTheme();
    const reloadedPreferences = await new DisplayPreferences({ file: preferencesFile }).load();
    assert.equal(reloadedPreferences.maxShortEdge, 1080, 'new store instance restores durable quality');
    await openSettings();
    await settingsCode("document.getElementById('resetDisplay').click()");
    await waitFor(() => settingsCode("!document.getElementById('resetDisplay').disabled && document.getElementById('qualityFps').value === '30'"), 'reset display preferences');
    assert.deepEqual(await new DisplayPreferences({ file: preferencesFile }).load(), { maxFps: 30, bitRate: 2000000, maxSize: 540, fitWidth: false });
    await closeSettings();
    const result = { success: true, controllerSettings: true, authorizationOpens, displayReset: true,
        loadingTransition: true, settingsChild: true, persistentQuality: reloadedPreferences, bottomNavigation: true, backend: 'fake device / real Electron + authenticated HTTP and PNG WebSocket', calls, darkAndLight: true, packedCarriers: carriers.length,
        qualityCalls, geometry: fits, singleWindow: BrowserWindow.getAllWindows().length === 1,
        artifacts: ['status.png', 'viewer-dark.png', 'viewer-light.png', 'viewer-stream.png', 'viewer-quality-dark.png', 'viewer-quality-light.png', 'viewer-landscape.png',
            'controller-dark.png', 'controller-light.png', 'controller-advanced-narrow.png'] };
    await fs.writeFile(path.join(output, 'electron-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}).catch(async error => {
    failed = true; console.error(error);
    if (win && !win.isDestroyed()) {
        console.error(JSON.stringify(await observe()));
        await fs.writeFile(path.join(output, 'failure.png'), await captureSettled());
    }
}).finally(async () => {
    host?.dispose();
    await server?.stop();
    app.exit(failed ? 1 : 0);
});
