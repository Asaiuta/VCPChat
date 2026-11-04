'use strict';

/**
 * 设备端 RPC 方法的签名表。
 *
 * 固定方法名与参数个数；错误形状必须在本地拒绝（dispatched=false）。
 * 随包 APK 已确认 click(x,y) 与 click(x,y,milliseconds)；第三参是按压时长。
 *
 * 每个条目：
 *   arity        允许的参数个数。u2 各构建的重载不统一，这里只声明已在真机或
 *                契约里证实过的形状；不确定的宁可不写。
 *   write        是否改变设备状态。影响 dispatched 语义与设备租约，不是注释。
 *   experimental 该形状未经真机证实，不得进入默认降级链。
 */
const RPC_METHODS = Object.freeze({
    // 点击/原生长按：click(x,y[,milliseconds])；三参重载在随包 APK 上已确认存在。
    click: { arity: [2, 3], write: true },
    // 滑动：swipe(x1,y1,x2,y2,steps)，steps ≈ duration/5；同点形状仅作长按回退。
    swipe: { arity: [5], write: true },
    // longClick 只接收 Selector/String，没有坐标重载；语义未做真机准入。
    longClick: { arity: [1], write: true, experimental: true },
    drag: { arity: [5], write: true, experimental: true },
    dragTo: { arity: [4], write: true, experimental: true },
    pinchIn: { arity: [3], write: true, experimental: true },
    pinchOut: { arity: [3], write: true, experimental: true },
    scrollTo: { arity: [3], write: true, experimental: true },
    pressKeyCode: { arity: [1, 2], write: true, experimental: true },
    setText: { arity: [2], write: true },
    clearTextField: { arity: [1], write: true },
    getText: { arity: [1], write: false },
    waitForIdle: { arity: [1], write: false, experimental: true },
    // 剪贴板这一组共用同一套隐藏 IClipboard 反射镜像（vendor apk classes2.dex：
    // proxy/wrappers/ClipboardManager + getSetPrimaryClipMethod / getGetPrimaryClipMethod）。
    // 真机（PJZ110 / Android 17）逐条实测：setClipboard 成功、getClipboard 成功、
    // pasteClipboard 抛 java.lang.AssertionError。**不是整组不可用**，所以能力必须按
    // 方法记账；paste 是写通道，没有只读探针可以代替它。标 experimental 是因为
    // 它们在不同 ROM 上会各自漂移。
    getClipboard: { arity: [0], write: false, experimental: true },
    setClipboard: { arity: [2], write: true, experimental: true },
    pasteClipboard: { arity: [0], write: true, experimental: true },
});

const NAMES = Object.freeze(Object.keys(RPC_METHODS));


function entry(method) {
    return typeof method === 'string' && Object.prototype.hasOwnProperty.call(RPC_METHODS, method)
        ? RPC_METHODS[method]
        : null;
}

function isKnown(method) {
    return entry(method) !== null;
}

function isWrite(method) {
    return entry(method)?.write === true;
}

function isExperimental(method) {
    return entry(method)?.experimental === true;
}

/**
 * 校验一次调用的形状。返回 `{ ok: true }` 或 `{ ok: false, reason }`。
 * 不抛异常：调用方要能把「本地形状错误」与「设备拒绝」区分成不同回执。
 */
function validate(method, params) {
    const spec = entry(method);
    if (!spec) return { ok: false, reason: `RPC method ${JSON.stringify(method)} 不在签名表内` };
    if (!Array.isArray(params)) return { ok: false, reason: 'RPC params 必须是数组' };
    if (!spec.arity.includes(params.length)) {
        return {
            ok: false,
            reason: `${method} 只接受 ${spec.arity.join('|')} 个参数，收到 ${params.length} 个`,
        };
    }
    const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
    const selector = value => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)
            || !integer(value.mask, 1, 0x7fffffff)
            || typeof value.packageName !== 'string' || value.packageName.length === 0 || value.packageName.length > 255
            || !Object.keys(value).every(key => ['mask', 'packageName', 'className', 'resourceId', 'text'].includes(key))) return false;
        let mask = 524288;
        let identity = false;
        for (const [key, bit] of [['className', 16], ['resourceId', 2097152], ['text', 1]]) {
            if (value[key] === undefined) continue;
            if (typeof value[key] !== 'string' || value[key].length === 0 || value[key].length > 2000) return false;
            mask |= bit;
            identity = true;
        }
        return identity && value.mask === mask;
    };
    const coordinate = value => integer(value, 0, 0x7fffffff);
    const steps = value => integer(value, 1, 2000);
    let valid = true;
    if (method === 'drag') valid = params.slice(0, 4).every(coordinate) && steps(params[4]);
    if (method === 'dragTo') valid = selector(params[0]) && coordinate(params[1]) && coordinate(params[2]) && steps(params[3]);
    if (method === 'pinchIn' || method === 'pinchOut') valid = selector(params[0]) && integer(params[1], 1, 100) && steps(params[2]);
    if (method === 'scrollTo') valid = selector(params[0]) && selector(params[1]) && typeof params[2] === 'boolean';
    if (method === 'pressKeyCode') valid = integer(params[0], 0, 400) && (params.length === 1 || (integer(params[1], 0, 0x7770ff) && (params[1] & ~0x7770ff) === 0));
    if (method === 'waitForIdle') valid = integer(params[0], 1, 2000);
    return valid ? { ok: true } : { ok: false, reason: 'RPC 参数形状或范围无效' };
}

module.exports = {
    RPC_METHODS,
    NAMES,
    entry,
    isKnown,
    isWrite,
    isExperimental,
    validate,
};
