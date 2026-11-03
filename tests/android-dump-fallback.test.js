'use strict';

/**
 * 控件树采集的失败分类与回退策略契约。
 *
 * 真机事实（PJZ110，2026-11-02，逐阶段剖析）：
 *   主路径 `exec-out uiautomator dump --compressed /dev/tty` 在动画密集页面
 *   （bilibili 视频详情、闲鱼列表）会输出 "ERROR: could not get idle state."
 *   —— uiautomator 等界面 idle 直到超时（实测 11.1–12.0s）。
 *
 *   而旧实现的回退路径 `shell uiautomator dump <file>` 走的是同一个
 *   uiautomator，会再卡一次同样的 11 秒。剖析日志里轮 2/4/5 的两次
 *   uiautomator 调用全部失败，Observe 因此从 2.4s 膨胀到 22.8s。
 *
 * 契约：
 *   1. idle 超时属于「瞬态」失败，必须重试主路径，不得直接回退到同源的 file 路径。
 *   2. 只有「主路径不可用」类失败（/dev/tty 不可写、--compressed 不支持）
 *      才回退 file 路径 —— 那才是 fallback 存在的理由。
 *   3. 两种情况都失败时，报出可诊断的错误，而不是把 11 秒超时伪装成普通失败。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SERVICE = path.resolve(__dirname, '../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js');
const source = fs.readFileSync(SERVICE, 'utf8');

test('idle 超时被识别为独立失败类型，而非普通空结果', () => {
    // 实现必须显式区分 idle 超时。只靠「没拿到 XML」无法区分
    // 「/dev/tty 不可用」和「界面一直在动」。
    assert.match(source, /could not get idle state/i,
        '实现必须识别 uiautomator 的 idle 超时输出');
});

test('idle 超时时重试主路径，而不是立刻退回同源的 file 路径', () => {
    const fn = /async function dumpUi[\s\S]*?\n}/.exec(source);
    assert.ok(fn, 'dumpUi 必须存在');
    const body = fn[0];
    // 找到 idle 分支，确认它在回退前先做了一次主路径重试
    const idleAt = body.search(/could not get idle state/i);
    assert.ok(idleAt > 0, 'idle 分支必须存在于 dumpUi 内');
    const fallbackAt = body.search(/\/data\/local\/tmp\/vcp_ui_dump\.xml/);
    assert.ok(fallbackAt > idleAt, 'file 回退必须排在 idle 处理之后');
    const idleSection = body.slice(idleAt, fallbackAt > 0 ? fallbackAt : body.length);
    assert.match(idleSection, /retry|重试|再次/i,
        'idle 超时分支必须有一次主路径重试，不能直接落到 file 路径');
});

test('非 idle 失败仍然回退 file 路径（老设备 /dev/tty 不可用）', () => {
    assert.match(source, /data\/local\/tmp\/vcp_ui_dump\.xml/,
        'file 回退路径必须保留，否则老设备无法采集');
});

test('采集失败的错误信息必须点明 idle 超时，便于区分设备卡顿与实现缺陷', () => {
    const fn = /async function dumpUi[\s\S]*?\n}/.exec(source);
    const body = fn ? fn[0] : '';
    // 错误提示里要出现「界面」「变化」之类的可操作描述
    assert.match(body, /idle|界面|动画/,
        '错误信息必须解释 idle 超时的成因');
});
