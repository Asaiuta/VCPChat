'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '..');
(async () => {
    const browser = await puppeteer.launch({ headless: true, ...(process.env.SYSTEM_UI_BROWSER ? { executablePath: process.env.SYSTEM_UI_BROWSER } : {}) });
    try {
        const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 900 });
        await page.setRequestInterception(true);
        page.on('request', async request => {
            const url = new URL(request.url());
            if (url.hostname !== 'fixture.local') return request.abort();
            if (url.pathname === '/') return request.respond({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Android 系统授权</title><body><form id="form"></form><script type="module">import { buildAndroidSystemSettings } from "/modules/settings/schema/android-system.js"; document.querySelector("form").append(buildAndroidSystemSettings(document));window.ready=true;</script></body></html>' });
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!file.startsWith(root + path.sep)) return request.abort();
            try { await request.respond({ contentType: 'text/javascript', body: await fs.readFile(file, 'utf8') }); } catch { await request.respond({ status: 404, body: '' }); }
        });
        await page.goto('http://fixture.local/', { waitUntil: 'networkidle0' }); await page.waitForFunction('window.ready === true');
        assert.equal(await page.$eval('#androidSystemGrantRead', node => node.disabled), true);
        await page.type('#androidSystemDevice', 'UI-TEST-DEVICE'); await page.keyboard.press('Tab'); await page.locator('#androidSystemAcknowledge').click();
        await page.locator('#androidSystemGrantRead').click();
        const read = await page.$eval('#androidSystemAuthorizations', node => JSON.parse(node.value)['UI-TEST-DEVICE']);
        assert.equal(read.grants.read, true);
        await page.locator('#androidSystemRevoke').click();
        assert.equal(await page.$eval('#androidSystemGrantRead', node => node.checked), false);
        const revoked = await page.$eval('#androidSystemAuthorizations', node => JSON.parse(node.value)['UI-TEST-DEVICE']);
        assert.equal(revoked.acknowledged, false); assert.equal(revoked.grants.read, false);
        await page.screenshot({ path: path.join(root, '.workbuddy/android-system-ui.png'), fullPage: true });
        console.log('Chromium: default-deny, identity, acknowledge, grant, revoke passed; no persistent settings changed.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
