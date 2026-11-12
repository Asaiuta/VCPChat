'use strict';
const { world, spec, response, id } = require('./android-ui-task-world.cjs');

// Adapter for the unified handwritten catalog. Expectations live in JSON;
// effects are read from this device world, independently of task receipts.
async function replayUi(c, overrides = {}) {
    const answers = overrides.answers ?? c.answers ?? [], transitions = overrides.transitions ?? c.transitions ?? [];
    const assistance = overrides.assistance === undefined ? c.assistance : overrides.assistance;
    const controller = new AbortController();
    let w, modelCalls = 0, reads = 0, replanCalls = 0, pending;
    const shellWrites = [], writes = [];
    const effect = (name, s) => {
        if (name === 'bump-version') s.revision++;
        if (name === 'cancel') controller.abort();
    };
    const wOptions = {
        onCapture(s) {
            reads++;
            if (pending && --pending.left === 0) { effect(pending.effect, s); pending = null; }
            if (c.world?.loading && reads >= 5) s.page = 'results';
        },
        nodes(s, defaults) {
            if (c.world?.loading && s.page !== 'results') return [{ name: 'loading', text: 'Loading' }];
            if (s.page === 'panel') return [{ name: 'panel', text: 'Detail panel', clickable: false }];
            if (c.world?.scroll && s.page === 'home') return [{ name: 'list', text: 'Results list', scrollable: true }];
            if (c.world?.semantic) return (s.page === 'results'
                ? [...defaults, { name: 'opaque_37', kind: 'TextView', clickable: false }] : defaults)
                .map(n => ({ ...n, noId: true, ...(n.name === 'opaque_37' ? { desc: 'Keywords' } : {}) }));
            return defaults;
        },
        transformXml: (xml, s) => xml.replace('<hierarchy rotation="0">', `<hierarchy rotation="0"><node package="com.example" class="android.widget.TextView" text="Revision ${s.revision}" enabled="true" visible-to-user="true" bounds="[0,160][90,190]"/>`),
        shell(args, s) {
            if (!args.includes('keyevent')) return;
            shellWrites.push({ op: 'back' }); writes.push(shellWrites.at(-1)); s.page = 'home'; return '';
        },
        decide(s, q, state) {
            modelCalls++;
            for (const tr of transitions.filter(t => t.on === 'model' && [].concat(t.call).includes(modelCalls))) {
                if (tr.afterCaptures) pending = { left: tr.afterCaptures, effect: tr.effect }; else effect(tr.effect, state);
            }
            const token = answers[modelCalls - 1];
            if (token === 'invalid') return {};
            if (token === 'escalate') return response(q, 'escalate');
            if (token === 'uncertain') {
                const a = response(q, 'escalate'), p = a.answers[Object.keys(q)[0]].probabilities;
                const op = Object.keys(p).find(k => !['wait', 'escalate'].includes(k));
                p.escalate = 0.5; p[op] = 0.5; return a;
            }
            const op = token?.startsWith('op:') ? token.slice(3) : s.hostCompletionMatched ? 'Done'
                : state.page === 'panel' ? 'Back' : state.page === 'home' ? c.world?.scroll ? 'Scroll' : 'Tap'
                    : !w.values.has('opaque_37') ? 'Fill' : 'Tap';
            const candidate = s.candidates.find(x => x.action.command === op && (op !== 'Tap'
                || s.elements.find(n => n.nodeRef === x.action.nodeRef)?.role !== 'textfield'));
            return response(q, ['Done', 'Back'].includes(op) ? op : candidate?.candidateId ?? 'escalate');
        },
        invoke(method, params, s, values) {
            const write = method === 'setText' ? { op: 'fill', target: 'query', value: params[1] === spec().inputs.query ? 'query' : 'mismatch' }
                : method === 'swipe' ? { op: 'scroll' } : method === 'click' ? { op: 'tap', target: s.page === 'home' ? 'entry' : 'submit' }
                    : { op: 'other:' + method };
            writes.push(write);
            const tr = transitions.find(t => t.on === 'write' && t.index === writes.length);
            if (tr?.effect === 'no-effect') return true;
            if (method === 'swipe') { s.page = 'form'; return true; }
            if (tr?.effect === 'lost-transport') {
                if (method === 'setText') values.set('opaque_37', params[1]);
                else if (method === 'click') s.page = s.page === 'home' ? 'form' : 'results';
                throw Object.assign(new Error('offline lost transport'), { code: 'UI_SERVER_RPC_TIMEOUT' });
            }
        },
        services: { humanInteraction: { request: async () => { replanCalls++; return assistance?.human === 'accept'; } } }
    };
    w = await world(wOptions);
    if (c.world?.back) w.state.page = 'panel';
    try {
        const context = { signal: controller.signal };
        if (assistance?.advice) context.androidTaskReplan = async p => {
            replanCalls++;
            return { schemaVersion: 1, taskId: p.taskId, observationId: p.observationId, action: assistance.advice,
                ...(assistance.advice === 'select' ? { candidateId: p.evidence.candidates[0].candidateId } : {}) };
        };
        const task = spec({ ...(c.world?.loading ? { loading: { id: id('loading') } } : {}),
            ...(c.world?.semantic ? { completion: { all: [
                { type: 'text', text: { selector: { desc: 'Keywords' }, inputRef: 'query' } },
                { type: 'visible', selector: { text: 'Found results' } }] } } : {}), ...(overrides.task ?? c.task ?? {}) });
        let result;
        try { result = (await w.run(task, context)).details.task; }
        catch (e) {
            if (e.code !== 'STEP_ABORTED') throw e;
            await Promise.all(w.executions);
            if (!w.results.length) throw e;
            // Runtime cancellation rejects the tool response even though the
            // executor has completed its stopped trace. Inspect that real result.
            result = w.results.at(-1);
        }
        return { result, rows: w.events, models: w.models, observed: { status: result.status, code: result.code ?? null,
            writes, effect: { page: w.state.page, query: w.values.has('opaque_37') ? w.values.get('opaque_37') === task.inputs.query ? 'query' : 'mismatch' : '' },
            receipts: result.receipts.map(r => r.outcome), modelCalls: result.counts.modelCalls,
            staleEvents: result.counts.staleEvents, replanCalls } };
    } finally { await w.close(); }
}
module.exports = { replayUi };
