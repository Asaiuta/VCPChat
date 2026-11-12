'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict');
const S = require('../android-j02/storage.cjs');
const { parseSafety } = require('../verify-android-m15.cjs');
const { PACKAGE, PEER } = require('./cases.cjs');
function parseArgs(argv) {
    const options = { matrix: 'journeys', contentRuntime: 'native' }, seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]; assert.ok(!seen.has(flag), 'Duplicate option'); seen.add(flag);
        if (flag === '--install') { options.install = true; continue; }
        const key = { '--serial': 'serial', '--adb': 'adb', '--output': 'output', '--apk': 'apk', '--peer-apk': 'peerApk', '--matrix': 'matrix', '--content-runtime': 'contentRuntime', '--only': 'only' }[flag];
        assert.ok(key && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Unknown or missing option'); options[key] = argv[++i];
    }
    assert.match(options.serial || '', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    for (const key of ['adb', 'output', 'apk']) assert.ok(options[key], `Required ${key}`);
    assert.ok(['journeys', 'm5', 'm15'].includes(options.matrix)); assert.ok(['native', '32'].includes(options.contentRuntime));
    if (options.matrix === 'journeys') assert.ok(options.peerApk, 'Required peer APK');
    for (const key of ['adb', 'output', 'apk', 'peerApk']) if (options[key]) options[key] = path.resolve(options[key]);
    return options;
}
function createDevice(options, emit, spawnSync = cp.spawnSync) {
    const queryArgs = pkg => ['shell', ...(options.contentRuntime === '32'
        ? ['CLASSPATH=/system/framework/content.jar', 'app_process32', '/system/bin', 'com.android.commands.content.Content'] : ['content']), 'query', '--uri', `content://${pkg}.state/state`];
    const exec = args => {
        const result = spawnSync(options.adb, ['-s', options.serial, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
        // Dumpsys may include unrelated app metadata: only record selected outputs below.
        if (result.status !== 0 || result.error || result.signal) {
            emit('transport', { args, exit: result.status, error: result.error?.code, signal: result.signal, stderr: result.stderr });
            throw Object.assign(Error('Device command failed'), { code: 'DEVICE_COMMAND_FAILED' });
        }
        return String(result.stdout).trim();
    };
    const gate = pkg => {
        const w = exec(['shell', 'dumpsys', 'window', 'displays']);
        const safety = parseSafety(w, exec(['shell', 'dumpsys', 'power']), exec(['shell', 'dumpsys', 'window', 'policy']));
        assert.ok(safety.awake && safety.unlocked, 'Device not proven awake and unlocked');
        if (pkg) {
            assert.ok([PACKAGE, PEER].includes(pkg));
            const focus = w.split(/\r?\n/).filter(line => /mCurrentFocus=/.test(line));
            assert.ok(focus.length === 1 && focus[0].includes(` u0 ${pkg}/`), 'Unexpected foreground');
        }
    };
    const parseState = (pkg, result) => {
        const match = /^Row: 0 state=(\{[^\r\n]*\})$/.exec(result);
        assert.ok(match, 'Invalid independent provider output'); const state = JSON.parse(match[1]);
        assert.equal(state.ready, true); assert.equal(state.protocol, 1); assert.equal(state.package, pkg); assert.match(state.session, /^[a-f0-9-]{36}$/i);
        emit('independent', state); return state;
    };
    const read = (pkg = PACKAGE) => {
        assert.ok([PACKAGE, PEER].includes(pkg)); return parseState(pkg, exec(queryArgs(pkg)));
    };
    // An in-flight observer must not block the host RPC/abort event loop.
    const readAsync = async (pkg = PACKAGE) => {
        assert.ok([PACKAGE, PEER].includes(pkg)); const args = queryArgs(pkg);
        const output = await new Promise((resolve, reject) => cp.execFile(options.adb, ['-s', options.serial, ...args],
            { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) { emit('transport', { args, exit: error.code, signal: error.signal, stderr }); reject(Object.assign(Error('Device command failed'), { code: 'DEVICE_COMMAND_FAILED' })); }
                else resolve(String(stdout).trim());
            }));
        return parseState(pkg, output);
    };
    const apkSha = pkg => {
        assert.ok([PACKAGE, PEER].includes(pkg));
        const locations = exec(['shell', 'pm', 'path', pkg]).split(/\r?\n/); assert.equal(locations.length, 1);
        const remote = locations[0].replace(/^package:/, ''); assert.match(remote, /^\/data\/[A-Za-z0-9_./=+~-]+\.apk$/);
        return exec(['shell', 'sha256sum', remote]).split(/\s+/)[0];
    };
    const ensureRpc = () => {
        const local = path.resolve(__dirname, '../../VCPDistributedServer/Plugin/AndroidController/vendor/u2-server-0.5.0.apk');
        const remote = '/data/local/tmp/u2-server-0.5.0.apk';
        const presence = exec(['shell', `[ -f ${remote} ] && echo PRESENT || echo ABSENT`]);
        assert.ok(['PRESENT', 'ABSENT'].includes(presence), 'RPC presence unknown');
        if (presence === 'ABSENT') {
            assert.equal(options.install, true, 'RPC artifact missing; --install provisions the bundled artifact');
            exec(['push', local, remote]); emit('provision-rpc', { remote });
        }
        assert.equal(exec(['shell', 'sha256sum', remote]).split(/\s+/)[0], S.sha(fs.readFileSync(local)), 'Existing RPC artifact identity differs');
    };
    return { exec, gate, read, readAsync, apkSha, queryArgs,
        async prepare() {
            gate();
            for (const [pkg, file] of [[PACKAGE, options.apk], ...(options.peerApk ? [[PEER, options.peerApk]] : [])]) {
                if (options.install) { const output = exec(['install', '-r', file]); emit('install', { package: pkg, output }); assert.ok(output.includes('Success')); }
                assert.equal(apkSha(pkg), S.sha(fs.readFileSync(file)), 'Installed APK does not match frozen artifact');
            }
            ensureRpc();
        },
        reset(variant) {
            gate(); exec(['shell', 'am', 'force-stop', PACKAGE]);
            const args = variant.startsWith('m5:') ? ['--es', 'fixtureMode', 'm5', '--es', 'm5Variant', variant.slice(3)]
                : variant === 'gestures' ? ['--es', 'fixtureMode', 'gestures'] : ['--es', 'fixtureMode', 'journey', '--es', 'journeyVariant', variant];
            exec(['shell', 'am', 'start', '-W', '-n', `${PACKAGE}/.MainActivity`, ...args]); gate(PACKAGE);
            const state = read(); assert.equal(state.resumed, true);
            if (!variant.startsWith('m5:') && variant !== 'gestures') { assert.equal(state.mode, 'journey'); assert.equal(state.journey.version, 1); assert.equal(state.journey.variant, variant); }
            return state;
        },
        launchPeer() { gate(PACKAGE); exec(['shell', 'am', 'force-stop', PEER]); exec(['shell', 'am', 'start', '-W', '-n', `${PEER}/com.vcpchat.m15fixture.PeerActivity`]); gate(PEER); assert.equal(read(PEER).resumed, true); },
        legacySpawn(file, args, opts) {
            const expected = ['-s', options.serial, 'shell', 'content', 'query', '--uri', `content://${PACKAGE}.state/state`];
            if (JSON.stringify(args) === JSON.stringify(expected)) args = ['-s', options.serial, ...queryArgs(PACKAGE)];
            return spawnSync(file, args, opts);
        },
    };
}
module.exports = { parseArgs, createDevice };
