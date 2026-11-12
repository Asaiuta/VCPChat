'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');
const tree = (bounds = '[0,0][100,200]', extra = '') => `<hierarchy rotation="0"><node class="android.widget.ScrollView" package="com.example" resource-id="com.example:id/list" scrollable="true" bounds="${bounds}" ${extra}/></hierarchy>`;
const inputs = h => h.calls.filter(([kind, args]) => kind === 'adb' && args[1] === 'input');
const run = (h, action, extra = {}) => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A', action: { command: 'Scroll', id: 'com.example:id/list', ...action }, ...extra });

for (const [direction, coordinates] of [
    ['down', ['50', '160', '50', '40']],
    ['up', ['50', '40', '50', '160']],
    ['right', ['80', '100', '20', '100']],
    ['left', ['20', '100', '80', '100']],
]) test(`Scroll ${direction} describes viewport travel, not finger direction`, async () => {
    const h = await harness({ dump: () => tree() });
    const result = await run(h, { direction });
    assert.deepEqual(Array.from(inputs(h)[0][1]), ['shell', 'input', 'swipe', ...coordinates, '300']);
    assert.equal(inputs(h).length, 1);
    assert.equal(result.details.execution.outcome, 'dispatched');
    assert.equal(result.details.direction, direction);
    assert.equal(h.dumpCount, 2, '目标采样与最终policy gate各一次');
});

test('Scroll clips a partially visible container and respects distance and duration', async () => {
    const h = await harness({ dump: () => tree('[-50,-50][150,250]') });
    await run(h, { direction: 'down', distance: 0.5, duration: 450 });
    assert.deepEqual(Array.from(inputs(h)[0][1]), ['shell', 'input', 'swipe', '50', '150', '50', '50', '450']);
});

test('Scroll index requires and consumes a current snapshot; semantic id rebinds live bounds', async () => {
    const h = await harness({ dump: () => tree() });
    const observed = await h.service.processToolCall({ command: 'Observe', serial: 'A', wake: 'never' });
    await run(h, { id: undefined, index: 0, snapshotId: observed.details.snapshotId, direction: 'down' }, { afterObserve: true });
    assert.equal(inputs(h).length, 1);
    await assert.rejects(run(h, { id: undefined, index: 0, snapshotId: observed.details.snapshotId, direction: 'down' }), { code: 'STALE_SNAPSHOT' });
    const g = await harness({ dump: n => tree(n === 0 ? '[0,0][100,200]' : '[0,20][100,180]') });
    await g.service.processToolCall({ command: 'Observe', wake: 'never' });
    await run(g, { direction: 'down' });
    assert.deepEqual(Array.from(inputs(g)[0][1]).slice(3, 7), ['50', '148', '50', '52']);
});

for (const action of [
    {}, { direction: 'diagonal' }, { direction: 'down', distance: 0 },
    { direction: 'down', distance: 1 }, { direction: 'down', distance: 'garbage' },
    { direction: 'down', duration: 0 }, { direction: 'down', duration: 10001 },
    { direction: 'down', duration: 1.2 }, { direction: 'down', x: 50, y: 100 },
    { direction: 'down', duration: true }, { direction: 'down', distance: [0.5] },
    { direction: 'down', index: null, id: undefined },
    { direction: 'down', duration: '0x10' }, { direction: 'down', duration: '1e2' },
    { direction: 'down', index: '0x0', id: undefined }, { direction: 'down', index: '0e0', id: undefined },
    { direction: 'down', id: undefined },
]) test(`Scroll rejects invalid parameters before input: ${JSON.stringify(action)}`, async () => {
    const h = await harness({ dump: () => tree() });
    await assert.rejects(run(h, action), { code: 'INVALID_ARGUMENT' });
    assert.equal(inputs(h).length, 0);
    assert.equal(h.dumpCount, 0);
});

for (const [name, source] of [
    ['not scrollable', tree().replace('scrollable="true"', 'scrollable="false" clickable="true"')],
    ['tiny', tree('[0,0][2,2]')],
]) test(`Scroll refuses ${name} target without input`, async () => {
    const h = await harness({ dump: () => source });
    await assert.rejects(run(h, { direction: 'down' }), { code: 'INVALID_SCROLL_TARGET' });
    assert.equal(inputs(h).length, 0);
});

test('Scroll does not retry backend failure and keeps an unknown receipt', async () => {
    const h = await harness({ dump: () => tree(), run: args => { if (args[1] === 'input') throw Object.assign(new Error('device failed'), { code: 'ADB_FAILED' }); } });
    await assert.rejects(run(h, { direction: 'down' }), error => error.execution.outcome === 'unknown');
    assert.equal(inputs(h).length, 1);
});

test('Scroll refuses changed index geometry before input', async () => {
    const h = await harness({ dump: n => tree(n === 0 ? '[0,0][100,200]' : '[0,20][100,180]') });
    const observed = await h.service.processToolCall({ command: 'Observe', wake: 'never' });
    await assert.rejects(run(h, { id: undefined, index: 0, snapshotId: observed.details.snapshotId, direction: 'down' }), { code: 'STALE_SNAPSHOT' });
    assert.equal(inputs(h).length, 0);
});


test('Scroll targets explicit B without changing default A and reports the post-action observation', async () => {
    const h = await harness({ dump: () => tree() });
    const result = await run(h, { direction: 'down' }, { serial: 'B', afterObserve: true });
    assert.equal(inputs(h)[0][2].serial, 'B');
    assert.equal(result.details.observation.serial, 'B');
    assert.equal(h.client.serial, 'A');
    assert.equal(result.details.observation.status, 'observed');
});

test('Scroll keeps device leased until its one input command completes', async () => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness({ dump: () => tree(), run: async args => { if (args[1] === 'input') { entered(); await gate; } } });
    const work = run(h, { direction: 'down' });
    await ready;
    try {
        await assert.rejects(run(h, { direction: 'up' }), { code: 'DEVICE_BUSY' });
    } finally { release(); }
    await work;
    assert.equal(inputs(h).length, 1);
});
