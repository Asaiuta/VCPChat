'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const B = require('../scripts/android-j02/benchmark.cjs');
const sources = require('../scripts/android-j02/benchmark-sources.json');
const { validate } = require('../scripts/android-j02/contract.cjs');
const { main } = require('../scripts/android-j02-batch.cjs');

function fixture(suite = 'androidworld') {
    const tasks = Array.from({ length: sources[suite].expectedTasks }, (_, index) => ({
        id: 'Task' + index, clusterId: `${suite}:Task${index}`, calibrated: false,
        appNames: ['Settings'], packages: ['com.android.settings'], goalTemplate: 'Turn on a setting',
        parameterSchema: null, definition: { file: 'source.py', line: 1 }, hooks: {}, answerRequired: false, judgeModel: 'not_invoked_by_importer'
    }));
    const host = { platform: 'win32', sdk: [{ imagePackages: ['android-36.1/google_apis_playstore/x86_64/package.xml'] }],
        androidEnvInstalled: false, dockerAvailableOnPath: false };
    const catalog = { suite, source: sources[suite], details: { scoringEntrypointHasSyntheticProbe: suite === 'androidlab' }, tasks };
    const selection = { schemaVersion: 1, suite, sourceRevision: sources[suite].revision, purpose: 'offline feasibility', taskIds: ['Task0', 'Task1'] };
    return { tasks, host, catalog, selection };
}

test('preparation preserves all selected and unselected denominators without reporting a model score', () => {
    const f = fixture(), p = B.plan(f.catalog, f.selection, f.host);
    assert.deepEqual(p.counts, { available: 116, selected: 2, notSelected: 114, executed: 0, notRun: 2, independentAcceptanceSamples: 0 });
    assert.equal(p.statistics.successRate, null);
    assert.equal(p.statistics.riskRate, null);
    assert.equal(p.calibrated, false);
    assert.equal(p.executionReady, false);
    assert.equal(p.selected[0].clusterId, 'androidworld:Task0');
    assert.equal(p.notSelected.length, 114);
    assert.ok(p.prerequisiteBlockers.includes('ANDROIDWORLD_API33_IMAGE_MISSING'));
    assert.ok(p.prerequisiteBlockers.includes('ANDROID_ENV_NOT_INSTALLED'));
    assert.throws(() => validate('manifest', p), { code: 'J02_MANIFEST_INVALID' });
});

test('complete host prerequisites do not invent an execution binding or independent oracle', () => {
    const f = fixture();
    f.host.sdk[0].imagePackages = ['android-33/google_apis/x86_64/package.xml'];
    f.host.androidEnvInstalled = true;
    const p = B.plan(f.catalog, f.selection, f.host);
    assert.ok(!p.prerequisiteBlockers.includes('ANDROIDWORLD_API33_IMAGE_MISSING'));
    assert.ok(p.prerequisiteBlockers.includes('EXECUTION_BINDING_REQUIRED'));
    assert.equal(p.executionReady, false);
});

test('AndroidLab judge requests, scoring probes and missing answer channel remain explicit blockers', () => {
    const f = fixture('androidlab');
    f.tasks[0].judgeModel = 'required'; f.tasks[0].answerRequired = true;
    const p = B.plan(f.catalog, f.selection, f.host);
    assert.ok(p.prerequisiteBlockers.includes('ANDROIDLAB_OFFICIAL_HOST_UNAVAILABLE'));
    assert.ok(p.prerequisiteBlockers.includes('DETERMINISTIC_SCORER_BINDING_REQUIRED'));
    assert.ok(p.selected[0].blockers.includes('JUDGE_MODEL_ACCOUNTING_AND_INDEPENDENT_ORACLE_REQUIRED'));
    assert.ok(p.selected[0].blockers.includes('AGENT_ANSWER_CHANNEL_REQUIRED'));
    assert.ok(!p.selected[1].blockers.includes('AGENT_ANSWER_CHANNEL_REQUIRED'));
});

test('unresolved goals and packages and multiple packages are retained as not-run tasks', () => {
    const f = fixture();
    f.tasks[0].goalTemplate = null; f.tasks[0].packages = null;
    f.tasks[1].packages = ['one.app', 'two.app'];
    const p = B.plan(f.catalog, f.selection, f.host);
    assert.ok(p.selected[0].blockers.includes('DYNAMIC_GOAL_REQUIRES_NATIVE_HARNESS'));
    assert.ok(p.selected[0].blockers.includes('PACKAGE_BINDING_UNRESOLVED'));
    assert.ok(p.selected[1].blockers.includes('J02_BATCH_SINGLE_APP_SCOPE'));
    assert.equal(p.counts.notRun, 2);
});

for (const fault of ['revision', 'duplicate', 'unknown', 'override', 'empty']) test(`invalid selection is rejected: ${fault}`, () => {
    const f = fixture();
    if (fault === 'revision') f.selection.sourceRevision = '0'.repeat(40);
    if (fault === 'duplicate') f.selection.taskIds = ['Task0', 'Task0'];
    if (fault === 'unknown') f.selection.taskIds = ['NotInUpstream'];
    if (fault === 'override') f.selection.goal = 'changed task';
    if (fault === 'empty') f.selection.taskIds = [];
    assert.throws(() => B.plan(f.catalog, f.selection, f.host), { code: 'J02_BENCHMARK_SELECTION' });
});

test('catalog cannot silently drop a task, duplicate tasks or promote imported evidence', () => {
    const f = fixture(), data = { tasks: f.tasks, host: f.host, details: {}, readFiles: [] };
    assert.equal(B.validateExtracted(data, 'androidworld'), data);
    for (const mutation of [copy => copy.tasks.pop(), copy => { copy.tasks[1] = copy.tasks[0]; }, copy => { copy.tasks[0].calibrated = true; }]) {
        const changed = structuredClone(data); mutation(changed);
        assert.throws(() => B.validateExtracted(changed, 'androidworld'), { code: 'J02_BENCHMARK_CATALOG_INVALID' });
    }
});

test('CLI prepares benchmarks but execution still requires the formal frozen batch path', async () => {
    assert.ok((await main(['help'])).usage.some(line => line.startsWith('benchmark-prepare ')));
    await assert.rejects(main(['benchmark-run', 'anything', '--real']), { code: 'J02_OPTIONS_INVALID' });
    await assert.rejects(main(['benchmark-prepare', 'invalid', '.', 'missing.json', 'missing-output']), { code: 'J02_BENCHMARK_SUITE' });
});

test('checkout identity rejects changed origin, revision and dirty source before extraction', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'j02-benchmark-source-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); delete sources.fixture; });
    const git = (...args) => {
        const r = cp.spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
    };
    git('init', '--quiet');
    fs.writeFileSync(path.join(root, 'task.py'), '# offline source\n');
    git('add', 'task.py');
    git('-c', 'user.name=Offline test', '-c', 'user.email=offline@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const revision = git('rev-parse', 'HEAD');
    sources.fixture = { repository: 'https://example.invalid/benchmark', revision };
    git('remote', 'add', 'origin', sources.fixture.repository);
    assert.equal(B.verifyCheckout('fixture', root).revision, revision);
    const before = B.inventory(root);
    assert.equal(before.length, 1);
    fs.appendFileSync(path.join(root, 'task.py'), '# local change\n');
    assert.throws(() => B.verifyCheckout('fixture', root), { code: 'J02_BENCHMARK_DIRTY' });
    assert.notDeepEqual(B.inventory(root), before);
    fs.writeFileSync(path.join(root, 'task.py'), '# offline source\n');
    sources.fixture.revision = '0'.repeat(40);
    assert.throws(() => B.verifyCheckout('fixture', root), { code: 'J02_BENCHMARK_REVISION' });
    sources.fixture.revision = revision;
    git('remote', 'set-url', 'origin', 'https://example.invalid/different');
    assert.throws(() => B.verifyCheckout('fixture', root), { code: 'J02_BENCHMARK_ORIGIN' });
});
