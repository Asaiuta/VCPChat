'use strict';

const { AdbError } = require('./adb-error');

const DEFAULT_MAX_QUEUE_SIZE = 64;
const REJECTION_CODES = new Set(['ADB_QUEUE_FULL', 'ADB_TIMEOUT', 'ADB_ABORTED']);

function createQueueStats() {
    return {
        peakDepth: 0, completed: 0, failed: 0,
        rejected: { ADB_QUEUE_FULL: 0, ADB_TIMEOUT: 0, ADB_ABORTED: 0 },
        failedByCode: {},
    };
}

/** Per-key FIFO; null keys are exclusive FIFO barriers across all keys. */
class AdbCommandQueue {
    constructor(maxQueueSize = DEFAULT_MAX_QUEUE_SIZE) {
        this.maxQueueSize = Number.isSafeInteger(maxQueueSize) && maxQueueSize > 0
            ? maxQueueSize : DEFAULT_MAX_QUEUE_SIZE;
        this.tail = Promise.resolve();
        this.depth = 0;
        this.pending = [];
        this.activeKeys = new Set();
        this.exclusiveRunning = false;
        this.draining = false;
        this.stats = createQueueStats();
    }

    get running() { return this.exclusiveRunning || this.activeKeys.size > 0; }

    resetStats() { this.stats = createQueueStats(); }

    push(task, deadlineMs, signal, key = null) {
        let error;
        if (signal?.aborted) error = new AdbError('ADB_ABORTED', 'adb 调用已取消。');
        else if (deadlineMs !== undefined && Date.now() >= deadlineMs) error = new AdbError('ADB_TIMEOUT', 'adb 调用在队列中已超时。');
        else if (this.depth >= this.maxQueueSize) error = new AdbError('ADB_QUEUE_FULL', 'adb 调用队列已满。');
        if (error) {
            this.stats.rejected[error.code] += 1;
            return Promise.reject(error);
        }
        if (this.depth === 0) this.tail = new Promise(resolve => { this.resolveIdle = resolve; });
        this.depth += 1;
        this.stats.peakDepth = Math.max(this.stats.peakDepth, this.depth);
        return new Promise((resolve, reject) => {
            const entry = { task, resolve, reject, deadlineMs, signal, key };
            const cancel = error => {
                const index = this.pending.indexOf(entry);
                if (index < 0) return;
                this.pending.splice(index, 1);
                this.finish(entry, error);
                this.drain();
            };
            entry.onAbort = () => cancel(new AdbError('ADB_ABORTED', 'adb 调用已取消。'));
            this.pending.push(entry);
            signal?.addEventListener('abort', entry.onAbort, { once: true });
            if (deadlineMs !== undefined) {
                entry.timer = setTimeout(() => cancel(new AdbError('ADB_TIMEOUT', 'adb 调用在队列中已超时。')),
                    Math.min(2147483647, Math.max(0, deadlineMs - Date.now())));
            }
            Promise.resolve().then(() => this.drain());
        });
    }

    cleanup(entry) {
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener('abort', entry.onAbort);
    }

    finish(entry, error, result, failed = true) {
        this.cleanup(entry);
        this.depth -= 1;
        if (failed) {
            this.stats.failed += 1;
            const code = error?.code || 'UNKNOWN';
            if (REJECTION_CODES.has(code)) this.stats.rejected[code] += 1;
            this.stats.failedByCode[code] = (this.stats.failedByCode[code] || 0) + 1;
            entry.reject(error);
        } else {
            this.stats.completed += 1;
            entry.resolve(result);
        }
        if (this.depth === 0) this.resolveIdle();
    }

    start(entry) {
        this.cleanup(entry);
        if (entry.key === null) this.exclusiveRunning = true;
        else this.activeKeys.add(entry.key);
        const complete = (error, result, failed = true) => {
            // Running cancellations retain the key until the transport actually settles.
            if (entry.key === null) this.exclusiveRunning = false;
            else this.activeKeys.delete(entry.key);
            this.finish(entry, error, result, failed);
            this.drain();
        };
        try {
            if (entry.signal?.aborted) throw new AdbError('ADB_ABORTED', 'adb 调用已取消。');
            if (entry.deadlineMs !== undefined && Date.now() >= entry.deadlineMs) {
                throw new AdbError('ADB_TIMEOUT', 'adb 调用在队列中已超时。');
            }
            Promise.resolve(entry.task()).then(result => complete(null, result, false), error => complete(error));
        } catch (error) { complete(error); }
    }

    drain() {
        if (this.draining || this.exclusiveRunning) return;
        this.draining = true;
        try {
            // The global capacity bounds the scan; no persistent map of idle serials.
            for (let i = 0; i < this.pending.length;) {
                const entry = this.pending[i];
                if (entry.key === null) {
                    if (!this.running) {
                        this.pending.splice(i, 1);
                        this.start(entry);
                        if (!this.exclusiveRunning) continue;
                    }
                    break;
                }
                if (this.activeKeys.has(entry.key)) { i += 1; continue; }
                this.pending.splice(i, 1);
                this.start(entry);
            }
        } finally { this.draining = false; }
    }
}

module.exports = { AdbCommandQueue, DEFAULT_MAX_QUEUE_SIZE };
