import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { androidSystemSection, buildAndroidSystemSettings } from '../modules/settings/schema/android-system.js';
import { applySettings, collectSettings } from '../modules/settings/value-semantics.js';
const require = createRequire(import.meta.url);
const SettingsManager = require('../modules/utils/appSettingsManager');
const { AndroidSystemAuthorization } = require('../modules/services/androidSystemAuthorization');
test('explicit deny survives durable merge and old backup never authorizes unreadable primary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-system-grants-'));
    try {
        const file = path.join(dir, 'settings.json'), granted = { androidSystemAuthorizations: { A: { version: 1, acknowledged: true, grants: { read: true, settings: true } } } };
        await fs.writeFile(file, JSON.stringify(granted));
        const manager = new SettingsManager(file), authority = new AndroidSystemAuthorization({ settingsManager: manager });
        await authority.assertAllowed('A', 'read');
        const dom = new JSDOM('<form></form>'), doc = dom.window.document, form = doc.querySelector('form');
        form.append(buildAndroidSystemSettings(doc)); applySettings([androidSystemSection], form, granted);
        const serial = doc.getElementById('androidSystemDevice'); serial.value = 'A'; serial.dispatchEvent(new dom.window.Event('change'));
        doc.getElementById('androidSystemRevoke').click();
        const patch = collectSettings([androidSystemSection], { form });
        const result = await manager.updateSettings(patch); assert.equal(result.success, true);
        await assert.rejects(authority.assertAllowed('A', 'read'), { code: 'SYSTEM_NOT_AUTHORIZED' });
        const persisted = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(persisted.androidSystemAuthorizations.A.grants.settings, false);
        await fs.writeFile(manager.backupPath, JSON.stringify(granted)); await fs.writeFile(file, '{corrupted');
        await assert.rejects(authority.assertAllowed('A', 'read'), { code: 'SYSTEM_NOT_AUTHORIZED' });
        dom.window.close();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
