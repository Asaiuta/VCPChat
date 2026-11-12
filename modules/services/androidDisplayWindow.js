'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createAndroidDisplayTheme } = require('./androidDisplayTheme');

const { ANDROID_DISPLAY: APP_ID } = require('./windowAppIds');

function displayUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('安卓显示屏返回了无效的本地地址。');
    }
    return url.href;
}

async function within(promise, timeoutMs, signal) {
    let timer;
    let abort;
    const cancelled = new Promise((_, reject) => {
        abort = () => reject(new Error('显示窗口已关闭。'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([promise, cancelled, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('安卓服务仍在初始化。稍后点击重试，不会重复启动服务。')), timeoutMs);
        })]);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
}

function createAndroidDisplayWindow({ BrowserWindow, session, nativeTheme, windowService, ipcMain, screen,
    projectRoot, openChildWindows, resolveDisplayUrl, getControllerService, openSystemAuthorization,
    timeoutMs = 15000, logger = console, themeStyles = createAndroidDisplayTheme({ projectRoot }) }) {
    const statusFile = path.join(projectRoot, 'modules', 'android-display', 'status.html');
    const statusUrl = pathToFileURL(statusFile).href;
    const isolatedSession = session.fromPartition('android-display');
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);
    let window = null;
    let opening = null;
    let connecting = null;
    let allowedUrl = null;
    let disposed = false;
    let settingsWindow = null;
    const windowStates = new Map();
    let lifetime = null;
    const sections = new Set(['display', 'connection', 'status', 'controller']);
    const viewerActions = new Set(['fit', 'reconnect']);

    const live = win => !disposed && window === win && !win.isDestroyed();
    const isStatus = raw => {
        try { const url = new URL(raw); url.search = ''; url.hash = ''; return url.href === statusUrl; }
        catch { return false; }
    };
    const focus = win => {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return win;
    };

    function trusted(event, win) {
        return Boolean(win && !disposed && windowStates.has(win) && !win.isDestroyed()
            && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
            && !event.senderFrame?.detached && permitted(win.webContents.getURL(), win));
    }

    function windowControl(event, action) {
        const win = [...windowStates.keys()].find(candidate => event.sender === candidate.webContents);
        if (!trusted(event, win) || !['state', 'minimize', 'toggle-maximize', 'close'].includes(action)) return false;
        if (action === 'minimize') win.minimize();
        else if (action === 'toggle-maximize') {
            if (win.isMaximized()) win.unmaximize();
            else win.maximize();
        } else if (action === 'close') {
            const maximized = win.isMaximized();
            win.close();
            return { maximized };
        }
        return { maximized: win.isMaximized() };
    }

    function notifyWindowState(win) {
        if (!disposed && windowStates.has(win) && !win.isDestroyed() && permitted(win.webContents.getURL(), win)) {
            win.webContents.send('android-display:window-state', { maximized: win.isMaximized() });
        }
    }

    function fitWindow(event, geometry) {
        const win = window;
        if (!trusted(event, win) || !allowedUrl || isStatus(win.webContents.getURL())
            || win.isMaximized() || win.isFullScreen()) return false;
        if (!geometry || Array.isArray(geometry) || typeof geometry !== 'object'
            || Object.keys(geometry).some(key => !['width', 'height', 'chromeHeight'].includes(key))) return false;
        const { width, height, chromeHeight } = geometry;
        if (![width, height, chromeHeight].every(Number.isSafeInteger)
            || width < 1 || height < 1 || width > 16384 || height > 16384
            || chromeHeight < 48 || chromeHeight > 480) return false;
        const bounds = win.getBounds();
        const content = win.getContentBounds();
        const borderWidth = bounds.width - content.width;
        const borderHeight = bounds.height - content.height;
        const work = screen.getDisplayMatching(bounds).workArea;
        const ratio = width / height;
        if (ratio < 0.2 || ratio > 5) return false;
        const maxWidth = Math.min(1600, work.width) - borderWidth;
        const maxHeight = Math.min(1200, work.height) - borderHeight;
        const minWidth = Math.min(360 - borderWidth, maxWidth);
        const minHeight = Math.min(480 - borderHeight, maxHeight);
        const availableHeight = Math.max(1, Math.min(content.height, maxHeight) - chromeHeight);
        let viewWidth = Math.min(maxWidth, Math.max(minWidth, Math.round(availableHeight * ratio)));
        const viewHeight = Math.min(maxHeight, Math.max(minHeight, Math.round(viewWidth / ratio) + chromeHeight)) + borderHeight;
        viewWidth = Math.min(maxWidth, Math.max(minWidth, Math.round((viewHeight - borderHeight - chromeHeight) * ratio))) + borderWidth;
        const x = Math.max(work.x, Math.min(bounds.x, work.x + work.width - viewWidth));
        const y = Math.max(work.y, Math.min(bounds.y, work.y + work.height - viewHeight));
        win.setMinimumSize(Math.min(360, work.width), Math.min(480, work.height));
        win.setBounds({ x, y, width: viewWidth, height: viewHeight });
        return true;
    }

    async function refreshWindowTheme(win) {
        const state = windowStates.get(win);
        if (!state || disposed || win.isDestroyed()) return;
        const version = ++state.themeVersion;
        const current = () => !disposed && windowStates.get(win) === state && !win.isDestroyed() && version === state.themeVersion;
        try {
            const css = await themeStyles.get(nativeTheme.shouldUseDarkColors);
            if (!current()) return;
            if (state.cssKey && state.cssText === css) return;
            const nextKey = await win.webContents.insertCSS(css, { cssOrigin: 'author' });
            if (!current()) {
                if (!win.isDestroyed()) await win.webContents.removeInsertedCSS(nextKey);
                return;
            }
            const previous = state.cssKey;
            state.cssKey = nextKey;
            state.cssText = css;
            if (previous) await win.webContents.removeInsertedCSS(previous);

        } catch (error) { logger.warn('[AndroidDisplay] Theme update failed:', error.message); }
    }

    async function refreshTheme() {
        await Promise.all([...windowStates.keys()].map(refreshWindowTheme));
    }

    async function showStatus(win, state, message = '') {
        if (!live(win)) return;
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
        allowedUrl = null;
        await win.loadFile(statusFile, { query: { state, message } });
    }

    async function connect(win) {
        if (connecting) return connecting;
        const pending = (async () => {
            try {
                await showStatus(win, 'loading');
                if (!live(win)) return;
                const url = displayUrl(await within(Promise.resolve().then(resolveDisplayUrl), timeoutMs, lifetime.signal));
                if (!live(win)) return;
                allowedUrl = url;
                await within(win.loadURL(url), timeoutMs, lifetime.signal);
            } catch (error) {
                if (!live(win)) return;
                logger.warn('[AndroidDisplay] Cannot open viewer:', error.message);
                await showStatus(win, 'error', error.message);
            }
        })();
        connecting = pending;
        try { await pending; }
        finally { if (connecting === pending) connecting = null; }
    }

    function permitted(raw, win = window) {
        if (win === window && isStatus(raw)) return true;
        if (!allowedUrl) return false;
        try {
            const url = new URL(raw);
            if (url.username || url.password || url.hash || url.origin !== new URL(allowedUrl).origin) return false;
            if (win === settingsWindow) {
                const entries = [...url.searchParams];
                return url.pathname === '/settings' && entries.length === 1 && entries[0][0] === 'section'
                    && sections.has(entries[0][1]) && url.search === `?section=${entries[0][1]}`;
            }
            return win === window && !url.search && ['/', '/index.html'].includes(url.pathname);
        } catch { return false; }
    }

    function trackWindow(win, main) {
        const state = { themeVersion: 0, cssKey: null, listeners: [], abort: new AbortController() };
        windowStates.set(win, state);
        openChildWindows.push(win);
        const on = (target, name, listener) => {
            target.on(name, listener);
            state.listeners.push(() => target.removeListener(name, listener));
        };
        win.setMenu(null);
        on(win, 'maximize', () => notifyWindowState(win));
        on(win, 'unmaximize', () => notifyWindowState(win));
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        on(win.webContents, 'will-attach-webview', event => event.preventDefault());
        const navigate = event => {
            const url = event.url;
            if (main && isStatus(url) && new URL(url).searchParams.get('state') === 'retry' && isStatus(win.webContents.getURL())) {
                event.preventDefault();
                void connect(win).catch(error => logger.warn('[AndroidDisplay] Retry failed:', error.message));
            } else if (!permitted(url, win)) event.preventDefault();
        };
        on(win.webContents, 'will-navigate', navigate);
        on(win.webContents, 'will-frame-navigate', event => {
            if (!event.isMainFrame) event.preventDefault();
            else navigate(event);
        });
        on(win.webContents, 'will-redirect', event => { if (!permitted(event.url, win)) event.preventDefault(); });
        on(win.webContents, 'did-start-navigation', event => {
            if (event.isMainFrame && !event.isSameDocument) { ++state.themeVersion; state.cssKey = null; }
        });
        on(win.webContents, 'did-finish-load', () => {
            if (disposed || !windowStates.has(win) || win.isDestroyed()) return;
            void refreshWindowTheme(win);
            notifyWindowState(win);
            if (main) windowService.markReady(APP_ID, { sender: win.webContents });
            win.show();
        });
        if (main) on(win.webContents, 'render-process-gone', () => {
            if (live(win)) void showStatus(win, 'error', '显示页面已中断。点击重试重新打开，不会重放手机操作。')
                .catch(error => logger.warn('[AndroidDisplay] Recovery page failed:', error.message));
        });
        on(win, 'closed', () => {
            state.abort.abort();
            ++state.themeVersion;
            state.listeners.forEach(remove => remove());
            windowStates.delete(win);
            if (window === win) {
                lifetime.abort();
                if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
                window = null; allowedUrl = null; connecting = null; opening = null;
            }
            if (settingsWindow === win) settingsWindow = null;
            const index = openChildWindows.indexOf(win);
            if (index !== -1) openChildWindows.splice(index, 1);
        });
        return state;
    }

    async function openSettings(event, section = 'display') {
        const parent = window;
        if (!sections.has(section) || !trusted(event, parent) || !allowedUrl || isStatus(parent.webContents.getURL())) return false;
        let win = settingsWindow;
        if (!win || win.isDestroyed()) {
            win = new BrowserWindow({
                parent, modal: false, width: 500, height: 680, minWidth: 360, minHeight: 480,
                title: '安卓显示屏设置', show: false, frame: false,
                backgroundColor: nativeTheme.shouldUseDarkColors ? '#101316' : '#f8fafc',
                icon: path.join(projectRoot, 'assets', 'icon.png'),
                webPreferences: { session: isolatedSession, preload: path.join(projectRoot, 'preloads/android-display.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
            });
            settingsWindow = win;
            trackWindow(win, false);
        }
        const state = windowStates.get(win);
        state.target = new URL(`/settings?section=${section}`, allowedUrl).href;
        if (!state.loading && win.webContents.getURL() !== state.target) {
            state.loading = (async () => {
                try {
                    while (windowStates.has(win) && !win.isDestroyed() && win.webContents.getURL() !== state.target) {
                        await within(win.loadURL(state.target), timeoutMs, state.abort.signal);
                    }
                    return !disposed && windowStates.has(win) && !win.isDestroyed();
                } catch (error) {
                    if (!win.isDestroyed()) win.destroy();
                    logger.warn('[AndroidDisplay] Cannot open settings:', error.message);
                    return false;
                } finally { state.loading = null; }
            })();
        }
        if (state.loading && !await state.loading) return false;
        if (disposed || !windowStates.has(win) || win.isDestroyed()) return false;
        focus(win);
        return true;
    }

    function requestViewerAction(event, action) {
        if (!viewerActions.has(action) || !trusted(event, settingsWindow) || !window || !live(window)
            || !permitted(window.webContents.getURL(), window) || isStatus(window.webContents.getURL())) return false;
        window.webContents.send('android-display:viewer-action', { action });
        return true;
    }

    async function controllerSettingsRequest(event, operation, payload) {
        const assertCurrent = () => {
            if (!trusted(event, settingsWindow)) throw new Error('请从安卓控制器设置窗口操作。');
        };
        try {
            assertCurrent();
            if (operation === 'authorization') {
                if (typeof openSystemAuthorization !== 'function') throw new Error('系统授权入口不可用。');
                await openSystemAuthorization();
                return { ok: true };
            }
            const service = getControllerService?.();
            if (!service) throw new Error('安卓控制器未加载，请重启 VCPChat 后重试。');
            if (operation === 'read') return await service.readControllerSettings();
            if (operation === 'save') return await service.saveControllerSettings(payload, { assertCurrent });
            throw new Error('不支持的设置操作。');
        } catch (error) { return { ok: false, error: error.message, code: error.code || null }; }
    }

    async function open() {
        if (disposed) throw new Error('安卓显示屏窗口服务已退出。');
        if (opening) return opening;
        if (window && !window.isDestroyed()) {
            void refreshTheme();
            return focus(window);
        }
        const pending = (async () => {
            const win = new BrowserWindow({
                width: 440, height: 840, minWidth: 360, minHeight: 480,
                title: '安卓显示屏', show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#101316' : '#f8fafc',
                frame: false,
                icon: path.join(projectRoot, 'assets', 'icon.png'),
                webPreferences: { session: isolatedSession, preload: path.join(projectRoot, 'preloads/android-display.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
            });
            window = win;
            lifetime = new AbortController();
            trackWindow(win, true);
            windowService.attachWindow(APP_ID, win);
            try {
                await connect(win);
                return live(win) ? win : null;
            } catch (error) {
                if (!win.isDestroyed()) win.destroy();
                throw error;
            }
        })();
        opening = pending;
        try { return await pending; }
        finally { if (opening === pending) opening = null; }
    }

    nativeTheme.on('updated', refreshTheme);
    ipcMain.handle('android-display:fit-window', fitWindow);
    ipcMain.handle('android-display:window-control', windowControl);
    ipcMain.handle('android-display:open-settings', openSettings);
    ipcMain.handle('android-display:request-viewer-action', requestViewerAction);
    ipcMain.handle('android-display:controller-settings', controllerSettingsRequest);
    windowService.register(APP_ID, { owner: 'android-display', getWindow: () => window, open, readyTimeoutMs: timeoutMs });
    return {
        open, refreshTheme,
        getWindow: () => window,
        getSettingsWindow: () => settingsWindow,
        dispose() {
            disposed = true;
            themeStyles.dispose();
            nativeTheme.removeListener('updated', refreshTheme);
            ipcMain.removeHandler('android-display:fit-window');
            ipcMain.removeHandler('android-display:window-control');
            ipcMain.removeHandler('android-display:open-settings');
            ipcMain.removeHandler('android-display:request-viewer-action');
            ipcMain.removeHandler('android-display:controller-settings');
            for (const win of [...windowStates.keys()]) if (!win.isDestroyed()) win.destroy();
        },
    };
}

function createAndroidDisplayResolver({ ensureServer, getServiceModule }) {
    return async () => {
        const server = await ensureServer();
        if (!server) throw new Error('本地分布式服务未启用或启动失败。请在设置中启用后重启 VCPChat。');
        const service = getServiceModule('AndroidController');
        if (!service) throw new Error('安卓控制器插件未加载。请在插件管理器中启用后重启 VCPChat。');
        return service.ensureDisplayUrl();
    };
}

module.exports = { createAndroidDisplayWindow, createAndroidDisplayResolver, displayUrl };
