'use strict';

const SAMPLE_INTERVAL_MS = 200;
const FALLBACK_RESERVE_MS = 400;
const NATIVE_LIMIT_MS = 1500;

function timedOut() {
    return { matched: false, idleMode: null, error: 'IDLE_TIMEOUT' };
}

// Snapshot context by value, independent of object identity and property insertion order.
function contextKey(context) {
    if (typeof context === 'string') return context.length ? JSON.stringify(context) : null;
    if (!context || typeof context !== 'object' || Array.isArray(context) || !Object.keys(context).length) return null;
    const seen = new Set();
    function canonical(value) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Invalid idle context');
        seen.add(value);
        const result = Array.isArray(value)
            ? value.map(canonical)
            : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
        seen.delete(value);
        return result;
    }
    try { return JSON.stringify(canonical(context)); }
    catch { return null; }
}

function canFallback(error) {
    // An unresolved request must never overlap a new layout RPC, even with a familiar code.
    if (!error || error.inFlight === true || error.drained === false) return false;
    if (error.code === 'UI_SERVER_NOT_READY') return error.dispatched !== true;
    if (error.code !== 'UI_SERVER_RPC_ERROR') return false;
    if (error.rpcCode === -32601) return true;
    // Only a complete device error response establishes that the native request drained.
    return /\bidle[\s_-]*time(?:out|d[\s_-]*out)\b|\b(?:[\w.]+\.)?TimeoutException\b/i.test(error.message || '');
}

/**
 * Wait without dispatching input, waking the device, or retrying the native request.
 *
 * runtime: step-runtime's check(), pause(ms), optional remainingMs(), executionSignal(), now().
 * nativeIdle?({ timeoutMs, deadlineMs, signal }): one completed native call; timeoutMs is the
 * device wait (<=1500), deadlineMs includes transport headroom and preserves fallback budget.
 * sample({ deadlineMs, timeoutMs, signal }): { digest: nonempty string, context, complete: true }.
 * The sampler must honor the deadline and certify a nonempty, unlocked, complete visible raw
 * tree digest covering ALL nodes/state except dynamic text, plus screen/foreground context.
 * Native returns are hints only: bundled QueryController catches UiAutomation idle timeouts.
 * void/null/true cannot independently prove idle; every supported result needs layout samples.
 * Neither callback may resolve while its underlying request is still in flight. Transport,
 * cancellation and unknown errors propagate; incomplete samples use complete:false instead.
 * Layout stability does not establish pixel stability or business-operation completion.
 */
async function waitForIdle({ runtime, nativeIdle, sample, timeoutMs = 5000 } = {}) {
    if (!runtime || typeof runtime.check !== 'function' || typeof runtime.pause !== 'function'
        || typeof sample !== 'function' || (nativeIdle !== undefined && typeof nativeIdle !== 'function')
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new TypeError('waitForIdle requires runtime.check/pause, sample and a positive integer timeoutMs');
    }
    const now = typeof runtime.now === 'function' ? () => runtime.now() : Date.now;
    const deadlineMs = now() + timeoutMs;
    const signal = runtime.executionSignal?.();
    function remaining() {
        runtime.check();
        if (signal?.aborted) throw Object.assign(new Error('Idle wait cancelled'), { code: 'STEP_ABORTED' });
        return Math.max(0, Math.floor(Math.min(deadlineMs - now(), runtime.remainingMs?.() ?? Infinity)));
    }
    function request(budget) {
        const startedAt = now();
        const limit = Math.min(deadlineMs, startedAt + Math.min(budget, remaining()));
        return { timeoutMs: Math.max(0, Math.floor(limit - now())), deadlineMs: limit, signal };
    }

    const available = remaining();
    if (nativeIdle && available > FALLBACK_RESERVE_MS + 1) {
        const room = available - FALLBACK_RESERVE_MS;
        const nativeMs = Math.min(NATIVE_LIMIT_MS, Math.floor(room * 0.75));
        const transportMs = nativeMs + Math.min(250, room - nativeMs);
        let result;
        const nativeRequest = { ...request(transportMs), timeoutMs: nativeMs };
        try {
            result = await nativeIdle(nativeRequest);
            if (now() >= nativeRequest.deadlineMs) {
                throw Object.assign(new Error('Native idle request exceeded its deadline'), { code: 'UI_SERVER_TIMEOUT' });
            }
        } catch (error) {
            remaining();
            if (!canFallback(error)) throw error;
            result = false;
        }
        if (!remaining()) return timedOut();
        if (result !== undefined && result !== null && result !== true && result !== false) {
            throw new TypeError('nativeIdle must resolve to void, null, true or false');
        }
    }

    let baselineContext = null;
    let previousDigest = null;
    while (remaining() > 0) {
        const sampleRequest = request(remaining());
        if (sampleRequest.timeoutMs <= 0) { remaining(); return timedOut(); }
        const snapshot = await sample(sampleRequest);
        if (!remaining()) return timedOut();
        const currentContext = contextKey(snapshot?.context);
        // A changed foreground, window or screen ends this wait; never rebaseline to wash it green.
        if (baselineContext !== null && currentContext !== null && currentContext !== baselineContext) return timedOut();
        if (baselineContext === null && currentContext !== null) baselineContext = currentContext;
        const valid = snapshot?.complete === true && currentContext !== null
            && typeof snapshot.digest === 'string' && snapshot.digest.length > 0;
        if (valid && snapshot.digest === previousDigest) return { matched: true, idleMode: 'layout_stable' };
        previousDigest = valid ? snapshot.digest : null;
        const left = remaining();
        if (left <= SAMPLE_INTERVAL_MS) {
            if (left > 0) await runtime.pause(left);
            remaining();
            return timedOut();
        }
        await runtime.pause(SAMPLE_INTERVAL_MS);
    }
    return timedOut();
}

module.exports = { waitForIdle };
