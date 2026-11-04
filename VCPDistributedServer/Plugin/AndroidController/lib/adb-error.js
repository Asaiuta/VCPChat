'use strict';

class AdbError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'AdbError';
        this.code = code;
        Object.assign(this, details);
    }
}

module.exports = { AdbError };
