'use strict';

const { deriveUiAutomatorRole } = require('./argent-uiautomator');

// Read the raw attribute, never the UI graph's default-false checked flag.
function toggleEvidence(task, entries, controls) {
    const matches = entries.filter(e => e.attrs['resource-id'] === task.targets.toggle);
    const entry = matches[0], a = entry?.attrs;
    const checked = a?.checked === 'true' ? true : a?.checked === 'false' ? false : null;
    let safe = matches.length === 1 && checked !== null && a.enabled === 'true'
        && a.clickable === 'true' && a.checkable === 'true' && Boolean(entry.visible)
        && ['left', 'top', 'right', 'bottom'].every(k => entry.visible[k] === entry.bounds[k]);
    for (let raw = entry?.raw; raw; raw = raw.parent) {
        const attrs = raw.attrs || {};
        if (attrs.password === 'true' || attrs.editable === 'true' || deriveUiAutomatorRole(attrs.class) === 'TextField'
            || attrs.enabled === 'false' || attrs['visible-to-user'] === 'false' || attrs.displayed === 'false'
            || raw !== entry.raw && (attrs.clickable === 'true' || attrs.checkable === 'true')) safe = false;
    }
    const nodes = controls.filter(n => n.id === task.targets.toggle);
    safe = Boolean(safe && nodes.length === 1 && nodes[0].rawNode === entry.raw && nodes[0].enabled && nodes[0].inViewport);
    return Object.freeze({ matches: matches.length, safe, checked: matches.length === 1 ? checked : null });
}

module.exports = { toggleEvidence };
