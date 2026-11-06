'use strict';

/**
 * Identity layers are deliberately independent. None is an authorization token.
 * Code: fresh bytes under plugin root (root JS, lib JS, vendor, manifest); no git,
 * environment files, commands, dependency trees or persistent cache are consulted.
 * Performance: caller supplied, non-secret Node/OS/ROM/config/workload data only.
 * Capability: code + carrier evidence + session generation + device evidence.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { types } = require('node:util');

const CODE_REQUIRED_FILES = Object.freeze([
    'AndroidControllerService.js', 'plugin-manifest.json',
    'lib/system-api.js', 'lib/step-runtime.js', 'lib/ui-graph.js',
    'lib/selector.js', 'lib/ui-transport.js', 'lib/ui-owner.js', 'lib/context.js',
    'lib/interaction-policy.js', 'lib/interaction-guard.js', 'lib/code-identity.js',
    'vendor/scrcpy-server-v5.0.1', 'vendor/u2-server-0.5.0.apk', 'vendor/vcp-ui-owner.jar',
]);
const DIGEST = /^[a-f0-9]{64}$/;
const SECRET_KEY = /password|passwd|passphrase|secret|token|credential|authorization|cookie|private.?key|api.?key/i;
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const JAVASCRIPT = /\.(?:js|cjs|mjs)$/;
const own = (object, key) => Object.hasOwn(object, key);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const invalid = () => Object.assign(new TypeError('Identity input must be bounded, non-secret plain data.'), { code: 'INVALID_ARGUMENT' });

function nativePrototype(value, builtin) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return builtin === Object;
    if (types.isProxy(prototype)) return false;
    if (builtin === Object && Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    return typeof constructor === 'function' && !types.isProxy(constructor)
        && Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value === prototype
        && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(builtin);
}

// No JSON.stringify hooks, getters, proxies, undefined, non-finite values or cycles.
// The canonical encoding sorts keys by UTF-16 code units, independent of locale.
function canonical(value) {
    let nodes = 0;
    const active = new Set();
    function visit(item, depth) {
        if (++nodes > 20000 || depth > 16) throw invalid();
        if (item === null || typeof item === 'boolean') return JSON.stringify(item);
        if (typeof item === 'string') {
            if (item.length > 65536) throw invalid();
            return JSON.stringify(item);
        }
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) throw invalid();
            return JSON.stringify(item);
        }
        if (!item || typeof item !== 'object' || types.isProxy(item) || active.has(item)) throw invalid();
        const array = Array.isArray(item);
        if (!nativePrototype(item, array ? Array : Object)) throw invalid();
        const fields = Object.getOwnPropertyDescriptors(item);
        const keys = Reflect.ownKeys(fields);
        for (const key of keys) {
            if (typeof key !== 'string' || !own(fields[key], 'value') || SECRET_KEY.test(key)) throw invalid();
            if (array && key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)) throw invalid();
        }
        active.add(item);
        let encoded;
        if (array) {
            const length = fields.length.value;
            if (length > 10000) throw invalid();
            const values = [];
            for (let index = 0; index < length; index++) {
                if (!own(fields, String(index))) throw invalid();
                values.push(visit(fields[index].value, depth + 1));
            }
            encoded = `[${values.join(',')}]`;
        } else {
            encoded = `{${keys.sort().map(key => `${JSON.stringify(key)}:${visit(fields[key].value, depth + 1)}`).join(',')}}`;
        }
        active.delete(item);
        return encoded;
    }
    return visit(value, 0);
}

function dataRecord(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
        || !nativePrototype(value, Object)) throw invalid();
    const fields = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(fields)) {
        if (typeof key !== 'string' || !own(fields[key], 'value') || !allowed.includes(key)) throw invalid();
    }
    return fields;
}
const get = (fields, key) => own(fields, key) ? fields[key].value : undefined;
const hashLayer = (schema, value) => sha256(canonical({ schema, value }));

async function computeCodeIdentity(options = {}) {
    const fields = dataRecord(options, ['rootDir']);
    const rootDir = get(fields, 'rootDir');
    if (typeof rootDir !== 'string' || rootDir.trim() === '') throw invalid();
    const root = path.resolve(rootDir);
    const entries = new Map();
    let visited = 0;
    function add(relative, status, extra = {}) {
        entries.set(relative, { path: relative, status, ...extra });
    }
    async function visit(relative, recursive, javascriptOnly) {
        if (++visited > MAX_FILES) throw Object.assign(new Error('Identity file limit exceeded.'), { code: 'IDENTITY_LIMIT' });
        const absolute = path.join(root, ...relative.split('/').filter(Boolean));
        let before;
        try { before = await fs.promises.lstat(absolute); }
        catch (error) { add(relative || '.', error.code === 'ENOENT' ? 'missing' : 'unreadable'); return; }
        if (before.isSymbolicLink()) { add(relative || '.', 'symlink'); return; }
        if (before.isDirectory()) {
            let children;
            try { children = (await fs.promises.readdir(absolute)).sort(); }
            catch { add(relative || '.', 'unreadable'); return; }
            for (const child of children) {
                const childRelative = relative ? `${relative}/${child}` : child;
                if (!relative) {
                    if (child === 'lib') await visit(childRelative, true, true);
                    else if (child === 'vendor') await visit(childRelative, true, false);
                    else if (child === 'plugin-manifest.json' || JAVASCRIPT.test(child)) await visit(childRelative, false, false);
                } else if (recursive) {
                    if (!javascriptOnly || JAVASCRIPT.test(child)) await visit(childRelative, true, javascriptOnly);
                    else {
                        let stat;
                        try { stat = await fs.promises.lstat(path.join(absolute, child)); }
                        catch { add(childRelative, 'unreadable'); continue; }
                        if (stat.isDirectory() || stat.isSymbolicLink()) await visit(childRelative, true, javascriptOnly);
                    }
                }
            }
            return;
        }
        if (!before.isFile()) { add(relative, 'unsupported'); return; }
        if (before.size > MAX_FILE_BYTES) { add(relative, 'oversized'); return; }
        try {
            // Fresh bytes on every request, with bounded buffers and event-loop turns
            // between chunks. A large vendor file never becomes one retained Buffer.
            const hash = createHash('sha256');
            let size = 0;
            for await (const chunk of fs.createReadStream(absolute, { highWaterMark: 64 * 1024 })) {
                size += chunk.length;
                if (size > MAX_FILE_BYTES) { add(relative, 'oversized'); return; }
                hash.update(chunk);
            }
            const after = await fs.promises.lstat(absolute);
            const stable = after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
                && before.size === after.size && size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
            add(relative, stable ? 'ok' : 'changedDuringRead', { sha256: hash.digest('hex'), size });
        } catch (error) { add(relative, error.code === 'ENOENT' ? 'missing' : 'unreadable'); }
    }
    await visit('', true, false);
    for (const required of CODE_REQUIRED_FILES) if (!entries.has(required)) add(required, 'missing');
    for (const directory of ['lib', 'vendor']) {
        try {
            const stat = await fs.promises.lstat(path.join(root, directory));
            if (!stat.isDirectory() || stat.isSymbolicLink()) add(`${directory}/`, 'unsupported');
        } catch { add(`${directory}/`, 'missing'); }
    }
    const files = [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const issues = files.filter(file => file.status !== 'ok').map(file => `${file.status}:${file.path}`);
    const schema = 'android-code-identity-v1';
    return Object.freeze({ schema, algorithm: 'sha256', digest: hashLayer(schema, files), complete: issues.length === 0,
        files: Object.freeze(files.map(Object.freeze)), issues: Object.freeze(issues) });
}

function computePerformanceIdentity(input) {
    const fields = dataRecord(input, ['node', 'os', 'rom', 'config', 'workload']);
    const digests = {};
    const missing = [];
    for (const name of ['node', 'os', 'rom', 'config', 'workload']) {
        const value = get(fields, name);
        if (value === undefined || value === null) missing.push(name);
        digests[name] = hashLayer(`android-performance-${name}-v1`, value === undefined ? null : value);
    }
    const schema = 'android-performance-identity-v1';
    return Object.freeze({ schema, algorithm: 'sha256', digest: hashLayer(schema, digests), complete: missing.length === 0,
        digests: Object.freeze(digests), missing: Object.freeze(missing) });
}

function computeCapabilityIdentity(input) {
    const fields = dataRecord(input, ['codeDigest', 'carrier', 'sessionGeneration', 'deviceEvidence']);
    const codeDigest = get(fields, 'codeDigest');
    const carrier = get(fields, 'carrier');
    const sessionGeneration = get(fields, 'sessionGeneration');
    const deviceEvidence = get(fields, 'deviceEvidence');
    const missing = [];
    if (typeof codeDigest !== 'string' || !DIGEST.test(codeDigest)) throw invalid();
    canonical(input);
    let carrierComplete = false;
    if (carrier && typeof carrier === 'object' && !Array.isArray(carrier)) {
        const data = Object.getOwnPropertyDescriptors(carrier);
        const expected = get(data, 'expectedSha256');
        const actual = get(data, 'actualSha256');
        const generation = get(data, 'generation');
        carrierComplete = get(data, 'status') === 'verified' && typeof expected === 'string' && DIGEST.test(expected)
            && actual === expected && Number.isSafeInteger(generation) && generation >= 0;
    }
    if (!carrierComplete) missing.push('verifiedCarrier');
    if (!((typeof sessionGeneration === 'string' && sessionGeneration.trim().length > 0 && sessionGeneration.length <= 160)
        || (Number.isSafeInteger(sessionGeneration) && sessionGeneration >= 0))) missing.push('sessionGeneration');
    if (!deviceEvidence || typeof deviceEvidence !== 'object' || Array.isArray(deviceEvidence) || Object.keys(deviceEvidence).length === 0) missing.push('deviceEvidence');
    const schema = 'android-capability-identity-v1';
    const binding = { codeDigest, carrier: carrier ?? null, sessionGeneration: sessionGeneration ?? null, deviceEvidence: deviceEvidence ?? null };
    return Object.freeze({ schema, algorithm: 'sha256', digest: hashLayer(schema, binding), complete: missing.length === 0, missing: Object.freeze(missing) });
}

module.exports = { computeCodeIdentity, computePerformanceIdentity, computeCapabilityIdentity, CODE_REQUIRED_FILES };
