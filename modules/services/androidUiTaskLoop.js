'use strict';

const { createHash } = require('node:crypto');
const { POLICY } = require('./androidUiTaskContract');
const { questionsFor, select, modelElements } = require('./androidUiTaskDecision');
const { requestTaskModel } = require('./androidTaskModel');
const { samplingExpired } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/sampling-deadline');
const fail = code => Object.assign(new Error(code), { code });
const safeCode = e => /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code || '') ? e.code : 'TASK_FAILED';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a, b) => a.observation.digest === b.observation.digest && a.observation.contextDigest === b.observation.contextDigest;
const signature = (sample, action) => JSON.stringify([sample.ui.pageDigest, action]);

function candidatesFor(task, sample, excluded = new Set()) {
    const candidates = [];
    const add = (action, description) => {
        if (excluded.has(signature(sample, action))) return;
        candidates.push({ candidateId: `c${candidates.length}`, action: Object.freeze(action), description });
    };
    const assignments = (task.completion?.all || []).filter(p => p.type === 'text' && p.text.inputRef)
        .map(p => p.text);
    // A caller-declared exact field/input binding is also an action constraint.
    // Resolve visible writable assignments before exposing unrelated navigation
    // or speculative field/value pairs. If the form is not yet visible, normal
    // autonomous navigation remains available.
    const declaredRefs = new Set(assignments.map(p => p.inputRef));
    const pending = sample.ui.nodes.flatMap(n => n.operations.includes('Fill')
        ? (n.boundInputRefs || []).filter(ref => !n.inputMatches.includes(ref)).map(inputRef => ({ nodeRef: n.nodeRef, inputRef })) : []);
    for (const node of sample.ui.nodes) {
        const context = node.ancestors?.find(p => p.resourceId || p.label);
        const target = `${node.nodeRef} [${node.role}] ${node.label || node.resourceId || 'unlabelled control'}${node.role === 'textfield' ? ` current value=${JSON.stringify(node.value)}${node.valueTruncated ? ' (truncated)' : ''}` : ''}${context ? ` (within ${context.label || context.resourceId})` : ''}`;
        for (const command of node.operations) {
            if (pending.length && command !== 'Fill') continue;
            if (command === 'Fill') {
                const bound = node.boundInputRefs || [];
                for (const inputRef of Object.keys(task.inputs).filter(ref => !node.inputMatches.includes(ref)
                    && (!declaredRefs.has(ref) || bound.includes(ref))
                    && (!bound.length || bound.includes(ref))
                    && (!pending.length || pending.some(p => p.nodeRef === node.nodeRef && p.inputRef === ref))))
                    add({ command, nodeRef: node.nodeRef, inputRef }, `Replace ${target} with supplied input ${inputRef}`);
            } else if (command === 'Scroll') {
                for (const direction of ['down', 'up', 'left', 'right']) add({ command, nodeRef: node.nodeRef, direction }, `Scroll ${direction} within ${target}`);
            } else if (command === 'ImeAction') {
                for (const imeAction of ['search', 'enter']) add({ command, nodeRef: node.nodeRef, imeAction }, `Submit focused ${target} using ${imeAction}`);
            } else add({ command, nodeRef: node.nodeRef }, `${command} ${target}`);
        }
    }
    if (!pending.length && task.operations.includes('Back')) add({ command: 'Back' }, 'Navigate back once within the allowed applications');
    if (!pending.length && task.operations.includes('LaunchApp')) for (const pkg of task.allowedPackages.filter(p => p !== sample.package))
        add({ command: 'LaunchApp', package: pkg }, `Open allowed application ${pkg}`);
    if (!task.completion || sample.ui.completion?.matched) {
        add({ command: 'Done' }, 'All requirements are visibly satisfied; ask the host to verify completion');
    }
    if (candidates.length > POLICY.maxCandidates) throw fail('TASK_CANDIDATE_OVERFLOW');
    return candidates;
}

async function run(task, device, { jev, traceStore, services = {} }) {
    const counts = { actions: 0, actionAttempts: 0, verifiedActions: 0, modelCalls: 0, mainModelCalls: 0,
        mainModelRequests: 0, humanHandoffs: 0, staleEvents: 0 };
    const receipts = [], history = [], excluded = new Set(), verifiedFields = new Set();
    let trace, sample, consecutiveStale = 0, claimed = false, verified = false, pageSettled = true;
    let lastCandidates = [], candidateObservationId = null;
    const contractSha256 = hash({ completion: task.completion, inputs: task.inputs, loading: task.loading, longPressMs: task.longPressMs });
    const append = async event => {
        try { await trace.append(event); }
        catch (e) { throw fail(e.code === 'TRACE_LIMIT' ? 'TASK_TRACE_LIMIT' : 'TASK_TRACE_FAILED'); }
    };
    const observe = async deadlineMs => {
        device.check();
        const s = await device.observe(task, deadlineMs ? { deadlineMs } : {});
        device.check();
        if (!s.complete || s.displayId !== 0 || !task.allowedPackages.includes(s.package)) throw fail('TASK_CONTEXT_UNPROVEN');
        await append({ type: 'observation', observation: s.observation, package: s.package,
            pageDigest: s.ui.pageDigest, completionMatched: s.ui.completion?.matched ?? null });
        for (const field of s.ui.fieldStates || []) {
            if (verifiedFields.has(field.index) && field.present && (!field.proven || !field.matched))
                throw fail('TASK_PROGRESS_LOST');
            if (field.proven && field.editable && field.matched) verifiedFields.add(field.index);
        }
        return s;
    };
    const recover = async (reason, old) => {
        counts.staleEvents++; consecutiveStale++;
        await append({ type: 'recovery', observationId: old.observation.id, reason, consecutive: consecutiveStale });
        if (consecutiveStale >= POLICY.maxConsecutiveStale) throw fail('TASK_STALE_LIMIT');
    };
    const settle = async (before, verifyCompletion = false, awaitReady = false) => {
        const deadline = Date.now() + Math.min(POLICY.waitTimeoutMs, device.remainingMs());
        let previous = null, last = before, stable = false;
        while (Date.now() < deadline) {
            if (previous) await device.pause(Math.min(POLICY.sampleMs, Math.max(0, deadline - Date.now())));
            device.check();
            // A complete observation includes pre-probe, RPC tree and post-probe.
            // Never start that chain with only the window's trailing milliseconds;
            // a local timeout would leave transport ownership unresolved.
            if (deadline - Date.now() < POLICY.minSampleBudgetMs) break;
            try { last = await observe(deadline); }
            catch (e) {
                device.check();
                if (samplingExpired(e, deadline)) break;
                // A rejected read is not an uncertain write. Discard its data
                // and reacquire inside the existing window and stale budget.
                if (!['UI_CONTEXT_CHANGED', 'CONTEXT_UNPROVEN'].includes(e.code)) throw e;
                await recover('sampling_context_changed', last);
                previous = null; stable = false;
                await device.pause(Math.min(POLICY.sampleMs, Math.max(0, deadline - Date.now())));
                continue;
            }
            if (Date.now() >= deadline) break;
            stable = Boolean(previous && same(previous, last));
            if (verifyCompletion) {
                if (last.ui.completion?.matched && previous?.ui.completion?.matched && stable) { pageSettled = true; return last; }
            } else if ((awaitReady || last.ui.pageDigest !== before.ui.pageDigest) && stable
                && (!last.ui.loading || last.ui.completion?.matched)) { pageSettled = true; return last; }
            previous = last;
        }
        if (verifyCompletion) throw fail('TASK_COMPLETION_UNPROVEN');
        if (awaitReady && last === before) throw fail('TASK_WAIT_TIMEOUT');
        pageSettled = stable;
        return last;
    };
    const remaining = () => {
        let timeoutMs = 0;
        try { timeoutMs = Math.max(0, Math.min(task.budget.timeoutMs, Math.floor(device.remainingMs()))); } catch { /* Reporting after cancellation. */ }
        return { timeoutMs, actions: Math.max(0, task.budget.maxActions - counts.actions),
            observations: Math.max(0, task.budget.maxObservations - device.observationCount()),
            modelCalls: Math.max(0, task.budget.maxModelCalls - counts.modelCalls) };
    };
    const canAssist = reason => ['TASK_JEV_UNCERTAIN', 'TASK_ESCALATION_REQUIRED'].includes(reason)
        && receipts.every(r => ['verified', 'dispatched', 'failed'].includes(r.outcome));
    const escalation = (reason, observation = sample, candidates = lastCandidates) => ({ schemaVersion: 1,
        taskId: task.taskId, intent: 'ui_task', reason, continuation: 'not_authorized', evidenceFreshness: 'historical',
        disposition: canAssist(reason) ? 'assistance_required' : 'hard_stop',
        decisionPolicyVersion: POLICY.version, completionPolicyVersion: POLICY.completionVersion,
        goalSha256: hash(task.goal), contractSha256, inputRefs: Object.keys(task.inputs), budget: task.budget,
        scope: { package: task.package, allowedPackages: task.allowedPackages, operations: task.operations, displayId: 0, policy: 'recheck_required' },
        observation: observation?.observation ?? null, candidateObservationId,
        candidates: candidates.map(({ candidateId, action }) => ({ candidateId, action })),
        counts: { ...counts, observations: device.observationCount() }, remaining: remaining(), receipts: receipts.map(r => ({ ...r })) });
    const assist = require('./androidTaskAssistance').createTaskAssistance({ task, device, services, counts, append,
        eventIdentity: s => ({ observationId: s.observation.id }),
        evidence: (reason, s, candidates) => ({ ...escalation(reason, s, candidates),
            // Live, bounded task text is shared only with the explicitly chosen
            // main Agent. It is excluded from summaries and durable traces.
            context: { goal: task.goal, candidateDescriptions: candidates.map(c => ({ candidateId: c.candidateId, description: c.description })),
                requirements: task.completion?.all.map((p, i) => ({ type: p.type, satisfied: s.ui.completion.checks[i] === true })) ?? null,
                hostCompletionMatched: s.ui.completion?.matched ?? null, pageSettled, loading: s.ui.loading === true } }) });
    const revalidateAssistance = (before, fresh) => {
        if (fresh.observation.contextDigest !== before.observation.contextDigest) throw fail('TASK_CONTEXT_UNPROVEN');
        if (same(before, fresh)) return;
        for (const field of before.ui.nodes.filter(n => n.role === 'textfield' && n.inputMatches.length)) {
            const declared = (before.ui.fieldStates || []).filter(s => s.nodeRef === field.nodeRef && s.matched);
            if (declared.length) {
                if (declared.some(s => !fresh.ui.fieldStates?.[s.index]?.proven || !fresh.ui.fieldStates[s.index].matched))
                    throw fail('TASK_PROGRESS_LOST');
                continue;
            }
            const matches = fresh.ui.nodes.filter(n => n.role === 'textfield' && n.resourceId === field.resourceId);
            if (!field.resourceId || matches.length !== 1 || !field.inputMatches.every(ref => matches[0].inputMatches.includes(ref)))
                throw fail('TASK_PROGRESS_LOST');
        }
    };
    const summary = (status, code) => ({ schemaVersion: 1, taskId: task.taskId, serial: task.serial, package: task.package,
        intent: task.intent, status, code, decision: 'jev', experimental: true, assistance: task.assistance, decisionPolicy: POLICY,
        completionPolicyVersion: POLICY.completionVersion, modelClaimedComplete: claimed, independentlyVerified: verified,
        counts: { ...counts, observations: device.observationCount() }, receipts, retryable: false,
        ...(status === 'stopped' ? { escalation: escalation(code) } : {}) });
    let result;
    try {
        trace = await traceStore.open({ schemaVersion: 1, taskId: task.taskId, serial: task.serial, package: task.package,
            intent: 'ui_task', decision: 'jev', policyVersion: POLICY.version, completionPolicyVersion: POLICY.completionVersion,
            inputRefs: Object.keys(task.inputs), budget: task.budget, allowedPackages: task.allowedPackages, operations: task.operations,
            assistance: task.assistance, goalSha256: hash(task.goal), contractSha256 });
        await device.preflight(task);
        sample = await observe();
        for (let round = 1; round <= task.budget.maxModelCalls; round++) {
            device.check();
            // Readiness is observable host state, not a model decision. Each
            // window consumes the original observation/deadline budgets only.
            // A matched target can be verified before background loading ends.
            while (!pageSettled || sample.ui.loading && !sample.ui.completion?.matched) {
                device.check();
                if (device.remainingMs() < POLICY.minSampleBudgetMs) throw fail('TASK_WAIT_TIMEOUT');
                const reason = sample.ui.loading && !sample.ui.completion?.matched ? 'loading' : 'page_unsettled';
                const next = await settle(sample, false, true);
                await append({ type: 'wait', source: 'host', reason, observationId: sample.observation.id,
                    changed: next.ui.pageDigest !== sample.ui.pageDigest });
                sample = next;
            }
            const candidates = pageSettled ? candidatesFor(task, sample, excluded)
                .filter(c => c.action.command === 'Done' || !sample.ui.loading && counts.actions < task.budget.maxActions) : [];
            lastCandidates = candidates; candidateObservationId = sample.observation.id;
            await append({ type: 'candidates', observationId: sample.observation.id, round,
                candidates: candidates.map(({ candidateId, action }) => ({ candidateId, action })), excludedCount: excluded.size });
            const space = questionsFor(task, sample, candidates), questions = space.questions;
            const state = { intent: 'ui_task', goal: task.goal, package: sample.package, observationId: sample.observation.id,
                semanticsVersion: POLICY.semanticsVersion, ...modelElements(sample.ui.nodes), inputs: task.inputs,
                candidates: candidates.map(({ candidateId, action }) => ({ candidateId, action })),
                recentActions: history, pageSettled, loading: { declared: Boolean(task.loading), active: sample.ui.loading === true },
                hostCompletionMatched: sample.ui.completion?.matched ?? null,
                requirements: task.completion?.all.map((condition, i) => ({ condition, satisfied: sample.ui.completion?.checks[i] === true })) ?? null,
                remaining: { actions: task.budget.maxActions - counts.actions, modelCalls: task.budget.maxModelCalls - counts.modelCalls,
                    timeoutMs: Math.max(0, Math.floor(device.remainingMs())) } };
            if (Buffer.byteLength(JSON.stringify({ state, questions })) > 150000) throw fail('TASK_CANDIDATE_OVERFLOW');
            counts.modelCalls++;
            const m = await requestTaskModel(jev, device, state, questions);
            await append({ type: 'model', observationId: sample.observation.id, modelCalls: counts.modelCalls,
                modelEvidence: m.evidence, ...(m.failure ? { code: safeCode(m.failure) } : {}) });
            if (m.failure) throw m.failure;
            let decision, assistanceReason;
            try { decision = select(m.response, space, candidates); }
            catch (e) {
                await append({ type: 'decision', observationId: sample.observation.id, choice: 'invalid', code: safeCode(e),
                    ...(Number.isFinite(e.probability) ? { probability: e.probability, margin: e.margin } : {}),
                    ...(e.heads ? { heads: e.heads } : {}) });
                if (e.code !== 'TASK_JEV_UNCERTAIN' || !assist) throw e;
                assistanceReason = e.code;
            }
            if (decision) {
                await append({ type: 'decision', observationId: sample.observation.id, ...decision });
                if (decision.choice === 'escalate') assistanceReason = 'TASK_ESCALATION_REQUIRED';
            }
            if (assistanceReason) {
                if (!assist || !canAssist(assistanceReason)) throw fail(assistanceReason);
                const advice = await assist({ reason: assistanceReason, sample, candidates });
                const fresh = await observe();
                revalidateAssistance(sample, fresh);
                if (advice.action === 'reobserve') { sample = fresh; pageSettled = false; continue; }
                if (!same(sample, fresh)) {
                    await recover('observation_stale', sample); sample = fresh; pageSettled = false; continue;
                }
                sample = fresh; decision = { choice: advice.candidateId };
            }
            if (decision.choice === 'wait') {
                const next = await settle(sample);
                await append({ type: 'wait', source: 'model', reason: 'model_requested',
                    observationId: sample.observation.id, changed: next.ui.pageDigest !== sample.ui.pageDigest });
                sample = next; continue;
            }
            const selected = candidates.find(c => c.candidateId === decision.choice), action = selected.action;
            const fresh = await observe();
            if (fresh.observation.contextDigest !== sample.observation.contextDigest) throw fail('TASK_CONTEXT_UNPROVEN');
            // Done with a host checker authorizes only fresh read verification,
            // never a write. Page-content drift does not invalidate that read;
            // the unchanged final predicate and stability window decide it.
            if (!same(sample, fresh) && !(action.command === 'Done' && task.completion)) {
                await recover('observation_stale', sample); pageSettled = false; sample = fresh; continue;
            }
            sample = fresh;
            if (action.command === 'Done') {
                claimed = true;
                if (!task.completion) {
                    await append({ type: 'completed', outcome: 'unverified' });
                    result = summary('unverified', 'TASK_MODEL_COMPLETION_UNVERIFIED'); break;
                }
                const final = await settle(sample, true);
                await append({ type: 'verification', observationId: final.observation.id, matched: true });
                await append({ type: 'completed', outcome: 'verified' });
                verified = true; result = summary('completed', null); break;
            }
            if (counts.actions >= task.budget.maxActions) throw fail('TASK_BUDGET_EXHAUSTED');
            counts.actions++; counts.actionAttempts++;
            await append({ type: 'action', phase: 'prepared', action });
            let receipt;
            try { receipt = (await device.execute(task, action, null, sample)).execution; }
            catch (e) {
                const r = { type: 'action', phase: 'settled', action, requestId: e.execution?.requestId,
                    outcome: e.execution?.outcome ?? 'unknown', code: safeCode(e) };
                receipts.push(r);
                if (r.requestId) await append(r);
                if (device.isUndispatchedStale?.(e) && r.outcome === 'failed') {
                    counts.actions--; await recover('dispatch_stale', sample); sample = await observe(); continue;
                }
                throw e;
            }
            const r = { type: 'action', phase: 'settled', action, requestId: receipt.requestId, outcome: receipt.outcome };
            receipts.push(r); await append(r);
            if (!['verified', 'dispatched'].includes(receipt.outcome)) throw fail('TASK_ACTION_UNVERIFIED');
            if (receipt.outcome === 'verified') counts.verifiedActions++;
            const after = await settle(sample);
            const changed = after.ui.pageDigest !== sample.ui.pageDigest;
            await append({ type: 'effect', requestId: receipt.requestId, changed, pageDigest: after.ui.pageDigest });
            // Keep exact attempts excluded on every previously seen page; cycling
            // back to a page cannot erase a duplicate-write guard.
            excluded.add(signature(sample, action));
            const target = sample.ui.nodes.find(n => n.nodeRef === action.nodeRef);
            history.push({ action, label: target?.label || '', changed, dispatchOutcome: receipt.outcome });
            if (history.length > POLICY.maxRecent) history.shift();
            consecutiveStale = 0; sample = after;
        }
        if (!result) throw fail('TASK_LOOP_LIMIT');
    } catch (e) {
        result = summary('stopped', safeCode(e));
        if (trace) {
            try { await append({ type: 'escalation', code: result.code, remaining: remaining(),
                ...(sample ? { observationId: sample.observation.id } : {}) }); }
            catch (failure) { result = summary('stopped', safeCode(failure)); }
            // Even a full ordinary-event budget must retain its terminal slot.
            try { await append({ type: 'stopped', code: result.code,
                outcome: receipts.some(r => r.outcome !== 'failed') ? 'unknown' : 'failed' }); }
            catch { result = summary('stopped', 'TASK_TRACE_FAILED'); }
        }
    } finally {
        if (trace) try { await trace.close(); } catch { result = summary('stopped', 'TASK_TRACE_FAILED'); }
    }
    return result;
}
module.exports = { run, candidatesFor, POLICY };
