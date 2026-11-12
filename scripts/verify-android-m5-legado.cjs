'use strict';

// Fixed real-App experiment. Query values and raw screens stay in memory.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { DOMParser } = require('@xmldom/xmldom');
const legacy = require('./verify-android-m15.cjs');
const { checkTrace } = require('./verify-android-m5.cjs');
const PKG = 'io.legado.app.release';
const id = name => `${PKG}:id/${name}`;
const fail = code => Object.assign(new Error(code), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const INDEPENDENT_POLICY = Object.freeze({ maxAttempts: 2, timeoutMs: 30000, requestTimeoutMs: 20000, pauseMs: 200 });
const SNAPSHOT_POLICY = Object.freeze({ maxAttempts: 1, timeoutMs: 30000, requestTimeoutMs: 15000, pauseMs: 0 });

function parseArgs(argv) {
    const options = { runs: 1, adb: 'D:/AI/tools/platform-tools/adb.exe' };
    const seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i];
        if (!['--serial', '--query', '--runs', '--adb', '--output', '--snapshot-jar'].includes(name) || seen.has(name)) throw fail('INVALID_OPTION');
        seen.add(name);
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw fail('MISSING_OPTION_VALUE');
        options[name.slice(2)] = name === '--runs' ? Number(value) : value;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.serial || '') || !options.query?.trim()
        || options.query.length > 2000 || !options.output || !Number.isSafeInteger(options.runs)
        || options.runs < 1 || options.runs > 20) throw fail('INVALID_OPTIONS');
    return options;
}

function taskOf(serial, query) {
    return { serial, package: PKG, intent: 'search', inputs: { query }, decision: 'rules',
        targets: { entry: id('menu_search'), field: id('search_src_text'), submit: id('search_go_btn') },
        // Legado keeps ll_input_help in its accessibility tree even after results appear.
        completion: { type: 'visible', id: id('recycler_view'), item: id('tv_name'), minItems: 1, itemMatchesInput: true },
        budget: { timeoutMs: 120000, maxActions: 3, maxObservations: 64, maxModelCalls: 0 } };
}

// Independent Android CLI XML, parsed with DOM rather than the plugin's graph/role parser.
function independentEvidence(text, query) {
    const invalid = stage => { throw Object.assign(fail('INDEPENDENT_XML_INVALID'), { stage }); };
    const start = text.indexOf('<?xml'), end = text.lastIndexOf('</hierarchy>');
    if (start < 0 || end < start) invalid('envelope');
    const doc = new DOMParser({ errorHandler: { warning() {}, error() { invalid('parse'); },
        fatalError() { invalid('parse'); } } }).parseFromString(text.slice(start, end + 12), 'text/xml');
    const all = Array.from(doc.getElementsByTagName('node'));
    if (doc.documentElement?.tagName !== 'hierarchy' || !all.length) invalid('root');
    const bounds = node => /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.getAttribute('bounds') || '')?.slice(1).map(Number);
    const screen = bounds(all[0]);
    if (!screen) invalid('bounds');
    const visible = node => {
        const b = bounds(node);
        return b && node.getAttribute('visible-to-user') !== 'false' && b[2] > b[0] && b[3] > b[1]
            && b[2] > screen[0] && b[3] > screen[1] && b[0] < screen[2] && b[1] < screen[3];
    };
    const containers = all.filter(node => node.getAttribute('resource-id') === id('recycler_view') && visible(node));
    const items = containers.length === 1 ? Array.from(containers[0].getElementsByTagName('node'))
        .filter(node => node.getAttribute('resource-id') === id('tv_name') && visible(node) && node.getAttribute('password') !== 'true') : [];
    const matchingItems = items.filter(node => node.getAttribute('text').includes(query)).length;
    const queryFieldMatches = all.some(node => node.getAttribute('resource-id') === id('search_src_text')
        && node.getAttribute('password') !== 'true' && node.getAttribute('text') === query && visible(node));
    return { containers: containers.length, visibleItems: items.length, matchingItems, queryFieldMatches,
        matched: containers.length === 1 && matchingItems > 0 && queryFieldMatches };
}

// Never persist stdout/stderr, parser messages, queries or free-form process errors.
function diagnoseIndependent(result, query, elapsedMs) {
    const stdout = String(result.stdout || ''), stderr = String(result.stderr || '');
    const messages = stdout + '\n' + stderr;
    const diagnostics = { exitCode: Number.isInteger(result.status) ? result.status : null,
        signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(result.signal) ? result.signal : result.signal ? 'OTHER' : null,
        processError: ['ETIMEDOUT', 'ENOBUFS', 'ENOENT'].includes(result.error?.code) ? result.error.code : result.error ? 'OTHER' : null,
        elapsedMs, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
        declaration: stdout.includes('<?xml'), hierarchyOpen: stdout.includes('<hierarchy'), hierarchyClose: stdout.includes('</hierarchy>'),
        idleTimeout: /could not get idle state/i.test(messages),
        automationBusy: /UiAutomation.*already|already.*UiAutomation|UiAutomation not connected/i.test(messages),
        permissionDenied: /permission denied|SecurityException/i.test(messages),
        deviceOffline: /device offline|device.*not found|no devices|unauthorized/i.test(messages),
        ...(messages.includes('VCP_SNAPSHOT_') ? { snapshotStage: /VCP_SNAPSHOT_(CONNECT|ROOT|TREE|DISCONNECT)_FAILED/.exec(messages)?.[1] || null,
            treeRetries: (messages.match(/^VCP_SNAPSHOT_TREE_RETRY\r?$/gm) || []).length,
            snapshotDetail: /VCP_SNAPSHOT_DETAIL (TREE_CHANGED|TREE_LIMIT)/.exec(messages)?.[1] || null } : {}), stage: 'process' };
    const failure = error => ({ matched: false, error, diagnostics });
    if (result.error || result.status !== 0) return failure(result.error?.code === 'ETIMEDOUT' ? 'INDEPENDENT_ADB_TIMEOUT' : 'INDEPENDENT_ADB_FAILED');
    try {
        const evidence = independentEvidence(stdout, query);
        diagnostics.stage = 'complete';
        return { ...evidence, diagnostics };
    } catch (error) {
        diagnostics.stage = ['envelope', 'parse', 'root', 'bounds'].includes(error.stage) ? error.stage : 'parse';
        const reason = diagnostics.idleTimeout ? 'IDLE_TIMEOUT' : diagnostics.automationBusy ? 'AUTOMATION_BUSY'
            : diagnostics.permissionDenied ? 'PERMISSION_DENIED' : !stdout.trim() ? 'EMPTY_OUTPUT'
                : diagnostics.hierarchyOpen && !diagnostics.hierarchyClose ? 'XML_TRUNCATED'
                    : diagnostics.stage === 'envelope' ? 'XML_ENVELOPE' : `XML_${diagnostics.stage.toUpperCase()}`;
        return failure(`INDEPENDENT_${reason}`);
    }
}

async function readIndependent({ execute, query, gate, now = Date.now, wait = pause, policy = INDEPENDENT_POLICY }) {
    const deadline = now() + policy.timeoutMs;
    const attempts = [];
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        gate();
        const remaining = deadline - now();
        if (remaining <= 0) return { matched: false, error: 'INDEPENDENT_DEADLINE', attempts };
        const at = now();
        const process = execute(Math.min(policy.requestTimeoutMs, remaining));
        const evidence = diagnoseIndependent(process, query, now() - at);
        attempts.push({ attempt, ...evidence });
        gate();
        if (now() >= deadline) return { matched: false, error: 'INDEPENDENT_DEADLINE', attempts };
        // A successful CLI exit with no XML and the explicit idle error is a drained
        // read. Retry only that read, never a task, input, malformed XML or unknown process.
        const drainedIdle = evidence.error === 'INDEPENDENT_IDLE_TIMEOUT'
            && evidence.diagnostics.exitCode === 0 && !evidence.diagnostics.processError
            && !evidence.diagnostics.signal && !evidence.diagnostics.hierarchyOpen;
        if (!drainedIdle || attempt === policy.maxAttempts) return { ...evidence, attempts };
        const left = deadline - now();
        if (left <= policy.pauseMs) return { ...evidence, attempts };
        await wait(policy.pauseMs);
    }
}

function identity(snapshotJar) {
    const files = ['modules/services/androidTaskExecutor.js', 'modules/services/androidTaskTrace.js', 'modules/services/androidSearchLoop.js',
        'scripts/verify-android-m5-legado.cjs',
        ...(snapshotJar ? ['scripts/android-independent-snapshot/reader.cjs',
            'scripts/android-independent-snapshot/src/com/vcpchat/validation/Snapshot.java',
            'scripts/android-independent-snapshot/build.cjs', path.resolve(snapshotJar)] : []),
        'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js',
        ...fs.readdirSync(path.join(__dirname, '../VCPDistributedServer/Plugin/AndroidController/lib'))
            .filter(name => name.endsWith('.js')).map(name => `VCPDistributedServer/Plugin/AndroidController/lib/${name}`)];
    return Object.fromEntries(files.sort().map(file => [file,
        createHash('sha256').update(fs.readFileSync(path.isAbsolute(file) ? file : path.join(__dirname, '..', file))).digest('hex')]));
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const output = path.resolve(options.output);
    fs.mkdirSync(output, { recursive: false }); // New run directory; never overwrite prior evidence.
    const emit = row => { fs.appendFileSync(path.join(output, 'results.jsonl'), `${JSON.stringify(row)}\n`); console.log(JSON.stringify(row)); };
    const source = identity(options['snapshot-jar']);
    const executeAdb = (args, device = true, timeout = 20000) => cp.spawnSync(options.adb, [...(device ? ['-s', options.serial] : []), ...args],
            { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const snapshotReader = options['snapshot-jar'] ? require('./android-independent-snapshot/reader.cjs')
        .createSnapshotReader({ jar: options['snapshot-jar'], executeAdb }) : null;
    const policy = snapshotReader ? SNAPSHOT_POLICY : INDEPENDENT_POLICY;
    fs.writeFileSync(path.join(output, 'protocol.json'), JSON.stringify({ version: snapshotReader ? 5 : 3, total: options.runs,
        serial: options.serial, package: PKG, decision: 'rules', completion: taskOf('', '').completion,
        querySource: 'operator_supplied_existing_search_history', caseRetry: false,
        independent: { command: snapshotReader ? 'shell app_process one-shot Snapshot' : 'exec-out uiautomator dump /dev/tty', ...policy,
            retryOnly: snapshotReader ? 'never' : 'exited-zero-explicit-idle-error-without-XML',
            ...(snapshotReader ? { reader: snapshotReader.identity, globalIdle: false, independentSource: 'Android-accessibility',
                treePolicy: { maxAttempts: 3, timeoutMs: 3000, pauseMs: 100, retryOnly: 'TREE_CHANGED', discardPartialXml: true } } : {}),
            diagnostics: 'bounded-metadata-v1' },
        stopOnTransportUnknown: true, productionSha256: source }, null, 2));
    const read = (args, device = true) => {
        const r = executeAdb(args, device);
        if (r.error || r.status !== 0) throw fail('ADB_FAILED');
        return r.stdout;
    };
    const gate = foreground => {
        const windows = read(['shell', 'dumpsys', 'window', 'displays']);
        const safe = legacy.parseSafety(windows, read(['shell', 'dumpsys', 'power']), read(['shell', 'dumpsys', 'window', 'policy']));
        if (!safe.awake || !safe.unlocked) throw fail('DEVICE_NOT_AWAKE_UNLOCKED');
        const focused = windows.split(/\r?\n/).filter(line => /mCurrentFocus=/.test(line));
        if (foreground && (!focused.length || focused.some(line => !line.includes(` u0 ${PKG}/`)))) throw fail('WRONG_FOREGROUND');
    };
    const service = require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService');
    const runtime = require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime');
    const { createAndroidTaskExecutor } = require('../modules/services/androidTaskExecutor');
    const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
    const traces = path.join(output, 'traces');
    let passed = 0, executed = 0;
    const stopCodes = {};
    let cleanup = null;
    try {
    if (snapshotReader) { gate(false); snapshotReader.prepare(); }
    for (let trial = 1; trial <= options.runs; trial++) {
        const started = Date.now();
        let initialized = false;
        let taskStarted = false;
        try {
            if (JSON.stringify(identity(options['snapshot-jar'])) !== JSON.stringify(source)) throw fail('PRODUCTION_CHANGED');
            if (!legacy.parseDevices(read(['devices', '-l'], false)).some(d => d.serial === options.serial && d.state === 'device')) throw fail('DEVICE_OFFLINE');
            gate(false);
            emit({ phase: 'start', trial });
            read(['shell', 'am', 'force-stop', PKG]);
            read(['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']);
            await pause(4000);
            gate(true);
            initialized = true;
            await service.initialize({ config: { ADB_PATH: options.adb, DEVICE_SERIAL: options.serial,
                AUTO_WAKE: 'false', UI_SERVER: 'true', DISPLAY_PORT: 0 },
            services: { androidTaskExecutor: createAndroidTaskExecutor({ traceStore: createTaskTraceStore({ directory: traces }) }) },
            logger: { log() {}, warn() {}, error() {} } });
            executed++; taskStarted = true;
            const result = await service.processToolCall({ command: 'RunTask', task: taskOf(options.serial, options.query) });
            const task = result.details.task;
            const traceText = fs.readFileSync(path.join(traces, `${task.taskId}.jsonl`), 'utf8');
            checkTrace(traceText.trim().split('\n').map(JSON.parse), task, options.query);
            emit({ phase: 'task-result', trial, taskId: task.taskId, status: task.status, code: task.code,
                ...(task.contextDiff ? { contextDiff: task.contextDiff } : {}), outcome: result.details.execution.outcome, counts: task.counts });
            runtime.assertManagementIdle();
            const transportUnknown = /^(?:UI_SERVER_|DEVICE_|ADB_|STEP_)/.test(task.code || '')
                || task.receipts.some(r => r.outcome === 'unknown');
            await service.cleanup(); initialized = false;
            gate(true);
            let independent = null;
            if (!transportUnknown) {
                independent = await readIndependent({ query: options.query, gate: () => gate(true),
                    policy, execute: snapshotReader ? timeout => snapshotReader.execute(timeout)
                        : timeout => executeAdb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], true, timeout) });
            }
            const success = task.status === 'completed' && result.details.execution.outcome === 'verified' && independent?.matched === true;
            if (success) passed++;
            else { const code = task.code || independent?.error || 'INDEPENDENT_RESULT_UNPROVEN'; stopCodes[code] = (stopCodes[code] || 0) + 1; }
            emit({ phase: 'result', trial, success, taskId: task.taskId, status: task.status, code: task.code,
                ...(task.contextDiff ? { contextDiff: task.contextDiff } : {}),
                outcome: result.details.execution.outcome, counts: task.counts, receipts: task.receipts,
                independent, traceContainsInput: false, elapsedMs: Date.now() - started, caseRetried: false });
            const diagnostics = independent?.attempts.at(-1)?.diagnostics;
            if (transportUnknown || diagnostics?.processError || diagnostics?.exitCode !== 0) break;
        } catch (error) {
            const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'EXPERIMENT_FAILED';
            if (taskStarted) stopCodes[code] = (stopCodes[code] || 0) + 1;
            emit({ phase: 'stop', trial, code, taskStarted });
            break;
        } finally { if (initialized) await service.cleanup(); }
    }
    } finally {
        if (snapshotReader) {
            try { cleanup = snapshotReader.cleanup(); }
            catch (error) { cleanup = { removed: false, code: error.code || 'INDEPENDENT_CLEANUP_FAILED' }; }
            emit({ phase: 'independent-cleanup', ...cleanup });
        }
    }
    const unchanged = JSON.stringify(identity(options['snapshot-jar'])) === JSON.stringify(source);
    const summary = { phase: 'summary', total: options.runs, executed, passed, failed: executed - passed,
        notExecuted: options.runs - executed, stopCodes, productionUnchanged: unchanged };
    emit(summary);
    return { exitCode: unchanged && passed === options.runs && (!snapshotReader || cleanup?.removed) ? 0 : 1, summary };
}

if (require.main === module) main().then(result => { process.exitCode = result.exitCode; }).catch(error => {
    console.log(JSON.stringify({ code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'EXPERIMENT_FAILED' }));
    process.exitCode = 1;
});
module.exports = { parseArgs, taskOf, independentEvidence, diagnoseIndependent, readIndependent, INDEPENDENT_POLICY, SNAPSHOT_POLICY };
