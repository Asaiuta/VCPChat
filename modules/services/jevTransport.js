'use strict';

// Bounded transport facts only. Local finish is not proof of gateway receipt.
const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const STAGES = Object.freeze(['request_created', 'socket_assigned', 'dns_resolved', 'tcp_connected',
    'tls_connected', 'request_finished', 'http_response', 'failed']);
const ERRORS = Object.freeze(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ECONNABORTED', 'ERR_CANCELED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'OTHER']);

function observedTransport(observer) {
    const requestId = randomUUID(), started = performance.now();
    const emit = (stage, details = {}) => {
        try { observer({ requestId, stage, elapsedMs: Math.max(0, Math.floor(performance.now() - started)), ...details }); }
        catch { /* Telemetry cannot change request behavior. */ }
    };
    return { request(options, callback) {
        const request = (options.protocol === 'http:' ? http : https).request(options, response => {
            emit('http_response', { httpStatus: response.statusCode }); callback(response);
        });
        emit('request_created');
        request.once('socket', socket => {
            emit('socket_assigned', { reusedSocket: request.reusedSocket === true });
            const lookup = error => { if (!error) emit('dns_resolved'); };
            const connect = () => emit('tcp_connected');
            const secure = () => emit('tls_connected');
            socket.once('lookup', lookup); socket.once('connect', connect); socket.once('secureConnect', secure);
            request.once('close', () => {
                socket.removeListener('lookup', lookup); socket.removeListener('connect', connect); socket.removeListener('secureConnect', secure);
            });
        });
        request.once('finish', () => emit('request_finished'));
        request.once('error', error => emit('failed', { errorCode: ERRORS.includes(error.code) ? error.code : 'OTHER' }));
        return request;
    } };
}

module.exports = { observedTransport, STAGES, ERRORS };
