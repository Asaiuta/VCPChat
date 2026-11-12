'use strict';
// Declarative J5.3 replay interpreter. Cases are data only; this module maps the
// closed vocabulary onto the existing synthetic worlds and normalizes their
// device-side writes into an independent effect record.
const fs = require('node:fs');
const path = require('node:path');
const { actionWorld } = require('./android-search-actions-world.cjs');
const { toggleWorld } = require('./android-toggle-world.cjs');
const { routeWorld, INPUTS: ROUTE_INPUTS } = require('./android-route-world.cjs');
const { response, id } = require('./android-search-world.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_QUERY = 'private query 731';
const FAMILIES = Object.freeze({
    search: { policy: 'search-v9', inputs: { query: SEARCH_QUERY }, world: ['back', 'ime'],
        boxes: [['query', 40, 70], ['search_go', 100, 130]] },
    toggle: { policy: 'toggle-v1', inputs: {}, world: ['checked'], boxes: [['notifications', 40, 70]] },
    route: { policy: 'route-v1', inputs: ROUTE_INPUTS, world: ['prefilled'], boxes: [['route_go', 130, 160]] },
    ui_task: { policy: 'ui-task-v20', inputs: { query: SEARCH_QUERY }, world: ['back', 'scroll', 'loading', 'semantic'] }
});
const CASE_KEYS = new Set(['name', 'family', 'source', 'transforms', 'world', 'task', 'answers', 'transitions', 'assistance', 'expect']);
const EXPECT_KEYS = new Set(['status', 'code', 'writes', 'effect', 'receipts', 'modelCalls', 'staleEvents', 'replanCalls']);
const TASK_KEYS = new Set(['budget', 'assistance']);
const EFFECTS = new Set(['bump-version', 'satisfy', 'no-effect', 'lost-transport', 'cancel']);
const ANSWER = /^(c0|escalate|invalid|uncertain|role:(origin|destination)|op:(Tap|Fill|Scroll|Back|Done))$/;
const PRIVATE = /private query 731|private origin|private destination|Private setting|Private label|Private result|android\.widget/;

const fail = (name, message) => { throw new Error(`replay case ${name}: ${message}`); };
const only = (name, value, keys, label) => {
    for (const key of Object.keys(value || {})) if (!keys.has(key)) fail(name, `unknown ${label} key ${key}`);
};

function validateCatalog(catalog) {
    if (catalog.schemaVersion !== 1) throw new Error('replay catalog schemaVersion must be 1');
    const vocabulary = new Set(Object.keys(catalog.transforms || {}));
    const names = new Set();
    for (const c of catalog.cases) {
        only(c.name, c, CASE_KEYS, 'case'); only(c.name, c.expect, EXPECT_KEYS, 'expect'); only(c.name, c.task, TASK_KEYS, 'task');
        if (names.has(c.name)) fail(c.name, 'duplicate name'); names.add(c.name);
        const family = FAMILIES[c.family]; if (!family) fail(c.name, `unknown family ${c.family}`);
        only(c.name, c.world, new Set(family.world), 'world');
        if (c.source?.kind !== 'handwritten-synthetic' || !fs.existsSync(path.join(ROOT, c.source.derivedFrom || '\0'))) fail(c.name, 'source must name an existing handwritten derivation');
        if (!c.transforms?.length || c.transforms.some(t => !vocabulary.has(t))) fail(c.name, 'transforms outside catalog vocabulary');
        for (const a of c.answers || []) if (!ANSWER.test(a)) fail(c.name, `answer ${a}`);
        for (const t of c.transitions || []) {
            if (!['model', 'write'].includes(t.on) || !EFFECTS.has(t.effect)) fail(c.name, 'transition vocabulary');
            if (t.effect === 'satisfy' && c.family !== 'toggle') fail(c.name, 'satisfy is toggle-only');
            if (t.effect === 'cancel' && c.family !== 'ui_task') fail(c.name, 'cancel is ui_task-only');
        }
        if (!['completed', 'stopped'].includes(c.expect?.status) || !Array.isArray(c.expect.writes)) fail(c.name, 'expect.status and expect.writes are required');
    }
    return catalog;
}

// Each family must cover normal completion, stale recovery, a hard stop, an
// unknown write and an assistance channel; a gap is a catalog defect.
function coverage(catalog) {
    const gaps = [];
    for (const family of Object.keys(FAMILIES)) {
        const cases = catalog.cases.filter(c => c.family === family);
        const has = {
            completed: cases.some(c => c.expect.status === 'completed' && c.expect.writes.length),
            stale: cases.some(c => c.expect.staleEvents > 0),
            hardStop: cases.some(c => c.expect.status === 'stopped' && !(c.expect.receipts || []).includes('unknown')),
            unknownWrite: cases.some(c => (c.expect.receipts || []).includes('unknown')),
            assistance: cases.some(c => c.assistance)
        };
        for (const [kind, ok] of Object.entries(has)) if (!ok) gaps.push(`${family}:${kind}`);
    }
    return gaps;
}

function answer(token, model, questions) {
    const key = Object.keys(questions)[0];
    if (token === 'invalid') return {};
    if (token === 'uncertain') return { answers: { [key]: { probabilities: { c0: 0.5, escalate: 0.5 } } } };
    if (token.startsWith('role:')) {
        const hit = model.candidates.find(c => c.role === token.slice(5));
        if (!hit) throw new Error(`no candidate with ${token}`);
        return response(questions, hit.candidateId);
    }
    return response(questions, token);
}

function normalizeWrite(family, action) {
    const method = action.method || action.command;
    const box = y => FAMILIES[family].boxes.find(([, top, bottom]) => y >= top && y < bottom)?.[0] ?? `y${y}`;
    if (method === 'back') return { op: 'back' };
    if (method === 'pressKeyCode') return { op: 'key', target: 'ime' };
    if (method === 'click') return { op: 'tap', target: box(action.params[1]) };
    if (method === 'setText') {
        const target = action.ref ? `route_${action.ref}` : action.params[0].resourceId.split(':id/')[1];
        const ref = action.ref || target, text = action.ref ? action.text : action.params[1];
        // The catalog names only an input reference; the actual bytes must be
        // the original declared input so a renamed reference cannot pass.
        if (text !== FAMILIES[family].inputs[ref]) return { op: 'fill', target, value: 'mismatch' };
        return { op: 'fill', target, value: ref };
    }
    return { op: `other:${method}` };
}

function effectOf(family, state) {
    if (family === 'toggle') return { checked: state.checked };
    if (family === 'route') return { submitted: state.submitted
        ? Object.keys(ROUTE_INPUTS).filter(r => state.submitted[r] === ROUTE_INPUTS[r]) : null };
    return { page: state.page, query: state.value === SEARCH_QUERY ? 'query' : state.value === '' ? '' : 'mismatch' };
}

async function replay(c, overrides = {}) {
    if (c.family === 'ui_task') return require('./android-ui-task-replay.cjs').replayUi(c, overrides);
    const family = c.family, world = c.world || {}, answers = overrides.answers || c.answers || [];
    const transitions = overrides.transitions ?? (c.transitions || []);
    const assistance = overrides.assistance === undefined ? c.assistance : overrides.assistance;
    let w, models = 0, pending = null, replanCalls = 0;
    const apply = (effect, state) => {
        if (effect === 'bump-version') state.version++;
        if (effect === 'satisfy') state.checked = true;
    };
    const onCapture = state => {
        if (pending && --pending.left === 0) { apply(pending.effect, state); pending = null; }
    };
    const decide = (model, questions, state) => {
        models++;
        for (const t of transitions.filter(t => t.on === 'model' && [].concat(t.call).includes(models))) {
            if (t.afterCaptures) pending = { left: t.afterCaptures, effect: t.effect }; else apply(t.effect, state);
        }
        return answer(answers[models - 1] || 'c0', model, questions);
    };
    const writeEffect = state => transitions.find(t => t.on === 'write' && t.index === state.actions.length)?.effect;
    const human = { request: async () => { replanCalls++; if (assistance?.effect) apply(assistance.effect, w.state); return assistance?.human === 'accept'; } };
    const options = { decide, onCapture, services: { humanInteraction: human } };
    if (family === 'search') {
        Object.assign(options, { back: world.back, ime: world.ime,
            backKey(state) { const e = writeEffect(state); if (e !== 'no-effect') state.page = 'form'; if (e === 'lost-transport') throw Error('lost transport private query 731'); return ''; },
            invoke(method, params, state) {
                if (!['setText', 'click', 'pressKeyCode'].includes(method)) return undefined;
                const e = writeEffect(state); if (!e) return undefined; if (e === 'no-effect') return true;
                if (method === 'setText') state.value = params[1];
                else if (method === 'click' && params[1] < 80) state.focused = true; else state.page = 'results';
                throw Error('lost transport private query 731');
            } });
        w = await actionWorld(options);
    } else if (family === 'toggle') {
        Object.assign(options, { checked: world.checked, click(state) {
            const e = writeEffect(state); if (e !== 'no-effect') state.checked = !state.checked;
            if (e === 'lost-transport') throw Error('lost transport Private setting'); return true;
        } });
        w = await toggleWorld(options);
    } else {
        Object.assign(options, { values: Object.fromEntries((world.prefilled || []).map(r => [r, ROUTE_INPUTS[r]])),
            invoke(method, params, state) {
                if (!['setText', 'click'].includes(method)) return undefined;
                const e = writeEffect(state); if (!e) return undefined; if (e === 'no-effect') return true;
                const ref = params[0]?.resourceId?.replace(`${id('route_')}`, '');
                if (method === 'setText') { state.values[ref] = params[1]; state.focus = ref; }
                else { state.submitted = { ...state.values }; state.page = 'results'; state.focus = null; }
                throw Error('lost transport private origin');
            } });
        w = await routeWorld(options);
    }
    try {
        const context = {};
        if (assistance?.advice) context.androidTaskReplan = async p => {
            replanCalls++; if (assistance.effect) apply(assistance.effect, w.state);
            return { schemaVersion: 1, taskId: p.taskId, observationId: p.observationId, action: assistance.advice,
                ...(assistance.advice === 'select' ? { candidateId: 'c0' } : {}) };
        };
        const task = { ...(overrides.task ?? c.task ?? {}) };
        // actionWorld always declares searchActions; an empty declaration is
        // invalid for search-v9, so a plain form task must omit it entirely.
        if (family === 'search' && !world.back && !world.ime) task.searchActions = undefined;
        let result;
        try { result = await w.run(task, context); } catch (error) { result = { status: 'rejected', code: error.code }; }
        const rows = result.taskId ? await w.trace().catch(() => []) : [];
        return {
            result, rows, models: w.state.models,
            observed: {
                status: result.status, code: result.code ?? null,
                writes: w.state.actions.map(a => normalizeWrite(family, a)),
                effect: effectOf(family, w.state),
                receipts: (result.receipts || []).map(r => r.outcome),
                modelCalls: result.counts?.modelCalls, staleEvents: result.counts?.staleEvents, replanCalls
            }
        };
    } finally { await w.close(); }
}

module.exports = { FAMILIES, PRIVATE, validateCatalog, coverage, replay };
