'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { traceEventLimit } = require('./androidTaskBudget');
const { failure, requireValid, record } = require('./androidTaskTraceData');
const { headerSnapshot, eventForTask } = require('./androidTaskTraceSchema');

const MAX_BYTES = 512 * 1024;
const TERMINAL_RESERVE_BYTES = 4096;

function encode(record) { return `${JSON.stringify(record)}\n`; }

function createTaskTraceStore(options) {
    const config = record(options, ['directory'], ['directory']);
    requireValid(typeof config.directory === 'string' && config.directory.length > 0 && !config.directory.includes('\0'));
    const directory = path.resolve(config.directory);
    return {
        async open(header) {
            const ui = Object.getOwnPropertyDescriptor(header || {}, 'intent')?.value === 'ui_task';
            const schema = ui ? require('./androidUiTaskTrace') : { headerSnapshot, eventForTask };
            const snapshot = schema.headerSnapshot(header);
            header = undefined;
            const firstLine = encode({ type: 'task', seq: 0, ...snapshot });
            let bytes = Buffer.byteLength(firstLine);
            if (bytes > MAX_BYTES) throw failure('TRACE_LIMIT');
            let handle;
            try {
                await fs.mkdir(directory, { recursive: true });
                handle = await fs.open(path.join(directory, `${snapshot.taskId}.jsonl`), 'wx', 0o600);
            } catch (error) { throw failure(error.code === 'EEXIST' ? 'TRACE_EXISTS' : 'TRACE_OPEN_FAILED'); }
            try { await handle.writeFile(firstLine, 'utf8'); }
            catch {
                await handle.close().catch(() => {});
                throw failure('TRACE_WRITE_FAILED');
            }
            // A host readiness window consumes at least one observation before
            // emitting a wait. It does not consume a model-call event slot.
            const maxEvents = traceEventLimit(snapshot.budget) + (ui ? snapshot.budget.maxObservations + 3 : 0);
            let count = 0;
            let failed = false;
            let closing = false;
            let inFlight = null;
            let closePromise;
            return {
                async append(event) {
                    if (failed) throw failure('TRACE_WRITE_FAILED');
                    if (closing) throw failure('TRACE_CLOSED');
                    if (inFlight) throw failure('TRACE_BUSY');
                    const copy = schema.eventForTask(event, snapshot);
                    event = undefined;
                    const line = encode({ ...copy, seq: count + 1 });
                    const size = Buffer.byteLength(line);
                    const terminal = copy.type === 'stopped' || copy.type === 'completed';
                    // Ordinary events cannot consume the last slot or the bytes needed
                    // to explain why the task stopped. This does not buffer events in RAM.
                    if (count >= maxEvents - (terminal ? 0 : 1)
                        || bytes + size > MAX_BYTES - (terminal ? 0 : TERMINAL_RESERVE_BYTES)) throw failure('TRACE_LIMIT');
                    const operation = Promise.resolve().then(() => handle.writeFile(line, 'utf8')).then(() => {
                        count += 1;
                        bytes += size;
                    }, () => {
                        failed = true;
                        throw failure('TRACE_WRITE_FAILED');
                    });
                    inFlight = operation;
                    try { await operation; }
                    finally { inFlight = null; }
                },
                async close() {
                    if (!closePromise) {
                        closing = true;
                        closePromise = (async () => {
                            if (inFlight) await inFlight.catch(() => {});
                            try { await handle.close(); }
                            catch { throw failure('TRACE_CLOSE_FAILED'); }
                        })();
                    }
                    await closePromise;
                }
            };
        }
    };
}

module.exports = { createTaskTraceStore };
