'use strict';

const { validateSelector } = require('./selector');

const ADDRESS_KEYS = ['id', 'resourceId', 'resource_id', 'selector', 'text', 'index'];
const DESTINATION_KEYS = new Set([...ADDRESS_KEYS, 'snapshotId']);

function createGestureActions({ stepRuntime, prepareTargets, rpcNodeSelector, dispatchInput, rpcAction, textResult, channelReceipt }) {
    const invalid = message => { throw stepRuntime.failure('INVALID_ARGUMENT', message); };
    const supplied = value => value !== undefined;
    const integer = (value, name, min, max) => {
        const number = typeof value === 'number' ? value
            : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(number) || number < min || number > max) invalid(`${name} 必须为 ${min}–${max} 的整数。`);
        return number;
    };
    const timing = args => {
        if (supplied(args.steps) && supplied(args.duration)) invalid('steps 与 duration 不能同时指定。');
        const steps = supplied(args.duration)
            ? Math.max(1, Math.round(integer(args.duration, 'duration', 1, 10000) / 5))
            : supplied(args.steps) ? integer(args.steps, 'steps', 1, 2000) : 60;
        return { steps, durationMs: steps * 5 };
    };
    const address = (args, label, semanticOnly = false) => {
        const keys = ADDRESS_KEYS.filter(key => supplied(args[key]));
        const pixels = supplied(args.x) || supplied(args.y);
        if (keys.length > 1 || (keys.length && pixels)) invalid(`${label}只能指定一种寻址方式。`);
        if (keys.length === 1) {
            if (keys[0] === 'index') {
                integer(args.index, `${label}.index`, 0, 100000);
                if (typeof args.snapshotId !== 'string' || !args.snapshotId.trim()) invalid(`${label}.index 必须携带 snapshotId。`);
            } else if (keys[0] === 'selector') {
                            if (!validateSelector(args.selector)) invalid(`${label}selector格式无效。`);
                        } else if (typeof args[keys[0]] !== 'string' || !args[keys[0]].trim()) invalid(`${label}语义目标不能为空。`);
            return true;
        }
        if (semanticOnly) invalid(`${label}必须是语义目标。`);
        integer(args.x, `${label}.x`, 0, 2147483647);
        integer(args.y, `${label}.y`, 0, 2147483647);
        return false;
    };
    const visible = (target, label) => {
        const box = target.node?.clipped;
        const screen = target.screen;
        if (!target.node || target.node.enabled !== true || target.node.inViewport !== true
            || !box || !screen || ![box.left, box.top, box.right, box.bottom, screen.width, screen.height].every(Number.isFinite)) {
            throw stepRuntime.failure('INVALID_GESTURE_TARGET', `${label}必须是可见且启用的控件。`);
        }
        const left = Math.max(0, Math.ceil(box.left));
        const top = Math.max(0, Math.ceil(box.top));
        const right = Math.min(screen.width, Math.ceil(box.right));
        const bottom = Math.min(screen.height, Math.ceil(box.bottom));
        if (right <= left || bottom <= top) throw stepRuntime.failure('INVALID_GESTURE_TARGET', `${label}没有可见矩形。`);
        return { x: Math.min(right - 1, Math.floor((left + right) / 2)), y: Math.min(bottom - 1, Math.floor((top + bottom) / 2)) };
    };
    const sameDevice = targets => {
        if (!targets[0]?.serial || targets.some(target => target.serial !== targets[0].serial)) {
            throw stepRuntime.failure('INVALID_GESTURE_TARGET', '手势两端必须绑定同一设备。');
        }
    };
    const start = () => {
        const attempts = [];
        stepRuntime.inputReceipt({ channels: [], attempts, experimental: true });
        return attempts;
    };
    const receipt = (message, details, attempts) => channelReceipt(textResult(message, details), attempts, { experimental: true });
    const unsupportedShape = args => {
        if (['gesture', 'points', 'p1', 'p2', 'p3', 'p4', 'x1', 'y1'].some(key => supplied(args[key]))) {
            invalid('仅支持 Drag 或 pinchIn/pinchOut 的固定原语形状，不接受自定义轨迹。');
        }
    };

    async function drag(args = {}) {
        const attempts = start();
        unsupportedShape(args);
        const { steps, durationMs } = timing(args);
        const semanticSource = address(args, 'Drag源');
        const hasTarget = supplied(args.target);
        const hasPixels = supplied(args.x2) || supplied(args.y2);
        if (hasTarget === hasPixels) invalid('Drag终点必须二选一：target语义对象或x2/y2像素。');
        let destination;
        if (hasTarget) {
            if (!args.target || typeof args.target !== 'object' || Array.isArray(args.target)
                || Object.keys(args.target).some(key => !DESTINATION_KEYS.has(key))) invalid('Drag.target 仅接受同设备语义寻址与snapshotId。');
            address(args.target, 'Drag终点', true);
            destination = { ...args.target, serial: args.serial };
        } else {
            destination = { serial: args.serial, x: integer(args.x2, 'x2', 0, 2147483647), y: integer(args.y2, 'y2', 0, 2147483647), frameId: args.frameId };
        }
        const [source, end] = await stepRuntime.stage('prepareMs', () => prepareTargets([
            { args, label: '拖拽源', rpcTarget: semanticSource },
            { args: destination, label: '拖拽终点', rpcTarget: hasTarget },
        ]));
        sameDevice([source, end]);
        const sourcePoint = semanticSource ? visible(source, '拖拽源') : source;
        const endPoint = hasTarget ? visible(end, '拖拽终点') : end;
        const method = semanticSource ? 'dragTo' : 'drag';
        const params = semanticSource
            ? [rpcNodeSelector(source.serial, source.node), endPoint.x, endPoint.y, steps]
            : [sourcePoint.x, sourcePoint.y, endPoint.x, endPoint.y, steps];
        await dispatchInput(source.serial, () => rpcAction(source.serial, method, params, attempts, 'write', { durationMs }), false);
        return receipt('已派发单条拖拽触摸流；效果未经真机准入。', {
            serial: source.serial, x1: sourcePoint.x, y1: sourcePoint.y, x2: endPoint.x, y2: endPoint.y, steps, durationMs,
        }, attempts);
    }

    async function pinch(args = {}) {
        const attempts = start();
        unsupportedShape(args);
        if (supplied(args.target) || supplied(args.x2) || supplied(args.y2)) invalid('Pinch只接受顶层语义目标。');
        address(args, 'Pinch', true);
        if (args.direction !== 'in' && args.direction !== 'out') invalid('Pinch.direction 必须为 in 或 out。');
        const percent = integer(args.percent, 'percent', 1, 100);
        const { steps, durationMs } = timing(args);
        const [target] = await stepRuntime.stage('prepareMs', () => prepareTargets([{ args, label: '捏合目标', rpcTarget: true }]));
        sameDevice([target]);
        visible(target, '捏合目标');
        const selector = rpcNodeSelector(target.serial, target.node);
        const method = args.direction === 'in' ? 'pinchIn' : 'pinchOut';
        await dispatchInput(target.serial, () => rpcAction(target.serial, method, [selector, percent, steps], attempts, 'write', { durationMs }), false);
        return receipt('已派发双指捏合；效果未经真机准入。', { serial: target.serial, direction: args.direction, percent, steps, durationMs }, attempts);
    }

    return { drag, pinch };
}

// Custom gesture(selector,p1,p2,p3,p4,steps) is intentionally not exposed without a verified use case.
module.exports = { createGestureActions };
