'use strict';

const { withOperationDeadline } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/operation-deadline');
const { JEV_REQUEST_POLICY } = require('./androidTaskPolicy');
const { requestEvidence, modelEvidence, transportEvidence } = require('./androidJevEvidence');

// Both task loops use the production client, its configured deadline and the same
// sanitized transport evidence. A local attempt is not proof of an HTTP request.
async function requestTaskModel(jev, device, state, questions) {
    const transport = [];
    let request = requestEvidence(null), response, failure;
    const started = performance.now();
    try {
        if (typeof jev?.decide !== 'function') throw Object.assign(new Error(), { code: 'TASK_JEV_UNAVAILABLE' });
        await withOperationDeadline(device.remainingMs(), device.signal, async outer => {
            const config = typeof jev.getStatus === 'function' ? await jev.getStatus() : null;
            const timeout = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs >= 1 && config.timeoutMs <= 300000
                ? config.timeoutMs : JEV_REQUEST_POLICY.defaultTimeoutMs;
            await withOperationDeadline(Math.min(timeout, outer.remainingMs()), outer.signal, async ({ signal, remainingMs }) => {
                response = await jev.decide(state, questions, { timeoutMs: remainingMs(), maxRetries: 0, signal,
                    onRequestMetadata: value => { request = requestEvidence(value); },
                    onTransportMetadata: value => {
                        const item = transportEvidence(value);
                        if (item && transport.length < 8) transport.push(item);
                    } });
            });
        });
        device.check();
    } catch (error) {
        failure = Object.assign(new Error(), { code: ['TIMEOUT', 'TASK_JEV_TIMEOUT'].includes(error.code)
            ? 'TASK_JEV_TIMEOUT' : 'TASK_JEV_UNAVAILABLE' });
        try { device.check(); } catch (boundary) { failure = boundary; }
    }
    return { response, failure, evidence: modelEvidence(request, response, performance.now() - started, transport) };
}
module.exports = { requestTaskModel };
