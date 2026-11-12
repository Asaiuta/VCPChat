'use strict';
const { object } = require('./androidTaskInput');
const { withOperationDeadline } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/operation-deadline');
const { modelEvidence } = require('./androidJevEvidence');
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const fail = code => Object.assign(new Error(code), { code });

// One bounded callback for every task family. The caller owns scope projection,
// fresh evidence validation and dispatch; this module never executes actions.
function createTaskAssistance({ task, device, services, counts, append, eventIdentity, evidence }) {
    return task.assistance === 'none' ? undefined : async ({ reason, sample, candidates }) => {
        device.check();
        const human = task.assistance === 'human';
        const callback = human ? device.handoff : services.androidTaskReplan;
        if (typeof callback !== 'function') throw fail('TASK_ASSISTANCE_UNAVAILABLE');
        const key = human ? 'humanHandoffs' : 'mainModelCalls';
        if (counts.mainModelCalls + counts.humanHandoffs >= 1) throw fail('TASK_ASSISTANCE_LIMIT');
        const timeoutMs = Math.min(human ? 60000 : 10000, device.remainingMs());
        const started = performance.now();
        let action = 'stop', candidateId, error, mainEvidence;
        try {
            const answer = await withOperationDeadline(timeoutMs, device.signal, async ({ signal, remainingMs }) => {
                await append({ type: 'assistance', ...eventIdentity(sample),
                    assistance: { mode: task.assistance, phase: 'started', action: 'pending', elapsedMs: 0 } });
                device.check();
                remainingMs();
                counts[key]++;
                // Historical packet is evidence only. The closure, same lease and
                // fresh observation checks authorize any subsequent local step.
                const packet = { schemaVersion: 1, taskId: task.taskId, observationId: sample.observation.id,
                    evidence: evidence(reason, sample, candidates) };
                if (!human) counts.mainModelRequests = null;
                return callback(packet, { signal, timeoutMs: remainingMs(), onModelMetadata: value => {
                    if (human) return;
                    counts.mainModelRequests = [0, 1].includes(value?.httpRequests) ? value.httpRequests : null;
                    mainEvidence = modelEvidence({ requestedModel: value?.requestedModel }, { model: value?.returnedModel,
                        usage: { input_tokens: value?.usage?.inputTokens, output_tokens: value?.usage?.outputTokens,
                            total_tokens: value?.usage?.totalTokens } }, Number.isSafeInteger(value?.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : 0);
                } });
            });
            device.check();
            if (human) {
                if (answer !== true) throw fail('TASK_HANDOFF_REJECTED');
                action = 'reobserve';
            } else {
                let advice;
                try { advice = object(answer, ['schemaVersion', 'taskId', 'observationId', 'action', 'candidateId']); }
                catch { throw fail('TASK_REPLAN_INVALID'); }
                if (advice.schemaVersion !== 1 || advice.taskId !== task.taskId || advice.observationId !== sample.observation.id
                    || !['select', 'reobserve', 'stop'].includes(advice.action)
                    || (advice.action === 'select' ? !candidates.some(c => c.candidateId === advice.candidateId) : advice.candidateId !== undefined)) {
                    throw fail('TASK_REPLAN_INVALID');
                }
                action = advice.action; candidateId = advice.candidateId;
                if (action === 'stop') throw fail('TASK_ASSISTANCE_STOPPED');
            }
        } catch (cause) {
            error = fail(cause.code === 'TIMEOUT' || cause.code === 'HUMAN_INTERACTION_CANCELLED' ? 'TASK_ASSISTANCE_TIMEOUT'
                : /^TASK_(?:REPLAN_INVALID|HANDOFF_REJECTED|ASSISTANCE_STOPPED|ASSISTANCE_UNAVAILABLE|TRACE_FAILED|TRACE_LIMIT)$/.test(cause.code || '')
                    ? cause.code : 'TASK_ASSISTANCE_FAILED');
            try { device.check(); } catch (boundary) { error = boundary; }
        }
        await append({ type: 'assistance', ...eventIdentity(sample),
            ...(!human ? { mainModelRequests: counts.mainModelRequests, ...(mainEvidence ? { modelEvidence: mainEvidence } : {}) } : {}),
            ...(error ? { code: CODE.test(error.code || '') ? error.code : 'TASK_ASSISTANCE_FAILED' } : {}),
            assistance: { mode: task.assistance, phase: 'settled', action: error ? 'stop' : action,
                elapsedMs: Math.max(0, Math.round(performance.now() - started)), ...(candidateId ? { candidateId } : {}) } });
        if (error) throw error;
        return { action, candidateId };
    };
}
module.exports = { createTaskAssistance };
