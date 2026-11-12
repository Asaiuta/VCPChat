import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildAndroidSystemSettings, androidSystemSection } from '../modules/settings/schema/android-system.js';
import { applySettings, collectSettings } from '../modules/settings/value-semantics.js';
function fixture() { const dom = new JSDOM('<form></form>'); const form = dom.window.document.querySelector('form'); form.append(buildAndroidSystemSettings(dom.window.document)); return { dom, form, node: form, doc: dom.window.document }; }
function change(f, id, value) { const el = f.doc.getElementById(id); if (el.type === 'checkbox') el.checked = value; else el.value = value; el.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); }
const ROW_CONTROL_IDS = ['androidSystemDevice', 'androidSystemAcknowledge', 'androidSystemGrantRead', 'androidSystemGrantNavigate', 'androidSystemGrantSettings', 'androidSystemGrantPersonal', 'androidSystemGrantCommunication', 'androidSystemGrantSchedule', 'androidSystemRevoke'];
test('defaults deny and new devices never inherit another device grants', () => {
    const f = fixture(); change(f, 'androidSystemDevice', 'A');
    assert.equal(f.doc.getElementById('androidSystemGrantRead').disabled, true);
    change(f, 'androidSystemAcknowledge', true); change(f, 'androidSystemGrantRead', true);
    let map = JSON.parse(f.doc.getElementById('androidSystemAuthorizations').value);
    assert.equal(map.A.grants.read, true); assert.equal(map.A.version, 1);
    change(f, 'androidSystemDevice', 'B'); assert.equal(f.doc.getElementById('androidSystemGrantRead').checked, false);
    change(f, 'androidSystemDevice', 'A'); assert.equal(f.doc.getElementById('androidSystemGrantRead').checked, true);
});
test('restored payload projects controls and revocation removes all device grants', () => {
    const f = fixture(), store = f.doc.getElementById('androidSystemAuthorizations');
    store.value = JSON.stringify({ A: { version: 1, acknowledged: true, grants: { read: true, settings: true } } });
    store.dispatchEvent(new f.dom.window.CustomEvent('vcp-uiux-sync'));
    change(f, 'androidSystemDevice', 'A'); assert.equal(f.doc.getElementById('androidSystemGrantRead').checked, true);
    f.doc.getElementById('androidSystemRevoke').click();
    const revoked = JSON.parse(store.value).A;
    assert.equal(revoked.acknowledged, false); assert.equal(revoked.grants.read, false); assert.equal(revoked.grants.settings, false);
    assert.equal(f.doc.getElementById('androidSystemGrantRead').checked, false);
});
test('invalid serial and outdated consent cannot enable grants; personal/communication not yet available stay disabled', () => {
    const f = fixture(); change(f, 'androidSystemDevice', '__proto__'); change(f, 'androidSystemAcknowledge', true);
    assert.equal(f.doc.getElementById('androidSystemGrantRead').disabled, true);
    assert.equal(f.doc.getElementById('androidSystemGrantPersonal').disabled, true);
    assert.equal(f.doc.getElementById('androidSystemGrantCommunication').disabled, true);
});


test('canonical settings value pipeline round-trips per-device object rather than object-string', () => {
    const f = fixture(), form = f.doc.querySelector('form');
    const original = { A: { version: 1, acknowledged: true, grants: { read: true } } };
    applySettings([androidSystemSection], form, { androidSystemAuthorizations: original });
    change(f, 'androidSystemDevice', 'A');
    assert.equal(f.doc.getElementById('androidSystemGrantRead').checked, true);
    assert.deepEqual(collectSettings([androidSystemSection], { form }).androidSystemAuthorizations, original);
});

test('partial snapshot does not erase already projected grants', () => {
    const f = fixture(), form = f.doc.querySelector('form');
    const original = { A: { version: 1, acknowledged: true, grants: { read: true } } };
    applySettings([androidSystemSection], form, { androidSystemAuthorizations: original });
    applySettings([androidSystemSection], form, { userName: 'unrelated' });
    assert.deepEqual(collectSettings([androidSystemSection], { form }).androidSystemAuthorizations, original);
});

test('risk disclosure explains remote caller and downstream application trust boundaries', () => {
    const f = fixture(), text = f.doc.body.textContent;
    assert.match(text, /服务器/); assert.match(text, /Agent/); assert.match(text, /第三方/);
    assert.match(text, /不保证/);
});

test('interaction policy is disclosed as plugin config, never a fake global authorization switch', () => {
    const f = fixture();
    assert.match(f.doc.body.textContent, /包策略/);
    assert.match(f.doc.body.textContent, /插件配置/);
    assert.match(f.doc.body.textContent, /系统授权不替代包策略/);
    assert.match(f.doc.body.textContent, /模型自批无效/);
    assert.equal(f.doc.getElementById('INTERACTION_POLICY'), null);
    assert.deepEqual(Object.keys(collectSettings([androidSystemSection], { form: f.form })), ['androidSystemAuthorizations']);
});

test('identity selection is transient and does not trigger global autosave', () => {
    const f = fixture(), form = f.doc.querySelector('form'), serial = f.doc.getElementById('androidSystemDevice');
    let changes = 0; form.addEventListener('input', () => changes++); form.addEventListener('change', () => changes++);
    serial.value = 'A'; serial.dispatchEvent(new f.doc.defaultView.Event('input', { bubbles: true })); serial.dispatchEvent(new f.doc.defaultView.Event('change', { bubbles: true }));
    assert.equal(changes, 0); assert.equal(f.doc.getElementById('androidSystemAcknowledge').disabled, false);
});

// ── 呈现契约：与宿主设置语言同构（卡片分组 / Toggle 原语 / canonical 行 / 无散文）
test('panel is grouped into host settings cards, not a flat field list', () => {
    const f = fixture(), cards = [...f.doc.querySelectorAll('.vcp-settings-card')];
    assert.ok(cards.length >= 2, `expected grouped cards, got ${cards.length}`);
    for (const card of cards) {
        assert.ok(card.querySelector('.vcp-settings-card-title')?.textContent.trim(), 'card has a title');
        assert.ok(card.querySelector('.vcp-settings-card-description')?.textContent.trim(), 'card has a description');
        assert.ok(card.querySelector('.vcp-settings-card-body'), 'card has a body');
        assert.ok(card.querySelector('.vcp-settings-card-toggle'), 'card head is collapsible');
    }
    for (const id of ROW_CONTROL_IDS) {
        const control = f.doc.getElementById(id);
        assert.ok(control, `${id} exists`);
        assert.ok(control.closest('.vcp-settings-card-body'), `${id} lives inside a card body`);
    }
});

test('boolean controls use the host Toggle primitive instead of a bare checkbox', () => {
    const f = fixture();
    for (const id of ['androidSystemAcknowledge', 'androidSystemGrantRead', 'androidSystemGrantSchedule']) {
        const input = f.doc.getElementById(id);
        assert.equal(input.type, 'checkbox');
        assert.equal(input.parentElement.className, 'vcp-uiux-toggle', `${id} is wrapped by the Toggle primitive`);
        assert.equal(input.parentElement.parentElement.className, 'switch', `${id} keeps the host switch holder`);
        assert.equal(input.closest('.vcp-uiux-row-copy'), null, `${id} is not swallowed by the copy slot`);
    }
});

test('every control sits in a canonical row owned by this section', () => {
    const f = fixture();
    for (const id of ROW_CONTROL_IDS) {
        const row = f.doc.getElementById(id).closest('.vcp-uiux-general-row');
        assert.ok(row, `${id} has a canonical row`);
        assert.equal(row.dataset.settingsSectionKey, 'android-system');
        assert.equal(row.dataset.settingKey, id);
        // 宿主两种既有 copy 形态：canonical copy 槽，或开关行 label+hint 的裸包裹 div。
        assert.ok(
            row.querySelector(':scope > .vcp-uiux-row-copy, :scope > div:not([class])'),
            `${id} row keeps the host copy column`,
        );
    }
});

test('panel chrome carries no prose blocks', () => {
    const f = fixture(), walker = f.doc.createTreeWalker(f.doc.querySelector('form'), f.dom.window.NodeFilter.SHOW_TEXT);
    const long = [];
    while (walker.nextNode()) {
        const text = (walker.currentNode.nodeValue || '').replace(/\s+/g, '');
        if (text.length > 40) long.push(text);
    }
    assert.deepEqual(long, [], `prose leaked into the panel: ${long.join(' | ')}`);
});

test('device status reports the current value only', () => {
    const f = fixture(), status = f.doc.querySelector('[role="status"]');
    assert.ok(status, 'status node exists');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.ok(status.textContent.length <= 24, `status is a value, not an explanation: ${status.textContent}`);
    change(f, 'androidSystemDevice', 'UI-TEST-DEVICE');
    assert.match(status.textContent, /UI-TEST-DEVICE/);
    assert.ok(status.textContent.length <= 24, status.textContent);
});