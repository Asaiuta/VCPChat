'use strict';

const { deriveUiAutomatorRole } = require('./argent-uiautomator');
const { createTargetMatcher, safeEntry: safe } = require('./task-ui-target');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const editable = a => a.editable === 'true' || deriveUiAutomatorRole(a.class) === 'TextField';
const normalize = (v, p) => {
    let text = String(v ?? '');
    if (p.normalize === 'NFC_trim') text = text.normalize('NFC').trim();
    if (p.stripPrefix && text.startsWith(p.stripPrefix)) text = text.slice(p.stripPrefix.length).trimStart();
    return text;
};
function completionEvidence(task, entries, match = createTargetMatcher(task, entries)) {
    if (!task.completion) return null;
    const textMatches = (p, list = entries) => {
        const result = match(p, list);
        const row = result.complete && result.hits.length === 1 ? result.hits[0] : null;
        return safe(row) && normalize(row.attrs.text, p) === normalize(p.inputRef ? task.inputs[p.inputRef] : p.equals, p) ? row : null;
    };
    const checks = task.completion.all.map(p => {
        if (p.type === 'text') return Boolean(textMatches(p.text));
        const result = match(p), found = result.hits;
        if (!result.complete) return false;
        if (p.type === 'absent') return found.length === 0;
        if (found.length !== 1 || !safe(found[0])) return false;
        if (p.type === 'visible') return true;
        if (p.type === 'checked') return found[0].attrs.checkable === 'true' && found[0].attrs.checked === String(p.checked);
        // Rows are direct children of the declared container. Never combine
        // a title from one row with an author or secondary field from another.
        const rows = new Map();
        for (const e of entries) {
            let row = e.raw;
            while (row.parent && row.parent !== found[0].raw) row = row.parent;
            if (row.parent !== found[0].raw) continue;
            if (!rows.has(row)) rows.set(row, []);
            rows.get(row).push(e);
        }
        return [...rows.values()].some(row => {
            const fields = p.fields.map(field => textMatches(field, row));
            return fields.every(Boolean) && new Set(fields.map(field => field.raw)).size === fields.length;
        });
    });
    return Object.freeze({ matched: checks.every(Boolean), checks: Object.freeze(checks) });
}
function uiEvidence(task, graph, entries, hash, activePackage = task.package) {
    const byRaw = new Map(entries.map(e => [e.raw, e]));
    const refs = Object.keys(task.inputs);
    const nodes = [];
    const bindings = new Map();
    const nodeRefs = new Map();
    const contextIds = new Map();
    const match = createTargetMatcher(task, entries, activePackage);
    const assignments = (task.completion?.all || []).filter(p => p.type === 'text' && p.text.inputRef).map(p => p.text);
    const assigned = assignments.map(p => ({ ...p, evidence: match(p) }));
    const clipped = v => String(v ?? '').slice(0, 160);
    for (const node of graph.controls) {
        const entry = byRaw.get(node.rawNode), a = entry?.attrs;
        if (!safe(entry) || !node.enabled || !node.inViewport) continue;
        const field = editable(a), focused = a.focused === 'true';
        const operations = [];
        if (a.clickable === 'true' || field) operations.push('Tap');
        // The existing Fill RPC requires unique class/package/resource identity.
        if (field && entries.filter(e => e.attrs.class === a.class && e.attrs.package === a.package
            && (!a['resource-id'] || e.attrs['resource-id'] === a['resource-id'])).length === 1) operations.push('Fill');
        if (a.scrollable === 'true') operations.push('Scroll');
        if (a['long-clickable'] === 'true') operations.push('LongPress');
        if (field && focused && entries.filter(e => e.attrs.focused === 'true').length === 1) operations.push('ImeAction');
        const nodeRef = `n${nodes.length}`;
        const ancestors = [];
        for (let raw = entry.raw.parent; raw && ancestors.length < 4; raw = raw.parent) {
            if (raw.tag !== 'node' || !safe(byRaw.get(raw))) continue;
            const parent = raw.attrs;
            const resourceId = clipped(parent['resource-id']);
            const label = editable(parent) ? '' : clipped(parent['content-desc'] || parent.text);
            // Anonymous and identically labelled containers still identify
            // different rows. Preserve raw object identity within this sample;
            // never expose structural paths or merge siblings by their labels.
            if (!contextIds.has(raw)) contextIds.set(raw, `a${contextIds.size}`);
            ancestors.push(Object.freeze({ contextId: contextIds.get(raw), resourceId, label, role: deriveUiAutomatorRole(parent.class) }));
        }
        // Resource IDs are hints. Dispatch always resolves the observation-bound
        // index, including ID-less nodes and repeated IDs with different rows.
        const current = { nodeRef, role: field ? 'textfield' : node.role,
            label: clipped(field ? a.hint || a['content-desc'] : node.label), resourceId: clipped(node.id),
            ...(field ? { value: clipped(a.text), valueTruncated: String(a.text ?? '').length > 160 } : {}),
            ancestors: Object.freeze(ancestors),
            operations: operations.filter(op => task.operations.includes(op)), focused,
            checked: a.checkable === 'true' && ['true', 'false'].includes(a.checked) ? a.checked === 'true' : null,
            selected: a.selected === 'true', inputMatches: field ? refs.filter(ref => a.text === task.inputs[ref]) : [],
            boundInputRefs: field ? assigned.filter(p => p.evidence.complete && p.evidence.hits.length === 1
                && p.evidence.hits[0].raw === entry.raw).map(p => p.inputRef) : [] };
        nodes.push(Object.freeze(current));
        nodeRefs.set(entry.raw, nodeRef);
        bindings.set(nodeRef, { index: node.index, raw: node.rawNode, selector: node.selector,
            identity: hash('ui-node', [a.package, a['resource-id'], a.class, entry.path]),
            operations: current.operations });
    }
    if (nodes.length > 96) fail('TASK_CANDIDATE_OVERFLOW');
    const semantic = entries.filter(safe).map(e => [e.path, e.attrs.package, e.attrs['resource-id'], e.attrs.class,
        e.attrs.text, e.attrs['content-desc'], e.attrs.checked, e.attrs.selected, e.attrs.focused, e.attrs.scrollable]);
    const loading = task.loading ? match(task.loading) : { complete: true, hits: [] };
    // A marker scoped to another allowed app is not relevant on this page.
    const loadingPackage = task.loading?.package ?? task.loading?.id?.split(':id/')[0];
    const markers = loadingPackage === activePackage ? loading.hits : [];
    if (loadingPackage === activePackage && !loading.complete || markers.length > 1 || markers.some(e => !safe(e) && e.visible)) fail('TASK_CONTEXT_UNPROVEN');
    // Host-only progress evidence. Missing fields during navigation say nothing
    // about persistence; a previously satisfied field is checked when visible
    // again. No text or raw node escapes into this bounded ledger.
    const fieldStates = assigned.map((p, index) => {
        const entry = p.evidence.hits[0];
        const proven = p.evidence.complete && p.evidence.hits.length === 1 && safe(entry);
        const field = proven && editable(entry.attrs);
        return Object.freeze({ index, inputRef: p.inputRef, nodeRef: proven ? nodeRefs.get(entry.raw) ?? null : null,
            present: p.evidence.hits.some(e => Boolean(e.visible)), proven, editable: field,
            matched: Boolean(proven && (field ? entry.attrs.text === task.inputs[p.inputRef]
                : normalize(entry.attrs.text, p) === normalize(task.inputs[p.inputRef], p))) });
    });
    return { ui: Object.freeze({ nodes: Object.freeze(nodes), loading: markers.length === 1 && safe(markers[0]),
        fieldStates: Object.freeze(fieldStates), pageDigest: hash('ui-page', semantic),
        completion: completionEvidence(task, entries, match) }), bindings };
}
module.exports = { uiEvidence, completionEvidence };
