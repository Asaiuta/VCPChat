'use strict';

const fail = code => Object.assign(new Error(code), { code });

function choose(response, candidates, key, { allowWait = true, policy }) {
    const invalid = () => { throw Object.assign(fail('TASK_JEV_INVALID'), { rejectionReason: 'invalid_distribution' }); };
    const data = (value, keys) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
        const descriptors = Object.getOwnPropertyDescriptors(value), copy = Object.create(null);
        for (const name of Reflect.ownKeys(descriptors)) {
            if (!keys.includes(name) || !Object.hasOwn(descriptors[name], 'value') || !descriptors[name].enumerable) invalid();
            copy[name] = descriptors[name].value;
        }
        return copy;
    };
    const root = data(response, ['model', 'answers', 'usage', 'id', 'object', 'created']);
    const answers = data(root.answers, [key]);
    const answer = data(answers[key], ['type', 'choice', 'confidence', 'probabilities']);
    if (answer.type !== undefined && answer.type !== 'choice'
        || answer.confidence !== undefined && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) invalid();
    const keys = [...candidates.map(c => c.candidateId), ...(allowWait ? ['wait'] : []), 'escalate'];
    const probabilities = data(answer.probabilities, keys);
    if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)
        || Object.keys(probabilities).length !== keys.length || Object.keys(probabilities).some(key => !keys.includes(key))
        || keys.some(key => !Number.isFinite(probabilities[key]) || probabilities[key] < 0 || probabilities[key] > 1)
        || Math.abs(keys.reduce((sum, key) => sum + probabilities[key], 0) - 1) > 0.02) {
        throw Object.assign(fail('TASK_JEV_INVALID'), { rejectionReason: 'invalid_distribution' });
    }
    const ranked = keys.sort((a, b) => probabilities[b] - probabilities[a]);
    const probability = probabilities[ranked[0]], margin = probability - probabilities[ranked[1]];
    if (answer.choice !== undefined && answer.choice !== ranked[0]) invalid();
    const result = { choice: ranked[0], probability, margin };
    if (probability < policy.minProbability || margin < policy.minMargin) {
        throw Object.assign(fail('TASK_JEV_UNCERTAIN'), { ...result,
            rejectionReason: probability < policy.minProbability ? 'low_probability' : 'low_margin' });
    }
    return result;
}

function questionKey(observationId) {
    if (typeof observationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(observationId)) {
        throw Object.assign(new Error('TASK_CONTEXT_UNPROVEN'), { code: 'TASK_CONTEXT_UNPROVEN' });
    }
    return `next_${observationId.replaceAll('-', '').toLowerCase()}`;
}

module.exports = { choose, questionKey };
