'use strict';
const MAX_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
function inputRefs(value, ref = 'query') {
    requireValid(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireValid(Reflect.ownKeys(descriptors).length === 2 && descriptors.length?.value === 1);
    requireValid(descriptors[0] && Object.hasOwn(descriptors[0], 'value') && descriptors[0].value === ref);
    return [ref];
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

module.exports = { failure, requireValid, record, integer, choice, uuid, digest, inputRefs, list, targetId };
