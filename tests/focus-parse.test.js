'use strict';

/**
 * currentFocus 解析契约。
 *
 * 真机踩到：dumpsys window displays 里 mCurrentFocus / mFocusedApp
 * 每个 display 都会出现一次，第一条常常是 null 或过期值。
 * 旧实现取第一条，导致「计算器已在前台」被误判成「前台是桌面」，
 * LaunchApp 于是谎报启动成功（或谎报失败）。
 */

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { AdbClient } = require(path.join(root, 'VCPDistributedServer/Plugin/AndroidController/lib/adb'));

/** 造一个只回固定 dumpsys 文本的 client */
function clientWith(text) {
    const client = new AdbClient({ adbPath: 'adb' });
    client.runText = async () => text;
    return client;
}

test('多条 mCurrentFocus：取最后一条（计算器真的在前台）', async () => {
    const text = [
        '  Display: mDisplayId=0',
        '    mCurrentFocus=null',
        '    mFocusedApp=ActivityRecord{30226813 u0 com.android.launcher/.Launcher t2}',
        '  Display: mDisplayId=1',
        '    mCurrentFocus=Window{d75cf0d u0 com.coloros.calculator/com.android.calculator2.Calculator}',
        '    mFocusedApp=ActivityRecord{149425502 u0 com.coloros.calculator/com.android.calculator2.Calculator t48935}',
    ].join('\n');

    const focus = await clientWith(text).currentFocus();
    assert.equal(focus.package, 'com.coloros.calculator', `实际拿到 ${focus.package}`);
    assert.match(focus.component, /com\.coloros\.calculator/);
});

test('第一条是 null 时，不能返回 null 当结果', async () => {
    const text = [
        '    mCurrentFocus=null',
        '    mFocusedApp=ActivityRecord{1 u0 com.android.settings/.Settings t1}',
    ].join('\n');

    const focus = await clientWith(text).currentFocus();
    assert.equal(focus.package, 'com.android.settings');
});

test('真的没有焦点时如实返回 null', async () => {
    const text = [
        '    mCurrentFocus=null',
        '    mFocusedApp=null',
    ].join('\n');

    const focus = await clientWith(text).currentFocus();
    assert.equal(focus.package, null);
    assert.equal(focus.window, null);
    assert.equal(focus.component, null);
});

test('锁屏界面能识别', async () => {
    const text = [
        '    mCurrentFocus=Window{aaa u0 com.android.systemui/com.android.systemui.keyguard.KeyguardView}',
        '    mFocusedApp=ActivityRecord{bbb u0 com.android.systemui/.keyguard.KeyguardView t1}',
    ].join('\n');
    const focus = await clientWith(text).currentFocus();
    assert.match(focus.package, /systemui/);
});
