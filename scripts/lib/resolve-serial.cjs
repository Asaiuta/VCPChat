'use strict';

/**
 * 采集脚本的设备选择。
 *
 * 为什么不再写死默认序列号：旧的默认值是某次热点会话的 `192.168.137.178:37109`。
 * 换网络后它就失效，而失效方式是**静默**的 —— 采集脚本照样跑完、判定照样 pass，
 * 只是所有 adb 调用都打在空气上（`--check` 实测打印 "device ... not found" 后仍给 pass）。
 *
 * 规则：显式 PERF_SERIAL 优先；否则取第一台 `device` 状态的设备；一台都没有就报错退出，
 * 绝不退化成"用某个历史地址试试"。
 */

/** 从 `adb devices` 的输出里挑第一台已授权设备。纯函数，便于用固定文本做断言。 */
function pickSerial(listText, envSerial) {
    const explicit = String(envSerial || '').trim();
    if (explicit) return explicit;
    for (const raw of String(listText || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^List of devices/i.test(line) || /^\*/.test(line)) continue;
        const [serial, state] = line.split(/\s+/);
        // mDNS 序列号形如 adb-beca2585-utuYDs._adb-tls-connect._tcp，同样按首列取。
        if (serial && state === 'device') return serial;
    }
    return null;
}

/**
 * 非致命版本：解析不到就返回 null，由调用方决定降级还是报错。
 * 供「读已落地产物也能工作」的脚本使用（离线 `--check` 不该被设备缺席阻塞）。
 * @param {{adbPath: string, execFileSync: Function, envSerial?: string}} options
 */
function tryResolveSerial(options) {
    const { adbPath, execFileSync, envSerial } = options;
    const explicit = String(envSerial || '').trim();
    if (explicit) return explicit;
    try {
        const listed = execFileSync(adbPath, ['devices'], { encoding: 'utf8', timeout: 15000 });
        return pickSerial(listed, envSerial);
    } catch {
        return null;
    }
}

/**
 * 致命版本：采集脚本必须有一台能用的设备，解析不到就退出码 2。
 * @param {{adbPath: string, execFileSync: Function, envSerial?: string}} options
 */
function resolveSerial(options) {
    const serial = tryResolveSerial(options);
    if (!serial) {
        console.error('[perf] 没有已授权设备。请连接真机，或显式设置 PERF_SERIAL=<serial>。');
        process.exit(2);
    }
    return serial;
}

module.exports = { pickSerial, resolveSerial, tryResolveSerial };
