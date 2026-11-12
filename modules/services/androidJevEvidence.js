'use strict';

// Deliberately not a response/error dump. Absent or malformed provider metadata
// stays unknown; neither a request alias nor missing usage proves a model version/cost.
const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:/~+-]{0,127}$/;
const USAGE_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'totalTokens']);
const REJECTION_REASONS = Object.freeze(['invalid_distribution', 'low_probability', 'low_margin',
    'escalate', 'model_timeout', 'model_unavailable', 'cancelled', 'deadline']);
const { STAGES, ERRORS } = require('./jevTransport');
const TRANSPORT_KEYS = Object.freeze(['requestId', 'stage', 'elapsedMs', 'httpStatus', 'reusedSocket', 'errorCode']);
function transportEvidence(value) {
    const requestId = own(value, 'requestId'), stage = own(value, 'stage'), elapsedMs = own(value, 'elapsedMs');
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
        || !STAGES.includes(stage) || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 1e9) return null;
    const result = { requestId, stage, elapsedMs };
    if (stage === 'http_response') {
        const status = own(value, 'httpStatus');
        if (!Number.isInteger(status) || status < 100 || status > 599) return null;
        result.httpStatus = status;
    }
    if (stage === 'socket_assigned') {
        if (typeof own(value, 'reusedSocket') !== 'boolean') return null;
        result.reusedSocket = own(value, 'reusedSocket');
    }
    if (stage === 'failed') {
        if (!ERRORS.includes(own(value, 'errorCode'))) return null;
        result.errorCode = own(value, 'errorCode');
    }
    return result;
}
function own(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
    catch { return undefined; }
}
const modelId = value => typeof value === 'string' && MODEL_ID.test(value) ? value : null;
const tokens = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9 ? value : null;
function requestEvidence(value) {
    const provider = own(value, 'provider');
    return { provider: ['typesafe', 'openrouter'].includes(provider) ? provider : null,
        requestedModel: modelId(own(value, 'requestedModel')) };
}
function modelEvidence(request, response, elapsedMs, transport) {
    const usage = own(response, 'usage');
    return { ...requestEvidence(request), returnedModel: modelId(own(response, 'model')),
        usage: { inputTokens: tokens(own(usage, 'input_tokens') ?? own(usage, 'prompt_tokens')),
            outputTokens: tokens(own(usage, 'output_tokens') ?? own(usage, 'completion_tokens')),
            totalTokens: tokens(own(usage, 'total_tokens')) }, elapsedMs: Math.max(0, Math.floor(elapsedMs)),
        ...(transport ? { transport: transport.slice(0, 8).map(transportEvidence).filter(Boolean) } : {}) };
}
function modelRejection(code) {
    return code === 'TASK_JEV_TIMEOUT' ? 'model_timeout' : code === 'STEP_ABORTED' ? 'cancelled'
        : code === 'STEP_DEADLINE' ? 'deadline' : 'model_unavailable';
}

module.exports = { MODEL_ID, USAGE_KEYS, REJECTION_REASONS, TRANSPORT_KEYS, transportEvidence, requestEvidence, modelEvidence, modelRejection };
