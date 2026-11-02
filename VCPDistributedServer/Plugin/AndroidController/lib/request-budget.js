'use strict';

const { performance } = require('node:perf_hooks');

// The boundary also handles injected dependencies that ignore AbortSignal.
async function withBudget(timeoutMs, signal, task) {
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    let timer;
    let onAbort;
    try {
        const boundary = new Promise((_, reject) => {
            const stop = (code) => {
                const error = Object.assign(new Error(code), { code });
                controller.abort(error);
                reject(error);
            };
            onAbort = () => stop('ABORTED');
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
            timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
        });
        const operation = Promise.resolve().then(() => {
            if (controller.signal.aborted) throw controller.signal.reason;
            return task(controller.signal);
        });
        const result = await Promise.race([boundary, operation]);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (performance.now() >= deadline) {
            const error = Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' });
            controller.abort(error);
            throw error;
        }
        return result;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

module.exports = { withBudget };
