'use strict';

const META_MASK = 0x7770ff;
const EDITABLE_CLASS = /(?:EditText|AutoCompleteTextView)$/;
// Text/navigation keys only; exclude power, app launching, system settings and dedicated clipboard keycodes.
const KEY_CODES = new Set([
    ...Array.from({ length: 17 }, (_, i) => i + 7),
    ...Array.from({ length: 35 }, (_, i) => i + 29),
    ...Array.from({ length: 12 }, (_, i) => i + 66),
    84, 92, 93, 111, 112, 122, 123, 124,
    ...Array.from({ length: 12 }, (_, i) => i + 131),
    ...Array.from({ length: 20 }, (_, i) => i + 144),
]);

function createKeyboardActions(deps) {
    const {
        stepRuntime, prepareTarget, dispatchInput, rpcAction, RPC_OPERATION,
        captureGraph, fieldSelector, requireAdb, resolveSerial, ensureActiveDevice,
        textResult, channelReceipt,
    } = deps;
    const fail = (code) => stepRuntime.failure(code, '键盘动作未确认；不回退、不重发，不披露字段内容。');
    const validMeta = value => Number.isSafeInteger(value) && value >= 0
        && value <= META_MASK && (value & ~META_MASK) === 0;

    function clean(error, attempts) {
        if (/^POLICY_/.test(error.code || '')) return error;
        const failure = fail(error.code || 'KEYBOARD_FAILED');
        failure.details = { channels: attempts.map(item => item.channel), attempts, keyboard: { experimental: true } };
        return failure;
    }

    async function active(args) {
        stepRuntime.check();
        const client = requireAdb();
        const { serial } = await ensureActiveDevice(client, resolveSerial(args));
        stepRuntime.bindDevice(serial);
        stepRuntime.check();
        return { client, serial };
    }

    async function send(args, kind) {
        const attempts = [];
        stepRuntime.inputReceipt({ keyboard: { experimental: true } });
        try {
            let code;
            if (kind === 'imeAction') {
                code = args.imeAction === 'enter' ? 66 : args.imeAction === 'search' ? 84 : null;
                if (!code || (args.metaState !== undefined && !validMeta(args.metaState))) throw fail('INVALID_ARGUMENT');
            } else {
                code = args.keyCode;
                if (!Number.isSafeInteger(code) || !KEY_CODES.has(code) || !validMeta(args.metaState)) throw fail('INVALID_ARGUMENT');
            }
            const { serial } = await active(args);
            const params = args.metaState === undefined ? [code] : [code, args.metaState];
            await dispatchInput(serial, () => rpcAction(serial, 'pressKeyCode', params, attempts, RPC_OPERATION.WRITE), false);
            return channelReceipt(textResult('键盘事件已派发；不证明提交、搜索或组合键业务结果。', {
                serial, keyboard: { experimental: true, action: kind },
            }), attempts);
        } catch (error) { throw clean(error, attempts); }
    }

    function proveTarget(graph, identity) {
        if (graph.keyguard || graph.package !== identity.package) throw fail('ERASE_TARGET_CHANGED');
        let target;
        let matches = 0;
        let focused = 0;
        const stack = [graph.rawRoot];
        while (stack.length) {
            const raw = stack.pop();
            if (!raw) continue;
            if (raw.tag === 'node') {
                const attrs = raw.attrs;
                // Include hidden/disabled nodes when proving identity and focus uniqueness.
                if (attrs['resource-id'] === identity.id && attrs.package === identity.package) {
                    target = attrs;
                    matches += 1;
                }
                if (attrs.focused === 'true') focused += 1;
            }
            stack.push(...raw.children);
        }
        const control = graph.controls.find(item => item.id === identity.id && item.package === identity.package);
        if (matches !== 1 || target.class !== identity.cls || !EDITABLE_CLASS.test(target.class || '')
            || !control || control.role !== 'textfield' || !control.enabled || !control.inViewport
            || target.enabled !== 'true' || target['visible-to-user'] === 'false'
            || target.password === 'true' || control.flags.includes('password')) throw fail('INVALID_ERASE_TARGET');
        if (target.focused !== 'true' || focused !== 1) throw fail('ERASE_FOCUS_CHANGED');
    }

    async function eraseText(args = {}) {
        const attempts = [];
        let keyEvents = 0;
        const keyboard = { experimental: true, action: 'eraseText', policy: 'max-del-events-stop-on-empty-or-no-progress' };
        stepRuntime.inputReceipt({ keyboard });
        try {
            if (!Number.isSafeInteger(args.count) || args.count < 1 || args.count > 100
                || !(args.id || args.resourceId || args.resource_id || args.selector || args.index !== undefined)
                || (args.selector !== undefined && (typeof args.selector !== 'string' || !args.selector.startsWith('id=')))
                || ['x', 'y', 'frameId', 'text', 'content'].some(key => args[key] !== undefined)) throw fail('INVALID_ARGUMENT');
            const { serial, node } = await stepRuntime.stage('prepareMs', () => prepareTarget({ ...args, rpcTarget: true }, '删除'));
            stepRuntime.bindDevice(serial);
            if (!node?.id || !node.enabled || !node.inViewport || node.role !== 'textfield' || node.flags.includes('password')) {
                throw fail('INVALID_ERASE_TARGET');
            }
            const selector = fieldSelector(serial, node);
            const identity = { id: node.id, package: node.package, cls: selector.className };
            const client = requireAdb();
            const prove = async () => {
                stepRuntime.check();
                const focus = await client.currentFocus(serial);
                if (focus?.package !== identity.package) throw fail('ERASE_TARGET_CHANGED');
                const screen = await client.screenSize(serial);
                const graph = await captureGraph(serial, { limit: 500, screen, rpcTarget: true });
                proveTarget(graph, identity);
                stepRuntime.check();
            };
            const read = async () => {
                await prove();
                const value = await rpcAction(serial, 'getText', [selector], attempts, RPC_OPERATION.READ);
                if (typeof value !== 'string') throw fail('ERASE_READBACK_INVALID');
                return value;
            };
            for (let index = 0; index < args.count; index += 1) {
                const before = await read();
                if (before.length === 0) {
                    if (keyEvents === 0) throw fail('ERASE_EMPTY');
                    break;
                }
                // No cursor/selection API exists: count bounds DEL events, never characters.
                // Prove focus after RPC readiness waits, immediately before invoking DEL.
                await dispatchInput(serial, () => rpcAction(serial, 'pressKeyCode', [67], attempts, RPC_OPERATION.WRITE, { beforeDispatch: prove }), false);
                keyEvents += 1;
                stepRuntime.inputReceipt({ keyboard: { ...keyboard, keyEvents } });
                const after = await read();
                if (after === before) throw fail('ERASE_NO_PROGRESS');
                if (after.length >= before.length) throw fail('ERASE_UNEXPECTED_CHANGE');
                if (after.length === 0) break;

            }
            return channelReceipt(textResult('删除按键已派发；遇空停止，不证明恰好删除指定字符数。', {
                serial, keyboard: { ...keyboard, keyEvents },
            }), attempts);
        } catch (error) { throw clean(error, attempts); }
    }

    return { imeAction: args => send(args || {}, 'imeAction'), keyCombo: args => send(args || {}, 'keyCombo'), eraseText };
}

module.exports = { createKeyboardActions, META_MASK };
