'use strict';

// Internal geometry only. Text, labels and descriptions cannot establish scroll progress.
const boxKeys = ['left', 'top', 'right', 'bottom'];
const box = value => value && boxKeys.map(key => value[key]);
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const sameBounds = (a, b) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
const editable = attrs => attrs.editable === 'true' || /(?:EditText|AutoCompleteTextView)$/.test(attrs.class || '');

function snapshot(task, entries, container, counts, hash, targetVisible) {
    if (!container?.bounds || !container.visible) return null;
    const anchors = [];
    for (const e of entries) {
        if (e.raw.parent !== container.raw || !e.visible || !sameBounds(e.visible, e.bounds)) continue;
        const a = e.attrs, id = a['resource-id'];
        if (a.enabled !== 'true' || a.scrollable === 'true' || !id?.startsWith(`${task.package}:id/`)
            || id.length > 320 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(id.slice(task.package.length + 4))) continue;
        if (counts.get(id) !== 1) return null;
        const stack = [e.raw]; let safe = true;
        while (stack.length) {
            const raw = stack.pop(), attrs = raw.attrs || {};
            if (attrs.password === 'true' || editable(attrs) || attrs.scrollable === 'true') { safe = false; break; }
            stack.push(...(raw.children || []));
        }
        if (!safe) continue;
        anchors.push(Object.freeze({ id, cls: a.class || '', bounds: Object.freeze(box(e.bounds)) }));
    }
    if (anchors.length < 2 || anchors.length > 64) return null;
    anchors.sort((a, b) => a.id.localeCompare(b.id));
    const identity = Object.freeze([container.attrs['resource-id'], container.attrs.class || '', ...box(container.bounds), ...box(container.visible)]);
    return Object.freeze({ identity, anchors: Object.freeze(anchors),
        positionDigest: hash('scroll-position', [identity, anchors, targetVisible]),
        contentDigest: hash('scroll-content', anchors.map(a => a.id)) });
}

function motion(before, after, direction) {
    if (!before || !after || !equal(before.identity, after.identity)) return null;
    const previous = new Map(before.anchors.map(a => [a.id, a]));
    const common = after.anchors.filter(a => previous.has(a.id));
    if (common.length < 2 || common.length === before.anchors.length || common.length === after.anchors.length) return null;
    const horizontal = ['left', 'right'].includes(direction), axis = horizontal ? 0 : 1, cross = horizontal ? 1 : 0;
    const sign = ['down', 'right'].includes(direction) ? -1 : 1;
    const size = horizontal ? before.identity[8] - before.identity[6] : before.identity[9] - before.identity[7];
    let displacement;
    for (const a of common) {
        const old = previous.get(a.id), b = a.bounds, o = old.bounds;
        const delta = b[axis] - o[axis];
        if (a.cls !== old.cls || b[2] - b[0] !== o[2] - o[0] || b[3] - b[1] !== o[3] - o[1]
            || b[cross] !== o[cross] || b[cross + 2] !== o[cross + 2]
            || delta * sign < 8 || delta * sign > size * 0.9
            || displacement !== undefined && Math.abs(delta - displacement) > 1) return null;
        displacement ??= delta;
    }
    return Object.freeze({ anchors: common.length, distance: Math.abs(displacement) });
}

module.exports = { snapshot, motion };
