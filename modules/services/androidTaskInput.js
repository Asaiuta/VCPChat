'use strict';

const fail = code => Object.assign(new Error(`Android task stopped: ${code}`), { code });
// Copy only JSON data properties. Never evaluate caller accessors or retain mutable input.
function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('TASK_INVALID');
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptor, 'value')) throw fail('TASK_INVALID');
        result[key] = descriptor.value;
    }
    return result;
}

function integer(value, fallback, min, max) {
    const number = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(number) || number < min || number > max) throw fail('TASK_INVALID');
    return number;
}

function resourceId(value, packageName) {
    if (typeof value !== 'string' || value.length > 320 || !value.startsWith(packageName + ':id/')
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(packageName.length + 4))) throw fail('TASK_INVALID');
    return value;
}

module.exports = { object, integer, resourceId };
