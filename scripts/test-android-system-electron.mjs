import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
const root = process.cwd();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-system-e2e-'));
const file = path.join(dir, 'settings.json');
await fs.writeFile(file, JSON.stringify({ uiMode: 'next', enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1', userName: 'System Test' }));
const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const executable = path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const childEnv = { ...process.env, VCPCHAT_APP_DATA_DIR: dir, VCPCHAT_E2E_TEST: '1' };
delete childEnv.ELECTRON_RUN_AS_NODE;
const launch = () => spawn(executable, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], { cwd: root, env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] });
let child = launch();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
    let page;
    async function connect() {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`Electron exit ${child.exitCode}`);
        try { await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/json/version`, res => { res.resume(); res.on('end', resolve); }).on('error', reject)); break; } catch { await pause(200); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    for (let attempt = 0; attempt < 100; attempt++) { page = (await browser.pages()).find(p => p.url().includes('main.html')); if (page) break; await pause(200); }
    assert.ok(page, 'main renderer'); await page.setViewport({ width: 1100, height: 900 });
    }
    async function restart() {
        browser?.disconnect();
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill(); await exited; child = launch(); page = null;
        await connect();
    }
    await connect();
    async function open() {
        await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: 90000 });
        await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
        await page.waitForSelector('#androidSystemDevice');
        await page.evaluate(() => {
            const nav = [...document.querySelectorAll('#globalSettingsModal .vcp-uiux-settings-nav-cell')].find(node => node.textContent.includes('Android'));
            if (!nav) throw new Error('Android category missing'); nav.click();
        });
        await page.waitForFunction(() => document.querySelector('#section-android-system')?.classList.contains('active'));
        await page.waitForFunction(() => Boolean(document.getElementById('globalSettingsModal')?.dataset.vcpSettingsRevision));
    }
    // 开关是宿主 Toggle 原语：input 视觉尺寸为 0，真实点击面是 label.switch
    // holder（与 Jev/外观分区的开关一致），因此按 holder 中心派发真实鼠标事件。
    async function clickToggle(id) {
        const point = await page.evaluate(targetId => {
            const holder = document.getElementById(targetId)?.closest('label.switch');
            if (!holder) return null;
            const rect = holder.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }, id);
        if (!point) throw new Error(`toggle holder missing: ${id}`);
        await page.mouse.click(point.x, point.y);
    }
    async function save() {
        await page.evaluate(() => document.getElementById('globalSettingsForm').requestSubmit());
        try { await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: 30000 }); }
        catch (error) {
            console.error('SAVE_DIAGNOSTICS', await page.evaluate(() => ({ state: document.getElementById('globalSettingsForm')?.dataset, invalid: [...document.querySelectorAll('#globalSettingsForm :invalid')].map(n => ({ id: n.id, type: n.type, message: n.validationMessage })), toasts: [...document.querySelectorAll('.vcp-ui-toast, .floating-toast-notification')].map(n => n.textContent) })));
            throw error;
        }
    }
    await open();
    assert.equal(await page.$eval('#androidSystemGrantRead', node => node.disabled), true);
    await page.type('#androidSystemDevice', 'E2E-DEVICE'); await page.keyboard.press('Tab');
    await clickToggle('androidSystemAcknowledge'); await clickToggle('androidSystemGrantRead');
    console.log('BEFORE_SAVE', await page.$eval('#androidSystemAuthorizations', node => node.value));
    await save();
    let saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.androidSystemAuthorizations['E2E-DEVICE'].grants.read, true);
    await restart(); await open();
    await page.type('#androidSystemDevice', 'E2E-DEVICE'); await page.keyboard.press('Tab');
    assert.equal(await page.$eval('#androidSystemGrantRead', node => node.checked), true);
    await page.screenshot({ path: path.join(root, '.workbuddy/android-system-electron.png'), fullPage: true });
    await page.locator('#androidSystemRevoke').click(); await save();
    saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.androidSystemAuthorizations['E2E-DEVICE'].acknowledged, false);
    assert.equal(saved.androidSystemAuthorizations['E2E-DEVICE'].grants.read, false);
    await restart(); await open();
    await page.type('#androidSystemDevice', 'E2E-DEVICE'); await page.keyboard.press('Tab');
    assert.equal(await page.$eval('#androidSystemGrantRead', node => node.checked), false);
    assert.equal(await page.$eval('#androidSystemAcknowledge', node => node.checked), false);
    console.log('PASS Electron: actual category, default deny, grant, IPC durable save, process restart grant projection, revoke durable save, process restart deny.');
} catch (error) {
    console.error(error.stack, error.cause);
    if (browser) { const pages = await browser.pages(); const main = pages.find(p => p.url().includes('main.html')); if (main) console.error('UI_DIAGNOSTICS', await main.evaluate(() => ({ device: document.getElementById('androidSystemDevice')?.value, ack: { disabled: document.getElementById('androidSystemAcknowledge')?.disabled, checked: document.getElementById('androidSystemAcknowledge')?.checked }, read: { disabled: document.getElementById('androidSystemGrantRead')?.disabled, checked: document.getElementById('androidSystemGrantRead')?.checked }, map: document.getElementById('androidSystemAuthorizations')?.value, status: document.querySelector('#section-android-system [role=status]')?.textContent })) ); }
    process.exitCode = 1;
}
finally { browser?.disconnect(); child.kill(); await pause(300); if (child.exitCode === null) child.kill('SIGKILL'); }
