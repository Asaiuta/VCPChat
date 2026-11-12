'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const cssTree = require('css-tree');

const html = fs.readFileSync(path.join(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib/viewer.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
function packet(window, magic, payload, flags = 0, seq = 1) {
    const bytes = new window.Uint8Array(16 + payload.length);
    const header = new window.DataView(bytes.buffer);
    header.setUint32(0, magic, true); header.setUint32(4, seq, true);
    if (magic === 0x56434831) header.setUint32(12, flags, true);
    bytes.set(payload, 16);
    return bytes.buffer;
}

async function viewer(t, { devices = [], adb = {}, replies = {}, url = 'http://127.0.0.1:18444/', setup } = {}) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const { window } = dom;
    const htmlDescriptor = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML');
    t.after(() => {
        Object.defineProperty(window.Element.prototype, 'innerHTML', htmlDescriptor);
        window.close();
    });
    const calls = [], sockets = [], timers = [];
    const results = {
        '/api/adb': { ok: true, available: true, addresses: [], ...adb },
        '/api/display/preferences': options => options.method === 'GET'
            ? { ok: true, fitWidth: false } : { ok: true, fitWidth: JSON.parse(options.body).fitWidth },
        '/api/devices': { ok: true, devices },
        '/api/connect': { ok: true, message: '已连接' },
        '/api/discover': { ok: true, connect: [], pairing: [] },
        '/api/pair': { ok: true },
        ...replies,
    };
    window.fetch = async (url, options) => {
        calls.push({ url, ...options });
        assert.ok(Object.hasOwn(results, url), `unexpected endpoint: ${url}`);
        return { json: async () => typeof results[url] === 'function' ? results[url](options) : results[url] };
    };
    window.WebSocket = class {
        constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
        close() { this.readyState = 3; }
    };
    window.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
    window.setInterval = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
    // Fail immediately if production code routes untrusted data through HTML parsing.
    Object.defineProperty(window.Element.prototype, 'innerHTML', {
        set() { throw new Error('viewer must not assign innerHTML'); },
    });
    setup?.(window);
    window.eval(script);
    await tick();
    await tick();
    return { window, document: window.document, calls, sockets, timers, results,
        get: id => window.document.getElementById(id),
        async click(id) { window.document.getElementById(id).click(); await tick(); await tick(); },
    };
}

test('viewer preserves legacy IDs and supplies visible labels, live status and read-only screen semantics', () => {
    const dom = new JSDOM(html);
    try {
        const { document } = dom.window;
        const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
        assert.equal(ids.length, new Set(ids).size, 'IDs must remain unique');
        for (const id of ['app', 'dot', 'conn', 'res', 'fps', 'lat', 'fit', 'reconnect', 'setup', 'stage',
            'h264', 'screen', 'wizard', 'step1', 'step2', 'step3', 'doScan', 'scanMsg', 'scanList',
            'pairBox', 'pairCode', 'doPair', 'pairMsg', 'doConnect', 'refresh', 'connMsg', 'deviceList',
            'manualBox', 'connAddr', 'connPort', 'pairAddr', 'tipBox', 'error-box', 'seq', 'bytes', 'interval', 'hint']) {
            assert.ok(document.getElementById(id), `preserve #${id}`);
        }
        for (const input of document.querySelectorAll('input')) {
            const label = document.querySelector(`label[for="${input.id}"]`);
            assert.ok(label?.textContent.trim(), `visible label for #${input.id}`);
        }
        for (const id of ['conn', 'scanMsg', 'pairMsg', 'connMsg', 'deviceSummary', 'error-box']) {
            assert.equal(document.getElementById(id).getAttribute('aria-live'), 'polite');
        }
        assert.match(document.getElementById('h264').getAttribute('aria-label'), /只读/);
        assert.match(document.getElementById('screen').alt, /只读/);
        assert.match(document.getElementById('hint').textContent, /不受 AI 包过滤影响/);
        assert.match(document.title, /安卓显示屏/);
    } finally { dom.window.close(); }
});

test('main page has only the titlebar and stage; all business controls live in settings', () => {
    const dom = new JSDOM(html);
    try {
        const { document } = dom.window;
        assert.deepEqual([...document.querySelectorAll('header > .header-actions > button')].map(node => node.id), ['takeoverToggle', 'openSettings']);
        assert.equal(document.getElementById('takeoverToggle').getAttribute('aria-pressed'), 'false');
        assert.equal(document.querySelector('#takeoverMenu, #takeoverStart, #closeSettings, #deviceNavigation > :not(.nav-key)'), null);
        assert.ok(document.getElementById('takeoverStatus').closest('#stage'));
        assert.match(css, /#app \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
        assert.equal(document.querySelector('header .metrics, footer, .viewer-toolbar'), null);
        for (const id of ['fit', 'reconnect', 'setup', 'qualityPanel', 'wizard', 'res', 'seq']) {
            assert.ok(document.getElementById(id).closest('#settingsPage'), `#${id} belongs in settings`);
        }
        assert.equal(document.getElementById('settingsPage').classList.contains('hidden'), true);
        assert.equal(document.querySelector('#stage select, #stage .toolbar, #stage #wizard'), null);
        assert.equal(document.querySelector('.card'), null, 'guide must not be a giant centered card');
        assert.ok(document.querySelector('.guide-layout #step3'));
        assert.doesNotMatch(css, /(?:-webkit-)?app-region\s*:/);
        assert.doesNotMatch(script, /(?:addEventListener|listenTakeover)\(\s*els\.(?:screen|h264)\s*,\s*['"](?:touchstart|touchmove|pointerdown|mousedown)/);
        assert.doesNotMatch(script, /els\.(?:screen|h264)\.addEventListener\(\s*['"](?:touchstart|touchmove|pointerdown|mousedown)/);
        assert.equal(document.querySelector('link[rel="stylesheet"], script[src]'), null, 'self-contained HTTP page');
    } finally { dom.window.close(); }
});

test('inline style parses with dark and light semantic themes, narrow layout and keyboard focus', () => {
    const ast = cssTree.parse(css);
    const rules = [], media = [];
    cssTree.walk(ast, node => {
        if (node.type === 'Rule') rules.push(node);
        if (node.type === 'Atrule' && node.name === 'media') media.push(cssTree.generate(node.prelude));
    });
    const roots = rules.filter(node => cssTree.generate(node.prelude) === ':root');
    assert.equal(roots.length, 2);
    for (const root of roots) {
        const declarations = new Map(root.block.children.toArray().map(node => [node.property, cssTree.generate(node.value)]));
        for (const token of ['--bg', '--panel', '--panel-2', '--line', '--text', '--muted', '--accent', '--on-accent', '--ok', '--warn', '--bad']) {
            assert.ok(declarations.has(token), `semantic theme token ${token}`);
        }
    }
    assert.match(cssTree.generate(roots[0]), /color-scheme:dark/);
    assert.match(cssTree.generate(roots[1]), /color-scheme:light/);
    assert.ok(media.includes('(prefers-color-scheme:light)'));
    assert.ok(media.includes('(max-width:720px)'));
    assert.ok(media.includes('(max-width:420px)'));
    assert.ok(media.includes('(prefers-reduced-motion:reduce)'));
    assert.match(css, /:focus-visible\s*\{[^}]*outline:/);
    assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
    assert.doesNotMatch(css, /radial-gradient|box-shadow/);
});

test('boot without devices only polls device status; no scan, connection request or stream', async t => {
    const v = await viewer(t);
    assert.deepEqual(v.calls.map(call => [call.url, call.method]), [['/api/adb', 'GET'], ['/api/display/preferences', 'GET'], ['/api/devices', 'GET']]);
    assert.ok(v.calls.every(call => call.credentials === 'same-origin'));
    assert.equal(v.sockets.length, 0);
    assert.equal(v.timers.length, 1);
    assert.equal(v.timers[0].delay, 4000);
    assert.equal(v.get('settingsPage').classList.contains('hidden'), true);
    assert.equal(v.get('emptyState').classList.contains('hidden'), false);
    assert.equal(v.get('conn').textContent, '等待连接手机');
    assert.equal(v.get('deviceSummary').textContent, '未发现已连接设备');
    assert.doesNotMatch(script, /startAutoConnect|stopAutoConnect|AUTO_CONNECT_|autoConnecting|autoAttempts/);
});

test('missing adb shows actionable text and does not attempt devices or connection', async t => {
    const v = await viewer(t, { adb: { available: false, error: '<img src=x onerror=alert(1)>' } });
    assert.equal(v.calls.length, 1);
    assert.match(v.get('tipBox').textContent, /ADB_PATH/);
    assert.equal(v.get('connMsg').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(v.get('connMsg').children.length, 0);
});

test('device and address data render as text, never HTML or per-row fake selectors', async t => {
    const hostile = '<img src=x onerror=alert(1)>';
    const v = await viewer(t, {
        adb: { addresses: [{ address: hostile }, { address: '10.0.0.2' }] },
        devices: [{ serial: hostile, model: '<svg onload=alert(2)>', state: 'device' },
            { serial: 'other', model: 'Other phone', state: 'device' },
            { serial: 'untrusted', state: hostile }],
    });
    assert.match(v.get('tipBox').textContent, /<img src=x/);
    assert.equal(v.get('tipBox').children.length, 0);
    assert.equal(v.get('deviceList').querySelector('img, svg, button'), null);
    assert.equal(v.get('deviceList').querySelectorAll('[role="listitem"]').length, 3);
    assert.match(v.get('deviceList').textContent, /已授权 · 就绪/);
    assert.match(v.get('deviceSummary').textContent, /2 台设备就绪.*由连接管理选择.*不切换投屏.*身份尚未提供/);
    assert.equal(v.get('connAddr').value, '', 'do not pretend first ready serial is selected');
    assert.equal(v.sockets.length, 1, 'existing ready devices retain stream attach behavior');
    assert.ok(v.calls.every(call => call.method === 'GET'));
});

test('connection management stays open on refresh and returns to the stream explicitly', async t => {
    const v = await viewer(t, { devices: [{ serial: 'ready', state: 'device' }] });
    assert.equal(v.get('wizard').classList.contains('hidden'), true);
    await v.click('setup');
    assert.equal(v.get('wizard').classList.contains('hidden'), false);
    assert.equal(v.get('settingsPage').classList.contains('hidden'), false);
    assert.equal(v.get('setup').getAttribute('aria-selected'), 'true');
    assert.equal(v.document.activeElement.id, 'settingsTitle');
    await v.click('refresh');
    assert.equal(v.get('wizard').classList.contains('hidden'), false);
    assert.equal(v.sockets.length, 1, 'read-only refresh must not churn WebSocket');
    await v.click('returnToScreen');
    assert.equal(v.get('settingsPage').classList.contains('hidden'), true);
    assert.equal(v.get('openSettings').getAttribute('aria-expanded'), 'false');
    assert.equal(v.document.activeElement.id, 'openSettings');
    assert.equal(v.sockets.length, 1, 'returning from settings must reuse the live stream');
});

test('fit control exposes toggle state without adding device interaction', async t => {
    const v = await viewer(t);
    await v.click('fit');
    assert.equal(v.get('fit').getAttribute('aria-pressed'), 'true');
    assert.ok(v.get('screen').classList.contains('fit-width'));
    assert.ok(v.get('h264').classList.contains('fit-width'));
    await v.click('fit');
    assert.equal(v.get('fit').getAttribute('aria-pressed'), 'false');
    assert.equal(v.get('screen').classList.contains('fit-width'), false);
    assert.equal(v.calls.length, 5);
    assert.deepEqual(v.calls.filter(call => call.method === 'POST').map(call => [call.url, JSON.parse(call.body)]),
        [['/api/display/preferences', { fitWidth: true }], ['/api/display/preferences', { fitWidth: false }]]);
});

test('explicit scan remains available and discovered addresses are text-only', async t => {
    const hostile = '<img src=x onerror=alert(1)>';
    const v = await viewer(t, { replies: { '/api/discover': { ok: true,
        connect: [{ address: hostile, connected: false }], pairing: [{ address: hostile }] } } });
    await v.click('doScan');
    assert.deepEqual(v.calls.slice(3).map(call => [call.url, call.method]), [['/api/discover', 'POST']]);
    assert.equal(v.get('scanList').querySelector('img, button'), null);
    assert.equal(v.get('scanList').textContent, `${hostile}连接中`);
    assert.equal(v.get('pairBox').classList.contains('hidden'), false);
    assert.equal(v.document.activeElement.id, 'pairCode');
});

test('explicit connect preserves manual payload and starts only an existing ready device', async t => {
    const v = await viewer(t);
    await v.click('connectSettings');
    v.get('connAddr').value = '192.168.1.10';
    v.get('connPort').value = '37123';
    v.get('doConnect').focus();
    v.results['/api/devices'] = { ok: true, devices: [{ serial: '192.168.1.10:37123', state: 'device' }] };
    await v.click('doConnect');
    const call = v.calls.find(call => call.url === '/api/connect');
    assert.equal(call.method, 'POST');
    assert.deepEqual(JSON.parse(call.body), { address: '192.168.1.10:37123' });
    assert.equal(v.sockets.length, 1);
    assert.equal(v.get('settingsPage').classList.contains('hidden'), true);
    assert.equal(v.document.activeElement.id, 'openSettings');
});

test('quality loads existing custom values and applies a single explicit request without device discovery', async t => {
    const v = await viewer(t, { replies: {
        '/api/scrcpy': { ok: true, available: true, status: { maxFps: 48, bitRate: 6000000, maxSize: 900 } },
        '/api/scrcpy/config': { ok: true, applied: 'next-start', status: { maxFps: 60, bitRate: 8000000, maxSize: 1080 } },
    } });
    await v.click('quality');
    assert.equal(v.get('quality').getAttribute('aria-selected'), 'true');
    assert.deepEqual(['qualityFps', 'qualityBitRate', 'qualitySize'].map(id => v.get(id).value), ['48', '6000000', 'long:900']);
    assert.match(v.get('qualitySize').selectedOptions[0].textContent, /旧配置/);
    assert.equal(v.get('applyQuality').disabled, false);
    v.get('qualityFps').value = '60'; v.get('qualityBitRate').value = '8000000'; v.get('qualitySize').value = 'short:1080';
    await v.click('applyQuality');
    const writes = v.calls.filter(call => call.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, '/api/scrcpy/config');
    assert.deepEqual(JSON.parse(writes[0].body), { maxFps: 60, bitRate: 8000000, maxShortEdge: 1080 });
    assert.equal(writes[0].credentials, 'same-origin');
    assert.match(v.get('qualityMessage').textContent, /下次启动/);
    assert.equal(v.sockets.length, 0);
    v.document.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(v.get('settingsPage').classList.contains('hidden'), true);
});

test('quality unavailable or failed reads keep all controls disabled without writing', async t => {
    const v = await viewer(t, { replies: { '/api/scrcpy': { ok: true, available: false, status: null } } });
    await v.click('quality');
    for (const id of ['qualityFps', 'qualityBitRate', 'qualitySize', 'applyQuality']) assert.equal(v.get(id).disabled, true);
    assert.match(v.get('qualityMessage').textContent, /不可用/);
    await v.click('applyQuality');
    assert.equal(v.calls.some(call => call.method === 'POST'), false);
});

test('quality holds edits during an in-flight apply and reports failures without replaying the write', async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const v = await viewer(t, { replies: {
        '/api/scrcpy': { ok: true, available: true, status: { maxFps: 30, bitRate: 2000000, maxSize: 720 } },
        '/api/scrcpy/config': () => pending,
    } });
    await v.click('quality');
    await v.click('applyQuality');
    await v.click('applyQuality');
    await v.click('quality'); await v.click('quality');
    assert.equal(v.get('qualityFps').disabled, true);
    assert.equal(v.calls.filter(call => call.url === '/api/scrcpy').length, 1);
    assert.equal(v.calls.filter(call => call.method === 'POST').length, 1);
    release({ ok: false, saved: true, applied: 'fallback', error: '<img onerror=fail()> 编码失败',
        status: { maxFps: 30, bitRate: 2000000, maxSize: 720 } });
    await tick(); await tick();
    assert.match(v.get('qualityMessage').textContent, /配置已保存.*兼容画面/);
    assert.equal(v.get('qualityMessage').querySelector('img'), null);
    assert.equal(v.get('applyQuality').disabled, false);
    assert.equal(v.calls.filter(call => call.method === 'POST').length, 1);
    for (const [response, expected] of [
        [{ ok: false, saved: true, applied: 'next-start', error: '设备切换取消' }, /配置已保存.*被取消/],
        [{ ok: false, error: '请求失败' }, /请求失败/],
        [{ ok: true, applied: 'active-stream' }, /已重启视频流并应用/],
    ]) {
        v.results['/api/scrcpy/config'] = response;
        await v.click('applyQuality');
        assert.match(v.get('qualityMessage').textContent, expected);
    }
});


test('short-edge presets preview both dimensions without stretching or upscaling, and native sends zero', async t => {
    const v = await viewer(t, { replies: {
        '/api/scrcpy': { ok: true, available: true, status: { maxFps: 30, bitRate: 2000000,
            maxSize: 540, maxShortEdge: 720, sourceWidth: 1080, sourceHeight: 2400 } },
        '/api/scrcpy/config': { ok: true, applied: 'next-start' },
    } });
    await v.click('openSettings');
    assert.equal(v.get('qualitySize').value, 'short:720');
    assert.match(v.get('resolutionPreview').textContent, /1080 × 2400.*720 × 1600.*等比/);
    v.get('qualitySize').value = 'short:2160';
    v.get('qualitySize').dispatchEvent(new v.window.Event('change'));
    assert.match(v.get('resolutionPreview').textContent, /预计 1080 × 2400.*不放大/);
    v.get('qualitySize').value = 'native';
    v.get('qualitySize').dispatchEvent(new v.window.Event('change'));
    await v.click('applyQuality');
    const writes = v.calls.filter(call => call.method === 'POST');
    assert.deepEqual(JSON.parse(writes[0].body), { maxFps: 30, bitRate: 2000000, maxShortEdge: 0 });
    assert.equal(writes.length, 1);
    v.get('qualitySize').value = '';
    await v.click('applyQuality');
    assert.equal(v.calls.filter(call => call.method === 'POST').length, 1, 'invalid selection must not mutate configuration');
});

test('legacy resolution remains unchanged when only bitrate changes', async t => {
    const v = await viewer(t, { replies: {
        '/api/scrcpy': { ok: true, available: true, status: { maxFps: 30, bitRate: 2000000, maxSize: 900 } },
        '/api/scrcpy/config': { ok: true, applied: 'next-start' },
    } });
    await v.click('openSettings');
    v.get('qualityBitRate').value = '4000000';
    await v.click('applyQuality');
    assert.deepEqual(JSON.parse(v.calls.find(call => call.method === 'POST').body),
        { maxFps: 30, bitRate: 4000000, maxSize: 900 });
});

test('explicit reconnect replaces an open socket while ordinary settings return does not', async t => {
    const v = await viewer(t, { devices: [{ serial: 'ready', state: 'device' }] });
    const old = v.sockets[0];
    old.readyState = 1;
    await v.click('reconnect');
    assert.equal(old.readyState, 3);
    assert.equal(v.sockets.length, 2);
    assert.equal(v.get('settingsPage').classList.contains('hidden'), true);
    assert.ok(v.calls.every(call => call.method === 'GET'));
});

test('first JPEG stays hidden through connect, socket-open and decode, and reveals only after the displayed image loads', async t => {
    const images = [], revoked = [];
    const v = await viewer(t, { devices: [{ serial: 'ready', state: 'device' }], setup(window) {
        window.URL.createObjectURL = () => `blob:fixture-${images.length}`;
        window.URL.revokeObjectURL = url => revoked.push(url);
        window.Image = class { constructor() { this.naturalWidth = 720; this.naturalHeight = 1600; images.push(this); } };
    } });
    assert.equal(v.get('stage').dataset.streamState, 'loading');
    assert.equal(v.get('stage').getAttribute('aria-busy'), 'true');
    assert.equal(v.get('screen').hasAttribute('src'), false);
    assert.equal(v.get('screen').classList.contains('hidden'), true);
    assert.equal(v.get('h264').classList.contains('hidden'), true);
    const ws = v.sockets[0]; ws.readyState = 1; ws.send = () => {}; ws.onopen();
    assert.equal(v.get('stage').dataset.streamState, 'loading', 'socket-ready is not frame-ready');
    ws.onmessage({ data: packet(v.window, 0x56434d31, [0x89, 0x50, 0x4e, 0x47]) });
    images[0].onload();
    assert.equal(v.get('stage').dataset.streamState, 'loading', 'preloading is not onscreen rendering');
    Object.defineProperty(v.get('screen'), 'naturalWidth', { value: 720 });
    v.get('screen').dispatchEvent(new v.window.Event('load'));
    assert.equal(v.get('stage').dataset.streamState, 'ready');
    assert.equal(v.get('stage').getAttribute('aria-busy'), 'false');
    assert.equal(v.get('streamPlaceholder').getAttribute('aria-hidden'), 'true');
    assert.equal(v.get('screen').classList.contains('hidden'), false);
    assert.equal(v.get('takeoverBack').disabled, true, 'navigation still needs human authorization');
    assert.ok(v.get('takeoverBack').closest('#deviceNavigation'));
});

test('first-frame timeout offers retry and a stale JPEG decode cannot replace a new connection', async t => {
    const images = [], revoked = [];
    const v = await viewer(t, { devices: [{ serial: 'ready', state: 'device' }], setup(window) {
        window.URL.createObjectURL = () => `blob:fixture-${images.length}`;
        window.URL.revokeObjectURL = url => revoked.push(url);
        window.Image = class { constructor() { this.naturalWidth = 720; this.naturalHeight = 1600; images.push(this); } };
    } });
    v.sockets[0].onmessage({ data: packet(v.window, 0x56434d31, [0xff, 0xd8, 0xff, 0xe0]) });
    v.timers.find(timer => timer.delay === 15000).fn();
    assert.equal(v.get('stage').dataset.streamState, 'error');
    assert.match(v.get('streamTitle').textContent, /超时/);
    assert.equal(v.get('retryStream').classList.contains('hidden'), false);
    await v.click('retryStream');
    assert.equal(v.sockets.length, 2);
    assert.equal(v.get('stage').dataset.streamState, 'loading');
    images[0].onload();
    assert.equal(v.get('screen').hasAttribute('src'), false);
    assert.equal(v.get('stage').dataset.streamState, 'loading');
    assert.equal(revoked.length, 1);
});

test('H264 metadata alone does not reveal a blank canvas; the first decoded VideoFrame does', async t => {
    const decoders = [];
    let paint;
    let drawn = 0, closed = 0;
    const v = await viewer(t, { devices: [{ serial: 'ready', state: 'device' }], setup(window) {
        window.requestAnimationFrame = fn => { paint = fn; return 1; };
        window.cancelAnimationFrame = () => { paint = null; };
        window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() { drawn++; } });
        window.VideoDecoder = class {
            constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; decoders.push(this); }
            configure() { this.state = 'configured'; }
            close() { this.state = 'closed'; }
        };
    } });
    v.sockets[0].onmessage({ data: JSON.stringify({ type: 'scrcpy-ready', width: 720, height: 1600, codecString: 'avc1.64001e' }) });
    assert.equal(v.get('stage').dataset.streamState, 'loading');
    assert.equal(v.get('h264').classList.contains('hidden'), true);
    v.sockets[0].onmessage({ data: packet(v.window, 0x56434831, [0,0,0,1,0x67,0x64,0,0x1e,0,0,0,1,0x68,1], 2) });
    assert.equal(decoders.length, 1);
    decoders[0].callbacks.output({ displayWidth: 720, displayHeight: 1600, close() { closed++; } });
    assert.equal(drawn, 0, 'decode output waits for the display refresh');
    paint();
    assert.equal(drawn, 1); assert.equal(closed, 1);
    assert.equal(v.get('stage').dataset.streamState, 'ready');
    assert.equal(v.get('h264').classList.contains('hidden'), false);
    await v.click('reconnect');
    decoders[0].callbacks.output({ displayWidth: 720, displayHeight: 1600, close() { closed++; } });
    assert.equal(drawn, 1, 'closed decoder callback cannot revive old frames');
    assert.equal(closed, 2, 'stale VideoFrame is still released');
});

test('settings-only child reads saved values, never creates a second stream and forwards viewer actions', async t => {
    const actions = [];
    const v = await viewer(t, { url: 'http://127.0.0.1:18444/settings?section=display', devices: [{ serial: 'ready', state: 'device' }],
        replies: { '/api/scrcpy': { ok: true, available: true, status: { maxFps: 60, bitRate: 8000000, maxShortEdge: 1080 } },
            '/api/display/preferences': { ok: true, fitWidth: true } },
        setup(window) { window.androidDisplay = { fitWindow() {}, requestViewerAction(action) { actions.push(action); } }; } });
    assert.equal(v.document.body.classList.contains('settings-window'), true);
    assert.equal(v.get('qualityFps').value, '60');
    assert.equal(v.get('qualitySize').value, 'short:1080');
    assert.equal(v.get('fit').getAttribute('aria-pressed'), 'true');
    assert.equal(v.sockets.length, 0);
    await v.click('fitWindow'); await v.click('reconnect');
    assert.deepEqual(actions, ['fit', 'reconnect']);
    assert.equal(v.sockets.length, 0);
    assert.ok(v.calls.every(call => call.method === 'GET'));
});

test('connecting from settings hands the stream to the main window before closing the child', async t => {
    for (const method of ['manual', 'scan', 'pair']) {
        const events = [];
        let acknowledge;
        const v = await viewer(t, { url: 'http://127.0.0.1:18444/settings?section=connection',
            replies: { '/api/discover': { ok: true, connect: [{ address: 'fixture:5555' }] } },
            setup(window) {
                window.close = () => events.push('close');
                window.androidDisplay = { requestViewerAction(action) {
                    events.push(action);
                    return new Promise(resolve => { acknowledge = resolve; });
                } };
            } });
        v.results['/api/devices'] = { ok: true, devices: [{ serial: 'fixture:5555', state: 'device' }] };
        v.get('pairCode').value = '123456';
        await v.click(method === 'manual' ? 'doConnect' : method === 'scan' ? 'doScan' : 'doPair');
        assert.deepEqual(events, ['reconnect'], `${method}: keep sender alive until the main window accepts the action`);
        assert.equal(v.sockets.length, 0);
        acknowledge(true);
        await tick(); await tick();
        assert.deepEqual(events, ['reconnect', 'close'], `${method}: return to the existing main window`);
    }
});

test('settings stays open and reports a rejected or failed main-window handoff without replaying connect', async t => {
    for (const throws of [false, true]) {
        let closed = false, relayed = 0;
        const v = await viewer(t, { url: 'http://127.0.0.1:18444/settings?section=connection', setup(window) {
            window.close = () => { closed = true; };
            window.androidDisplay = { async requestViewerAction() {
                relayed++;
                if (throws) throw new Error('window closed');
                return false;
            } };
        } });
        v.results['/api/devices'] = { ok: true, devices: [{ serial: 'fixture:5555', state: 'device' }] };
        await v.click('doConnect');
        assert.equal(closed, false);
        assert.equal(relayed, 1);
        assert.match(v.get('connMsg').textContent, /设备已连接.*主窗口/);
        assert.equal(v.calls.filter(call => call.url === '/api/connect').length, 1);
        assert.equal(v.sockets.length, 0);
    }
});

test('native settings launch leaves the stage and socket unchanged instead of swapping pages', async t => {
    const sections = [];
    const v = await viewer(t, { devices: [{ serial: 'ready', state: 'device' }], setup(window) {
        window.androidDisplay = { openSettings(section) { sections.push(section); } };
    } });
    await v.click('openSettings'); await v.click('connectSettings');
    assert.deepEqual(sections, ['display', 'connection']);
    assert.equal(v.get('settingsPage').classList.contains('hidden'), true);
    assert.equal(v.get('stage').classList.contains('hidden'), false);
    assert.equal(v.sockets.length, 1);
});

test('saved display mode restores without a startup write and a failed save does not change it', async t => {
    const v = await viewer(t, { replies: { '/api/display/preferences': options => options.method === 'GET'
        ? { ok: true, fitWidth: true } : { ok: false, error: 'disk full' } } });
    assert.equal(v.get('fit').getAttribute('aria-pressed'), 'true');
    assert.ok(v.calls.every(call => call.method === 'GET'));
    await v.click('fit');
    assert.equal(v.get('fit').getAttribute('aria-pressed'), 'true');
    assert.match(v.get('qualityMessage').textContent, /disk full/);
});

test('settings keyboard tabs preserve unsaved edits and Escape restores the titlebar without reconnecting', async t => {
    const v = await viewer(t, { devices: [{ serial: 'ready', state: 'device' }], replies: {
        '/api/scrcpy': { ok: true, available: true, status: { maxFps: 30, bitRate: 2000000, maxShortEdge: 720 } },
    } });
    await v.click('openSettings');
    assert.equal(v.get('stage').classList.contains('hidden'), true);
    v.get('qualitySize').value = 'short:1080';
    await v.click('diagnosticsTab');
    v.get('diagnosticsTab').dispatchEvent(new v.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await tick();
    assert.equal(v.document.activeElement.id, 'quality');
    assert.equal(v.get('quality').getAttribute('aria-selected'), 'true');
    assert.equal(v.get('setup').tabIndex, -1);
    assert.equal(v.get('qualitySize').value, 'short:1080', 'tab changes must not discard the draft');
    assert.equal(v.calls.filter(call => call.url === '/api/scrcpy').length, 1);
    v.document.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(v.get('settingsPage').classList.contains('hidden'), true);
    assert.equal(v.get('stage').classList.contains('hidden'), false);
    assert.equal(v.document.activeElement.id, 'openSettings');
    assert.equal(v.sockets.length, 1);
    assert.ok(v.calls.every(call => call.method === 'GET'));
});

test('controller settings preserve drafts across tabs and failed saves, and save typed policy through native bridge', async t => {
    const schema = require('../VCPDistributedServer/Plugin/AndroidController/plugin-manifest.json').configSchema;
    const { KEYS } = require('../VCPDistributedServer/Plugin/AndroidController/lib/controller-settings');
    const values = Object.fromEntries(KEYS.map(key => [key, schema[key].default]));
    const writes = [];
    let reads = 0, opens = 0, succeed = false;
    const v = await viewer(t, { setup(window) {
        window.androidDisplay = {
            async readControllerSettings() { reads++; return { ok: true, values, revision: 'before', pendingRestart: [] }; },
            async saveControllerSettings(request) { writes.push(request); return succeed
                ? { ok: true, values: request.values, revision: 'after', pendingRestart: ['AUTO_WAKE'] }
                : { ok: false, error: '配置已被其他窗口修改' }; },
            async openSystemAuthorization() { opens++; return { ok: true }; },
        };
    } });
    await v.click('controllerTab');
    assert.equal(v.get('controllerFields').disabled, false);
    v.get('controllerAutoWake').checked = false;
    v.get('controllerDenyPackages').value = 'com.private\ncom.bank';
    v.get('controllerConfirmWrite').checked = true;
    await v.click('setup'); await v.click('controllerTab');
    assert.equal(reads, 1);
    assert.equal(v.get('controllerAutoWake').checked, false);
    await v.click('saveController');
    assert.match(v.get('controllerMessage').textContent, /其他窗口/);
    assert.equal(v.get('controllerDenyPackages').value, 'com.private\ncom.bank');
    assert.equal(writes.length, 1, 'failure must not retry');
    assert.equal(writes[0].revision, 'before');
    assert.equal(writes[0].values.ADB_TIMEOUT_MS, 20000);
    assert.deepEqual(JSON.parse(writes[0].values.INTERACTION_POLICY), {
        denyPackages: ['com.private', 'com.bank'], readOnlyPackages: [], confirmEveryWrite: true,
    });
    succeed = true;
    await v.click('saveController');
    assert.match(v.get('controllerMessage').textContent, /重启 VCPChat 后生效/);
    await v.click('openSystemAuthorization');
    assert.equal(opens, 1);
    assert.ok(v.calls.every(call => call.method === 'GET'), 'no device API writes');
});

test('browser controller settings remain disabled with an actionable native-window instruction', async t => {
    const v = await viewer(t);
    await v.click('controllerTab');
    assert.equal(v.get('controllerFields').disabled, true);
    assert.equal(v.get('saveController').disabled, true);
    assert.equal(v.get('openSystemAuthorization').disabled, true);
    assert.match(v.get('controllerMessage').textContent, /独立窗口/);
});

test('reset display submits one reset transaction and restores saved fit mode even on encoder fallback', async t => {
    const v = await viewer(t, { replies: {
        '/api/scrcpy': { ok: true, available: true, status: { maxFps: 60, bitRate: 8000000, maxShortEdge: 1080 } },
        '/api/display/preferences': { ok: true, fitWidth: true },
        '/api/display/reset': { ok: false, saved: true, fitWidth: false, applied: 'fallback', error: 'encoder unavailable',
            status: { maxFps: 30, bitRate: 2000000, maxSize: 540, maxShortEdge: null } },
    } });
    await v.click('openSettings');
    await v.click('resetDisplay');
    assert.equal(v.get('fit').getAttribute('aria-pressed'), 'false');
    assert.equal(v.get('qualityFps').value, '30');
    assert.match(v.get('qualityMessage').textContent, /配置已保存/);
    assert.deepEqual(v.calls.filter(call => call.method === 'POST').map(call => [call.url, call.body]), [['/api/display/reset', '{}']]);
});
