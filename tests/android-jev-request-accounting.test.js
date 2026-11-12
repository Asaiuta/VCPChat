'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { GlobalJevService } = require('../modules/services/globalJevService');
const { searchWorld } = require('./helpers/android-search-world.cjs');
const { createAndroidTaskExecutor } = require('../modules/services/androidTaskExecutor');

test('modelCalls and request metadata do not prove an HTTP request reached a gateway', async t => {
    let networkCalls = 0, clientCalls = 0;
    t.mock.method(axios, 'post', () => { networkCalls++; throw Error('Unexpected network call'); });
    const service = new GlobalJevService({
        settingsManager: { readSettings: async () => ({ jevEnabled: true, jevProvider: 'typesafe',
            jevApiUrl: 'https://offline.invalid/v1/systemone', jevApiKey: 'offline-test-only',
            jevModel: 'jev-latest', jevTimeoutMs: 1000 }) },
        client: { getStatus: config => ({ ...config, configured: true }), decide(_state, _questions, request) {
            clientCalls++;
            assert.ok(request.timeoutMs <= 1000, 'executor honors the configured request cap');
            assert.equal(request.maxRetries, 0);
            return new Promise((_, reject) => {
                if (request.signal.aborted) reject(request.signal.reason);
                else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
            });
        } }
    });
    const h = await searchWorld({ executorFactory: options => createAndroidTaskExecutor({ ...options, jev: service }) });
    t.after(() => h.service.cleanup());
    const result = (await h.run()).details.task;
    assert.equal(result.code, 'TASK_JEV_TIMEOUT');
    assert.equal(result.counts.modelCalls, 1);
    assert.equal(result.counts.actions, 0);
    assert.equal(clientCalls, 1);
    assert.equal(networkCalls, 0);
    const model = h.events.find(e => e.type === 'model');
    assert.equal(model.modelEvidence.requestedModel, 'jev-latest');
    assert.equal(model.modelEvidence.returnedModel, null);
    assert.equal(model.code, 'TASK_JEV_TIMEOUT');
    const escalation = h.events.find(e => e.type === 'escalation');
    assert.equal(escalation.escalation.disposition, 'hard_stop');
    assert.equal(escalation.escalation.continuation, 'not_authorized');
    assert.equal(result.counts.mainModelCalls, 0);
});
