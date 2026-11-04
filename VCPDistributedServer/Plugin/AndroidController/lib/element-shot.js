'use strict';

const { screenContext, elementEvidence } = require('./layout-evidence');

function createElementShot({ runtime, vision, prepareTarget, getRecord, captureGraph, resolveSelector, intOf, validateSelector, graphLayout }) {
    const fail = (code, message) => { throw runtime.failure(code, message); };
    function validate(args) {
        if (args.target !== 'element') {
            if (args.padding !== undefined) fail('INVALID_ARGUMENT', 'padding 仅用于 target=element。');
            return;
        }
        const fields = ['selector', 'id', 'index'].filter(key => args[key] !== undefined);
        if (fields.length !== 1 || args.region !== undefined || args.crop !== undefined
            || ['x', 'y', 'frameId', 'resourceId', 'resource_id', 'text'].some(key => args[key] !== undefined)) {
            fail('INVALID_ARGUMENT', '元素截图必须使用唯一一种 selector/id/index+snapshotId，不可混用region或像素。');
        }
        if (args.selector !== undefined) validateSelector(args.selector);
        if (args.id !== undefined && (typeof args.id !== 'string' || !args.id.trim())) fail('INVALID_ARGUMENT', '元素id必须非空。');
        if (args.index !== undefined && (intOf(args.index, 'index') < 0 || typeof args.snapshotId !== 'string' || !args.snapshotId)) fail('INVALID_ARGUMENT', '元素index必须携带snapshotId。');
        if (args.padding !== undefined && (!Number.isSafeInteger(args.padding) || args.padding < 0 || args.padding > 128)) fail('INVALID_ARGUMENT', 'padding 必须为0–128整数设备像素。');
    }
    async function prepare({ client, serial, size, args }) {
        validate(args);
        const before = await client.probeScreen(serial);
        before.size = await client.screenSize(serial, { force: true });
        const context = screenContext(before);
        if (!context || JSON.stringify(before.size) !== JSON.stringify(size)) fail('INVALID_ELEMENT_TARGET', '未确认当前前台、未锁定与屏幕尺寸。');
        const binding = await prepareTarget({ ...args, serial, rpcTarget: true, safeRead: true }, '元素截图');
        const graph = getRecord(serial)?.graph;
        const evidence = binding.node && elementEvidence(graph, binding.node, size);
        if (!evidence || binding.node.package !== before.focus.package) fail('INVALID_ELEMENT_TARGET', '元素来源不唯一、不可见或不属于当前前台。');
        const element = vision.elementRegion({ bounds: binding.node.bounds, visibleBounds: evidence.visibleBounds, screen: size, padding: args.padding });
        return { element, context, rotation: graph.rawRoot?.attrs?.rotation ?? null,
            identity: evidence.identity, layout: args.index !== undefined ? graphLayout(graph) : null, limit: getRecord(serial).limit };
    }
    async function verify({ client, serial, size, args, baseline }) {
        const probe = await client.probeScreen(serial);
        probe.size = await client.screenSize(serial, { force: true });
        if (screenContext(probe) !== baseline.context || JSON.stringify(probe.size) !== JSON.stringify(size)) fail('ELEMENT_CONTEXT_CHANGED', '截图期间前台或屏幕尺寸变化。');
        const graph = await captureGraph(serial, { limit: baseline.limit, screen: size, rpcTarget: true, deadlineMs: Date.now() + runtime.remainingMs() });
        const after = await client.probeScreen(serial);
        after.size = await client.screenSize(serial, { force: true });
        if (screenContext(after) !== baseline.context || (graph.rawRoot?.attrs?.rotation ?? null) !== baseline.rotation) {
            fail('ELEMENT_CONTEXT_CHANGED', '末次采样期间前台、屏幕尺寸或旋转变化。');
        }
        const node = args.index !== undefined ? graph.controls[intOf(args.index, 'index')]
            : resolveSelector(graph, args.selector !== undefined ? args.selector : { id: args.id });
        const evidence = node && elementEvidence(graph, node, size);
        if (!evidence || evidence.identity !== baseline.identity || JSON.stringify(evidence.visibleBounds) !== JSON.stringify(baseline.element.visibleBounds)
            || (args.index !== undefined && graphLayout(graph) !== baseline.layout)) fail('ELEMENT_TARGET_CHANGED', '截图期间元素或可见布局变化；不签发图像凭据。');
        runtime.check();
    }
    return { validate, prepare, verify };
}

module.exports = { createElementShot };
