'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, createHmac, randomBytes, randomUUID } = require('node:crypto');
const { approvalBinding } = require('./human-interaction');
const { layoutEvidence, rawEntries } = require('./layout-evidence');
const { contextDifference, orderedTokens } = require('./context');

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

function createTaskPort({ runtime, captureGraph, executePlan, ensureCapabilities }) {
    const actions = new AsyncLocalStorage();
    const tasks = new AsyncLocalStorage();
    const issued = new WeakMap();
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
        const graph = await captureGraph(task.serial, { limit: 500, includeDisabled: true,
            deadlineMs: Math.min(options.deadlineMs ?? Infinity, Date.now() + runtime.remainingMs()) });
        const evidence = graph.contextEvidence;
        const probe = evidence?.probe;
        const reasons = [];
        if (!evidence) reasons.push('task_context');
        if (graph.truncated) reasons.push('task_truncated');
        if (graph.keyguard) reasons.push('task_keyguard');
        if (!graph.controls.length) reasons.push('task_empty');
        if (evidence && evidence.context.package !== task.package) reasons.push('task_package');
        if (evidence && evidence.context.displayId !== 0) reasons.push('task_display');
        if (!belongsTo(graph, task.package)) reasons.push('task_foreign_node');
        if (evidence && !layoutEvidence(graph, probe).complete) reasons.push('task_layout');
        const complete = reasons.length === 0;
        if (!complete) fail('TASK_CONTEXT_UNPROVEN', reasons);
        // Context drift between two individually coherent samples ends a settle wait without
        // a thrown error; record which dimensions moved relative to the previous task sample.
        const state = tasks.getStore();
        const contextDiff = state?.lastContext ? orderedTokens([...contextDifference(state.lastContext, evidence.context),
            ...(state.lastEpoch !== evidence.epoch ? ['epoch'] : [])]) : [];
        if (state) { state.lastContext = evidence.context; state.lastEpoch = evidence.epoch; }
        // Completion labels can be folded into clickable rows by the action graph.
        // Count the original visible descendants, without exposing their text to the host.
        const entries = rawEntries(graph, probe.size);
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
        const sample = Object.freeze({ complete, package: evidence.context.package, displayId: evidence.context.displayId,
            completion: completionEvidence,
            contextDiff: Object.freeze(contextDiff),
            observation: Object.freeze({ id: randomUUID(), digest: digest(task.serial, graph, probe),
                contextDigest: contextDigest(graph), controls: graph.controls.length,
                ...(target ? { targetDigest: regionDigest('target', treeData(target)),
                    outsideDigest: regionDigest('outside', treeData(graph.rawRoot, target)) } : {}) }),
            controls: Object.freeze(graph.controls.map(node => Object.freeze({ id: node.id, role: node.role,
                enabled: node.enabled, inViewport: node.inViewport, password: node.flags.includes('password'),
                ...(task.decision === 'jev' ? {
                    text: node.role === 'textfield' || node.flags.includes('password') ? '' : node.text,
                    desc: node.flags.includes('password') ? '' : node.desc,
                    inputMatches: node.role === 'textfield' && !node.flags.includes('password') && node.text === task.inputs.query,
                } : {}),
                clickable: node.rawNode?.attrs?.clickable === 'true' }))) });
        issued.set(sample, { task, at: Date.now(), epoch: evidence.epoch });
        return sample;
    }
    function assertWrite(serial, probe, graph) {
        const fence = actions.getStore();
        if (!fence) return;
        const { task, sample, record, verificationDeadlineMs } = fence;
        runtime.check();
        if (verificationDeadlineMs !== undefined && Date.now() >= verificationDeadlineMs) fail('TASK_COMPLETION_UNPROVEN');
        if (serial !== task.serial || probe.focus?.package !== task.package || !belongsTo(graph, task.package)
            || graph.truncated || graph.contextEvidence?.epoch !== record.epoch || Date.now() - record.at >= 15000
            || digest(serial, graph, probe) !== sample.observation.digest) fail('TASK_OBSERVATION_CHANGED');
    }
    async function execute(task, action, expected, sample, verifyAfter, { verificationDeadlineMs } = {}) {
        const record = issued.get(sample);
        if (!record || record.task !== task || Date.now() - record.at >= 15000) fail('TASK_OBSERVATION_CHANGED');
        const command = action.command.toLowerCase();
        if (!['tap', 'fill'].includes(command)) fail('TASK_ACTION_UNSUPPORTED');
        const result = await runtime.runOwned({ serial: task.serial, actionCommand: command }, () =>
            actions.run({ task, sample, record, verificationDeadlineMs }, async () => {
                const output = await executePlan({ action, command, expected, verificationDeadlineMs,
                    waitMs: Math.min(5000, runtime.remainingMs()), experimentalM2: false }, task.serial, null, {});
                // Internal host postcondition, never supplied as executable code by a tool caller.
                if (verifyAfter && output.details?.actionVerified !== false) {
                    const deadline = Date.now() + Math.min(5000, runtime.remainingMs());
                    let matched = false;
                    do {
                        runtime.check();
                        matched = verifyAfter(await observe(task)) === true;
                        if (matched || Date.now() >= deadline) break;
                        await runtime.pause(100);
                    } while (true);
                    runtime.verified(matched, { type: 'task_progress', ...(matched ? {} : { error: 'TASK_NO_PROGRESS' }) });
                }
                return output;
            }));
        return { execution: result.details.execution };
    }
    return Object.freeze({ observe, execute, assertWrite, beforeCapture, check: runtime.check, pause: runtime.pause,
        preflight: task => ensureCapabilities(task.serial),
        run: (task, callback) => tasks.run({ task, observations: 0, digestKey: randomBytes(32), lastContext: null, lastEpoch: null }, callback),
        observationCount: () => tasks.getStore()?.observations || 0,
        get signal() { return runtime.executionSignal(); }, remainingMs: runtime.remainingMs });
}

module.exports = { createTaskPort };
