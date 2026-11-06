'use strict';

const { parseUiGraph, parseBounds } = require('./ui-graph');
const { displayTarget, filterHierarchyByDisplay } = require('./display-target');

/**
 * M4.5 P1: parse only the target display out of a carrier rootInActive=false dump.
 * The default display keeps using the caller's existing single-root path; this helper
 * refuses it so the old contract cannot silently change.
 */
function displayScopedGraph(xml, target, options = {}) {
    const t = displayTarget(target);
    if (t.isDefault) {
        const error = new Error('默认 display 继续走原单根路径');
        error.code = 'DISPLAY_SCOPE_DEFAULT_UNCHANGED';
        throw error;
    }
    const cut = filterHierarchyByDisplay(xml, t.displayId);
    const graph = parseUiGraph(cut.xml, options);
    return { graph, xml: cut.xml, displayId: t.displayId, uniqueId: t.uniqueId, generation: t.generation,
        rootCount: cut.roots, keptRoots: cut.kept };
}

function emptyTreeState(probe, count) {
    if (probe?.wakefulness === 'Asleep' || probe?.wakefulness === 'Dozing') return 'SCREEN_ASLEEP';
    if (probe?.keyguard?.showing === true || probe?.keyguard?.inputRestricted === true) return 'DEVICE_LOCKED';
    if (probe?.wakefulness !== 'Awake' || !probe?.focus?.package) return 'CONTEXT_UNKNOWN';
    return count > 0 ? 'ROOTS_AVAILABLE' : 'ROOT_UNAVAILABLE';
}

/** XML contains roots, not complete AccessibilityWindowInfo records. */
function windowEvidence(xml, probe, assertPackage = () => {}) {
    const graph = parseUiGraph(xml, { limit: 500, screen: probe?.size, rpcTarget: true });
    const roots = (graph.rawRoot?.children || []).filter(node => node.tag === 'node');
    let totalNodes = 0;
    const records = roots.map((root, index) => {
        let nodeCount = 0;
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            if (node.tag === 'node') {
                nodeCount++;
                assertPackage(node.attrs?.package || '');
            }
            stack.push(...(node.children || []));
        }
        totalNodes += nodeCount;
        const rawDisplay = root.attrs?.['display-id'];
        const displayId = typeof rawDisplay === 'string' && /^(?:0|[1-9][0-9]{0,5})$/.test(rawDisplay) ? Number(rawDisplay) : null;
        return { rootIndex: index, displayId, bounds: parseBounds(root.attrs?.bounds), nodeCount,
            windowId: null, type: null, layer: null, rootAvailable: true };
    });
    return { source: 'uiautomator-multi-root-xml', enumeration: 'interactive-roots',
        state: emptyTreeState(probe, roots.length), rootCount: roots.length, totalNodes,
        roots: records.slice(0, 32), truncated: records.length > 32,
        windowMetadata: 'unavailable', nullRootCount: null, occlusion: 'unknown',
        snapshotAtomic: false, actionable: false };
}

module.exports = { windowEvidence, emptyTreeState, displayScopedGraph };
