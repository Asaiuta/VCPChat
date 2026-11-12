'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const S = require('./storage.cjs');
const { fail } = require('./contract.cjs');
const SOURCES = require('./benchmark-sources.json');

function git(root, args) {
    const result = cp.spawnSync('git', ['-C', root, ...args], {
        encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    });
    if (result.error || result.status !== 0) throw fail('J02_BENCHMARK_GIT_FAILED');
    return result.stdout.trim();
}

function verifyCheckout(suite, root) {
    const source = SOURCES[suite];
    if (!source) throw fail('J02_BENCHMARK_SUITE');
    if (git(root, ['rev-parse', 'HEAD']) !== source.revision) throw fail('J02_BENCHMARK_REVISION');
    const origin = git(root, ['config', '--get', 'remote.origin.url']).replace(/\.git$/, '').replace(/\/$/, '');
    if (origin.toLowerCase() !== source.repository.toLowerCase()) throw fail('J02_BENCHMARK_ORIGIN');
    if (git(root, ['status', '--porcelain', '--untracked-files=all'])) throw fail('J02_BENCHMARK_DIRTY');
    return source;
}

function inventory(root) {
    return git(root, ['ls-files', '-z']).split('\0').filter(Boolean).filter(file => fs.existsSync(path.join(root, file)))
        .sort().map(file => {
            const absolute = path.join(root, file);
            const resolved = fs.realpathSync(absolute);
            const relative = path.relative(fs.realpathSync(root), resolved);
            if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(absolute).isFile()) throw fail('J02_BENCHMARK_SOURCE_PATH');
            return { file, sha256: S.sha(fs.readFileSync(absolute)) };
        });
}

function validateSelection(value, suite, tasks) {
    const keys = ['schemaVersion', 'suite', 'sourceRevision', 'purpose', 'taskIds'];
    if (!value || Object.keys(value).some(key => !keys.includes(key)) || Object.keys(value).length !== keys.length
        || value.schemaVersion !== 1 || value.suite !== suite || value.sourceRevision !== SOURCES[suite]?.revision
        || typeof value.purpose !== 'string' || !value.purpose.trim() || value.purpose.length > 4000
        || !Array.isArray(value.taskIds) || !value.taskIds.length || value.taskIds.length > tasks.length
        || new Set(value.taskIds).size !== value.taskIds.length || value.taskIds.some(id => !tasks.some(task => task.id === id))) {
        throw fail('J02_BENCHMARK_SELECTION');
    }
    return value;
}

function validateExtracted(data, suite) {
    if (!data || !Array.isArray(data.tasks) || data.tasks.length !== SOURCES[suite].expectedTasks
        || new Set(data.tasks.map(task => task.id)).size !== data.tasks.length
        || data.tasks.some(task => typeof task.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(task.id)
            || task.calibrated !== false || task.clusterId !== `${suite}:${task.id}`
            || !Array.isArray(task.appNames) || !task.definition || !task.hooks
            || !(task.goalTemplate === null || typeof task.goalTemplate === 'string'))
        || !data.host || !Array.isArray(data.host.sdk) || !data.details || !Array.isArray(data.readFiles)) {
        throw fail('J02_BENCHMARK_CATALOG_INVALID');
    }
    return data;
}

function plan(catalog, selection, host) {
    validateSelection(selection, catalog.suite, catalog.tasks);
    const prerequisiteBlockers = ['EXECUTION_BINDING_REQUIRED', 'INDEPENDENT_CHECKER_BINDING_REQUIRED',
        'INITIAL_STATE_AND_APP_BYTES_NOT_FROZEN', 'BUDGET_AND_MODEL_NOT_FROZEN', 'BASELINES_NOT_BOUND'];
    if (catalog.suite === 'androidworld') {
        if (!host.sdk.some(sdk => sdk.imagePackages.some(file => file.startsWith('android-33/')))) prerequisiteBlockers.push('ANDROIDWORLD_API33_IMAGE_MISSING');
        if (!host.androidEnvInstalled) prerequisiteBlockers.push('ANDROID_ENV_NOT_INSTALLED');
    } else {
        if (!['linux', 'darwin'].includes(host.platform)) prerequisiteBlockers.push('ANDROIDLAB_OFFICIAL_HOST_UNAVAILABLE');
        if (host.platform === 'linux' && !host.dockerAvailableOnPath) prerequisiteBlockers.push('ANDROIDLAB_DOCKER_UNAVAILABLE');
        prerequisiteBlockers.push('ANDROIDLAB_OFFICIAL_IMAGE_NOT_VERIFIED');
        if (catalog.details.scoringEntrypointHasSyntheticProbe) prerequisiteBlockers.push('DETERMINISTIC_SCORER_BINDING_REQUIRED');
    }
    const selected = selection.taskIds.map(id => {
        const task = catalog.tasks.find(task => task.id === id);
        const blockers = [];
        if (catalog.suite === 'androidworld') blockers.push('NATIVE_TASK_PARAMETERS_NOT_INSTANTIATED');
        if (!task.goalTemplate) blockers.push('DYNAMIC_GOAL_REQUIRES_NATIVE_HARNESS');
        if (!task.packages?.length) blockers.push('PACKAGE_BINDING_UNRESOLVED');
        if ((task.packages?.length || 0) > 1) blockers.push('J02_BATCH_SINGLE_APP_SCOPE');
        if (task.answerRequired) blockers.push('AGENT_ANSWER_CHANNEL_REQUIRED');
        if (task.judgeModel === 'required') blockers.push('JUDGE_MODEL_ACCOUNTING_AND_INDEPENDENT_ORACLE_REQUIRED');
        return { ...task, status: 'not_run', blockers, executionReady: false };
    });
    return {
        format: 'j02-public-benchmark-preparation-v1', suite: catalog.suite,
        sourceRevision: catalog.source.revision, catalogSha256: S.sha(S.canonical(catalog)),
        selectionSha256: S.sha(S.canonical(selection)), purpose: selection.purpose,
        stage: 'exploration_preparation', executionReady: false, calibrated: false,
        scope: 'public_benchmark_separate_from_PJZ110_device_acceptance',
        counts: { available: catalog.tasks.length, selected: selected.length, notSelected: catalog.tasks.length - selected.length,
            executed: 0, notRun: selected.length, independentAcceptanceSamples: 0 },
        statistics: { successRate: null, riskRate: null, independentSampleCount: 0 },
        independence: 'Parameters and repeats of the same upstream task retain its clusterId; cross-template independence is not established.',
        host, prerequisiteBlockers, selected,
        notSelected: catalog.tasks.filter(task => !selection.taskIds.includes(task.id)).map(task => ({ id: task.id, reason: 'outside_initial_feasibility_selection' }))
    };
}

function prepare(suite, checkout, selectionFile, output, python = 'python') {
    checkout = path.resolve(checkout); selectionFile = path.resolve(selectionFile); output = path.resolve(output);
    if (fs.existsSync(output)) throw fail('J02_BENCHMARK_OUTPUT_EXISTS');
    const source = verifyCheckout(suite, checkout);
    const before = inventory(checkout), selection = S.read(selectionFile);
    const extraction = cp.spawnSync(python, ['-B', path.join(__dirname, 'benchmark-extract.py'), suite, checkout], {
        encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true
    });
    if (extraction.error || extraction.status !== 0) throw fail('J02_BENCHMARK_EXTRACT_FAILED');
    let data;
    try { data = validateExtracted(JSON.parse(extraction.stdout), suite); }
    catch (error) { throw fail(error.code || 'J02_BENCHMARK_CATALOG_INVALID'); }
    if (data.readFiles.some(file => !before.some(entry => entry.file === file))) throw fail('J02_BENCHMARK_UNTRACKED_SOURCE');
    verifyCheckout(suite, checkout);
    if (S.canonical(before) !== S.canonical(inventory(checkout))) throw fail('J02_BENCHMARK_SOURCE_CHANGED');
    if (S.canonical(selection) !== S.canonical(S.read(selectionFile))) throw fail('J02_BENCHMARK_SELECTION_CHANGED');
    const catalog = { format: 'j02-public-benchmark-catalog-v1', suite,
        source: { ...source, checkout, availableFiles: before, availableSourceSha256: S.sha(S.canonical(before)),
            licenseText: fs.readFileSync(path.join(checkout, 'LICENSE'), 'utf8') },
        extraction: { method: 'static_ast_and_safe_yaml_no_upstream_import', python: data.host.python,
            toolIdentity: S.snapshot(['benchmark.cjs', 'benchmark-extract.py', 'benchmark-sources.json', 'storage.cjs', 'contract.cjs'].map(file => path.join(__dirname, file))),
            readFiles: data.readFiles },
        details: data.details, tasks: data.tasks };
    const prepared = plan(catalog, selection, data.host);
    fs.mkdirSync(output);
    S.write(path.join(output, 'catalog.json'), catalog);
    S.write(path.join(output, 'selection.json'), selection);
    S.write(path.join(output, 'preflight.json'), prepared);
    S.write(path.join(output, 'identity.json'), S.snapshot(['catalog.json', 'selection.json', 'preflight.json'].map(file => path.join(output, file))));
    return { status: 'prepared_not_run', output, suite, ...prepared.counts, calibrated: false, executionReady: false,
        blockers: prepared.prerequisiteBlockers };
}

module.exports = { prepare, plan, validateSelection, validateExtracted, verifyCheckout, inventory };
