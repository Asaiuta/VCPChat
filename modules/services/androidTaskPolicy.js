'use strict';

const { MAX_LOADING_WAITS } = require('./androidTaskBudget');
const JEV_REQUEST_POLICY = Object.freeze({ version: 'jev-request-v2', defaultTimeoutMs: 30000,
    timeoutSource: 'global_configuration_capped_by_task', maxRetries: 0 });

// Only contracts emitted by the current executor are accepted for new traces.
const SEARCH_POLICY = Object.freeze({ version: 'search-v9', completionVersion: 'search-completion-v2',
    feedbackVersion: 'search-feedback-v4', semanticsVersion: 'search-semantics-v2',
    minProbability: 0.9, minMargin: 0.2, calibrated: false, maxCandidates: 8, maxRounds: 8,
    maxWaits: MAX_LOADING_WAITS, waitTimeoutMs: 5000, waitSampleMs: 200, maxConsecutiveStale: 3 });
const TOGGLE_POLICY = Object.freeze({ version: 'toggle-v1', completionVersion: 'toggle-completion-v1',
    feedbackVersion: 'toggle-feedback-v1', minProbability: 0.9, minMargin: 0.2, calibrated: false,
    maxCandidates: 1, maxRounds: 4, maxWaits: 0, maxConsecutiveStale: 3 });
const ROUTE_POLICY = Object.freeze({ version: 'route-v1', completionVersion: 'route-completion-v1',
    feedbackVersion: 'route-feedback-v1', minProbability: 0.9, minMargin: 0.2, calibrated: false,
    maxCandidates: 2, maxRounds: 6, maxWaits: 0, maxConsecutiveStale: 3 });
const UI_TASK_POLICY = Object.freeze({ version: 'ui-task-v20', semanticsVersion: 'ui-elements-v11',
    completionVersion: 'ui-predicates-v2', minProbability: 0.9, minMargin: 0.2, calibrated: false,
    maxCandidates: 128, maxElements: 96, maxRecent: 8, maxConsecutiveStale: 3,
    waitTimeoutMs: 5000, completionTimeoutMs: 5000, sampleMs: 200, minSampleBudgetMs: 1500 });
const policies = Object.freeze({ search: SEARCH_POLICY, set_toggle: TOGGLE_POLICY, route_search: ROUTE_POLICY, ui_task: UI_TASK_POLICY });
const assistanceReasons = new Set(['TASK_ESCALATION_REQUIRED', 'TASK_JEV_UNCERTAIN', 'TASK_TARGET_MISSING',
    'TASK_NO_PROGRESS', 'TASK_WAIT_UNPROVEN', 'TASK_WAIT_TIMEOUT', 'TASK_WAIT_LIMIT', 'TASK_STALE_LIMIT']);

function taskPolicy(intent) {
    return typeof intent === 'string' && Object.hasOwn(policies, intent) ? policies[intent] : undefined;
}

function escalationDisposition(code, receipts) {
    return assistanceReasons.has(code) && receipts.every(r => r.outcome === 'failed' || r.outcome === 'verified')
        ? 'assistance_required' : 'hard_stop';
}

module.exports = { SEARCH_POLICY, TOGGLE_POLICY, ROUTE_POLICY, UI_TASK_POLICY, JEV_REQUEST_POLICY, taskPolicy, escalationDisposition };
