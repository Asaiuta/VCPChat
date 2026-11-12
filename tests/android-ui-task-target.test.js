'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareTask } = require('../modules/services/androidTaskExecutor');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { rawEntries } = require('../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence');
const { completionEvidence } = require('../VCPDistributedServer/Plugin/AndroidController/lib/task-ui-evidence');
const { createTargetMatcher } = require('../VCPDistributedServer/Plugin/AndroidController/lib/task-ui-target');
const { world, spec, response, id } = require('./helpers/android-ui-task-world.cjs');

const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const node = (attrs = {}, children = '') => '<node ' + Object.entries({ package: 'com.example', class: 'android.widget.TextView',
    text: '', 'resource-id': '', 'content-desc': '', enabled: 'true', 'visible-to-user': 'true', password: 'false',
    bounds: '[0,0][90,150]', ...attrs }).map(([k,v]) => `${k}="${esc(v)}"`).join(' ') + '>' + children + '</node>';
const entries = tree => rawEntries(parseUiGraph(`<hierarchy rotation="0">${tree}</hierarchy>`,
    { rpcTarget: true, screen: { width: 100, height: 200 } }), { width: 100, height: 200 }, { excludeHiddenSubtrees: true });
const check = (all, tree, extra = {}, active = 'com.example') => {
    const task = prepareTask(spec({ completion: { all }, ...extra })), raw = entries(tree);
    return completionEvidence(task, raw, createTargetMatcher(task, raw, active)).matched;
};

for (const [name, selector, tree] of [
    ['exact text', { text: 'Saved', role: 'StaticText' }, node({ text: 'Saved' })],
    ['description', { desc: 'Status', class: 'TextView' }, node({ 'content-desc': 'Status', text: 'Saved' })],
    ['within', { text: 'Saved', within: { desc: 'Receipt' } }, node({ 'content-desc': 'Receipt' }, node({ text: 'Saved' }))],
    ['childOf', { text: 'Saved', childOf: { desc: 'Receipt' } }, node({ 'content-desc': 'Receipt' }, node({ text: 'Saved' }))],
    ['siblingOf', { text: 'Saved', siblingOf: { text: 'Status' } }, node({}, node({ text: 'Status' }) + node({ text: 'Saved' }))],
    ['hasDescendant', { class: 'LinearLayout', hasDescendant: { text: 'Saved' } }, node({ class: 'android.widget.LinearLayout' }, node({ text: 'Saved' }))]
]) test(`completion uses original ID-less ${name} evidence`, () => {
    assert.equal(check([{ type: 'visible', selector }], tree), true);
    assert.equal(check([{ type: 'visible', selector }], tree.replaceAll('Saved', 'Pending').replaceAll('Status', 'Other')), false);
});

for (const [name, extra] of [
    ['visible duplicate', {}], ['hidden duplicate', { 'visible-to-user': 'false' }],
    ['disabled duplicate', { enabled: 'false' }], ['offscreen duplicate', { bounds: '[0,250][90,280]' }]
]) test(`${name} does not become a unique completion target`, () => {
    for (const target of [{ selector: { desc: 'Status' } }, { id: id('status') }]) {
        assert.equal(check([{ type: 'visible', ...target }], node({ 'content-desc': 'Status', 'resource-id': id('status') })
            + node({ 'content-desc': 'Status', 'resource-id': id('status'), ...extra })), false);
    }
});

test('unsafe target or ancestor cannot prove completion, including a hidden descendant', () => {
    for (const attrs of [{ password: 'true' }, { enabled: 'false' }, { 'visible-to-user': 'false' }, { displayed: 'false' }]) {
        assert.equal(check([{ type: 'visible', selector: { text: 'Saved' } }], node(attrs, node({ text: 'Saved' }))), false);
    }
    assert.equal(check([{ type: 'visible', selector: { text: 'Saved' } }], node({ package: 'other.app', text: 'Saved' })), false);
});

test('missing, duplicate or unsafe relation anchor is unknown for absence', () => {
    const all = [{ type: 'absent', selector: { text: 'Error', within: { desc: 'Receipt' } } }];
    assert.equal(check(all, node({ text: 'Saved' })), false);
    assert.equal(check(all, node({ 'content-desc': 'Receipt' })), true);
    assert.equal(check(all, node({ 'content-desc': 'Receipt' }) + node({ 'content-desc': 'Receipt' })), false);
    assert.equal(check(all, node({ 'content-desc': 'Receipt', 'visible-to-user': 'false' })), false);
    assert.equal(check(all, node({ 'content-desc': 'Receipt' }, node({ text: 'Error', 'visible-to-user': 'false' }))), false);
});

test('an allowed foreground app cannot prove a target in another app absent', () => {
    const tree = node({ package: 'other.app', text: 'Saved' });
    const extra = { allowedPackages: ['com.example', 'other.app'] };
    assert.equal(check([{ type: 'absent', selector: { text: 'Error' } }], tree, extra, 'other.app'), false);
    assert.equal(check([{ type: 'visible', package: 'other.app', selector: { text: 'Saved' } }], tree, extra, 'other.app'), true);
});

test('text checks original full text, checked requires explicit raw booleans', () => {
    assert.equal(check([{ type: 'text', text: { selector: { desc: 'Author' }, equals: '白石定规', normalize: 'NFC_trim', stripPrefix: '作者：' } }],
        node({ 'content-desc': 'Author', text: ' 作者：白石定规 ' })), true);
    const checked = [{ type: 'checked', selector: { role: 'switch', desc: 'Notifications' }, checked: false }];
    const attrs = { class: 'android.widget.Switch', 'content-desc': 'Notifications', checkable: 'true' };
    assert.equal(check(checked, node(attrs)), false);
    assert.equal(check(checked, node({ ...attrs, checked: 'false' })), true);
    assert.equal(check(checked, node({ ...attrs, checked: 'true' })), false);
    assert.equal(check([{ type: 'visible', selector: { text: 'Title Author' } }],
        node({ clickable: 'true' }, node({ text: 'Title' }) + node({ text: 'Author' }))), false, 'aggregate labels cannot satisfy exact text');
});

test('ID-less rows require distinct fields in the same direct result row', () => {
    const fields = [{ selector: { desc: 'Title' }, equals: 'A' }, { selector: { desc: 'Author' }, equals: 'B' }];
    const all = [{ type: 'row', selector: { desc: 'Results' }, fields }];
    const row = (title, author) => node({ class: 'android.widget.LinearLayout' }, node({ 'content-desc': 'Title', text: title }) + node({ 'content-desc': 'Author', text: author }));
    assert.equal(check(all, node({ 'content-desc': 'Results' }, row('A','B'))), true);
    assert.equal(check(all, node({ 'content-desc': 'Results' }, row('A','X') + row('X','B'))), false);
    const aliases = [{ selector: { desc: 'Title' }, equals: 'A' }, { selector: { role: 'statictext', text: 'A' }, equals: 'A' }];
    assert.equal(check([{ type: 'row', selector: { desc: 'Results' }, fields: aliases }], node({ 'content-desc': 'Results' }, row('A','B'))), false);
});

test('target validation rejects fuzzy, positional, foreign and nested selectors without evaluating accessors', () => {
    const invalid = [ {}, { nth: 0, text: 'A' }, { regex: '.*' }, { contains: 'A' }, { any: 'A' }, { text: '' },
        { id: 'other.app:id/a' }, { id: id('a') + ':id/extra' }, { text: 'A', within: { text: 'B', childOf: { text: 'C' } } },
        { desc: 'x'.repeat(2001) }, { text: 'A\u0000B' } ];
    let getters = 0; invalid.push({ get text() { getters++; return 'A'; } });
    for (const selector of invalid) assert.throws(() => prepareTask(spec({ completion: { all: [{ type: 'visible', selector }] } })), { code: 'TASK_INVALID' });
    for (const target of [{ id: id('a'), selector: { text: 'A' } }, { id: id('a') + ':id/extra' }, { id: id('a'), package: 'com.example' },
        { selector: { text: 'A' }, package: 'other.app' }]) assert.throws(() => prepareTask(spec({ completion: { all: [{ type: 'visible', ...target }] } })), { code: 'TASK_INVALID' });
    assert.equal(getters, 0);
    const selector = { role: 'TextField', within: { desc: 'Form' } };
    const task = prepareTask(spec({ completion: { all: [{ type: 'visible', selector }] } }));
    selector.within.desc = 'Changed'; assert.equal(task.completion.all[0].selector.within.desc, 'Form');
    assert.ok(Object.isFrozen(task.completion.all[0].selector.within));
});

test('production loop binds an ID-less field by semantic target, then verifies the original text', async t => {
    const w = await world({ nodes: s => s.page === 'home' ? [{ name: 'query', noId: true, kind: 'EditText', desc: 'Keywords' }]
        : [{ name: 'results', text: 'unused' }],
        decide(s,q) { const c = s.candidates.find(c => c.action.command === (s.elements[0].inputMatches.length ? 'Done' : 'Fill')); return response(q, c.action.command === 'Done' ? 'Done' : c.candidateId); }
    }); t.after(w.close);
    const r = (await w.run(spec({ operations: ['Fill'], completion: { all: [{ type: 'text', text: {
        selector: { role: 'textfield', desc: 'Keywords' }, inputRef: 'query' } }] } }))).details.task;
    assert.equal(r.status, 'completed', JSON.stringify(r)); assert.equal(w.writes.length, 1);
    assert.equal(w.values.get('query'), spec().inputs.query);
    assert.doesNotMatch(JSON.stringify([r,w.events]), /Keywords|private query/);
});

test('an ambiguous declared field offers no Fill with its bound input', async t => {
    const w = await world({ nodes: () => [{ name: 'one', kind: 'EditText', desc: 'Keywords' }, { name: 'two', kind: 'EditText', desc: 'Keywords' }],
        decide(s,q) { assert.equal(s.candidates.some(c => c.action.command === 'Fill'), false); return response(q,'escalate'); } }); t.after(w.close);
    const r = (await w.run(spec({ completion: { all: [{ type: 'text', text: { selector: { desc: 'Keywords' }, inputRef: 'query' } }] } }))).details.task;
    assert.equal(r.status, 'stopped'); assert.equal(w.writes.length, 0);
});

test('selector loading uses host polling without model wait decisions', async t => {
    const w = await world({ nodes: s => s.revision < 3 ? [{ name:'loading', noId:true, desc:'Loading', clickable:false }]
        : [{ name:'ready', noId:true, text:'Saved', clickable:false }], onCapture(s) { s.revision++; },
        decide(s,q) { assert.equal(s.loading.active,false); return response(q,'Done'); } }); t.after(w.close);
    const r = (await w.run(spec({ loading:{ selector:{desc:'Loading'} }, completion:{all:[{type:'visible',selector:{text:'Saved'}}]} }))).details.task;
    assert.equal(r.status,'completed',JSON.stringify(r)); assert.equal(w.models.length,1); assert.equal(w.writes.length,0);
});
