'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ui = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const vm = require('node:vm');
const selector = require('../VCPDistributedServer/Plugin/AndroidController/lib/selector');
const port = require('../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator');

const xmlNode = (attrs = '', children = '') => `<node class="android.widget.Button" package="com.demo" clickable="true" bounds="[10,10][100,50]" ${attrs}>${children}</node>`;
const parse = (nodes, options = {}) => ui.parseUiGraph(`<hierarchy>${nodes}</hierarchy>`, {
    screen: { width: 800, height: 800 }, ...options,
});

function rejects(value) {
    assert.equal(ui.validateSelector(value), false);
    assert.throws(() => ui.parseSelector(value), { code: 'ANDROID_SELECTOR_INVALID' });
    assert.equal(ui.resolveSelector([], value), null);
}

test('selector API is exported by both modules and parsed objects can be reused', () => {
    assert.equal(ui.parseSelector, selector.parseSelector);
    assert.equal(ui.validateSelector, selector.validateSelector);
    const graph = parse(xmlNode('text="Open" resource-id="com.demo:id/open"'));
    const parsed = ui.parseSelector({ id: 'com.demo:id/open', role: 'Button', nth: 0 });
    assert.equal(parsed.role, 'button');
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(ui.validateSelector(parsed), true);
    assert.equal(ui.resolveSelector(graph, parsed), graph.controls[0]);
    const legacy = ui.parseSelector('text=Open#1');
    assert.equal(ui.resolveSelector(graph, legacy), graph.controls[0]);
});

test('bare selector/id/text reject duplicates; findControls retains all hits', () => {
    const graph = parse(xmlNode('text="Open" resource-id="com.demo:id/open"')
        + xmlNode('text="Open" resource-id="com.demo:id/open"'));
    for (const value of ['text=Open', 'id=com.demo:id/open', { text: 'Open' }, { id: 'com.demo:id/open' }, 'role=Button']) {
        assert.equal(ui.resolveSelector(graph, value), null);
        assert.equal(ui.findControls(graph, value).length, 2);
    }
    assert.equal(ui.resolveSelector(graph, 'text=Open#1'), graph.controls[0]);
    assert.equal(ui.resolveSelector(graph, 'id=com.demo:id/open#2'), graph.controls[1]);
    for (const value of ['text=Open#0', 'text=Open#9007199254740992']) rejects(value);
    assert.equal(ui.resolveSelector(graph, 'text=Open#3'), null);
});

test('legacy #N is one-based XML order; nth is zero-based screen order, not identity', () => {
    const graph = parse(xmlNode('text="Same" bounds="[50,400][100,450]"')
        + xmlNode('text="Same" bounds="[50,100][100,150]"')
        + xmlNode('text="Same" bounds="[10,100][40,150]"'));
    assert.equal(ui.resolveSelector(graph, 'text=Same#1'), graph.controls[0]);
    assert.equal(ui.resolveSelector(graph, { text: 'Same', nth: 0 }), graph.controls[2]);
    assert.equal(ui.resolveSelector(graph, { text: 'Same', nth: 1 }), graph.controls[1]);
    assert.equal(ui.resolveSelector(graph, { text: 'Same', nth: 2 }), graph.controls[0]);
    assert.equal(ui.resolveSelector(graph, { text: 'Same', nth: 3 }), null);
    assert.deepEqual(graph.controls.map(c => c.index), [0, 1, 2], 'matching must not reorder presentation');
    const boxes = [[1, 2, 8, 9], [1, 2, 7, 10], [1, 2, 7, 9], [1, 2, 7, 9]];
    const controls = boxes.map(([top, left, bottom, right], index) => ({
        index, text: 'tie', bounds: { top, left, bottom, right },
    }));
    assert.deepEqual([0, 1, 2, 3].map(nth => ui.resolveSelector(controls, { text: 'tie', nth }).index), [2, 3, 1, 0]);
    const reordered = parse(xmlNode('text="Same" bounds="[10,100][40,150]"')
        + xmlNode('text="Same" bounds="[50,400][100,450]"'));
    assert.notEqual(ui.resolveSelector(reordered, 'text=Same#1').y, graph.controls[0].y);
});

test('single conditions, AND objects, short/full classes and existing roles', () => {
    const graph = parse(xmlNode('text="Open invoice 42" resource-id="com.demo:id/action"')
        + xmlNode('text="Open profile" class="com.custom.Button"')
        + xmlNode('text="Compose toggle" class="android.view.View"'));
    const target = graph.controls[0];
    for (const query of ['contains=invoice', 'regex=^Open invoice [0-9]+$', 'class=android.widget.Button', {
        id: 'com.demo:id/action', text: 'Open invoice 42', contains: 'invoice',
        regex: '^Open.*42$', class: 'Button', role: 'button',
    }]) assert.equal(ui.resolveSelector(graph, query), target);
    assert.equal(ui.findControls(graph, 'class=Button').length, 2);
    assert.equal(ui.resolveSelector(graph, 'class=Button'), null);
    assert.equal(ui.resolveSelector(graph, { contains: 'invoice', role: 'view' }), null);
    assert.equal(ui.resolveSelector(graph, 'role=View'), graph.controls[2]);
    assert.equal(graph.controls[2].role, 'view', 'a Compose View is not an inferred button role');
    assert.equal(target.fullClass, 'android.widget.Button');
    assert.equal(Object.keys(target).includes('fullClass'), false);
    assert.equal(JSON.stringify(target).includes('fullClass'), false);
});

test('strict validation rejects unknown keys, invalid types, empty conditions and recursive scope', () => {
    const invalid = [null, undefined, 1, true, [], new String('text=a'), /a/, new Date(),
        '', 'a', 'text=', 'id=', 'contains=', 'regex=', 'class=', 'role=', {}, { nth: 0 },
        { within: 'text=a' }, { text: '' }, { contains: ' ' }, { regex: /a/ }, { text: 1 },
        { id: null }, { class: ['Button'] }, { role: true }, { text: 'a', extra: true },
        { text: 'a', nth: '0' }, { text: 'a', nth: -1 }, { text: 'a', nth: 0.5 },
        { text: 'a', nth: Infinity }, { text: 'a', nth: NaN }, { text: 'a', nth: 2 ** 53 },
        { text: 'a', within: {} }, { text: 'a', within: null }, { text: 'a', within: 1 },
        { text: 'a', within: { id: 'parent', within: 'id=root' } },
        { text: 'a', [Symbol('unknown')]: 1 },
        Object.assign(Object.create({ inherited: true }), { text: 'a' }),
    ];
    for (const value of invalid) rejects(value);
    let read = false;
    const accessor = Object.defineProperty({}, 'text', { get() { read = true; return 'a'; } });
    rejects(accessor);
    assert.equal(read, false, 'validation must not invoke selector getters');
    const cyclic = { text: 'a' }; cyclic.within = cyclic;
    rejects(cyclic);
    assert.equal(ui.validateSelector({ text: 'a', nth: Number.MAX_SAFE_INTEGER }), true);
    assert.equal(ui.validateSelector({ text: 'a', within: 'id=parent' }), true);
    assert.equal(ui.validateSelector(Object.assign(Object.create(null), { text: 'a' })), true);
});

test('escaping round-trips literal ordinals; unlabeled controls are snapshot-only, not empty text selectors', () => {
    const graph = parse(xmlNode('text="Item#1"') + xmlNode('text="Item%23#1"') + xmlNode());
    for (const control of graph.controls.slice(0, 2)) assert.equal(ui.resolveSelector(graph, control.selector), control);
    assert.equal(graph.controls[2].selector, null);
    assert.equal(ui.validateSelector('text=#1'), false);
    assert.equal(ui.resolveSelector(graph, 'text=Item%231'), graph.controls[0]);
    assert.equal(ui.resolveSelector(graph, { text: 'Item#1' }), graph.controls[0]);
    assert.equal(ui.validateSelector({ text: '' }), false);
    assert.equal(ui.resolveSelector(graph, { text: '' }), null);
    assert.deepEqual(ui.findControls(graph, { text: '' }), []);
});

test('within addresses pruned raw parents and uses strict XML descendants, never bounds containment', () => {
    const children = '<node class="android.widget.LinearLayout" resource-id="com.demo:id/group" bounds="[0,0][20,20]">'
        + xmlNode('text="Inside tree" bounds="[200,200][300,250]"') + '</node>'
        + xmlNode('text="Geometric sibling" bounds="[1,1][10,10]"');
    const graph = parse(children, { rpcTarget: true });
    assert.equal(graph.controls.some(c => c.id === 'com.demo:id/group'), false, 'pruning stays unchanged');
    assert.equal(ui.resolveSelector(graph, { contains: 'Inside', within: 'id=com.demo:id/group' }), graph.controls[0]);
    assert.equal(ui.resolveSelector(graph, { contains: 'Inside', within: { class: 'android.widget.LinearLayout' } }), graph.controls[0]);
    assert.equal(ui.resolveSelector(graph, { contains: 'sibling', within: 'id=com.demo:id/group' }), null);
    assert.equal(ui.resolveSelector(graph, { text: 'Inside tree', within: 'text=Inside tree' }), null, 'self is not a descendant');
    assert.equal(graph.controls[0].rawNode, graph.rawRoot.children[0].children[0]);
    assert.equal(graph.controls[0].rawNode.parent, graph.rawRoot.children[0]);
    const ordinary = parse(children);
    assert.equal(Object.hasOwn(ordinary, 'rawRoot'), false);
    assert.equal(ui.resolveSelector(ordinary.controls, { contains: 'Inside', within: 'id=com.demo:id/group' }), ordinary.controls[0]);
});

test('within parent must be unique across the original tree; explicit parent ordinal is allowed', () => {
    const group = text => '<node class="android.widget.LinearLayout" resource-id="com.demo:id/group" bounds="[0,0][500,500]">'
        + xmlNode(`text="${text}"`) + '</node>';
    const graph = parse(group('First') + group('Second'));
    assert.equal(ui.resolveSelector(graph, { text: 'First', within: 'id=com.demo:id/group' }), null);
    assert.equal(ui.resolveSelector(graph, { text: 'First', within: 'id=com.demo:id/missing' }), null);
    assert.equal(ui.resolveSelector(graph, { text: 'First', within: 'id=com.demo:id/group#1' }), graph.controls[0]);
    assert.equal(ui.resolveSelector(graph, { text: 'Second', within: { id: 'com.demo:id/group', nth: 1 } }), graph.controls[1]);
    assert.equal(ui.resolveSelector(graph, { text: 'First', within: { id: 'com.demo:id/group', nth: 1 } }), null);
});

test('aggregated host label requires explicit any, including within host scopes', () => {
    const graph = parse('<node class="android.widget.LinearLayout" clickable="true" resource-id="com.demo:id/card" bounds="[0,0][500,500]">'
        + '<node class="android.widget.TextView" text="Invoice" bounds="[10,10][200,50]" />'
        + '<node class="android.widget.TextView" text="Paid" bounds="[10,60][200,100]" />'
        + xmlNode('text="Delete" bounds="[300,300][400,350]"') + '</node>', { rpcTarget: true });
    const host = graph.controls[0];
    assert.equal(host.label, 'Invoice / Paid');
    assert.equal(host.rawNode.attrs.text, undefined);
    assert.equal(ui.resolveSelector(graph, 'contains=Paid'), null, 'contains is raw text only');
    assert.equal(ui.resolveSelector(graph, 'any=Invoice / Paid'), host);
    assert.equal(ui.resolveSelector(graph, 'text=Invoice'), null);
    assert.equal(ui.resolveSelector(graph, { text: 'Delete', within: 'any=Invoice / Paid' }), graph.controls[1]);
    assert.equal(host.rawNode, graph.rawRoot.children[0]);
});

test('wrapper folding keeps surviving inner provenance even when outer identity is inherited', () => {
    const graph = parse('<node class="android.widget.LinearLayout" resource-id="com.demo:id/outer" clickable="true" bounds="[0,0][500,500]">'
        + '<node class="android.view.View" clickable="true" bounds="[0,0][500,500]" />'
        + '</node>', { rpcTarget: true });
    assert.equal(graph.controls.length, 1);
    const control = graph.controls[0];
    assert.equal(control.id, 'com.demo:id/outer');
    assert.equal(control.rawNode, graph.rawRoot.children[0].children[0]);
    assert.equal(ui.resolveSelector(graph, { id: 'com.demo:id/outer', within: 'id=com.demo:id/outer' }), control);
});

test('provenance preserves package/system rules and port pruning for named, absent and chrome packages', () => {
    const xml = '<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][800,800]">'
        + xmlNode('text="App" package="com.demo"')
        + xmlNode('text="No package" package=""')
        + xmlNode('text="Chrome" package="com.android.systemui"')
        + xmlNode('text="Chrome rid" package="com.demo" resource-id="android:id/navigationBarBackground"')
        + xmlNode('text="Keyboard" package="com.android.inputmethod.latin"') + '</node></hierarchy>';
    for (const includeSystem of [false, true]) {
        const graph = ui.parseUiGraph(xml, { screen: { width: 800, height: 800 }, includeSystem, rpcTarget: true });
        const reference = port.parseUiAutomatorTree(port.parseUiAutomatorXml(xml), 800, 800, { includeSystem });
        const expected = reference.children.filter(n => includeSystem || !/inputmethod|ime$|inputmethod\.latin/i.test(n.package || ''));
        assert.deepEqual(graph.controls.map(c => [c.label, c.package, c.fullClass]), expected.map(n => [n.label, n.package || '', n.cls]));
        assert.ok(graph.controls.every(c => typeof c.package === 'string'));
        assert.deepEqual(graph.rawRoot, port.parseUiAutomatorXml(xml), 'raw attributes are not boxed or rewritten');
        for (const c of graph.controls) assert.equal(c.rawNode.attrs.text, c.label);
    }
});

test('truncation retains complete matching evidence for uniqueness, nth and selector generation', () => {
    const graph = parse(xmlNode('text="Same" bounds="[10,400][100,450]"')
        + xmlNode('text="Same" bounds="[10,10][100,50]"') + xmlNode('text="Hidden unique"'), { limit: 1 });
    assert.equal(graph.truncated, true);
    assert.equal(graph.controls.length, 1);
    assert.equal(ui.findControls(graph, 'text=Same').length, 2);
    assert.equal(ui.resolveSelector(graph, 'text=Same'), null);
    assert.equal(ui.resolveSelector(graph, 'text=Same#2'), graph.matchingControls[1]);
    assert.equal(ui.resolveSelector(graph, { text: 'Same', nth: 0 }), graph.matchingControls[1]);
    assert.equal(graph.controls[0].selector, 'text=Same#1');
    assert.equal(ui.resolveSelector(graph.controls, 'text=Same'), null);
    assert.equal(ui.resolveSelector(graph, 'text=Hidden unique'), graph.matchingControls[2]);
    assert.equal(Object.keys(graph).includes('matchingControls'), false);
    assert.equal(JSON.stringify(graph).includes('Hidden unique'), false);
    const withoutEvidence = JSON.parse(JSON.stringify(graph));
    assert.equal(ui.resolveSelector(withoutEvidence, 'text=Same'), null);
    assert.equal(ui.resolveSelector(withoutEvidence, { text: 'Same', nth: 0 }), null);
});

test('raw provenance and scope evidence never serialize raw passwords', () => {
    const graph = parse('<node class="android.widget.EditText" password="true" text="super-secret-password" resource-id="com.demo:id/password" bounds="[0,0][200,50]" />', { rpcTarget: true });
    const control = graph.controls[0];
    assert.equal(control.rawNode.attrs.text, 'super-secret-password', 'raw evidence remains available only internally');
    for (const key of ['rawNode', 'fullClass']) assert.equal(Object.getOwnPropertyDescriptor(control, key).enumerable, false);
    for (const key of ['rawRoot', 'matchingControls', 'scopeControls']) assert.equal(Object.getOwnPropertyDescriptor(graph, key).enumerable, false);
    assert.equal(Object.getOwnPropertyDescriptor(control.rawNode, 'parent').enumerable, false);
    assert.equal(JSON.stringify(graph).includes('super-secret-password'), false);
    assert.equal(JSON.stringify(graph.scopeControls).includes('super-secret-password'), false);
    assert.equal(ui.resolveSelector(graph, 'contains=super-secret'), null);
    assert.equal(ui.resolveSelector(graph, 'regex=super-secret.*'), null);
});

test('bounded regex matches a linear grammar with independent native reference results', () => {
    const patterns = ['^a[0-9]+$', 'a.*b', '^a?b*$', '[^ab]+', '\\d+\\s\\w?', '^a\\+b$', 'a+b?', '^$', '[a-c]*x', '\\D+', 'b$'];
    const samples = ['', 'a', 'b', 'ab', 'a1', 'a123', 'a+b', '123 x', 'xyz', 'a\nb', 'cx', 'abbbc', 'b\n'];
    for (const pattern of patterns) {
        assert.equal(ui.validateSelector({ regex: pattern }), true, pattern);
        const native = new RegExp(pattern);
        for (const label of samples) {
            const actual = ui.findControls([{ text: label }], { regex: pattern }).length > 0;
            // This subset intentionally treats $ as strict end, not pre-final-newline.
            const expected = pattern.endsWith('$') && label.endsWith('\n') ? false : native.test(label);
            assert.equal(actual, expected, `${pattern} on ${JSON.stringify(label)}`);
        }
    }
});

test('regex rejects unsupported/catastrophic syntax without an unbounded native fallback', () => {
    rejects({ regex: 'a'.repeat(selector.MAX_PATTERN_LENGTH + 1) });
    for (const pattern of ['[', '\\', '*a', '[z-a]', 'a**']) rejects({ regex: pattern });
    if (selector.regexEngine === 'linear-subset') {
        for (const pattern of ['(a+)+$', '(a|aa)+$', '(a*)*b', '(?=a)', '(a)\\1', 'a{1,1000000}', 'a|b']) rejects({ regex: pattern });
    }
    const tooLong = 'a'.repeat(selector.MAX_REGEX_TEXT_LENGTH + 1);
    assert.equal(ui.resolveSelector([{ text: 'a' }, { text: tooLong }], { regex: '^a+$' }), null,
        'over-budget potential duplicate cannot turn an ambiguous query into a unique target');
    assert.equal(ui.resolveSelector([{ text: 'a'.repeat(2000) + '!' }], { regex: `${'a*'.repeat(40)}b$` }), null);
});


test('plain JSON selectors cross VM realms without accepting class instances or accessors', () => {
    const graph = parse('<node class="android.widget.LinearLayout" resource-id="com.demo:id/parent" bounds="[0,0][500,500]">'
        + xmlNode('text="Open"') + '</node>');
    const query = vm.runInNewContext('JSON.parse(\'{"text":"Open","within":{"id":"com.demo:id/parent"}}\')');
    assert.equal(ui.validateSelector(query), true);
    assert.equal(ui.resolveSelector(graph, query), graph.controls[0]);
    assert.equal(ui.validateSelector(vm.runInNewContext('Object.assign(Object.create(null), {text:"Open"})')), true);
    for (const expression of ['new Date()', 'new (class Query { constructor(){ this.text="Open"; } })()',
        '({ get text(){ throw new Error("must not execute"); } })']) {
        rejects(vm.runInNewContext(expression));
    }
});

test('evidence-aware evaluation distinguishes complete duplicates/absence from uncertainty', () => {
    assert.equal(ui.evaluateSelector, selector.evaluateSelector);
    const graph = parse(xmlNode('text="Same"') + xmlNode('text="Same"'));
    assert.deepEqual(ui.evaluateSelector(graph, 'text=Same'), {
        hits: graph.controls, complete: true, ambiguous: true,
    });
    assert.deepEqual(ui.evaluateSelector(graph, 'text=Missing'), { hits: [], complete: true, ambiguous: false });
    assert.deepEqual(ui.evaluateSelector(graph, { text: 'Same', nth: 0 }), {
        hits: [graph.controls[0]], complete: true, ambiguous: false,
    });
    for (const source of [null, undefined, {}, { controls: graph.controls, truncated: true }]) {
        assert.equal(ui.evaluateSelector(source, 'text=Missing').complete, false);
    }
    assert.equal(ui.evaluateSelector(graph, { text: '' }).complete, false);
    assert.equal(ui.evaluateSelector(graph, { text: 'Same', within: 'text=Same' }).complete, false);
    assert.equal(ui.evaluateSelector(graph, { text: 'Same', within: 'text=Same' }).ambiguous, true);
    assert.equal(ui.evaluateSelector(graph, { text: 'Same', within: 'text=Missing' }).complete, false);
    assert.equal(ui.evaluateSelector([{ text: 'parent' }, { text: 'child' }], {
        text: 'child', within: 'text=parent',
    }).complete, false, 'missing raw ancestry cannot prove absence');
    const tooLong = 'a'.repeat(selector.MAX_REGEX_TEXT_LENGTH + 1);
    assert.equal(ui.evaluateSelector([{ text: tooLong }], { regex: '^b$' }).complete, false);
});

test('condition and full-query regex budgets fail closed without yielding false absence', () => {
    rejects({ contains: 'x'.repeat(selector.MAX_CONDITION_LENGTH + 1) });
    rejects({ id: 'x'.repeat(selector.MAX_CONDITION_LENGTH + 1) });
    const pattern = `${'a*'.repeat(40)}b$`;
    const nodes = Array.from({ length: 110 }, () => ({ text: 'a'.repeat(1000) }));
        assert.ok(nodes.length * pattern.length * nodes[0].text.length > selector.MAX_REGEX_WORK);
    const result = ui.evaluateSelector(nodes, { regex: pattern });
    assert.deepEqual(result, { hits: [], complete: false, ambiguous: false });
    assert.equal(ui.resolveSelector(nodes, { regex: pattern }), null);
});

test('linear regex subset agrees with independent bounded native reference', () => {
    const patterns = ['a', '^a', 'a$', '^a*$', '^a+$', '^a?b*$', '[ab]+', '[^a]+$', '^a.*b$', 'a*b?c+', '\\d+', '^\\w*$', '^\\s?$', 'a\\+b', '$', '^'];
    const words = [''];
    for (let size = 1; size <= 5; size++) {
        const previous = words.filter(word => word.length === size - 1);
        for (const prefix of previous) for (const char of ['a', 'b', '1', ' ']) words.push(prefix + char);
    }
    for (const pattern of patterns) {
        const expected = new RegExp(pattern);
        const parsed = selector.parseSelector({ regex: pattern });
        for (const label of words) {
            const actual = selector.evaluateSelector([{ text: label }], parsed);
            assert.equal(actual.complete, true);
            assert.equal(actual.hits.length === 1, expected.test(label), JSON.stringify({ pattern, label }));
        }
    }
});


test('visible evidence rejects explicit hidden nodes without cutting visible children of hidden parents', () => {
    for (const attr of ['visible-to-user="false"', 'displayed="false"']) {
        const graph = parse(xmlNode(`text="Hidden" ${attr}`));
        assert.equal(ui.resolveSelector(graph, 'text=Hidden'), null);
        assert.equal(ui.evaluateSelector(graph, 'text=Hidden', { includeDisabled: true }).hits.length, 0);
    }
    const graph = parse('<node class="android.view.View" text="Hidden parent" visible-to-user="false" bounds="[0,0][500,500]">'
        + xmlNode('text="Visible child" visible-to-user="true"') + '</node>');
    assert.equal(ui.resolveSelector(graph, 'text=Hidden parent'), null);
    assert.equal(ui.resolveSelector(graph, 'text=Visible child').label, 'Visible child');
});

test('disabled presence is assertion evidence, never an implicit actionable target', () => {
    const graph = parse(xmlNode('text="Disabled" enabled="false"') + xmlNode('text="Enabled"'), { limit: 1 });
    assert.equal(graph.controls.length, 1);
    assert.equal(graph.controls[0].label, 'Enabled');
    assert.equal(ui.resolveSelector(graph, 'text=Disabled'), null);
    assert.equal(ui.findControls(graph, 'text=Disabled').length, 0);
    const result = ui.evaluateSelector(graph, 'text=Disabled', { includeDisabled: true });
    assert.equal(result.complete, true);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].enabled, false);
    assert.equal(JSON.stringify(graph).includes('"label":"Disabled"'), false);
    assert.equal(Object.getOwnPropertyDescriptor(graph, 'evidenceControls').enumerable, false);
});

test('full matching labels survive display truncation, scoped nth and regex budgets', () => {
    const prefix = 'A'.repeat(120);
    const full = prefix + 'TAIL';
    const graph = parse('<node class="android.widget.LinearLayout" text="Parent" resource-id="parent" bounds="[0,0][800,800]">'
        + xmlNode(`text="${full}" bounds="[10,100][100,140]"`)
        + xmlNode(`text="${full}" bounds="[10,200][100,240]"`) + '</node>', { limit: 1 });
    assert.ok(ui.projectUiGraph(graph).controls.every(c => c.label.length <= 121));
    assert.ok(graph.evidenceControls.some(c => c.text === full), 'assertions retain the complete raw source');
    for (const query of [{ text: full }, { contains: 'TAIL' }, { regex: 'TAIL$' }]) {
        const result = ui.evaluateSelector(graph, { ...query, within: 'id=parent' });
        assert.equal(result.complete, true);
        assert.equal(result.hits.length, 2);
        assert.equal(result.ambiguous, true);
        assert.equal(ui.resolveSelector(graph, { ...query, nth: 1, within: 'id=parent' }).y, 220);
    }
    const overBudget = parse(xmlNode(`text="${'a'.repeat(selector.MAX_REGEX_TEXT_LENGTH + 1)}"`));
    assert.equal(ui.evaluateSelector(overBudget, { regex: '^b$' }).complete, false);
    const password = parse('<node class="android.widget.EditText" password="true" text="secret-tail" bounds="[0,0][100,40]"/>');
    assert.equal(ui.evaluateSelector(password, { contains: 'secret' }, { includeDisabled: true }).hits.length, 0);
    assert.equal(JSON.stringify(password.evidenceControls).includes('secret-tail'), false);
});


test('long aggregated match labels retain full safe descendants and generated selectors round-trip', () => {
    const full = 'A'.repeat(120) + 'TAIL';
    const graph = parse('<node class="android.widget.LinearLayout" clickable="true" resource-id="card" bounds="[0,0][800,400]">'
        + `<node class="android.widget.TextView" text="${full}" bounds="[10,10][400,50]"/>`
        + '<node class="android.widget.EditText" password="true" text="secret-tail" bounds="[10,60][400,90]"/>'
        + '</node>');
    const host = ui.resolveSelector(graph, { id: 'card', any: `${full} / [password]` });
    assert.equal(host.id, 'card');
    assert.equal(ui.resolveSelector(graph, { id: 'card', contains: 'TAIL' }), null, 'raw parent text is empty');
    assert.equal(ui.projectUiGraph(graph).controls[0].label.endsWith('…'), true);
    assert.equal(host.label.endsWith('[password]'), true);
    assert.equal(ui.evaluateSelector(graph, 'contains=secret-tail', { includeDisabled: true }).hits.length, 0);
    assert.equal(JSON.stringify(graph.evidenceControls).includes('secret-tail'), false);
    for (const key of Reflect.ownKeys(host)) {
        const value = host[key];
        if (typeof value === 'string') assert.equal(value.includes('secret-tail'), false);
    }
    const ordinary = parse(xmlNode(`text="${full}"`));
    assert.equal(ui.resolveSelector(ordinary, ordinary.controls[0].selector), ordinary.controls[0]);
});

test('assertion-only disabled candidates honor unique raw scope and explicit screen nth', () => {
    const graph = parse('<node class="android.widget.LinearLayout" resource-id="parent" bounds="[0,0][800,800]">'
        + xmlNode('text="Same" enabled="false" bounds="[10,200][100,240]"')
        + xmlNode('text="Same" bounds="[10,100][100,140]"') + '</node>');
    const query = { text: 'Same', within: 'id=parent' };
    assert.equal(ui.resolveSelector(graph, query).enabled, true);
    const evidence = ui.evaluateSelector(graph, query, { includeDisabled: true });
    assert.equal(evidence.complete, true);
    assert.equal(evidence.ambiguous, true);
    assert.equal(evidence.hits.length, 2);
    assert.equal(ui.evaluateSelector(graph, { ...query, nth: 1 }, { includeDisabled: true }).hits[0].enabled, false);
});


test('hidden descendant labels never enter parent presentation, selectors or scoped matching', () => {
    for (const hidden of ['visible-to-user="false"', 'displayed="false"']) {
        const graph = parse('<node class="android.widget.LinearLayout" clickable="true" resource-id="card" bounds="[0,0][800,500]">'
            + `<node class="android.widget.TextView" text="HIDDEN_SECRET_LABEL" content-desc="HIDDEN_DESCRIPTION" ${hidden} bounds="[0,0][100,40]"/>`
            + `<node class="android.widget.TextView" text="${'V'.repeat(120)}TAIL" bounds="[0,60][300,100]"/>`
            + xmlNode('text="Independent" bounds="[400,200][500,240]"') + '</node>', { rpcTarget: true });
        const card = ui.resolveSelector(graph, 'id=card');
        assert.equal(card.label.includes('HIDDEN'), false);
        for (const source of [graph.controls, graph.evidenceControls, graph.scopeControls]) {
            assert.equal(JSON.stringify(source).includes('HIDDEN'), false);
        }
        for (const contains of ['HIDDEN_SECRET_LABEL', 'HIDDEN_DESCRIPTION']) {
            assert.equal(ui.evaluateSelector(graph, { contains }, { includeDisabled: true }).hits.length, 0);
            assert.equal(ui.evaluateSelector(graph, { text: 'Independent', within: { contains } }).complete, false);
            for (const key of Reflect.ownKeys(card)) if (typeof card[key] === 'string') assert.equal(card[key].includes(contains), false);
        }
        assert.equal(ui.resolveSelector(graph, { id: 'card', contains: 'TAIL' }), null);
        assert.equal(ui.resolveSelector(graph, { id: 'card', any: `${'V'.repeat(120)}TAIL` }), card);
        assert.equal(graph.rawRoot.children[0].children[0].attrs.text, 'HIDDEN_SECRET_LABEL');
    }
});

test('private hidden wrapper sanitization preserves explicit visible children without inherited hidden identity', () => {
    const graph = parse('<node class="android.widget.ScrollView" clickable="true" scrollable="true" password="true" resource-id="hidden-parent" text="HIDDEN_PARENT" visible-to-user="false" bounds="[0,0][800,800]">'
        + xmlNode('text="Visible child" visible-to-user="true"') + '</node>', { rpcTarget: true });
    const child = ui.resolveSelector(graph, 'text=Visible child');
    assert.ok(child);
    assert.equal(child.id, '');
    assert.equal(child.flags.includes('password'), false);
    assert.equal(ui.resolveSelector(graph, 'id=hidden-parent'), null);
    assert.equal(ui.resolveSelector(graph, { text: 'Visible child', within: 'id=hidden-parent' }), child);
    assert.equal(ui.evaluateSelector(graph, { text: 'Visible child', within: 'contains=HIDDEN_PARENT' }).complete, false);
    assert.equal(JSON.stringify(graph).includes('HIDDEN_PARENT'), false);
    assert.equal(JSON.stringify(graph.scopeControls).includes('HIDDEN_PARENT'), false);
});

