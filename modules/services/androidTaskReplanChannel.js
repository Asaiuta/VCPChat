'use strict';
const { randomUUID } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });

// A cancelled request waits for the upstream drain receipt while its connection
// remains alive. Entries outlive an early tool_result from runtime cancellation.
function createAndroidTaskReplanChannel() {
    const pending = new Map();
    function bind(socket, requestId) {
        let used = false;
        return async (packet, { signal, timeoutMs, onModelMetadata }) => {
            if (used) throw fail('TASK_ASSISTANCE_LIMIT');
            used = true;
            signal.throwIfAborted();
            if (socket.readyState !== 1) throw fail('TASK_ASSISTANCE_UNAVAILABLE');
            const replanId = randomUUID();
            return new Promise((resolve, reject) => {
                const abort = () => {
                    try { socket.send(JSON.stringify({ type: 'cancel_android_task_replan', data: { requestId, replanId } })); }
                    catch { finish(fail('TASK_ASSISTANCE_UNAVAILABLE')); }
                };
                const finish = (error, answer) => {
                    pending.delete(replanId); signal.removeEventListener('abort', abort);
                    if (error) reject(error); else if (signal.aborted) reject(fail('TASK_ASSISTANCE_TIMEOUT')); else resolve(answer);
                };
                pending.set(replanId, { socket, requestId, finish, onModelMetadata });
                signal.addEventListener('abort', abort, { once: true });
                try { socket.send(JSON.stringify({ type: 'android_task_replan', data: { requestId, replanId, timeoutMs, packet } })); }
                catch { finish(fail('TASK_ASSISTANCE_UNAVAILABLE')); }
            });
        };
    }
    function receive(socket, data) {
        const item = pending.get(data?.replanId);
        if (!item || item.socket !== socket || item.requestId !== data.requestId) return;
        item.onModelMetadata?.(data.metadata);
        item.finish(data.status === 'success' ? null : fail(data.code === 'TASK_REPLAN_INVALID' ? data.code : 'TASK_ASSISTANCE_FAILED'), data.answer);
    }
    function close(socket) {
        for (const item of pending.values()) if (!socket || item.socket === socket) item.finish(fail('TASK_ASSISTANCE_UNAVAILABLE'));
    }
    return { bind, receive, close };
}
module.exports = { createAndroidTaskReplanChannel };
