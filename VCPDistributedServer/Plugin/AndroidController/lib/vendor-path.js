'use strict';

const path = require('node:path');

function vendorPath(name, libDirectory = __dirname) {
    return path.resolve(libDirectory, '..', 'vendor', name)
        .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

module.exports = { vendorPath };
