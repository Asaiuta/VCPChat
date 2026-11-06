'use strict';

const fail = (code, message) => Object.assign(new Error(message), { code });
const integer = (min, max) => text => {
    if (!/^-?\d+$/.test(text)) throw fail('INVALID_RESPONSE', '系统返回的数值无效。');
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('INVALID_RESPONSE', '系统返回的数值越界。');
    return value;
};
const textValue = text => {
    if (!text || text.length > 160 || /[\x00-\x1f]/.test(text)) throw fail('INVALID_RESPONSE', '系统返回的文本无效。');
    return text;
};
const reads = {
    timeZone: [['getprop', 'persist.sys.timezone'], text => {
        if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){0,3}$/.test(text) || text.length > 100) throw fail('INVALID_RESPONSE', '系统时区无效。');
        try { new Intl.DateTimeFormat('en', { timeZone: text }); } catch { throw fail('INVALID_RESPONSE', '系统时区不受识别。'); }
        return text;
    }],
    automaticTime: [['settings', 'get', 'global', 'auto_time'], integer(0, 1)],
    automaticTimeZone: [['settings', 'get', 'global', 'auto_time_zone'], integer(0, 1)],
    batteryLevel: [['cmd', 'battery', 'get', 'level'], integer(0, 100)],
    batteryStatus: [['cmd', 'battery', 'get', 'status'], integer(1, 5)],
    manufacturer: [['getprop', 'ro.product.manufacturer'], textValue],
    model: [['getprop', 'ro.product.model'], textValue],
    androidVersion: [['getprop', 'ro.build.version.release'], textValue],
    apiLevel: [['getprop', 'ro.build.version.sdk'], integer(1, 100)],
    securityPatch: [['getprop', 'ro.build.version.security_patch'], textValue],
    brightness: [['settings', 'get', 'system', 'screen_brightness'], integer(0, 100000)],
    wifiEnabled: [['settings', 'get', 'global', 'wifi_on'], integer(0, 3)],
    bluetoothEnabled: [['settings', 'get', 'global', 'bluetooth_on'], integer(0, 3)],
    airplaneMode: [['settings', 'get', 'global', 'airplane_mode_on'], integer(0, 1)],
};
const settings = {
    brightnessMode: { key: 'screen_brightness_mode', min: 0, max: 1 },
    screenTimeout: { key: 'screen_off_timeout', min: 15000, max: 1800000 },
    autoRotate: { key: 'accelerometer_rotation', min: 0, max: 1 },
    userRotation: { key: 'user_rotation', min: 0, max: 3 },
};
for (const [id, rule] of Object.entries(settings)) {
    reads[id] = [['settings', '--user', '0', 'get', 'system', rule.key], integer(id === 'screenTimeout' ? 0 : rule.min, id === 'screenTimeout' ? 2147483647 : rule.max)];
}
const pages = {
    settings: 'android.settings.SETTINGS', wifi: 'android.settings.WIFI_SETTINGS',
    bluetooth: 'android.settings.BLUETOOTH_SETTINGS', display: 'android.settings.DISPLAY_SETTINGS',
    sound: 'android.settings.SOUND_SETTINGS', storage: 'android.settings.INTERNAL_STORAGE_SETTINGS',
    battery: 'android.settings.BATTERY_SAVER_SETTINGS', location: 'android.settings.LOCATION_SOURCE_SETTINGS',
    dateTime: 'android.settings.DATE_SETTINGS', language: 'android.settings.LOCALE_SETTINGS',
    inputMethod: 'android.settings.INPUT_METHOD_SETTINGS', accessibility: 'android.settings.ACCESSIBILITY_SETTINGS',
    privacy: 'android.settings.PRIVACY_SETTINGS', security: 'android.settings.SECURITY_SETTINGS',
    applications: 'android.settings.APPLICATION_SETTINGS', notifications: 'android.settings.ALL_APPS_NOTIFICATION_SETTINGS',
    wireless: 'android.settings.WIRELESS_SETTINGS', nfc: 'android.settings.NFC_SETTINGS',
    cast: 'android.settings.CAST_SETTINGS', vpn: 'android.settings.VPN_SETTINGS',
    alarms: 'android.intent.action.SHOW_ALARMS',
    aboutDevice: 'android.settings.DEVICE_INFO_SETTINGS', airplane: 'android.settings.AIRPLANE_MODE_SETTINGS',
    dataUsage: 'android.settings.DATA_USAGE_SETTINGS', home: 'android.settings.HOME_SETTINGS',
    print: 'android.settings.ACTION_PRINT_SETTINGS', caption: 'android.settings.CAPTIONING_SETTINGS',
};
const drafts = { dial: 'communication', sms: 'communication', calendarEvent: 'schedule', contact: 'personal' };
function draftIntent(capability, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail('INVALID_ARGUMENT', '草稿必须提供 params 对象。');
    const allowed = { dial: ['phone'], sms: ['phone', 'body'], calendarEvent: ['title', 'begin', 'end'], contact: ['name', 'phone'] }[capability];
    if (Object.keys(params).some(key => !allowed.includes(key))) throw fail('INVALID_ARGUMENT', '草稿含未知字段。');
    const bounded = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
    if (['dial', 'sms', 'contact'].includes(capability) && (typeof params.phone !== 'string' || !/^\+?[0-9]{3,20}$/.test(params.phone))) throw fail('INVALID_ARGUMENT', '电话仅接受可选加号与3–20位数字，不支持USSD、分机或多接收人。');
    if (capability === 'dial') return ['-a', 'android.intent.action.DIAL', '-d', `tel:${params.phone}`];
    if (capability === 'sms') {
        if (!bounded(params.body, 2000)) throw fail('INVALID_ARGUMENT', '短信草稿正文必须为1–2000字符。');
        return ['-a', 'android.intent.action.SENDTO', '-d', `smsto:${params.phone}`, '--es', 'sms_body', params.body];
    }
    if (capability === 'contact') {
        if (!bounded(params.name, 120)) throw fail('INVALID_ARGUMENT', '联系人名称必须为1–120字符。');
        return ['-a', 'android.intent.action.INSERT', '-t', 'vnd.android.cursor.dir/contact', '--es', 'name', params.name, '--es', 'phone', params.phone];
    }
    if (!bounded(params.title, 200) || !Number.isSafeInteger(params.begin) || !Number.isSafeInteger(params.end)
        || params.begin < 946684800000 || params.end > 4102444800000 || params.end <= params.begin || params.end - params.begin > 366 * 86400000) throw fail('INVALID_ARGUMENT', '日程标题或起止时间无效；仅支持2000–2100年、最长366天。');
    return ['-a', 'android.intent.action.INSERT', '-t', 'vnd.android.cursor.dir/event', '--es', 'title', params.title, '--el', 'beginTime', String(params.begin), '--el', 'endTime', String(params.end)];
}
const catalog = Object.freeze([
    ...Object.entries(drafts).map(([id, group]) => Object.freeze({ id, group, operation: 'draft', requiresUserCompletion: true })),
    ...Object.keys(reads).map(id => Object.freeze({ id, operation: 'read', group: 'read' })),
    ...Object.entries(settings).map(([id, rule]) => Object.freeze({ id, operation: 'set', group: 'settings', min: rule.min, max: rule.max })),
    ...Object.keys(pages).map(id => Object.freeze({ id, operation: 'navigate', group: 'navigate' })),
]);
function validate(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail('INVALID_ARGUMENT', '系统请求必须为对象。');
    const allowed = ['serial', 'operation', 'capability', 'value', 'targetOperation', 'params'];
    if (Object.keys(request).some(key => !allowed.includes(key))) throw fail('INVALID_ARGUMENT', '系统请求含未知参数。');
    if (typeof request.serial !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,159}$/.test(request.serial)) throw fail('INVALID_ARGUMENT', '必须明确指定设备。');
    const { capability, value } = request;
    const operation = request.operation === 'probe' ? request.targetOperation : request.operation;
    if (request.operation !== 'probe' && request.targetOperation !== undefined) throw fail('INVALID_ARGUMENT', '仅探测接受 targetOperation。');
    if (request.operation === 'probe' && value !== undefined) throw fail('INVALID_ARGUMENT', '探测不接受写入值。');
    const map = operation === 'read' ? reads : operation === 'navigate' ? pages : operation === 'set' ? settings : operation === 'draft' && request.operation !== 'probe' ? drafts : {};
    if (typeof capability !== 'string' || !Object.hasOwn(map, capability)) throw fail('INVALID_ARGUMENT', '未知系统能力。');
    if (operation === 'draft') draftIntent(capability, request.params);
    else if (request.params !== undefined) throw fail('INVALID_ARGUMENT', '该操作不接受 params。');
    if (operation !== 'set' && value !== undefined) throw fail('INVALID_ARGUMENT', '该操作不接受 value。');
    if (operation === 'set' && request.operation !== 'probe') {
        const rule = settings[capability];
        if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max) throw fail('INVALID_ARGUMENT', '设置值越界或类型错误。');
    }
}
function checkOutput(text) {
    if (/permission\s*(?:denial|denied)|SecurityException|not allowed/i.test(text)) throw fail('PERMISSION_DENIED', 'Android 拒绝系统接口访问。');
    if (/unknown command|not found|unsupported|no activity found/i.test(text)) throw fail('UNSUPPORTED', '当前设备不支持该系统接口。');
    if (/^\s*(?:error|exception|failure)[:\s]/i.test(text)) throw fail('SYSTEM_ERROR', '系统接口返回错误。');
    return text;
}
async function executeSystemInternal(request, deps = {}) {
    validate(request);
    const { serial, operation, capability, value } = request;
    const group = operation === 'draft' ? drafts[capability] : operation === 'probe' ? 'read' : operation === 'set' ? 'settings' : operation === 'navigate' ? 'navigate' : 'read';
    const check = () => { if (deps.signal?.aborted) throw fail('ABORTED', '系统操作已取消；取消不代表已派发动作被回滚。'); };
    const authorize = async () => {
        check();
        if (typeof deps.authorize !== 'function') throw fail('SYSTEM_NOT_AUTHORIZED', '系统能力未配置可信授权服务。');
        await deps.authorize(serial, group); check();
    };
    const run = async tokens => {
        check();
        let response;
        try { response = await deps.run(tokens); }
        catch (error) { checkOutput(String(error.stderr || error.message || '')); throw error; }
        if (response && typeof response === 'object') checkOutput(String(response.stderr || '').trim());
        const output = String(response && typeof response === 'object' ? response.stdout ?? '' : response).trim();
        if (output.length > 16384) throw fail('INVALID_RESPONSE', '系统响应过大。');
        return checkOutput(output);
    };
    const dispatch = async tokens => {
        await authorize();
        if (typeof deps.beforeDispatch !== 'function') throw fail('INVALID_CONTEXT', '缺少受控变更入口。');
        await deps.beforeDispatch(tokens); check();
        return run(tokens);
    };
    const receipt = { serial, operation, capability, group };
    await authorize();
    if (operation === 'probe') {
        try {
            if (request.targetOperation === 'navigate') {
                const resolved = await run(['cmd', 'package', 'resolve-activity', '--brief', '-a', pages[capability]]);
                return { ...receipt, targetOperation: request.targetOperation, outcome: 'observed', support: /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/m.test(resolved) ? 'supported' : 'unsupported', businessWrites: 0 };
            }
            const [tokens, parse] = reads[capability];
            const observed = parse(await run(tokens));
            return { ...receipt, targetOperation: request.targetOperation, outcome: 'observed', support: request.targetOperation === 'set' ? 'unknown' : 'supported', readable: true, value: observed, businessWrites: 0 };
        } catch (error) {
            check();
            return { ...receipt, targetOperation: request.targetOperation, outcome: 'observed', support: error.code === 'PERMISSION_DENIED' ? 'permission-denied' : error.code === 'UNSUPPORTED' ? 'unsupported' : 'unknown', reason: error.code || 'PROBE_FAILED', businessWrites: 0 };
        }
    }
    if (operation === 'read') {
        const [tokens, parse] = reads[capability];
        return { ...receipt, outcome: 'observed', value: parse(await run(tokens)), businessWrites: 0 };
    }
    if (operation === 'draft') {
        const intent = draftIntent(capability, request.params);
        const resolved = await run(['cmd', 'package', 'resolve-activity', '--brief', '--user', '0', ...intent]);
        if (!/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/m.test(resolved)) throw fail('UNSUPPORTED', '没有支持该草稿的公开编辑器。');
        const component = resolved.split(/\r?\n/).find(line => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(line));
        await dispatch(['am', 'start', '-W', '--user', '0', '-n', component, ...intent]);
        return { ...receipt, outcome: 'dispatched', verified: false, requiresUserCompletion: true, businessWrites: null, downstreamBehaviorGuaranteed: false, privacy: 'content-redacted' };
    }
    if (operation === 'navigate') {
        const action = pages[capability];
        const resolved = await run(['cmd', 'package', 'resolve-activity', '--brief', '--user', '0', '-a', action]);
        if (!/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/m.test(resolved)) throw fail('UNSUPPORTED', '没有可处理该页面的公开组件。');
        const component = resolved.split(/\r?\n/).find(line => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(line));
        await dispatch(['am', 'start', '-W', '--user', '0', '-n', component, '-a', action]);
        return { ...receipt, outcome: 'dispatched', verified: false, businessWrites: 0 };
    }
    const [tokens, parse] = reads[capability];
    const before = parse(await run(tokens));
    if (before === value) return { ...receipt, before, after: before, changed: false, outcome: 'verified', businessWrites: 0 };
    let attempted = false;
    try {
        await authorize();
        if (typeof deps.beforeDispatch !== 'function') throw fail('INVALID_CONTEXT', '缺少受控变更入口。');
        await deps.beforeDispatch(); check(); attempted = true;
        await run(['settings', '--user', '0', 'put', 'system', settings[capability].key, String(value)]);
        const after = parse(await run(tokens));
        return { ...receipt, before, requested: value, after, changed: after !== before, writeAttempts: 1, outcome: after === value ? 'verified' : 'unknown' };
    } catch (error) {
        if (!attempted) throw error;
        return { ...receipt, before, requested: value, after: null, changed: null, writeAttempts: 1, outcome: 'unknown', verificationError: error.code || 'READBACK_FAILED' };
    }
}
async function executeSystem(request, deps = {}) {
    try { return await executeSystemInternal(request, deps); }
    catch (error) {
        if (request?.operation !== 'draft' || /^POLICY_/.test(error.code || '')) throw error;
        const safeCodes = new Set(['INVALID_ARGUMENT', 'SYSTEM_NOT_AUTHORIZED', 'PERMISSION_DENIED', 'UNSUPPORTED', 'UNSUPPORTED_USER', 'ABORTED', 'ADB_TIMEOUT', 'ADB_ERROR', 'INVALID_CONTEXT', 'INVALID_RESPONSE', 'SYSTEM_ERROR']);
        throw fail(safeCodes.has(error.code) ? error.code : 'DRAFT_FAILED', '草稿操作失败或结果未确认；未回传接收人或内容。已派发的动作不保证撤销，请先检查手机再重试。');
    }
}
module.exports = { catalog, executeSystem };
