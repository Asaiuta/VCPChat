'use strict';

const { createHash } = require('node:crypto');

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
    async function request(kind, detail) {
        runtime.check();
        if (!available()) throw runtime.failure('HUMAN_INTERACTION_UNAVAILABLE', '宿主没有注入可信用户交互服务。');
        const controller = new AbortController();
        const signal = runtime.executionSignal();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const timeoutMs = Math.min(kind === 'handoff' ? 600000 : 60000, runtime.remainingTaskMs());
        let timer;
        let onAbort;
        try {
            const boundary = new Promise((_, reject) => {
                onAbort = () => reject(runtime.failure('HUMAN_INTERACTION_CANCELLED', '用户交互已取消；不执行原动作。'));
                controller.signal.addEventListener('abort', onAbort, { once: true });
                if (controller.signal.aborted) onAbort();
                timer = setTimeout(abort, timeoutMs);
            });
            const answer = await Promise.race([boundary,
                Promise.resolve().then(() => {
                    runtime.check();
                    controller.signal.throwIfAborted();
                    return getService().request({ kind, detail, signal: controller.signal });
                })]);
            runtime.check();
            controller.signal.throwIfAborted();
            return answer === true;
        } catch (error) {
            runtime.check();
            if (error.code === 'HUMAN_INTERACTION_CANCELLED') throw error;
            throw runtime.failure('HUMAN_INTERACTION_FAILED', '宿主用户交互失败；未批准，不执行原动作。');
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            controller.signal.removeEventListener('abort', onAbort);
            controller.abort();
        }
    }
    return { available, request };
}

module.exports = { createHumanInteraction, approvalBinding };
