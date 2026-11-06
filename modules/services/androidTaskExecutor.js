'use strict';

const { randomUUID } = require('node:crypto');
const { POLICY, runSearchLoop } = require('./androidSearchLoop');
const { waitForIdle } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/idle-wait');
const { CONTEXT_DIFF_TOKENS } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/context');
const { LIMITS, MAX_ACTION_ATTEMPTS } = require('./androidTaskBudget');

const prepared = new WeakSet();
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SETTLE_TIMEOUT_MS = 5000;
const COMPLETION_POLICY_VERSION = 'search-completion-v2';
const fail = code => Object.assign(new Error(`Android task stopped: ${code}`), { code });
// Only closed-vocabulary dimension names cross into trace/receipt; anything else is dropped.
const contextDiffOf = value => Array.isArray(value) && value.length > 0 && value.length <= CONTEXT_DIFF_TOKENS.length
    && value.every(token => CONTEXT_DIFF_TOKENS.includes(token)) ? CONTEXT_DIFF_TOKENS.filter(token => value.includes(token)) : undefined;
const withContextDiff = (error, source) => {
    const contextDiff = contextDiffOf(source?.contextDiff);
    return contextDiff ? Object.assign(error, { contextDiff }) : error;
};

// Copy only JSON data properties. Never evaluate caller accessors or retain mutable input.
function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('TASK_INVALID');
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptor, 'value')) throw fail('TASK_INVALID');
        result[key] = descriptor.value;
    }
    return result;
}

function integer(value, fallback, min, max) {
    const number = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(number) || number < min || number > max) throw fail('TASK_INVALID');
    return number;
}

function prepareTask(value) {
    const task = object(value, ['serial', 'package', 'intent', 'inputs', 'targets', 'completion', 'budget', 'decision']);
    if (typeof task.serial !== 'string' || !SERIAL.test(task.serial)
        || typeof task.package !== 'string' || task.package.length > 200 || !PACKAGE.test(task.package)
        || task.intent !== 'search' || !['rules', 'shadow', 'jev'].includes(task.decision ?? 'rules')) throw fail('TASK_INVALID');
    const decision = task.decision ?? 'rules';
    const inputs = object(task.inputs, ['query']);
    if (typeof inputs.query !== 'string' || !inputs.query.trim() || inputs.query.length > 2000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(inputs.query)) throw fail('TASK_INVALID');
    const id = value => {
        if (typeof value !== 'string' || value.length > 320 || !value.startsWith(`${task.package}:id/`)
            || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(task.package.length + 4))) throw fail('TASK_INVALID');
        return value;
    };
    let targets;
    if (decision === 'jev') {
        if (task.targets !== undefined) throw fail('TASK_INVALID');
    } else {
        targets = object(task.targets, ['entry', 'field', 'submit']);
        targets.field = id(targets.field);
        targets.submit = id(targets.submit);
        if (targets.entry !== undefined) targets.entry = id(targets.entry);
    }
    const completion = object(task.completion, ['type', 'id', 'item', 'minItems', 'absent', 'itemMatchesInput']);
    if (completion.type !== 'visible') throw fail('TASK_INVALID');
    completion.id = id(completion.id);
    if (completion.absent !== undefined) completion.absent = id(completion.absent);
    if (completion.item !== undefined) {
        completion.item = id(completion.item);
        completion.minItems = integer(completion.minItems, 1, 1, 50);
        if (completion.itemMatchesInput !== undefined && typeof completion.itemMatchesInput !== 'boolean') throw fail('TASK_INVALID');
    } else if (completion.minItems !== undefined || completion.itemMatchesInput !== undefined) throw fail('TASK_INVALID');
    // A disappeared input is valid evidence; a positive marker cannot also be absent.
    const ids = [...Object.values(targets || {}), completion.id, completion.item].filter(Boolean);
    if (new Set(ids).size !== ids.length || completion.absent !== undefined
        && [completion.id, completion.item].includes(completion.absent)) throw fail('TASK_INVALID');
    const rawBudget = object(task.budget ?? {}, ['timeoutMs', 'maxActions', 'maxObservations', 'maxModelCalls']);
    const budget = Object.freeze({
        timeoutMs: integer(rawBudget.timeoutMs, 60000, 1, LIMITS.timeoutMs),
        maxActions: integer(rawBudget.maxActions, decision === 'jev' ? 6 : targets.entry ? 3 : 2, 1, LIMITS.maxActions),
        maxObservations: integer(rawBudget.maxObservations, decision === 'jev' ? 96 : 64, 1, LIMITS.maxObservations),
        maxModelCalls: integer(rawBudget.maxModelCalls, decision === 'jev' ? 8 : decision === 'shadow' ? 3 : 0, 0, LIMITS.maxModelCalls),
    });
    if (budget.maxActions < (targets?.entry ? 3 : 2) || budget.maxObservations < (targets?.entry ? 12 : 8) + (decision !== 'rules' ? (targets?.entry ? 3 : 2) : 0)
        || (decision !== 'rules' && budget.maxModelCalls < (targets?.entry ? 3 : 2))) throw fail('TASK_BUDGET_INSUFFICIENT');
    const result = Object.freeze({ ...task, taskId: randomUUID(), decision,
        inputs: Object.freeze(inputs), targets: Object.freeze(targets), completion: Object.freeze(completion), budget });
    prepared.add(result);
    return result;
}

function createAndroidTaskExecutor({ traceStore, jev = null } = {}) {
    async function run(task, device) {
        if (!prepared.delete(task)) throw fail('TASK_INVALID');
        const counts = { actions: 0, modelCalls: 0, mainModelCalls: 0 };
        const receipts = [];
        let trace;
        let step = 'entry';
        let completionDeadlineMs;
        const check = () => device.check();
        const append = async event => {
            try { await trace.append(event); }
            catch (error) { throw fail(error.code === 'TRACE_LIMIT' ? 'TASK_TRACE_LIMIT' : 'TASK_TRACE_FAILED'); }
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
            const evidence = sample.completion;
            await append({ type: 'observation', step, observation: sample.observation, ...(contextDiff ? { contextDiff } : {}),
                // Per-sample predicate evidence separates late results from a page that never holds still.
                ...(step === 'complete' ? { matched: completed(sample) === true, completion: { present: evidence.present === true,
                    containers: evidence.containers, items: evidence.items, inputMatched: evidence.inputMatched === true,
                    absent: evidence.absent === true } } : {}) });
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
                    latest = await observe(request);
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
        const completed = sample => {
            const evidence = sample.completion;
            const { item, minItems, itemMatchesInput } = task.completion;
            return evidence?.containers === 1 && evidence.absent
                && (!item || evidence.items >= minItems && (!itemMatchesInput || evidence.inputMatched));
        };
        // All decision modes use raw completion evidence, including labels folded
        // out of the action graph. An empty item container is not old success.
        const hasPreexistingCompletion = sample => task.completion.item ? completed(sample) : sample.completion.present;
        const noOldResult = sample => {
            if (hasPreexistingCompletion(sample)) throw fail('TASK_COMPLETION_PREEXISTS');
        };
        const target = (sample, id, role) => {
            const matches = sample.controls.filter(node => node.id === id);
            if (matches.length !== 1) throw fail(matches.length ? 'TASK_TARGET_AMBIGUOUS' : 'TASK_TARGET_MISSING');
            const node = matches[0];
            if (!node.enabled || !node.inViewport || node.password || (role === 'field' ? node.role !== 'textfield' : !node.clickable)) {
                throw fail('TASK_TARGET_UNSAFE');
            }
            return node;
        };
        const model = async (state, questions) => {
            if (typeof jev?.decide !== 'function') throw fail('TASK_JEV_UNAVAILABLE');
            take('modelCalls', task.budget.maxModelCalls);
            const controller = new AbortController();
            const abort = () => controller.abort();
            device.signal.addEventListener('abort', abort, { once: true });
            if (device.signal.aborted) abort();
            const timer = setTimeout(abort, Math.min(2000, device.remainingMs()));
            let response;
            try {
                response = await jev.decide(state, questions,
                { timeoutMs: Math.min(2000, device.remainingMs()), maxRetries: 0, signal: controller.signal });
                check();
                if (controller.signal.aborted) throw fail('TASK_JEV_TIMEOUT');

            } catch (error) {
                check();
                throw fail(controller.signal.aborted || error.code === 'TASK_JEV_TIMEOUT' || error.code === 'TIMEOUT'
                    ? 'TASK_JEV_TIMEOUT' : 'TASK_JEV_UNAVAILABLE');
            } finally {
                clearTimeout(timer);
                device.signal.removeEventListener('abort', abort);
                controller.abort();
            }
            return response;
        };
        const shadow = async (sample, node) => {
            if (task.decision !== 'shadow') return;
            const response = await model({ intent: task.intent, step, completedActions: counts.actions,
                package: task.package, candidates: [{ id: 'c0', resourceId: node.id, role: node.role }] },
            { target: { type: 'choice', criteria: { c0: 'Declared current task target', none: 'Insufficient evidence' },
                instructions: 'Shadow evaluation only. Select a candidate, never generate actions or infer business success.' } });
            const probabilities = response?.answers?.target?.probabilities;
            const valid = probabilities && Object.keys(probabilities).length === 2
                && ['c0', 'none'].every(key => Number.isFinite(probabilities[key]) && probabilities[key] >= 0 && probabilities[key] <= 1)
                && Math.abs(probabilities.c0 + probabilities.none - 1) <= 0.02;
            const choice = !valid ? 'invalid' : probabilities.c0 > probabilities.none ? 'c0' : 'none';
            await append({ type: 'decision', step, source: 'shadow', targetId: node.id, choice, modelCalls: counts.modelCalls });
            // Model latency cannot renew evidence. Re-observe before any rule-authorized action.
            const fresh = await observe();
            if (fresh.observation.contextDigest !== sample.observation.contextDigest
                || fresh.observation.digest !== sample.observation.digest) throw fail('TASK_OBSERVATION_CHANGED');
        };
        const act = async (sample, id, command, expect, verifyAfter, ready) => {
            const node = target(sample, id, command === 'Fill' ? 'field' : 'button');
            await shadow(sample, node);
            take('actions', task.budget.maxActions);
            for (let attempt = 1; attempt <= MAX_ACTION_ATTEMPTS; attempt++) {
                if (task.decision !== 'jev') await append({ type: 'decision', step, source: 'rule', targetId: id, ...(command === 'Fill' ? { inputRef: 'query' } : {}) });
                await append({ type: 'action', step, phase: 'prepared', targetId: id,
                    ...(expect ? { expectId: expect.selector.slice(3) } : command === 'Fill' ? { inputRef: 'query' } : {}) });
                check();
                let result;
                try {
                    // Start once per submit attempt, before the last dispatch checks.
                    // Container visibility and full completion consume this same window.
                    const verification = step === 'submit'
                        ? { verificationDeadlineMs: completionDeadlineMs = Date.now() + Math.min(SETTLE_TIMEOUT_MS, device.remainingMs()) } : undefined;
                    result = await device.execute(task, { command, id, ...(command === 'Fill' ? { text: task.inputs.query } : {}) }, expect, sample, verifyAfter, verification);
                } catch (error) {
                    const execution = error.execution;
                    const receipt = { type: 'action', step, phase: 'settled', targetId: id,
                        outcome: execution?.outcome || 'failed', ...(execution?.requestId ? { requestId: execution.requestId } : {}),
                        code: CODE.test(error.code || '') ? error.code : 'TASK_ACTION_FAILED' };
                    receipts.push(receipt);
                    await append(receipt);
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
                    requestId: result.execution.requestId, outcome: result.execution.outcome };
                receipts.push(receipt);
                await append(receipt);
                check();
                if (receipt.outcome !== 'verified') {
                    const code = result.execution.verification?.error;
                    throw fail(CODE.test(code || '') ? code : 'TASK_ACTION_UNVERIFIED');
                }
                return;
            }
        };
        const runDeclaredSearch = async () => {
            const formReady = sample => {
                noOldResult(sample);
                target(sample, task.targets.field, 'field');
                target(sample, task.targets.submit, 'button');
            };
            const entryReady = sample => { noOldResult(sample); target(sample, task.targets.entry, 'button'); };
            let sample = await settle(sample => {
                noOldResult(sample);
                if (sample.controls.some(node => node.id === task.targets.field) || !task.targets.entry) formReady(sample);
                else entryReady(sample);
            });
            if (!sample.controls.some(node => node.id === task.targets.field)) {
                await act(sample, task.targets.entry, 'Tap', { type: 'visible', selector: `id=${task.targets.field}` }, undefined, entryReady);
                sample = await settle(formReady);
            }
            step = 'fill';
            await act(sample, task.targets.field, 'Fill', null, undefined, formReady);
            step = 'submit';
            sample = await settle(formReady);
            await act(sample, task.targets.submit, 'Tap', { type: 'visible', selector: `id=${task.completion.id}` }, undefined, formReady);
        };
        const summary = (status, code, contextDiff) => ({ schemaVersion: 1, taskId: task.taskId, serial: task.serial, package: task.package,
            intent: task.intent, status, code, ...(contextDiff ? { contextDiff: [...contextDiff] } : {}),
            completionPolicyVersion: COMPLETION_POLICY_VERSION,
            counts: { ...counts, observations: device.observationCount() },
            ...(task.decision === 'jev' ? { decision: 'jev', experimental: true, decisionPolicy: POLICY } : {}),
            receipts: receipts.map(item => ({ ...item })), retryable: false });
        let result;
        try {
            check();
            try { trace = await traceStore.open({ schemaVersion: 1, taskId: task.taskId, serial: task.serial, package: task.package,
                intent: task.intent, inputRefs: ['query'], budget: task.budget,
                completionPolicyVersion: COMPLETION_POLICY_VERSION,
                ...(task.decision === 'jev' ? { decision: 'jev', policyVersion: POLICY.version } : {}) }); }
            catch { throw fail('TASK_TRACE_FAILED'); }
            if (task.decision === 'jev' && typeof jev?.decide !== 'function') throw fail('TASK_JEV_UNAVAILABLE');
            await device.preflight(task);
            check();
            if (task.decision === 'jev') {
                await runSearchLoop(task, { observe, model, act, append, setStep: value => { step = value; },
                    pause: device.pause, completedActions: () => counts.actions, hasPreexistingCompletion });
            } else await runDeclaredSearch();
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
                try { await append({ type: 'stopped', step, code, ...(contextDiff ? { contextDiff } : {}),
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
