'use strict';

const { NAMES } = require('./rpc-methods');

const CAPACITY = 100;
const MAX_DEVICES = 32;
const devices = new Map();
const COMMANDS = new Set([
    'tap', 'doubletap', 'longpress', 'swipe', 'scroll', 'scrolluntil',
    'inputtext', 'fill', 'keyevent', 'launchapp', 'killapp', 'wait', 'system',
    'imeaction', 'erasetext', 'keycombo', 'drag', 'pinch',
]);
const OUTCOMES = new Set(['observed', 'dispatched', 'verified', 'unknown', 'failed']);
const CHANNELS = new Set(['rpc', 'shell']);
const METHODS = new Set(NAMES);
const STATUSES = new Set(['starting', 'invoking', 'dispatched', 'not-dispatched', 'unknown']);
const CODES = new Set([
    'STEP_ABORTED', 'STEP_DEADLINE', 'STEP_FAILED', 'INVALID_ARGUMENT', 'DEVICE_BUSY',
    'NO_DEVICE', 'DEVICE_NOT_FOUND', 'UNAUTHORIZED', 'ADB_FAILED', 'INPUT_FAILED',
    'INVALID_COORDINATES', 'INVALID_FILL_TARGET', 'INVALID_SCROLL_TARGET',
    'SNAPSHOT_REQUIRED', 'STALE_SNAPSHOT', 'FRAME_REQUIRED', 'STALE_FRAME',
    'UI_IDLE_TIMEOUT', 'UI_ACQUISITION_FAILED', 'ADB_KEYBOARD_NOT_ACTIVE',
    'UI_SERVER_DISABLED', 'UI_SERVER_NOT_READY', 'UI_SERVER_ACTION_REJECTED',
    'UI_SERVER_RPC_FAILED', 'UI_SERVER_TIMEOUT', 'UI_SERVER_ABORTED',
    'UI_SERVER_INVALID_ARGUMENT', 'UI_SERVER_METHOD_UNAVAILABLE',
    'DOUBLE_TAP_WINDOW_MISSED', 'URL_RESOLUTION_FAILED', 'URL_NOT_SUPPORTED', 'URL_DISPATCH_FAILED',
    'SYSTEM_NOT_AUTHORIZED', 'UNSUPPORTED_USER', 'UNSUPPORTED_CAPABILITY',
    'PERMISSION_DENIED', 'UNSUPPORTED', 'PROBE_FAILED', 'DRAFT_FAILED',
]);

// Read only own data properties: neither retain callers' objects nor run accessors.
function value(object, key) {
    if (!object || typeof object !== 'object') return undefined;
    return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function validSerial(serial) {
    return typeof serial === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serial);
}

function normalizeCommand(command) {
    if (typeof command !== 'string' || command.length > 32) return undefined;
    const normalized = command.toLowerCase();
    return COMMANDS.has(normalized) ? normalized : undefined;
}

function optional(target, key, candidate, allowed) {
    if (typeof candidate === 'string' && allowed.has(candidate)) target[key] = candidate;
}

function record(metadata) {
    const serial = value(metadata, 'serial');
    const command = normalizeCommand(value(metadata, 'command'));
    const requestId = value(metadata, 'requestId');
    const outcome = value(metadata, 'outcome');
    const durationMs = value(metadata, 'durationMs');
    if (!validSerial(serial) || !command || typeof requestId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId) ||
        !OUTCOMES.has(outcome) || !Number.isFinite(durationMs) || durationMs < 0) return false;
    const entry = { requestId, command, outcome, durationMs: Math.round(Math.min(durationMs, 86400000) * 1000) / 1000 };
    const stepIndex = value(metadata, 'stepIndex');
    if (Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex < 8) entry.stepIndex = stepIndex;
    const attempts = value(value(metadata, 'receipt'), 'attempts');
    if (Array.isArray(attempts)) {
        // Only the last actual attempt is summarized; arguments and earlier failures are never copied.
        const attempt = value(attempts, String(attempts.length - 1));
        optional(entry, 'channel', value(attempt, 'channel'), CHANNELS);
        optional(entry, 'method', value(attempt, 'method'), METHODS);
        optional(entry, 'status', value(attempt, 'status'), STATUSES);
        optional(entry, 'code', value(attempt, 'code'), CODES);
    }
    optional(entry, 'code', value(metadata, 'code'), CODES);
    const entries = devices.get(serial) || [];
    if (entries.length === CAPACITY) entries.shift();
    entries.push(Object.freeze(entry));
    // Record recency, not query recency, controls bounded device eviction.
    devices.delete(serial);
    devices.set(serial, entries);
    if (devices.size > MAX_DEVICES) devices.delete(devices.keys().next().value);
    return true;
}

function invalid() {
    return Object.assign(new Error('[AndroidController] actionHistory 需要明确有效的 serial（或恰好一个留存设备）及 1–100 的整数 limit。'), { code: 'INVALID_ARGUMENT' });
}

function query(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => !['serial', 'limit'].includes(key))) throw invalid();
    const requestedLimit = value(options, 'limit');
    const limit = requestedLimit === undefined ? 20 : requestedLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > CAPACITY) throw invalid();
    let serial = value(options, 'serial');
    if (serial === undefined) {
        if (devices.size !== 1) throw invalid();
        serial = devices.keys().next().value;
    }
    if (!validSerial(serial)) throw invalid();
    const entries = (devices.get(serial) || []).slice(-limit).reverse().map(entry => ({ ...entry }));
    return { serial, entries, capacity: CAPACITY, maxDevices: MAX_DEVICES };
}

function clear() { devices.clear(); }

module.exports = { CAPACITY, MAX_DEVICES, record, query, clear, normalizeCommand };
