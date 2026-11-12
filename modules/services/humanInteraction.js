'use strict';

// Main-process capability injected into direct plugins. No renderer IPC or model
// argument can produce an answer; Electron owns the dialog and its buttons.
function createHumanInteraction({ dialog, getWindow }) {
    return Object.freeze({
        async request({ kind, detail, signal }) {
            if (!['approval', 'handoff', 'takeover'].includes(kind) || typeof detail !== 'string' || detail.length > 16000 || !signal) {
                throw new TypeError('Invalid human interaction request');
            }
            signal.throwIfAborted();
            const window = getWindow();
            if (!window || window.isDestroyed()) throw new Error('Human interaction window unavailable');
            const handoff = kind === 'handoff';
            const takeover = kind === 'takeover';
            const result = await dialog.showMessageBox(window, {
                type: 'question', title: handoff ? 'Android · 请接手操作' : takeover ? 'Android · 人工接管显示屏' : 'Android · 确认本次操作',
                message: handoff ? '请在手机上处理，完成后选择继续。' : takeover ? '允许此窗口临时操作手机吗？' : '是否允许以下这一次操作？',
                detail, buttons: handoff ? ['停止', '继续'] : takeover ? ['拒绝', '允许本次接管'] : ['拒绝', '允许这一次'],
                defaultId: 0, cancelId: 0, noLink: true, signal,
            });
            signal.throwIfAborted();
            if (window.isDestroyed()) throw new Error('Human interaction window closed');
            return result.response === 1;
        },
    });
}

module.exports = { createHumanInteraction };
