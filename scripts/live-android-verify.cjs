'use strict';

/**
 * 真机端到端验证：走 AndroidControllerService 的真实工具调用路径。
 * 覆盖多个真实 App + 滚动重绑 + 稳定等待 + 错误路径。
 *
 * 用法：node scripts/live-android-verify.cjs [serial]
 * 需要设备已授权（USB 或无线调试）。不传 serial 则自动接管唯一在线设备。
 */

const path = require('node:path');

const SERVICE = path.join(
    __dirname, '..', 'VCPDistributedServer', 'Plugin', 'AndroidController', 'AndroidControllerService.js',
);
const service = require(SERVICE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
    if (cond) {
        pass += 1;
        log(`  ✔ ${name}${extra ? ` — ${extra}` : ''}`);
    } else {
        fail += 1;
        failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
        log(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
    }
}

async function call(args) {
    const t0 = Date.now();
    try {
        const r = await service.processToolCall(args);
        const execution = r.details?.execution;
        return { ok: !execution || ['observed', 'dispatched', 'verified'].includes(execution.outcome), ms: Date.now() - t0,
            text: r.content[0].text, d: r.details || {}, error: execution?.error?.message || execution?.error?.code };
    } catch (error) {
        return { ok: false, ms: Date.now() - t0, error: error.message };
    }
}
const observe = (a = {}) => call({ command: 'Observe', ...a });
const brief = (o) => (o.ok
    ? `控件 ${o.d.total} / ${Buffer.byteLength(o.text || '')}B / ${o.ms}ms / sig ${o.d.signature}`
    : `失败: ${o.error}`);

/**
 * 不能碰的控件：无线调试开关一关，adb 连接当场断，端口还会变。
 * 之前就是因为「取 y 最大的第一个可点条目」恰好选中它，把测试自己搞死了。
 */
const FORBIDDEN = /无线调试|Wi-?Fi|USB|关掉|停止|卸载|清除|重置|格式化|恢复出厂/i;

function safeToTap(control) {
    return !FORBIDDEN.test(control.label || '')
        && !FORBIDDEN.test(control.id || '')
        && !/switch|checkbox|check/i.test(control.role || '')
        && !control.flags.includes('check');
}

async function openApp(pkg, settleMs = 2600) {
    const r = await call({ command: 'ExecuteStep', action: { command: 'LaunchApp', package: pkg } });
    await sleep(settleMs);
    return r;
}

async function swipe(from, to) {
    const image = await call({ command: 'Observe', mode: 'image' });
    if (!image.ok) throw new Error(image.error || 'Image observation failed');
    const frame = image.d.image;
    const width = frame.mapping.screen.width, height = frame.mapping.screen.height;
    return call({ command: 'ExecuteStep', action: { command: 'Swipe', frameId: frame.frameId,
        x1: Math.floor(width / 2), y1: Math.floor(height * from),
        x2: Math.floor(width / 2), y2: Math.floor(height * to), duration: 300 } });
}

(async () => {
    await service.initialize({
        config: {
            ADB_PATH: process.env.ADB_PATH || 'adb',
            DEVICE_SERIAL: process.argv[2] || '',
        },
        logger: { log() {}, info() {}, warn() {}, error() {} },
    });

    log('\n=== 0. 设备 ===');
    const dev = await call({ command: 'Describe', topic: 'devices' });
    log(dev.ok ? dev.text.split('\n').slice(0, 3).join('\n') : dev.error);
    check('有在线设备', dev.ok);

    log('\n=== 1. 桌面：语义聚合 ===');
    await call({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'home' } });
    await sleep(1200);
    const home = await observe();
    log(brief(home));
    check('桌面可 Observe', home.ok && home.d.total > 5, home.error || '');
    check('图标带名称，不是裸容器', home.d.controls.filter((c) => c.label).length / home.d.total > 0.85);
    // 可点的 ImageView（如小组件）允许存在，但不允许拿占位词当名字
    check('无占位标签（Image/icon 之类）', !home.d.controls.some((c) =>
        /^(image|img|icon|button|view|widget)$/i.test(String(c.label || '').trim())));
    check('所有落点都在 bounds 内', home.d.controls.every((c) =>
        c.x >= c.bounds.left && c.x <= c.bounds.right && c.y >= c.bounds.top && c.y <= c.bounds.bottom));

    log('\n=== 2. 设置：导航 + 签名变化 ===');
    await openApp('com.android.settings');
    const s1 = await observe();
    log(brief(s1));
    log(s1.text.split('\n').slice(0, 14).join('\n'));
    check('设置页在前台', /com\.(android|oplus)\.settings/.test(s1.d.focus?.package || ''), s1.d.focus?.package);
    check('设置页有可点条目', s1.d.total > 5);

    const navItem = s1.d.controls.find((c) => c.role === 'button' && c.label && c.y > 500 && safeToTap(c));
    if (navItem) {
        log(`  目标条目：${navItem.label}  ${navItem.selector}  (${navItem.x},${navItem.y})`);
        const tap = await call({ command: 'ExecuteStep', action: { command: 'Tap', selector: navItem.selector } });
        check('Tap 按 selector 命中', tap.ok, tap.error || tap.text);
        await sleep(1600);
        const s2 = await observe();
        log(brief(s2));
        check('点击后仍能 Observe（连接没断）', s2.ok, s2.error || '');
        check('点击后页面签名变化', s2.ok && s2.d.changed === true, s2.ok ? `changed=${s2.d.changed}` : s2.error);
        check('页面内容确实换了（不是空表）', s2.ok && s2.d.total > 0);

        await call({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' } });
        await sleep(1500);
        const s3 = await observe();
        check('返回后回到原页签名', s3.d.signature === s1.d.signature, `${s3.d.signature} vs ${s1.d.signature}`);
        check('返回被识别为页面变化', s3.d.changed === true);
    } else {
        check('找到可导航条目', false);
    }

    log('\n=== 3. 微信聊天列表：聚合质量 ===');
    await openApp('com.tencent.mm', 3200);
    const w1 = await observe();
    log(brief(w1));
    check('微信在前台', /com\.tencent\.mm/.test(w1.d.focus?.package || ''), w1.d.focus?.package);
    const rows = (w1.d.controls || []).filter((c) => c.shortId === ':id/cj1');
    check('会话行被折叠成一个控件', rows.length >= 3, `${rows.length} 行 / 总 ${w1.d.total}`);
    check('每行都有非空标签', rows.length > 0 && rows.every((c) => c.label && c.label.trim()),
        rows.slice(0, 2).map((c) => c.label).join(' | '));
    check('标签含时间或日期', rows.some((c) => /\d{1,2}:\d{2}|昨天|周[一二三四五六日]|\d+月\d+日/.test(c.label)),
        rows.slice(0, 2).map((c) => c.label).join(' | '));
    check('底部 tab 四项齐全', ['微信', '通讯录', '发现', '我'].every((t) => w1.d.controls.some((c) => c.label === t)));
    check('无裸 ImageView', !w1.d.controls.some((c) => c.cls === 'ImageView'));
    check('原始节点 / 输出行数 > 3', w1.d.stats.rawNodes / Math.max(1, w1.d.total) > 3,
        `${w1.d.stats.rawNodes} → ${w1.d.total}（${(w1.d.stats.rawNodes / Math.max(1, w1.d.total)).toFixed(1)}×）`);

    log('\n=== 4. 滚动：index 失效 vs selector 重绑 ===');
    const targetRow = rows[2];
    if (targetRow) {
        log(`  滚动前第 3 行：${targetRow.label}  ${targetRow.selector}`);
        await swipe(0.8, 0.3);
        await sleep(1600);
        const w2 = await observe();
        log(brief(w2));
        check('滚动被识别为页面变化', w2.d.changed === true);
        const nowThird = (w2.d.controls || []).filter((c) => c.shortId === ':id/cj1')[2];
        check('同一 index 已不是同一行（index 不可靠）',
            !nowThird || nowThird.label !== targetRow.label,
            `现在 [2]=${nowThird ? nowThird.label : '(空)'}`);

        let rebound = (w2.d.controls || []).find((c) => c.selector === targetRow.selector);
        if (!rebound) {
            await swipe(0.3, 0.8);
            await sleep(1600);
            const w3 = await observe();
            rebound = (w3.d.controls || []).find((c) => c.selector === targetRow.selector);
        }
        check('selector 滚动后仍命中同一行', Boolean(rebound), rebound ? rebound.label : '(未命中)');
        if (rebound) check('重绑坐标来自新帧', rebound.y !== targetRow.y, `y ${targetRow.y} → ${rebound.y}`);
    } else {
        check('拿到第 3 行做滚动测试', false);
    }

    log('\n=== 5. 按 id 进会话 ===');
    const w4 = await observe();
    const row = (w4.d.controls || []).find((c) => c.shortId === ':id/cj1' && c.label);
    if (row) {
        log(`  目标：${row.label}  id=${row.id}`);
        const tap = await call({ command: 'ExecuteStep', action: { command: 'Tap', selector: row.selector } });
        check('Tap 按 id 命中', tap.ok, tap.error || tap.text);
        await sleep(2400);
        const chat = await observe();
        log(brief(chat));
        check('进入了详情页', chat.d.changed === true);
        const hasInput = chat.d.controls.some((c) => c.flags.includes('edit') || /EditText/.test(c.cls));
        check('详情页识别出输入框', hasInput,
            hasInput ? '' : chat.d.controls.slice(0, 6).map((c) => `${c.label}<${c.cls}>`).join(', '));
        const labeled = chat.d.controls.filter((c) => c.label && c.label.length > 1);
        check('详情页文本折叠成带标签控件', labeled.length > 3, `${labeled.length} 条`);
        log('\n  —— 聊天详情页前 16 行 ——');
        log(chat.text.split('\n').slice(0, 17).join('\n'));
        await call({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'back' } });
        await sleep(1600);
    } else {
        check('找到会话行', false);
    }

    log('\n=== 6. 同页连拍 ===');
    const a = await observe();
    const b = await observe();
    check('同页第二次 changed=false', b.d.changed === false, `changed=${b.d.changed}`);
    check('签名一致', a.d.signature === b.d.signature, `${a.d.signature} vs ${b.d.signature}`);

    log('\n=== 7. stable:true ===');
    const single = await observe();
    const stable = await observe({ stable: 'true' });
    log(`  单帧 ${single.ms}ms → stable ${stable.ms}ms，settled=${stable.d.settled}`);
    check('返回 settled 字段', typeof stable.d.settled === 'boolean');
    check('stable 明显更慢（真采了两次）', stable.ms > single.ms * 1.4, `${single.ms} → ${stable.ms}`);

    log('\n=== 8. 错误路径 ===');
    const miss = await call({ command: 'ExecuteStep', action: { command: 'Tap', selector: 'id=com.tencent.mm:id/__nope__' } });
    check('selector 未命中时报错而非乱点', !miss.ok, miss.error);

    log('\n=== 9. 计算器对照 ===');
    await openApp('com.android.calculator2');
    const calc = await observe();
    log(brief(calc));
    if (calc.ok && calc.d.total > 0) {
        const digits = calc.d.controls.filter((c) => /^[0-9]$/.test(String(c.label).trim()));
        check('数字键都识别出来', digits.length >= 8, `${digits.length} 个数字键`);
        const seven = calc.d.controls.find((c) => String(c.label).trim() === '7');
        if (seven) {
            await call({ command: 'ExecuteStep', action: { command: 'Tap', selector: seven.selector } });
            await sleep(600);
            const after = await observe();
            check('点 7 之后界面有反应', after.ok, `sig ${calc.d.signature} → ${after.d.signature}`);
            log(after.text.split('\n').slice(0, 12).join('\n'));
        }
    } else {
        check('计算器可 Observe', false, calc.error || '(空表)');
    }

    await call({ command: 'ExecuteStep', action: { command: 'KeyEvent', key: 'home' } });

    log(`\n================ ${pass} passed, ${fail} failed ================`);
    if (failures.length) log(failures.map((f) => `  · ${f}`).join('\n'));
    await service.cleanup?.().catch(() => {});
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('HARNESS FAIL', e);
    process.exit(2);
});
