'use strict';

const { displayTarget, displayKey } = require('./display-target');

function logicalSize(size) {
    return size && Number.isSafeInteger(size.width) && size.width > 0
        && Number.isSafeInteger(size.height) && size.height > 0
        ? { width: size.width, height: size.height } : null;
}

// M4.5 P1: an explicit non-default target must be proven by the scoped probe (same logical id,
// uniqueId and generation). Device-global wake/keyguard requirements are deliberately kept
// identical for now; relaxing them for ALWAYS_UNLOCKED virtual displays is a later policy step.
function frameContext(probe, target) {
    if (target !== undefined && !displayTarget(target).isDefault) return scopedFrameContext(probe, displayTarget(target));
    const size = logicalSize(probe?.size);
    if (!size || probe.displayId !== 0 || ![0, 1, 2, 3].includes(probe.rotation)
        || probe.wakefulness !== 'Awake' || probe.keyguard?.showing !== false
        || probe.keyguard?.inputRestricted !== false || /systemui|keyguard/i.test(probe.focus?.package || '')
        || !['package', 'component', 'window'].every(key => typeof probe.focus?.[key] === 'string' && probe.focus[key].trim())) return null;
    return { displayId: 0, package: probe.focus.package, component: probe.focus.component,
        window: probe.focus.window, size, rotation: probe.rotation };
}

function scopedFrameContext(probe, t) {
    const base = frameContext(probe && { ...probe, displayId: probe.displayId === t.displayId ? 0 : null });
    if (!base || probe.displayId !== t.displayId || probe.uniqueId !== t.uniqueId
        || probe.target?.displayId !== t.displayId || probe.target?.uniqueId !== t.uniqueId
        || probe.target?.generation !== t.generation) return null;
    return { ...base, displayId: t.displayId, uniqueId: t.uniqueId, generation: t.generation };
}

function sameDisplay(a, b) {
    if (a.displayId === 0 && b.displayId === 0) return true;
    return Number.isSafeInteger(a.displayId) && a.displayId > 0 && a.displayId === b.displayId
        && typeof a.uniqueId === 'string' && a.uniqueId === b.uniqueId
        && typeof a.generation === 'string' && a.generation === b.generation;
}

function sameContext(a, b) {
    return Boolean(a && b && sameDisplay(a, b) && a.package === b.package
        && a.component === b.component && a.window === b.window && a.rotation === b.rotation
        && a.size?.width === b.size?.width && a.size?.height === b.size?.height);
}

function contextKey(context) {
    if (!context) return null;
    const key = [context.displayId, context.package, context.component, context.window,
        context.rotation, context.size.width, context.size.height];
    return JSON.stringify(context.displayId === 0 ? key : [...key, context.uniqueId, context.generation]);
}

function graphMatchesContext(graph, context) {
    if (!context || !graph?.rawRoot || graph.keyguard || (graph.package && graph.package !== context.package)
        || graph.rawRoot.attrs?.rotation !== String(context.rotation)) return false;
    const stack = [graph.rawRoot];
    while (stack.length) {
        const raw = stack.pop();
        if (raw.tag === 'node' && raw.attrs?.package === context.package) return true;
        for (const child of raw.children || []) stack.push(child);
    }
    return false;
}

// Closed vocabulary for persisted context-change evidence. Tokens name failed dimensions only,
// never package, component, window, size or rotation values.
const PROBE_REASONS = Object.freeze(['missing', 'display', 'rotation', 'size', 'wakefulness', 'keyguard', 'focus', 'overlay']);
const CONTEXT_DIFF_TOKENS = Object.freeze([
    'display', 'package', 'component', 'window_token', 'window_title', 'rotation', 'size', 'epoch',
    ...['before', 'after', 'previous', 'current'].flatMap(side => PROBE_REASONS.map(reason => `${side}_${reason}`)),
    'graph_root', 'graph_keyguard', 'graph_package', 'graph_rotation', 'graph_foreground',
    'task_context', 'task_truncated', 'task_keyguard', 'task_empty', 'task_package', 'task_display',
    'task_foreign_node', 'task_layout',
]);

function unprovenReasons(probe) {
    if (!probe || typeof probe !== 'object') return ['missing'];
    const reasons = [];
    if (probe.displayId !== 0) reasons.push('display');
    if (![0, 1, 2, 3].includes(probe.rotation)) reasons.push('rotation');
    if (!logicalSize(probe.size)) reasons.push('size');
    if (probe.wakefulness !== 'Awake') reasons.push('wakefulness');
    if (probe.keyguard?.showing !== false || probe.keyguard?.inputRestricted !== false) reasons.push('keyguard');
    if (!['package', 'component', 'window'].every(key => typeof probe.focus?.[key] === 'string' && probe.focus[key].trim())) reasons.push('focus');
    if (/systemui|keyguard/i.test(probe.focus?.package || '')) reasons.push('overlay');
    return reasons;
}

// "Window{<token> u0 <title>}": a token-only change means the same titled window was recreated.
function windowTitle(window) {
    return /^Window\{\S+\s+(?:u\d+\s+)?(.+)\}$/.exec(String(window || '').trim())?.[1] ?? null;
}

function contextDifference(a, b) {
    if (!a || !b) return [];
    const tokens = [];
    if (a.displayId !== b.displayId) tokens.push('display');
    if (a.package !== b.package) tokens.push('package');
    if (a.component !== b.component) tokens.push('component');
    if (a.window !== b.window) {
        const title = windowTitle(a.window);
        tokens.push(title !== null && title === windowTitle(b.window) ? 'window_token' : 'window_title');
    }
    if (a.rotation !== b.rotation) tokens.push('rotation');
    if (a.size?.width !== b.size?.width || a.size?.height !== b.size?.height) tokens.push('size');
    return tokens;
}

function graphReasons(graph, context) {
    if (!context) return [];
    if (!graph?.rawRoot) return ['graph_root'];
    const reasons = [];
    if (graph.keyguard) reasons.push('graph_keyguard');
    if (graph.package && graph.package !== context.package) reasons.push('graph_package');
    if (graph.rawRoot.attrs?.rotation !== String(context.rotation)) reasons.push('graph_rotation');
    let foreground = false;
    const stack = [graph.rawRoot];
    while (stack.length && !foreground) {
        const raw = stack.pop();
        if (raw?.tag === 'node' && raw.attrs?.package === context.package) foreground = true;
        for (const child of raw?.children || []) stack.push(child);
    }
    if (!foreground) reasons.push('graph_foreground');
    return reasons;
}

function orderedTokens(tokens) {
    const set = new Set(tokens);
    return CONTEXT_DIFF_TOKENS.filter(token => set.has(token));
}

// Why a layout read's before/after probes, epoch or graph failed to agree.
function describeContextChange({ before, after, epochChanged = false, graph } = {}) {
    const a = frameContext(before), b = frameContext(after);
    return orderedTokens([
        ...(a ? [] : unprovenReasons(before).map(reason => `before_${reason}`)),
        ...(b ? [] : unprovenReasons(after).map(reason => `after_${reason}`)),
        ...contextDifference(a, b),
        ...(epochChanged ? ['epoch'] : []),
        ...(a && graph !== undefined ? graphReasons(graph, a) : []),
    ]);
}

// Default display state stays keyed by the bare serial; other displays get their own epoch
// partition so a virtual-display change never advances the default display epoch, and vice versa.
function createContextTracker() {
    const states = new Map();
    const scoped = new Map();
    function epoch(serial, target) {
        return target === undefined ? states.get(serial)?.epoch || 0 : states.get(displayKey(serial, target))?.epoch || 0;
    }
    function observe(serial, probe, target) {
        const key = target === undefined ? serial : displayKey(serial, target);
        const context = target === undefined ? frameContext(probe) : frameContext(probe, target);
        const previous = states.get(key);
        const changed = previous ? contextKey(previous.context) !== contextKey(context) : false;
        const next = { context, epoch: (previous?.epoch || 0) + (!previous || changed ? 1 : 0) };
        states.set(key, next);
        if (key !== serial) scoped.set(key, String(serial ?? ''));
        return { ...next, changed };
    }
    // Device-level invalidation (reconnect, input, unknown outcome) affects every display of the serial.
    function invalidate(serial, target) {
        if (target !== undefined && !displayTarget(target).isDefault) {
            const key = displayKey(serial, target);
            const next = { context: null, epoch: (states.get(key)?.epoch || 0) + 1 };
            states.set(key, next);
            scoped.set(key, String(serial ?? ''));
            return next.epoch;
        }
        const next = { context: null, epoch: epoch(serial) + 1 };
        states.set(serial, next);
        for (const [key, owner] of scoped) {
            if (owner === String(serial ?? '')) states.set(key, { context: null, epoch: (states.get(key)?.epoch || 0) + 1 });
        }
        return next.epoch;
    }
    // A destroyed virtual display must not leave a reusable epoch behind.
    function forget(serial, target) {
        const key = displayKey(serial, target);
        if (key === serial) return false;
        scoped.delete(key);
        return states.delete(key);
    }
    return { observe, epoch, invalidate, forget, clear() { states.clear(); scoped.clear(); } };
}

module.exports = { logicalSize, frameContext, sameContext, contextKey, graphMatchesContext, createContextTracker,
    CONTEXT_DIFF_TOKENS, unprovenReasons, contextDifference, graphReasons, orderedTokens, describeContextChange };
