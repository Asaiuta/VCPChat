'use strict';
// Same real workload, freeze/cleanup and independent checker; distinct candidate protocol.
require('./android-j02-search.cjs').main(process.argv.slice(2), { generic: true })
    .then(r => { process.exitCode = r.status === 'completed' && r.trials[0].outcome === 'success' ? 0 : 1; })
    .catch(e => { console.error(/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code || '') ? e.code : 'EXPLORATION_FAILED'); process.exitCode = 1; });
