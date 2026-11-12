'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInteractionPolicy, classifyRisk, RISK_VOCABULARY } = require('../VCPDistributedServer/Plugin/AndroidController/lib/interaction-policy');
const vm = require('node:vm');
const request = extra => ({ operation: 'write', package: 'com.example', ...extra });
const policy = config => createInteractionPolicy({ getConfig: () => config });

test('denied packages block reads and writes, exact package matching only', () => {
    const p = policy({ denyPackages: ['com.example'] });
    for (const operation of ['read', 'write']) {
        const result = p.decide(request({ operation }));
        assert.equal(result.allowed, false);
        assert.equal(result.code, 'POLICY_DENIED');
        assert.deepEqual(result.reasons, ['denyPackage']);
    }
    assert.equal(p.decide(request({ package: 'com.example.other' })).allowed, true);
});

test('read-only package allows reads and rejects writes before confirmation', () => {
    const p = policy({ readOnlyPackages: ['com.example'], confirmEveryWrite: true });
    assert.equal(p.decide(request({ operation: 'read' })).allowed, true);
    assert.deepEqual(p.decide(request()).reasons, ['readOnlyPackage']);
});

test('every write confirmation is a refusal, never a model approval channel', () => {
    const p = policy({ confirmEveryWrite: true });
    const denied = p.decide(request());
    assert.equal(denied.code, 'POLICY_CONFIRMATION_REQUIRED');
    assert.equal(denied.needsConfirmation, true);
    assert.equal(p.decide(request({ operation: 'read' })).allowed, true);
    for (const approved of [{ confirmed: true }, { approval: 'yes' }, { trustedApproval: true }]) {
        assert.equal(p.decide(request(approved)).allowed, false);
        assert.equal(p.decide(request(approved)).code, 'INVALID_ARGUMENT');
    }
});

test('config changes are read at every decision; JSON config is supported', () => {
    let reads = 0;
    let config = {};
    const p = createInteractionPolicy({ getConfig: () => { reads++; return config; } });
    assert.equal(p.decide(request()).allowed, true);
    config = '{"denyPackages":["com.example"]}';
    assert.equal(p.decide(request()).allowed, false);
    config = { readOnlyPackages: ['com.example'] };
    assert.equal(p.decide(request({ operation: 'read' })).allowed, true);
    config = { confirmEveryWrite: true };
    assert.equal(p.decide(request()).needsConfirmation, true);
    assert.equal(reads, 4);
});

test('malformed configuration never silently disables policy', () => {
    for (const config of [undefined, null, [], true, '', 'null', '{', '{"confirmed":true}', { denyPackages: '*' },
        { denyPackages: [''] }, { denyPackages: ['com.*'] }, { readOnlyPackages: [null] }, { confirmEveryWrite: 'false' }, { typo: [] }]) {
        const result = policy(config).decide(request());
        assert.equal(result.allowed, false);
        assert.equal(result.code, 'POLICY_CONFIG_INVALID');
    }
    assert.equal(createInteractionPolicy({ getConfig: () => { throw new Error('private'); } }).decide(request()).code, 'POLICY_CONFIG_INVALID');
});

test('package rules fail closed when trusted caller has no resolved package', () => {
    for (const config of [{ denyPackages: ['com.other'] }, { readOnlyPackages: ['com.other'] }]) {
        for (const packageName of [undefined, '']) {
            assert.deepEqual(policy(config).decide(request({ package: packageName })).reasons, ['packageUnknown']);
        }
    }
    assert.equal(policy({}).decide(request({ package: undefined })).allowed, true);
});

test('sensitive vocabulary drives the same badges and write refusals by default', () => {
    for (const rule of RISK_VOCABULARY) {
        assert.ok(Object.isFrozen(rule.words));
        for (const label of rule.words) {
            const risk = classifyRisk({ label });
            assert.ok(risk.sensitive, label);
            assert.ok(risk.categories.includes(rule.category), label);
            const result = policy({ confirmEveryWrite: false }).decide(request({ control: { label } }));
            assert.equal(result.allowed, false, label);
            assert.equal(result.needsConfirmation, true, label);
            assert.deepEqual(result.risk, risk);
            assert.equal(policy({}).decide(request({ operation: 'read', control: { label } })).allowed, true);
        }
    }
});

test('semantic actions, system capabilities, IDs and keyboard/pixel context cannot skip risks', () => {
    for (const extra of [
        { action: 'Confirm' }, { capability: 'sms' }, { action: 'InputPassword' },
        { control: { id: 'com.example:id/btnSendMessage' } }, { control: { shortId: ':id/checkout' } },
        { control: { desc: '确认支付' } }, { controls: [{ label: '普通' }, { label: '删除' }] },
    ]) {
        assert.equal(policy({}).decide(request(extra)).needsConfirmation, true);
    }
});

test('classifier uses only short complete labels and leaf IDs, never content or provenance', () => {
    const rawNode = { text: 'delete password send' };
    rawNode.parent = rawNode;
    const control = { label: '聊天内容'.repeat(40) + '删除', desc: '', value: 'send password',
        id: 'com.delete.payment:id/ordinary', role: 'statictext' };
    Object.defineProperty(control, 'rawNode', { value: rawNode });
    Object.defineProperty(control, Symbol('fullLabel'), { value: '发送' });
    assert.equal(classifyRisk(control).sensitive, false);
    for (const label of ['删除…', 'send\nmessage', 'payment'.repeat(30)]) assert.equal(classifyRisk({ label }).sensitive, false);
    for (const label of ['sender', 'display', 'removable', 'repayment']) assert.equal(classifyRisk({ label }).sensitive, false);
});

test('accessors and proxies are rejected without invoking user code', () => {
    let calls = 0;
    const getter = { get label() { calls++; return 'safe'; } };
    const requestGetter = { operation: 'write', get package() { calls++; return 'com.example'; } };
    const configGetter = { get denyPackages() { calls++; return []; } };
    const proxy = new Proxy({}, { ownKeys() { calls++; return []; }, get() { calls++; return 'safe'; } });
    assert.equal(policy({}).decide(request({ control: getter })).code, 'INVALID_ARGUMENT');
    assert.equal(policy({}).decide(requestGetter).code, 'INVALID_ARGUMENT');
    assert.equal(policy(configGetter).decide(request()).code, 'POLICY_CONFIG_INVALID');
    assert.equal(policy(proxy).decide(request()).code, 'POLICY_CONFIG_INVALID');
    assert.equal(policy({}).decide(request({ control: proxy })).code, 'INVALID_ARGUMENT');
    assert.equal(policy({}).decide(request({ controls: new Proxy([], {}) })).code, 'INVALID_ARGUMENT');
    assert.equal(calls, 0);
});

test('array accessors, sparse arrays, malformed request fields and inherited behavior fail closed', () => {
    let calls = 0;
    const packages = [];
    Object.defineProperty(packages, '0', { get() { calls++; return 'com.example'; } });
    const controls = [];
    Object.defineProperty(controls, '0', { get() { calls++; return { label: 'safe' }; } });
    assert.equal(policy({ denyPackages: packages }).decide(request()).code, 'POLICY_CONFIG_INVALID');
    for (const extra of [{ controls }, { controls: new Array(1) }, { operation: 'navigate' }, { package: 7 },
        { package: 'com.example;rm' }, { capability: {} }, { action: 'a'.repeat(65) }, { control: { label: 3 } }]) {
        assert.equal(policy({}).decide(request(extra)).code, 'INVALID_ARGUMENT');
    }
    assert.equal(policy(Object.create({ denyPackages: ['com.example'] })).decide(request()).code, 'POLICY_CONFIG_INVALID');
    assert.equal(calls, 0);
});

test('assertAllowed errors fit step-runtime code/details and never include private text', () => {
    const p = policy({});
    assert.throws(() => p.assertAllowed(request({ control: { label: '发送', value: 'PRIVATE CONTENT' } })), error => {
        assert.equal(error.code, 'POLICY_CONFIRMATION_REQUIRED');
        assert.equal(error.needsConfirmation, true);
        assert.equal(error.details.policy.allowed, false);
        assert.equal(JSON.stringify(error).includes('PRIVATE CONTENT'), false);
        assert.ok(Object.isFrozen(error.details.policy));
        return true;
    });
    assert.equal(p.assertAllowed(request({ control: { label: '下一页' } })).allowed, true);
});

test('cross-realm native records and arrays retain policy rather than being rejected as config', () => {
    const config = vm.runInNewContext('({denyPackages:["com.blocked"],readOnlyPackages:["com.readonly"]})');
    const p = policy(config);
    assert.equal(p.decide(vm.runInNewContext('({operation:"write",package:"com.example",control:{label:"下一页"}})')).allowed, true);
    assert.deepEqual(p.decide(request({ package: 'com.blocked' })).reasons, ['denyPackage']);
    assert.deepEqual(p.decide(request({ package: 'com.readonly' })).reasons, ['readOnlyPackage']);
    assert.equal(p.decide(vm.runInNewContext('({operation:"write",package:"com.example",controls:[{label:"发送"}]})')).needsConfirmation, true);
});

test('exact EraseText field editing is not business deletion, but node risk still wins', () => {
    const p = policy({});
    assert.equal(p.decide(request({ action: 'EraseText', control: { label: '搜索' } })).allowed, true);
    assert.equal(p.decide(request({ action: 'EraseText', control: { label: '密码' } })).needsConfirmation, true);
    assert.equal(p.decide(request({ action: 'EraseAccount' })).needsConfirmation, true);
});

test('public ui-graph arrays may carry hidden circular provenance without scanning it', () => {
    const controls = [{ label: '下一页' }];
    const hidden = [{ label: '发送' }];
    hidden.push(hidden);
    Object.defineProperties(controls, { matchingControls: { value: hidden }, evidenceControls: { value: hidden }, scopeControls: { value: hidden } });
    assert.equal(policy({}).decide(request({ controls })).allowed, true);
});

test('prototype and constructor proxy/getter impostors are rejected without execution', () => {
    let calls = 0;
    const prototype = Object.create(null);
    Object.defineProperty(prototype, 'constructor', { get() { calls++; return Object; } });
    const proxyPrototype = new Proxy({}, { getPrototypeOf() { calls++; return null; } });
    for (const input of [Object.create(prototype), Object.create(proxyPrototype)]) {
        assert.equal(policy(input).decide(request()).code, 'POLICY_CONFIG_INVALID');
    }
    assert.equal(calls, 0);
});

test('stock SearchView submit is a query, but its id does not launder other submit labels', () => {
    const go = 'io.legado.app.release:id/search_go_btn';
    assert.equal(classifyRisk({ id: go, desc: '提交查询' }).sensitive, false);
    assert.equal(classifyRisk({ id: go, label: 'Submit query' }).sensitive, false);
    assert.deepEqual(classifyRisk({ id: go, desc: '提交订单' }).categories, ['communication']);
    assert.deepEqual(classifyRisk({ id: 'com.demo:id/go', desc: '提交查询' }).categories, ['communication']);
});
