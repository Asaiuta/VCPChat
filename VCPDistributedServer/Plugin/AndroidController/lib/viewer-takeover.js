'use strict';

const { randomBytes } = require('node:crypto');
const { imagePointToDevice } = require('./vision');

const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.includes(key))) throw fail('INVALID_ARGUMENT', '接管请求字段无效。');
};

// A read-stream cookie never grants write ownership. The native host approves a
// bounded session; each input still uses the production frame and policy gates.
function createViewerTakeover({ runtime, client, selectedSerial, authorize, capture, execute,
    invalidate, assertCertain, quarantine, sessionMs = 600000, operationMs = 15000 }) {
    let current = null;
    let stopped = false;
    let generation = 0;
    const status = () => ({ available: Boolean(authorize), state: current?.phase || 'idle',
        serial: current?.serial || null, epoch: generation });
    function assertIdle() {
        if (current) throw fail('DEVICE_BUSY', '人工接管期间不能切换设备或修改显示连接。');
    }
    function live(session) {
        session.controller.signal.throwIfAborted();
        if (current !== session || session.phase === 'ending') throw fail('TAKEOVER_ENDED', '人工接管会话已结束。');
        if (selectedSerial() !== session.serial) throw fail('TAKEOVER_DEVICE_CHANGED', '显示设备已改变，接管已停止。');
        assertCertain(session.serial);
    }
    function authenticate(body, owner) {
        const session = current;
        if (!session || session.phase !== 'human' || session.owner !== owner || body.token !== session.token
            || body.epoch !== session.epoch) throw fail('TAKEOVER_SESSION_REQUIRED', '需要当前连接的有效接管会话。');
        live(session);
        return session;
    }
    function finish(session, code = 'TAKEOVER_ENDED') {
        if (session.ending) return session.ending;
        session.phase = 'ending';
        clearTimeout(session.timer);
        session.controller.abort(fail(code, '人工接管已结束，不自动恢复原任务。'));
        invalidate(session.serial);
        session.ending = (async () => {
            const handle = await session.acquisition.catch(async error => { await error.takeoverDrain; return null; });
            if (handle) await runtime.releaseTakeover(handle);
            invalidate(session.serial);
            session.detach?.();
            if (current === session) { current = null; generation++; }
            session.notify?.({ type: 'takeover-ended', code });
        })();
        return session.ending;
    }
    async function run(session, actionCommand, task, timeoutMs = operationMs) {
        live(session);
        const result = await runtime.runTakeover(session.handle, { client: client(), timeoutMs,
            signal: session.controller.signal, outcome: 'observed', actionCommand }, async () => {
            live(session);
            runtime.bindDevice(session.serial);
            return task();
        });
        live(session);
        return result;
    }
    async function frame(session) {
        session.frame = null;
        const result = await run(session, 'takeoverSnapshot', () => capture(session.serial));
        const value = result.details?.image;
        if (!value?.frameId || value.actionable !== true || !Number.isSafeInteger(value.width)
            || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1
            || typeof value.dataUrl !== 'string' || !/^data:image\/(?:jpeg|png);base64,/.test(value.dataUrl)
            || value.dataUrl.length > 3 * 1024 * 1024) throw fail('TAKEOVER_FRAME_UNAVAILABLE', '没有可操作的新截图，请刷新。');
        session.frame = Object.freeze({ frameId: value.frameId, dataUrl: value.dataUrl,
            width: value.width, height: value.height, expiresAt: Math.min(session.expiresAt,
                (result.details.capturedAt || Date.now()) + 14000), mapping: value.mapping });
        const { mapping, ...publicFrame } = session.frame;
        return publicFrame;
    }
    async function start(body, { owner, signal, notify } = {}) {
        if (stopped) throw fail('SERVICE_STOPPED', '安卓服务已停止。');
        fields(body, ['serial']);
        if (!owner || !signal || !SERIAL.test(body.serial || '') || body.serial === '__auto__') throw fail('INVALID_ARGUMENT', '接管必须显式绑定显示中的设备。');
        assertIdle();
        if (selectedSerial() !== body.serial) throw fail('TAKEOVER_DEVICE_CHANGED', '只能接管当前显示的设备。');
        if (!authorize) throw fail('HUMAN_INTERACTION_UNAVAILABLE', '当前宿主没有可信的人工授权通道。');
        assertCertain(body.serial);
        const session = { owner, serial: body.serial, phase: 'draining', epoch: ++generation,
            token: randomBytes(32).toString('hex'), controller: new AbortController(), notify,
            expiresAt: Date.now() + sessionMs, frame: null };
        current = session;
        session.acquisition = runtime.acquireTakeover({ serial: session.serial, signal: session.controller.signal, timeoutMs: operationMs,
            onUncertain: serials => { for (const serial of serials) quarantine(serial); } });
        const abort = () => { void finish(session, 'TAKEOVER_DISCONNECTED').catch(() => {}); };
        signal.addEventListener('abort', abort, { once: true });
        session.detach = () => signal.removeEventListener('abort', abort);
        session.timer = setTimeout(() => { void finish(session, 'TAKEOVER_EXPIRED').catch(() => {}); }, sessionMs);
        session.timer.unref?.();
        if (signal.aborted) abort();
        try {
            session.handle = await session.acquisition;
            live(session);
            invalidate(session.serial);
            session.phase = 'authorizing';
            const result = await run(session, 'takeoverApproval', async () => ({ content: [], details: {
                approved: await authorize(session.serial) === true,
            } }), 60000);
            if (!result.details.approved) throw fail('POLICY_REJECTED', '用户拒绝人工接管。');
            session.phase = 'human';
            const fresh = await frame(session);
            return { token: session.token, epoch: session.epoch, serial: session.serial,
                expiresAt: session.expiresAt, frame: fresh };
        } catch (error) {
            if (error.code === 'DEVICE_STATE_UNCERTAIN') {
                const serials = Array.isArray(error.uncertainSerials) ? error.uncertainSerials : [];
                for (const serial of new Set([session.serial, ...serials])) quarantine(serial);
            }
            await finish(session, error.code || 'TAKEOVER_FAILED');
            throw error;
        }
    }
    async function refresh(body, { owner }) {
        fields(body, ['token', 'epoch']);
        const session = authenticate(body, owner);
        try { return { frame: await frame(session) }; }
        catch (error) {
            if (error.code === 'DEVICE_STATE_UNCERTAIN' || session.controller.signal.aborted) await finish(session, error.code);
            throw error;
        }
    }
    function actionFor(body, shot) {
        fields(body, ['command', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'duration', 'key']);
        const point = (x, y) => {
            if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= shot.width || y >= shot.height) {
                throw fail('INVALID_COORDINATES', '操作位置必须在当前接管截图内。');
            }
            const mapping = shot.mapping;
            if (!mapping || ![mapping.offsetX, mapping.offsetY, mapping.stepX, mapping.stepY].every(Number.isFinite)
                || mapping.stepX <= 0 || mapping.stepY <= 0) throw fail('TAKEOVER_FRAME_UNAVAILABLE', '截图坐标映射不完整。');
            const mapped = imagePointToDevice(mapping, x, y);
            return [mapped.x, mapped.y];
        };
        const action = { command: body.command, frameId: shot.frameId };
        if (body.command === 'Tap') {
            fields(body, ['command', 'x', 'y']);
            [action.x, action.y] = point(body.x, body.y);
        } else if (body.command === 'Swipe') {
            fields(body, ['command', 'x1', 'y1', 'x2', 'y2', 'duration']);
            [action.x1, action.y1] = point(body.x1, body.y1);
            [action.x2, action.y2] = point(body.x2, body.y2);
            if (!Number.isSafeInteger(body.duration) || body.duration < 100 || body.duration > 1500) throw fail('INVALID_ARGUMENT', '滑动时长必须为100–1500ms。');
            action.duration = body.duration;
        } else if (body.command === 'KeyEvent') {
            fields(body, ['command', 'key']);
            if (!['back', 'home', 'recents'].includes(body.key)) throw fail('INVALID_ARGUMENT', '接管仅开放返回、主页、最近任务。');
            action.key = body.key;
        } else throw fail('INVALID_ARGUMENT', '接管不支持此操作。');
        return action;
    }
    async function input(body, { owner }) {
        fields(body, ['token', 'epoch', 'frameId', 'action']);
        const session = authenticate(body, owner);
        const shot = session.frame;
        if (!shot || body.frameId !== shot.frameId || Date.now() >= shot.expiresAt) throw fail('STALE_FRAME', '接管截图已过期，请刷新后操作。');
        const action = actionFor(body.action, shot);
        session.frame = null;
        try {
            const result = await run(session, action.command, () => execute(session.serial, action));
            const execution = result.details?.execution;
            if (execution?.outcome === 'unknown') {
                quarantine(session.serial);
                throw Object.assign(fail('DEVICE_STATE_UNCERTAIN', '输入结局未知，已停止接管，禁止重放。'), { execution });
            }
            try { return { execution, frame: await frame(session) }; }
            catch (error) {
                if (error.code === 'DEVICE_STATE_UNCERTAIN' || session.controller.signal.aborted) throw error;
                return { execution, frame: null, warning: '操作已派发，快照刷新失败；请刷新后再操作。' };
            }
        } catch (error) {
            if (error.execution?.outcome === 'unknown' || error.code === 'DEVICE_STATE_UNCERTAIN') {
                quarantine(session.serial);
                await finish(session, 'DEVICE_STATE_UNCERTAIN');
            }
            throw error;
        }
    }
    async function end(body, { owner }) {
        fields(body, ['token', 'epoch']);
        const session = authenticate(body, owner);
        await finish(session);
        return { ended: true };
    }
    return Object.freeze({ start, refresh, input, end, status, assertIdle,
        management: task => stopped ? Promise.reject(fail('SERVICE_STOPPED', '安卓服务已停止。')) : runtime.runManagement(task),
        close: owner => current?.owner === owner ? finish(current, 'TAKEOVER_DISCONNECTED') : Promise.resolve(),
        stop: () => { stopped = true; return current ? finish(current, 'TAKEOVER_STOPPED') : Promise.resolve(); } });
}

module.exports = { createViewerTakeover };
