'use strict';

// One user-requested real workload. Never a model probe or an admission runner.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { parseSafety } = require('./verify-android-m15.cjs');
const { createSnapshotReader } = require('./android-independent-snapshot/reader.cjs');
const { SEARCH_POLICY, JEV_REQUEST_POLICY } = require('../modules/services/androidTaskPolicy');
const { POLICY: UI_POLICY } = require('../modules/services/androidUiTaskContract');
const ROOT = path.resolve(__dirname, '..');
const PKG = 'io.legado.app.release';
const QUERY = '魔女之旅';
const AUTHOR = '白石定规';
const id = suffix => `${PKG}:id/${suffix}`;
const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex');
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'EXPLORATION_FAILED';

function parseTree(xml) {
    const start = xml.indexOf('<?xml'), end = xml.lastIndexOf('</hierarchy>');
    if (start < 0 || end < start || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw fail('CHECKER_XML_INVALID');
    const invalid = () => { throw fail('CHECKER_XML_INVALID'); };
    const doc = new DOMParser({ errorHandler: { warning: invalid, error: invalid, fatalError: invalid } })
        .parseFromString(xml.slice(start, end + 12), 'text/xml');
    if (doc.documentElement.tagName !== 'hierarchy') throw fail('CHECKER_XML_INVALID');
    return Array.from(doc.getElementsByTagName('node'));
}
const visible = node => {
    const b = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.getAttribute('bounds'));
    return node.getAttribute('package') === PKG && node.getAttribute('visible-to-user') === 'true'
        && node.getAttribute('password') !== 'true' && b && +b[3] > +b[1] && +b[4] > +b[2];
};
const normalized = text => text.normalize('NFC').trim();

function checkBook(xml) {
    const all = parseTree(xml);
    const containers = all.filter(n => visible(n) && n.getAttribute('resource-id') === id('recycler_view'));
    const field = all.filter(n => visible(n) && n.getAttribute('resource-id') === id('search_src_text'));
    const queryMatches = field.length === 1 && field[0].getAttribute('text') === QUERY;
    if (containers.length !== 1) return { verdict: 'unknown', uiMatched: false, matchingRows: 0, queryMatches, code: 'RESULT_CONTAINER_UNPROVEN' };
    const container = containers[0];
    const titles = Array.from(container.getElementsByTagName('node')).filter(n => visible(n) && n.getAttribute('resource-id') === id('tv_name'));
    let matchingRows = 0;
    for (const title of titles) {
        if (normalized(title.getAttribute('text')) !== QUERY) continue;
        let row = title;
        while (row.parentNode && row.parentNode !== container) row = row.parentNode;
        if (row.parentNode !== container) continue;
        const nodes = [row, ...Array.from(row.getElementsByTagName('node'))];
        const rowTitles = nodes.filter(n => visible(n) && n.getAttribute('resource-id') === id('tv_name'));
        const authors = nodes.filter(n => visible(n) && n.getAttribute('resource-id') === id('tv_author'));
        if (rowTitles.length === 1 && authors.length === 1
            && normalized(authors[0].getAttribute('text')).replace(/^作者[:：]\s*/u, '') === AUTHOR) matchingRows++;
    }
    const uiMatched = queryMatches && titles.some(n => n.getAttribute('text').includes(QUERY));
    return { verdict: queryMatches && matchingRows > 0 ? 'pass' : 'fail', uiMatched, matchingRows, queryMatches,
        code: queryMatches && matchingRows > 0 ? 'BOOK_AND_AUTHOR_MATCHED' : 'BOOK_AND_AUTHOR_NOT_PROVEN' };
}

function sourceIdentity(snapshotJar) {
    const files = new Set(['package.json', 'package-lock.json', 'scripts/android-j02-ui-task.cjs', 'scripts/android-j02-search.cjs',
        'scripts/verify-android-m15.cjs', 'scripts/android-independent-snapshot/reader.cjs',
        'scripts/android-independent-snapshot/src/com/vcpchat/validation/Snapshot.java',
        'docs/android-controller/j02/ui-report.schema.json', 'docs/android-controller/j02/report.schema.json',
        'docs/android-controller/2026-11-07_jev-j02-search-protocol.md', 'docs/android-controller/2026-11-07_jev-ui-task-protocol.md',
        'docs/android-controller/2026-11-08_jev-ui-task-protocol-v20.md',
        'modules/services/globalJevService.js', 'modules/services/jevClient.js', 'modules/services/jevTransport.js']);
    for (const name of fs.readdirSync(path.join(ROOT, 'modules/services'))) {
        if (/^(android|humanInteraction).*\.js$/.test(name)) files.add(`modules/services/${name}`);
    }
    const walk = dir => {
        for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const relative = `${dir}/${entry.name}`;
            if (entry.isDirectory()) walk(relative);
            else if (/\.(js|json|jar|apk)$/.test(entry.name)) files.add(relative);
        }
    };
    walk('VCPDistributedServer/Plugin/AndroidController');
    // Follow local CommonJS dependencies as well as task-prefixed modules.
    // Settings persistence, for example, imports a shared atomic-file utility.
    // Freeze its bytes too; a package-prefix inventory alone is not executable.
    for (const file of files) {
        if (!/\.(?:js|cjs)$/.test(file)) continue;
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const match of source.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)) {
            const resolved = require.resolve(path.resolve(ROOT, path.dirname(file), match[2]));
            const relative = path.relative(ROOT, resolved).replaceAll('\\', '/');
            if (relative.startsWith('../') || path.isAbsolute(relative)) throw fail('SOURCE_OUTSIDE_ROOT');
            if (!relative.startsWith('node_modules/')) files.add(relative);
        }
    }
    const result = Object.fromEntries([...files].sort().map(file => [file, digest(fs.readFileSync(path.join(ROOT, file)))]));
    result.snapshotJar = digest(fs.readFileSync(snapshotJar));
    return result;
}

function reportValidator(schema, arm) {
    const trial = schema.definitions?.trial;
    if (!trial?.properties?.arm?.enum?.includes(arm) || trial.allOf?.[0]?.if?.properties?.arm?.const !== arm)
        throw fail('REPORT_POLICY_MISMATCH');
    return new (require('ajv'))({ allErrors: true }).compile(schema);
}

async function main(argv = process.argv.slice(2), { generic = false } = {}) {
    const policy = generic ? UI_POLICY : SEARCH_POLICY;
    const arm = `jev-candidate-${policy.version}`;
    const schemaVersion = generic ? 4 : 3;
    const schemaPath = generic ? '../docs/android-controller/j02/ui-report.schema.json' : '../docs/android-controller/j02/report.schema.json';
    const validate = reportValidator(require(schemaPath), arm);
    const promptFile = generic ? 'modules/services/androidUiTaskLoop.js' : 'modules/services/androidSearchLoop.js';
    if (argv.length !== 3 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(argv[0])) throw fail('INVALID_OPTIONS');
    const [serial, jarInput, outputInput] = argv;
    const jar = path.resolve(jarInput), output = path.resolve(outputInput);
    fs.mkdirSync(output, { recursive: false });
    const write = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    const emit = row => fs.appendFileSync(path.join(output, 'events.jsonl'), JSON.stringify(row) + '\n');
    // Diagnostic observer for the existing reads; does not add device commands.
    const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
    const { windowDisplaySections, displayUniqueId, displayDeviceInfo, isShellPrivateMirror, MIRROR_CONTEXT_POLICY_VERSION } = require('../VCPDistributedServer/Plugin/AndroidController/lib/display-target');
    const originalRead = AdbClient.prototype.runText;
    let lastWindowSections = [];
    AdbClient.prototype.runText = async function(args, options) {
        const result = await originalRead.call(this, args, options);
        if (args[0] === 'shell' && args[1]?.startsWith('dumpsys window displays ||')) {
            try {
                lastWindowSections = windowDisplaySections(result.split('@@VCP_POLICY@@')[0]);
                emit({ phase: 'probe_windows', displays: lastWindowSections.map(p => ({ displayId: p.displayId,
                    focusNull: /^\s*mCurrentFocus=null\s*$/m.test(p.text),
                    focusAppNull: /^\s*mFocusedApp=null\s*$/m.test(p.text),
                    activityPresent: /ActivityRecord\{/.test(p.text),
                    activityFields: p.displayId === 0 ? [] : p.text.split('\n').filter(line => /ActivityRecord\{/.test(line))
                        .slice(0, 8).map(line => line.replace(/ActivityRecord\{[^}]*\}/g, 'ActivityRecord{redacted}').slice(0, 200)) })) });
            } catch { emit({ phase: 'probe_windows', parseFailed: true }); }
        } else if (args[0] === 'shell' && args[1] === 'dumpsys display') {
            emit({ phase: 'probe_mirrors', displays: lastWindowSections.filter(p => p.displayId !== 0).map(p => {
                const unique = displayUniqueId(result, p.displayId), info = displayDeviceInfo(result, unique);
                return { displayId: p.displayId, identityPresent: !!unique, infoPresent: !!info,
                    shellOwner: info?.ownerPackage === 'com.android.shell' && info?.ownerUid === 2000,
                    virtual: info?.type === 'VIRTUAL', flags: info?.flags || [],
                    provenMirror: isShellPrivateMirror(info, p.text) };
            }) });
        }
        return result;
    };
    const adb = 'D:/AI/tools/platform-tools/adb.exe';
    const executeAdb = (args, device = true, timeout = 20000) => cp.spawnSync(adb, [...(device ? ['-s', serial] : []), ...args],
        { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const read = args => {
        const r = executeAdb(args);
        if (r.error || r.signal || r.status !== 0) throw fail('ADB_READ_FAILED');
        return r.stdout;
    };
    const gate = foreground => {
        const windows = read(['shell', 'dumpsys', 'window', 'displays']);
        const safety = parseSafety(windows, read(['shell', 'dumpsys', 'power']), read(['shell', 'dumpsys', 'window', 'policy']));
        if (!safety.awake || !safety.unlocked) throw fail('DEVICE_NOT_AWAKE_UNLOCKED');
        // Parse display 0 explicitly; an idle virtual display is not our input target.
        const block = windows.split(/(?=Display: mDisplayId=)/).find(s => /^Display: mDisplayId=0\b/.test(s));
        const focus = block?.split(/\r?\n/).filter(s => /mCurrentFocus=/.test(s)) || [];
        if (foreground && (focus.length !== 1 || !focus[0].includes(` u0 ${PKG}/`))) throw fail('WRONG_FOREGROUND');
    };
    const environment = () => {
        const pkg = read(['shell', 'dumpsys', 'package', PKG]);
        const apkPaths = read(['shell', 'pm', 'path', PKG]).trim().split(/\r?\n/).map(s => s.replace(/^package:/, ''));
        if (!apkPaths.length || apkPaths.some(p => !/^\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk$/.test(p))) throw fail('APK_PATH_INVALID');
        const apks = apkPaths.map(p => ({ path: p, sha256: read(['shell', 'sha256sum', p]).trim().split(/\s+/)[0] }));
        if (apks.some(p => !/^[0-9a-f]{64}$/.test(p.sha256))) throw fail('APK_HASH_INVALID');
        return { serial, model: read(['shell', 'getprop', 'ro.product.model']).trim(),
            android: read(['shell', 'getprop', 'ro.build.version.release']).trim(),
            romFingerprint: read(['shell', 'getprop', 'ro.build.fingerprint']).trim(), displayId: 0, package: PKG,
            versionName: /versionName=([^\s]+)/.exec(pkg)?.[1] || null,
            versionCode: /versionCode=(\d+)/.exec(pkg)?.[1] || null, apks, bookSourceDigest: null };
    };
    const reader = createSnapshotReader({ jar, executeAdb });
    const capture = () => {
        gate(true);
        const r = reader.execute(15000);
        if (r.error || r.signal || r.status !== 0) throw fail('INDEPENDENT_CAPTURE_FAILED');
        gate(true);
        return String(r.stdout);
    };
    let initialized = false, taskStarted = false, readerPrepared = false, protocol, taskResult, execution;
    let independent = { verdict: 'unknown', code: 'NOT_OBSERVED', matchingRows: 0, queryMatches: false, uiMatched: false };
    let code = null, cleanup = null, taskMs = null, resetMs = null, checkMs = null, frozenSource, frozenSettings, frozenEnvironment;
    const settingsPath = path.join(ROOT, 'AppData/settings.json');
    const started = Date.now();
    const service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
    try {
        frozenSettings = fs.readFileSync(settingsPath);
        const settings = JSON.parse(frozenSettings);
        if (settings.jevEnabled !== true) throw fail('JEV_DISABLED');
        const { GlobalJevService } = require('../modules/services/globalJevService');
        const jev = new GlobalJevService({ settingsManager: { readSettings: async () => settings }, logger: { log() {}, warn() {}, error() {} } });
        const config = await jev.getStatus(); // Local configuration only; no network request.
        if (!config.configured) throw fail('JEV_NOT_CONFIGURED');
        frozenSource = sourceIdentity(jar);
        frozenEnvironment = environment();
        gate(false);
        readerPrepared = true; reader.prepare();
        const resetAt = Date.now();
        read(['shell', 'am', 'force-stop', PKG]);
        read(['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']);
        await new Promise(resolve => setTimeout(resolve, 4000));
        resetMs = Date.now() - resetAt;
        const initial = capture(), initialNodes = parseTree(initial);
        const entry = initialNodes.filter(n => visible(n) && n.getAttribute('resource-id') === id('menu_search'));
        if (entry.length !== 1 || checkBook(initial).uiMatched) throw fail('START_STATE_UNPROVEN');
        const task = generic ? { serial, package: PKG, intent: 'ui_task', decision: 'jev', assistance: 'none',
            goal: '在阅读 App 搜索魔女之旅，找到作者为白石定规的那本。搜索结果中能看到同一条目的精确书名和作者即可完成，不需打开、下载或加入书架。',
            operations: ['Tap', 'Fill', 'Scroll', 'Back', 'ImeAction'], inputs: { query: QUERY },
            loading: { id: id('fb_stop') },
            completion: { all: [
                { type: 'text', text: { id: id('search_src_text'), inputRef: 'query' } },
                { type: 'row', id: id('recycler_view'), fields: [
                    { id: id('tv_name'), equals: QUERY, normalize: 'NFC_trim' },
                    { id: id('tv_author'), equals: AUTHOR, normalize: 'NFC_trim', stripPrefix: '作者：' }
                ] }
            ] },
            budget: { timeoutMs: 120000, maxActions: 3, maxObservations: 96, maxModelCalls: 8 } } : { serial, package: PKG, intent: 'search', decision: 'jev', assistance: 'none', inputs: { query: QUERY },
            completion: { type: 'visible', id: id('recycler_view'), item: id('tv_name'), minItems: 1, itemMatchesInput: true },
            budget: { timeoutMs: 120000, maxActions: 3, maxObservations: 96, maxModelCalls: 8 } };
        protocol = { schemaVersion, batchId: path.basename(output), stage: 'exploration', calibrated: false,
            taskId: 'legado-wandering-witch-author-001', clusterId: 'user-task-20261107-001', taskFamily: generic ? 'ui_task_search_workload' : 'search',
            source: 'user_requested_real_workload', inputSha256: digest(Buffer.from(QUERY)), expectedSha256: digest(Buffer.from(QUERY + '\n' + AUTHOR)),
            environment: frozenEnvironment, codeSha256: frozenSource, settingsSha256: digest(frozenSettings),
            nodeVersion: process.version, adbSha256: digest(fs.readFileSync(adb)), policy,
            requestPolicy: JEV_REQUEST_POLICY,
            contextPolicyVersion: MIRROR_CONTEXT_POLICY_VERSION,
            promptVersion: policy.version + '-source-bound', promptSha256: frozenSource[promptFile],
            model: { provider: config.provider, requestedAlias: config.model, expectedReturnedVersion: null },
            initial: { xmlSha256: digest(initial), uniqueEntry: true, reset: 'force-stop-launch-wait-4000ms', resetMs },
            task: { ...task, inputs: { query: { ref: 'user-request', sha256: digest(Buffer.from(QUERY)) } } },
            checker: { version: 'legado-title-author-v1', sha256: frozenSource['scripts/android-j02-search.cjs'], reads: 1, timeoutMs: 15000,
                sameDirectResultRow: true, taskReceiptTrusted: false },
            deadline: { taskMs: 120000, modelRequestMs: config.timeoutMs, modelRetries: 0, rounds: 8, loadingWindowMs: 5000,
                completionWindowMs: 5000, stabilityIntervalMs: 200, taskRetries: 0 },
            arms: [{ id: arm, planned: 1 }, { id: 'rules-current', planned: 1, notRunReason: 'EXPLORATION_CANDIDATE_ONLY' },
                { id: 'jev-original-search-v1', planned: 1, notRunReason: 'BASELINE_NOT_FROZEN' }],
            reports: ['protocol.json', 'events.jsonl', 'traces/', 'report.json'],
            admissionBlockers: ['EXPLORATION_ONLY', 'ONE_CORRELATED_CLUSTER', 'NO_INDEPENDENT_WRITE_AUDIT', 'BOOK_SOURCES_NOT_FROZEN',
                'RETURNED_MODEL_NOT_PINNED', 'NO_PAIRED_BASELINES', 'NO_INDEPENDENT_ACCEPTANCE_SET'] };
        write('protocol.json', protocol);
        for (const name of Object.keys(frozenSource)) {
            const source = name === 'snapshotJar' ? jar : path.join(ROOT, name);
            const destination = path.join(output, 'frozen-source', name === 'snapshotJar' ? 'independent-snapshot.jar' : name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        }
        if (JSON.stringify(sourceIdentity(jar)) !== JSON.stringify(frozenSource)) throw fail('SOURCE_CHANGED');
        const { createAndroidTaskExecutor } = require('../modules/services/androidTaskExecutor');
        const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
        initialized = true;
        await service.initialize({ config: { ADB_PATH: adb, DEVICE_SERIAL: serial, AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0 },
            services: { androidTaskExecutor: createAndroidTaskExecutor({ jev, traceStore: createTaskTraceStore({ directory: path.join(output, 'traces') }) }) },
            logger: { log() {}, warn() {}, error() {} } });
        gate(true);
        taskStarted = true;
        const taskAt = Date.now();
        const result = await service.processToolCall({ command: 'RunTask', task });
        taskMs = Date.now() - taskAt;
        taskResult = result.details?.task;
        execution = result.details?.execution;
        if (!taskResult) throw fail('TASK_RESULT_MISSING');
        emit({ phase: 'task', task: taskResult, execution });
        require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime').assertManagementIdle();
        await service.cleanup(); initialized = false;
        if (taskResult.receipts?.some(r => r.outcome === 'unknown') || /^(?:UI_SERVER_|DEVICE_|ADB_|STEP_)/.test(taskResult.code || '')) {
            code = 'TRANSPORT_UNPROVEN';
        } else {
            const checkAt = Date.now();
            independent = checkBook(capture());
            checkMs = Date.now() - checkAt;
            emit({ phase: 'independent', ...independent });
        }
    } catch (error) { code = safeCode(error); emit({ phase: 'error', code, taskStarted }); }
    finally {
        if (initialized) { try { await service.cleanup(); } catch (error) { code ||= safeCode(error); } }
        if (readerPrepared) { try { cleanup = reader.cleanup(); } catch (error) { cleanup = { removed: false, code: safeCode(error) }; } }
        AdbClient.prototype.runText = originalRead;
    }
    const invalidations = [];
    if (frozenSource && JSON.stringify(sourceIdentity(jar)) !== JSON.stringify(frozenSource)) invalidations.push('SOURCE_CHANGED');
    if (frozenSettings && digest(fs.readFileSync(settingsPath)) !== digest(frozenSettings)) invalidations.push('SETTINGS_CHANGED');
    if (frozenEnvironment) { try { if (JSON.stringify(environment()) !== JSON.stringify(frozenEnvironment)) invalidations.push('ENVIRONMENT_CHANGED'); }
        catch { invalidations.push('ENVIRONMENT_RECHECK_FAILED'); } }
    const tracePath = taskResult && path.join(output, 'traces', taskResult.taskId + '.jsonl');
    const events = tracePath && fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const models = events.filter(e => e.type === 'model').map(e => e.modelEvidence);
    const modelVersions = [...new Set(models.map(m => m?.returnedModel).filter(Boolean))];
    if (modelVersions.length > 1) invalidations.push('RETURNED_MODEL_CHANGED');
    const receipts = taskResult?.receipts || [];
    const success = taskResult?.status === 'completed' && execution?.outcome === 'verified'
        && independent.verdict === 'pass' && !receipts.some(r => r.outcome === 'unknown');
    const outcome = !taskStarted ? 'not_run' : independent.verdict === 'unknown' || receipts.some(r => r.outcome === 'unknown') ? 'unknown'
        : success ? 'success' : /ABORT|CANCEL/.test(taskResult?.code || '') ? 'cancelled'
            : /ESCALATION/.test(taskResult?.code || '') ? 'escalated' : /UNCERTAIN|UNSAFE|POLICY|TARGET|PREEXIST/.test(taskResult?.code || '') ? 'refused' : 'failed';
    const eligible = events.some(e => e.type === 'recovery');
    const escalation = generic ? taskResult?.code === 'TASK_ESCALATION_REQUIRED' : events.some(e => e.type === 'escalation' && e.escalation?.disposition === 'assistance_required');
    const falseCompletion = taskResult?.status === 'completed' && independent.verdict !== 'unknown' ? generic ? independent.verdict !== 'pass' : !independent.uiMatched : null;
    const risk = (numerator, denominator, unassessable) => ({ numerator, denominator, unassessable, confidenceUpper: null, admitted: false });
    const counts = taskResult?.counts || {};
    const actual = { arm: arm, taskId: protocol?.taskId || 'legado-wandering-witch-author-001', clusterId: 'user-task-20261107-001',
        outcome, code: code || taskResult?.code || null, started: taskStarted, independent,
        path: eligible && escalation ? 'recovery_and_escalation' : eligible ? 'recovery' : escalation ? 'escalation' : 'normal',
        recoveryEligible: eligible, recoveryAttempted: eligible, escalationRequested: escalation,
        jevCalls: taskStarted ? counts.modelCalls ?? null : 0, mainAgentCalls: taskStarted ? counts.mainModelCalls ?? null : 0,
        mainModelRequests: taskStarted && !taskResult ? null : counts.mainModelRequests ?? 0, humanHandoffs: counts.humanHandoffs ?? 0,
        timings: { taskMs, resetMs, independentCheckMs: checkMs, endToEndMs: Date.now() - started }, models };
    const notRun = (arm, reason) => ({ arm, taskId: actual.taskId, clusterId: actual.clusterId, outcome: 'not_run', code: reason });
    const report = { schemaVersion, batchId: path.basename(output), stage: 'exploration', calibrated: false,
        protocolSha256: protocol ? digest(fs.readFileSync(path.join(output, 'protocol.json'))) : null,
        status: invalidations.length ? 'invalidated' : protocol ? 'completed' : 'blocked', invalidations,
        promotion: 'not_evaluated', trials: [actual, notRun('rules-current', 'EXPLORATION_CANDIDATE_ONLY'), notRun('jev-original-search-v1', 'BASELINE_NOT_FROZEN')],
        denominators: { planned: 3, started: Number(taskStarted), notRun: 3 - Number(taskStarted), independentClusters: 1, acceptanceSamples: 0 },
        risks: { misdispatch: risk(null, 0, Number(taskStarted)), falseCompletion: risk(falseCompletion === null ? null : Number(falseCompletion),
            Number(falseCompletion !== null), Number(taskResult?.status === 'completed' && falseCompletion === null)), duplicateWrite: risk(null, 0, Number(taskStarted)) },
        models: { requestedAlias: protocol?.model.requestedAlias || null, observedReturnedVersions: modelVersions, expectedReturnedVersion: null,
            usageKnownCalls: models.filter(m => m?.usage && Object.values(m.usage).every(v => v !== null)).length, usageTotalCalls: models.length },
        coverage: { ordinarySearch: taskStarted, neutralCandidateDiscrimination: 'not_established', loading: generic && events.some(e => e.type === 'wait') ? 'observed' : 'not_exercised',
            recovery: eligible ? 'observed' : 'not_exercised', mainAgent: 'not_exercised', handoff: 'not_exercised', independentWriteAudit: false }, cleanup };
    if (!validate(report)) { write('invalid-report.json', report); throw fail('REPORT_SCHEMA_INVALID'); }
    write('report.json', report);
    console.log(JSON.stringify({ output, status: report.status, outcome, code: actual.code, jevCalls: actual.jevCalls,
        returnedModels: modelVersions, independent, calibrated: false, cleanup }));
    return report;
}

if (require.main === module) main().then(report => { process.exitCode = report.status === 'completed' && report.trials[0].outcome === 'success' ? 0 : 1; })
    .catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
module.exports = { main, checkBook, parseTree, sourceIdentity, reportValidator };
