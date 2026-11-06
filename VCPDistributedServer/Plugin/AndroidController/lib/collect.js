'use strict';

const { createHash } = require('node:crypto');
const { evaluateSelector, validateSelector } = require('./selector');
const { projectUiGraph } = require('./ui-graph');
const { sameContext } = require('./context');
const { rawEntries } = require('./layout-evidence');

// A bounded page collector. Pages retain duplicate entries and provenance; an
// unchanged sample is only NO_PROGRESS, never proof that the list has ended.
function createCollector({ runtime, prepareTarget, getGraph, scroll, textResult }) {
    return async function collect(args) {
        const maxPages = args.maxPages ?? 10;
        const direction = args.direction ?? 'down';
        if (Object.keys(args).some(key => !['command', 'serial', 'container', 'maxPages', 'direction', 'until'].includes(key))
            || !validateSelector(args.container) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 30
            || !['up', 'down', 'left', 'right'].includes(direction)
            || (args.until !== undefined && !validateSelector(args.until))) {
            throw runtime.failure('INVALID_ARGUMENT', 'Collect需要container选择器、maxPages=1–30、滚动方向和可选until选择器。');
        }
        const pages = [], attempts = [];
        const signatures = new Set();
        let baseline, stopReason = 'MAX_PAGES', truncated = false;
        try {
            for (let page = 0; page < maxPages; page++) {
                runtime.check();
                const { node, serial } = await prepareTarget({ serial: args.serial, selector: args.container }, '采集列表');
                const graph = getGraph(serial);
                const context = graph?.contextEvidence?.context;
                if (!node?.flags.includes('scroll') || !node.enabled || !node.inViewport || !node.rawNode || !context) {
                    throw runtime.failure('INVALID_SCROLL_TARGET', 'Collect需要当前可见启用的滚动容器。');
                }
                if (baseline && !sameContext(baseline, context)) throw runtime.failure('COLLECT_CONTEXT_CHANGED', '采集期间窗口或设备上下文变化；停止。');
                baseline = context;
                const visible = new Set(rawEntries(graph, context.size).filter(entry => entry.visible).map(entry => entry.raw));
                const controls = graph.matchingControls.filter(control => {
                    if (!control.enabled || !control.inViewport || control.package !== node.package || !visible.has(control.rawNode)) return false;
                    for (let parent = control.rawNode?.parent; parent; parent = parent.parent) if (parent === node.rawNode) return true;
                    return false;
                });
                // Fingerprint full matching data, not the presentation budget. It
                // identifies only repeated samples, not persistent list records.
                const signature = createHash('sha256').update(JSON.stringify(controls.map(control =>
                    [control.id, control.text, control.desc, control.label, control.bounds]))).digest('hex');
                const projected = projectUiGraph({ ...graph, controls, total: controls.length }, { limit: 100, textLength: 120 });
                const items = projected.controls.map((control, ordinal) => ({ ordinal, id: control.id,
                    text: control.text, desc: control.desc, label: control.label, role: control.role }));
                const pageTruncated = controls.length > items.length
                    || controls.some(control => ['text', 'desc', 'label'].some(key => (control[key]?.length || 0) > 120));
                truncated ||= pageTruncated;
                pages.push({ page, items, total: controls.length, truncated: pageTruncated });
                if (args.until !== undefined) {
                    const match = evaluateSelector({ controls, scopeControls: graph.scopeControls }, args.until);
                    if (!match.complete) throw runtime.failure('COLLECT_EVIDENCE_INCOMPLETE', '停止条件证据不完整。');
                    if (match.hits.length) { stopReason = 'UNTIL_MATCH'; break; }
                }
                if (signatures.has(signature)) { stopReason = 'NO_PROGRESS'; break; }
                signatures.add(signature);
                if (page + 1 === maxPages) break;
                const result = await scroll({ serial, selector: args.container, direction });
                attempts.push(...(result.details?.attempts || []));
                runtime.inputReceipt({ channels: attempts.map(attempt => attempt.channel), attempts });
            }
        } catch (error) {
            error.details = { ...error.details, collection: { pagesCollected: pages.length, partial: true, stopReason: 'ERROR' } };
            throw error;
        }
        const matched = stopReason === 'UNTIL_MATCH' && !truncated;
        const collection = { pages, partial: !matched, truncated, stopReason, listEndProven: false,
            deduplicated: false, inputMayHaveOccurred: attempts.length > 0 };
        runtime.verified(matched, { condition: { type: 'collectUntil' }, evidence: { stopReason, pagesCollected: pages.length } });
        const result = textResult(`已采集${pages.length}页；${stopReason}。保留重复条目，不证明列表完整。`,
            { serial: args.serial, collection, actionVerified: matched, attempts });
        result.content.push({ type: 'text', text: JSON.stringify({ collection }) });
        return result;
    };
}

module.exports = { createCollector };
