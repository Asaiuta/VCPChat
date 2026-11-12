'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskPort } = require('../VCPDistributedServer/Plugin/AndroidController/lib/task-port');
const { parseUiGraph } = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');
const { frameContext } = require('../VCPDistributedServer/Plugin/AndroidController/lib/context');

function fixture(t, intent, options = {}) {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const pkg = 'com.example', id = name => `${pkg}:id/${name}`;
    const node = (name, cls, y, attrs = '') => `<node package="${pkg}" resource-id="${id(name)}" class="android.widget.${cls}" bounds="[10,${y}][90,${y + 20}]" enabled="true" clickable="true" ${attrs}/>`;
    const children = intent === 'route_search'
        ? `<node package="${pkg}" resource-id="${id('form')}" class="android.widget.LinearLayout" bounds="[0,0][100,200]" enabled="true">`
            + node('origin', 'EditText', 20, 'password="false" focused="false" text=""')
            + node('destination', 'EditText', 60, 'password="false" focused="false" text=""')
            + node('submit', 'Button', 120, 'text="Go"') + '</node>'
        : node('target', intent === 'set_toggle' ? 'Switch' : 'Button', 40, 'checkable="true" checked="false" text="Search"');
    const graph = parseUiGraph(`<hierarchy rotation="0">${children}</hierarchy>`, { rpcTarget: true, screen: { width: 100, height: 200 } });
    const probe = { focus: { package: pkg, component: `${pkg}/.Main`, window: 'Window{a u0 com.example/.Main}' },
        size: { width: 100, height: 200 }, rotation: 0, displayId: 0, wakefulness: 'Awake', keyguard: { showing: false, inputRestricted: false } };
    graph.contextEvidence = { context: frameContext(probe), probe, epoch: 1 };
    const task = { serial: 'A', package: pkg, intent, decision: 'jev',
        inputs: intent === 'route_search' ? { origin: 'A', destination: 'B' } : intent === 'set_toggle' ? { checked: true } : { query: 'q' },
        targets: intent === 'route_search' ? { form: id('form'), origin: id('origin'), destination: id('destination'), submit: id('submit') } : { toggle: id('target') },
        completion: { id: id('results') }, budget: { maxObservations: 256 } };
    const requests = [], pauses = [], verdicts = [];
    let writes = 0, checks = 0;
    const port = createTaskPort({ runtime: {
        check() { checks++; options.check?.(); }, remainingMs: () => 60000,
        failure: code => Object.assign(new Error(code), { code }),
        async pause(ms) { pauses.push(ms); t.mock.timers.tick(ms); },
        async runOwned(_scope, fn) { return fn(); },
        verified(matched, evidence) { verdicts.push({ matched, evidence }); },
    }, async captureGraph(_serial, request) {
        if (writes) { requests.push(request); options.capture?.(request); }
        return graph;
    }, async executePlan() {
        writes++; options.dispatch?.();
        return { details: { actionVerified: true, fillVerified: true, execution: { outcome: 'dispatched' } } };
    } });
    return { requests, pauses, verdicts, get writes() { return writes; }, get checks() { return checks; },
        run: () => port.run(task, async () => {
            const sample = await port.observe(task);
            const action = intent === 'route_search' ? { command: 'Fill', id: id('origin'), text: 'A' } : { command: 'Tap', id: id('target') };
            return port.execute(task, action, null, sample, () => options.matched === true, { verificationDeadlineMs: 1050 });
        }) };
}

for (const intent of ['search', 'set_toggle', 'route_search']) {
    test(`${intent} post-action captures and pauses share the original deadline`, async t => {
        const f = fixture(t, intent, { capture() { t.mock.timers.tick(20); } });
        await f.run();
        assert.equal(f.writes, 1);
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].deadlineMs, 1050);
        assert.deepEqual(f.pauses, [30]);
        assert.equal(Date.now(), 1050);
        assert.deepEqual(f.verdicts, [{ matched: false, evidence: { type: 'task_progress', error: 'TASK_NO_PROGRESS' } }]);
    });
    test(`${intent} cannot accept a late positive sample or start capture after expiry`, async t => {
        const f = fixture(t, intent, { matched: true, capture() { t.mock.timers.tick(50); } });
        await f.run();
        assert.equal(f.requests.length, 1);
        assert.equal(f.verdicts[0].matched, false);
        assert.deepEqual(f.pauses, []);
    });
    test(`${intent} skips post-action capture when dispatch has used the entire window`, async t => {
        const f = fixture(t, intent, { matched: true, dispatch() { t.mock.timers.tick(50); } });
        await f.run();
        assert.equal(f.requests.length, 0);
        assert.equal(f.verdicts[0].matched, false);
        assert.equal(f.writes, 1);
    });
}

for (const code of ['VERIFICATION_TIMEOUT', 'ADB_TIMEOUT']) test(`a drained ${code} becomes unproved progress without renewing or replaying the action`, async t => {
    const f = fixture(t, 'search', { capture() {
        t.mock.timers.tick(50);
        throw Object.assign(new Error('capture deadline'), { code });
    } });
    await f.run();
    assert.equal(f.writes, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.verdicts[0].matched, false);
    assert.deepEqual(f.pauses, []);
});

for (const error of [
    { code: 'UI_SERVER_TIMEOUT' }, { code: 'VERIFICATION_TIMEOUT', inFlight: true },
    { code: 'VERIFICATION_TIMEOUT', drained: false }, { code: 'VERIFICATION_TIMEOUT', early: true },
    { code: 'ADB_TIMEOUT', drained: false }, { code: 'ADB_TIMEOUT', early: true },
]) test(`capture failure propagates without replay: ${JSON.stringify(error)}`, async t => {
    const failure = Object.assign(new Error('capture failure'), error);
    const f = fixture(t, 'search', { capture() { if (!error.early) t.mock.timers.tick(50); throw failure; } });
    await assert.rejects(f.run(), value => value === failure);
    assert.equal(f.writes, 1);
    assert.deepEqual(f.verdicts, []);
});

test('task cancellation at the capture deadline takes precedence over unproved progress', async t => {
    const failure = Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' });
    const f = fixture(t, 'search', { check() { if (Date.now() >= 1050) throw failure; }, capture() {
        t.mock.timers.tick(50);
        throw Object.assign(new Error('capture deadline'), { code: 'VERIFICATION_TIMEOUT' });
    } });
    await assert.rejects(f.run(), value => value === failure);
    assert.equal(f.writes, 1);
    assert.deepEqual(f.verdicts, []);
});
