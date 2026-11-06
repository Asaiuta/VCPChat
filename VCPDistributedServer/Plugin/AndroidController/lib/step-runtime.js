'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const actionHistory = require('./action-history');

const context = new AsyncLocalStorage();
const leases = new Set();
const managementContext = new AsyncLocalStorage();
let managementActive = false;
let managementDrain = null;
const activeRuns = new Set();
const takeoverHandles = new WeakMap();
let takeover = null;

function failure(code, message) {
    return Object.assign(new Error(`[AndroidController] ${message}`), { code });
}

function check() {
    const state = context.getStore();
    if (state?.signal?.aborted) throw failure('STEP_ABORTED', '单步执行已取消。');
    if (state && Date.now() >= state.deadlineMs) throw failure('STEP_DEADLINE', '单步执行截止时间已到。');
}

async function stage(name, task) {
    check();
    const state = context.getStore();
    const started = performance.now();
    try { return await task(); }
    finally {
        if (state) state.timings[name] = (state.timings[name] || 0) + performance.now() - started;
    }
}

async function pause(ms) {
    check();
    const state = context.getStore();
    const signal = state?.signal;
    const duration = Math.max(0, Math.min(ms, state ? state.deadlineMs - Date.now() : ms));
    await new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', aborted);
        const timer = setTimeout(() => { cleanup(); resolve(); }, duration);
        function aborted() { clearTimeout(timer); cleanup(); reject(failure('STEP_ABORTED', '单步执行已取消。')); }
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
    });
    check();
}

function receiptState({ serial, actionCommand, outcome = 'dispatched' }) {
    return {
        requestId: randomUUID(),
        timings: { prepareMs: 0, actionMs: 0, verificationMs: 0, totalMs: 0 },
        outcome, dispatched: false, verification: null,
        historySerial: serial, actionCommand: actionHistory.normalizeCommand(actionCommand), historyClosed: false,
    };
}

function uncertain(state) {
    return state.dispatched || state.childDispatched || state.childUnknown || state.outcome === 'unknown'
        || (state.ownedScope && uncertain(state.ownedScope));
}

function completeResult(state, result, started) {
    state.timings.totalMs = performance.now() - started;
    const outcome = state.childUnknown ? 'unknown' : state.verification ? state.outcome
        : result.details?.system?.outcome || (state.dispatched || state.childDispatched ? 'dispatched' : state.outcome);
    state.finalOutcome = outcome;
    const execution = {
        requestId: state.requestId, serial: state.activeSerial || state.historySerial, outcome,
        verification: state.verification, timings: { ...state.timings }, retryable: false,
        ...(state.sequence ? { sequence: sequenceReceipt(state) } : {}),
    };
    result.details = { ...result.details, execution };
    result.content = [...(result.content || []), { type: 'text', text: JSON.stringify({ execution }) }];
    return result;
}

function completeHistory(state, outcome, started, code) {
    if (state.historyClosed) return;
    state.historyClosed = true;
    state.timings.totalMs = performance.now() - started;
    finishHistory(state, outcome, state.timings.totalMs, code);
}

function completeError(state, error, started) {
    const reason = state.signal.reason;
    // A child receipt and the shared abort reason must not be mutated by its parent.
    if (error.execution || error === reason) error = Object.assign(new Error(error.message), error);
    if (state.inputReceipt) error.details = { ...error.details, ...state.inputReceipt };
    if (reason?.code === 'STEP_DEADLINE') error = Object.assign(failure(reason.code, '单步执行截止时间已到。'), { details: error.details });
    const outcome = uncertain(state) ? 'unknown' : 'failed';
    state.finalOutcome = outcome;
    completeHistory(state, outcome, started, reason?.code || error.code);
    error.execution = {
        requestId: state.requestId, serial: state.activeSerial || state.historySerial, outcome, retryable: false,
        verification: state.verification, timings: { ...state.timings },
        ...(state.sequence ? { sequence: sequenceReceipt(state, true) } : {}),
    };
    error.message += `\n${JSON.stringify({ ...(state.inputReceipt ? { details: state.inputReceipt } : {}), code: error.code || 'STEP_FAILED', execution: { requestId: state.requestId, serial: error.execution.serial, outcome, retryable: false, ...(error.execution.sequence ? { sequence: error.execution.sequence } : {}) } })}`;
    return error;
}

function assertTakeoverIdle() {
    if (takeover) throw failure('DEVICE_BUSY', '人工接管正在申请、执行或排干。');
}

function takeoverStatus() {
    return Object.freeze({ active: Boolean(takeover), phase: takeover?.phase || 'idle',
        serial: takeover?.serial || null, inFlight: activeRuns.size });
}

function uncertainBindings(states) {
    return Object.freeze([...new Set(states.filter(state => state.finalOutcome === 'unknown' || uncertain(state))
        .flatMap(state => [state.activeSerial || state.historySerial, ...state.leaseKeys])
        .filter(key => typeof key === 'string' && key && key !== '__auto__'))]);
}

function closeTakeover(lease) {
    if (lease.closePromise) return lease.closePromise;
    lease.phase = lease.phase === 'active' ? 'releasing' : 'draining';
    const humanRuns = [...activeRuns].filter(state => state.takeoverLease === lease);
    const drains = humanRuns.map(state => state.drain);
    // Neither cancellation receipts nor a timeout prove that dependencies have stopped.
    lease.closePromise = Promise.all([lease.drain, ...drains]).then(() => {
        const serials = uncertainBindings([...lease.targets, ...humanRuns]);
        // Persist device isolation before opening the global gate. Acquisition may
        // have already returned a timeout/abort receipt before these tasks drained.
        if (serials.length && lease.onUncertain) lease.onUncertain(serials);
        lease.signal?.removeEventListener('abort', lease.onAbort);
        lease.phase = 'released';
        if (takeover === lease) takeover = null;
    });
    // Keep fail-closed callback failures observable to awaited cleanup, but never
    // emit an unhandled rejection from an AbortSignal/timer callback.
    lease.closePromise.catch(() => {});
    lease.controller.abort(failure('STEP_ABORTED', '人工接管会话已结束。'));
    return lease.closePromise;
}

async function acquireTakeover({ serial, signal, timeoutMs = 15000, onUncertain }) {
    if (typeof serial !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,159}$/.test(serial)
        || !Number.isFinite(timeoutMs) || timeoutMs <= 0
        || (onUncertain !== undefined && typeof onUncertain !== 'function')) throw failure('INVALID_ARGUMENT', '人工接管需要明确安全的 serial 和正数 timeoutMs。');
    assertTakeoverIdle();
    if (managementActive) throw failure('DEVICE_BUSY', '设备管理期间不能申请人工接管。');
    const targets = [...activeRuns];
    const lease = { serial, signal, targets, onUncertain, controller: new AbortController(), phase: 'acquiring',
        drain: Promise.all(targets.map(state => state.drain)) };
    // First version deliberately uses ONE global write gate, including other serials and
    // management: USB/Wi-Fi aliases must not bypass ownership without physical identity.
    // Reserve synchronously before firing any cancellation callback or awaiting anything.
    takeover = lease;
    let timer;
    try {
        const boundary = new Promise((_, reject) => {
            lease.onAbort = () => {
                closeTakeover(lease);
                reject(failure('TAKEOVER_ABORTED', '人工接管申请或会话已取消。'));
            };
            signal?.addEventListener('abort', lease.onAbort, { once: true });
            if (signal?.aborted) lease.onAbort();
            timer = setTimeout(() => {
                closeTakeover(lease);
                reject(failure('TAKEOVER_TIMEOUT', '人工接管等待排干超时。'));
            }, timeoutMs);
        });
        for (const state of targets) state.cancel();
        await Promise.race([lease.drain, boundary]);
        if (lease.phase !== 'acquiring') throw failure('TAKEOVER_ABORTED', '人工接管申请已失效。');
        const uncertainSerials = uncertainBindings(targets);
        if (targets.some(state => state.finalOutcome === 'unknown' || uncertain(state))) {
            // A global takeover can cancel unknown work on more than the requested device.
            // Internal error metadata lets the caller quarantine every actual binding.
            throw Object.assign(failure('DEVICE_STATE_UNCERTAIN', '被取消任务的设备结局未证明；不能授予人工接管。'),
                { uncertainSerials: Object.freeze(uncertainSerials) });
        }
        lease.phase = 'active';
        const handle = Object.freeze(Object.create(null));
        takeoverHandles.set(handle, lease);
        return handle;
    } catch (error) {
        // Keep session cleanup ordered after real drain without serializing this internal fence.
        Object.defineProperty(error, 'takeoverDrain', { value: closeTakeover(lease) });
        throw error;
    } finally { clearTimeout(timer); }
}

function releaseTakeover(handle) {
    const lease = takeoverHandles.get(handle);
    if (!lease) return Promise.reject(failure('INVALID_TAKEOVER_HANDLE', '无效的人工接管句柄。'));
    return closeTakeover(lease);
}

async function runTakeover(handle, options, task) {
    const lease = takeoverHandles.get(handle);
    if (!lease || takeover !== lease || lease.phase !== 'active') throw failure('INVALID_TAKEOVER_HANDLE', '人工接管句柄无效或已释放。');
    const settings = { ...options };
    if (settings.serial !== undefined && settings.serial !== lease.serial) throw failure('INVALID_ARGUMENT', '人工接管不能覆盖绑定设备。');
    const signal = settings.signal ? AbortSignal.any([lease.controller.signal, settings.signal]) : lease.controller.signal;
    return runInternal({ ...settings, serial: lease.serial, signal }, task, lease);
}

async function run(options, task) { return runInternal(options, task); }

async function runInternal({ serial, timeoutMs = 60000, signal, client, outcome = 'dispatched', actionCommand }, task, takeoverLease) {
    if (takeover && (takeover !== takeoverLease || takeover.phase !== 'active')) throw failure('DEVICE_BUSY', '人工接管闸门已关闭其他操作。');
    if (takeoverLease && (takeover !== takeoverLease || takeoverLease.phase !== 'active' || serial !== takeoverLease.serial)) throw failure('INVALID_TAKEOVER_HANDLE', '人工接管会话已失效。');
    if (managementActive || leases.has(serial)) throw failure('DEVICE_BUSY', '设备已有操作或连接管理，请等待当前操作结束。');
    const controller = new AbortController();
    const state = {
        ...receiptState({ serial, actionCommand, outcome }),
        deadlineMs: Date.now() + timeoutMs, signal: controller.signal, externalSignal: signal,
        leaseKeys: new Set([serial]), activeSerial: null, acceptingOwned: true, takeoverLease,
        cancel: () => controller.abort(failure('STEP_ABORTED', '单步执行已取消。')),
    };
    leases.add(serial);
    let drained;
    state.drain = new Promise(resolve => { drained = resolve; });
    activeRuns.add(state);
    const started = performance.now();
    let timer;
    let operation;
    let abortHandler;
    let boundaryAbort;
    const release = () => {
        state.acceptingOwned = false;
        for (const key of state.leaseKeys) leases.delete(key);
        activeRuns.delete(state);
        drained();
    };
    try {
        const boundary = new Promise((_, reject) => {
            boundaryAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', boundaryAbort, { once: true });
            abortHandler = state.cancel;
            signal?.addEventListener('abort', abortHandler, { once: true });
            if (signal?.aborted) abortHandler();
            timer = setTimeout(() => {
                const error = failure('STEP_DEADLINE', '单步执行截止时间已到。');
                controller.abort(error);
                reject(error);
            }, timeoutMs);
        });
        operation = context.run(state, async () => {
            check();
            const execute = async () => {
                let result;
                try { result = await task(); }
                finally {
                    state.acceptingOwned = false;
                    // Cancellation may settle the child receipt before its dependency drains.
                    await state.ownedDrain;
                }
                check();
                return completeResult(state, result, started);
            };
            return typeof client?.withContext === 'function'
                ? client.withContext({ deadlineMs: state.deadlineMs, signal: state.signal }, execute) : execute();
        });
        operation.then(release, release);
        const result = await Promise.race([boundary, operation]);
        completeHistory(state, result.details.execution.outcome, started);
        return result;
    } catch (error) {
        throw completeError(state, error, started);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        controller.signal.removeEventListener('abort', boundaryAbort);
        if (!operation) release();
    }
}

async function runOwned({ serial, actionCommand, outcome = 'dispatched' }, task) {
    const parent = context.getStore();
    const owner = parent?.owner || parent;
    if (!owner || !owner.acceptingOwned || parent.historyClosed || !serial || !owner.leaseKeys.has(serial)
        || !leases.has(serial) || (owner.activeSerial && owner.activeSerial !== serial)) {
        throw failure('INVALID_ARGUMENT', '子动作需要有效任务上下文及其已持有的设备。');
    }
    check();
    if (owner.ownedScope) throw failure('DEVICE_BUSY', '当前任务已有子动作正在执行。');
    const state = {
        ...receiptState({ serial, actionCommand, outcome }), owner,
        deadlineMs: owner.deadlineMs, signal: owner.signal, leaseKeys: owner.leaseKeys, activeSerial: serial,
    };
    owner.ownedScope = state;
    const started = performance.now();
    let abortHandler;
    try {
        const boundary = new Promise((_, reject) => {
            abortHandler = () => reject(failure('STEP_ABORTED', '单步执行已取消。'));
            state.signal.addEventListener('abort', abortHandler, { once: true });
            if (state.signal.aborted) abortHandler();
        });
        const operation = context.run(state, async () => {
            check();
            const result = await task();
            check();
            return completeResult(state, result, started);
        });
        const release = (error) => {
            owner.childDispatched ||= state.dispatched;
            owner.childUnknown ||= state.finalOutcome === 'unknown' || state.outcome === 'unknown' || Boolean(error && uncertain(state));
            owner.ownedScope = null;
        };
        owner.ownedDrain = operation.then(() => release(), release);
        const result = await Promise.race([boundary, operation]);
        completeHistory(state, result.details.execution.outcome, started);
        return result;
    } catch (error) {
        const completed = completeError(state, error, started);
        owner.childDispatched ||= state.dispatched;
        owner.childUnknown ||= completed.execution.outcome === 'unknown';
        throw completed;
    } finally {
        state.signal.removeEventListener('abort', abortHandler);
    }
}

function bindDevice(serial) {
    check();
    const state = context.getStore();
    const owner = state?.owner || state;
    if (takeover && (owner?.takeoverLease !== takeover || takeover.phase !== 'active')) throw failure('DEVICE_BUSY', '人工接管期间不能绑定设备。');
    if (owner?.takeoverLease && serial !== owner.takeoverLease.serial) throw failure('INVALID_ARGUMENT', '人工接管不能切换绑定设备。');
    if (!state) return;
    if (state.owner && serial !== state.activeSerial) throw failure('INVALID_ARGUMENT', '子动作不能切换任务绑定设备。');
    if (!state.leaseKeys.has(serial)) {
        if (leases.has(serial)) throw failure('DEVICE_BUSY', '设备已有单步操作。');
        leases.add(serial);
        state.leaseKeys.add(serial);
    }
    state.activeSerial = serial;
}

function activeDevice() { return context.getStore()?.activeSerial || null; }
function executionSignal() { return context.getStore()?.signal; }
function requestId() { return context.getStore()?.requestId; }
function remainingTaskMs() { check(); return Math.max(1, (context.getStore()?.deadlineMs ?? Date.now()) - Date.now()); }

async function runManagement(task) {
    assertTakeoverIdle();
    if (managementContext.getStore()) return task();
    assertManagementIdle();
    if (managementActive) throw failure('DEVICE_BUSY', '设备管理正在执行。');
    managementActive = true;
    let drained;
    managementDrain = new Promise(resolve => { drained = resolve; });
    try { return await managementContext.run(true, task); }
    finally { managementActive = false; managementDrain = null; drained(); }
}

// Admission belongs to the service. Receipt cancellation is separate from this
// wait: actual task/child/management completion must precede resource disposal.
async function cancelAndDrain() {
    const runs = [...activeRuns];
    const management = managementDrain;
    for (const state of runs) state.cancel();
    await Promise.all([...runs.map(state => state.drain), management]);
}

function assertManagementIdle() {
    assertTakeoverIdle();
    if (managementActive && !managementContext.getStore()) throw failure('DEVICE_BUSY', '设备管理正在执行。');
    const owned = context.getStore()?.leaseKeys || new Set();
    for (const key of leases) if (!owned.has(key)) throw failure('DEVICE_BUSY', '设备管理不能打断正在执行的单步操作。');
}

function markDispatched() {
    const state = context.getStore();
    if (state) { state.dispatched = true; state.itemDispatched = true; }
}

function inputReceipt(details) { const state = context.getStore(); if (state) state.inputReceipt = { ...state.inputReceipt, ...details }; }
function dispatchState() { const state = context.getStore(); return { dispatched: Boolean(state?.dispatched || state?.childDispatched || state?.ownedScope?.dispatched), itemDispatched: state?.itemDispatched || false }; }
function restoreDispatch(saved) { const state = context.getStore(); if (state) Object.assign(state, saved); }
function remainingMs() { check(); return Math.max(1, Math.min(120000, (context.getStore()?.deadlineMs ?? Date.now() + 20000) - Date.now())); }

function verified(matched, evidence) {
    const state = context.getStore();
    if (state) {
        state.outcome = matched ? 'verified' : 'unknown';
        state.verification = { matched, ...evidence };
    }
}

function sequenceReceipt(state, stopped = false) {
    return { status: stopped ? 'stopped' : state.sequence.status, total: state.sequence.total, steps: state.sequence.steps.map(step => ({ ...step, ...(step.outcome === 'running' ? { outcome: state.itemDispatched || state.outcome === 'unknown' ? 'unknown' : 'failed' } : {}) })) };
}

function beginSequence(total) {
    context.getStore().sequence = { status: 'running', total, steps: [] };
}

function beginItem(command) {
    const state = context.getStore();
    if (state.historyClosed) return;
    state.actionCommand = actionHistory.normalizeCommand(command);
    state.itemHistory = { started: performance.now(), recorded: false };
    state.outcome = 'dispatched';
    state.verification = null;
    state.itemDispatched = false;
    state.inputReceipt = null;
    state.sequence.status = 'running';
    state.sequence.steps.push({ index: state.sequence.steps.length, command, outcome: 'running' });
}

function finishItem(requireVerified = false) {
    const state = context.getStore();
    const step = state.sequence.steps.at(-1);
    step.outcome = state.outcome;
    step.verification = state.verification;
    const stopped = state.outcome === 'unknown' || (requireVerified && state.outcome !== 'verified');
    state.sequence.status = stopped ? 'stopped' : 'completed';
    if (!state.historyClosed) finishHistory(state, step.outcome, performance.now() - state.itemHistory.started);
    return { ...step };
}

function setActionCommand(command) {
    const state = context.getStore();
    if (state && !state.historyClosed) state.actionCommand = actionHistory.normalizeCommand(command);
}

function finishHistory(state, outcome, durationMs, code) {
    if (state.sequence) {
        if (!state.itemHistory || state.itemHistory.recorded) return;
        state.itemHistory.recorded = true;
        const step = state.sequence.steps.at(-1);
        // A dispatched earlier step does not make an unstarted current step unknown.
        outcome = step.outcome === 'running' ? (state.itemDispatched || state.outcome === 'unknown' ? 'unknown' : 'failed') : step.outcome;
        durationMs = performance.now() - state.itemHistory.started;
    }
    actionHistory.record({
        serial: state.activeSerial || state.historySerial, requestId: state.requestId,
        command: state.actionCommand, outcome, durationMs, code, receipt: state.inputReceipt,
        ...(state.sequence ? { stepIndex: state.sequence.steps.length - 1 } : {}),
    });
}

module.exports = { cancelAndDrain, acquireTakeover, releaseTakeover, runTakeover, takeoverStatus, assertTakeoverIdle, requestId, remainingTaskMs, setActionCommand, inputReceipt, dispatchState, restoreDispatch, remainingMs, beginSequence, beginItem, finishItem, run, runOwned, stage, pause, check, failure, markDispatched, verified, bindDevice, activeDevice, executionSignal, assertManagementIdle, runManagement };
