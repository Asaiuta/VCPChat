'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, xml } = require('./helpers/android-service-harness.cjs');
const { createHumanInteraction } = require('../modules/services/humanInteraction');
const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

function controlHub(overrides = {}) {
    const sent = [];
    return { sent, serial: 'A', width: 50, height: 100, ready: true,
        controlReady() { return this.ready; },
        injectTouch(event) { if (!this.ready) throw Object.assign(new Error('lost'), { code: 'SCRCPY_CONTROL_UNAVAILABLE' }); sent.push(['touch', event]); },
        injectKeycode(action, keycode) { sent.push(['key', action, keycode]); },
        ...overrides };
}
async function fixture(t, options = {}) {
    const prompts = [];
    const hub = options.hub || controlHub();
    const h = await harness({ ...options, hub, services: { humanInteraction: { async request(request) {
        prompts.push(request); return options.approve ? options.approve(request) : true;
    } }, ...options.services } });
    t.after(() => h.service.cleanup());
    const owner = {}, controller = new AbortController(), notifications = [];
    const context = { owner, signal: controller.signal, notify: value => notifications.push(value) };
    const start = () => h.takeoverApi.start({ serial: 'A' }, context);
    return { ...h, hub, prompts, owner, controller, notifications, context, start };
}
const body = session => ({ token: session.token, epoch: session.epoch });
const touch = (session, action, x = 10, y = 10, extra = {}) => ({ ...body(session), action, x, y, width: 50, height: 100, ...extra });
const legacyWrites = h => h.calls.filter(c => c[0] === 'rpc' || (c[0] === 'adb' && c[1].includes('input')));

test('takeover native dialog is a distinct bounded capability and defaults to rejection', async () => {
    let options;
    const human = createHumanInteraction({ getWindow: () => ({ isDestroyed: () => false }),
        dialog: { async showMessageBox(_window, value) { options = value; return { response: 0 }; } } });
    assert.equal(await human.request({ kind: 'takeover', detail: 'A', signal: new AbortController().signal }), false);
    assert.match(options.title, /人工接管/);
    assert.deepEqual(options.buttons, ['拒绝', '允许本次接管']);
});

test('start requires explicit displayed device, trusted host and a live control channel', async t => {
    const h = await fixture(t);
    await assert.rejects(h.takeoverApi.start({ serial: 'B' }, h.context), { code: 'TAKEOVER_DEVICE_CHANGED' });
    await assert.rejects(h.takeoverApi.start({ serial: '__auto__' }, h.context), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(h.service.processToolCall({ command: 'Manage', operation: 'takeover' }), { code: 'INVALID_ARGUMENT' });
    h.hub.ready = false;
    await assert.rejects(h.start(), { code: 'SCRCPY_CONTROL_UNAVAILABLE' });
    assert.equal(h.prompts.length, 0); assert.equal(h.hub.sent.length, 0);
    assert.equal(h.takeoverApi.status().state, 'idle');
});

test('control from a different scrcpy device is never used', async t => {
    const h = await fixture(t, { hub: controlHub({ serial: 'B' }) });
    await assert.rejects(h.start(), { code: 'SCRCPY_CONTROL_UNAVAILABLE' });
});

test('native refusal never grants lease or sends input', async t => {
    const h = await fixture(t, { approve: () => false });
    await assert.rejects(h.start(), { code: 'POLICY_REJECTED' });
    assert.equal(runtime.takeoverStatus().active, false);
    assert.equal(h.takeoverApi.status().state, 'idle');
    assert.equal(h.hub.sent.length, 0);
});

test('live drag streams down/move/up through scrcpy control; Agent and management stay blocked', async t => {
    const h = await fixture(t);
    const session = await h.start();
    assert.equal(h.prompts[0].kind, 'takeover');
    assert.equal(session.mode, 'live');
    assert.deepEqual(session.video, { width: 50, height: 100 });
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'B' }), { code: 'DEVICE_BUSY' });
    await assert.rejects(h.service.processToolCall({ command: 'Manage', operation: 'stopDisplay' }), { code: 'DEVICE_BUSY' });
    h.takeoverApi.touch(touch(session, 'down', 10, 10), h.context);
    h.takeoverApi.touch(touch(session, 'move', 20, 40), h.context);
    h.takeoverApi.touch(touch(session, 'up', 30, 80), h.context);
    assert.deepEqual(h.hub.sent.map(([, e]) => [e.action, e.x, e.y]), [[0, 10, 10], [2, 20, 40], [1, 30, 80]]);
    await h.takeoverApi.end(body(session), h.context);
    assert.equal(runtime.takeoverStatus().active, false);
    assert.equal(legacyWrites(h).length, 0);
});

test('client frame pixels scale to the encoder frame; rotated aspect lifts the gesture', async t => {
    const h = await fixture(t);
    const session = await h.start();
    h.takeoverApi.touch(touch(session, 'down', 100, 200, { width: 200, height: 400 }), h.context);
    assert.deepEqual(h.hub.sent.at(-1)[1], { action: 0, x: 25, y: 50, width: 50, height: 100 });
    assert.throws(() => h.takeoverApi.touch(touch(session, 'move', 10, 10, { width: 400, height: 200 }), h.context), { code: 'VIDEO_SIZE_CHANGED' });
    assert.equal(h.hub.sent.at(-1)[1].action, 1, 'pointer released on mismatch');
    assert.throws(() => h.takeoverApi.touch(touch(session, 'down', 50, 10), h.context), { code: 'INVALID_COORDINATES' });
    await h.takeoverApi.end(body(session), h.context);
});

test('move/up without an accepted down never reach the device', async t => {
    const h = await fixture(t);
    const session = await h.start();
    h.takeoverApi.touch(touch(session, 'move'), h.context);
    h.takeoverApi.touch(touch(session, 'up'), h.context);
    assert.equal(h.hub.sent.length, 0);
    await h.takeoverApi.end(body(session), h.context);
});

test('ending or disconnecting with a pressed pointer sends exactly one up', async t => {
    const h = await fixture(t);
    const session = await h.start();
    h.takeoverApi.touch(touch(session, 'down', 5, 6), h.context);
    h.controller.abort();
    for (let n = 0; n < 20 && h.takeoverApi.status().state !== 'idle'; n++) await tick();
    assert.deepEqual(h.hub.sent.map(([, e]) => e.action), [0, 1]);
    assert.equal(h.takeoverApi.status().state, 'idle');
});

test('session is socket bound; copied token, wrong epoch, old token cannot operate or release', async t => {
    const h = await fixture(t);
    const session = await h.start();
    assert.throws(() => h.takeoverApi.touch(touch(session, 'down'), { owner: {} }), { code: 'TAKEOVER_SESSION_REQUIRED' });
    await assert.rejects(h.takeoverApi.end({ ...body(session), epoch: session.epoch + 1 }, h.context), { code: 'TAKEOVER_SESSION_REQUIRED' });
    await h.takeoverApi.close({});
    assert.equal(h.takeoverApi.status().state, 'human');
    await h.takeoverApi.end(body(session), h.context);
    const next = await h.start();
    assert.notEqual(next.token, session.token);
    assert.throws(() => h.takeoverApi.touch(touch(session, 'down'), h.context), { code: 'TAKEOVER_SESSION_REQUIRED' });
    await h.takeoverApi.end(body(next), h.context);
    assert.equal(h.hub.sent.length, 0);
});

test('keys are limited to back/home/recents and sent as down+up', async t => {
    const h = await fixture(t);
    const session = await h.start();
    h.takeoverApi.key({ ...body(session), key: 'back' }, h.context);
    h.takeoverApi.key({ ...body(session), key: 'recents' }, h.context);
    for (const key of ['paste', 'power', 'KEYCODE_HOME']) {
        assert.throws(() => h.takeoverApi.key({ ...body(session), key }, h.context), { code: 'INVALID_ARGUMENT' });
    }
    assert.throws(() => h.takeoverApi.touch({ ...touch(session, 'down'), text: 'x' }, h.context), { code: 'INVALID_ARGUMENT' });
    assert.deepEqual(h.hub.sent, [['key', 0, 4], ['key', 1, 4], ['key', 0, 187], ['key', 1, 187]]);
    await h.takeoverApi.end(body(session), h.context);
});

test('read-only foreground package blocks new touches and keys', async t => {
    const h = await fixture(t, { config: { INTERACTION_POLICY: { readOnlyPackages: ['com.example'] } } });
    const session = await h.start();
    assert.equal(session.policy, 'POLICY_DENIED');
    assert.throws(() => h.takeoverApi.touch(touch(session, 'down'), h.context), { code: 'POLICY_DENIED' });
    assert.throws(() => h.takeoverApi.key({ ...body(session), key: 'home' }, h.context), { code: 'POLICY_DENIED' });
    assert.equal(h.hub.sent.length, 0);
    await h.takeoverApi.end(body(session), h.context);
});

test('confirmEveryWrite is satisfied by the human session approval; sensitive screens do not block a human', async t => {
    const h = await fixture(t, { config: { INTERACTION_POLICY: { confirmEveryWrite: true } }, dump: () => xml('Pay') });
    const session = await h.start();
    h.takeoverApi.touch(touch(session, 'down'), h.context);
    h.takeoverApi.touch(touch(session, 'up'), h.context);
    assert.equal(h.hub.sent.length, 2);
    assert.equal(h.prompts.length, 1);
    await h.takeoverApi.end(body(session), h.context);
});

test('stale policy sample stops new touches until a fresh sample arrives', async t => {
    const h = await fixture(t);
    const session = await h.start();
    const original = Date.now;
    Date.now = () => original() + 10000;
    try { assert.throws(() => h.takeoverApi.touch(touch(session, 'down'), h.context), { code: 'POLICY_STALE' }); }
    finally { Date.now = original; }
    assert.equal(h.hub.sent.length, 0);
    await h.takeoverApi.end(body(session), h.context);
});

test('disconnect during native confirmation discards late approval and releases gate without input', async t => {
    const entered = deferred(), answer = deferred();
    const h = await fixture(t, { approve: () => { entered.resolve(); return answer.promise; } });
    const start = h.start(); const rejection = assert.rejects(start);
    await entered.promise; h.controller.abort(); answer.resolve(true);
    await rejection; await tick();
    assert.equal(h.takeoverApi.status().state, 'idle'); assert.equal(h.hub.sent.length, 0);
});

test('old Agent snapshot is invalid after takeover ends, and no task resumes by itself', async t => {
    const h = await fixture(t);
    const observation = await h.service.processToolCall({ command: 'Observe', serial: 'A' });
    const session = await h.start();
    await h.takeoverApi.end(body(session), h.context);
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Tap', index: 0,
        snapshotId: observation.details.snapshotId } }), { code: 'STALE_SNAPSHOT' });
    assert.equal(legacyWrites(h).length, 0);
});

test('takeover cancels the production RunTask parent before approving human input and never resumes it', async t => {
    const entered = deferred(); let resumes = 0;
    const h = await fixture(t, { services: { androidTaskExecutor: {
        prepare: value => ({ ...value, taskId: 'fixture-task', budget: { timeoutMs: 10000 } }),
        async run(_task, device) {
            entered.resolve();
            await new Promise((resolve, reject) => {
                device.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'STEP_ABORTED' })), { once: true });
            });
            resumes++; return { status: 'completed' };
        },
    } } });
    const task = h.service.processToolCall({ command: 'RunTask', task: { serial: 'A' } });
    const stopped = assert.rejects(task, { code: 'STEP_ABORTED' });
    await entered.promise;
    const session = await h.start(); await stopped;
    assert.equal(h.prompts.length, 1); assert.equal(resumes, 0);
    await h.takeoverApi.end(body(session), h.context);
    await tick(); assert.equal(resumes, 0);
});

test('Handoff unknown cannot be silently converted into a successful viewer takeover', async t => {
    const entered = deferred(), answer = deferred();
    const h = await fixture(t, { approve: request => {
        if (request.kind === 'handoff') { entered.resolve(); return answer.promise; }
        return true;
    } });
    const task = h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Handoff', reason: 'fixture' } });
    const stopped = assert.rejects(task);
    await entered.promise;
    const rejected = assert.rejects(h.start(), { code: 'DEVICE_STATE_UNCERTAIN' });
    try { await stopped; } finally { answer.resolve(true); }
    await rejected;
    assert.equal(h.prompts.length, 1); assert.equal(h.hub.sent.length, 0);
    await assert.rejects(h.service.processToolCall({ command: 'Observe', serial: 'A' }), { code: 'DEVICE_STATE_UNCERTAIN' });
});
