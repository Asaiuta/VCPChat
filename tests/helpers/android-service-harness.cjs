'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { UiServer } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
const { createRequire } = require('node:module');

const entry = path.resolve(__dirname, '../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
const realRequire = createRequire(entry);
const xml = (label = 'Go', top = 0) => `<hierarchy rotation="0"><node class="android.widget.Button" package="com.example" resource-id="com.example:id/go" text="${label}" clickable="true" bounds="[0,${top}][100,${top + 40}]" /></hierarchy>`;

async function harness(options = {}) {
    const dataDir = options.dataDir || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'android-service-'));
    const calls = [];
    let dumps = 0;
    const client = {
        serial: options.serial ?? 'A', adbPath: 'fake-adb',
        async devices() { return [{ serial: 'A', state: 'device' }, { serial: 'B', state: 'device' }]; },
        async probeScreen(serial, options = {}) {
            calls.push(['probe', serial]);
            return { focus: { package: 'com.example', component: 'com.example/.Main', window: 'Window{test u0 com.example/.Main}' },
                size: { width: 100, height: 200 }, wakefulness: 'Awake', rotation: 0, displayId: 0,
                keyguard: { showing: false, inputRestricted: false } };
        },
        async screenSize() { return { width: 100, height: 200 }; },
        async currentFocus(serial) { calls.push(['focus', serial]); return { package: options.foreground || 'com.example', component: 'com.example/.Main' }; },
        async runText(args, request = {}) {
            calls.push(['adb', args, request]);
            if (args[1] === 'cat /proc/sys/kernel/random/boot_id && settings get secure android_id') {
                return (options.bootId?.() || '12345678-1234-1234-1234-123456789012') + '\n1234567890abcdef';
            }
            if (options.run) {
                const custom = await options.run(args, request);
                if (custom !== undefined) return custom;
            }
            if (args.includes('uiautomator') || (args[0] === 'exec-out' && args[1] === 'cat')) {
                const index = dumps++;
                const value = options.dump ? await options.dump(index, args) : xml();
                if (value instanceof Error) throw value;
                return value;
            }
            if (args.includes('packages')) return 'package:com.example';
            if (args.includes('resolve-activity')) return 'com.example/.Main';
            return '';
        },
        async enqueue(args, request) { return { stdout: await this.runText(args, request), stderr: '' }; },
    };
    Object.assign(client, options.client || {});
    const hub = options.hub || {};
    for (const [name, fn] of Object.entries({ async stop() {}, configure() {}, status() { return {}; } })) hub[name] ??= fn;
    // 常驻 UI 采集服务替身：默认「起不来」，保持既有回退语义，但不再真的 spawn adb。
    // 记录 start 次数，供「配置关掉时连尝试都不该有」这类断言使用。
    const uiServer = { started: 0, stopped: 0, dumped: 0 };
    function UiServerStub(serverOptions = {}) {
        const spec = options.uiServer || {};
        this.carrierIdentity = spec.carrier || null;
        this.start = async () => {
            uiServer.started += 1;
            if (spec.start) return spec.start(uiServer.started);
            return spec.ok === true ? { ok: true, port: 9008, carrier: this.carrierIdentity } : { ok: false, reason: 'stub-unavailable', carrier: this.carrierIdentity };
        };
        const transport = {
            generation: 1,
            isReady: () => typeof spec.ready === 'function' ? spec.ready() : spec.ok === true,
            async call(method, params, timeoutMs, signal) {
                const request = { timeoutMs, signal };
                calls.push(['rpc', method, params, request]);
                if (spec.invoke) return spec.invoke(method, params, request);
                return method === 'getText' ? (spec.text ?? '') : true;
            },
            async stop() {
                this.generation++;
                uiServer.stopped += 1;
                return spec.stop?.(serverOptions.serial);
            },
        };
        const session = new UiServer({ transport });
        this.invoke = session.invoke.bind(session);
        this.isReady = session.isReady.bind(session);
        this.noteCapability = session.noteCapability.bind(session);
        this.capability = session.capability.bind(session);
        this.stop = session.stop.bind(session);
        this.dump = async () => {
            uiServer.dumped += 1;
            if (!transport.isReady()) throw new Error('stub not ready');
            const currentXml = spec.xml;
            return { xml: typeof currentXml === 'function' ? await currentXml(uiServer.dumped) : currentXml || xml() };
        };
    }
    const frames = {
        requireSharp() { return {}; }, async captureOneShot() { return {}; },
        invalidateSelection() {}, stop() {}, pauseLoop() {}, async capture() { return {}; }, status() { return {}; },
    };
    Object.assign(frames, options.frames || {});
        let api;
        let takeoverApi;
    const overrides = {
        './lib/adb': { AdbClient: function () { return client; }, AdbError: class extends Error {} },
        './lib/ui-server': { UiServer: UiServerStub, UiServerError: class extends Error {} },
        './lib/frame-hub': { FrameHub: function () { return frames; } },
        './lib/scrcpy-hub': { ScrcpyHub: function () { return hub; } },
        './lib/stream-server': { StreamServer: function (serverOptions) { api = serverOptions.deviceApi; takeoverApi = serverOptions.takeoverApi; return options.streamServer || { async start() {}, async stop() {}, async changeDevice(select) { return select(); }, url() { return options.displayUrl || null; } }; } },
        './lib/vision': options.vision || {
            DEFAULT_MAX_WIDTH: 1080,
            async buildVisionFrame() { return { sourceWidth: 100, sourceHeight: 200, width: 100, height: 200, byteLength: 1, dataUrl: 'data:image/jpeg;base64,AA==', mapping: { region: {} } }; },
            describeMapping() { return ''; },
        },
        'node:fs': { readFileSync() { throw new Error('absent'); }, mkdirSync() {}, writeFileSync() {}, unlinkSync() {} },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(entry), __filename: entry,
        require(name) { return Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name); },
        console, Buffer, process, Date, setTimeout, clearTimeout, AbortController,
    }, { filename: entry });
    await module.exports.initialize({ dataDir, config: { DEVICE_SERIAL: client.serial, ...(options.config || {}) }, services: options.services, logger: { log() {}, warn() {} } });
    return { service: module.exports, client, api, takeoverApi, calls, uiServer, dataDir, get dumpCount() { return dumps; } };
}

module.exports = { harness, xml };
