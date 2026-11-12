'use strict';
const { harness } = require('./android-service-harness.cjs');
const { createAndroidTaskExecutor } = require('../../modules/services/androidTaskExecutor');
const pkg = 'com.example';
const id = name => `${pkg}:id/${name}`;
const spec = extra => ({ serial: 'A', package: pkg, intent: 'search', decision: 'jev',
    inputs: { query: 'private query 731' }, completion: { type: 'visible', id: id('results') }, ...extra });
const response = (questions, selected) => {
    const key = Object.keys(questions)[0];
    return { answers: { [key]: { probabilities: Object.fromEntries(Object.keys(questions[key].criteria).map(id => [id, id === selected ? 1 : 0])) } } };
};

async function searchWorld(options = {}) {
    const events = [], models = [], actions = [], values = new Map();
    let page = options.start || 'home', version = 0, sampleCount = 0;
    const button = (name, label = 'Search', extra = {}) => ({ name, label, kind: 'Button', ...extra });
    const field = name => ({ name, label: values.get(name) || '', kind: 'EditText', password: options.password });
    const controls = () => {
        let nodes = page === 'home' ? [button('settings', 'Settings'), button('open')]
            : page.startsWith('entry_') ? [button(`route_${page.slice(6)}`)]
            : page === 'middle' ? [button('action_search')]
            : page === 'form' ? [field('query'), button('search_go')]
            : page === 'results' ? [button('results', 'Found results')]
            : [button('unrelated', 'Account settings')];
        if (options.noRelevant) nodes = [button('unrelated', 'Account settings')];
        if (options.twoChoices && page === 'home') nodes.push(button('menu_search'));
        if (options.twoFields && page === 'form') nodes.push(field('search_input'));
        if (options.duplicate && page === 'home') nodes.push(button('open', 'Search'));
        if (options.overflow && page === 'home') nodes = Array.from({ length: 9 }, (_, i) => button(`entry_${i}`));
        if (options.preexisting) nodes.push(button('results', 'Old results'));
        if (version) nodes.push(button('version', `v${version}`));
        if (options.nodes) nodes = options.nodes(nodes, page);
        return nodes.map((n, i) => ({ ...n, top: i * (options.overflow ? 20 : 45) }));
    };
    const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const xml = () => {
        sampleCount++;
        options.onCapture?.(sampleCount, { change: () => version++ });
        const tree = `<hierarchy rotation="0">${controls().map(n => `<node class="android.widget.${n.kind}" package="${pkg}" resource-id="${id(n.name)}" text="${escape(n.label)}" content-desc="${escape(n.desc || '')}" enabled="${n.enabled !== false}" clickable="${n.clickable !== false}" password="${n.password === true}" visible-to-user="${n.visible !== false}" bounds="[0,${n.top}][90,${n.top + 35}]"/>`).join('')}</hierarchy>`;
        return options.transformXml ? options.transformXml(tree) : tree;
    };
    const jev = options.jev === null ? null : { ...(options.modelTimeoutMs ? { async getStatus() { return { timeoutMs: options.modelTimeoutMs }; } } : {}), async decide(state, questions, request) {
        models.push({ state: structuredClone(state), questions, request });
        if (options.decide) return options.decide(state, questions, request);
        const candidate = state.candidates.find(c => c.targetId === id(options.twoChoices && page === 'home' ? 'menu_search'
            : page === 'home' ? 'open' : page === 'middle' ? 'action_search'
            : state.step === 'fill' ? options.twoFields ? 'search_input' : 'query' : 'search_go'));
        return response(questions, candidate?.candidateId || 'escalate');
    } };
    const store = options.traceStore || { async open(header) {
        events.push(header);
        return { async append(event) {
            if (options.traceFailAt === event.type) throw Error('private path');
            events.push(structuredClone(event));
        }, async close() {} };
    } };
    const executor = (options.executorFactory || createAndroidTaskExecutor)({ traceStore: store, jev });
    const h = await harness({ config: options.config, services: { androidTaskExecutor: executor, ...(options.services || {}) },
        ...(options.probeScreen ? { client: { probeScreen: options.probeScreen } } : {}),
        uiServer: { ok: true, xml, async invoke(method, params, request) {
            if (options.invoke) { const result = await options.invoke(method, params, request); if (result !== undefined) return result; }
            if (method === 'click') {
                const hit = controls().find(n => params[1] >= n.top && params[1] < n.top + 35);
                actions.push({ method, target: hit?.name, from: page });
                if (!options.noProgress) {
                    if (page === 'home' && hit?.name === (options.twoChoices ? 'menu_search' : 'open')) page = options.longRoute ? 'entry_0' : options.multiEntry ? 'middle' : 'form';
                    else if (page.startsWith('entry_')) page = `entry_${Number(page.slice(6)) + 1}`;
                    else if (page === 'middle' && hit?.name === 'action_search') page = options.cycle ? 'home' : 'form';
                    else if (page === 'form' && hit?.name === 'search_go') page = options.noResult ? 'form' : 'results';
                    else page = 'wrong';
                }
            }
            if (method === 'setText') {
                const name = params[0].resourceId.split(':id/')[1];
                actions.push({ method, target: name, from: page }); values.set(name, params[1]);
            }
            if (method === 'getText') return values.get(params[0].resourceId.split(':id/')[1]) || '';
            return true;
        } } });
    return { ...h, events, actions, models, run: (task = spec(), context = {}) => h.service.processToolCall({ command: 'RunTask', task }, context),
        change: () => version++, setPage: value => { page = value; }, setValue: (name, value) => values.set(name, value),
        get page() { return page; }, get values() { return values; } };
}
module.exports = { searchWorld, spec, response, pkg, id };
