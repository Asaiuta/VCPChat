'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const context = require('../VCPDistributedServer/Plugin/AndroidController/lib/context');
const { layoutEvidence } = require('../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { createElementShot } = require('../VCPDistributedServer/Plugin/AndroidController/lib/element-shot');
const vision = require('../VCPDistributedServer/Plugin/AndroidController/lib/vision');
const probe = () => ({ displayId: 0, rotation: 0, size: { width: 100, height: 200 }, wakefulness: 'Awake',
    keyguard: { showing: false, inputRestricted: false }, focus: { package: 'com.example', component: 'com.example/.Main', window: 'Main' } });
const xml = '<hierarchy rotation="0"><node package="com.example" class="android.widget.Button" resource-id="com.example:id/go" text="Go" enabled="true" clickable="true" bounds="[10,20][80,60]"/></hierarchy>';
const missing = {
    display: p => { delete p.displayId; }, otherDisplay: p => { p.displayId = 1; }, stringDisplay: p => { p.displayId = '0'; },
    rotation: p => { delete p.rotation; }, stringRotation: p => { p.rotation = '0'; }, size: p => { p.size.width = 0; },
    asleep: p => { p.wakefulness = 'Asleep'; }, dozing: p => { p.wakefulness = 'Dozing'; },
    unknownKeyguard: p => { delete p.keyguard; }, showing: p => { p.keyguard.showing = true; },
    unknownRestriction: p => { delete p.keyguard.inputRestricted; }, restricted: p => { p.keyguard.inputRestricted = true; },
    window: p => { delete p.focus.window; }, component: p => { delete p.focus.component; },
    systemui: p => { p.focus.package = 'com.android.systemui'; },
};
for (const [name, mutate] of Object.entries(missing)) test(`strict context and layout evidence reject ${name}`, () => {
    const p = probe(); mutate(p);
    assert.equal(context.frameContext(p), null);
    assert.equal(layoutEvidence(parseUiGraph(xml, { screen: probe().size }), p).complete, false);
});

test('context is copied by value and all primary-display identity dimensions matter', () => {
    const p = probe(), baseline = context.frameContext(p);
    p.size.width = 200; p.focus.window = 'Other';
    assert.equal(baseline.size.width, 100); assert.equal(baseline.window, 'Main');
    for (const mutate of [p => { p.rotation = 2; }, p => { p.focus.component = 'com.example/.Other'; },
        p => { p.focus.window = 'Dialog'; }, p => { p.size.height = 300; }, p => { p.focus.package = 'com.other'; }]) {
        const changed = probe(); mutate(changed);
        assert.equal(context.sameContext(baseline, context.frameContext(changed)), false);
    }
});

test('epoch advances on observed context loss and A-B-A, not repeated equivalent samples; serials are isolated', () => {
    const tracker = context.createContextTracker(), p = probe();
    assert.equal(tracker.epoch('A'), 0);
    assert.equal(tracker.observe('A', p).epoch, 1);
    assert.equal(tracker.observe('A', probe()).changed, false);
    p.focus.component = 'com.example/.Other';
    assert.deepEqual([tracker.observe('A', p).epoch, tracker.observe('A', probe()).epoch], [2, 3]);
    assert.equal(tracker.observe('A', null).epoch, 4);
    assert.equal(tracker.observe('A', null).epoch, 4);
    assert.equal(tracker.observe('A', probe()).epoch, 5);
    tracker.observe('B', probe());
    assert.equal(tracker.invalidate('A'), 6); assert.equal(tracker.epoch('B'), 1);
    tracker.clear(); assert.equal(tracker.epoch('A'), 0);
});

test('raw tree rotation cannot masquerade as certified screen rotation', () => {
    const graph = parseUiGraph(xml.replace('rotation="0"', 'rotation="2"'), { screen: probe().size });
    assert.equal(context.graphMatchesContext(graph, context.frameContext(probe())), false);
    assert.equal(layoutEvidence(graph, probe()).complete, false);
});

test('element helper uses fresh probes for all boundaries without cached-size composition', async () => {
    const graph = parseUiGraph(xml, { screen: probe().size, rpcTarget: true });
    const requests = [], controller = new AbortController();
    const runtime = { check() {}, remainingMs: () => 1200, executionSignal: () => controller.signal,
        failure: (code, message) => Object.assign(new Error(message), { code }) };
    const helper = createElementShot({ runtime, vision, prepareTarget: async () => ({ node: graph.controls[0] }),
        getRecord: () => ({ graph, limit: 500 }), captureGraph: async () => graph, resolveSelector: () => graph.controls[0],
        intOf: Number, validateSelector() {}, graphLayout: () => 'layout' });
    const client = { async probeScreen(serial, request) { requests.push(request); return probe(); },
        async screenSize() { assert.fail('cached size must not compose fresh evidence'); } };
    const args = { target: 'element', id: 'com.example:id/go' }, size = probe().size;
    const baseline = await helper.prepare({ client, serial: 'A', size, args });
    await helper.verify({ client, serial: 'A', size, args, baseline });
    assert.equal(requests.length, 3);
    for (const request of requests) { assert.equal(request.fresh, true); assert.equal(request.signal, controller.signal); assert.equal(request.timeoutMs, 1200); }
    client.probeScreen = async () => ({ size, focus: probe().focus, wakefulness: 'Awake' });
    await assert.rejects(helper.prepare({ client, serial: 'A', size, args }), { code: 'INVALID_ELEMENT_TARGET' });
});

test('context-change tokens name failed dimensions only, never values', () => {
    const before = probe(), win = token => `Window{${token} u0 com.example/com.example.Main}`;
    before.focus.window = win('a1');
    const after = probe(); after.focus.window = win('b2');
    assert.deepEqual(context.describeContextChange({ before, after, epochChanged: true }), ['window_token', 'epoch']);
    const dialog = probe(); dialog.focus.window = 'Window{c3 u0 PopupWindow:5}'; dialog.rotation = 1;
    assert.deepEqual(context.describeContextChange({ before, after: dialog }), ['window_title', 'rotation']);
    const locked = probe(); locked.keyguard.showing = true; locked.focus.package = 'com.android.systemui';
    assert.deepEqual(context.describeContextChange({ before, after: locked }), ['after_keyguard', 'after_overlay']);
    assert.deepEqual(context.describeContextChange({ before: null, after: probe() }), ['before_missing']);
    const graph = parseUiGraph(xml.replace('rotation="0"', 'rotation="2"').replaceAll('com.example', 'com.other'), { screen: probe().size, rpcTarget: true });
    assert.deepEqual(context.describeContextChange({ before: probe(), after: probe(), graph }), ['graph_package', 'graph_rotation', 'graph_foreground']);
    assert.deepEqual(context.describeContextChange({ before: probe(), after: probe(), graph: parseUiGraph(xml, { screen: probe().size, rpcTarget: true }) }), []);
    for (const tokens of [context.describeContextChange({ before, after: dialog }), context.unprovenReasons(locked)]) {
        assert.doesNotMatch(JSON.stringify(tokens), /com\.|Window|Popup|Main/);
    }
    assert.ok(context.CONTEXT_DIFF_TOKENS.every(token => /^[a-z_]+$/.test(token)));
});
