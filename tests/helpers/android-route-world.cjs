'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { harness } = require('./android-service-harness.cjs');
const { createAndroidTaskExecutor } = require('../../modules/services/androidTaskExecutor');
const { createTaskTraceStore } = require('../../modules/services/androidTaskTrace');
const { response, id, pkg } = require('./android-search-world.cjs');
const INPUTS = Object.freeze({ origin: ' 起点 private origin 731 🚉 ', destination: '终点 private destination 829' });
const spec = (extra = {}) => ({ serial: 'A', package: pkg, intent: 'route_search', decision: 'jev', inputs: { ...INPUTS },
    targets: { form: id('route_form'), origin: id('route_origin'), destination: id('route_destination'), submit: id('route_go') },
    completion: { type: 'visible', id: id('route_results') }, ...extra });
const escape = v => v.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
async function routeWorld(options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-route-'));
    const state = { page: 'form', values: { origin: '', destination: '', ...options.values }, focus: options.focus ?? null,
        version: 0, captures: 0, actions: [], models: [], questions: [], submitted: null };
    const node = (name, cls, bounds, attrs = '') => `<node package="${pkg}" resource-id="${id(name)}" class="android.widget.${cls}" enabled="true" bounds="${bounds}" ${attrs}/>`;
    const xml = () => {
        state.captures++; options.onCapture?.(state);
        const children = state.page === 'form' ? `<node package="${pkg}" resource-id="${id('route_form')}" class="android.widget.LinearLayout" enabled="true" bounds="[0,0][100,190]">`
            + node('route_origin', 'EditText', '[10,25][90,55]', `clickable="true" password="false" text="${escape(state.values.origin)}" focused="${state.focus === 'origin'}"`)
            + node('route_destination', 'EditText', '[10,70][90,100]', `clickable="true" password="false" text="${escape(state.values.destination)}" focused="${state.focus === 'destination'}"`)
            + node('route_go', 'Button', '[10,130][90,160]', `clickable="true" text="Search routes" focused="${state.focus === 'submit'}"`) + '</node>'
            : node('route_results', 'TextView', '[10,40][90,80]', 'text="Private result label"');
        const tree = `<hierarchy rotation="0">${children}${node('clock', 'TextView', '[10,190][90,200]', `text="Clock ${state.version}"`)}</hierarchy>`;
        return options.xml ? options.xml(tree, state) : tree;
    };
    const backing = options.traceStore || createTaskTraceStore({ directory });
    const traceStore = { async open(header) { const trace = await backing.open(header); return { close: trace.close,
        async append(event) { await trace.append(event); options.onTrace?.(event, state); } }; } };
    const executor = (options.executorFactory || createAndroidTaskExecutor)({ traceStore, jev: options.noModel ? null : { async decide(model, questions, request) {
        state.models.push(structuredClone(model)); state.questions.push(structuredClone(questions));
        return options.decide ? options.decide(model, questions, state, request) : response(questions, 'c0');
    } } });
    const h = await harness({ services: { androidTaskExecutor: executor, ...options.services }, client: options.client,
        uiServer: { ok: true, xml, async invoke(method, params, request) {
            const ref = params[0]?.resourceId?.replace(`${pkg}:id/route_`, '');
            if (method === 'setText') state.actions.push({ method, ref, text: params[1] });
            if (method === 'click') state.actions.push({ method, params: [...params] });
            if (options.invoke) { const result = await options.invoke(method, params, state, request); if (result !== undefined) return result; }
            if (method === 'setText') { state.values[ref] = params[1]; state.focus = ref; }
            if (method === 'getText') return state.values[ref];
            if (method === 'click') { state.submitted = { ...state.values }; state.page = 'results'; state.focus = null; }
            return true;
        } } });
    let taskId;
    return { ...h, state, directory, async run(extra = {}, context = {}) {
        const result = await h.service.processToolCall({ command: 'RunTask', task: spec(extra) }, context);
        taskId = result.details.task.taskId; return result.details.task;
    }, async trace() {
        const name = taskId || (await fs.readdir(directory))[0]?.replace('.jsonl', '');
        return (await fs.readFile(path.join(directory, `${name}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    }, async close() { await fs.rm(directory, { recursive: true, force: true }); } };
}
module.exports = { routeWorld, spec, response, id, pkg, INPUTS };
