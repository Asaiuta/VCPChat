'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { harness } = require('./android-service-harness.cjs');
const { createAndroidTaskExecutor } = require('../../modules/services/androidTaskExecutor');
const { createTaskTraceStore } = require('../../modules/services/androidTaskTrace');
const { spec, response, id, pkg } = require('./android-search-world.cjs');

async function actionWorld(options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-search-actions-'));
    const state = { page: options.scroll || options.back ? 'hidden' : 'form', value: '', focused: options.focused === true,
        otherFocus: false, version: 0, captures: 0, actions: [], models: [] };
    const node = (name, kind, box, attrs = '') => `<node package="${pkg}" resource-id="${id(name)}" class="android.widget.${kind}" enabled="true" bounds="${box}" ${attrs}/>`;
    const escaped = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const xml = () => {
        state.captures++; options.onCapture?.(state);
        let children = state.page === 'results' ? node('results', 'TextView', '[10,50][90,80]', 'text="Found"')
            : state.page === 'hidden' ? node('placeholder', 'TextView', '[10,80][90,110]', 'text="Browse"')
            : node('query', 'EditText', options.edge ? '[0,0][90,35]' : '[10,40][90,70]', `text="${escaped(state.value)}" clickable="true" focused="${state.focused}" password="${options.password === true}"`)
                + (options.ime ? '' : node('search_go', 'Button', '[10,100][90,130]', 'text="Search" clickable="true"'));
        if (options.extraField) children += node('other', 'EditText', '[10,140][90,170]', `text="" focused="${state.otherFocus}"`);
        if (options.duplicate && state.page === 'form') children += node('query', 'EditText', '[10,140][90,170]', 'text=""');
        if (state.otherFocus && !options.extraField) children += node('other', 'TextView', '[10,140][90,170]', 'text="Other" focused="true"');
        if (state.version) children += node('clock', 'TextView', '[10,175][90,190]', `text="${state.version}"`);
        if (options.scroll) {
            const targetOutside = options.outside && state.page === 'form';
            children = `<node package="${pkg}" resource-id="${id('list')}" class="android.widget.ScrollView" enabled="true" scrollable="true" bounds="[0,0][100,200]">${targetOutside ? node('placeholder', 'TextView', '[10,80][90,110]', 'text="Browse"') : children}</node>${targetOutside ? children : ''}`;
        }
        const tree = `<hierarchy rotation="0">${children}</hierarchy>`;
        return options.xml ? options.xml(tree, state) : tree;
    };
    const traceStore = createTaskTraceStore({ directory });
    const executor = (options.executorFactory || createAndroidTaskExecutor)({ traceStore, jev: { async decide(model, questions) {
        state.models.push(structuredClone(model));
        if (options.decide) return options.decide(model, questions, state);
        return response(questions, model.candidates.length ? 'c0' : 'escalate');
    } } });
    const h = await harness({ services: { androidTaskExecutor: executor, ...(options.services || {}) }, config: options.config, client: options.client,
        async run(args, request) {
            if (args[1] === 'input' && args[2] === 'keyevent' && args[3] === 'KEYCODE_BACK') {
                state.actions.push({ command: 'back', args: [...args] });
                if (options.backKey) return options.backKey(state, request);
                state.page = 'form'; return '';
            }
            if (args[1] === 'input' && args[2] === 'swipe') {
                state.actions.push({ command: 'swipe', args: [...args] });
                if (options.swipe) return options.swipe(state, request);
                state.page = 'form'; return '';
            }
        },
        uiServer: { ok: true, xml, async invoke(method, params, request) {
            if (method === 'swipe') {
                state.actions.push({ command: 'swipe', args: ['shell', 'input', 'swipe', ...params.slice(0, 4).map(String), '300'] });
                if (options.swipe) { await options.swipe(state, request); return true; }
                state.page = 'form'; return true;
            }
            if (['setText', 'click', 'pressKeyCode'].includes(method)) state.actions.push({ command: method, params: structuredClone(params) });
            if (options.invoke) {
                const result = await options.invoke(method, params, state, request);
                if (result !== undefined) return result;
            }
            if (method === 'setText') state.value = params[1];
            if (method === 'getText') return state.value;
            if (method === 'click') { if (params[1] < 80) state.focused = true; else state.page = 'results'; }
            if (method === 'pressKeyCode') state.page = 'results';
            return true;
        } } });
    let taskId;
    return { ...h, state, directory, async run(extra = {}, context = {}) {
        const task = spec({ searchActions: { ...(options.ime ? { imeAction: options.ime } : {}),
            ...(options.back ? { back: { from: id('placeholder'), target: id('query') } } : {}),
            ...(options.scroll ? { scroll: { command: options.scroll, container: id('list'), target: id('query'), direction: options.direction || 'down' } } : {}) },
            ...extra });
        const result = (await h.service.processToolCall({ command: 'RunTask', task }, context)).details.task;
        taskId = result.taskId; return result;
    }, async trace() { return (await fs.readFile(path.join(directory, `${taskId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse); },
    async close() { await fs.rm(directory, { recursive: true, force: true }); } };
}
module.exports = { actionWorld };
