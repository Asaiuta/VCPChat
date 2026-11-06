'use strict';

const TYPES = Object.freeze({ 'takeover-start': 'start', 'takeover-refresh': 'refresh',
    'takeover-input': 'input', 'takeover-end': 'end' });

function attachTakeoverChannel({ socket, api, send }) {
    const controller = new AbortController();
    const requests = new Set();
    let busy = false;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        controller.abort();
        void api?.close(socket).catch(() => {});
    };
    const reply = value => {
        if (closed || socket.readyState !== 1) return;
        // A dropped write receipt cannot safely be retried. Revoke the session if
        // its bounded send queue cannot carry the receipt and new snapshot.
        if (!send(JSON.stringify(value))) {
            close();
            try { socket.close(1013, 'Takeover receipt unavailable'); } catch { /* Already closed. */ }
        }
    };
    async function message(raw, binary) {
        if (closed || binary || Buffer.byteLength(raw) > 16384) return;
        let payload;
        try { payload = JSON.parse(String(raw)); } catch { return; }
        if (!payload || !Object.hasOwn(TYPES, payload.type)) return;
        const { type, requestId, at, ...body } = payload;
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) return;
        const error = (code, text) => reply({ type: 'takeover-result', requestId, ok: false, code, error: text });
        if (!api) { error('TAKEOVER_UNAVAILABLE', '当前宿主不支持人工接管。'); return; }
        if (requests.has(requestId)) { error('TAKEOVER_REPLAY_REJECTED', '重复请求已拒绝，不重放操作。'); return; }
        if (requests.size >= 512) {
            close();
            try { socket.close(1008, 'Takeover request limit'); } catch { /* Already closed. */ }
            return;
        }
        requests.add(requestId);
        if (busy && type !== 'takeover-end') { error('DEVICE_BUSY', '上一次接管操作尚未结束。'); return; }
        if (type !== 'takeover-end') busy = true;
        try {
            const value = await api[TYPES[type]](body, { owner: socket, signal: controller.signal, notify: reply });
            reply({ type: 'takeover-result', requestId, ok: true, ...value });
        } catch (cause) {
            reply({ type: 'takeover-result', requestId, ok: false, code: cause.code || 'TAKEOVER_FAILED',
                error: cause.code ? cause.message.split('\n')[0] : '人工接管未完成，请重新观察。',
                ...(cause.execution ? { execution: cause.execution } : {}) });
        } finally { if (type !== 'takeover-end') busy = false; }
    }
    socket.on('message', message);
    socket.on('close', close);
    socket.on('error', close);
    return close;
}

module.exports = { attachTakeoverChannel };
