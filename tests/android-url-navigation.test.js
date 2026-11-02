'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const request = (h, action = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'LaunchApp', package: 'com.example', url: 'https://example.com/path?q=hello&n=1', ...action } });
const starts = h => h.calls.filter(([kind, args]) => kind === 'adb' && args.includes('start'));

test('URL navigation resolves the requested package and starts one explicit VIEW activity', async () => {
    const h = await harness();
    const result = await request(h);
    const resolve = h.calls.find(([, args]) => Array.isArray(args) && args.includes('resolve-activity'));
    assert.ok(resolve[1].includes('android.intent.action.VIEW'));
    assert.ok(resolve[1].includes('android.intent.category.BROWSABLE'));
    assert.ok(resolve[1].includes('-p'));
    assert.deepEqual(Array.from(starts(h)[0][1]), ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE', '-d', "'https://example.com/path?q=hello&n=1'", '-n', 'com.example/.Main']);
    assert.equal(starts(h).length, 1);
    assert.equal(result.details.execution.outcome, 'verified');
    assert.equal(result.details.pageLoaded, null);
    assert.equal(result.details.url, undefined, 'URL query is not echoed in details');
    assert.doesNotMatch(JSON.stringify(result), /hello&n/);
});

for (const url of ['intent://example', 'file:///sdcard/test', 'javascript:alert(1)', 'https://user:secret@example.com/', 'https://example.com/\n', ' https://example.com', 'https://example.com/%0a', 'https://example.com/%00', 'https:\\example.com', '', 123, 'https://example.com/' + 'x'.repeat(4096)]) {
    test(`invalid URL rejected before any adb: ${String(url).slice(0, 65)}`, async () => {
        const h = await harness();
        await assert.rejects(request(h, { url }), { code: 'INVALID_ARGUMENT' });
        assert.equal(h.calls.some(([kind]) => kind === 'adb'), false);
    });
}

for (const action of [{ activity: '.Main' }, { stop: true }, { stop: 'true' }, { package: undefined }]) {
    test(`URL conflicts rejected without dispatch: ${JSON.stringify(action)}`, async () => {
        const h = await harness();
        await assert.rejects(request(h, action), { code: 'INVALID_ARGUMENT' });
        assert.equal(h.calls.some(([kind]) => kind === 'adb'), false);
    });
}

for (const resolved of ['', 'No activity found', 'com.other/.Main', 'com.example/.Main;id', 'com.example/.Main\ncom.example/.Second']) {
    test(`URL resolution fails closed: ${resolved}`, async () => {
        const h = await harness({ run: args => args.includes('resolve-activity') ? resolved : undefined });
        await assert.rejects(request(h), { code: 'URL_NOT_SUPPORTED' });
        assert.equal(starts(h).length, 0);
        assert.equal(h.calls.some(([, args]) => Array.isArray(args) && args.includes('monkey')), false);
    });
}

test('URL resolve errors are not mistaken for unsupported URL and never echo URL', async () => {
    const h = await harness({ run: args => { if (args.includes('resolve-activity')) throw new Error('private-url'); } });
    await assert.rejects(request(h), error => error.code === 'URL_RESOLUTION_FAILED' && error.execution.outcome === 'failed' && !error.message.includes('private-url'));
});

test('URL start backend rejection is unknown and never retried or echoed', async () => {
    const h = await harness({ run: args => { if (args.includes('start')) throw new Error('private-url'); } });
    await assert.rejects(request(h), error => error.code === 'URL_DISPATCH_FAILED' && error.execution.outcome === 'unknown' && !error.message.includes('private-url'));
    assert.equal(starts(h).length, 1);
});

test('am start error output cannot be verified just because the package was already foreground', async () => {
    const h = await harness({ run: args => args.includes('start') ? 'Error: Activity not started, unable to resolve Intent private-url' : undefined });
    await assert.rejects(request(h), error => error.code === 'URL_DISPATCH_FAILED' && error.execution.outcome === 'unknown' && !error.message.includes('private-url'));
    assert.equal(starts(h).length, 1);
});

test('URL metacharacters are quoted as device shell data, never interpolated', async () => {
    const h = await harness();
    await request(h, { url: "https://example.com/?q=';$(id)&v=1" });
    const args = starts(h)[0][1];
    const token = args[args.indexOf('-d') + 1];
    assert.equal(token, "'https://example.com/?q='\\'';$(id)&v=1'");
});

test('URL navigation returns new observation when requested and preserves explicit B', async () => {
    const h = await harness();
    const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'B', action: { command: 'LaunchApp', package: 'com.example', url: 'https://example.com/' }, afterObserve: true });
    assert.equal(starts(h)[0][2].serial, 'B');
    assert.equal(result.details.observation.serial, 'B');
    assert.equal(h.client.serial, 'A');
});


test('URL resolver cancellation is not downgraded to unsupported navigation', async () => {
    const controller = new AbortController();
    const h = await harness({ run: args => { if (args.includes('resolve-activity')) { controller.abort(); throw new Error('cancelled'); } } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'LaunchApp', package: 'com.example', url: 'https://example.com/' } }, { signal: controller.signal }), error => error.code === 'STEP_ABORTED' && error.execution.outcome === 'failed');
    assert.equal(starts(h).length, 0);
});

test('URL navigation holds the device lease during resolution', async () => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ run: async args => { if (args.includes('resolve-activity')) { entered(); await gate; return 'com.example/.Main'; } } });
    const work = request(h);
    await ready;
    try { await assert.rejects(request(h), { code: 'DEVICE_BUSY' }); }
    finally { release(); }
    await work;
    assert.equal(starts(h).length, 1);
});
