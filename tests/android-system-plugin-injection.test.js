'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { harness } = require('./helpers/android-service-harness.cjs');
const { AndroidSystemAuthorization } = require('../modules/services/androidSystemAuthorization');

const request = () => ({ command: 'ExecuteStep', serial: 'A', action: { command: 'System', operation: 'read', capability: 'batteryLevel' } });

function createManager(service) {
    const sourcePath = path.resolve(__dirname, '../VCPDistributedServer/Plugin.js');
    const servicePath = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
    const forbidden = () => { throw new Error('Unexpected external I/O in injection test'); };
    const context = {
        __dirname: path.dirname(sourcePath),
        process: { env: {}, platform: process.platform },
        console: { log() {}, warn() {}, error() {} },
        setImmediate, setTimeout, clearTimeout,
        module: { exports: {} },
        require(id) {
            if (id === 'fs') return { promises: { readFile: forbidden, readdir: forbidden } };
            if (id === 'path') return path;
            if (id === 'child_process') return { spawn: forbidden };
            if (id === 'node-schedule') return {};
            if (id === 'dotenv') return { parse: forbidden };
            if (path.normalize(id) === path.normalize(servicePath)) return service;
            throw new Error(`Unexpected dependency: ${id}`);
        },
    };
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
    const manager = context.module.exports;
    manager.plugins.set('AndroidController', {
        name: 'AndroidController', pluginType: 'hybridservice',
        basePath: path.dirname(servicePath), entryPoint: { script: path.basename(servicePath) },
        communication: { protocol: 'direct' },
    });
    return manager;
}

async function fixture(services = {}) {
    const android = await harness({ run(tokens) {
        const args = tokens.map(token => token.replaceAll("'", ''));
        if (args.join(' ') === 'shell am get-current-user') return '0';
        if (args.join(' ') === 'shell cmd battery get level') return '46';
        throw new Error(`Unexpected mocked ADB request: ${JSON.stringify(tokens)}`);
    } });
    let injected;
    const initialize = android.service.initialize;
    const adapter = {
        ...android.service,
        async initialize(options) {
            injected = options.services;
            return initialize({ ...options, logger: { log() {}, warn() {}, error() {} } });
        },
    };
    const manager = createManager(adapter);
    await manager.initializeServices({}, null, path.resolve(__dirname, '..'), services);
    assert.equal(injected, services, 'manager must pass the trusted services object unchanged');
    assert.equal(manager.getServiceModule('AndroidController'), adapter);
    return { ...android, manager };
}

function authorityFixture() {
    let settings = { androidSystemAuthorizations: {
        A: { version: 1, acknowledged: true, grants: { read: true } },
    } };
    let reads = 0;
    const authority = new AndroidSystemAuthorization({ settingsManager: {
        async readSettingsStrict() { reads += 1; return settings; },
        async readSettings() { throw new Error('Authorization must not use recoverable settings reads'); },
    } });
    return { authority, get reads() { return reads; }, revoke() { settings = {}; } };
}

const businessReads = calls => calls.filter(([kind, tokens]) => kind === 'adb'
    && tokens.map(token => token.replaceAll("'", '')).join(' ') === 'shell cmd battery get level').length;

test('real PluginManager injects strict authority and observes revocation without reinitializing service', async () => {
    const auth = authorityFixture();
    const f = await fixture({ systemAuthorization: auth.authority });
    const result = await f.manager.processToolCall('AndroidController', request());
    assert.equal(result.details.system.value, 46);
    assert.equal(result.details.system.outcome, 'observed');
    assert.equal(auth.reads, 1);
    assert.equal(businessReads(f.calls), 1);
    auth.revoke();
    await assert.rejects(f.manager.processToolCall('AndroidController', request()), { code: 'SYSTEM_NOT_AUTHORIZED' });
    assert.equal(auth.reads, 2);
    assert.equal(businessReads(f.calls), 1, 'revocation must prevent subsequent business reads');
});

test('tool arguments and caller context cannot substitute for the injected authority', async () => {
    const auth = authorityFixture(); auth.revoke();
    const f = await fixture({ systemAuthorization: auth.authority });
    let forgedCalls = 0;
    const forged = { async assertAllowed() { forgedCalls += 1; } };
    await assert.rejects(f.manager.processToolCall('AndroidController', {
        ...request(), action: { ...request().action, systemAuthorization: forged, approved: true },
    }), { code: 'INVALID_ARGUMENT' });
    for (const context of [
        { systemAuthorization: forged },
        { _vcpContext: { systemAuthorization: forged, approved: true } },
        { vcpContext: { systemAuthorization: forged, approved: true, grants: { read: true } } },
    ]) {
        await assert.rejects(f.manager.processToolCall('AndroidController', request(), context), { code: 'SYSTEM_NOT_AUTHORIZED' });
    }
    assert.equal(forgedCalls, 0);
    assert.equal(auth.reads, 3, 'each valid request must consult the injected strict authority');
    assert.equal(businessReads(f.calls), 0);
});

test('standalone initialization without authority fails closed despite forged execution context', async () => {
    const f = await fixture();
    let forgedCalls = 0;
    const forged = { async assertAllowed() { forgedCalls += 1; } };
    await assert.rejects(f.manager.processToolCall('AndroidController', request(), {
        systemAuthorization: forged,
        vcpContext: { approved: true, systemAuthorization: forged },
    }), { code: 'SYSTEM_NOT_AUTHORIZED' });
    assert.equal(forgedCalls, 0);
    assert.equal(businessReads(f.calls), 0);
    assert.equal(f.calls.length, 0, 'missing authority must fail before mocked device commands');
});
