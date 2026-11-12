'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createTrustedMainSender } = require('./helpers/trusted-main-sender.cjs');

function fixture() {
    const filename = path.resolve(__dirname, '../modules/ipc/desktopHandlers.js');
    const productionRequire = createRequire(filename);
    const handlers = new Map(), opened = [];
    const main = createTrustedMainSender();
    const module = { exports: {} };
    const stubs = {
        electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name), on() {} }, app: { once() {} } },
        'fs-extra': { ensureDirSync() {}, async ensureDir() {}, async readdir() { return []; }, async writeFile() {}, async pathExists() { return false; } },
        './desktopMetrics': { initialize() {} },
        './gameHandlers': { initialize() {} },
        '../services/windowService': { register() {}, async open(id) { opened.push(id); } },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: name => Object.hasOwn(stubs, name) ? stubs[name] : productionRequire(name),
        module, __dirname: path.dirname(filename), process,
        console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Buffer,
    }, { filename });
    module.exports.initialize({ mainWindow: main.mainWindow, openChildWindows: [], APP_DATA_ROOT_IN_PROJECT: '/unused-isolated-data' });
    return { handler: handlers.get('desktop-launch-vchat-app'), opened, main };
}

test('real desktop launch handler opens Android only for top-level application windows', async () => {
    const f = fixture();
    const desktop = createTrustedMainSender('Desktopmodules/desktop.html');
    for (const event of [f.main.event, desktop.event]) {
        const result = await f.handler(event, 'open-android-display-window');
        assert.equal(result.success, true); assert.equal(result.appId, 'android-display');
    }
    assert.deepEqual(f.opened, ['android-display', 'android-display']);
    const viewer = createTrustedMainSender();
    viewer.sender.getURL = () => 'http://127.0.0.1:5977/';
    viewer.sender.mainFrame.url = 'http://127.0.0.1:5977/';
    const foreign = createTrustedMainSender('Voicechatmodules/voicechat.html');
    const anotherMain = createTrustedMainSender();
    const subframe = { ...f.main.event, senderFrame: { url: f.main.sender.mainFrame.url, detached: false } };
    for (const event of [viewer.event, foreign.event, anotherMain.event, subframe, null]) {
        assert.equal((await f.handler(event, 'open-android-display-window')).success, false);
    }
    assert.equal(f.opened.length, 2, 'rejected callers cannot reach window creation');
});
