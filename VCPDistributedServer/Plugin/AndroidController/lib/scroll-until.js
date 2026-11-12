'use strict';

const { parseBounds, clipToScreen } = require('./ui-graph');

function intersect(a, b) {
    if (!a || !b) return null;
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function createScrollUntil({ stepRuntime, prepareTargets, rpcNodeSelector, dispatchInput, rpcAction,
    requireAdb, freshProbe, uiServerEnabled, uiServerFor, getGraph, textResult, channelReceipt }) {
    const fail = (code, message) => { throw stepRuntime.failure(code, message); };
    const invalid = () => fail('INVALID_ARGUMENT', 'ScrollUntil 需要 container=id=…、target=id=…或text=…，以及有效策略、方向和host滚动上限；不接受序号或像素寻址。');
    const selector = (value, container = false) => {
        if (typeof value !== 'string') invalid();
        const match = /^(id|text)=([^#]+)$/.exec(value);
        if (!match || (container && match[1] !== 'id')) invalid();
        const key = match[2].replace(/%25|%23/gi, code => code.toLowerCase() === '%25' ? '%' : '#');
        if (!key.trim() || /[\x00-\x1f\x7f]/.test(key)) invalid();
        return { kind: match[1], key };
    };
    const integer = value => {
        const n = typeof value === 'number' ? value
            : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(n) || n < 1 || n > 20) invalid();
        return n;
    };
    const sizeEqual = (a, b) => a?.width === b?.width && a?.height === b?.height;
    const validSize = size => Number.isInteger(size?.width) && size.width > 0
        && Number.isInteger(size?.height) && size.height > 0;
    const safeSampleCodes = new Set(['DEVICE_NOT_AWAKE', 'DEVICE_LOCKED', 'SCROLL_CONTEXT_CHANGED',
        'INVALID_SCROLL_CONTAINER', 'AMBIGUOUS_SCROLL_TARGET']);

    return async function scrollUntil(args = {}) {
        const container = selector(args.container, true);
        const target = selector(args.target);
        const requestedStrategy = args.strategy === undefined ? 'auto' : args.strategy;
        const direction = args.direction === undefined ? 'down' : args.direction;
        if (!['auto', 'rpc', 'host'].includes(requestedStrategy)
            || !['down', 'up', 'right', 'left'].includes(direction)
            || ['id', 'resourceId', 'resource_id', 'text', 'selector', 'index', 'snapshotId', 'frameId',
                'x', 'y', 'x1', 'y1', 'x2', 'y2', 'distance', 'duration', 'steps', 'wake', 'autoWake']
                .some(key => args[key] !== undefined)) invalid();
        const explicitMax = args.maxSwipes !== undefined;
        if (requestedStrategy === 'rpc' && (explicitMax || direction === 'up' || direction === 'left')) invalid();
        const maxSwipes = explicitMax ? integer(args.maxSwipes) : 10;
        const serial = args.serial || stepRuntime.activeDevice();
        const client = requireAdb();
        const attempts = [];
        let strategy = requestedStrategy;
        let swipes = 0;
        let baseline = null;
        stepRuntime.inputReceipt({ channels: [], attempts, experimental: true });

        async function sample() {
            stepRuntime.check();
            try {
                // Target binding uses the current logical display. The legacy probe caches
                // wm size (natural orientation), which rejects valid landscape containers.
                const probe = await freshProbe(serial);
                stepRuntime.check();
                if (probe?.wakefulness !== 'Awake') fail('DEVICE_NOT_AWAKE', '设备未确认醒着；ScrollUntil不唤醒设备。');
                if (!probe.focus?.package || /systemui|keyguard/i.test(probe.focus.package)) {
                    fail('DEVICE_LOCKED', '设备未确认处于未锁定应用页面。');
                }
                const [binding] = await prepareTargets([{ args: { serial, id: container.key }, label: '滚动容器' }]);
                stepRuntime.check();
                const graph = getGraph(serial);
                const node = binding?.node;
                const box = node?.clipped;
                if (graph?.keyguard) fail('DEVICE_LOCKED', '锁屏时不滚动。');
                if (!graph?.rawRoot || !node?.enabled || !node.inViewport || !node.flags?.includes('scroll')
                    || !box || box.right - box.left < 16 || box.bottom - box.top < 16
                    || !node.package || !validSize(binding.screen) || !sizeEqual(binding.screen, probe.size)) {
                    fail('INVALID_SCROLL_CONTAINER', '无法确认当前可见启用滚动容器和屏幕尺寸。');
                }
                if (probe.focus.package !== node.package
                    || (baseline && (baseline.package !== node.package || !sizeEqual(baseline.screen, binding.screen)))) {
                    fail('SCROLL_CONTEXT_CHANGED', '滚动期间应用或屏幕尺寸变化；停止且不重放。');
                }
                baseline ||= { package: node.package, screen: { ...binding.screen } };
                const nodes = [];
                const stack = [{ raw: graph.rawRoot, clip: { left: 0, top: 0, right: binding.screen.width, bottom: binding.screen.height }, hidden: false, inside: false }];
                while (stack.length) {
                    const { raw, clip, hidden, inside } = stack.pop();
                    const attrs = raw.attrs || {};
                    const ownHidden = hidden || attrs['visible-to-user'] === 'false' || attrs.displayed === 'false';
                    const bounds = raw.tag === 'node' ? parseBounds(attrs.bounds) : null;
                    const visibleBox = ownHidden ? null : intersect(bounds, clip);
                    const inContainer = inside || attrs['resource-id'] === container.key;
                    if (raw.tag === 'node') nodes.push({ attrs, inContainer, visibleBox, hidden: ownHidden });
                    const nextClip = attrs.scrollable === 'true' ? intersect(clip, bounds) : clip;
                    for (const child of raw.children || []) stack.push({ raw: child, clip: nextClip, hidden: ownHidden, inside: inContainer });
                }
                const containers = nodes.filter(item => item.attrs['resource-id'] === container.key);
                if (containers.length !== 1 || containers[0].attrs.package !== node.package
                    || containers[0].hidden || !containers[0].visibleBox) {
                    fail('INVALID_SCROLL_CONTAINER', '滚动容器原始身份不唯一或不可见。');
                }

                const safeBox = intersect(box, containers[0].visibleBox);
                if (!safeBox || safeBox.right - safeBox.left < 16 || safeBox.bottom - safeBox.top < 16) {
                    fail('INVALID_SCROLL_CONTAINER', '滚动容器在祖先裁剪范围内没有足够空间。');
                }
                const hits = nodes.filter(item => item.attrs.package === node.package
                    && item.attrs[target.kind === 'id' ? 'resource-id' : 'text'] === target.key);
                if (hits.length > 1) fail('AMBIGUOUS_SCROLL_TARGET', '滚动目标身份不唯一；不接受序号消歧。');
                const hit = hits[0];
                const viewport = clipToScreen(safeBox, binding.screen);
                const visibleBounds = hit?.inContainer ? intersect(hit.visibleBox, viewport) : null;
                // XML bounds may already be clipped by Android. They cannot prove a
                // percentage of the original element. Require the observed region to
                // clear BOTH edges on the scrolling axis instead of accepting a sliver.
                const horizontal = direction === 'left' || direction === 'right';
                const visible = Boolean(visibleBounds && (horizontal
                    ? visibleBounds.left > viewport.left && visibleBounds.right < viewport.right
                    : visibleBounds.top > viewport.top && visibleBounds.bottom < viewport.bottom));
                return { binding: { ...binding, node: { ...node, clipped: safeBox } }, visible,
                    visibility: { contract: 'scroll-axis-interior', visibleBounds, viewport,
                        reason: visible ? 'INTERIOR' : visibleBounds ? 'VIEWPORT_EDGE' : 'NOT_VISIBLE' } };
            } catch (error) {
                stepRuntime.check();
                const code = safeSampleCodes.has(error.code) ? error.code : 'SCROLL_UNTIL_SAMPLE_FAILED';
                fail(code, 'ScrollUntil实时采样或安全检查失败；停止且不重放。');
            }
        }

        const finish = sample => {
            stepRuntime.check();
            const matched = sample.visible;
            const evidence = { strategy, swipes, targetVisible: matched, visibility: sample.visibility };
            stepRuntime.verified(matched, { condition: { type: 'scrollUntil' }, evidence });
            return channelReceipt(textResult(matched
                ? '目标可见区域已离开滚动轴两端边缘；未点击，不证明完整元素或无遮挡。'
                : '滚动已停止，未验证目标可见；不证明已到达边界。', {
                serial, strategy, direction, swipes, actionVerified: matched, visibility: sample.visibility,
            }), attempts, { experimental: true });
        };

        let current = await stepRuntime.stage('prepareMs', sample);
        if (current.visible) return finish(current);

        if (strategy === 'auto' && (explicitMax || direction === 'up' || direction === 'left')) strategy = 'host';
        if (strategy !== 'host') {
            stepRuntime.check();
            let ready = false;
            if (uiServerEnabled()) {
                try {
                    const state = await stepRuntime.stage('prepareMs', () => uiServerFor(serial).start());
                    stepRuntime.check();
                    if (!state || typeof state.ok !== 'boolean') fail('UI_SERVER_READINESS_UNKNOWN', '无法确认RPC服务就绪状态。');
                    ready = state.ok;
                } catch (error) {
                    stepRuntime.check();
                    fail('UI_SERVER_READINESS_UNKNOWN', 'RPC服务就绪状态未知；未派发且不切换策略。');
                }
            }
            if (strategy === 'auto') strategy = ready ? 'rpc' : 'host';
            else if (!ready) fail('UI_SERVER_NOT_READY', '指定RPC策略但服务不可用；未派发且不切换策略。');
        }

        if (strategy === 'rpc') {
            // Readiness can take time; bind again immediately before the single write.
            current = await stepRuntime.stage('prepareMs', sample);
            if (current.visible) return finish(current);
            const containerRPC = rpcNodeSelector(serial, current.binding.node);
            const targetRPC = { mask: 524288 | (target.kind === 'id' ? 2097152 : 1), packageName: baseline.package };
            targetRPC[target.kind === 'id' ? 'resourceId' : 'text'] = target.key;
            // The strategy is immutable after this call, including explicit not-dispatched failures.
            await dispatchInput(serial, () => rpcAction(serial, 'scrollTo', [containerRPC, targetRPC,
                direction === 'down' || direction === 'up'], attempts, 'write', {
                durationMs: Math.max(0, stepRuntime.remainingMs() - 1000),
            }), false);
            current = await stepRuntime.stage('verificationMs', sample);
            return finish(current);
        }

        while (swipes < maxSwipes) {
            stepRuntime.check();
            // The first host iteration also rebinds after strategy readiness waits.
            current = await stepRuntime.stage('prepareMs', sample);
            if (current.visible) return finish(current);
            const box = current.binding.node.clipped;
            const horizontal = direction === 'left' || direction === 'right';
            const sign = direction === 'down' || direction === 'right' ? 1 : -1;
            const cx = (box.left + box.right) / 2;
            const cy = (box.top + box.bottom) / 2;
            const delta = (horizontal ? box.right - box.left : box.bottom - box.top) * 0.3;
            const points = [Math.round(cx + (horizontal ? sign * delta : 0)),
                Math.round(cy + (horizontal ? 0 : sign * delta)),
                Math.round(cx - (horizontal ? sign * delta : 0)),
                Math.round(cy - (horizontal ? 0 : sign * delta))];
            const attempt = { channel: 'shell', method: 'swipe', status: 'starting' };
            attempts.push(attempt);
            stepRuntime.inputReceipt({ channels: attempts.map(item => item.channel), attempts });
            await dispatchInput(serial, async () => {
                stepRuntime.check();
                attempt.status = 'dispatched';
                swipes += 1;
                try {
                    await client.runText(['shell', 'input', 'swipe', ...points.map(String), '300'],
                        { serial, timeoutMs: stepRuntime.remainingMs() });
                    stepRuntime.check();
                } catch (error) {
                    attempt.status = 'unknown';
                    attempt.code = 'SCROLL_UNTIL_INPUT_FAILED';
                    stepRuntime.check();
                    fail(attempt.code, '滚动输入结果未知；停止且不重放。');
                }
            });
            current = await stepRuntime.stage('verificationMs', sample);
            if (current.visible) return finish(current);
        }
        return finish(current);
    };
}

module.exports = { createScrollUntil };
