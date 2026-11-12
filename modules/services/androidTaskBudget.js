'use strict';

// Shared by task admission, retries and trace storage. Trace events include both
// observations and action/model receipts; an observation budget is not an event budget.
const LIMITS = Object.freeze({ timeoutMs: 300000, maxActions: 8, maxObservations: 256, maxModelCalls: 16 });
const MAX_ACTION_ATTEMPTS = 3;
const MAX_LOADING_WAITS = 2;
function traceEventLimit(budget) {
    // Each attempt: decision + prepared + settled. Each model call: candidates +
    // model evidence + decision + at most one stale recovery record. Final
    // verification, two events per loading wait, one escalation packet and the
    // terminal record and two assistance events retain dedicated slots. The byte ceiling stays unchanged.
    return budget.maxObservations + 3 * MAX_ACTION_ATTEMPTS * budget.maxActions + 4 * budget.maxModelCalls
        + 2 * MAX_LOADING_WAITS + 5;
}

module.exports = { LIMITS, MAX_ACTION_ATTEMPTS, MAX_LOADING_WAITS, traceEventLimit };
