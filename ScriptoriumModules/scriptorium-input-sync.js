'use strict';

((root, factory) => {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ScriptoriumInputSync = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    /**
     * 管理 contenteditable 的“视觉输入态”和“源码提交态”。
     *
     * 该模块故意不理解编辑器的源码格式：
     * - 浏览器原生 DOM 是输入期间的视觉真相；
     * - snapshot() 负责读取当前 DOM；
     * - commit() 负责把最新快照写入对应模型；
     * - 同一编辑目标的多次 input 只保留最后一个待提交快照。
     */
    function createInputSync(options = {}) {
        const protocol = options.verifiedKernel;
        if (protocol && (!protocol.createInputMailbox || !protocol.readInputMailbox
            || !protocol.publishInputMailbox || !protocol.stepInputMailbox || !protocol.INPUT_ACTION)) {
            throw new TypeError('The verified input protocol is unavailable.');
        }
        const actions = protocol?.INPUT_ACTION;
        const delay = Number.isFinite(options.delay)
            ? Math.max(0, options.delay)
            : 0;
        const requestFrame = typeof window !== 'undefined'
            && typeof window.requestAnimationFrame === 'function'
            ? window.requestAnimationFrame.bind(window)
            : (callback) => setTimeout(callback, 0);
        const cancelFrame = typeof window !== 'undefined'
            && typeof window.cancelAnimationFrame === 'function'
            ? window.cancelAnimationFrame.bind(window)
            : (handle) => clearTimeout(handle);

        const state = {
            entries: new Map(),
            frame: 0,
            timer: 0,
            disposed: false,
        };

        function assertActive() {
            if (state.disposed) {
                throw new Error('Input sync has been disposed.');
            }
        }

        function now() {
            return Date.now();
        }

        function entryFor(target, create = true) {
            if (!target) return null;
            let entry = state.entries.get(target);
            if (!entry && create) {
                entry = {
                    target,
                    lastInputAt: 0,
                    compositionEpoch: 0,
                    ...(protocol ? { mailbox: protocol.createInputMailbox() }
                        : { composing: false, dirty: false, pending: null }),
                };
                if (protocol) Object.defineProperties(entry, {
                    composing: { get: () => protocol.readInputMailbox(entry.mailbox).composing },
                    dirty: { get: () => protocol.readInputMailbox(entry.mailbox).dirty },
                });
                state.entries.set(target, entry);
            }
            return entry;
        }

        function advance(entry, action, token = 0) {
            const next = protocol.stepInputMailbox(entry.mailbox, action, token);
            if (!next) throw new Error('Input mailbox rejected its action or token.');
            entry.mailbox = next;
            return protocol.readInputMailbox(next);
        }

        function publish(entry, snapshot, ending = false) {
            const next = protocol.publishInputMailbox(entry.mailbox, snapshot, ending);
            if (!next) throw new Error('Input mailbox exhausted its version range.');
            entry.mailbox = next;
            return protocol.readInputMailbox(next);
        }

        function snapshotOf(entry, event = null) {
            if (typeof options.snapshot !== 'function') return null;
            return options.snapshot(entry.target, event);
        }

        function notifyVisual(entry, event, snapshot) {
            options.onVisualInput?.({
                target: entry.target,
                event,
                snapshot,
                composing: entry.composing,
                timestamp: now(),
            });
        }

        function schedule() {
            if (state.disposed || state.frame || state.timer) return;
            const run = () => {
                state.frame = 0;
                state.timer = 0;
                flush();
            };
            if (delay > 0) {
                state.timer = setTimeout(run, delay);
            } else {
                state.frame = requestFrame(run);
            }
        }

        function markInput(target, event = null) {
            assertActive();
            const entry = entryFor(target);
            if (!entry) return false;

            const snapshot = snapshotOf(entry, event);
            if (protocol) {
                publish(entry, snapshot);
                entry.lastInputAt = now();
                notifyVisual(entry, event, snapshot);
                if (!entry.composing) schedule();
                return true;
            }
            // 视觉反馈永远先于源码提交调度。
            notifyVisual(entry, event, snapshot);

            entry.lastInputAt = now();
            entry.dirty = true;
            entry.pending = snapshot;
            if (!entry.composing) schedule();
            return true;
        }

        function compositionStart(target, event = null) {
            assertActive();
            const entry = entryFor(target);
            if (!entry) return false;
            entry.compositionEpoch += 1;
            if (protocol) advance(entry, actions.START);
            else entry.composing = true;
            options.onCompositionStart?.({
                target,
                event,
                epoch: entry.compositionEpoch,
            });
            return true;
        }

        function compositionEnd(target, event = null) {
            assertActive();
            const entry = entryFor(target, false);
            if (!entry) return false;
            if (protocol) {
                const snapshot = snapshotOf(entry, event);
                publish(entry, snapshot, true);
                options.onCompositionEnd?.({ target, event, epoch: entry.compositionEpoch, snapshot });
                schedule();
                return true;
            }
            entry.composing = false;
            // compositionend 本身不假设 DOM 已经收到最终 input；先取一次
            // 快照，再安排一帧提交。迟到的最终 input 会覆盖 pending。
            entry.pending = snapshotOf(entry, event);
            entry.dirty = true;
            options.onCompositionEnd?.({
                target,
                event,
                epoch: entry.compositionEpoch,
                snapshot: entry.pending,
            });
            schedule();
            return true;
        }

        function flushEntry(entry) {
            if (!entry?.dirty || entry.composing) return false;
            if (protocol) {
                if (options.canCommit?.(entry.target) === false) return false;
                if (protocol.readInputMailbox(entry.mailbox).hasLease || typeof options.commit !== 'function') return false;
                const delivery = advance(entry, actions.ACQUIRE);
                if (!delivery.hasLease) return false;
                const token = delivery.lease;
                try {
                    const accepted = options.commit({ target: entry.target,
                        snapshot: delivery.leasedPayload, lastInputAt: entry.lastInputAt });
                    // Reentry can replace entry.mailbox. Confirm this old receipt
                    // against the current mailbox, preserving any newer payload.
                    advance(entry, accepted === false ? actions.FAIL : actions.ACK, token);
                    return accepted !== false;
                } catch (error) {
                    if (protocol.readInputMailbox(entry.mailbox).lease === token) advance(entry, actions.FAIL, token);
                    throw error;
                }
            }
            const pending = entry.pending;
            entry.dirty = false;
            entry.pending = null;
            if (typeof options.commit !== 'function') return false;
            options.commit({
                target: entry.target,
                snapshot: pending,
                lastInputAt: entry.lastInputAt,
            });
            return true;
        }

        function flush(target = null) {
            assertActive();
            if (target) {
                return flushEntry(entryFor(target, false));
            }
            let changed = false;
            state.entries.forEach((entry) => {
                changed = flushEntry(entry) || changed;
            });
            return changed;
        }

        function unbind(target) {
            const entry = entryFor(target, false);
            if (!entry) return false;
            flushEntry(entry);
            if (protocol && (entry.composing || entry.dirty || protocol.readInputMailbox(entry.mailbox).hasLease)) return false;
            state.entries.delete(target);
            return true;
        }

        function dispose() {
            if (state.disposed) return;
            if (protocol) {
                state.entries.forEach(entry => flushEntry(entry));
                if ([...state.entries.values()].some(entry => entry.composing || entry.dirty
                    || protocol.readInputMailbox(entry.mailbox).hasLease)) return false;
            }
            if (state.frame) cancelFrame(state.frame);
            if (state.timer) clearTimeout(state.timer);
            state.frame = 0;
            state.timer = 0;
            state.entries.forEach((entry) => flushEntry(entry));
            state.entries.clear();
            state.disposed = true;
        }

        return Object.freeze({
            markInput,
            compositionStart,
            compositionEnd,
            flush,
            unbind,
            dispose,
            hasPending() {
                return [...state.entries.values()].some(entry => entry.dirty || entry.composing
                    || (protocol && protocol.readInputMailbox(entry.mailbox).hasLease));
            },
            isComposing(target) {
                return Boolean(entryFor(target, false)?.composing);
            },
        });
    }

    return Object.freeze({
        createInputSync,
    });
});