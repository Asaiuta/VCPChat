'use strict';

const { parseSelector, evaluateSelector } = require('./selector');

/** Poll one condition within the existing step lease, cancellation signal and deadline. */
async function waitForExpectation({ runtime, client, captureGraph, serial, expected, deadlineMs }) {
    const selector = expected.type === 'foreground' ? null : parseSelector(expected.selector);
    let matched = false;
    let evidence = null;
    let errorNote = null;
    let sample = null;
    do {
        runtime.check();
        try {
            errorNote = null;
            const acquire = async () => {
                if (expected.type === 'foreground') {
                    const focus = await client.currentFocus(serial);
                    matched = focus?.package === expected.package;
                    evidence = { package: focus?.package || null };
                    return;
                }
                const size = await client.screenSize(serial);
                const graph = await captureGraph(serial, { limit: 500, screen: size, deadlineMs });
                // The tree proves its package, not a later foreground component/window.
                sample = { serial, graph, size, focus: { package: graph.package || null }, limit: 500, at: Date.now() };
                const evaluated = evaluateSelector(graph, selector, { includeDisabled: true });
                const found = evaluated.hits.length > 0;
                const incomplete = !evaluated.complete || graph.truncated || graph.keyguard;
                matched = !incomplete && (expected.type === 'visible' ? evaluated.hits.length === 1 : !found);
                if (incomplete) errorNote = 'INCOMPLETE_OBSERVATION';
                else if (evaluated.ambiguous) errorNote = 'AMBIGUOUS_SELECTOR';
                evidence = { signature: graph.signature, found, ambiguous: evaluated.ambiguous, truncated: graph.truncated, keyguard: graph.keyguard };
            };
            if (typeof client.withContext === 'function') await client.withContext({ deadlineMs }, acquire);
            else await acquire();
            if (Date.now() > deadlineMs) { matched = false; errorNote = 'VERIFICATION_TIMEOUT'; }
        } catch (error) {
            runtime.check();
            errorNote = error.code || 'VERIFICATION_FAILED';
            if (error.code !== 'UI_SERVER_RPC_ERROR') break;
        }
        if (matched || Date.now() >= deadlineMs) break;
        await runtime.pause(Math.min(150, deadlineMs - Date.now()));
    } while (Date.now() < deadlineMs);
    runtime.verified(matched, { condition: expected, evidence, error: errorNote });
    return { matched, sample: matched ? sample : null };
}

module.exports = { waitForExpectation };
