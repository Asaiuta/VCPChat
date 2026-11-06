'use strict';

// Shared by task admission, retries and trace storage. Trace events include both
// observations and action/model receipts; an observation budget is not an event budget.
const LIMITS = Object.freeze({ timeoutMs: 300000, maxActions: 8, maxObservations: 256, maxModelCalls: 16 });
const MAX_ACTION_ATTEMPTS = 3;
function traceEventLimit(budget) {
    // Each attempt: decision + prepared + settled. Each model call: candidates +
    // decision. The final verification and one terminal record have their own slots.
    return budget.maxObservations + 3 * MAX_ACTION_ATTEMPTS * budget.maxActions + 2 * budget.maxModelCalls + 2;
}

module.exports = { LIMITS, MAX_ACTION_ATTEMPTS, traceEventLimit };
