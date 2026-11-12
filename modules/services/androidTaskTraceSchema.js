'use strict';

const { CONTEXT_DIFF_TOKENS } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/context');
const { LIMITS } = require('./androidTaskBudget');
const { FEEDBACK_VERSION, ROLES, HINTS, FIELD_RELATIONS, FEEDBACK_EVENTS, MAX_RECENT_ACTIONS } = require('./androidSearchEvidence');
const { MODEL_ID, USAGE_KEYS, REJECTION_REASONS, TRANSPORT_KEYS, transportEvidence } = require('./androidJevEvidence');
const routeSchema = require('./androidRouteTrace');
const { taskPolicy, TOGGLE_POLICY, escalationDisposition } = require('./androidTaskPolicy');

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const HEADER_KEYS = ['schemaVersion', 'taskId', 'serial', 'package', 'intent', 'inputRefs', 'budget'];
const BUDGET_KEYS = ['timeoutMs', 'maxActions', 'maxObservations', 'maxModelCalls'];
const EVENT_KEYS = ['type', 'step', 'observation', 'targetId', 'inputRef', 'source', 'requestId',
    'outcome', 'code', 'matched', 'modelCalls', 'phase', 'attempts', 'dispatched', 'choice', 'expectId', 'candidates',
    'contextDiff', 'completion', 'modelEvidence', 'rejectionReason', 'probability', 'margin', 'recovery', 'wait', 'escalation', 'loading', 'assistance', 'mainModelRequests', 'decisionContext', 'scrollProof', 'toggle', 'route'];
const COMPLETION_KEYS = ['present', 'containers', 'items', 'inputMatched', 'absent'];

const { requireValid, record, integer, choice, uuid, digest, inputRefs, list, targetId } = require('./androidTaskTraceData');

function headerSnapshot(value) {
    const data = record(value, [...HEADER_KEYS, 'decision', 'policyVersion', 'completionPolicyVersion', 'loading', 'assistance', 'searchActions', 'toggle', 'route'], HEADER_KEYS);
    const toggle = data.intent === 'set_toggle';
    const route = data.intent === 'route_search';
    const policy = taskPolicy(data.intent);
    requireValid(data.schemaVersion === 1 && policy !== undefined);
    let routeScope;
    if (route) {
        requireValid(data.decision === 'jev'
            && !Object.hasOwn(data, 'searchActions') && !Object.hasOwn(data, 'loading'));
        routeScope = routeSchema.scope(data.route, data.package);
    } else requireValid(!Object.hasOwn(data, 'route'));
    let toggleScope;
    if (toggle) {
        requireValid(data.decision === 'jev'
            && !Object.hasOwn(data, 'searchActions') && !Object.hasOwn(data, 'loading'));
        const item = record(data.toggle, ['id', 'checked'], ['id', 'checked']);
        requireValid(typeof item.checked === 'boolean' && typeof item.id === 'string' && item.id.length <= 320);
        toggleScope = { id: targetId(item.id, data.package), checked: item.checked };
    } else requireValid(!Object.hasOwn(data, 'toggle'));
    requireValid(typeof data.serial === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,159}$/.test(data.serial)
        && !['constructor', 'prototype', '__proto__'].includes(data.serial));
    requireValid(typeof data.package === 'string' && data.package.length <= 255 && PACKAGE.test(data.package));
    const budget = record(data.budget, BUDGET_KEYS, BUDGET_KEYS);
    if (data.decision !== undefined || data.policyVersion !== undefined) {
        requireValid(data.decision === 'jev' && data.policyVersion === policy.version);
    }
    requireValid(data.completionPolicyVersion === policy.completionVersion);
    let searchActions;
    if (data.searchActions !== undefined) {
        requireValid(data.intent === 'search' && data.decision === 'jev');
        searchActions = searchActionsSnapshot(data.searchActions, data.package);
    }
    if (data.assistance !== undefined) requireValid(data.decision === 'jev' && ['main_agent', 'human'].includes(data.assistance));
    if (toggle) requireValid(budget.maxActions === 1 && budget.maxObservations >= 4);
    if (route) requireValid(budget.maxActions <= 3 && budget.maxObservations >= 8);
    let loading;
    if (data.loading !== undefined) {
        requireValid(data.intent === 'search' && data.decision === 'jev');
        const item = record(data.loading, ['id'], ['id']);
        requireValid(typeof item.id === 'string' && item.id.length <= 320);
        loading = { id: targetId(item.id, data.package) };
    }
    return { schemaVersion: 1, taskId: uuid(data.taskId), serial: data.serial, package: data.package,
        ...(data.decision ? { decision: data.decision, policyVersion: data.policyVersion } : {}),
        completionPolicyVersion: data.completionPolicyVersion,
        ...(loading ? { loading } : {}),
        ...(searchActions ? { searchActions } : {}),
        ...(data.assistance ? { assistance: data.assistance } : {}),
        ...(toggleScope ? { toggle: toggleScope } : {}),
        ...(routeScope ? { route: routeScope } : {}),
        intent: data.intent, inputRefs: route ? routeSchema.refs(data.inputRefs, true) : inputRefs(data.inputRefs, toggle ? 'checked' : 'query'), budget: {
            timeoutMs: integer(budget.timeoutMs, 1, LIMITS.timeoutMs), maxActions: integer(budget.maxActions, 1, LIMITS.maxActions),
            maxObservations: integer(budget.maxObservations, 1, LIMITS.maxObservations), maxModelCalls: integer(budget.maxModelCalls, 0, LIMITS.maxModelCalls)
        } };
}
function parametersSnapshot(value, command, packageName) {
    if (command === 'KeyEvent') {
        const p = record(value, ['key', 'revealId'], ['key', 'revealId']);
        requireValid(p.key === 'back' && typeof p.revealId === 'string' && p.revealId.length <= 320);
        return { key: 'back', revealId: targetId(p.revealId, packageName) };
    }
    if (command === 'ImeAction') {
        const p = record(value, ['imeAction'], ['imeAction']);
        return { imeAction: choice(p.imeAction, ['enter', 'search']) };
    }
    requireValid(['Scroll', 'ScrollUntil'].includes(command));
    const p = record(value, ['direction', 'revealId'], ['direction', 'revealId']);
    requireValid(typeof p.revealId === 'string' && p.revealId.length <= 320);
    return { direction: choice(p.direction, ['up', 'down', 'left', 'right']), revealId: targetId(p.revealId, packageName) };
}
function searchActionsSnapshot(value, packageName) {
    const data = record(value, ['imeAction', 'scroll', 'back']);
    requireValid(Object.keys(data).length > 0);
    const result = {};
    if (Object.hasOwn(data, 'imeAction')) result.imeAction = choice(data.imeAction, ['enter', 'search']);
    if (Object.hasOwn(data, 'scroll')) {
        const keys = ['command', 'container', 'target', 'direction'], s = record(data.scroll, [...keys, 'maxSwipes'], keys);
        requireValid(s.container !== s.target && typeof s.container === 'string' && s.container.length <= 320
            && typeof s.target === 'string' && s.target.length <= 320);
        result.scroll = { command: choice(s.command, ['Scroll', 'ScrollUntil']), container: targetId(s.container, packageName),
            target: targetId(s.target, packageName), direction: choice(s.direction, ['up', 'down', 'left', 'right']),
            ...(Object.hasOwn(s, 'maxSwipes') ? { maxSwipes: integer(s.maxSwipes, 1, s.command === 'Scroll' ? 4 : 1) } : {}) };
    }
    if (Object.hasOwn(data, 'back')) {
        const b = record(data.back, ['from', 'target'], ['from', 'target']);
        requireValid(b.from !== b.target && typeof b.from === 'string' && b.from.length <= 320
            && typeof b.target === 'string' && b.target.length <= 320);
        result.back = { from: targetId(b.from, packageName), target: targetId(b.target, packageName) };
    }
    return result;
}
function compatibleAction(step, item) {
    switch (step) {
    case 'back': return item.command === 'KeyEvent' && item.postcondition === 'search_back_progress';
    case 'entry': return item.command === 'Tap' && item.postcondition === 'search_progress';
    case 'fill': return item.command === 'Fill' && item.postcondition === 'input_readback';
    case 'focus': return item.command === 'Tap' && item.postcondition === 'input_focused';
    case 'seek': return ['Scroll', 'ScrollUntil'].includes(item.command) && ['search_target_visible', 'search_scroll_progress'].includes(item.postcondition);
    case 'submit': return ['Tap', 'ImeAction'].includes(item.command) && item.postcondition === 'completion_visible';
    default: return false;
    }
}
function assertActionScope(step, item, scope) {
    requireValid(compatibleAction(step, item));
    if (step === 'submit' && scope?.imeAction) requireValid(item.command === 'ImeAction');
    if (step === 'focus') requireValid(Boolean(scope?.imeAction) && item.semantics?.role === 'textfield');
    if (item.command === 'ImeAction') requireValid(scope?.imeAction === item.parameters?.imeAction && item.semantics?.role === 'textfield');
    if (step === 'back') requireValid(scope?.back && item.targetId === scope.back.from
        && item.parameters?.key === 'back' && item.parameters.revealId === scope.back.target);
    if (step === 'seek') requireValid(scope?.scroll && scope.scroll.command === item.command && scope.scroll.container === item.targetId
        && scope.scroll.target === item.parameters?.revealId && scope.scroll.direction === item.parameters?.direction
        && item.postcondition === (scope.scroll.maxSwipes > 1 ? 'search_scroll_progress' : 'search_target_visible'));
}
function scrollProgressSnapshot(value) {
    const keys = ['swipes', 'maxSwipes', 'lastResult'], p = record(value, keys, keys);
    const maxSwipes = integer(p.maxSwipes, 2, 4), swipes = integer(p.swipes, 0, maxSwipes);
    const lastResult = choice(p.lastResult, ['initial', 'directional_motion', 'target_visible']);
    requireValid((swipes === 0) === (lastResult === 'initial'));
    return { swipes, maxSwipes, lastResult };
}
function assertScrollContext(context, scope) {
    const multi = scope?.scroll?.maxSwipes > 1;
    requireValid(Boolean(context?.scrollProgress) === multi);
    if (multi) requireValid(context.scrollProgress.maxSwipes === scope.scroll.maxSwipes);
    if (context?.lastEvent === 'verified_back') requireValid(scope?.back);
}
function scrollProofSnapshot(value) {
    const keys = ['beforeObservationId', 'afterObservationId', 'beforeDigest', 'afterDigest', 'result', 'anchors', 'distance'];
    const p = record(value, keys, keys), result = choice(p.result, ['directional_motion', 'target_visible']);
    requireValid(p.beforeObservationId !== p.afterObservationId && p.beforeDigest !== p.afterDigest);
    const anchors = integer(p.anchors, 0, 64), distance = integer(p.distance, 0, 100000);
    requireValid(result === 'target_visible' ? anchors === 0 && distance === 0 : anchors >= 2 && distance >= 8);
    return { beforeObservationId: uuid(p.beforeObservationId), afterObservationId: uuid(p.afterObservationId),
        beforeDigest: digest(p.beforeDigest), afterDigest: digest(p.afterDigest), result, anchors, distance };
}
function decisionContextSnapshot(value, packageName) {
    const keys = ['version', 'observationId', 'round', 'queryVerified', 'screenChanged', 'consecutiveStale', 'waits', 'recentActions', 'lastEvent', 'remaining'];
    const data = record(value, [...keys, 'scrollProgress'], keys);
    requireValid(data.version === FEEDBACK_VERSION && typeof data.queryVerified === 'boolean'
        && (data.screenChanged === null || typeof data.screenChanged === 'boolean'));
    const recentActions = list(data.recentActions, MAX_RECENT_ACTIONS, action => {
        const keys = ['step', 'command', 'targetId', 'postcondition'];
        const item = record(action, [...keys, 'parameters'], keys);
        const step = choice(item.step, ['entry', 'fill', 'focus', 'seek', 'back']);
        requireValid(compatibleAction(step, item) && typeof item.targetId === 'string' && item.targetId.length <= 320);
        requireValid(Object.hasOwn(item, 'parameters') === (['seek', 'back'].includes(step)));
        return { step, command: item.command, targetId: targetId(item.targetId, packageName), postcondition: item.postcondition,
            ...(item.parameters ? { parameters: parametersSnapshot(item.parameters, item.command, packageName) } : {}) };
    });
    const max = { timeoutMs: 300000, actions: 8, observations: 256, modelCalls: 16, rounds: 8, waits: 2 };
    const remaining = record(data.remaining, Object.keys(max), Object.keys(max));
    return { version: data.version, observationId: uuid(data.observationId), round: integer(data.round, 1, 8),
        queryVerified: data.queryVerified, screenChanged: data.screenChanged, consecutiveStale: integer(data.consecutiveStale, 0, 3),
        waits: integer(data.waits, 0, 2), recentActions, lastEvent: choice(data.lastEvent, FEEDBACK_EVENTS),
        remaining: Object.fromEntries(Object.entries(max).map(([key, cap]) => [key, integer(remaining[key], 0, cap)])),
        ...(Object.hasOwn(data, 'scrollProgress') ? { scrollProgress: scrollProgressSnapshot(data.scrollProgress) } : {}) };
}
function toggleContextSnapshot(value) {
    const keys = ['version', 'observationId', 'round', 'currentChecked', 'desiredChecked', 'consecutiveStale', 'lastEvent', 'remaining'];
    const data = record(value, keys, keys);
    requireValid(data.version === TOGGLE_POLICY.feedbackVersion && typeof data.currentChecked === 'boolean'
        && typeof data.desiredChecked === 'boolean' && data.currentChecked !== data.desiredChecked);
    const caps = { timeoutMs: 300000, actions: 1, observations: 256, modelCalls: 16, rounds: 4, waits: 0 };
    const left = record(data.remaining, Object.keys(caps), Object.keys(caps));
    return { version: data.version, observationId: uuid(data.observationId), round: integer(data.round, 1, 4),
        currentChecked: data.currentChecked, desiredChecked: data.desiredChecked,
        consecutiveStale: integer(data.consecutiveStale, 0, 3),
        lastEvent: choice(data.lastEvent, ['initial', 'stale_observation', 'stale_dispatch', 'main_agent_reobserve', 'human_reobserve']),
        remaining: Object.fromEntries(Object.entries(caps).map(([k, max]) => [k, integer(left[k], 0, max)])) };
}
function eventSnapshot(value, packageName, toggle = false, route = false) {
    const data = record(value, EVENT_KEYS, ['type']);
    const event = { type: choice(data.type, ['observation', 'candidates', 'model', 'decision', 'action', 'recovery', 'wait', 'escalation', 'assistance', 'verification', 'stopped', 'completed']) };
    for (const key of Object.keys(data)) {
        const value = data[key];
        if (toggle) requireValid(!['scrollProof', 'loading', 'wait', 'completion', 'inputRef', 'expectId'].includes(key));
        if (route) requireValid(!['scrollProof', 'loading', 'wait', 'completion', 'toggle'].includes(key));
        switch (key) {
        case 'type': break;
        case 'route':
            requireValid(route && data.type === 'observation'); event.route = routeSchema.sample(value); break;
        case 'toggle': {
            requireValid(toggle && data.type === 'observation');
            const item = record(value, ['matches', 'safe', 'checked'], ['matches', 'safe', 'checked']);
            requireValid(typeof item.safe === 'boolean' && (item.checked === null || typeof item.checked === 'boolean')
                && (!item.safe || item.matches === 1 && item.checked !== null));
            event.toggle = { matches: integer(item.matches, 0, 1000), safe: item.safe, checked: item.checked };
            break;
        }
        case 'scrollProof':
            requireValid(data.type === 'action' && data.phase === 'settled' && data.step === 'seek' && data.outcome === 'verified');
            event.scrollProof = scrollProofSnapshot(value);
            break;
        case 'decisionContext':
            requireValid(data.type === 'candidates');
            event.decisionContext = route ? routeSchema.context(value) : toggle ? toggleContextSnapshot(value) : decisionContextSnapshot(value, packageName);
            break;
        case 'assistance': {
            requireValid(data.type === 'assistance');
            const item = record(value, ['mode', 'phase', 'action', 'elapsedMs', 'candidateId'], ['mode', 'phase', 'action', 'elapsedMs']);
            event.assistance = { mode: choice(item.mode, ['main_agent', 'human']), phase: choice(item.phase, ['started', 'settled']),
                action: choice(item.action, ['pending', 'select', 'reobserve', 'stop']), elapsedMs: integer(item.elapsedMs) };
            requireValid((item.phase === 'started') === (item.action === 'pending'));
            if (item.candidateId !== undefined) event.assistance.candidateId = choice(item.candidateId, route ? ['c0', 'c1'] : toggle ? ['c0'] : ['c0','c1','c2','c3','c4','c5','c6','c7']);
            break;
        }
        case 'loading': {
            requireValid(data.type === 'observation');
            const item = record(value, ['matches', 'visible', 'safe'], ['matches', 'visible', 'safe']);
            requireValid(typeof item.safe === 'boolean' && item.visible <= item.matches);
            event.loading = { matches: integer(item.matches, 0, 1000), visible: integer(item.visible, 0, 1000), safe: item.safe };
            break;
        }
        case 'wait': {
            requireValid(data.type === 'wait');
            const keys = ['phase', 'reason', 'episode', 'elapsedMs', 'matched'];
            const item = record(value, keys, keys);
            requireValid(typeof item.matched === 'boolean' && (item.phase !== 'started' || !item.matched));
            event.wait = { phase: choice(item.phase, ['started', 'settled']), reason: choice(item.reason, ['declared_loading']),
                episode: integer(item.episode, 1, 2), elapsedMs: integer(item.elapsedMs), matched: item.matched };
            break;
        }
        case 'escalation':
            requireValid(data.type === 'escalation');
            event.escalation = escalationSnapshot(value, packageName);
            requireValid((event.escalation.intent === 'set_toggle') === toggle);
            requireValid((event.escalation.intent === 'route_search') === route);
            break;
        case 'mainModelRequests':
            requireValid(data.type === 'assistance');
            event.mainModelRequests = value === null ? null : integer(value, 0, 1);
            break;
        case 'modelEvidence': {
            requireValid(['model', 'assistance'].includes(data.type));
            const keys = ['provider', 'requestedModel', 'returnedModel', 'usage', 'elapsedMs'];
            const item = record(value, [...keys, 'transport'], keys);
            choice(item.provider, [null, 'typesafe', 'openrouter']);
            for (const key of ['requestedModel', 'returnedModel']) {
                requireValid(item[key] === null || typeof item[key] === 'string' && MODEL_ID.test(item[key]));
            }
            const usage = record(item.usage, USAGE_KEYS, USAGE_KEYS);
            event.modelEvidence = { provider: item.provider, requestedModel: item.requestedModel, returnedModel: item.returnedModel,
                usage: Object.fromEntries(USAGE_KEYS.map(key => [key, usage[key] === null ? null : integer(usage[key], 0, 1e9)])),
                elapsedMs: integer(item.elapsedMs) };
            if (item.transport !== undefined) event.modelEvidence.transport = list(item.transport, 8, raw => {
                const entry = record(raw, TRANSPORT_KEYS, ['requestId', 'stage', 'elapsedMs']);
                const projected = transportEvidence(entry);
                requireValid(projected !== null && Object.keys(entry).length === Object.keys(projected).length);
                return projected;
            });
            break;
        }
        case 'rejectionReason': event.rejectionReason = choice(value, REJECTION_REASONS); break;
        case 'probability': case 'margin':
            requireValid(Number.isFinite(value) && value >= 0 && value <= 1);
            event[key] = value;
            break;
        case 'recovery': {
            requireValid(data.type === 'recovery');
            const keys = ['reason', 'consecutive', 'retryAllowed'];
            const item = record(value, keys, keys);
            requireValid(typeof item.retryAllowed === 'boolean');
            event.recovery = { reason: choice(item.reason, ['observation_stale', 'dispatch_stale']),
                consecutive: integer(item.consecutive, 1, 3), retryAllowed: item.retryAllowed };
            break;
        }
        case 'step': event.step = choice(value, route ? ['route_fill', 'route_submit', 'complete'] : toggle ? ['toggle', 'complete'] : ['entry', 'fill', 'submit', 'complete', 'focus', 'seek', 'back']); break;
        case 'observation': {
            const item = record(value, ['id', 'digest', 'contextDigest', 'controls', 'targetDigest', 'outsideDigest'],
                ['id', 'digest', 'contextDigest', 'controls']);
            requireValid(Object.hasOwn(item, 'targetDigest') === Object.hasOwn(item, 'outsideDigest'));
            event.observation = { id: uuid(item.id), digest: digest(item.digest),
                contextDigest: digest(item.contextDigest), controls: integer(item.controls),
                ...(Object.hasOwn(item, 'targetDigest') ? { targetDigest: digest(item.targetDigest),
                    outsideDigest: digest(item.outsideDigest) } : {}) };
            break;
        }
        case 'contextDiff': {
            const tokens = list(value, CONTEXT_DIFF_TOKENS.length, token => choice(token, CONTEXT_DIFF_TOKENS));
            requireValid(tokens.length > 0 && new Set(tokens).size === tokens.length);
            event.contextDiff = CONTEXT_DIFF_TOKENS.filter(token => tokens.includes(token));
            break;
        }
        case 'completion': {
            const item = record(value, COMPLETION_KEYS, COMPLETION_KEYS);
            for (const key of ['present', 'inputMatched', 'absent']) requireValid(typeof item[key] === 'boolean');
            event.completion = { present: item.present, containers: integer(item.containers, 0, 1000),
                items: integer(item.items, 0, 1000), inputMatched: item.inputMatched, absent: item.absent };
            break;
        }
        case 'targetId': case 'expectId': event[key] = targetId(value, packageName); break;
        case 'candidates':
            if (route) { event.candidates = routeSchema.candidates(value, packageName); break; }
            if (toggle) {
                const keys = ['candidateId', 'targetId', 'command', 'evidenceSources', 'postcondition'];
                event.candidates = list(value, 1, raw => {
                    const c = record(raw, keys, keys);
                    requireValid(c.candidateId === 'c0' && c.command === 'Tap' && c.postcondition === 'checked_readback');
                    const sources = list(c.evidenceSources, 1, v => choice(v, ['declared']));
                    requireValid(sources.length === 1 && typeof c.targetId === 'string' && c.targetId.length <= 320);
                    return { candidateId: 'c0', targetId: targetId(c.targetId, packageName), command: 'Tap',
                        evidenceSources: sources, postcondition: 'checked_readback' };
                });
                break;
            }
            event.candidates = list(value, 8, (candidate, index) => {
                const keys = ['candidateId', 'targetId', 'command', 'evidenceSources', 'postcondition', 'semantics', 'inputRef'];
                const item = record(candidate, [...keys, 'parameters'], keys);
                const m = record(item.semantics, ['role', 'hints', 'fieldRelation'], ['role', 'hints', 'fieldRelation']);
                const hints = list(m.hints, HINTS.length, hint => choice(hint, HINTS));
                requireValid(hints.length > 0 && new Set(hints).size === hints.length
                    && item.inputRef === (item.command === 'Fill' ? 'query' : null));
                const semantics = { role: choice(m.role, ROLES), hints, fieldRelation: choice(m.fieldRelation, FIELD_RELATIONS) };
                requireValid(item.command !== 'Fill' || semantics.role === 'textfield');
                requireValid(item.candidateId === `c${index}`);
                const evidenceSources = list(item.evidenceSources, 3, source => choice(source, ['id', 'text', 'desc', 'declared']));
                requireValid(evidenceSources.length > 0 && new Set(evidenceSources).size === evidenceSources.length);
                requireValid(Object.hasOwn(item, 'parameters') === ['Scroll', 'ScrollUntil', 'ImeAction', 'KeyEvent'].includes(item.command));
                if (['Scroll', 'ScrollUntil', 'KeyEvent'].includes(item.command)) requireValid(evidenceSources.length === 1 && evidenceSources[0] === 'declared');
                else requireValid(!evidenceSources.includes('declared'));
                return { candidateId: item.candidateId, targetId: targetId(item.targetId, packageName),
                    command: choice(item.command, ['Tap', 'Fill', 'Scroll', 'ScrollUntil', 'ImeAction', 'KeyEvent']), evidenceSources,
                    ...(item.parameters ? { parameters: parametersSnapshot(item.parameters, item.command, packageName) } : {}),
                    inputRef: item.inputRef, semantics,
                    postcondition: choice(item.postcondition, ['search_progress', 'input_readback', 'completion_visible', 'input_focused', 'search_target_visible', 'search_scroll_progress', 'search_back_progress']) };
            });
            requireValid(new Set(event.candidates.map(c => c.targetId)).size === event.candidates.length);
            break;
        case 'inputRef': event.inputRef = choice(value, route ? ['origin', 'destination'] : ['query']); break;
        case 'source': event.source = choice(value, toggle || route ? ['jev'] : ['rule', 'shadow', 'jev']); break;
        case 'choice': event.choice = choice(value, route ? ['c0', 'c1', 'invalid', 'escalate'] : toggle ? ['c0', 'invalid', 'escalate'] : ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'none', 'invalid', 'wait', 'escalate']); break;
        case 'requestId': event.requestId = uuid(value); break;
        case 'outcome': event.outcome = choice(value, ['observed', 'dispatched', 'verified', 'unknown', 'failed']); break;
        case 'code':
            requireValid(typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value));
            event.code = value;
            break;
        case 'matched': case 'dispatched': requireValid(typeof value === 'boolean'); event[key] = value; break;
        case 'modelCalls': event.modelCalls = integer(value, 0, 16); break;
        case 'attempts': event.attempts = integer(value, 0, 32); break;
        case 'phase': event.phase = choice(value, ['prepared', 'settled']); break;
        }
    }
    return event;
}

// The returned packet and persisted evidence share a closed data contract. It is
// historical evidence, never a capability to resume or relax write authorization.
function escalationSnapshot(value, packageName) {
    const keys = ['schemaVersion', 'taskId', 'step', 'reason', 'contextDiff', 'disposition', 'continuation',
        'evidenceFreshness', 'intent', 'inputRefs', 'scope', 'completion', 'loading', 'progress', 'counts',
        'remaining', 'observation', 'candidateObservationId', 'candidates', 'receipts',
        'decisionPolicyVersion', 'completionPolicyVersion', 'budget', 'loadingEvidence', 'decisionContext', 'candidateStep'];
    const data = record(value, [...keys, 'searchActions', 'route'], keys);
    const toggle = data.intent === 'set_toggle';
    const route = data.intent === 'route_search';
    const policy = taskPolicy(data.intent);
    requireValid(policy !== undefined && data.decisionPolicyVersion === policy.version
        && data.completionPolicyVersion === policy.completionVersion);
    const routeScope = route ? routeSchema.scope(data.route, packageName) : null;
    if (route) requireValid(data.loading === null && data.loadingEvidence === null && !Object.hasOwn(data, 'searchActions'));
    else requireValid(!Object.hasOwn(data, 'route'));
    if (toggle) requireValid(data.loading === null && data.loadingEvidence === null && !Object.hasOwn(data, 'searchActions'));
    requireValid(data.schemaVersion === 1 && ['search', 'set_toggle', 'route_search'].includes(data.intent) && data.continuation === 'not_authorized'
        && data.evidenceFreshness === 'historical');
    const budget = record(data.budget, BUDGET_KEYS, BUDGET_KEYS);
    const limitedId = value => { requireValid(typeof value === 'string' && value.length <= 320); return targetId(value, packageName); };
    const scopeKeys = ['serial', 'package', 'displayId', 'commands', 'policy'];
    const scope = record(data.scope, scopeKeys, scopeKeys);
    requireValid(scope.package === packageName && scope.displayId === 0 && scope.policy === 'recheck_required'
        && typeof scope.serial === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.serial));
    if (data.searchActions !== undefined) requireValid(data.intent === 'search');
    const searchActions = data.searchActions === undefined ? undefined : searchActionsSnapshot(data.searchActions, packageName);
    const expectedCommands = ['Tap', ...(toggle ? [] : ['Fill']), ...(searchActions?.scroll ? [searchActions.scroll.command] : []), ...(searchActions?.imeAction ? ['ImeAction'] : []), ...(searchActions?.back ? ['KeyEvent'] : [])];
    const commands = list(scope.commands, 5, (command, i) => choice(command, [expectedCommands[i]]));
    requireValid(commands.length === expectedCommands.length);
    const completion = record(data.completion, route ? ['type', 'id'] : toggle ? ['type', 'id', 'checked'] : ['type', 'id', 'item', 'minItems', 'absent', 'itemMatchesInput'], ['type', 'id']);
    requireValid(completion.type === (toggle ? 'checked' : 'visible'));
    const predicate = { type: completion.type, id: limitedId(completion.id) };
    if (toggle) { requireValid(typeof completion.checked === 'boolean' && budget.maxActions === 1); predicate.checked = completion.checked; }
    if (route) requireValid(predicate.id === routeScope.completion && budget.maxActions <= 3 && budget.maxObservations >= 8);
    for (const key of ['item', 'absent']) if (completion[key] !== undefined) predicate[key] = limitedId(completion[key]);
    if (completion.item !== undefined) predicate.minItems = integer(completion.minItems, 1, 50);
    else requireValid(completion.minItems === undefined && completion.itemMatchesInput === undefined);
    if (completion.itemMatchesInput !== undefined) {
        requireValid(typeof completion.itemMatchesInput === 'boolean'); predicate.itemMatchesInput = completion.itemMatchesInput;
    }
    const progressKeys = ['rounds', 'waits', 'consecutiveStale', 'verifiedReceiptIndexes'];
    const progress = record(data.progress, progressKeys, progressKeys);
    const countMax = { actions: route ? 3 : toggle ? 1 : 8, modelCalls: 16, mainModelCalls: 1, actionAttempts: 32, verifiedActions: route ? 3 : toggle ? 1 : 8, staleEvents: 8, observations: 256 };
    const counts = record(data.counts, [...Object.keys(countMax), 'humanHandoffs', 'mainModelRequests'], Object.keys(countMax));
    if (counts.humanHandoffs !== undefined) {
        countMax.humanHandoffs = 1;
        requireValid(counts.humanHandoffs + counts.mainModelCalls <= 1);
    }
    const remainingMax = { timeoutMs: 300000, actions: route ? 3 : toggle ? 1 : 8, observations: 256, modelCalls: 16, rounds: route ? 6 : toggle ? 4 : 8, waits: toggle || route ? 0 : 2 };
    const remaining = record(data.remaining, Object.keys(remainingMax), Object.keys(remainingMax));
    const receipts = list(data.receipts, 24, raw => {
        const r = record(raw, ['type', 'step', 'phase', 'targetId', 'outcome', 'requestId', 'code', 'scrollProof', ...(route ? ['inputRef'] : [])], ['type', 'step', 'phase', 'targetId', 'outcome']);
        requireValid(r.type === 'action' && r.phase === 'settled');
        limitedId(r.targetId);
        if (r.step === 'back') requireValid(r.targetId === searchActions?.back?.from);
        if (toggle) requireValid(r.step === 'toggle' && r.targetId === predicate.id);
        if (route) requireValid(r.step === 'route_fill' ? ['origin', 'destination'].includes(r.inputRef) && r.targetId === routeScope[r.inputRef]
            : r.step === 'route_submit' && r.targetId === routeScope.submit && r.inputRef === undefined);
        return eventSnapshot(r, packageName, toggle, route);
    });
    for (const receipt of receipts) if (receipt.scrollProof) requireValid(searchActions?.scroll?.maxSwipes > 1
        && receipt.targetId === searchActions.scroll.container);
    const verifiedReceiptIndexes = list(progress.verifiedReceiptIndexes, 8, index => integer(index, 0, Math.max(0, receipts.length - 1)));
    requireValid(JSON.stringify(verifiedReceiptIndexes) === JSON.stringify(receipts.flatMap((r, i) => r.outcome === 'verified' ? [i] : [])));
    if (data.step === 'back') requireValid(searchActions?.back);
    if (data.decisionContext) requireValid(data.decisionContext.version === policy.feedbackVersion);
    const fields = eventSnapshot({ type: 'escalation', step: data.step, code: data.reason,
        ...(data.observation === null ? {} : { observation: data.observation }), candidates: data.candidates }, packageName, toggle, route);
    fields.candidates.forEach(c => limitedId(c.targetId));
    // A terminal failure may retain candidates from an earlier decision. Their
    // stage and observation identity remain historical; they authorize no action.
    const candidateStep = data.candidateStep;
    if (candidateStep === null) requireValid(fields.candidates.length === 0
        && data.decisionContext === null && data.candidateObservationId === null);
    else choice(candidateStep, route ? ['route_fill', 'route_submit'] : toggle ? ['toggle']
        : ['entry', 'fill', 'submit', 'focus', 'seek', 'back']);
    if (toggle) requireValid(fields.candidates.every(c => c.targetId === predicate.id)
        && (!data.decisionContext || data.decisionContext.desiredChecked === predicate.checked));
    const routeContext = route && data.decisionContext ? routeSchema.context(data.decisionContext) : null;
    if (route) routeSchema.bindCandidates(candidateStep, fields.candidates, routeContext, routeScope);
    if (data.intent === 'search') fields.candidates.forEach(c => assertActionScope(candidateStep, c, searchActions));
    const contextDiff = list(data.contextDiff, CONTEXT_DIFF_TOKENS.length, token => choice(token, CONTEXT_DIFF_TOKENS));
    requireValid(new Set(contextDiff).size === contextDiff.length);
    const disposition = choice(data.disposition, ['assistance_required', 'hard_stop']);
    requireValid(disposition === escalationDisposition(data.reason, receipts));
    const loading = data.loading === null ? null : { id: limitedId(record(data.loading, ['id'], ['id']).id) };
    const loadingEvidence = data.loadingEvidence === null ? null
        : eventSnapshot({ type: 'observation', loading: data.loadingEvidence }, packageName).loading;
    requireValid(loading !== null || loadingEvidence === null);
    return { schemaVersion: 1, taskId: uuid(data.taskId), step: fields.step, reason: fields.code, contextDiff,
        disposition, continuation: 'not_authorized', evidenceFreshness: 'historical', intent: data.intent,
        inputRefs: route ? routeSchema.refs(data.inputRefs, true) : inputRefs(data.inputRefs, toggle ? 'checked' : 'query'),
        decisionPolicyVersion: data.decisionPolicyVersion, completionPolicyVersion: data.completionPolicyVersion,
        budget: Object.fromEntries(Object.entries(LIMITS).map(([key, max]) => [key, integer(budget[key], key === 'maxModelCalls' ? 0 : 1, max)])),
        scope: { serial: scope.serial, package: packageName, displayId: 0, commands, policy: 'recheck_required' }, completion: predicate, loading,
        ...(searchActions ? { searchActions } : {}),
        ...(routeScope ? { route: routeScope } : {}),
        progress: { rounds: integer(progress.rounds, 0, route ? 6 : toggle ? 4 : 8), waits: integer(progress.waits, 0, toggle || route ? 0 : 2),
            consecutiveStale: integer(progress.consecutiveStale, 0, 3), verifiedReceiptIndexes },
        counts: { ...Object.fromEntries(Object.entries(countMax).map(([key, max]) => [key, integer(counts[key], 0, max)])),
            ...(counts.mainModelRequests !== undefined ? { mainModelRequests: counts.mainModelRequests === null ? null : integer(counts.mainModelRequests, 0, 1) } : {}) },
        remaining: Object.fromEntries(Object.entries(remainingMax).map(([key, max]) => [key, integer(remaining[key], 0, max)])),
        observation: fields.observation || null, loadingEvidence,
        candidateStep,
        candidateObservationId: data.candidateObservationId === null ? null : uuid(data.candidateObservationId),
        candidates: fields.candidates, receipts,
        decisionContext: data.decisionContext === null ? null : route ? routeContext : toggle ? toggleContextSnapshot(data.decisionContext) : decisionContextSnapshot(data.decisionContext, packageName) };
}
// Validate data against the admitted task before it reaches storage.
function eventForTask(value, snapshot) {
    const packageName = snapshot.package;
    const toggle = snapshot.intent === 'set_toggle';
    const route = snapshot.intent === 'route_search';
    const jev = snapshot.decision === 'jev';
    const copy = eventSnapshot(value, packageName, toggle, route);
    if (route) {
        requireValid(copy.type !== 'wait');
        if (copy.type === 'candidates') {
            requireValid(copy.decisionContext?.observationId === copy.observation?.id);
            routeSchema.bindCandidates(copy.step, copy.candidates, copy.decisionContext, snapshot.route);
        }
        if (copy.inputRef !== undefined) requireValid(copy.type === 'action' && copy.step === 'route_fill');
        if (copy.expectId !== undefined) requireValid(copy.type === 'action' && copy.step === 'route_submit'
            && copy.phase === 'prepared' && copy.expectId === snapshot.route.completion);
        if (copy.targetId !== undefined) requireValid(copy.type === 'verification' ? copy.targetId === snapshot.route.completion
            : copy.type === 'action' && (copy.step === 'route_fill' ? copy.inputRef && copy.targetId === snapshot.route[copy.inputRef]
                : copy.step === 'route_submit' && copy.targetId === snapshot.route.submit && copy.inputRef === undefined));
        if (copy.escalation) requireValid(JSON.stringify(copy.escalation.route) === JSON.stringify(snapshot.route)
            && (copy.escalation.decisionContext?.observationId || null) === copy.escalation.candidateObservationId);
    }
    if (toggle) {
        requireValid(!['wait'].includes(copy.type));
        if (copy.targetId !== undefined) requireValid(copy.targetId === snapshot.toggle.id);
        if (copy.type === 'candidates') requireValid(copy.step === 'toggle'
            && copy.candidates?.length === 1 && copy.candidates[0].targetId === snapshot.toggle.id
            && copy.decisionContext?.observationId === copy.observation?.id
            && copy.decisionContext?.desiredChecked === snapshot.toggle.checked);
        if (copy.escalation) requireValid(copy.escalation.decisionPolicyVersion === snapshot.policyVersion
            && copy.escalation.completion.id === snapshot.toggle.id && copy.escalation.completion.checked === snapshot.toggle.checked
            && (copy.escalation.decisionContext?.observationId || null) === copy.escalation.candidateObservationId);
    }
    if (copy.step === 'back') requireValid(jev && snapshot.searchActions?.back
        && (copy.targetId === undefined || copy.targetId === snapshot.searchActions.back.from));
    if (copy.scrollProof) requireValid(jev && snapshot.searchActions?.scroll?.maxSwipes > 1
        && copy.targetId === snapshot.searchActions.scroll.container);
    if (copy.assistance) requireValid(jev && copy.assistance.mode === snapshot.assistance);
    if (jev && !toggle && !route) {
        if (copy.type === 'candidates') {
            requireValid(copy.decisionContext?.observationId === copy.observation?.id && Array.isArray(copy.candidates));
            assertScrollContext(copy.decisionContext, snapshot.searchActions);
            copy.candidates.forEach(c => assertActionScope(copy.step, c, snapshot.searchActions));
            copy.decisionContext.recentActions.forEach(a => assertActionScope(a.step,
                { ...a, semantics: a.step === 'focus' ? { role: 'textfield' } : undefined }, snapshot.searchActions));
        }
        if (copy.escalation) {
            requireValid((copy.escalation.decisionContext?.observationId || null) === copy.escalation.candidateObservationId);
            requireValid(JSON.stringify(copy.escalation.searchActions) === JSON.stringify(snapshot.searchActions));
            if (copy.escalation.decisionContext) assertScrollContext(copy.escalation.decisionContext, snapshot.searchActions);
            copy.escalation.decisionContext?.recentActions.forEach(a => assertActionScope(a.step,
                { ...a, semantics: a.step === 'focus' ? { role: 'textfield' } : undefined }, snapshot.searchActions));
        }
    } else if (!toggle && !route) {
        requireValid(!['seek', 'focus', 'back'].includes(copy.step)
            && !['candidates', 'recovery', 'wait', 'escalation', 'assistance'].includes(copy.type)
            && copy.decisionContext === undefined && copy.candidates === undefined);
    }
    if (copy.loading) requireValid(snapshot.loading !== undefined);
    if (copy.escalation) requireValid(jev && copy.escalation.decisionPolicyVersion === snapshot.policyVersion
        && copy.escalation.taskId === snapshot.taskId && copy.escalation.scope.serial === snapshot.serial
        && (copy.escalation.loading?.id || null) === (snapshot.loading?.id || null)
        && BUDGET_KEYS.every(key => copy.escalation.budget[key] === snapshot.budget[key]));
    return copy;
}

module.exports = { headerSnapshot, eventForTask };
