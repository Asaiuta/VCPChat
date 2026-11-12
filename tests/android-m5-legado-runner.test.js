'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, taskOf, independentEvidence, diagnoseIndependent, readIndependent, SNAPSHOT_POLICY } = require('../scripts/verify-android-m5-legado.cjs');
const pkg = 'io.legado.app.release';
const node = (id, text, children = '', extra = '') => `<node package="${pkg}" resource-id="${pkg}:id/${id}" text="${text}" bounds="[0,0][100,100]" ${extra}>${children}</node>`;
const screen = content => `<?xml version="1.0"?><hierarchy><node bounds="[0,0][100,200]">${content}</node></hierarchy>\nUI hierarchy dumped to: /dev/tty`;

test('Legado experiment requires explicit serial, query and new output; trial count is bounded', () => {
    const args = ['--serial', 'A', '--query', 'PRIVATE', '--output', 'new-result'];
    assert.equal(parseArgs(args).runs, 1);
    for (const invalid of [[], args.slice(0, 4), [...args, '--runs', '0'], [...args, '--runs', '21'],
        [...args, '--runs', '1.5'], [...args, '--serial', 'B'], [...args, '--unknown', 'x']]) assert.throws(() => parseArgs(invalid));
    assert.equal(taskOf('A', 'PRIVATE').decision, 'rules');
    assert.equal(taskOf('A', 'PRIVATE').completion.itemMatchesInput, true);
    assert.equal(taskOf('A', 'PRIVATE').completion.absent, undefined);
});

test('independent acquisition records distinct failure stages without persisting process or screen text', () => {
    const cases = [
        [{ status: 0, stdout: 'ERROR: could not get idle state. PRIVATE' }, 'INDEPENDENT_IDLE_TIMEOUT', 'envelope'],
        [{ status: 0, stderr: 'UiAutomation not connected PRIVATE' }, 'INDEPENDENT_AUTOMATION_BUSY', 'envelope'],
        [{ status: 0, stdout: '' }, 'INDEPENDENT_EMPTY_OUTPUT', 'envelope'],
        [{ status: 0, stdout: '<?xml version="1.0"?><hierarchy><node text="PRIVATE"/>' }, 'INDEPENDENT_XML_TRUNCATED', 'envelope'],
        [{ status: 0, stdout: 'PRIVATE non-XML output' }, 'INDEPENDENT_XML_ENVELOPE', 'envelope'],
        [{ status: 0, stdout: '<?xml version="1.0"?><hierarchy></hierarchy>' }, 'INDEPENDENT_XML_ROOT', 'root'],
        [{ status: 0, stdout: '<?xml version="1.0"?><hierarchy><node bounds="PRIVATE"/></hierarchy>' }, 'INDEPENDENT_XML_BOUNDS', 'bounds'],
        [{ status: 1, stderr: 'Permission denied PRIVATE' }, 'INDEPENDENT_ADB_FAILED', 'process'],
        [{ status: null, error: { code: 'ETIMEDOUT', message: 'PRIVATE' }, signal: 'SIGTERM' }, 'INDEPENDENT_ADB_TIMEOUT', 'process'],
    ];
    for (const [process, code, stage] of cases) {
        const result = diagnoseIndependent(process, 'PRIVATE', 123);
        assert.equal(result.matched, false);
        assert.equal(result.error, code);
        assert.equal(result.diagnostics.stage, stage);
        assert.equal(result.diagnostics.elapsedMs, 123);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE|could not|Permission denied|not connected/);
    }
});

test('a timed-out process cannot pass using partial valid XML', () => {
    const stdout = screen(node('search_src_text', 'PRIVATE') + node('recycler_view', '', node('tv_name', 'PRIVATE')));
    assert.equal(diagnoseIndependent({ status: 0, stdout }, 'PRIVATE', 10).matched, true);
    const failed = diagnoseIndependent({ status: null, stdout, error: { code: 'ETIMEDOUT' } }, 'PRIVATE', 20000);
    assert.equal(failed.matched, false);
    assert.equal(failed.error, 'INDEPENDENT_ADB_TIMEOUT');
});

test('snapshot failure exposes only bounded stage metadata and never retries the process', async () => {
    let calls = 0;
    const result = await readIndependent({ policy: SNAPSHOT_POLICY, query: 'PRIVATE', gate() {},
        execute() { calls++; return { status: 1, stdout: '', stderr:
            'VCP_SNAPSHOT_TREE_FAILED\nVCP_SNAPSHOT_DETAIL TREE_CHANGED\nVCP_SNAPSHOT_TREE_RETRY\nPRIVATE raw error' }; } });
    assert.equal(calls, 1);
    assert.equal(result.matched, false);
    assert.equal(result.diagnostics.snapshotStage, 'TREE');
    assert.equal(result.diagnostics.snapshotDetail, 'TREE_CHANGED');
    assert.equal(result.diagnostics.treeRetries, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|raw error/);
});

test('one drained idle read may be sampled again, preserving both attempts and the full deadline', async () => {
    let time = 0, calls = 0, gates = 0;
    const limits = [];
    const valid = screen(node('search_src_text', 'PRIVATE') + node('recycler_view', '', node('tv_name', 'PRIVATE')));
    const result = await readIndependent({ query: 'PRIVATE', now: () => time, wait: async ms => { time += ms; },
        gate() { gates++; }, execute(timeout) {
            limits.push(timeout); calls++; time += 11700;
            return { status: 0, stdout: calls === 1 ? 'ERROR: could not get idle state.' : valid };
        } });
    assert.equal(result.matched, true);
    assert.equal(calls, 2); assert.equal(gates, 4);
    assert.deepEqual(limits, [20000, 18100]);
    assert.equal(result.attempts[0].error, 'INDEPENDENT_IDLE_TIMEOUT');
    assert.equal(result.attempts[1].matched, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('unknown transport, malformed XML, mismatching results and repeated idle do not trigger task replay', async () => {
    for (const process of [{ status: null, error: { code: 'ETIMEDOUT' } }, { status: 1 },
        { status: 0, stdout: '<?xml version="1.0"?><hierarchy>' },
        { status: 0, stdout: screen(node('recycler_view', '')) }]) {
        let calls = 0;
        const result = await readIndependent({ query: 'PRIVATE', gate() {}, wait: async () => {},
            execute() { calls++; return process; } });
        assert.equal(calls, 1); assert.equal(result.matched, false);
    }
    let calls = 0;
    const stopped = await readIndependent({ query: 'PRIVATE', gate() {}, wait: async () => {},
        execute() { calls++; return { status: 0, stdout: 'ERROR: could not get idle state.' }; } });
    assert.equal(calls, 2); assert.equal(stopped.matched, false);
    assert.equal(stopped.error, 'INDEPENDENT_IDLE_TIMEOUT');
});

test('foreground loss or exhausted shared deadline prevents the second read', async () => {
    let calls = 0, gates = 0;
    await assert.rejects(readIndependent({ query: 'PRIVATE', wait: async () => {},
        gate() { if (++gates === 2) throw Object.assign(Error(), { code: 'WRONG_FOREGROUND' }); },
        execute() { calls++; return { status: 0, stdout: 'ERROR: could not get idle state.' }; } }), { code: 'WRONG_FOREGROUND' });
    assert.equal(calls, 1);
    let time = 0; calls = 0;
    const result = await readIndependent({ query: 'PRIVATE', now: () => time, gate() {}, wait: async () => {},
        execute() { calls++; time += 30000; return { status: 0, stdout: 'ERROR: could not get idle state.' }; } });
    assert.equal(calls, 1); assert.equal(result.matched, false);
    assert.equal(result.error, 'INDEPENDENT_DEADLINE');
});

test('independent evidence requires visible matching descendants and the exact input; returns only counts/booleans', () => {
    const field = node('search_src_text', 'PRIVATE');
    const item = node('tv_name', 'title PRIVATE');
    const valid = independentEvidence(screen(field + node('recycler_view', '', item)), 'PRIVATE');
    assert.equal(valid.matched, true);
    assert.equal(valid.visibleItems, 1);
    assert.doesNotMatch(JSON.stringify(valid), /PRIVATE|title|recycler/);
    for (const content of [field + node('recycler_view', ''), field + node('recycler_view', '') + item,
        field + node('recycler_view', '', node('tv_name', 'unrelated')),
        field + node('recycler_view', '', node('tv_name', 'PRIVATE', '', 'password="true"')),
        field + node('recycler_view', '', item, 'visible-to-user="false"'),
        node('search_src_text', 'wrong') + node('recycler_view', '', item),
        field + node('recycler_view', '', item) + node('recycler_view', '', item)]) {
        assert.equal(independentEvidence(screen(content), 'PRIVATE').matched, false);
    }
    assert.throws(() => independentEvidence('not XML', 'PRIVATE'));
});
