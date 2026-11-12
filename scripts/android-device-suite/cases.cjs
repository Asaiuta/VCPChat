'use strict';
const assert = require('node:assert/strict');
const PACKAGE = 'com.vcpchat.m15fixture', PEER = 'com.vcpchat.fixturepeer';
const id = name => `${PACKAGE}:id/${name}`;
const CASES = Object.freeze([
    ['Hold800', 'touch'], ['Hold2000', 'touch'], ['Hold4000', 'touch'], ['TouchCancel', 'touch'],
    ['SelectedState', 'selected'], ['Toggle', 'toggle'], ['MultiPage', 'multi'], ['LostInputStops', 'lost'],
    ['ScrollThenOpen', 'scroll'], ['Loading', 'loading'], ['TransientCompletion', 'transient'], ['LoadingDeadline', 'stuck'],
    ['LaunchApp', 'launch'], ['SearchFromHome', 'm5:home'], ['NoEffectAlternative', 'm5:no-result'],
    ['StaleBeforeFill', 'm5:form'], ['CancelProvider', 'm5:form'],
].map(([name, variant]) => Object.freeze({ name, variant })));
const direct = c => c.name.startsWith('Hold') || c.name === 'TouchCancel';
const text = (name, inputRef) => ({ type: 'text', text: { id: id(name), inputRef } });
function taskFor(c, serial) {
    if (direct(c)) return null;
    const task = { serial, package: PACKAGE, intent: 'ui_task', decision: 'jev', goal: `Isolated fixture: ${c.name}`,
        inputs: {}, operations: ['Tap'], completion: { all: [{ type: 'visible', id: id('jd_done') }] },
        budget: { timeoutMs: 120000, maxActions: 1, maxObservations: 96, maxModelCalls: 8 } };
    if (c.name === 'SelectedState') task.completion = null; // Verify selected via model projection AND independent provider below.
    if (c.name === 'Toggle') task.completion.all = [{ type: 'checked', id: id('jd_toggle'), checked: true }];
    if (['MultiPage', 'LostInputStops'].includes(c.name)) {
        task.inputs = { first: 'North_中文', second: 'South_20261108' }; task.operations = ['Tap', 'Fill', 'Back'];
        task.budget.maxActions = 5;
        task.completion.all = [text('jd_first', 'first'), text('jd_second', 'second'), ...task.completion.all];
    }
    if (c.name === 'ScrollThenOpen') { task.operations = ['Tap', 'Scroll']; task.budget.maxActions = 12; task.budget.maxModelCalls = 16; task.budget.maxObservations = 160; }
    if (['Loading', 'TransientCompletion', 'LoadingDeadline'].includes(c.name)) task.loading = { id: id('jd_loading') };
    if (c.name === 'LoadingDeadline') { task.budget.timeoutMs = 9000; task.budget.maxObservations = 96; }
    if (c.name === 'LaunchApp') { task.operations = ['LaunchApp']; task.allowedPackages = [PACKAGE, PEER]; }
    if (c.variant.startsWith('m5:')) {
        task.operations = ['Tap', 'Fill']; task.inputs = { query: 'MuMu_中文_20261108' }; task.completion.all = [{ type: 'visible', id: id('m5_results') }];
        task.budget.maxActions = c.name === 'SearchFromHome' ? 3 : 2;
        if (c.name === 'NoEffectAlternative') { task.inputs = {}; task.completion.all = [{ type: 'visible', id: id('input') }]; }
    }
    return task;
}
function response(questions, selected) {
    const key = Object.keys(questions)[0];
    const branch = Object.keys(questions).find(k => k !== key && Object.hasOwn(questions[k].criteria, selected));
    const operation = branch ? branch.slice(key.length + 1) : selected;
    return { model: 'deterministic-device-fixture', answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name,
        { probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, Number(k === (name === key ? operation : name === branch ? selected : 'escalate'))])) }])) };
}
function choose(state, questions, command, resource, extra = {}) {
    const matches = state.candidates.filter(c => c.action.command === command
        && (!resource || state.elements.find(e => e.nodeRef === c.action.nodeRef)?.resourceId === id(resource))
        && Object.entries(extra).every(([key, value]) => c.action[key] === value));
    assert.equal(matches.length, 1, `Expected unique ${command} ${resource || ''}`);
    return response(questions, ['Done', 'Back'].includes(command) ? command : matches[0].candidateId);
}
async function decide(c, state, questions, request, ctx) {
    const pick = (command, resource, extra) => choose(state, questions, command, resource, extra);
    const element = name => state.elements.find(e => e.resourceId === id(name));
    if (c.name === 'CancelProvider') return new Promise((resolve, reject) => {
        const aborted = () => { ctx.providerAborted = true; reject(Object.assign(Error('cancelled'), { code: 'STEP_ABORTED' })); };
        if (request.signal.aborted) return aborted();
        request.signal.addEventListener('abort', aborted, { once: true });
        setTimeout(() => ctx.controller.abort(), 50);
    });
    if (c.name === 'SelectedState') {
        const selected = element('jd_select'); assert.ok(selected);
        if (ctx.calls === 1) { assert.equal(selected.selected, false); return pick('Tap', 'jd_select'); }
        assert.equal(selected.selected, true); assert.equal(state.recentActions.at(-1).changed, true);
        return pick('Done');
    }
    if (c.name === 'LaunchApp') return state.package === PEER ? pick('LaunchApp', null, { package: PACKAGE }) : pick('Done');
    if (c.name === 'NoEffectAlternative') {
        if (ctx.calls === 1) return pick('Tap', 'm5_search_go');
        if (ctx.calls === 2) {
            assert.equal(state.recentActions.at(-1).changed, false); assert.equal(ctx.read().m5.submissions, 1);
            assert.equal(state.candidates.some(v => v.action.command === 'Tap' && state.elements.find(e => e.nodeRef === v.action.nodeRef)?.resourceId === id('m5_search_go')), false);
            return pick('Tap', 'nav_keyboard');
        }
        return pick('Done');
    }
    if (c.variant.startsWith('m5:')) {
        if (element('m5_entry')) return pick('Tap', 'm5_entry');
        const field = element('m5_query');
        if (field && !field.inputMatches.includes('query')) {
            if (c.name === 'StaleBeforeFill' && !ctx.injected) {
                assert.equal(field.focused, true); const before = ctx.read();
                ctx.adb(['shell', 'input', 'keyevent', '123']); ctx.adb(['shell', 'input', 'text', '_external_drift']);
                const after = ctx.read(); assert.notEqual(after.m5.query, before.m5.query); assert.equal(after.m5.submissions, 0); ctx.injected = true;
            }
            return pick('Fill', 'm5_query', { inputRef: 'query' });
        }
        return field ? pick('Tap', 'm5_search_go') : pick('Done');
    }
    if (['MultiPage', 'LostInputStops'].includes(c.name)) {
        if (state.hostCompletionMatched) return pick('Done');
        if (element('jd_next')) {
            if (!element('jd_first').inputMatches.includes('first')) return pick('Fill', 'jd_first', { inputRef: 'first' });
            return pick('Tap', ctx.secondFilled ? 'jd_review' : 'jd_next');
        }
        if (!element('jd_second').inputMatches.includes('second')) { ctx.secondFilled = true; return pick('Fill', 'jd_second', { inputRef: 'second' }); }
        return pick('Back');
    }
    if (c.name === 'ScrollThenOpen') {
        if (state.hostCompletionMatched) return pick('Done');
        return element('jd_target') ? pick('Tap', 'jd_target') : pick('Scroll', 'jd_scroll', { direction: 'down' });
    }
    if (state.hostCompletionMatched) {
        if (['Loading', 'TransientCompletion'].includes(c.name)) { const j = ctx.read().journey; assert.equal(j.finalDone, true); assert.equal(j.loading, false); }
        return pick('Done');
    }
    if (c.name === 'Toggle') return pick('Tap', 'jd_toggle');
    assert.equal(ctx.calls, 1, 'loading must be resolved by the host without another decision');
    return pick('Tap', 'jd_start');
}
function verify(c, task, before, after, receipt, error, ctx) {
    const j = after.journey;
    if (c.name === 'CancelProvider') { assert.equal(error?.code || receipt?.code, 'STEP_ABORTED'); assert.equal(ctx.providerAborted, true); assert.equal(ctx.calls, 1); assert.deepEqual(after.m5, before.m5); return; }
    assert.ifError(error); assert.ok(receipt); assert.equal(receipt.counts.mainModelCalls, 0); assert.equal(receipt.counts.humanHandoffs, 0);
    if (c.name === 'LostInputStops') {
        assert.equal(receipt.code, 'TASK_PROGRESS_LOST'); assert.equal(receipt.status, 'stopped'); assert.equal(receipt.counts.actions, 4);
        assert.equal(j.first, ''); assert.equal(j.second, task.inputs.second); assert.equal(j.firstWrites, 1); assert.equal(j.secondWrites, 1); assert.equal(j.backs, 1); assert.equal(j.submissions, 0); return;
    }
    if (c.name === 'LoadingDeadline') {
        assert.equal(receipt.status, 'stopped'); assert.ok(['TASK_WAIT_TIMEOUT', 'TASK_DEADLINE', 'STEP_DEADLINE', 'TASK_BUDGET_EXHAUSTED'].includes(receipt.code), receipt.code);
        assert.equal(receipt.counts.actions, 1); assert.equal(ctx.calls, 1); assert.equal(j.starts, 1); assert.equal(j.done, false); assert.equal(j.loading, true); return;
    }
    assert.equal(receipt.status, c.name === 'SelectedState' ? 'unverified' : 'completed', JSON.stringify(receipt));
    assert.equal(receipt.independentlyVerified, c.name !== 'SelectedState');
    if (c.name === 'SelectedState') { assert.equal(j.selections, 1); assert.equal(j.selected, true); }
    else if (c.name === 'Toggle') { assert.equal(j.checked, true); assert.equal(j.toggles, 1); }
    else if (c.name === 'MultiPage') {
        assert.equal(j.first, task.inputs.first); assert.equal(j.second, task.inputs.second); assert.equal(j.firstWrites, 1); assert.equal(j.secondWrites, 1);
        assert.equal(j.nexts, 1); assert.equal(j.backs, 1); assert.equal(j.submissions, 1); assert.equal(receipt.counts.actions, 5);
    } else if (c.name === 'ScrollThenOpen') { assert.ok(j.scrollY > 0); assert.equal(j.targetClicks, 1); assert.equal(j.done, true); }
    else if (['Loading', 'TransientCompletion'].includes(c.name)) {
        assert.equal(ctx.calls, 2); assert.equal(j.starts, 1); assert.equal(j.finalDone, true); assert.equal(j.loading, false); assert.equal(j.pulses, c.name === 'TransientCompletion' ? 1 : 0);
    } else if (c.name === 'LaunchApp') { assert.equal(receipt.counts.actions, 1); assert.equal(ctx.calls, 2); assert.equal(j.done, true); }
    else if (c.name === 'NoEffectAlternative') { assert.equal(after.mode, 'keyboard'); assert.equal(ctx.calls, 3); assert.equal(receipt.counts.actions, 2); }
    else {
        assert.equal(after.m5.submissions, 1); assert.equal(after.m5.lastQuery, task.inputs.query); assert.equal(after.m5.resultVisible, true);
        assert.equal(after.m5.entries, c.name === 'SearchFromHome' ? 1 : 0); assert.equal(ctx.calls, 4);
        assert.equal(receipt.counts.staleEvents, c.name === 'StaleBeforeFill' ? 1 : 0);
    }
}
function verifyTouch(name, before, after) {
    assert.equal(before.downCount, 0); assert.equal(after.downCount, 1); assert.equal(after.activeTouch, false);
    if (name === 'TouchCancel') { assert.equal(after.cancelCount, 1); assert.equal(after.upCount, 0); assert.equal(after.holdCount, 0); assert.equal(after.tapCount, 0); }
    else {
        const requested = Number(name.slice(4)); assert.equal(after.cancelCount, 0); assert.equal(after.upCount, 1); assert.equal(after.holdCount, 1); assert.equal(after.tapCount, 0);
        for (const key of ['durationMs', 'wallDurationMs']) assert.ok(after[key] >= requested - 100 && after[key] <= requested + 500, `${key}=${after[key]}, requested=${requested}`);
    }
}
module.exports = { PACKAGE, PEER, id, CASES, direct, taskFor, response, choose, decide, verify, verifyTouch };
