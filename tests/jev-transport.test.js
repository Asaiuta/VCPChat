'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { observedTransport } = require('../modules/services/jevTransport');
const { GlobalJevService } = require('../modules/services/globalJevService');
const { transportEvidence } = require('../modules/services/androidJevEvidence');

test('transport records ordered bounded facts, not headers, addresses, body or error text', t => {
    const req = new EventEmitter(), socket = new EventEmitter(); let respond;
    t.mock.method(http, 'request', (_options, callback) => { respond = callback; return req; });
    const rows = [];
    observedTransport(row => rows.push(row)).request({ protocol: 'http:', headers: { Authorization: 'secret' } }, () => {});
    req.emit('socket', socket); socket.emit('lookup', null, 'private-IP'); socket.emit('connect'); socket.emit('secureConnect');
    req.emit('finish'); respond({ statusCode: 200, body: 'private body' });
    req.emit('error', { code: 'ECONNRESET', message: 'private error', address: 'private-IP' }); req.emit('close');
    assert.deepEqual(rows.map(r => r.stage), ['request_created','socket_assigned','dns_resolved','tcp_connected','tls_connected','request_finished','http_response','failed']);
    assert.equal(rows[6].httpStatus, 200); assert.equal(rows[7].errorCode, 'ECONNRESET');
    assert.equal(new Set(rows.map(r => r.requestId)).size, 1);
    assert.doesNotMatch(JSON.stringify(rows), /private|secret|Authorization/);
    assert.ok(rows.every(r => transportEvidence(r)));
    assert.equal(socket.listenerCount('lookup'), 0);
});
test('global service caps the caller timeout to configuration and forwards transport observer', async () => {
    let captured; const observer = () => {};
    const service = new GlobalJevService({settingsManager:{readSettings:async()=>({jevEnabled:true,jevTimeoutMs:30000})},
        client:{decide:async(_s,_q,options)=>{captured=options;return {answers:{}};}}});
    await service.decide({}, {}, {timeoutMs:120000,maxRetries:0,onTransportMetadata:observer});
    assert.equal(captured.timeoutMs,30000);assert.equal(captured.onTransportMetadata,observer);assert.equal(captured.maxRetries,0);
    await service.decide({}, {}, {timeoutMs:500,maxRetries:0});assert.equal(captured.timeoutMs,500);
});
