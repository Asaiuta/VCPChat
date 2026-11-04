'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { harness } = require('./helpers/android-service-harness.cjs');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
const start = h => h.service.processToolCall({ command: 'Manage', operation: 'startDisplay' });
const stop = h => h.service.processToolCall({ command: 'Manage', operation: 'stopDisplay' });
function loom() {
    let reads = 0, saves = 0;
    const manager = {
        manifests: new Map([['android-mirror', { id: 'android-mirror', startUrl: 'http://127.0.0.1:1' }]]),
        async readSources() { reads++; return { manifest: this.manifests.get('android-mirror'), css: '', js: '' }; },
        async saveApp(payload) { saves++; this.manifests.set('android-mirror', payload.manifest); },
    };
    return { manager, counts: () => ({ reads, saves }) };
}

test('Manage start waits for an existing real bind and synchronizes URL only once', async t => {
    const server = new StreamServer({ port: 0, logger: {} });
    t.after(() => server.stop());
    const apps = loom();
    const h = await harness({ streamServer: server, services: { loomManager: apps.manager } });
    await stop(h);
    const gate = deferred(), entered = deferred();
    const listen = http.Server.prototype.listen;
    t.mock.method(http.Server.prototype, 'listen', function (...args) {
        entered.resolve();
        gate.promise.then(() => listen.apply(this, args));
        return this;
    });
    const first = server.start();
    await entered.promise;
    let completed = false;
    const second = start(h).then(result => { completed = true; return result; });
    await tick();
    const premature = completed;
    await assert.rejects(start(h), { code: 'DEVICE_BUSY' });
    gate.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(premature, false);
    assert.ok(server.actualPort > 0);
    assert.equal(results[0], server.actualPort);
    assert.equal(results[1].details.url, server.url());
    assert.equal(apps.counts().saves, 2, 'initialization and one restart');
    const counts = apps.counts();
    await start(h);
    assert.deepEqual(apps.counts(), counts, 'already-ready start must not synchronize again');
});

test('Manage start during real pending stop waits and publishes replacement URL', async t => {
    const gate = deferred();
    const server = new StreamServer({ port: 0, logger: {}, scrcpyHub: { stop: () => gate.promise } });
    t.after(() => server.stop());
    const apps = loom();
    const h = await harness({ streamServer: server, services: { loomManager: apps.manager } });
    const old = server.server;
    const stopping = server.stop();
    let completed = false;
    const starting = start(h).then(result => { completed = true; return result; });
    await tick();
    const premature = completed;
    gate.resolve();
    await stopping;
    const result = await starting;
    assert.equal(premature, false);
    assert.notEqual(server.server, old);
    assert.equal(server.server.listening, true);
    assert.equal(result.details.url, server.url());
    assert.equal(apps.manager.manifests.get('android-mirror').startUrl, server.url());
    const counts = apps.counts();
    await start(h);
    assert.deepEqual(apps.counts(), counts);
});
