'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const stepRuntime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const boundary of ['abort', 'deadline']) {
    for (const ready of [true, false]) {
        test(`Observe ${boundary} during startup dispatches neither dump nor CLI after startup resolves ${ready}`, async t => {
            let entered;
            let release;
            const started = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { release = resolve; });
            const controller = new AbortController();
            const h = await harness({ uiServer: {
                ok: true,
                async start() {
                    entered();
                    await gate;
                    return { ok: ready, reason: ready ? undefined : 'offline startup failed' };
                },
            } });
            t.after(() => h.service.cleanup());
            const work = h.service.processToolCall({
                command: 'Observe', serial: 'A', wake: 'never',
                timeoutMs: boundary === 'deadline' ? 25 : 1000,
            }, { signal: controller.signal });
            const rejected = assert.rejects(work, { code: boundary === 'abort' ? 'STEP_ABORTED' : 'STEP_DEADLINE' });
            await started;
            try {
                if (boundary === 'abort') controller.abort();
                await rejected;
                await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_BUSY' });
            } finally { release(); }
            await tick();
            await stepRuntime.run({ serial: 'A' }, async () => ({ details: {} }));
            assert.equal(h.uiServer.dumped, 0, 'a cancelled request must not dispatch a fresh UI RPC after startup');
            assert.equal(h.calls.some(([kind, args]) => kind === 'adb' && args.includes('uiautomator')), false,
                'a cancelled request must not enter CLI fallback after startup');
        });
    }
}
