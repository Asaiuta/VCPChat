'use strict';

const { createHash } = require('node:crypto');
const { parseBounds } = require('./ui-graph');
const contextEvidence = require('./context');

function intersect(a, b) {
    if (!a || !b) return null;
    const box = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
    return box.right > box.left && box.bottom > box.top ? box : null;
}

function rawEntries(graph, screen) {
    const entries = [];
    const stack = [{ raw: graph?.rawRoot, clip: { left: 0, top: 0, right: screen.width, bottom: screen.height }, path: '' }];
    while (stack.length) {
        const { raw, clip, path } = stack.pop();
        if (!raw) continue;
        const attrs = raw.attrs || {};
        const ownHidden = attrs['visible-to-user'] === 'false' || attrs.displayed === 'false';
        const bounds = parseBounds(attrs.bounds);
        const visible = ownHidden ? null : intersect(bounds, clip);
        if (raw.tag === 'node') entries.push({ raw, attrs, bounds, visible, path });
        const nextClip = attrs.scrollable === 'true' ? intersect(clip, bounds) : clip;
        for (let i = (raw.children || []).length - 1; i >= 0; i--) {
            stack.push({ raw: raw.children[i], clip: nextClip, path: `${path}/${i}` });
        }
    }
    return entries;
}

function screenContext(probe) {
    return contextEvidence.contextKey(contextEvidence.frameContext(probe));
}

function layoutEvidence(graph, probe) {
    const baseContext = screenContext(probe);
    const context = baseContext;
    if (!contextEvidence.graphMatchesContext(graph, contextEvidence.frameContext(probe))) return { complete: false, context, digest: '' };
    const entries = rawEntries(graph, probe.size);
    if (entries.some(item => item.path.split('/').length >= 200)) return { complete: false, context, digest: '' };
    const nodes = entries.filter(item => item.visible);
    const foreground = nodes.some(item => item.attrs.package === probe.focus.package);
    if (!nodes.length || !foreground) return { complete: false, context, digest: '' };
    const evidence = nodes.map(({ attrs, bounds, visible, path }) => [path, attrs.class || '', attrs.package || '',
        attrs['resource-id'] || '', bounds, visible, attrs.enabled, attrs.clickable, attrs['long-clickable'], attrs.scrollable,
        attrs.checkable, attrs.checked, attrs.selected, attrs.focusable, attrs.focused, attrs.password]);
    return { complete: true, context, digest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
}

// Internal fixed-fixture diagnostics only; never emit text, resource ids, class names or context strings.
function m2IdleDiagnostic(graph, probe, evidence) {
    const fixture = 'com.vcpchat.m15fixture';
    if (!screenContext(probe) || probe.focus.package !== fixture
        || ![`${fixture}/.MainActivity`, `${fixture}/${fixture}.MainActivity`].includes(probe.focus.component)) return null;
    const entries = rawEntries(graph, probe.size);
    const geometry = entries.map(({ path, bounds, visible }) => ({ path, bounds, visibleBounds: visible }));
    const color = entries.filter(item => item.attrs.package === fixture && item.attrs['resource-id'] === `${fixture}:id/m2_color`);
    return {
        complete: evidence?.complete === true,
        digest: /^[a-f0-9]{64}$/.test(evidence?.digest || '') ? evidence.digest : null,
        rawNodeCount: entries.length,
        visibleNodeCount: entries.filter(item => item.visible).length,
        geometryDigest: createHash('sha256').update(JSON.stringify(geometry)).digest('hex'),
        geometry: geometry.slice(0, 128),
        geometryTruncated: geometry.length > 128,
        colorNodeCount: color.length,
        colorGeometry: color.slice(0, 8).map(({ path, bounds, visible }) => ({ path, bounds, visibleBounds: visible })),
        colorGeometryTruncated: color.length > 8,
    };
}

function elementEvidence(graph, node, screen) {
    if (!node?.rawNode || !node.bounds || !node.enabled) return null;
    const matches = rawEntries(graph, screen).filter(item => item.raw === node.rawNode);
    if (matches.length !== 1) return null;
    const hit = matches[0];
    const attrs = hit.attrs;
    if (!hit.visible || !hit.bounds || attrs.enabled === 'false'
        || !['left', 'top', 'right', 'bottom'].every(key => hit.bounds[key] === node.bounds[key])
        || attrs.package !== node.package || String(attrs.class || '').split('.').at(-1) !== node.cls) return null;
    // The emitted id/label may come from a folded wrapper; rawNode remains the exact inner source.
    return { visibleBounds: hit.visible, identity: JSON.stringify([hit.path, attrs.class, attrs.package,
        attrs['resource-id'] || '', node.id || '', node.bounds, node.label, node.value, node.flags]) };
}

module.exports = { rawEntries, screenContext, layoutEvidence, elementEvidence, m2IdleDiagnostic };
