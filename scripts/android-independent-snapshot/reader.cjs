'use strict';
// Validation-only, one-shot Android reader. No input calls or automatic retries.
const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const CLASS = 'com.vcpchat.validation.Snapshot';

function createSnapshotReader({ jar, executeAdb }) {
    const hash = createHash('sha256').update(fs.readFileSync(jar)).digest('hex');
    const name = `vcp-snapshot-${randomBytes(12).toString('hex')}`;
    const remote = `/data/local/tmp/${name}-${hash.slice(0, 16)}.jar`;
    let uploaded = false;
    let state = 'new';
    const checked = args => {
        const r = executeAdb(args, true, 5000);
        if (r.error || r.signal || r.status !== 0) throw fail('INDEPENDENT_SNAPSHOT_ADB_FAILED');
        return String(r.stdout || '');
    };
    const absent = () => !checked(['shell', 'ps', '-A', '-o', 'ARGS']).split(/\r?\n/)
        .some(line => line.trim().split(/\s+/)[0] === name);
    return {
        identity: { sha256: hash, processName: name, remotePath: remote },
        prepare() {
            if (state !== 'new') throw fail('INDEPENDENT_SNAPSHOT_STATE');
            if (!absent()) throw fail('INDEPENDENT_SNAPSHOT_BUSY');
            // Unique per run; no old artifact can satisfy this read.
            uploaded = true;
            checked(['push', jar, remote]);
            if (checked(['shell', 'sha256sum', remote]).trim().split(/\s+/)[0] !== hash) throw fail('INDEPENDENT_SNAPSHOT_HASH');
            state = 'ready';
        },
        execute(timeout) {
            if (state !== 'ready') throw fail('INDEPENDENT_SNAPSHOT_STATE');
            if (!absent()) throw fail('INDEPENDENT_SNAPSHOT_BUSY');
            state = 'unknown';
            const result = executeAdb(['shell', `CLASSPATH=${remote}:/system/framework/uiautomator.jar`,
                'app_process', '/system/bin', `--nice-name=${name}`, CLASS], true, timeout);
            // An ADB timeout is not an exit proof. Even an exited client must leave
            // no named reader process; otherwise the batch cannot continue.
            const gone = absent();
            if (!gone) throw fail('INDEPENDENT_SNAPSHOT_EXIT_UNPROVEN');
            state = 'ready';
            return result;
        },
        cleanup() {
            if (!uploaded) return { removed: true, processAbsent: true };
            if (!absent()) throw fail('INDEPENDENT_SNAPSHOT_EXIT_UNPROVEN');
            checked(['shell', 'rm', '-f', remote]);
            checked(['shell', 'test', '!', '-e', remote]);
            state = 'closed';
            return { removed: true, processAbsent: true };
        },
    };
}
module.exports = { createSnapshotReader };
