'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInteractionPolicy } = require('../VCPDistributedServer/Plugin/AndroidController/lib/interaction-policy');
const { createInteractionGuard } = require('../VCPDistributedServer/Plugin/AndroidController/lib/interaction-guard');

function setup() {
    const state = { config: {}, reads: 0, dumps: 0,
        probe: { focus: { package: 'com.demo' }, wakefulness: 'Awake', keyguard: { showing: false, inputRestricted: false } },
        controls: [{ id: 'com.demo:id/open', package: 'com.demo', cls: 'Button', label: 'Open', x: 10, y: 20 }] };
    const policy = createInteractionPolicy({ getConfig: () => state.config });
    const guard = createInteractionGuard({ policy,
        probe: async () => { state.reads++; return state.probe; },
        captureGraph: async () => { state.dumps++; return { package: 'com.demo', controls: state.controls }; },
        check() {}, fail: (code, message) => Object.assign(new Error(message), { code }) });
    return { state, guard };
}

test('denied read returns no tree and policy is read dynamically', async () => {
    const { state, guard } = setup();
    await guard.read('A');
    state.config = { denyPackages: ['com.demo'] };
    await assert.rejects(guard.read('A'), { code: 'POLICY_DENIED' });
    assert.equal(state.dumps, 0);
});
test('writes outside a controlled action are rejected', async () => {
    const { guard } = setup();
    await assert.rejects(guard.write('A'), { code: 'POLICY_CONTEXT_REQUIRED' });
});
test('confirmation policy rejects before a dump or input attempt', async () => {
    const { state, guard } = setup(); state.config = { confirmEveryWrite: true };
    await assert.rejects(guard.run('tap', { confirmed: true }, () => guard.write('A')), { code: 'POLICY_CONFIRMATION_REQUIRED', needsConfirmation: true });
    assert.equal(state.dumps, 0);
});
test('target rebind uses current semantic risk, not an old benign label', async () => {
    const { state, guard } = setup(); const old = { ...state.controls[0] };
    state.controls[0].label = 'Pay';
    await assert.rejects(guard.run('tap', {}, async () => { guard.target(old); await guard.write('A'); }), { code: 'POLICY_CONFIRMATION_REQUIRED' });
});
test('unscoped keys and pixels cannot bypass a sensitive control', async () => {
    for (const command of ['keyevent', 'tap', 'inputtext', 'imeaction']) {
        const { state, guard } = setup(); state.controls[0].label = 'Confirm';
        await assert.rejects(guard.run(command, {}, () => guard.write('A')), { code: 'POLICY_CONFIRMATION_REQUIRED' });
    }
});
test('a changed or duplicate target fails closed', async () => {
    const { state, guard } = setup(); const old = { ...state.controls[0] };
    state.controls.push({ ...old });
    await assert.rejects(guard.run('tap', {}, async () => { guard.target(old); await guard.write('A'); }), { code: 'POLICY_TARGET_CHANGED' });
});
test('read-only destination cannot be launched from a permitted foreground', async () => {
    const { state, guard } = setup(); state.config = { readOnlyPackages: ['com.bank'] };
    await assert.rejects(guard.run('launchapp', { package: 'com.bank' }, () => guard.write('A')), { code: 'POLICY_DENIED' });
});
test('doubletap continuation rechecks mutable policy without an extra round trip', async () => {
    const { state, guard } = setup();
    await guard.run('doubletap', {}, async () => {
        await guard.write('A'); const reads = state.reads, dumps = state.dumps;
        await guard.write('A', { continuation: true });
        assert.equal(state.reads, reads); assert.equal(state.dumps, dumps);
        state.config = { confirmEveryWrite: true };
        await assert.rejects(guard.write('A', { continuation: true }), { code: 'POLICY_CONFIRMATION_REQUIRED' });
    });
});
test('wake cannot perform an ordinary locked-device action', async () => {
    const { state, guard } = setup(); state.probe.wakefulness = 'Asleep'; state.probe.keyguard.showing = true;
    await assert.rejects(guard.run('tap', {}, () => guard.write('A')), { code: 'POLICY_CONTEXT_UNPROVEN' });
    await guard.run('wake', {}, () => guard.write('A'));
    assert.equal(state.dumps, 0);
});
