'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/viewer.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { await tick(); await tick(); };

async function viewer(t, status = { display: { serial: 'bound-device' } }) {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1:18444/', runScripts: 'outside-only' });
    const { window } = dom;
    const get = id => window.document.getElementById(id);
    const calls = [], sockets = [], timers = new Map();
    let now = 1700000000000, timerId = 0;
    let rect = { left: 10, top: 20, width: 800, height: 600 };
    window.Date.now = () => now;
    window.setTimeout = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, due: now + delay, interval: 0 }); return id; };
    window.setInterval = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, due: now + delay, interval: delay }); return id; };
    window.clearTimeout = window.clearInterval = id => timers.delete(id);
    const results = {
        '/api/adb': { ok: true, available: true, addresses: [] },
        '/api/display/preferences': options => options.method === 'GET'
            ? { ok: true, fitWidth: false } : { ok: true, fitWidth: JSON.parse(options.body).fitWidth },
        '/api/devices': { ok: true, devices: [{ serial: 'not-the-selected-device', state: 'device' }] },
        '/status': status,
        '/api/scrcpy': { ok: true, available: true, status: { maxFps: 30, bitRate: 2000000, maxShortEdge: 720 } },
    };
    window.fetch = async (url, options) => {
        calls.push({ url, ...options });
        assert.ok(Object.hasOwn(results, url), `unexpected endpoint: ${url}`);
        return { json: async () => typeof results[url] === 'function' ? results[url](options) : results[url] };
    };
    window.WebSocket = class {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closeCount = 0; sockets.push(this); }
        send(data) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(data)); }
        close() { this.closeCount++; this.readyState = 3; }
        open() { this.readyState = 1; this.onopen?.(); }
        receive(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
        disconnect() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    };
    window.eval(script);
    await flush();
    const ws = sockets[0];
    ws.open();
    // A decoded 1080x1920 H.264 frame on the live canvas.
    const canvas = get('h264');
    canvas.width = 1080; canvas.height = 1920;
    canvas.classList.remove('hidden');
    canvas.getBoundingClientRect = () => ({ ...rect });
    const captures = [];
    canvas.setPointerCapture = id => captures.push(['set', id]);
    canvas.releasePointerCapture = id => captures.push(['release', id]);
    function advance(ms) {
        const end = now + ms;
        for (let steps = 0; steps < 10000; steps++) {
            const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
            if (!next) { now = end; return; }
            const [id, timer] = next;
            now = timer.due;
            if (timer.interval) timer.due += timer.interval;
            else timers.delete(id);
            timer.fn();
        }
        throw new Error('unbounded timer loop');
    }
    async function click(id) { get(id).click(); await flush(); }
    function pointer(type, x = 410, y = 320, properties = {}, target = canvas) {
        const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
        Object.defineProperties(event, Object.fromEntries(Object.entries({ isPrimary: true, pointerId: 1, ...properties })
            .map(([key, value]) => [key, { value }])));
        target.dispatchEvent(event);
        return event;
    }
    const requests = () => ws.sent.filter(item => item.type === 'takeover-start' || item.type === 'takeover-end');
    const touches = () => ws.sent.filter(item => item.type === 'takeover-touch').map(({ action, x, y, width, height }) => [action, x, y, width, height]);
    const keys = () => ws.sent.filter(item => item.type === 'takeover-key');
    function reply(payload) { ws.receive({ type: 'takeover-result', requestId: requests().at(-1).requestId, ok: true, ...payload }); }
    async function start(response = {}) {
        await click('takeoverToggle');
        assert.equal(requests().at(-1)?.type, 'takeover-start');
        reply({ token: 'secret-token', epoch: 7, serial: requests().at(-1).serial, expiresAt: now + 120000, mode: 'live', ...response });
    }
    t.after(() => { window.dispatchEvent(new window.Event('beforeunload')); window.close(); });
    return { window, get, canvas, captures, calls, sockets, ws, timers, results, advance, click, pointer, requests, touches, keys, reply, start,
        now: () => now, setRect: value => { rect = value; } };
}

test('default live surface stays read-only and no takeover request is implicit', async t => {
    const v = await viewer(t);
    assert.equal(v.calls.some(call => call.url === '/status'), false);
    v.pointer('pointerdown'); v.pointer('pointermove', 420, 400); v.pointer('pointerup');
    for (const id of ['takeoverBack', 'takeoverHome', 'takeoverRecents']) v.get(id).dispatchEvent(new v.window.Event('click'));
    assert.deepEqual(v.ws.sent.filter(item => item.type.startsWith('takeover-')), []);
    assert.equal(v.get('takeoverToggle').getAttribute('aria-pressed'), 'false');
    assert.equal(v.get('takeoverFrame'), null, 'no separate snapshot surface');
});

test('start binds only the explicit GET /status serial and waits for native approval on the same WS', async t => {
    const v = await viewer(t, { display: { serial: 'selected' }, scrcpy: { serial: 'other' } });
    await v.click('takeoverToggle');
    assert.deepEqual(v.requests(), [{ type: 'takeover-start', requestId: v.requests()[0].requestId, serial: 'selected' }]);
    const call = v.calls.find(item => item.url === '/status');
    assert.equal(call.credentials, 'same-origin');
    assert.match(v.get('takeoverStatus').textContent, /等待.*电脑上批准.*selected/);
    v.pointer('pointerdown'); v.pointer('pointerup'); await v.click('takeoverHome');
    assert.deepEqual(v.touches(), []); assert.deepEqual(v.keys(), []);
    assert.equal(v.get('openSettings').disabled, true);
    assert.equal(v.get('stage').classList.contains('takeover-mode'), true);
});

test('scrcpy serial is a valid fallback but missing serial never guesses from connected devices', async t => {
    const v = await viewer(t, { scrcpy: { serial: 'scrcpy-selected' } });
    await v.click('takeoverToggle');
    assert.equal(v.requests()[0].serial, 'scrcpy-selected');
    v.reply({ ok: false, code: 'DENIED', error: '用户拒绝' });
    v.results['/status'] = { display: { serial: ' ' }, scrcpy: {} };
    await v.click('takeoverToggle');
    assert.equal(v.requests().length, 1);
    assert.match(v.get('takeoverStatus').textContent, /无法确认.*设备.*未请求/);
});

test('live video stays visible during takeover', async t => {
    const v = await viewer(t);
    await v.start();
    assert.equal(v.get('stage').classList.contains('takeover-mode'), true);
    assert.equal(v.canvas.classList.contains('hidden'), false);
    assert.doesNotMatch(html, /#stage\.takeover-mode #h264[^{]*\{[^}]*display:\s*none/);
    assert.equal(v.get('stage').dataset.takeoverInteractive, 'true');
});

test('drag streams down, coalesced moves and up in live-frame pixels with pointer capture', async t => {
    const v = await viewer(t);
    await v.start();
    // 1080x1920 contained in 800x600 => 337.5x600 at left 241.25, top 20.
    v.pointer('pointerdown', 241.25, 20);
    v.pointer('pointermove', 410, 100);
    v.pointer('pointermove', 410, 320);
    assert.equal(v.touches().length, 1, 'moves wait for the next frame');
    v.advance(16);
    v.pointer('pointerup', 578.74, 619.99);
    assert.deepEqual(v.touches(), [['down', 0, 0, 1080, 1920], ['move', 540, 960, 1080, 1920], ['up', 1079, 1919, 1080, 1920]]);
    assert.deepEqual(v.captures, [['set', 1], ['release', 1]]);
    const sample = v.ws.sent.find(item => item.type === 'takeover-touch');
    assert.equal(sample.token, 'secret-token'); assert.equal(sample.epoch, 7);
    assert.equal(Object.hasOwn(sample, 'requestId'), false);
});

test('letterbox presses are ignored; captured moves outside the frame clamp to its edge', async t => {
    const v = await viewer(t);
    await v.start();
    v.pointer('pointerdown', 240, 320); v.pointer('pointerup', 240, 320);
    assert.deepEqual(v.touches(), []);
    v.pointer('pointerdown', 410, 320);
    v.pointer('pointermove', 900, 700); v.advance(16);
    v.pointer('pointerup', 900, 700);
    assert.deepEqual(v.touches().slice(1), [['move', 1079, 1919, 1080, 1920], ['up', 1079, 1919, 1080, 1920]]);
});

test('secondary button, non-primary and foreign pointers never dispatch', async t => {
    const v = await viewer(t);
    await v.start();
    v.pointer('pointerdown', 410, 320, { button: 2 });
    v.pointer('pointerdown', 410, 320, { isPrimary: false });
    assert.deepEqual(v.touches(), []);
    v.pointer('pointerdown');
    v.pointer('pointermove', 410, 400, { pointerId: 2 }); v.pointer('pointerup', 410, 400, { pointerId: 2 });
    assert.deepEqual(v.touches().map(item => item[0]), ['down']);
    v.pointer('pointercancel');
    assert.deepEqual(v.touches().map(item => item[0]), ['down', 'up']);
});

test('blur or hidden document lifts a pressed pointer exactly once', async t => {
    const v = await viewer(t);
    await v.start();
    v.pointer('pointerdown');
    v.window.dispatchEvent(new v.window.Event('blur'));
    v.window.document.dispatchEvent(new v.window.Event('visibilitychange'));
    v.pointer('pointerup');
    assert.deepEqual(v.touches().map(item => item[0]), ['down', 'up']);
});

test('JPEG fallback image is also a live surface using its intrinsic size', async t => {
    const v = await viewer(t);
    await v.start();
    v.canvas.classList.add('hidden');
    const image = v.get('screen');
    image.classList.remove('hidden');
    Object.defineProperties(image, { naturalWidth: { get: () => 540 }, naturalHeight: { get: () => 960 } });
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 540, height: 960 });
    v.pointer('pointerdown', 270, 480, {}, image); v.pointer('pointerup', 270, 480, {}, image);
    assert.deepEqual(v.touches(), [['down', 270, 480, 540, 960], ['up', 270, 480, 540, 960]]);
});

test('navigation keys send live key messages', async t => {
    const v = await viewer(t);
    await v.start();
    await v.click('takeoverBack'); await v.click('takeoverHome'); await v.click('takeoverRecents');
    assert.deepEqual(v.keys().map(item => [item.key, item.token, item.epoch]), [['back', 'secret-token', 7], ['home', 'secret-token', 7], ['recents', 'secret-token', 7]]);
});

test('server input error and policy block show a transient notice and drop the pressed pointer', async t => {
    const v = await viewer(t);
    await v.start();
    v.pointer('pointerdown');
    v.ws.receive({ type: 'takeover-blocked', code: 'POLICY_DENIED', error: '<img src=x onerror=fail()>' });
    assert.match(v.get('takeoverStatus').textContent, /POLICY_DENIED.*<img/);
    assert.equal(v.get('takeoverStatus').children.length, 0);
    v.pointer('pointermove', 410, 400); v.advance(16); v.pointer('pointerup');
    assert.deepEqual(v.touches().map(item => item[0]), ['down']);
    v.advance(3000);
    assert.match(v.get('takeoverStatus').textContent, /已接管 bound-device/);
    v.ws.receive({ type: 'takeover-input-error', code: 'VIDEO_SIZE_CHANGED', error: '画面方向已变化' });
    assert.match(v.get('takeoverStatus').textContent, /VIDEO_SIZE_CHANGED/);
});

test('disconnect clears credentials and takeover timers, retaining only device polling', async t => {
    const v = await viewer(t);
    await v.start();
    v.pointer('pointerdown');
    const count = v.ws.sent.length;
    v.ws.disconnect();
    assert.equal(v.get('stage').classList.contains('takeover-mode'), false);
    assert.equal(v.get('openSettings').disabled, false);
    assert.equal(v.timers.size, 1, 'only read-only device polling remains');
    v.pointer('pointermove', 410, 400); v.pointer('pointerup'); v.advance(180000);
    assert.equal(v.ws.sent.length, count);
    await v.click('reconnect');
    assert.equal(v.sockets.length, 2);
});

test('start approval timeout is 90 seconds and ignores a late successful authorization', async t => {
    const v = await viewer(t);
    await v.click('takeoverToggle');
    const onmessage = v.ws.onmessage;
    const requestId = v.requests()[0].requestId;
    v.advance(89999);
    assert.equal(v.ws.closeCount, 0);
    v.advance(1);
    assert.equal(v.ws.closeCount, 1);
    onmessage({ data: JSON.stringify({ type: 'takeover-result', requestId, ok: true, token: 'late', epoch: 8,
        serial: 'bound-device', expiresAt: v.now() + 120000 }) });
    v.pointer('pointerdown');
    assert.deepEqual(v.touches(), []);
    assert.equal(v.timers.size, 1, 'only read-only device polling remains');
});

test('server ended, ended errors and explicit end restore read-only and require a new start', async t => {
    const v = await viewer(t);
    await v.start();
    v.ws.receive({ type: 'takeover-ended', code: 'USER_ABORTED' });
    assert.match(v.get('takeoverStatus').textContent, /USER_ABORTED.*不会自动恢复 AI/);
    v.pointer('pointerdown'); assert.deepEqual(v.touches(), []);
    await v.start();
    await v.click('takeoverToggle');
    assert.equal(v.requests().at(-1).type, 'takeover-end');
    v.pointer('pointerdown'); assert.deepEqual(v.touches(), [], 'no input while end is pending');
    v.reply({ ended: true });
    assert.equal(v.get('takeoverToggle').getAttribute('aria-pressed'), 'false');
    assert.equal(v.get('stage').getAttribute('aria-label'), '安卓只读显示屏');
});

test('session expiry closes and revokes rather than automatically reacquiring', async t => {
    const v = await viewer(t);
    await v.start({ expiresAt: v.now() + 20000 });
    v.advance(20000);
    assert.equal(v.ws.closeCount, 1);
    assert.match(v.get('takeoverStatus').textContent, /授权已到期.*不会自动重新接管/);
    assert.equal(v.timers.size, 1, 'only read-only device polling remains');
});

test('settings, config and reconnect remain locked during takeover', async t => {
    const v = await viewer(t);
    await v.start();
    for (const id of ['openSettings', 'fit', 'reconnect', 'doScan', 'doPair', 'doConnect', 'refresh', 'applyQuality',
        'qualityFps', 'qualityBitRate', 'qualitySize']) assert.equal(v.get(id).disabled, true, id);
    const calls = v.calls.length;
    for (const id of ['openSettings', 'setup', 'fit', 'reconnect', 'doScan', 'doPair', 'doConnect', 'refresh', 'applyQuality']) {
        v.get(id).dispatchEvent(new v.window.Event('click'));
    }
    await flush();
    assert.equal(v.calls.length, calls);
    assert.equal(v.sockets.length, 1);
});

test('invalid authorization closes WS and never enables input', async t => {
    const v = await viewer(t);
    await v.start({ epoch: '7' });
    assert.equal(v.ws.closeCount, 1);
    v.pointer('pointerdown');
    assert.deepEqual(v.touches(), []);
});

test('binding timeout also closes WS and ignores the late GET /status result', async t => {
    const v = await viewer(t);
    let release;
    v.results['/status'] = () => new Promise(resolve => { release = resolve; });
    await v.click('takeoverToggle');
    v.advance(90000);
    assert.equal(v.ws.closeCount, 1);
    release({ display: { serial: 'too-late' } });
    await flush();
    assert.equal(v.requests().length, 0);
    assert.equal(v.timers.size, 1, 'only read-only device polling remains');
});

test('unload clears timers, socket callbacks and all added takeover listeners', async t => {
    const v = await viewer(t);
    await v.start();
    v.pointer('pointerdown'); v.pointer('pointermove', 410, 400);
    v.window.dispatchEvent(new v.window.Event('beforeunload'));
    assert.equal(v.timers.size, 0);
    assert.equal(v.ws.onmessage, null);
    assert.equal(v.ws.onclose, null);
    const sent = v.ws.sent.length;
    v.pointer('pointerup'); v.get('takeoverToggle').dispatchEvent(new v.window.Event('click'));
    await flush(); v.advance(180000);
    assert.equal(v.ws.sent.length, sent);
});
