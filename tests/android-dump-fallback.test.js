'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { harness, xml } = require('./helpers/android-service-harness.cjs');
const observe = h => h.service.processToolCall({ command: 'Observe', serial: 'A' });
const acquisition = h => h.calls.filter(call => call[0] === 'adb' &&
    (call[1].includes('uiautomator') || call[1].includes('cat'))).map(call => Array.from(call[1]));
const tty = ['exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty'];

test('idle timeout retries tty once and recovers without file fallback', async t => {
    const h = await harness({ dump: index => index === 0 ? 'ERROR: could not get idle state.' : xml() });
    t.after(() => h.service.cleanup());
    await observe(h);
    assert.deepEqual(acquisition(h), [tty, tty]);
});

test('persistent idle fails with diagnostic and never runs file fallback', async t => {
    const h = await harness({ dump: () => 'ERROR: could not get idle state.' });
    t.after(() => h.service.cleanup());
    await assert.rejects(observe(h), error => {
        assert.equal(error.code, 'UI_IDLE_TIMEOUT');
        assert.match(error.message, /界面.*动画/);
        return true;
    });
    assert.deepEqual(acquisition(h), [tty, tty]);
});

test('unavailable tty uses file dump then reads the resulting hierarchy', async t => {
    const h = await harness({ dump: (index, args) => args.includes('/dev/tty') ? new Error('tty unavailable') : xml() });
    t.after(() => h.service.cleanup());
    await observe(h);
    assert.deepEqual(acquisition(h), [tty,
        ['shell', 'uiautomator', 'dump', '/data/local/tmp/vcp_ui_dump.xml'],
        ['exec-out', 'cat', '/data/local/tmp/vcp_ui_dump.xml']]);
});
