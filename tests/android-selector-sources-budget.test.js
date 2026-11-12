'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { MAX_CONDITION_LENGTH, MAX_REGEX_TEXT_LENGTH } = require('../VCPDistributedServer/Plugin/AndroidController/lib/selector');

const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const button = (text = '', desc = '', top = 0, extra = '') => `<node class="android.widget.Button" package="com.demo" text="${escape(text)}" content-desc="${escape(desc)}" clickable="true" bounds="[10,${top}][200,${top + 40}]" ${extra}/>`;
const parse = (nodes, options = {}) => ui.parseUiGraph(`<hierarchy>${nodes}</hierarchy>`, {
    screen: { width: 800, height: 1000 }, ...options,
});

test('raw text and content-desc are independent exact sources in strings and AND objects', () => {
    const graph = parse(button('Visible title', 'Accessible name'));
    const target = graph.controls[0];
    assert.equal(target.text, 'Visible title');
    assert.equal(target.desc, 'Accessible name');
    assert.equal(target.label, 'Accessible name');
    for (const query of ['text=Visible title', 'desc=Accessible name', 'any=Accessible name', {
        text: 'Visible title', desc: 'Accessible name', any: 'Accessible name', contains: 'title', regex: '^Visible.*$',
    }]) assert.equal(ui.resolveSelector(graph, query), target);
    for (const query of ['text=Accessible name', 'desc=Visible title', 'any=Visible title',
        'contains=Accessible', 'regex=^Accessible.*$', { text: 'Visible title', desc: 'Visible title' }]) {
        assert.deepEqual(ui.evaluateSelector(graph, query), { hits: [], complete: true, ambiguous: false });
    }
});

test('empty raw text never falls back to description, including generated selectors and nth', () => {
    const graph = parse(button('', 'Only description', 300) + button('', 'Only description', 50));
    assert.equal(ui.findControls(graph, 'text=Only description').length, 0);
    assert.equal(ui.findControls(graph, 'contains=description').length, 0);
    assert.equal(ui.findControls(graph, 'regex=description$').length, 0);
    assert.equal(ui.findControls(graph, 'desc=Only description').length, 2);
    assert.equal(ui.resolveSelector(graph, { desc: 'Only description', nth: 0 }), graph.controls[1]);
    assert.equal(graph.controls[0].selector, 'desc=Only description#1');
    assert.equal(graph.controls[1].selector, 'desc=Only description#2');
    for (const c of graph.controls) assert.equal(ui.resolveSelector(graph, c.selector), c);
});

test('aggregated descendants require explicit any; raw parent scopes keep their own dual sources', () => {
    const graph = parse('<node class="android.widget.LinearLayout" package="com.demo" clickable="true" bounds="[0,0][800,800]">'
        + '<node class="android.widget.TextView" text="Invoice" content-desc="Paid" bounds="[10,10][200,40]"/>'
        + button('Delete', 'Remove invoice', 200) + '</node>');
    const host = graph.controls[0];
    assert.equal(host.text, '');
    assert.equal(host.desc, '');
    assert.equal(host.label, 'Invoice / Paid');
    assert.equal(ui.resolveSelector(graph, 'any=Invoice / Paid'), host);
    assert.equal(ui.resolveSelector(graph, 'text=Invoice / Paid'), null);
    assert.equal(ui.resolveSelector(graph, 'desc=Invoice / Paid'), null);
    assert.equal(ui.resolveSelector(graph, 'contains=Paid'), null);
    assert.equal(ui.resolveSelector(graph, { text: 'Delete', within: 'any=Invoice / Paid' }), graph.controls[1]);
    assert.equal(ui.resolveSelector(graph, { text: 'Delete', within: 'text=Invoice / Paid' }), null);
    const scoped = parse('<node class="android.widget.LinearLayout" text="Raw parent" content-desc="Parent description" bounds="[0,0][800,800]">'
        + button('Child', 'Child description', 100) + '</node>');
    for (const within of ['text=Raw parent', 'desc=Parent description', { text: 'Raw parent', desc: 'Parent description' }]) {
        assert.equal(ui.resolveSelector(scoped, { text: 'Child', within }), scoped.controls.at(-1));
    }
});

test('selectors and evidence preserve exact XML text, whitespace, placeholders and long source tails', () => {
    const full = '  Start\n' + 'X'.repeat(150) + ' END  ';
    const graph = parse(button(full, 'Description'), { textLength: 5 });
    const target = graph.controls[0];
    assert.equal(target.text, full);
    assert.equal(ui.resolveSelector(graph, { text: full }), target);
    assert.equal(ui.resolveSelector(graph, { contains: ' END  ' }), target);
    assert.equal(ui.resolveSelector(graph, target.selector), target);
    assert.equal(ui.resolveSelector(graph, { text: full.trim() }), null);
    const placeholder = parse(button('Image', 'icon'));
    assert.equal(placeholder.controls[0].label, '');
    assert.equal(ui.resolveSelector(placeholder, 'text=Image'), placeholder.controls[0]);
    assert.equal(ui.resolveSelector(placeholder, 'desc=icon'), placeholder.controls[0]);
});

test('presentation budgets apply to a separate public projection, never matching/evidence or original graph', () => {
    const full = 'A'.repeat(130) + 'TAIL';
    const graph = parse(button(full, 'D'.repeat(130) + 'DESC', 100, 'resource-id="com.demo:id/target"')
        + button(full, 'Other description', 200), { limit: 1 });
    const projected = ui.projectUiGraph(graph, { textLength: 12 });
    assert.notEqual(projected.controls[0], graph.controls[0]);
    assert.equal(projected.controls[0].label, 'D'.repeat(12) + '…');
    assert.equal(projected.controls[0].text, 'A'.repeat(12) + '…');
    assert.equal(projected.controls[0].desc, 'D'.repeat(12) + '…');
    for (const key of ['x', 'y', 'bounds', 'clipped', 'center', 'labelBox', 'shortId']) {
        assert.equal(Object.hasOwn(projected.controls[0], key), false, key);
    }
    assert.equal(projected.controls[0].id, 'com.demo:id/target');
    assert.equal(projected.controls[0].selector, graph.controls[0].selector);
    assert.equal(projected.matchingControls, graph.matchingControls);
    assert.equal(projected.evidenceControls, graph.evidenceControls);
    assert.equal(projected.scopeControls, graph.scopeControls);
    assert.equal(ui.findControls(projected, { text: full }).length, 2);
    assert.equal(ui.findControls(projected.controls, { text: full }).length, 2);
    assert.equal(ui.resolveSelector(projected, { text: full, nth: 1 }), graph.matchingControls[1]);
    assert.equal(graph.controls[0].text, full);
    assert.equal(graph.evidenceControls[0].label.endsWith('DESC'), true);
    assert.equal(JSON.stringify(projected).includes('TAIL'), false);
    assert.equal(ui.renderView(graph).includes('(105,120)'), false);
    assert.equal(ui.renderView(graph).includes('#:id/target'), false);
    const detailed = ui.projectUiGraph(graph, { detail: true, textLength: 12 });
    assert.equal(detailed.controls[0].x, 105);
    assert.equal(detailed.controls[0].shortId, ':id/target');
    assert.equal(ui.renderView(graph, { detail: true }).includes('(105,120)'), true);
    assert.equal(ui.renderView(graph, { includeCoordinates: true }).includes('#:id/target'), false);
    assert.equal(ui.renderView(graph, { includeShortId: true }).includes('(105,120)'), false);
    assert.equal(ui.projectUiGraph(graph, { detail: true, includeCoordinates: false }).controls[0].x, undefined);
    assert.equal(ui.projectUiGraph(projected, { detail: true, textLength: 200 }).controls[0].text, full);
});

test('signature uses full evidence rather than label/coordinate/short-id presentation budgets', () => {
    const first = parse(button('A'.repeat(130) + 'First', 'Name'));
    const second = parse(button('A'.repeat(130) + 'Second', 'Name'));
    assert.equal(ui.samePage(first, second), false);
    assert.equal(first.signature, ui.projectUiGraph(first, { textLength: 1 }).signature);
});

test('4096 condition budgets and regex input safety remain fail-closed on raw sources', () => {
    for (const field of ['text', 'desc', 'any']) {
        assert.equal(ui.validateSelector({ [field]: 'A'.repeat(MAX_CONDITION_LENGTH) }), true);
        assert.equal(ui.validateSelector({ [field]: 'A'.repeat(MAX_CONDITION_LENGTH + 1) }), false);
    }
    const graph = parse(button('A'.repeat(MAX_REGEX_TEXT_LENGTH + 1), 'Short desc'));
    assert.equal(ui.evaluateSelector(graph, 'regex=^B$').complete, false);
    assert.equal(ui.resolveSelector(graph, 'desc=Short desc'), graph.controls[0]);
});

test('password and hidden sources are sanitized in full evidence, scopes and projected tables', () => {
    const graph = parse(button('TEXT_SECRET', 'DESC_SECRET', 0, 'password="true"')
        + button('HIDDEN_TEXT', 'HIDDEN_DESC', 100, 'visible-to-user="false"'), { rpcTarget: true });
    for (const source of [graph, graph.evidenceControls, graph.scopeControls, ui.projectUiGraph(graph)]) {
        for (const secret of ['TEXT_SECRET', 'DESC_SECRET', 'HIDDEN_TEXT', 'HIDDEN_DESC']) {
            assert.equal(JSON.stringify(source).includes(secret), false);
            for (const field of ['text', 'desc', 'any', 'contains', 'regex']) {
                assert.equal(ui.evaluateSelector(source, { [field]: secret }, { includeDisabled: true }).hits.length, 0);
            }
        }
    }
    assert.equal(graph.controls[0].text, '');
    assert.equal(graph.controls[0].desc, '');
    assert.equal(ui.resolveSelector(graph, 'any=[password]'), graph.controls[0]);
});

test('serialized public projections cannot supply false absence or nth evidence after truncation', () => {
    const full = 'Long '.repeat(40) + 'TAIL';
    const graph = parse(button(full, 'Name', 100, 'resource-id="stable"'));
    const projected = ui.projectUiGraph(graph, { textLength: 8 });
    assert.equal(projected.truncated, false, 'this case is text-budget truncation, not row truncation');
    assert.equal(ui.evaluateSelector(projected, { contains: 'TAIL' }).hits[0], graph.controls[0]);
    for (const source of [JSON.parse(JSON.stringify(projected)), JSON.parse(JSON.stringify(projected.controls))]) {
        for (const query of [{ contains: 'TAIL' }, { text: full, nth: 0 }, { id: 'stable' }]) {
            assert.deepEqual(ui.evaluateSelector(source, query), { hits: [], complete: false, ambiguous: false });
        }
    }
});

test('projection limits and rendering preserve settings while matching the entire canonical graph', () => {
    const graph = parse(button('First label', 'First description', 100)
        + button('Second label', 'Second description', 200) + button('Third label', 'Third description', 300));
    const projected = ui.projectUiGraph(graph, { limit: 1, textLength: 4, detail: true });
    assert.equal(projected.controls.length, 1);
    assert.equal(projected.total, 3);
    assert.equal(projected.truncated, true);
    assert.equal(projected.controls[0].text, 'Firs…');
    assert.equal(ui.resolveSelector(projected, 'text=Third label'), graph.controls[2]);
    assert.equal(ui.projectUiGraph(projected).controls.length, 1);
    assert.equal(ui.projectUiGraph(projected).controls[0].text, 'Firs…');
    assert.equal(ui.renderView(projected).includes('First description'), false);
    assert.equal(ui.renderView(projected).includes('(105,120)'), true);
    const expanded = ui.projectUiGraph(projected, { limit: 3, textLength: 100, detail: false });
    assert.equal(expanded.controls.length, 3);
    assert.equal(expanded.controls[0].text, 'First label');
    assert.equal(expanded.controls[0].x, undefined);
});

test('desc and any ordinals escape once and count id-backed controls in their own source universe', () => {
    const value = 'Desc%23#1';
    const graph = parse(button('', value, 0, 'resource-id="first"') + button('', value, 100));
    assert.equal(graph.controls[1].selector, 'desc=Desc%2523%231#2');
    assert.equal(ui.resolveSelector(graph, graph.controls[1].selector), graph.controls[1]);
    assert.equal(ui.resolveSelector(graph, { desc: value, nth: 1 }), graph.controls[1]);
    assert.equal(ui.resolveSelector(graph, { text: value }), null);
    const aggregate = '<node class="android.widget.LinearLayout" clickable="true" bounds="[0,0][800,500]">'
        + '<node class="android.widget.TextView" text="Aggregate%23#1" bounds="[10,10][200,40]"/></node>';
    const hosts = parse(aggregate + aggregate);
    assert.equal(hosts.controls[0].selector, 'any=Aggregate%2523%231#1');
    assert.equal(hosts.controls[1].selector, 'any=Aggregate%2523%231#2');
    for (const host of hosts.controls) assert.equal(ui.resolveSelector(hosts, host.selector), host);
    assert.equal(ui.resolveSelector(hosts, { any: 'Aggregate%23#1', nth: 1 }), hosts.controls[1]);
    assert.equal(ui.resolveSelector(hosts, 'text=Aggregate%2523%231#1'), null);
});

for (const field of ['desc', 'any']) {
    test(`${field} automatic selectors consume the decoded 4096 budget and reject over-budget identities`, () => {
        for (const size of [MAX_CONDITION_LENGTH, MAX_CONDITION_LENGTH + 1]) {
            const value = '%#'.repeat(size >> 1) + (size % 2 ? 'X' : '');
            const graph = field === 'desc' ? parse(button('', value)) : parse('<node class="android.widget.LinearLayout" clickable="true" bounds="[0,0][800,500]">'
                + `<node class="android.widget.TextView" text="${escape(value)}" bounds="[10,10][200,40]"/></node>`);
            const control = graph.controls[0];
            if (size > MAX_CONDITION_LENGTH) assert.equal(control.selector, null);
            else {
                assert.equal(ui.parseSelector(control.selector)[field], value);
                assert.equal(ui.resolveSelector(graph, control.selector), control);
            }
        }
    });
}

