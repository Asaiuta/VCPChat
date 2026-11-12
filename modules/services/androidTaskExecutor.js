'use strict';

const { randomUUID } = require('node:crypto');
const searchIntent = require('./androidSearchLoop');
const { object } = require('./androidTaskInput');
const toggleIntent = require('./androidToggleLoop');
const routeIntent = require('./androidRouteLoop');
const { waitForIdle } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/idle-wait');
const { CONTEXT_DIFF_TOKENS } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/context');
const { MAX_ACTION_ATTEMPTS } = require('./androidTaskBudget');
const { escalationDisposition } = require('./androidTaskPolicy');
const { samplingExpired } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/sampling-deadline');
const { modelRejection } = require('./androidJevEvidence');

const INTENTS = Object.freeze({ search: searchIntent, set_toggle: toggleIntent, route_search: routeIntent });
const prepared = new WeakSet();
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SETTLE_TIMEOUT_MS = 5000;
const fail = code => Object.assign(new Error(`Android task stopped: ${code}`), { code });
// Only closed-vocabulary dimension names cross into trace/receipt; anything else is dropped.
const contextDiffOf = value => Array.isArray(value) && value.length > 0 && value.length <= CONTEXT_DIFF_TOKENS.length
    && value.every(token => CONTEXT_DIFF_TOKENS.includes(token)) ? CONTEXT_DIFF_TOKENS.filter(token => value.includes(token)) : undefined;
const withContextDiff = (error, source) => {
    const contextDiff = contextDiffOf(source?.contextDiff);
    return contextDiff ? Object.assign(error, { contextDiff }) : error;
};

function prepareTask(value) {
    const task = object(value, ['serial', 'package', 'intent', 'inputs', 'targets', 'completion', 'budget', 'decision', 'loading', 'assistance', 'searchActions', 'goal', 'allowedPackages', 'operations', 'longPressMs']);
    if (typeof task.serial !== 'string' || !SERIAL.test(task.serial)
        || typeof task.package !== 'string' || task.package.length > 200 || !PACKAGE.test(task.package)
        || !['search', 'set_toggle', 'route_search', 'ui_task'].includes(task.intent) || !['rules', 'shadow', 'jev'].includes(task.decision ?? 'rules')) throw fail('TASK_INVALID');
    const decision = task.decision ?? 'rules';
    const assistance = task.assistance ?? 'none';
    if (!['none', 'main_agent', 'human'].includes(assistance) || decision !== 'jev' && assistance !== 'none') throw fail('TASK_INVALID');
    const spec = { ...task, decision, assistance };
    if (task.intent === 'ui_task' ? ['targets', 'searchActions'].some(k => Object.hasOwn(task, k))
        : ['goal', 'allowedPackages', 'operations', 'longPressMs'].some(k => Object.hasOwn(task, k))) throw fail('TASK_INVALID');
    const result = Object.freeze({ ...spec, ...(task.intent === 'ui_task' ? require('./androidUiTaskContract').prepare(spec) : INTENTS[task.intent].prepare(spec)), taskId: randomUUID() });
    prepared.add(result);
    return result;
}

function createAndroidTaskExecutor({ traceStore, jev = null } = {}) {
    async function run(task, device, services = {}) {
        if (!prepared.delete(task)) throw fail('TASK_INVALID');
        if (task.intent === 'ui_task') return require('./androidUiTaskLoop').run(task, device, { jev, traceStore, services });
        const toggle = task.intent === 'set_toggle';
        const route = task.intent === 'route_search';
        const intent = INTENTS[task.intent];
        const policy = intent.POLICY;
        const completionPolicy = policy.completionVersion;
        const inputRefs = intent.REFS;
        const routeScope = route ? { ...task.targets, completion: task.completion.id } : null;
        const counts = { actions: 0, modelCalls: 0, mainModelCalls: 0 };
        if (task.decision === 'jev') Object.assign(counts, { actionAttempts: 0, verifiedActions: 0, staleEvents: 0 });
        if (task.assistance !== 'none') Object.assign(counts, { humanHandoffs: 0, mainModelRequests: 0 });
        const receipts = [];
        let trace;
        let step = intent.initialStep;
        let completionDeadlineMs;
        let lastObservation = null, lastCandidates = null, lastLoadingEvidence = null;
        let loopState = { rounds: 0, waits: 0, consecutiveStale: 0 };
        const check = () => device.check();
        const append = async event => {
            try { await trace.append(event); }
            catch (error) { throw fail(error.code === 'TRACE_LIMIT' ? 'TASK_TRACE_LIMIT' : 'TASK_TRACE_FAILED'); }
            if (event.type === 'observation') {
                lastObservation = { ...event.observation };
                lastLoadingEvidence = event.loading ? { ...event.loading } : null;
            }
            if (event.type === 'candidates') lastCandidates = { step: event.step, observationId: event.observation.id,
                decisionContext: structuredClone(event.decisionContext),
                items: event.candidates.map(item => ({ ...item, evidenceSources: [...item.evidenceSources] })) };
        };
        const take = (key, max) => {
            check();
            if (counts[key] >= max) throw fail('TASK_BUDGET_EXHAUSTED');
            counts[key]++;
        };
        const observe = async options => {
            check();
            const sample = await device.observe(task, options);
            check();
            if (!sample.complete || sample.package !== task.package || sample.displayId !== 0) throw fail('TASK_CONTEXT_UNPROVEN');
            const contextDiff = contextDiffOf(sample.contextDiff);
            if ((toggle || route) && (contextDiff || lastObservation && lastObservation.contextDigest !== sample.observation.contextDigest)) {
                throw withContextDiff(fail('TASK_CONTEXT_UNPROVEN'), sample);
            }
            const evidence = sample.completion;
            await append({ type: 'observation', step, observation: sample.observation, ...(contextDiff ? { contextDiff } : {}),
                ...(sample.loading ? { loading: { matches: sample.loading.matches, visible: sample.loading.visible, safe: sample.loading.safe } } : {}),
                // Per-sample predicate evidence separates late results from a page that never holds still.
                ...(toggle ? { toggle: sample.toggle } : {}),
                ...(route ? { route: sample.route } : {}),
                ...(step === 'complete' ? { matched: completed(sample) === true, ...(toggle || route ? {} : { completion: { present: evidence.present === true,
                    containers: evidence.containers, items: evidence.items, inputMatched: evidence.inputMatched === true,
                    absent: evidence.absent === true } }) } : {}) });
            return sample;
        };
        // Reuse M2's bounded sampler, with the stricter full task digest (including text).
        // Missing targets may appear during loading; ambiguous/unsafe targets still stop.
        const settle = async (ready = () => true, timeoutCode = 'TASK_PAGE_UNSETTLED', deadlineMs = Date.now() + SETTLE_TIMEOUT_MS) => {
            check();
            const timeoutMs = Math.floor(Math.min(SETTLE_TIMEOUT_MS, deadlineMs - Date.now()));
            if (timeoutMs <= 0) throw fail(timeoutCode);
            let latest;
            let missing = false;
            const result = await waitForIdle({ timeoutMs,
                runtime: { check, pause: device.pause,
                    remainingMs: () => Math.min(device.remainingMs(), deadlineMs - Date.now()), executionSignal: () => device.signal },
                sample: async request => {
                    try { latest = await observe(request); }
                    catch (error) {
                        check();
                        // The sampler's deadline can expire during capture setup.
                        // Keep this wait's failure contract; transport/unknown RPC
                        // failures and task cancellation still propagate unchanged.
                        if (!samplingExpired(error, request.deadlineMs)) throw error;
                        return { complete: false, digest: '', context: null };
                    }
                    let valid;
                    missing = false;
                    try { valid = ready(latest) !== false; }
                    catch (error) {
                        if (error.code !== 'TASK_TARGET_MISSING') throw error;
                        missing = true;
                        valid = false;
                    }
                    return { complete: valid, digest: latest.observation.digest, context: latest.observation.contextDigest };
                } });
            if (!result.matched) throw fail(missing ? 'TASK_TARGET_MISSING' : timeoutCode);
            return latest;
        };
        const completed = sample => intent.completed(task, sample);
        const target = (sample, id, role) => {
            const matches = sample.controls.filter(node => node.id === id);
            if (matches.length !== 1) throw fail(matches.length ? 'TASK_TARGET_AMBIGUOUS' : 'TASK_TARGET_MISSING');
            const node = matches[0];
            if (!node.enabled || !node.inViewport || node.password || (role === 'field' ? node.role !== 'textfield'
                : role === 'scroll' ? !node.scrollable : !node.clickable)) {
                throw fail('TASK_TARGET_UNSAFE');
            }
            return node;
        };
        const model = async (state, questions, sample) => {
            if (typeof jev?.decide !== 'function') throw fail('TASK_JEV_UNAVAILABLE');
            take('modelCalls', task.budget.maxModelCalls);
            const { response, failure, evidence } = await require('./androidTaskModel').requestTaskModel(jev, device, state, questions);
            await append({ type: 'model', step, source: task.decision, modelCalls: counts.modelCalls,
                observation: sample.observation, modelEvidence: evidence,
                ...(failure ? { code: CODE.test(failure.code || '') ? failure.code : 'TASK_JEV_UNAVAILABLE',
                    rejectionReason: modelRejection(failure.code) } : {}) });
            if (failure) throw failure;
            return response;
        };
        const shadow = async (sample, node) => {
            if (task.decision !== 'shadow') return;
            const response = await model({ intent: task.intent, step, completedActions: counts.actions,
                package: task.package, candidates: [{ id: 'c0', resourceId: node.id, role: node.role }] },
            { target: { type: 'choice', criteria: { c0: 'Declared current task target', none: 'Insufficient evidence' },
                instructions: 'Shadow evaluation only. Select a candidate, never generate actions or infer business success.' } }, sample);
            const probabilities = response?.answers?.target?.probabilities;
            const valid = probabilities && Object.keys(probabilities).length === 2
                && ['c0', 'none'].every(key => Number.isFinite(probabilities[key]) && probabilities[key] >= 0 && probabilities[key] <= 1)
                && Math.abs(probabilities.c0 + probabilities.none - 1) <= 0.02;
            const choice = !valid ? 'invalid' : probabilities.c0 > probabilities.none ? 'c0' : 'none';
            await append({ type: 'decision', step, source: 'shadow', targetId: node.id, choice, modelCalls: counts.modelCalls,
                ...(!valid ? { rejectionReason: 'invalid_distribution' } : {}) });
            // Model latency cannot renew evidence. Re-observe before any rule-authorized action.
            const fresh = await observe();
            if (fresh.observation.contextDigest !== sample.observation.contextDigest
                || fresh.observation.digest !== sample.observation.digest) throw fail('TASK_OBSERVATION_CHANGED');
        };
        const act = async (sample, id, command, expect, verifyAfter, ready, parameters) => {
            const inputRef = command === 'Fill' ? route ? parameters?.inputRef : 'query' : null;
            if (route && command === 'Fill' && (!routeIntent.REFS.includes(inputRef) || task.targets[inputRef] !== id)) throw fail('TASK_ACTION_UNSUPPORTED');
            if (command === 'KeyEvent' && (!sample.searchActionEvidence?.back?.sourceSafe
                || sample.searchActionEvidence.back.targetMatches !== 0)) throw fail('TASK_NAVIGATION_UNSAFE');
            const node = command === 'KeyEvent' ? { id } : target(sample, id, command === 'Fill' || command === 'ImeAction' || step === 'focus' ? 'field'
                : ['Scroll', 'ScrollUntil'].includes(command) ? 'scroll' : 'button');
            await shadow(sample, node);
            take('actions', task.budget.maxActions);
            if (task.decision === 'jev') counts.actionAttempts++;
            for (let attempt = 1; attempt <= MAX_ACTION_ATTEMPTS; attempt++) {
                if (task.decision !== 'jev') await append({ type: 'decision', step, source: 'rule', targetId: id, ...(command === 'Fill' ? { inputRef: 'query' } : {}) });
                await append({ type: 'action', step, phase: 'prepared', targetId: id,
                    ...(task.decision === 'jev' ? { attempts: counts.actionAttempts, modelCalls: counts.modelCalls } : {}),
                    ...(expect ? { expectId: expect.selector.slice(3) } : command === 'Fill' ? { inputRef } : {}) });
                check();
                let result;
                try {
                    // Start once per submit attempt, before the last dispatch checks.
                    // Container visibility and full completion consume this same window.
                    const verification = step === 'route_fill' ? { verificationDeadlineMs: Date.now() + Math.min(SETTLE_TIMEOUT_MS, device.remainingMs()) }
                        : step === 'submit' || step === 'toggle' || step === 'route_submit'
                        ? { verificationDeadlineMs: completionDeadlineMs = Date.now() + Math.min(SETTLE_TIMEOUT_MS, device.remainingMs()) } : undefined;
                    const action = command === 'KeyEvent' ? { command, key: 'back' } : command === 'ScrollUntil' ? { command, container: `id=${id}`, target: `id=${parameters.revealId}`,
                        direction: parameters.direction, strategy: 'host', maxSwipes: 1 }
                        : { command, id, ...(command === 'Fill' ? { text: task.inputs[inputRef] } : {}),
                            ...(command === 'Scroll' ? { direction: parameters.direction, distance: 0.6, duration: 300 } : {}),
                            ...(command === 'ImeAction' ? { imeAction: parameters.imeAction } : {}) };
                    result = await device.execute(task, action, expect, sample, verifyAfter, verification);
                } catch (error) {
                    const execution = error.execution;
                    const receipt = { type: 'action', step, phase: 'settled', targetId: id,
                        ...(route && inputRef ? { inputRef } : {}),
                        outcome: execution?.outcome || 'failed', ...(execution?.requestId ? { requestId: execution.requestId } : {}),
                        code: CODE.test(error.code || '') ? error.code : 'TASK_ACTION_FAILED' };
                    receipts.push(receipt);
                    await append(receipt);
                    if (task.decision === 'jev' && device.isUndispatchedStale?.(error) === true) {
                        // Preserve the failed attempt receipt, but a proved zero-write
                        // attempt does not consume the action allowance or progress.
                        counts.actions--;
                        return { stale: true, requestId: execution.requestId };
                    }
                    // Only a failed child receipt proves that this attempt never dispatched.
                    // Prior verified actions stay committed; no unknown write may be replayed.
                    if (task.decision === 'rules' && ready && attempt < MAX_ACTION_ATTEMPTS
                        && error.code === 'TASK_OBSERVATION_CHANGED' && execution?.outcome === 'failed') {
                        sample = await settle(ready);
                        continue;
                    }
                    throw withContextDiff(fail(receipt.code), error);
                }
                const receipt = { type: 'action', step, phase: 'settled', targetId: id,
                    ...(route && inputRef ? { inputRef } : {}),
                    requestId: result.execution.requestId, outcome: result.execution.outcome,
                    ...(result.execution.verification?.scrollProof ? { scrollProof: result.execution.verification.scrollProof } : {}) };
                receipts.push(receipt);
                await append(receipt);
                check();
                if (receipt.outcome !== 'verified') {
                    const code = result.execution.verification?.error;
                    throw fail(CODE.test(code || '') ? code : 'TASK_ACTION_UNVERIFIED');
                }
                if (task.decision === 'jev') counts.verifiedActions++;
                return receipt.scrollProof ? { scrollProof: receipt.scrollProof } : undefined;
            }
        };
        const remainingTime = () => {
            // Runtime budget reads may throw after cancellation/deadline. Reporting
            // a stop must not call back into execution or hide the original receipt.
            try { return Math.max(0, Math.min(task.budget.timeoutMs, Math.floor((device.remainingTaskMs || device.remainingMs)()))); }
            catch { return 0; }
        };
        const remainingBudget = () => ({ timeoutMs: remainingTime(),
            actions: Math.max(0, task.budget.maxActions - counts.actions),
            observations: Math.max(0, task.budget.maxObservations - device.observationCount()),
            modelCalls: Math.max(0, task.budget.maxModelCalls - counts.modelCalls),
            rounds: Math.max(0, policy.maxRounds - loopState.rounds), waits: Math.max(0, policy.maxWaits - loopState.waits) });
        const summary = (status, code, contextDiff) => ({ schemaVersion: 1, taskId: task.taskId, serial: task.serial, package: task.package,
            intent: task.intent, status, code, ...(contextDiff ? { contextDiff: [...contextDiff] } : {}),
            completionPolicyVersion: completionPolicy, assistance: task.assistance,
            counts: { ...counts, observations: device.observationCount() },
            ...(task.decision === 'jev' ? { decision: 'jev', experimental: true, decisionPolicy: policy } : {}),
            receipts: receipts.map(item => ({ ...item })), retryable: false,
            ...(task.decision === 'jev' && status === 'stopped' ? { escalation: {
                schemaVersion: 1, taskId: task.taskId, step, reason: code, contextDiff: contextDiff ? [...contextDiff] : [],
                disposition: escalationDisposition(code, receipts),
                continuation: 'not_authorized', evidenceFreshness: 'historical', intent: task.intent, inputRefs: [...inputRefs],
                decisionPolicyVersion: policy.version, completionPolicyVersion: completionPolicy, budget: { ...task.budget },
                scope: { serial: task.serial, package: task.package, displayId: 0, commands: ['Tap', ...(toggle ? [] : ['Fill']),
                    ...(task.searchActions?.scroll ? [task.searchActions.scroll.command] : []),
                    ...(task.searchActions?.imeAction ? ['ImeAction'] : []),
                    ...(task.searchActions?.back ? ['KeyEvent'] : [])], policy: 'recheck_required' },
                ...(task.searchActions ? { searchActions: structuredClone(task.searchActions) } : {}),
                ...(route ? { route: { ...routeScope } } : {}),
                completion: { ...task.completion }, loading: task.loading ? { ...task.loading } : null,
                progress: { ...loopState, verifiedReceiptIndexes: receipts.flatMap((r, i) => r.outcome === 'verified' ? [i] : []) },
                counts: { ...counts, observations: device.observationCount() },
                remaining: remainingBudget(),
                observation: lastObservation ? { ...lastObservation } : null,
                loadingEvidence: lastLoadingEvidence ? { ...lastLoadingEvidence } : null,
                candidateStep: lastCandidates?.step || null,
                candidateObservationId: lastCandidates?.observationId || null,
                decisionContext: lastCandidates ? structuredClone(lastCandidates.decisionContext) : null,
                candidates: lastCandidates?.items.map(c => ({ ...c, evidenceSources: [...c.evidenceSources] })) || [],
                receipts: receipts.map(r => ({ ...r })),
            } } : {}) });
        const assist = require('./androidTaskAssistance').createTaskAssistance({ task, device, services, counts, append,
            eventIdentity: sample => ({ step, observation: sample.observation }),
            evidence: reason => summary('stopped', reason).escalation });
        let result;
        try {
            check();
            try { trace = await traceStore.open({ schemaVersion: 1, taskId: task.taskId, serial: task.serial, package: task.package,
                intent: task.intent, inputRefs: [...inputRefs], budget: task.budget,
                completionPolicyVersion: completionPolicy,
                ...(toggle ? { toggle: { id: task.targets.toggle, checked: task.inputs.checked } } : {}),
                ...(route ? { route: { ...routeScope } } : {}),
                ...(task.assistance !== 'none' ? { assistance: task.assistance } : {}),
                ...(task.loading ? { loading: { ...task.loading } } : {}),
                ...(task.searchActions ? { searchActions: structuredClone(task.searchActions) } : {}),
                ...(task.decision === 'jev' ? { decision: 'jev', policyVersion: policy.version } : {}) }); }
            catch { throw fail('TASK_TRACE_FAILED'); }
            if (!toggle && !route && task.decision === 'jev' && typeof jev?.decide !== 'function') throw fail('TASK_JEV_UNAVAILABLE');
            await device.preflight(task);
            check();
            await intent.run(task, { observe, settle, target, model, act, append, setStep: value => { step = value; },
                pause: device.pause, completedActions: () => counts.verifiedActions,
                check, assist, remainingBudget, remainingMs: device.remainingMs, onState: value => { loopState = value; },
                onStale: () => { counts.staleEvents++; } });
            step = 'complete';
            const sample = await settle(completed, 'TASK_COMPLETION_UNPROVEN', completionDeadlineMs);
            const matched = completed(sample);
            await append({ type: 'verification', step, matched, targetId: task.completion.id, observation: sample.observation });
            if (!matched) throw fail('TASK_COMPLETION_UNPROVEN');
            await append({ type: 'completed', step, outcome: 'verified' });
            check();
            result = summary('completed', null);
        } catch (error) {
            const code = CODE.test(error.code || '') ? error.code : 'TASK_FAILED';
            const contextDiff = contextDiffOf(error.contextDiff);
            result = summary('stopped', code, contextDiff);
            if (trace && code !== 'TASK_TRACE_FAILED') {
                if (result.escalation) {
                    try { await append({ type: 'escalation', step, escalation: result.escalation }); }
                    catch (error) { result = summary('stopped', error.code, contextDiff); }
                }
                try { await append({ type: 'stopped', step, code: result.code, ...(contextDiff ? { contextDiff } : {}),
                    outcome: receipts.some(r => r.outcome !== 'failed') ? 'unknown' : 'failed' }); }
                catch { result = summary('stopped', 'TASK_TRACE_FAILED'); }
            }
        } finally {
            if (trace) {
                try { await trace.close(); }
                catch { result = summary('stopped', 'TASK_TRACE_FAILED'); }
            }
        }
        return result;
    }
    return Object.freeze({ prepare: prepareTask, run });
}

module.exports = { createAndroidTaskExecutor, prepareTask };
