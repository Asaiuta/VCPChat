'use strict';

const { createHash } = require('node:crypto');
const { withOperationDeadline } = require('./operation-deadline');

// Ephemeral approval evidence, never a public token or persistent element handle.
function approvalBinding({ serial, requestId, action, policy, probe, graph }) {
    const nodes = [];
    const stack = [graph.rawRoot];
    while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        nodes.push(Object.entries(node.attrs || {}).sort(([a], [b]) => a.localeCompare(b)));
        nodes.push((node.children || []).length);
        stack.push(...(node.children || []));
    }
    return createHash('sha256').update(JSON.stringify({ serial, requestId, action, policy,
        context: graph.contextEvidence?.context || null, epoch: graph.contextEvidence?.epoch,
        focus: probe.focus, size: probe.size, keyguard: probe.keyguard, wakefulness: probe.wakefulness,
        displayId: probe.displayId, rotation: probe.rotation, nodes })).digest('hex');
}

function createHumanInteraction({ getService, runtime }) {
    const available = () => typeof getService()?.request === 'function';
    async function request(kind, detail, options = {}) {
        runtime.check();
        if (!available()) throw runtime.failure('HUMAN_INTERACTION_UNAVAILABLE', '宿主没有注入可信用户交互服务。');
        const signal = AbortSignal.any([runtime.executionSignal(), options.signal].filter(Boolean));
        const timeoutMs = Math.min(options.timeoutMs ?? Infinity, kind === 'handoff' ? 600000 : 60000, runtime.remainingTaskMs());
        try {
            const answer = await withOperationDeadline(timeoutMs, signal, ({ signal }) => {
                runtime.check();
                return getService().request({ kind, detail, signal });
            });
            runtime.check();
            return answer === true;
        } catch (error) {
            runtime.check();
            if (error.code === 'TIMEOUT' || error.code === 'ABORTED') {
                throw runtime.failure('HUMAN_INTERACTION_CANCELLED', '用户交互已取消；不执行原动作。');
            }
            throw runtime.failure('HUMAN_INTERACTION_FAILED', '宿主用户交互失败；未批准，不执行原动作。');
        }
    }
    return { available, request };
}

module.exports = { createHumanInteraction, approvalBinding };
