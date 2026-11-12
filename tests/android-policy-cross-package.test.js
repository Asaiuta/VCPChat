'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./helpers/android-service-harness.cjs');

const mixedTree = (attributes = '') => `<hierarchy rotation="0">
  <node class="android.widget.Button" package="com.example" resource-id="com.example:id/open"
    text="" clickable="true" bounds="[0,0][100,80]">
    <node class="android.widget.TextView" package="com.other" text="PRIVATE CONTENT"
      clickable="false" bounds="[0,0][100,40]" ${attributes}/>
  </node>
</hierarchy>`;
const inputCalls = h => h.calls.filter(call => call[0] === 'rpc'
    || (call[0] === 'adb' && call[1].includes('input')));

for (const attributes of ['', 'visible-to-user="false"']) {
    test(`Observe rejects denied raw descendants even when folded or hidden: ${attributes || 'folded'}`, async () => {
        const h = await harness({ dump: () => mixedTree(attributes),
            config: { INTERACTION_POLICY: { denyPackages: ['com.other'] } } });
        await assert.rejects(h.service.processToolCall({ command: 'Observe', limit: 1 }), { code: 'POLICY_DENIED' });
        assert.equal(h.service._internals.lastObserve.size, 0);
        assert.equal(inputCalls(h).length, 0);
    });
}

test('idle sampling cannot verify a tree containing a denied noncontrol', async () => {
    const h = await harness({ dump: () => mixedTree(),
        config: { INTERACTION_POLICY: { denyPackages: ['com.other'] } } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep',
        action: { command: 'Wait', mode: 'idle' }, waitMs: 1000 }), { code: 'POLICY_DENIED' });
    assert.equal(inputCalls(h).length, 0);
});

test('stale attachment rejects denied raw content without replacing the original error', async () => {
    const h = await harness({ dump: () => mixedTree(),
        config: { INTERACTION_POLICY: { denyPackages: ['com.other'] } } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep',
        action: { command: 'Tap', index: 0, snapshotId: 'expired' } }), error => {
        assert.equal(error.code, 'STALE_SNAPSHOT');
        assert.equal(error.details.screen, null);
        assert.equal(error.details.screenReason, 'POLICY_DENIED');
        return true;
    });
    assert.equal(inputCalls(h).length, 0);
});

test('read-only raw descendants prevent unscoped keys and pixels even when folded into another package', async () => {
    const h = await harness({ dump: () => mixedTree(),
        config: { INTERACTION_POLICY: { readOnlyPackages: ['com.other'] } } });
    assert.equal((await h.service.processToolCall({ command: 'Observe' })).details.controls.length, 1);
    const image = await h.service.processToolCall({ command: 'Observe', mode: 'image' });
    for (const action of [{ command: 'KeyEvent', key: 'enter' },
        { command: 'Tap', x: 20, y: 20, frameId: image.details.frameId }]) {
        await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep', action }), { code: 'POLICY_DENIED' });
    }
    assert.equal(inputCalls(h).length, 0);
});

test('exact foreign-package target uses its own write policy', async () => {
    const tree = mixedTree().replace('clickable="false"', 'clickable="true" resource-id="com.other:id/open"');
    const h = await harness({ dump: () => tree,
        config: { INTERACTION_POLICY: { readOnlyPackages: ['com.other'] } } });
    await assert.rejects(h.service.processToolCall({ command: 'ExecuteStep',
        action: { command: 'Tap', id: 'com.other:id/open' } }), { code: 'POLICY_DENIED' });
    assert.equal(inputCalls(h).length, 0);
});

test('an allowed mixed-package tree retains its complete semantics', async () => {
    const h = await harness({ dump: () => mixedTree() });
    const result = await h.service.processToolCall({ command: 'Observe', limit: 1 });
    assert.match(JSON.stringify(result.details.controls), /PRIVATE CONTENT/);
    assert.equal(result.details.actionable, true);
});
