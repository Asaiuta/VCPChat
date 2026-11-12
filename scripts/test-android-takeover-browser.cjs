'use strict';

// Isolated browser fixture: device transport and native approval are substitutes.
// Production Service, takeover session, runtime, HTTP/WS and image mapping execute.
const sharp = require('sharp');
const { harness } = require('../tests/helpers/android-service-harness.cjs');
const { StreamServer } = require('../VCPDistributedServer/Plugin/AndroidController/lib/stream-server');
const vision = require('../VCPDistributedServer/Plugin/AndroidController/lib/vision');
let server, h, timer;
(async () => {
    let clicks = 0, keys = 0, approvals = 0;
    async function image() {
        const svg = `<svg width="100" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="200" fill="#ecedf0"/><rect x="8" y="8" width="84" height="30" rx="4" fill="#8a3c32"/><text x="50" y="27" text-anchor="middle" font-size="9" fill="#f8f5ef">Tap fixture ${clicks}</text><text x="50" y="98" text-anchor="middle" font-size="8" fill="#34383c">No real device</text></svg>`;
        return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), width: 100, height: 200, mime: 'image/png', seq: clicks + 1, capturedAt: Date.now() };
    }
    h = await harness({ vision, services: { humanInteraction: { async request() { approvals++; return true; } } },
        frames: { requireSharp() { return sharp; }, captureOneShot: image },
        uiServer: { ok: true, async invoke(method) { if (method === 'click') clicks++; return true; } },
        run(args) { if (args.includes('keyevent')) keys++; },
    });
    const subscribers = new Set();
    const frameHub = { adb: h.client, latestOrNull() { return null; }, status() { return { streaming: true }; },
        subscribe(sink) { subscribers.add(sink); void image().then(sink); return () => subscribers.delete(sink); } };
    server = new StreamServer({ port: 0, frameHub,
        takeoverApi: { ...h.takeoverApi, status: () => ({ ...h.takeoverApi.status(), fixtureClicks: clicks, fixtureKeys: keys, fixtureApprovals: approvals }) },
        deviceApi: { ...h.api, async adbStatus() { return { ok: true, available: true, addresses: [] }; } },
        logger: { log() {}, warn() {} } });
    await server.start();
    console.log(JSON.stringify({ fixtureUrl: server.url(), realDevice: false, nativeApproval: 'substitute' }));
    timer = setTimeout(stop, 300000);
})().catch(error => { console.error(error); process.exitCode = 1; void stop(); });
async function stop() { clearTimeout(timer); await server?.stop(); await h?.service.cleanup(); }
process.on('SIGTERM', () => { void stop(); });
