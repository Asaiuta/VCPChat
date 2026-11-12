'use strict';
// Optional preload for acceptance runs. It never initializes a service or contacts a device.
const { performance } = require('node:perf_hooks');
const { UiServer } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server');
const measured = new Set(['click', 'drag', 'dragTo', 'pinchIn', 'pinchOut', 'pressKeyCode', 'scrollTo']);
const invoke = UiServer.prototype.invoke;
const start = UiServer.prototype.start;
const baseline = performance.now();
let counter = 0;
const ms = value => Math.round(value * 1000) / 1000;
const emit = item => console.log(JSON.stringify({ phase: 'rpcTiming', ...item }));
UiServer.prototype.invoke = async function (method, params, options) {
    if (!measured.has(method)) return invoke.call(this, method, params, options);
    const n = ++counter;
    const t = performance.now();
    let status = 'ack';
    emit({ n, event: 'begin', method, arity: Array.isArray(params) ? params.length : null, atMs: ms(t - baseline) });
    try { return await invoke.call(this, method, params, options); }
    catch (error) { status = 'error'; throw error; }
    finally { emit({ n, event: 'end', method, status, elapsedMs: ms(performance.now() - t) }); }
};
UiServer.prototype.start = async function (...args) {
    const t = performance.now();
    try { return await start.apply(this, args); }
    finally {
        const elapsed = performance.now() - t;
        if (elapsed > 10) emit({ event: 'readiness', elapsedMs: ms(elapsed) });
    }
};
