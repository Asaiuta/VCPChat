'use strict';
const { harness } = require('./android-service-harness.cjs');
const { createAndroidTaskExecutor } = require('../../modules/services/androidTaskExecutor');
const schema = require('../../modules/services/androidUiTaskTrace');
const pkg = 'com.example', id = name => `${pkg}:id/${name}`;
const response = (questions, selected) => {
    const key = Object.keys(questions)[0];
    const branch = Object.keys(questions).find(k => k !== key && Object.hasOwn(questions[k].criteria, selected));
    const operation = branch ? branch.slice(key.length + 1) : selected;
    return { model: 'offline-fixture', answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name,
        { probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, Number(k === (name === key ? operation : name === branch ? selected : 'escalate'))])) }])) };
};
const spec = extra => ({ serial: 'A', package: pkg, intent: 'ui_task', decision: 'jev', goal: 'Find the requested book',
    inputs: { query: 'private query 731' }, completion: { all: [{ type: 'visible', id: id('results') }] }, ...extra });
async function world(options = {}) {
    const events = [], models = [], writes = [], results = [], executions = [], values = new Map();
    const state = { page: 'home', revision: 0, checked: false, package: pkg };
    const defaults = () => state.page === 'home' ? [{ name: 'odd_entry', text: 'Search', kind: 'Button' }]
        : state.page === 'form' ? [{ name: 'opaque_37', kind: 'EditText', hint: 'Keywords' }, { name: 'opaque_91', text: 'Search', kind: 'ImageView' }]
        : [{ name: 'results', text: 'Found results', kind: 'TextView', clickable: false }];
    const nodes = () => (options.nodes?.(state, defaults()) || defaults()).map((n, i) => ({ top: i * 40, ...n }));
    const resource = n => n.noId ? '' : n.id ?? `${state.package}:id/${n.name}`;
    const esc = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const xml = () => {
        options.onCapture?.(state);
        const tree = `<hierarchy rotation="0">${nodes().map(n => `<node class="android.widget.${n.kind || 'Button'}" package="${state.package}" resource-id="${esc(resource(n))}" text="${esc(values.get(n.name) ?? n.text)}" content-desc="${esc(n.desc)}" hint="${esc(n.hint)}" enabled="${n.enabled !== false}" clickable="${n.clickable !== false}" focused="${n.focused === true}" password="${n.password === true}" checkable="${n.checkable === true}" checked="${state.checked}" selected="false" scrollable="${n.scrollable === true}" long-clickable="${n.longClickable === true}" visible-to-user="${n.visible !== false}" bounds="[0,${n.top}][90,${n.top + 35}]"/>`).join('')}</hierarchy>`;
        return options.transformXml ? options.transformXml(tree, state) : tree;
    };
    const executor = createAndroidTaskExecutor({ traceStore: options.traceStore || { async open(header) {
        const h = schema.headerSnapshot(header); events.push(h);
        return { async append(e) { events.push(schema.eventForTask(e, h)); }, async close() {} };
    } }, jev: { async decide(body, questions, request) {
        models.push({ state: structuredClone(body), questions });
        if (options.decide) return options.decide(body, questions, state, response);
        const select = body.candidates.find(c => state.page === 'home' ? c.action.command === 'Tap'
            : state.page === 'form' && !values.has('opaque_37') ? c.action.command === 'Fill'
                : state.page === 'form' ? c.action.command === 'Tap' && body.elements.find(n => n.nodeRef === c.action.nodeRef)?.role !== 'textfield'
                    : c.action.command === 'Done');
        return response(questions, select?.action.command === 'Done' ? 'Done' : select?.candidateId || 'escalate');
    } } });
    const trackedExecutor = { ...executor, async run(...args) {
        const execution = executor.run(...args).then(result => { results.push(result); return result; });
        executions.push(execution); return execution;
    } };
    const h = await harness({ services: { ...options.services, androidTaskExecutor: trackedExecutor }, config: options.config,
        client: { async probeScreen() { if (options.probeScreen) { const value = options.probeScreen(state); if (value !== undefined) return value; } return { focus: { package: state.package, component: `${state.package}/.Main`, window: `Window{test u0 ${state.package}/.Main}` },
            size: { width: 100, height: 200 }, wakefulness: 'Awake', rotation: 0, displayId: 0, keyguard: { showing: false, inputRestricted: false } }; },
            async currentFocus() { return { package: state.package }; } },
        run: async args => {
            if (options.shell) { const value = await options.shell(args, state); if (value !== undefined) return value; }
            if (args.includes('keyevent')) { state.page = 'results'; return ''; }
            if (args.includes('packages')) return 'package:' + args.at(-1);
            if (args.includes('resolve-activity')) return args.at(-1) + '/.Main';
            if (args.includes('start') && args.includes('-n')) { state.package = args[args.indexOf('-n') + 1].split('/')[0]; return 'OK'; }
        },
        uiServer: { ok: true, xml, async invoke(method, params) {
            if (method === 'getText') {
                const n = nodes().find(n => params[0].resourceId ? resource(n) === params[0].resourceId : `android.widget.${n.kind}` === params[0].className);
                return values.get(n?.name) || '';
            }
            if (!['click', 'setText', 'clearTextField', 'pressKey', 'pressKeyCode', 'swipe'].includes(method)) return true;
            writes.push({ method, params: structuredClone(params) });
            if (options.invoke) { const result = await options.invoke(method, params, state, values); if (result !== undefined) return result; }
            if (method === 'setText') {
                const n = nodes().find(n => params[0].resourceId ? resource(n) === params[0].resourceId : `android.widget.${n.kind}` === params[0].className);
                values.set(n.name, params[1]);
            } else if (method === 'click') {
                const hit = nodes().find(n => params[1] >= n.top && params[1] < n.top + 35);
                if (state.page === 'home') state.page = 'form';
                else if (hit?.kind !== 'EditText') state.page = 'results';
            } else if (method === 'pressKeyCode') state.page = 'results';
            else if (method === 'pressKey') state.page = 'home';
            else if (method === 'swipe') state.page = 'results';
            return true;
        } } });
    return { ...h, state, models, writes, values, events, results, executions, run: (task, context) => h.service.processToolCall({ command: 'RunTask', task: task || spec() }, context),
        close: () => h.service.cleanup() };
}
module.exports = { world, spec, response, id, pkg };
