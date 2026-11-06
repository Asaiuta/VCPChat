'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { CONTEXT_DIFF_TOKENS } = require('../../VCPDistributedServer/Plugin/AndroidController/lib/context');
const { LIMITS, traceEventLimit } = require('./androidTaskBudget');

const MAX_BYTES = 512 * 1024;
const TERMINAL_RESERVE_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const HEADER_KEYS = ['schemaVersion', 'taskId', 'serial', 'package', 'intent', 'inputRefs', 'budget'];
const BUDGET_KEYS = ['timeoutMs', 'maxActions', 'maxObservations', 'maxModelCalls'];
const EVENT_KEYS = ['type', 'step', 'observation', 'targetId', 'inputRef', 'source', 'requestId',
    'outcome', 'code', 'matched', 'modelCalls', 'phase', 'attempts', 'dispatched', 'choice', 'expectId', 'candidates',
    'contextDiff', 'completion'];
const COMPLETION_KEYS = ['present', 'containers', 'items', 'inputMatched', 'absent'];

function failure(code) { return Object.assign(new Error(code), { code }); }
function requireValid(condition) { if (!condition) throw failure('TRACE_INVALID_ARGUMENT'); }
function record(value, allowed, required = []) {
    requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
    const prototype = Object.getPrototypeOf(value);
    requireValid(prototype === Object.prototype || prototype === null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
        requireValid(typeof key === 'string' && allowed.includes(key));
        const descriptor = descriptors[key];
        requireValid(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
        copy[key] = descriptor.value;
    }
    for (const key of required) requireValid(Object.hasOwn(copy, key));
    return copy;
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    requireValid(Number.isSafeInteger(value) && value >= min && value <= max);
    return value;
}
function choice(value, values) { requireValid(values.includes(value)); return value; }
function uuid(value) { requireValid(typeof value === 'string' && UUID.test(value)); return value.toLowerCase(); }
function digest(value) {
    requireValid(typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value));
    return value.toLowerCase();
}
function inputRefs(value) {
    requireValid(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireValid(Reflect.ownKeys(descriptors).length === 2 && descriptors.length?.value === 1);
    requireValid(descriptors[0] && Object.hasOwn(descriptors[0], 'value') && descriptors[0].value === 'query');
    return ['query'];
}
function headerSnapshot(value) {
    const data = record(value, [...HEADER_KEYS, 'decision', 'policyVersion', 'completionPolicyVersion'], HEADER_KEYS);
    requireValid(data.schemaVersion === 1 && data.intent === 'search');
    requireValid(typeof data.serial === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,159}$/.test(data.serial)
        && !['constructor', 'prototype', '__proto__'].includes(data.serial));
    requireValid(typeof data.package === 'string' && data.package.length <= 255 && PACKAGE.test(data.package));
    const budget = record(data.budget, BUDGET_KEYS, BUDGET_KEYS);
    if (data.decision !== undefined || data.policyVersion !== undefined) {
        requireValid(data.decision === 'jev' && data.policyVersion === 'search-v1');
    }
    if (data.completionPolicyVersion !== undefined) requireValid(data.completionPolicyVersion === 'search-completion-v2');
    return { schemaVersion: 1, taskId: uuid(data.taskId), serial: data.serial, package: data.package,
        ...(data.decision ? { decision: data.decision, policyVersion: data.policyVersion } : {}),
        ...(data.completionPolicyVersion ? { completionPolicyVersion: data.completionPolicyVersion } : {}),
        intent: 'search', inputRefs: inputRefs(data.inputRefs), budget: {
            timeoutMs: integer(budget.timeoutMs, 1, LIMITS.timeoutMs), maxActions: integer(budget.maxActions, 1, LIMITS.maxActions),
            maxObservations: integer(budget.maxObservations, 1, LIMITS.maxObservations), maxModelCalls: integer(budget.maxModelCalls, 0, LIMITS.maxModelCalls)
        } };
}
function list(value, max, convert) {
    requireValid(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length.value;
    requireValid(length <= max && Reflect.ownKeys(descriptors).length === length + 1);
    return Array.from({ length }, (_, index) => {
        const descriptor = descriptors[index];
        requireValid(descriptor && Object.hasOwn(descriptor, 'value'));
        return convert(descriptor.value, index);
    });
}
function targetId(value, packageName) {
    const prefix = `${packageName}:id/`;
    requireValid(typeof value === 'string' && value.length <= MAX_BYTES && value.startsWith(prefix)
        && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(prefix.length)));
    return value;
}
function eventSnapshot(value, packageName) {
    const data = record(value, EVENT_KEYS, ['type']);
    const event = { type: choice(data.type, ['observation', 'candidates', 'decision', 'action', 'verification', 'stopped', 'completed']) };
    for (const key of Object.keys(data)) {
        const value = data[key];
        switch (key) {
        case 'type': break;
        case 'step': event.step = choice(value, ['entry', 'fill', 'submit', 'complete']); break;
        case 'observation': {
            const item = record(value, ['id', 'digest', 'contextDigest', 'controls', 'targetDigest', 'outsideDigest'],
                ['id', 'digest', 'contextDigest', 'controls']);
            requireValid(Object.hasOwn(item, 'targetDigest') === Object.hasOwn(item, 'outsideDigest'));
            event.observation = { id: uuid(item.id), digest: digest(item.digest),
                contextDigest: digest(item.contextDigest), controls: integer(item.controls),
                ...(Object.hasOwn(item, 'targetDigest') ? { targetDigest: digest(item.targetDigest),
                    outsideDigest: digest(item.outsideDigest) } : {}) };
            break;
        }
        case 'contextDiff': {
            const tokens = list(value, CONTEXT_DIFF_TOKENS.length, token => choice(token, CONTEXT_DIFF_TOKENS));
            requireValid(tokens.length > 0 && new Set(tokens).size === tokens.length);
            event.contextDiff = CONTEXT_DIFF_TOKENS.filter(token => tokens.includes(token));
            break;
        }
        case 'completion': {
            const item = record(value, COMPLETION_KEYS, COMPLETION_KEYS);
            for (const key of ['present', 'inputMatched', 'absent']) requireValid(typeof item[key] === 'boolean');
            event.completion = { present: item.present, containers: integer(item.containers, 0, 1000),
                items: integer(item.items, 0, 1000), inputMatched: item.inputMatched, absent: item.absent };
            break;
        }
        case 'targetId': case 'expectId': event[key] = targetId(value, packageName); break;
        case 'candidates':
            event.candidates = list(value, 8, (candidate, index) => {
                const keys = ['candidateId', 'targetId', 'command', 'evidenceSources', 'postcondition'];
                const item = record(candidate, keys, keys);
                requireValid(item.candidateId === `c${index}`);
                const evidenceSources = list(item.evidenceSources, 3, source => choice(source, ['id', 'text', 'desc']));
                requireValid(evidenceSources.length > 0 && new Set(evidenceSources).size === evidenceSources.length);
                return { candidateId: item.candidateId, targetId: targetId(item.targetId, packageName),
                    command: choice(item.command, ['Tap', 'Fill']), evidenceSources,
                    postcondition: choice(item.postcondition, ['search_progress', 'input_readback', 'completion_visible']) };
            });
            requireValid(new Set(event.candidates.map(c => c.targetId)).size === event.candidates.length);
            break;
        case 'inputRef': event.inputRef = choice(value, ['query']); break;
        case 'source': event.source = choice(value, ['rule', 'shadow', 'jev']); break;
        case 'choice': event.choice = choice(value, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'none', 'invalid', 'wait', 'escalate']); break;
        case 'requestId': event.requestId = uuid(value); break;
        case 'outcome': event.outcome = choice(value, ['observed', 'dispatched', 'verified', 'unknown', 'failed']); break;
        case 'code':
            requireValid(typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value));
            event.code = value;
            break;
        case 'matched': case 'dispatched': requireValid(typeof value === 'boolean'); event[key] = value; break;
        case 'modelCalls': event.modelCalls = integer(value, 0, 16); break;
        case 'attempts': event.attempts = integer(value, 0, 32); break;
        case 'phase': event.phase = choice(value, ['prepared', 'settled']); break;
        }
    }
    return event;
}
function encode(record) { return `${JSON.stringify(record)}\n`; }

function createTaskTraceStore(options) {
    const config = record(options, ['directory'], ['directory']);
    requireValid(typeof config.directory === 'string' && config.directory.length > 0 && !config.directory.includes('\0'));
    const directory = path.resolve(config.directory);
    return {
        async open(header) {
            const snapshot = headerSnapshot(header);
            header = undefined;
            const firstLine = encode({ type: 'task', seq: 0, ...snapshot });
            let bytes = Buffer.byteLength(firstLine);
            if (bytes > MAX_BYTES) throw failure('TRACE_LIMIT');
            let handle;
            try {
                await fs.mkdir(directory, { recursive: true });
                handle = await fs.open(path.join(directory, `${snapshot.taskId}.jsonl`), 'wx', 0o600);
            } catch (error) { throw failure(error.code === 'EEXIST' ? 'TRACE_EXISTS' : 'TRACE_OPEN_FAILED'); }
            try { await handle.writeFile(firstLine, 'utf8'); }
            catch {
                await handle.close().catch(() => {});
                throw failure('TRACE_WRITE_FAILED');
            }
            const packageName = snapshot.package;
            const maxEvents = traceEventLimit(snapshot.budget);
            let count = 0;
            let failed = false;
            let closing = false;
            let inFlight = null;
            let closePromise;
            return {
                async append(event) {
                    if (failed) throw failure('TRACE_WRITE_FAILED');
                    if (closing) throw failure('TRACE_CLOSED');
                    if (inFlight) throw failure('TRACE_BUSY');
                    const copy = eventSnapshot(event, packageName);
                    event = undefined;
                    const line = encode({ ...copy, seq: count + 1 });
                    const size = Buffer.byteLength(line);
                    const terminal = copy.type === 'stopped' || copy.type === 'completed';
                    // Ordinary events cannot consume the last slot or the bytes needed
                    // to explain why the task stopped. This does not buffer events in RAM.
                    if (count >= maxEvents - (terminal ? 0 : 1)
                        || bytes + size > MAX_BYTES - (terminal ? 0 : TERMINAL_RESERVE_BYTES)) throw failure('TRACE_LIMIT');
                    const operation = Promise.resolve().then(() => handle.writeFile(line, 'utf8')).then(() => {
                        count += 1;
                        bytes += size;
                    }, () => {
                        failed = true;
                        throw failure('TRACE_WRITE_FAILED');
                    });
                    inFlight = operation;
                    try { await operation; }
                    finally { inFlight = null; }
                },
                async close() {
                    if (!closePromise) {
                        closing = true;
                        closePromise = (async () => {
                            if (inFlight) await inFlight.catch(() => {});
                            try { await handle.close(); }
                            catch { throw failure('TRACE_CLOSE_FAILED'); }
                        })();
                    }
                    await closePromise;
                }
            };
        }
    };
}

module.exports = { createTaskTraceStore };
