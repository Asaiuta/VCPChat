'use strict';

// A local capture deadline says nothing about an unresolved transport request.
// Callers check cancellation/root deadlines first and own the resulting business code.
function samplingExpired(error, deadlineMs, now = Date.now()) {
    return (error?.code === 'VERIFICATION_TIMEOUT' || error?.code === 'ADB_TIMEOUT') && now >= deadlineMs
        && error.inFlight !== true && error.drained !== false;
}

module.exports = { samplingExpired };
