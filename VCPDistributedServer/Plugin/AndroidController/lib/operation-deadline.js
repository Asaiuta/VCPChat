'use strict';

const { performance } = require('node:perf_hooks');

// Keep ownership until the dependency settles, even if it ignores cancellation.
// Timers signal cancellation; the monotonic deadline decides whether a result is valid.
async function withOperationDeadline(timeoutMs, signal, task) {
    const deadline = performance.now() + timeoutMs;
    const controller = new AbortController();
    const failure = code => Object.assign(new Error(code), { code });
    const stop = code => controller.abort(failure(code));
    const onAbort = () => stop('ABORTED');
    const remainingMs = () => {
        // Parent cancellation takes precedence over a simultaneous local timeout.
        if (signal?.aborted) throw failure('ABORTED');
        const remaining = deadline - performance.now();
        if (remaining <= 0) stop('TIMEOUT');
        controller.signal.throwIfAborted();
        return Math.ceil(remaining);
    };
    let timer;
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        timer = setTimeout(() => stop('TIMEOUT'), remainingMs());
        let result;
        try {
            result = await task({ signal: controller.signal, remainingMs });
        } catch (error) {
            remainingMs();
            throw error;
        }
        remainingMs();
        return result;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        controller.abort();
    }
}

module.exports = { withOperationDeadline };
