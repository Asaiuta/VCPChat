'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { sameContext, frameContext } = require('./context');
const { approvalBinding } = require('./human-interaction');

/** Bind policy to the real action path, never to model-supplied approval fields. */
function createInteractionGuard({ policy, probe, captureGraph, check, fail, human, requestId = () => null, assertWrite = () => {} }) {
    const actions = new AsyncLocalStorage();
    const deny = (code, message) => Object.assign(fail(code, message), { dispatched: false, drained: true });
    const assertRead = state => policy.assertAllowed({ operation: 'read', package: state?.focus?.package || '' });
    function assertPolicy(request, defer = false) {
        const decision = policy.decide(request);
        if (decision.needsConfirmation && defer && human?.available()) return decision;
        return policy.assertAllowed(request);
    }
    async function read(serial, supplied) {
        check();
        const current = supplied || await probe(serial);
        assertRead(current);
        return current;
    }
    function readGraph(graph) {
        const stack = graph.rawRoot ? [graph.rawRoot] : [];
        const packages = new Set();
        while (stack.length) {
            const raw = stack.pop();
            if (raw.tag === 'node') packages.add(raw.attrs?.package || '');
            stack.push(...(raw.children || []));
        }
        if (!graph.rawRoot) for (const control of graph.matchingControls || graph.controls || []) packages.add(control.package || '');
        for (const pkg of packages) policy.assertAllowed({ operation: 'read', package: pkg });
        return packages;
    }
    function binding(value) {
        const state = actions.getStore();
        if (state && value) state.binding = value;
    }
    function target(control, evidence) {
        const state = actions.getStore();
        if (state && control) state.control = control;
        binding(evidence);
    }
    async function preflight(serial) {
        check();
        const state = actions.getStore();
        if (!state) throw deny('POLICY_CONTEXT_REQUIRED', '输入缺少受控动作上下文。');
        const current = await read(serial);
        const request = { operation: 'write', package: current?.focus?.package || '',
            action: state.command, capability: state.action.capability, control: state.control || undefined };
        assertPolicy(request, true);
        const destination = state.action.package || state.action.packageName || state.action.app;
        if (typeof destination === 'string' && destination) assertPolicy({ ...request, package: destination }, true);
    }
    async function write(serial, { continuation = false } = {}) {
        check();
        const state = actions.getStore();
        if (!state) throw deny('POLICY_CONTEXT_REQUIRED', '输入缺少受控动作上下文。');
        // A bounded second click is part of one already-checked compound gesture. It
        // still rechecks mutable policy, but a fresh ADB round trip would destroy its ABI.
        if (continuation && state.gate && state.command === 'doubletap') {
            const approved = state.gate.approvedPolicy === policy.fingerprint();
            assertDecision(state, state.gate.probe, state.gate.graph, approved);
            return state.gate.probe;
        }
        let gate = await sampleWrite(state, serial);
        const decisions = assertDecision(state, gate.probe, gate.graph, true);
        if (decisions.some(decision => decision.needsConfirmation)) {
            // Waiting cannot renew a 15-second index/frame credential. Use a live
            // semantic selector for an action requiring human approval.
            if ([state.action, state.action.target || {}].some(action => action.index !== undefined || action.frameId !== undefined)) {
                throw deny('POLICY_APPROVAL_REQUIRES_SELECTOR', '需要人工确认的动作必须使用实时语义目标，不能延长旧索引或像素凭据。');
            }
            const fingerprint = () => approvalBinding({ serial, requestId: requestId(), action: state.action,
                policy: policy.fingerprint(), probe: gate.probe, graph: gate.graph });
            const before = fingerprint();
            const detail = `设备：${serial}\n应用：${gate.probe.focus?.package || '未知'}\n动作：${state.command}\n`
                + `目标：${state.control?.label || state.control?.id || '当前界面'}\n参数：${JSON.stringify(state.action)}`;
            if (!await human.request('approval', detail)) throw deny('POLICY_REJECTED', '用户拒绝本次操作；未派发。');
            check();
            gate = await sampleWrite(state, serial);
            assertDecision(state, gate.probe, gate.graph, true);
            if (before !== fingerprint()) throw deny('POLICY_APPROVAL_STALE', '批准期间界面、目标、动作或策略发生变化；未派发，请重新观察。');
            gate.approvedPolicy = policy.fingerprint();
        }
        state.gate = gate;
        return gate.probe;
    }
    async function sampleWrite(state, serial) {
        const current = await read(serial);
        const pkg = current?.focus?.package;
        assertPolicy({ operation: 'write', package: pkg || '', action: state.command, capability: state.action.capability }, true);
        if (state.command !== 'wake' && (current?.wakefulness !== 'Awake' || current?.keyguard?.showing !== false
            || current?.keyguard?.inputRestricted !== false || !pkg)) {
            throw deny('POLICY_CONTEXT_UNPROVEN', '未确认醒着且未锁定的输入上下文。');
        }
        let graph = { controls: [] };
        if (!['system', 'launchapp', 'killapp', 'wake'].includes(state.command)) {
            try { graph = await captureGraph(serial, { limit: 500, screen: current.size, rpcTarget: true }); }
            catch (error) {
                if (/^(?:POLICY_|STEP_|DEVICE_STATE_UNCERTAIN)/.test(error.code || '')) throw error;
                throw deny(error.code || 'UI_ACQUISITION_FAILED', '派发前界面证据采集失败；未派发。');
            }
            if (graph.package && graph.package !== pkg) throw deny('POLICY_CONTEXT_CHANGED', '派发前界面归属已变化。');
            if (state.binding && (!graph.contextEvidence
                || state.binding.epoch !== graph.contextEvidence.epoch
                || !sameContext(state.binding.context, graph.contextEvidence.context))) {
                throw deny('POLICY_CONTEXT_CHANGED', '派发前目标的上下文证据已变化。');
            }
            if (graph.contextEvidence && !sameContext(frameContext(current), graph.contextEvidence.context)) {
                throw deny('POLICY_CONTEXT_CHANGED', '派发前安全采样改变了上下文。');
            }
        }
        assertWrite(serial, current, graph);
        return { probe: current, graph };
    }
    function assertDecision(state, current, graph, defer = false) {
        const decisions = [];
        const assertWrite = request => decisions.push(assertPolicy(request, defer));
        const packages = readGraph(graph);
        const controls = graph.matchingControls || graph.controls || [];
        const request = { operation: 'write', package: current?.focus?.package || '',
            action: state.command, capability: state.action.capability };
        const destination = state.action.package || state.action.packageName || state.action.app;
        if (typeof destination === 'string' && destination) assertWrite({ ...request, package: destination });
        // Exact node targets use only their current matching identity. Unscoped keys,
        // coordinates and gestures conservatively inspect the complete control set.
        const control = state.control;
        if (control) {
            const fresh = controls.filter(item => item.package === control.package
                && item.id === control.id && item.cls === control.cls
                && item.x === control.x && item.y === control.y);
            if (fresh.length !== 1) throw deny('POLICY_TARGET_CHANGED', '派发前目标证据不再唯一。');
            assertWrite(request);
            assertWrite({ ...request, package: fresh[0].package || '', control: fresh[0] });
        } else {
            assertWrite({ ...request, controls });
            // Raw descendants may have been folded into another package's control.
            for (const pkg of packages) {
                assertWrite({ ...request, package: pkg });
            }
        }
        return decisions;
    }
    return { read, readGraph, preflight, write, target, binding,
        run: (command, action, task) => actions.run({ command, action, control: null, binding: null, gate: null }, task),
        active: () => actions.getStore() || null };
}

module.exports = { createInteractionGuard };
