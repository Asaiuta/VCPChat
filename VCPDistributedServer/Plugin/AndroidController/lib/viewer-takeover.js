'use strict';

const { randomBytes } = require('node:crypto');

const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEYCODES = Object.freeze({ back: 4, home: 3, recents: 187 });
const TOUCH = Object.freeze({ down: 0, up: 1, move: 2 });
const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = (value, allowed) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.includes(key))) throw fail('INVALID_ARGUMENT', '接管请求字段无效。');
};

// A read-stream cookie never grants write ownership. The native host approves a
// bounded session that holds the runtime takeover lease; input then streams through
// the scrcpy control socket. Package deny/read-only policy is enforced against a
// periodically sampled foreground package; a pointer can only go down while that
// sample is fresh and allowed. Socket writes are dispatch-only, never verified.
function createViewerTakeover({ runtime, selectedSerial, authorize, control, checkPolicy,
    invalidate, assertCertain, quarantine, sessionMs = 600000, operationMs = 15000,
    policyIntervalMs = 1000, policyFreshMs = 3000 }) {
    let current = null;
    let stopped = false;
    let generation = 0;
    const status = () => ({ available: Boolean(authorize), state: current?.phase || 'idle',
        serial: current?.serial || null, epoch: generation, mode: 'live' });
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
    function releasePointer(session) {
        const pointer = session.pointer;
        session.pointer = null;
        if (!pointer) return;
        try { control().injectTouch({ ...pointer, action: TOUCH.up }); } catch { /* Control loss ends the gesture on device. */ }
    }
    function finish(session, code = 'TAKEOVER_ENDED') {
        if (session.ending) return session.ending;
        if (session.phase === 'human') releasePointer(session);
        session.phase = 'ending';
        clearTimeout(session.timer);
        clearTimeout(session.policyTimer);
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
    async function samplePolicy(session) {
        try {
            const pkg = await checkPolicy(session.serial, session.controller.signal);
            if (session.phase !== 'human' || current !== session) return;
            session.policy = { ok: true, package: pkg, at: Date.now() };
        } catch (error) {
            if (session.phase !== 'human' || current !== session) return;
            const previous = session.policy;
            session.policy = { ok: false, code: error.code || 'POLICY_UNAVAILABLE', at: Date.now() };
            if (error.code === 'POLICY_DENIED' && session.pointer) releasePointer(session);
            if (previous?.ok !== false || previous.code !== session.policy.code) {
                session.notify?.({ type: 'takeover-blocked', code: session.policy.code,
                    error: error.code === 'POLICY_DENIED' ? '前台应用受包策略限制，接管输入已暂停。' : '无法确认前台应用，接管输入已暂停。' });
            }
        }
    }
    function schedulePolicy(session) {
        session.policyTimer = setTimeout(async () => {
            if (session.phase !== 'human' || current !== session) return;
            await samplePolicy(session);
            if (session.phase === 'human' && current === session) schedulePolicy(session);
        }, policyIntervalMs);
        session.policyTimer.unref?.();
    }
    function assertWritable(session) {
        const policy = session.policy;
        if (!policy?.ok || Date.now() - policy.at > policyFreshMs) {
            throw fail(policy?.code || 'POLICY_STALE', '前台应用策略未确认，暂不接受新的触摸。');
        }
    }
    function videoSize() {
        const hub = control();
        if (!hub?.controlReady?.()) throw fail('SCRCPY_CONTROL_UNAVAILABLE', '实时控制通道未就绪；需要 H.264 画面。');
        return { width: hub.width, height: hub.height };
    }
    async function start(body, { owner, signal, notify } = {}) {
        if (stopped) throw fail('SERVICE_STOPPED', '安卓服务已停止。');
        fields(body, ['serial']);
        if (!owner || !signal || !SERIAL.test(body.serial || '') || body.serial === '__auto__') throw fail('INVALID_ARGUMENT', '接管必须显式绑定显示中的设备。');
        assertIdle();
        if (selectedSerial() !== body.serial) throw fail('TAKEOVER_DEVICE_CHANGED', '只能接管当前显示的设备。');
        if (!authorize) throw fail('HUMAN_INTERACTION_UNAVAILABLE', '当前宿主没有可信的人工授权通道。');
        assertCertain(body.serial);
        videoSize();
        const session = { owner, serial: body.serial, phase: 'draining', epoch: ++generation,
            token: randomBytes(32).toString('hex'), controller: new AbortController(), notify,
            expiresAt: Date.now() + sessionMs, pointer: null, policy: null };
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
            const result = await runtime.runTakeover(session.handle, { timeoutMs: 60000, signal: session.controller.signal,
                outcome: 'observed', actionCommand: 'takeoverApproval' }, async () => ({ content: [], details: {
                approved: await authorize(session.serial) === true,
            } }));
            live(session);
            if (!result.details.approved) throw fail('POLICY_REJECTED', '用户拒绝人工接管。');
            session.phase = 'human';
            await samplePolicy(session);
            live(session);
            schedulePolicy(session);
            return { token: session.token, epoch: session.epoch, serial: session.serial,
                expiresAt: session.expiresAt, mode: 'live', video: videoSize(),
                policy: session.policy.ok ? 'allowed' : session.policy.code };
        } catch (error) {
            if (error.code === 'DEVICE_STATE_UNCERTAIN') {
                const serials = Array.isArray(error.uncertainSerials) ? error.uncertainSerials : [];
                for (const serial of new Set([session.serial, ...serials])) quarantine(serial);
            }
            await finish(session, error.code || 'TAKEOVER_FAILED');
            throw error;
        }
    }
    function touch(body, { owner }) {
        fields(body, ['token', 'epoch', 'action', 'x', 'y', 'width', 'height']);
        const session = authenticate(body, owner);
        const action = TOUCH[body.action];
        if (action === undefined) throw fail('INVALID_ARGUMENT', '触摸动作必须为 down/move/up。');
        const { width, height } = videoSize();
        // The client reports pixels of the frame it displays (H.264 canvas or JPEG
        // fallback). Scale to the encoder frame; a different aspect means rotation.
        if (![body.width, body.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16384)) {
            throw fail('INVALID_ARGUMENT', '画面尺寸无效。');
        }
        if (Math.abs(body.width / body.height - width / height) > 0.02 * (width / height)) {
            releasePointer(session);
            throw fail('VIDEO_SIZE_CHANGED', '画面方向或尺寸已变化，本次手势已抬起。');
        }
        if (![body.x, body.y].every(Number.isSafeInteger) || body.x < 0 || body.y < 0 || body.x >= body.width || body.y >= body.height) {
            throw fail('INVALID_COORDINATES', '触摸位置必须在当前画面内。');
        }
        const pointer = { x: Math.min(width - 1, Math.floor(body.x * width / body.width)),
            y: Math.min(height - 1, Math.floor(body.y * height / body.height)), width, height };
        if (action === TOUCH.down) {
            if (session.pointer) releasePointer(session);
            assertWritable(session);
            control().injectTouch({ ...pointer, action });
            session.pointer = pointer;
        } else {
            // Without an accepted down, move/up must not reach the device.
            if (!session.pointer) return;
            control().injectTouch({ ...pointer, action });
            session.pointer = action === TOUCH.up ? null : pointer;
        }
        invalidate(session.serial);
    }
    function key(body, { owner }) {
        fields(body, ['token', 'epoch', 'key']);
        const session = authenticate(body, owner);
        const keycode = Object.hasOwn(KEYCODES, body.key) ? KEYCODES[body.key] : null;
        if (keycode === null) throw fail('INVALID_ARGUMENT', '接管仅开放返回、主页、最近任务。');
        videoSize();
        assertWritable(session);
        control().injectKeycode(0, keycode);
        control().injectKeycode(1, keycode);
        invalidate(session.serial);
    }
    async function end(body, { owner }) {
        fields(body, ['token', 'epoch']);
        const session = authenticate(body, owner);
        await finish(session);
        return { ended: true };
    }
    return Object.freeze({ start, touch, key, end, status, assertIdle,
        management: task => stopped ? Promise.reject(fail('SERVICE_STOPPED', '安卓服务已停止。')) : runtime.runManagement(task),
        close: owner => current?.owner === owner ? finish(current, 'TAKEOVER_DISCONNECTED') : Promise.resolve(),
        stop: () => { stopped = true; return current ? finish(current, 'TAKEOVER_STOPPED') : Promise.resolve(); } });
}

module.exports = { createViewerTakeover, KEYCODES };
