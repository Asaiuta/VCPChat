'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const scene = rotation => `<hierarchy rotation="${rotation}"><node class="android.widget.Button" package="com.example" resource-id="com.example:id/icon" text="Icon" clickable="true" enabled="true" bounds="[10,10][60,70]"/></hierarchy>`;

for (const changed of [false, true]) {
    test(`element screenshot ${changed ? 'rejects changed' : 'accepts unchanged'} rotation with identical dimensions and target`, async () => {
        let captured = false;
        let builds = 0;
        const h = await harness({
            client: { async probeScreen() {
                return { focus: { package: 'com.example', component: 'com.example/.Main', window: 'Main' },
                                    size: { width: 100, height: 200 }, wakefulness: 'Awake', rotation: captured && changed ? 2 : 0,
                                    displayId: 0, keyguard: { showing: false, inputRestricted: false } };
            } },
            uiServer: { ok: true, xml: () => scene(captured && changed ? 2 : 0) },
            frames: { async captureOneShot() { captured = true; return {}; } },
            vision: {
                DEFAULT_MAX_WIDTH: 1080,
                elementRegion({ bounds, visibleBounds }) { return { elementBounds: bounds, visibleBounds,
                    region: { left: 10, top: 10, width: 50, height: 60 }, center: { x: 35, y: 40 } }; },
                async buildVisionFrame() { builds++; return { sourceWidth: 100, sourceHeight: 200, width: 50, height: 60, byteLength: 1,
                    dataUrl: 'data:image/jpeg;base64,AA==', mapping: { region: {} } }; },
                describeMapping() { return ''; },
            },
        });
        try {
            const request = h.service.processToolCall({ command: 'Observe', mode: 'image', target: 'element',
                serial: 'A', id: 'com.example:id/icon' });
            if (changed) await assert.rejects(request, { code: 'ELEMENT_CONTEXT_CHANGED' });
            else assert.ok((await request).details.frameId);
            assert.equal(captured, true);
            assert.equal(h.uiServer.dumped, 2);
            assert.equal(builds, 1, 'final evidence validation follows encoding, before credential issuance');
        } finally { await h.service.cleanup(); }
    });
}
