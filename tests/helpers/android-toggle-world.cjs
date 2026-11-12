'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { harness } = require('./android-service-harness.cjs');
const { createAndroidTaskExecutor } = require('../../modules/services/androidTaskExecutor');
const { createTaskTraceStore } = require('../../modules/services/androidTaskTrace');
const { response, id, pkg } = require('./android-search-world.cjs');
const spec = (extra = {}) => ({ serial: 'A', package: pkg, intent: 'set_toggle', decision: 'jev',
    inputs: { checked: true }, targets: { toggle: id('notifications') }, ...extra });
async function toggleWorld(options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-toggle-'));
    const state = { checked: options.checked ?? false, otherChecked: false, version: 0, captures: 0, actions: [], models: [], questions: [] };
    const xml = () => {
        state.captures++; options.onCapture?.(state);
        const node = `<node package="${pkg}" resource-id="${id('notifications')}" class="android.widget.Switch" text="Private setting 829" content-desc="Private label 731" clickable="true" checkable="true" checked="${state.checked}" enabled="true" bounds="[10,40][90,70]"/>`;
        const tree = `<hierarchy rotation="0">${node}<node package="${pkg}" resource-id="${id('other')}" class="android.widget.TextView" text="clock ${state.version}" enabled="true" bounds="[10,100][90,130]"/></hierarchy>`;
        return options.xml ? options.xml(tree, state) : tree;
    };
    const backingStore = options.traceStore || createTaskTraceStore({ directory });
    const traceStore = { async open(header) {
        const trace = await backingStore.open(header);
        return { close: trace.close, async append(event) { await trace.append(event); options.onTrace?.(event, state); } };
    } };
    const executor = (options.executorFactory || createAndroidTaskExecutor)({ traceStore,
        jev: options.noModel ? null : { async decide(model, questions, request) {
            state.models.push(structuredClone(model)); state.questions.push(structuredClone(questions));
            return options.decide ? options.decide(model, questions, state, request) : response(questions, 'c0');
        } } });
    const h = await harness({ services: { androidTaskExecutor: executor, ...options.services }, client: options.client,
        uiServer: { ok: true, xml, async invoke(method, params, request) {
            if (method === 'click') {
                state.actions.push({ method, params: structuredClone(params) });
                if (options.click) return options.click(state, request, params);
                state.checked = !state.checked;
            }
            return true;
        } } });
    let taskId, execution;
    return { ...h, state, directory, get execution() { return execution; }, async run(extra = {}, context = {}) {
        const result = await h.service.processToolCall({ command: 'RunTask', task: spec(extra) }, context);
        taskId = result.details.task.taskId; execution = result.details.execution; return result.details.task;
    }, async trace() {
        const name = taskId || (await fs.readdir(directory))[0]?.replace('.jsonl', '');
        return (await fs.readFile(path.join(directory, `${name}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    }, async close() { await fs.rm(directory, { recursive: true, force: true }); } };
}
module.exports = { toggleWorld, spec, response, id, pkg };
