'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, createHmac, randomBytes, randomUUID } = require('node:crypto');
const { approvalBinding } = require('./human-interaction');
const { hasCompleteLayout, rawEntries } = require('./layout-evidence');
const { contextDifference, orderedTokens } = require('./context');
const { deriveUiAutomatorRole } = require('./argent-uiautomator');
const { snapshot: scrollSnapshot } = require('./task-scroll-progress');
const { backEvidence } = require('./task-back-evidence');
const { toggleEvidence } = require('./task-toggle-evidence');
const { REFS, routeEvidence, assertRouteForm } = require('./task-route-evidence');
const { samplingExpired } = require('./sampling-deadline');
const { uiEvidence } = require('./task-ui-evidence');
const { createTargetMatcher, safeEntry } = require('./task-ui-target');
const taskEntries = (graph, screen) => rawEntries(graph, screen, { excludeHiddenSubtrees: true });

function loadingEvidence(task, entries, activePackage = task.package) {
    if (!task.loading) return undefined;
    if (task.intent === 'ui_task') {
        const result = createTargetMatcher(task, entries, activePackage)(task.loading);
        return { matches: result.hits.length, visible: result.hits.filter(safeEntry).length,
            safe: result.complete && result.hits.every(safeEntry) };
    }
    const markers = entries.filter(entry => entry.attrs['resource-id'] === task.loading.id);
    const safe = markers.every(entry => {
        for (let raw = entry.raw; raw; raw = raw.parent) {
            if (raw.attrs?.password === 'true' || raw.attrs?.clickable === 'true' || raw.attrs?.editable === 'true'
                || deriveUiAutomatorRole(raw.attrs?.class) === 'TextField') return false;
        }
        return true;
    });
    const visible = markers.reduce((count, entry) => count + Number(Boolean(entry.visible)), 0);
    return Object.freeze({ matches: markers.length, visible, safe });
}

// Raw subtree attributes in a fixed order; `skip` is replaced by a marker without descending.
function treeData(root, skip) {
    const nodes = [];
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        if (node === skip) { nodes.push('target'); continue; }
        nodes.push(Object.entries(node.attrs || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        nodes.push((node.children || []).length);
        stack.push(...(node.children || []));
    }
    return nodes;
}

function resourceCounts(entries) {
    const counts = new Map();
    for (const entry of entries) {
        const id = entry.attrs['resource-id'];
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
}

function searchActionEvidence(task, entries, counts, hash) {
    const shown = entry => Boolean(entry?.visible) && ancestorsSafe(entry.raw);
    function ancestorsSafe(raw) {
        for (; raw; raw = raw.parent) if (raw.attrs?.['visible-to-user'] === 'false' || raw.attrs?.displayed === 'false'
            || raw.attrs?.password === 'true' || raw.attrs?.enabled === 'false') return false;
        return true;
    }
    const fields = entries.filter(e => deriveUiAutomatorRole(e.attrs.class) === 'TextField');
    const focused = entries.filter(e => e.attrs.focused === 'true');
    const focusedField = fields.length === 1 && focused.length === 1 && fields[0] === focused[0] && shown(fields[0])
        && fields[0].attrs.text === task.inputs.query ? fields[0].attrs['resource-id'] : null;
    let scroll;
    if (task.searchActions?.scroll) {
        const config = task.searchActions.scroll;
        const containers = entries.filter(e => e.attrs['resource-id'] === config.container);
        const targets = entries.filter(e => e.attrs['resource-id'] === config.target);
        const container = containers[0], target = targets[0];
        let inside = false;
        for (let raw = target?.raw.parent; raw; raw = raw.parent) if (raw === container?.raw) inside = true;
        const box = container?.visible, region = target?.visible;
        const safe = containers.length === 1 && shown(container) && container.attrs.scrollable === 'true'
            && box.right - box.left >= 16 && box.bottom - box.top >= 16 && targets.length <= 1
            && (!target || inside && ancestorsSafe(target.raw));
        const horizontal = ['left', 'right'].includes(config.direction);
        const targetVisible = Boolean(safe && target && shown(target) && region && (horizontal
            ? region.left > box.left && region.right < box.right : region.top > box.top && region.bottom < box.bottom));
        scroll = Object.freeze({ safe, targetVisible,
            ...(config.maxSwipes > 1 ? { position: safe ? scrollSnapshot(task, entries, container, counts, hash, targetVisible) : null } : {}) });
    }
    return Object.freeze({ editableCount: fields.length, focusedCount: focused.length, focusedField, ...(scroll ? { scroll } : {}),
        ...(task.searchActions?.back ? { back: backEvidence(task.searchActions.back, entries) } : {}) });
}

function createTaskPort({ runtime, captureGraph, executePlan, ensureCapabilities, handoff, bindSnapshot }) {
    const actions = new AsyncLocalStorage();
    const tasks = new AsyncLocalStorage();
    const issued = new WeakMap();
    // Only errors emitted by this port's stale fence AND completed with a failed
    // owned receipt can grant retry. A code/string supplied elsewhere cannot.
    const undispatchedStale = new WeakSet();
    const fail = (code, contextDiff) => {
        const error = runtime.failure(code, '任务证据不可信或已变化；未派发新动作。');
        throw contextDiff?.length ? Object.assign(error, { contextDiff: orderedTokens(contextDiff) }) : error;
    };
    // Per-task HMAC: comparable inside one trace, not reversible to page text across tasks.
    const regionDigest = (label, value) => createHmac('sha256', tasks.getStore().digestKey)
        .update(JSON.stringify([label, value])).digest('hex');
    const digest = (serial, graph, probe) => createHmac('sha256', tasks.getStore().digestKey)
        .update(approvalBinding({ serial, requestId: null, action: {}, policy: '', probe, graph })).digest('hex');
    const contextDigest = graph => createHash('sha256').update(JSON.stringify(graph.contextEvidence?.context || null)).digest('hex');
    function belongsTo(graph, pkg) {
        const stack = [graph.rawRoot];
        while (stack.length) {
            const raw = stack.pop();
            if (!raw) continue;
            if (raw.tag === 'node' && raw.attrs?.package !== pkg) return false;
            stack.push(...(raw.children || []));
        }
        return true;
    }
    function beforeCapture(serial) {
        const state = tasks.getStore();
        if (!state) return;
        runtime.check();
        if (serial !== state.task.serial) fail('TASK_CONTEXT_UNPROVEN');
        if (state.observations >= state.task.budget.maxObservations) fail('TASK_BUDGET_EXHAUSTED');
        state.observations++;
    }
    async function observe(task, options = {}) {
        runtime.check();
        const graph = await captureGraph(task.serial, { limit: 500, includeDisabled: task.intent !== 'ui_task',
            deadlineMs: Math.min(options.deadlineMs ?? Infinity, Date.now() + runtime.remainingMs()) });
        const evidence = graph.contextEvidence;
        const probe = evidence?.probe;
        const entries = probe?.size ? taskEntries(graph, probe.size) : [];
        // Counts belong to this capture only, including hidden duplicates. Never
        // retain raw nodes or reuse an index after the next observation.
        const rawCounts = task.searchActions ? resourceCounts(entries) : null;
        // An explicitly declared raw marker may be the only meaningful content
        // during loading, even when the presentation graph prunes an empty label.
        const loading = loadingEvidence(task, entries, evidence?.context.package);
        const actionEvidence = task.searchActions ? searchActionEvidence(task, entries, rawCounts, regionDigest) : undefined;
        const toggle = task.intent === 'set_toggle' ? toggleEvidence(task, entries, graph.controls) : undefined;
        const route = task.intent === 'route_search' ? routeEvidence(task, entries, graph.controls) : undefined;
        const reasons = [];
        if (!evidence) reasons.push('task_context');
        if (graph.truncated) reasons.push('task_truncated');
        if (graph.keyguard) reasons.push('task_keyguard');
        if (!graph.controls.length && !(loading?.matches === 1 && loading.visible === 1 && loading.safe)
            && !actionEvidence?.back?.sourceSafe) reasons.push('task_empty');
        const uiTask = task.intent === 'ui_task';
        if (evidence && (uiTask ? !task.allowedPackages.includes(evidence.context.package) : evidence.context.package !== task.package)) reasons.push('task_package');
        if (evidence && evidence.context.displayId !== 0) reasons.push('task_display');
        if (!belongsTo(graph, uiTask ? evidence?.context.package : task.package)) reasons.push('task_foreign_node');
        if (evidence && !hasCompleteLayout(graph, probe, entries)) reasons.push('task_layout');
        const complete = reasons.length === 0;
        if (!complete) fail('TASK_CONTEXT_UNPROVEN', reasons);
        // Context drift between two individually coherent samples ends a settle wait without
        // a thrown error; record which dimensions moved relative to the previous task sample.
        const state = tasks.getStore();
        const contextDiff = state?.lastContext ? orderedTokens([...contextDifference(state.lastContext, evidence.context),
            ...(state.lastEpoch !== evidence.epoch ? ['epoch'] : [])]) : [];
        if (state) { state.lastContext = evidence.context; state.lastEpoch = evidence.epoch; }
        if (uiTask) {
            const { ui, bindings } = uiEvidence(task, graph, entries, regionDigest, evidence.context.package);
            const sample = Object.freeze({ complete, package: evidence.context.package, displayId: evidence.context.displayId,
                contextDiff: Object.freeze(contextDiff), ui,
                observation: Object.freeze({ id: randomUUID(), digest: digest(task.serial, graph, probe),
                    contextDigest: contextDigest(graph), controls: graph.controls.length }) });
            issued.set(sample, { task, at: Date.now(), epoch: evidence.epoch, graph, probe, bindings });
            return sample;
        }
        // Completion labels can be folded into clickable rows by the action graph.
        // Count the original visible descendants, without exposing their text to the host.
        const completion = task.completion;
        const containers = entries.filter(entry => entry.attrs['resource-id'] === completion.id && entry.visible);
        const items = containers.length === 1 && completion.item ? entries.filter(entry => {
            if (!entry.visible || entry.attrs['resource-id'] !== completion.item || entry.attrs.password === 'true') return false;
            let descendant = false;
            for (let parent = entry.raw.parent; parent; parent = parent.parent) {
                if (parent.attrs?.password === 'true') return false;
                if (parent === containers[0].raw) descendant = true;
            }
            return descendant;
        }) : [];
        const target = containers.length === 1 ? containers[0].raw : null;
        const completionEvidence = Object.freeze({
            present: entries.some(entry => entry.attrs['resource-id'] === completion.id),
            containers: containers.length, items: items.length,
            inputMatched: Boolean(completion.itemMatchesInput && items.some(entry => String(entry.attrs.text || '').includes(task.inputs.query))),
            absent: !completion.absent || !entries.some(entry => entry.attrs['resource-id'] === completion.absent),
        });
        // Ephemeral identity for a direct raw parent, never a public selector or
        // external label/path. A hierarchy root does not establish a form group.
        const parentGroups = new Map();
        const parentGroup = node => {
            const parent = node.rawNode?.parent;
            if (parent?.tag !== 'node') return null;
            if (!parentGroups.has(parent)) parentGroups.set(parent, parentGroups.size + 1);
            return parentGroups.get(parent);
        };
        const sample = Object.freeze({ complete, package: evidence.context.package, displayId: evidence.context.displayId,
            completion: completionEvidence,
            ...(toggle ? { toggle } : {}),
            ...(route ? { route } : {}),
            ...(actionEvidence ? { searchActionEvidence: actionEvidence } : {}),
            ...(loading ? { loading } : {}),
            contextDiff: Object.freeze(contextDiff),
            observation: Object.freeze({ id: randomUUID(), digest: digest(task.serial, graph, probe),
                contextDigest: contextDigest(graph), controls: graph.controls.length,
                ...(target ? { targetDigest: regionDigest('target', treeData(target)),
                    outsideDigest: regionDigest('outside', treeData(graph.rawRoot, target)) } : {}) }),
            controls: Object.freeze(graph.controls.map(node => Object.freeze({ id: node.id, role: node.role,
                enabled: node.enabled, inViewport: node.inViewport, password: node.flags.includes('password'),
                ...(task.decision === 'jev' && task.intent === 'search' ? {
                    text: node.role === 'textfield' || node.flags.includes('password') ? '' : node.text,
                    desc: node.flags.includes('password') ? '' : node.desc,
                    parentGroup: parentGroup(node),
                    ...(task.searchActions ? { scrollable: node.rawNode?.attrs?.scrollable === 'true',
                        rawMatches: rawCounts.get(node.id) || 0 } : {}),
                    inputMatches: node.role === 'textfield' && !node.flags.includes('password') && node.text === task.inputs.query,
                } : {}),
                clickable: node.rawNode?.attrs?.clickable === 'true' }))) });
        issued.set(sample, { task, at: Date.now(), epoch: evidence.epoch });
        return sample;
    }
    function assertWrite(serial, probe, graph) {
        const fence = actions.getStore();
        if (!fence) return;
        const { task, sample, record, verificationDeadlineMs, action } = fence;
        runtime.check();
        if (verificationDeadlineMs !== undefined && Date.now() >= verificationDeadlineMs) fail('TASK_COMPLETION_UNPROVEN');
        const pkg = task.intent === 'ui_task' ? sample.package : task.package;
        if (serial !== task.serial || probe.focus?.package !== pkg || !belongsTo(graph, pkg)
            || graph.truncated || !graph.contextEvidence || graph.contextEvidence.epoch !== record.epoch
            || contextDigest(graph) !== sample.observation.contextDigest) fail('TASK_CONTEXT_UNPROVEN');
        if (task.intent === 'route_search') {
            const proof = routeEvidence(task, taskEntries(graph, probe.size), graph.controls);
            // Progress/safety failures must not become retryable digest drift, even
            // if a vanished field returns before the next loop observation.
            assertRouteForm(proof, REFS.filter(ref => sample.route.fields[ref].inputMatched));
            if (action.command === 'Tap' && REFS.some(ref => !proof.fields[ref].inputMatched)) fail('TASK_PROGRESS_LOST');
        }
        if (Date.now() - record.at >= 15000 || digest(serial, graph, probe) !== sample.observation.digest) {
            fence.stale = true;
            fail('TASK_OBSERVATION_CHANGED');
        }
        if (task.intent === 'ui_task') return; // The private action binding was checked by executeUi.
        if (task.intent === 'set_toggle') {
            const proof = toggleEvidence(task, taskEntries(graph, probe.size), graph.controls);
            if (!proof.safe || proof.checked === task.inputs.checked) fail('TASK_TARGET_UNSAFE');
        }
        if (action.command === 'KeyEvent') {
            const proof = backEvidence(task.searchActions.back, taskEntries(graph, probe.size));
            if (!proof.sourceSafe || proof.targetMatches !== 0) fail('TASK_NAVIGATION_UNSAFE');
        }
        if (action.command === 'ImeAction') {
            const entries = taskEntries(graph, probe.size);
            const counts = task.searchActions?.scroll?.maxSwipes > 1 ? resourceCounts(entries) : null;
            const proof = searchActionEvidence(task, entries, counts, regionDigest);
            if (proof.focusedField !== action.id) fail('TASK_FOCUS_UNPROVEN');
        }
    }
    async function execute(task, action, expected, sample, verifyAfter, { verificationDeadlineMs } = {}) {
        const record = issued.get(sample);
        if (!record || record.task !== task) fail('TASK_CONTEXT_UNPROVEN');
        if (task.intent === 'ui_task') return executeUi(task, action, sample, record);
        const command = action.command.toLowerCase();
        if (!['tap', 'fill', 'scroll', 'scrolluntil', 'imeaction', 'keyevent'].includes(command)) fail('TASK_ACTION_UNSUPPORTED');
        if (task.intent === 'set_toggle' && (command !== 'tap' || action.id !== task.targets.toggle
            || Object.keys(action).some(k => !['command', 'id'].includes(k))
            || !sample.toggle?.safe || sample.toggle.checked === task.inputs.checked)) fail('TASK_ACTION_UNSUPPORTED');
        if (task.intent === 'route_search') {
            assertRouteForm(sample.route);
            const ref = REFS.find(ref => task.targets[ref] === action.id);
            if (!(command === 'fill' && ref && action.text === task.inputs[ref] && !sample.route.fields[ref].inputMatched
                && Object.keys(action).every(k => ['command', 'id', 'text'].includes(k))
                || command === 'tap' && action.id === task.targets.submit && REFS.every(ref => sample.route.fields[ref].inputMatched)
                && Object.keys(action).every(k => ['command', 'id'].includes(k)))) fail('TASK_ACTION_UNSUPPORTED');
        }
        if (command === 'keyevent' && (!task.searchActions?.back || action.key !== 'back'
            || Object.keys(action).some(k => !['command', 'key'].includes(k))
            || !sample.searchActionEvidence?.back?.sourceSafe || sample.searchActionEvidence.back.targetMatches !== 0)) fail('TASK_NAVIGATION_UNSAFE');
        if (command === 'imeaction' && (!task.searchActions?.imeAction || action.imeAction !== task.searchActions.imeAction
            || sample.searchActionEvidence?.focusedField !== action.id)) fail('TASK_FOCUS_UNPROVEN');
        if (command === 'scroll' || command === 'scrolluntil') {
            const scope = task.searchActions?.scroll;
            if (!scope || scope.command !== action.command || scope.direction !== action.direction || !sample.searchActionEvidence?.scroll?.safe
                || sample.searchActionEvidence.scroll.targetVisible || (command === 'scroll'
                    ? action.id !== scope.container || action.distance !== 0.6 || action.duration !== 300
                    : action.container !== `id=${scope.container}` || action.target !== `id=${scope.target}` || action.strategy !== 'host' || action.maxSwipes !== 1)) fail('TASK_ACTION_UNSUPPORTED');
        }
        const fence = { task, sample, record, action, verificationDeadlineMs, stale: false };
        let result;
        try { result = await runtime.runOwned({ serial: task.serial, actionCommand: command }, () =>
            actions.run(fence, async () => {
                if (Date.now() - record.at >= 15000) { fence.stale = true; fail('TASK_OBSERVATION_CHANGED'); }
                const output = await executePlan({ action, command, expected, verificationDeadlineMs,
                    waitMs: Math.min(5000, runtime.remainingMs()), experimentalM2: false }, task.serial, null, {});
                // Internal host postcondition, never supplied as executable code by a tool caller.
                // Route Fill requires both RPC readback and stable raw-tree evidence.
                // Never replace a failed/missing RPC verification with tree-only success.
                const routeFillVerified = task.intent !== 'route_search' || command !== 'fill' || output.details?.fillVerified === true;
                if (verifyAfter && output.details?.actionVerified !== false && routeFillVerified) {
                    const deadline = Math.min(verificationDeadlineMs ?? Infinity, Date.now() + Math.min(5000, runtime.remainingMs()));
                    let matched = false, verification;
                    while (true) {
                        runtime.check();
                        if (Date.now() >= deadline) break;
                        let after;
                        try { after = await observe(task, { deadlineMs: deadline }); }
                        catch (error) {
                            runtime.check();
                            // A drained capture that used this window cannot renew it.
                            // Unknown/in-flight transport failures retain their original receipt.
                            if (!samplingExpired(error, deadline)) throw error;
                            break;
                        }
                        runtime.check();
                        if (Date.now() >= deadline) break;
                        verification = verifyAfter(after);
                        matched = verification === true || verification?.matched === true;
                        if (Date.now() >= deadline) matched = false;
                        if (matched || Date.now() >= deadline) break;
                        await runtime.pause(Math.max(0, Math.min(100, deadline - Date.now())));
                    }
                    runtime.verified(matched, { type: 'task_progress', ...(matched ? verification?.scrollProof ? { scrollProof: verification.scrollProof } : {} : { error: 'TASK_NO_PROGRESS' }) });
                }
                return output;
            })); } catch (error) {
            if (fence.stale && error.code === 'TASK_OBSERVATION_CHANGED' && error.execution?.outcome === 'failed'
                && error.execution.serial === task.serial && error.execution.requestId) undispatchedStale.add(error);
            throw error;
        }
        return { execution: result.details.execution };
    }
    async function executeUi(task, choice, sample, record) {
        // A caller/model never supplies selectors, indices, coordinates or values.
        const allowed = ['command', 'nodeRef', 'inputRef', 'direction', 'imeAction', 'package'];
        if (Object.keys(choice).some(k => !allowed.includes(k)) || !task.operations.includes(choice.command)) fail('TASK_ACTION_UNSUPPORTED');
        const binding = record.bindings.get(choice.nodeRef);
        const node = sample.ui.nodes.find(n => n.nodeRef === choice.nodeRef);
        let action;
        if (choice.command === 'Back') {
            if (Object.keys(choice).length !== 1) fail('TASK_ACTION_UNSUPPORTED');
            action = { command: 'KeyEvent', key: 'back' };
        } else if (choice.command === 'LaunchApp') {
            if (Object.keys(choice).length !== 2 || !task.allowedPackages.includes(choice.package) || choice.package === sample.package) fail('TASK_ACTION_UNSUPPORTED');
            action = { command: 'LaunchApp', package: choice.package, taskObservationRequired: true };
        } else {
            if (!binding?.operations.includes(choice.command) || !node) fail('TASK_TARGET_UNSAFE');
            const expectedKeys = { Tap: ['command', 'nodeRef'], LongPress: ['command', 'nodeRef'],
                Fill: ['command', 'nodeRef', 'inputRef'], Scroll: ['command', 'nodeRef', 'direction'], ImeAction: ['command', 'nodeRef', 'imeAction'] }[choice.command];
            if (!expectedKeys || Object.keys(choice).length !== expectedKeys.length || Object.keys(choice).some(k => !expectedKeys.includes(k))) fail('TASK_ACTION_UNSUPPORTED');
            if (choice.command === 'Fill' && (!Object.hasOwn(task.inputs, choice.inputRef) || node.inputMatches.includes(choice.inputRef))) fail('TASK_ACTION_UNSUPPORTED');
            if (choice.command === 'Scroll' && !['up', 'down', 'left', 'right'].includes(choice.direction)) fail('TASK_ACTION_UNSUPPORTED');
            if (choice.command === 'ImeAction' && (!node.focused || !['search', 'enter'].includes(choice.imeAction))) fail('TASK_FOCUS_UNPROVEN');
            const snapshot = bindSnapshot(task.serial, record.graph, record.probe.size, record.probe.focus, 500);
            action = { command: choice.command, index: binding.index, snapshotId: snapshot.snapshotId,
                ...(choice.command === 'Fill' ? { text: task.inputs[choice.inputRef] } : {}),
                ...(choice.command === 'Scroll' ? { direction: choice.direction, distance: 0.6, duration: 300 } : {}),
                ...(choice.command === 'LongPress' ? { duration: task.longPressMs } : {}),
                ...(choice.command === 'ImeAction' ? { imeAction: choice.imeAction } : {}) };
        }
        const fence = { task, sample, record, action, stale: false };
        try {
            const result = await runtime.runOwned({ serial: task.serial, actionCommand: action.command.toLowerCase() }, () =>
                actions.run(fence, async () => {
                    if (Date.now() - record.at >= 15000) { fence.stale = true; fail('TASK_OBSERVATION_CHANGED'); }
                    return executePlan({ action, command: action.command.toLowerCase(), expected: null,
                        waitMs: Math.min(5000, runtime.remainingMs()), experimentalM2: false }, task.serial, null, {});
                }));
            return { execution: result.details.execution };
        } catch (error) {
            if (fence.stale && error.code === 'TASK_OBSERVATION_CHANGED' && error.execution?.outcome === 'failed'
                && error.execution.serial === task.serial && error.execution.requestId) undispatchedStale.add(error);
            throw error;
        }
    }
    return Object.freeze({ observe, execute, assertWrite, beforeCapture,
        handoff: typeof handoff !== 'function' ? undefined : async (_packet, options) => {
            const state = tasks.getStore();
            if (!state) fail('TASK_CONTEXT_UNPROVEN');
            const result = await handoff(state.task, options);
            runtime.check();
            if (result.resumed) {
                // invalidate clears the tracker's context; its next coherent
                // capture advances exactly once. Other context drift still fails.
                state.lastEpoch = result.epoch + 1;
            }
            return result.resumed === true;
        },
        isUndispatchedStale: error => undispatchedStale.has(error), check: runtime.check, pause: runtime.pause,
        preflight: task => ensureCapabilities(task.serial),
        run: (task, callback) => tasks.run({ task, observations: 0, digestKey: randomBytes(32), lastContext: null, lastEpoch: null }, callback),
        observationCount: () => tasks.getStore()?.observations || 0,
        get signal() { return runtime.executionSignal(); }, remainingMs: runtime.remainingMs, remainingTaskMs: runtime.remainingTaskMs });
}

module.exports = { createTaskPort };
