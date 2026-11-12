'use strict';
const { harness } = require('./android-service-harness.cjs');
const { createAndroidTaskExecutor } = require('../../modules/services/androidTaskExecutor');
const { response } = require('./android-search-world.cjs');

const pkg = 'com.example';
const id = name => `${pkg}:id/${name}`;
const query = 'private completion input 943';
const completion = { type: 'visible', id: id('results'), item: id('item'), minItems: 2,
    itemMatchesInput: true, absent: id('blocker') };
const spec = (decision, extra = {}) => ({ serial: 'A', package: pkg, intent: 'search', decision,
    inputs: { query }, completion,
    ...(decision === 'jev' ? {} : { targets: { entry: id('open'), field: id('query'), submit: id('search_go') } }), ...extra });
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const node = (name, value, top, kind = 'Button', children = '') => `<node class="android.widget.${kind}" package="${pkg}" resource-id="${id(name)}" text="${escape(value)}" enabled="true" clickable="${kind !== 'TextView'}" bounds="[0,${top}][90,${top + 35}]">${children}</node>`;

async function fixture(options = {}) {
    let page = options.start || 'home', value = '', resultReads = 0, submittedAt;
    const events = [], writes = [], sampleTimes = [];
    const traceStore = { async open(header) {
        events.push(header);
        return { async append(event) {
            events.push(structuredClone(event));
            if (event.type === 'observation' && event.step === 'complete') sampleTimes.push(Date.now());
        }, async close() {} };
    } };
    const executor = createAndroidTaskExecutor({ traceStore, jev: { async decide(state, questions) {
        return Object.hasOwn(questions, 'target') ? { answers: { target: { probabilities: { c0: 1, none: 0 } } } } : response(questions, 'c0');
    } } });
    const xml = () => {
        if (page === 'results') resultReads++;
        const form = page === 'home' ? node('open', 'Search', 0) : page === 'form'
            ? node('query', value, 0, 'EditText') + node('search_go', 'Search', 45) : '';
        const elapsed = submittedAt === undefined ? 0 : Date.now() - submittedAt;
        const hasItems = page === 'results' ? resultReads > (options.delayItemsReads || 0)
            && elapsed >= (options.itemsAfterMs || 0) : options.oldItems;
        const items = hasItems ? node('item', 'other result', 105, 'TextView')
            + node('item', options.wrongItems ? 'unrelated result' : query, 115, 'TextView') : '';
        const marker = page === 'results' && elapsed >= (options.delayContainerMs || 0) || options.placeholder
            ? node('results', 'Results', 90, 'Button', items) : '';
        const blocker = options.blocked ? node('blocker', 'Loading', 155, 'TextView') : '';
        const loading = page === 'results' && !marker ? node('loading', 'Loading', 0, 'TextView') : '';
        return `<hierarchy rotation="0">${form}${marker}${blocker}${loading}</hierarchy>`;
    };
    const h = await harness({ services: { androidTaskExecutor: executor }, uiServer: { ok: true, xml,
        async invoke(method, params) {
            if (method === 'click') {
                writes.push(page === 'home' ? 'open' : 'submit');
                page = page === 'home' ? 'form' : 'results';
                if (page === 'results') submittedAt = Date.now();
            }
            if (method === 'setText') { writes.push('fill'); value = params[1]; }
            if (method === 'getText') return value;
            return true;
        } } });
    return { events, writes, sampleTimes, run: async task => (await h.service.processToolCall({ command: 'RunTask', task })).details.task };
}

module.exports = { fixture, spec, pkg, id, query };
