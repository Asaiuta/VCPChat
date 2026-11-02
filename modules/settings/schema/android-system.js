// schema/android-system — “Android 系统授权”分区。
//
// 呈现遵循宿主设置语言：分组走 settings card，布尔控件走 Toggle 原语，
// 每行由 field-renderer 直出 canonical 行。面板自身只负责“设备身份 → 授权
// 投影”这段业务逻辑，因此整体是一个 custom 组件；组件内部逐行调用
// renderSchemaField，行结构与其它分区逐属性同构（不手写行类名）。
//
// 文案只放标签、当前值、控件与状态；风险边界写成卡片描述与行内提示，
// 不把机制论证铺在界面上。
import { section, card, custom, text, switchField } from './kernel.js';
import { renderSchemaField } from '../render/field-renderer.js';

const VERSION = 1;
const SECTION_KEY = 'android-system';
const CANONICAL_CONTEXT = Object.freeze({ sectionKey: SECTION_KEY });

// key → [控件后缀, 标题, 行内提示, 是否可用]
const GROUPS = [
    ['read', 'Read', '系统状态读取', '电量、型号、系统版本与固定设置值。', true],
    ['navigate', 'Navigate', '系统页面导航', '打开固定设置页或闹钟列表；不自动点击授权、发送或删除。', true],
    ['settings', 'Settings', '可逆系统设置', '改自动亮度、息屏与旋转；先读旧值再写入核验。', true],
    ['personal', 'Personal', '联系人编辑草稿', '仅打开预填姓名电话的编辑页；不读取通讯录。', true],
    ['communication', 'Communication', '通信草稿', '仅打开拨号页或短信草稿；发送由你逐次操作。', true],
    ['schedule', 'Schedule', '日程编辑草稿', '仅打开预填日程的编辑页；不自动创建或响铃。', true],
];

const STATUS_EMPTY = '未填写序列号';
const STATUS_PENDING = ' · 未确认';

function validSerial(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,159}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
}

function deniedRecord() {
    return { version: VERSION, acknowledged: false, grants: Object.fromEntries(GROUPS.map(([key]) => [key, false])) };
}

// 面板状态：授权 Map 是唯一持久事实；控件引用随分区挂载一次性登记。
function createPanel(doc) {
    const panel = { map: {}, store: null, device: null, ack: null, status: null, revoke: null, grants: new Map() };

    panel.persist = () => {
        panel.store.value = JSON.stringify(panel.map);
        panel.store.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
        panel.project();
    };

    panel.project = () => {
        const serial = panel.device.value.trim();
        const valid = validSerial(serial);
        const record = valid && Object.hasOwn(panel.map, serial) ? panel.map[serial] : null;
        panel.ack.checked = record?.version === VERSION && record?.acknowledged === true;
        panel.ack.disabled = !valid;
        for (const [key, { input, available }] of panel.grants) {
            input.checked = panel.ack.checked && record?.grants?.[key] === true;
            input.disabled = !valid || !panel.ack.checked || !available;
        }
        panel.revoke.disabled = !valid || !record;
        panel.status.textContent = !valid
            ? STATUS_EMPTY
            : `已选 ${serial}${panel.ack.checked ? '' : STATUS_PENDING}`;
    };

    return panel;
}

function buildDevicePanel(doc, panel) {
    const fragment = doc.createDocumentFragment();
    const deviceRow = renderSchemaField(doc, text('androidSystemDevice', {
        label: '设备序列号',
        placeholder: 'ListDevices 返回的完整 serial',
        stacked: true,
        maxLength: 160,
        hint: STATUS_EMPTY,
    }), CANONICAL_CONTEXT);
    const device = deviceRow.querySelector('input');
    const status = deviceRow.querySelector('small');
    status.id = 'androidSystemStatus';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    device.setAttribute('aria-describedby', status.id);
    // 设备身份只切换本地面板视图；只有序列化后的授权 Map 才是持久值。
    device.addEventListener('input', event => event.stopPropagation());
    device.addEventListener('change', event => { event.stopPropagation(); panel.project(); });

    const ackRow = renderSchemaField(doc, switchField('androidSystemAcknowledge', {
        label: '我已理解风险，仅授权此设备',
        hint: '已连接主服务器的 Agent 可调用；不按调用者隔离。',
        hintInsideWrapper: true,
    }), CANONICAL_CONTEXT);
    const ack = ackRow.querySelector('input');
    ack.addEventListener('change', () => {
        const serial = device.value.trim();
        if (!validSerial(serial)) { panel.project(); return; }
        panel.map[serial] = { ...deniedRecord(), acknowledged: ack.checked };
        panel.persist();
    });

    fragment.append(deviceRow, ackRow);
    panel.device = device;
    panel.ack = ack;
    panel.status = status;
    return fragment;
}

function buildGrantPanel(doc, panel) {
    const fragment = doc.createDocumentFragment();
    for (const [key, suffix, title, hint, available] of GROUPS) {
        const id = `androidSystemGrant${suffix}`;
        const row = renderSchemaField(doc, switchField(id, { label: title, hint, hintInsideWrapper: true }), CANONICAL_CONTEXT);
        const input = row.querySelector('input');
        input.addEventListener('change', () => {
            const serial = panel.device.value.trim();
            const record = Object.hasOwn(panel.map, serial) ? panel.map[serial] : null;
            if (!validSerial(serial) || !available || record?.version !== VERSION || record?.acknowledged !== true) { panel.project(); return; }
            record.grants = { ...record.grants, [key]: input.checked === true };
            panel.persist();
        });
        panel.grants.set(key, { input, available });
        fragment.append(row);
    }
    fragment.append(buildRevokeRow(doc, panel));
    return fragment;
}

// 撤销是行内动作而不是独立按钮：标题 + 提示 + 行尾按钮，与其它设置行同构。
function buildRevokeRow(doc, panel) {
    const row = doc.createElement('div');
    row.className = 'vcp-uiux-general-item vcp-uiux-general-row';
    row.dataset.settingPrimitive = 'general-item';
    row.dataset.settingsSectionKey = SECTION_KEY;
    row.dataset.settingKey = 'androidSystemRevoke';
    row.dataset.canonicalRow = 'true';
    const copy = doc.createElement('div');
    copy.className = 'vcp-uiux-row-copy';
    copy.dataset.settingPrimitive = 'row-copy';
    const label = doc.createElement('label');
    label.id = 'androidSystemRevokeLabel';
    label.textContent = '撤销此设备授权';
    const hint = doc.createElement('small');
    hint.textContent = '清空全部能力与风险确认，保存后生效。';
    copy.append(label, hint);
    const revoke = doc.createElement('button');
    revoke.type = 'button';
    revoke.id = 'androidSystemRevoke';
    revoke.className = 'small-button';
    revoke.textContent = '撤销';
    revoke.setAttribute('aria-labelledby', label.id);
    revoke.addEventListener('click', () => {
        const serial = panel.device.value.trim();
        if (!validSerial(serial)) return;
        panel.map[serial] = deniedRecord();
        panel.persist();
    });
    row.append(copy, revoke);
    panel.revoke = revoke;
    return row;
}

export function buildAndroidSystemSettings(doc) {
    const panel = createPanel(doc);
    const store = doc.createElement('input');
    store.type = 'hidden';
    store.id = store.name = 'androidSystemAuthorizations';
    store.value = '{}';
    store.addEventListener('vcp-uiux-sync', () => {
        try {
            const parsed = JSON.parse(store.value);
            panel.map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch { panel.map = {}; }
        panel.project();
    });
    panel.store = store;

    const fragment = doc.createDocumentFragment();
    fragment.append(
        store,
        renderSchemaField(doc, card('androidDeviceCard', {
            cardKey: 'android-device',
            title: '当前设备',
            description: '仅管理本机已配对的手机；此页授权不等于 Android 系统权限。',
            fields: [custom('androidDevicePanel', inner => buildDevicePanel(inner, panel))],
        }), CANONICAL_CONTEXT),
        renderSchemaField(doc, card('androidGrantCard', {
            cardKey: 'android-grants',
            title: '能力授权',
            description: '草稿可能交由第三方应用处理；本插件不保证其不保存或发送。',
            fields: [custom('androidGrantPanel', inner => buildGrantPanel(inner, panel))],
        }), CANONICAL_CONTEXT),
    );
    panel.project();
    return fragment;
}

export const androidSystemSection = section('android-system', 'Android 系统授权', [
    custom('androidSystemPermissionPanel', buildAndroidSystemSettings, ['androidSystemAuthorizations'], {
        saveMap: { androidSystemAuthorizations: {
            serialize(value) { return JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? value : {}); },
            transform(value) { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } },
        } },
    }),
]);
