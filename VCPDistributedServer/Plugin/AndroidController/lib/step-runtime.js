'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');

const context = new AsyncLocalStorage();
const leases = new Set();
const managementContext = new AsyncLocalStorage();
let managementActive = false;

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

async function run({ serial, timeoutMs = 60000, signal, client, outcome = 'dispatched' }, task) {
    if (managementActive || leases.has(serial)) throw failure('DEVICE_BUSY', '设备已有操作或连接管理，请等待当前操作结束。');
    const controller = new AbortController();
    const state = {
        requestId: randomUUID(), deadlineMs: Date.now() + timeoutMs,
        signal: controller.signal, externalSignal: signal,
        timings: { prepareMs: 0, actionMs: 0, verificationMs: 0, totalMs: 0 },
        outcome, dispatched: false, verification: null,
        leaseKeys: new Set([serial]), activeSerial: null,
    };
    leases.add(serial);
    const started = performance.now();
    let timer;
    let operation;
    let abortHandler;
    const release = () => { for (const key of state.leaseKeys) leases.delete(key); };
    try {
        const boundary = new Promise((_, reject) => {
            abortHandler = () => {
                const error = failure('STEP_ABORTED', '单步执行已取消。');
                controller.abort(error);
                reject(error);
            };
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
                const result = await task();
                check();
                state.timings.totalMs = performance.now() - started;
                const execution = { requestId: state.requestId, serial: state.activeSerial || serial, outcome: state.verification ? state.outcome : result.details?.system?.outcome || (state.dispatched ? 'dispatched' : state.outcome), verification: state.verification, timings: { ...state.timings }, retryable: false };
                if (state.sequence) execution.sequence = sequenceReceipt(state);
                result.details = { ...result.details, execution };
                result.content = [...(result.content || []), { type: 'text', text: JSON.stringify({ execution }) }];
                return result;
            };
            return typeof client?.withContext === 'function'
                ? client.withContext({ deadlineMs: state.deadlineMs, signal: state.signal }, execute) : execute();
        });
        operation.then(release, release);
        return await Promise.race([boundary, operation]);
    } catch (error) {
        state.timings.totalMs = performance.now() - started;
        if (state.inputReceipt) error.details = state.inputReceipt;
        if (controller.signal.reason?.code === 'STEP_DEADLINE') error = Object.assign(controller.signal.reason, { details: error.details });
        error.execution = {
            requestId: state.requestId, serial: state.activeSerial || serial, outcome: state.dispatched ? 'unknown' : 'failed', retryable: false,
            verification: state.verification, timings: { ...state.timings },
            ...(state.sequence ? { sequence: sequenceReceipt(state, true) } : {}),
        };
        error.message += `\n${JSON.stringify({ ...(state.inputReceipt ? { details: state.inputReceipt } : {}), code: error.code || 'STEP_FAILED', execution: { requestId: state.requestId, serial: state.activeSerial || serial, outcome: error.execution.outcome, retryable: false, ...(error.execution.sequence ? { sequence: error.execution.sequence } : {}) } })}`;
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        if (!operation) release();
    }
}

function bindDevice(serial) {
    const state = context.getStore();
    if (!state) return;
    if (!state.leaseKeys.has(serial)) {
        if (leases.has(serial)) throw failure('DEVICE_BUSY', '设备已有单步操作。');
        leases.add(serial);
        state.leaseKeys.add(serial);
    }
    state.activeSerial = serial;
}

function activeDevice() { return context.getStore()?.activeSerial || null; }
function executionSignal() { return context.getStore()?.signal; }

async function runManagement(task) {
    if (managementContext.getStore()) return task();
    assertManagementIdle();
    if (managementActive) throw failure('DEVICE_BUSY', '设备管理正在执行。');
    managementActive = true;
    try { return await managementContext.run(true, task); }
    finally { managementActive = false; }
}

function assertManagementIdle() {
    if (managementActive && !managementContext.getStore()) throw failure('DEVICE_BUSY', '设备管理正在执行。');
    const owned = context.getStore()?.leaseKeys || new Set();
    for (const key of leases) if (!owned.has(key)) throw failure('DEVICE_BUSY', '设备管理不能打断正在执行的单步操作。');
}

function markDispatched() {
    const state = context.getStore();
    if (state) { state.dispatched = true; state.itemDispatched = true; }
}

function inputReceipt(details) { const state = context.getStore(); if (state) state.inputReceipt = { ...state.inputReceipt, ...details }; }
function dispatchState() { const state = context.getStore(); return { dispatched: state?.dispatched || false, itemDispatched: state?.itemDispatched || false }; }
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
    return { status: stopped ? 'stopped' : state.sequence.status, total: state.sequence.total, steps: state.sequence.steps.map(step => ({ ...step, ...(step.outcome === 'running' ? { outcome: state.itemDispatched ? 'unknown' : 'failed' } : {}) })) };
}

function beginSequence(total) {
    context.getStore().sequence = { status: 'running', total, steps: [] };
}

function beginItem(command) {
    const state = context.getStore();
    state.outcome = 'dispatched';
    state.verification = null;
    state.itemDispatched = false;
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
    return { ...step };
}

module.exports = { inputReceipt, dispatchState, restoreDispatch, remainingMs, beginSequence, beginItem, finishItem, run, stage, pause, check, failure, markDispatched, verified, bindDevice, activeDevice, executionSignal, assertManagementIdle, runManagement };
