'use strict';

/**
 * 设备端 RPC 链路唯一的错误类型。
 *
 * 单独成文件是为了让「传输层」与「会话层」共用同一个类对象 —— 调用方用
 * `error instanceof UiServerError` 判定，若两侧各自定义一份类，同一个失败
 * 在两个模块里会得到不同的构造器，instanceof 静默变假。
 *
 * `code` 是稳定契约（UI_SERVER_*），测试与上层回退逻辑都按它分派；
 * `dispatched` / `drained` 是回执语义，含义见 invoke 的注释。
 */
class UiServerError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'UiServerError';
        this.code = code;
        Object.assign(this, details);
    }
}

module.exports = { UiServerError };
