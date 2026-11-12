'use strict';

const { deriveUiAutomatorRole } = require('./argent-uiautomator');
const editable = attrs => attrs.editable === 'true' || deriveUiAutomatorRole(attrs.class) === 'TextField';
const full = entry => entry?.visible && entry.attrs.enabled === 'true'
    && ['left', 'top', 'right', 'bottom'].every(key => entry.visible[key] === entry.bounds[key]);

function safeAncestors(raw, marker) {
    for (; raw; raw = raw.parent) {
        const a = raw.attrs || {};
        if (a['visible-to-user'] === 'false' || a.displayed === 'false' || a.enabled === 'false'
            || a.password === 'true' || marker && (editable(a) || a.clickable === 'true' || a.checkable === 'true')) return false;
    }
    return true;
}

// These are internal predicates, not a claim that the app has no hidden business state.
function backEvidence(config, entries) {
    const sources = entries.filter(e => e.attrs['resource-id'] === config.from);
    const targets = entries.filter(e => e.attrs['resource-id'] === config.target);
    const noEdits = entries.every(e => !editable(e.attrs) && e.attrs.password !== 'true' && e.attrs.checkable !== 'true');
    return Object.freeze({ sourceMatches: sources.length, targetMatches: targets.length,
        sourceSafe: sources.length === 1 && Boolean(full(sources[0])) && safeAncestors(sources[0].raw, true) && noEdits,
        targetSafe: targets.length === 1 && Boolean(full(targets[0])) && safeAncestors(targets[0].raw, false) });
}

module.exports = { backEvidence };
