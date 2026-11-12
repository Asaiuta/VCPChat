'use strict';

// Research-only parsing. No production display guards are relaxed here.
const fail = code => Object.assign(new Error(code), { code });
const PACKAGE = 'com.vcpchat.m4fixture';

function installedApkPath(result) {
    const match = /^package:(\/data\/app\/[A-Za-z0-9._=+~\/-]+\/base\.apk)\s*$/.exec(result.stdout);
    if (result.code !== 0 || result.stderr.trim() || !match) throw fail('INSTALLED_FIXTURE_PATH_UNPROVEN');
    return match[1];
}

function parseArgs(argv) {
    const result = { mode: 'baseline', adb: 'D:/AI/tools/platform-tools/adb.exe' };
    const seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (!['--serial', '--output', '--adb', '--mode', '--apk', '--ffmpeg', '--use-installed-fixture'].includes(key) || seen.has(key)) throw fail('INVALID_OPTION');
        seen.add(key);
        if (key === '--use-installed-fixture') { result.useInstalledFixture = true; continue; }
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw fail('MISSING_OPTION_VALUE');
        result[key.slice(2)] = value;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.serial || '')) throw fail('EXPLICIT_SERIAL_REQUIRED');
    if (!result.output) throw fail('OUTPUT_REQUIRED');
    if (!['baseline', 'overlay', 'new-display', 'focus1'].includes(result.mode)) throw fail('INVALID_MODE');
    if (result.mode !== 'baseline' && (!result.apk || !result.ffmpeg)) throw fail('FIXTURE_AND_DECODER_REQUIRED');
    return result;
}

function displayFlags(displayText, uniqueId) {
    if (!uniqueId) return [];
    const lines = displayText.split(/\r?\n/).filter(line => /^\s*DisplayDeviceInfo\{/.test(line) && line.includes(`uniqueId="${uniqueId}"`));
    return lines.length === 1 ? [...new Set(lines[0].match(/\bFLAG_[A-Z_]+\b/g) || [])] : [];
}
function requireFocusFlags(target) {
    if (!['FLAG_TRUSTED', 'FLAG_OWN_FOCUS', 'FLAG_STEAL_TOP_FOCUS_DISABLED'].every(flag => target?.flags?.includes(flag))) throw fail('FOCUS_FLAGS_UNPROVEN');
}
function validateFocusBuild(build, hash) {
    if (build.candidate !== 'scrcpy-5.0.1-focus1' || build.upstreamCommit !== 'a60891aea193d92e7e5c3942700eca63f9d19a5f'
        || build.sha256 !== hash) throw fail('FOCUS_SERVER_IDENTITY_UNPROVEN');
}
function inventory(windowText, displayText, sfText) {
    for (const text of [windowText, displayText, sfText]) if (/DUMP TIMEOUT|Permission Denial|Can't find service/i.test(text)) throw fail('DISPLAY_DUMP_FAILED');
    const windows = [...windowText.matchAll(/^\s*Display: mDisplayId=(\d+)(?: \(organized\))?\s*$/gm)];
    if (!windows.length) throw fail('DISPLAY_LIST_UNPROVEN');
    const sfIds = [...sfText.matchAll(/^Display (\d+) \(HWC display \d+\):/gm)].map(m => m[1]);
    const ids = new Set();
    return windows.map((match, index) => {
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id) || ids.has(id)) throw fail('AMBIGUOUS_DISPLAY_ID');
        ids.add(id);
        const block = windowText.slice(match.index, windows[index + 1]?.index ?? windowText.length);
        const sizes = [...block.matchAll(/\bcur=(\d+)x(\d+)\b/g)];
        const focus = [...block.matchAll(/^\s*mCurrentFocus=([^\r\n]*)/gm)];
        if (sizes.length !== 1 || focus.length !== 1) throw fail('DISPLAY_GEOMETRY_OR_FOCUS_UNPROVEN');
        if (![Number(sizes[0][1]), Number(sizes[0][2])].every(n => Number.isSafeInteger(n) && n > 0)) throw fail('DISPLAY_GEOMETRY_OR_FOCUS_UNPROVEN');
        const logical = new RegExp('^  Display ' + id + ':\\r?\\n([\\s\\S]*?)(?=^  \\S|$(?![\\s\\S]))', 'm').exec(displayText)?.[1];
        const unique = logical && /^\s*mPrimaryDisplayDevice=.*\(([^()]+)\)\s*$/m.exec(logical)?.[1];
        const sfId = unique?.startsWith('local:') && sfIds.includes(unique.slice(6)) ? unique.slice(6) : null;
        return { logicalId: id, uniqueId: unique || null, surfaceFlingerId: sfId, flags: displayFlags(displayText, unique),
            size: { width: Number(sizes[0][1]), height: Number(sizes[0][2]) }, focus: focus[0][1].trim() };
    });
}

function physical(infos) {
    const found = infos.filter(d => d.logicalId === 0);
    if (found.length !== 1 || !found[0].uniqueId || !/^Window\{/.test(found[0].focus)) throw fail('PHYSICAL_CONTEXT_UNPROVEN');
    return found[0];
}
function samePhysical(before, after) {
    return before.uniqueId === after.uniqueId && before.focus === after.focus
        && before.size.width === after.size.width && before.size.height === after.size.height;
}
function newDisplay(before, after) {
    const added = after.filter(d => !before.some(old => old.logicalId === d.logicalId));
    if (added.length !== 1 || added[0].logicalId === 0 || !added[0].uniqueId) throw fail('NEW_DISPLAY_UNPROVEN');
    return added[0];
}
function sameTarget(target, infos) {
    const matches = infos.filter(d => d.logicalId === target.logicalId);
    return matches.length === 1 && matches[0].uniqueId === target.uniqueId
        && matches[0].size.width === target.size.width && matches[0].size.height === target.size.height;
}
function fixtureState(text, displayId) {
    const match = /^Row: 0 json=(\{[^\r\n]*\})\s*$/.exec(text.trim());
    let data;
    try { data = JSON.parse(match?.[1]); } catch { throw fail('FIXTURE_UNREADABLE'); }
    if (data.schemaVersion !== 1 || data.package !== PACKAGE || !Array.isArray(data.states)) throw fail('FIXTURE_INVALID');
    if (data.captureStatus !== 'fresh' || !/^[a-f0-9-]{36}$/i.test(data.processSession || '')
        || !Number.isSafeInteger(data.capturedAtUptimeMs) || data.capturedAtUptimeMs < 0) throw fail('FIXTURE_CAPTURE_STALE');
    const candidates = data.states.filter(s => s.displayId === displayId && s.destroyed === false);
    if (candidates.length !== 1) throw fail('FIXTURE_AMBIGUOUS');
    const state = candidates[0];
    if (state.resumed !== true || !Number.isSafeInteger(state.taps) || state.taps < 0 || !Array.isArray(state.touchDisplayIds)
        || !state.touchDisplayIds.every(id => id === displayId) || !/^[a-f0-9-]{36}$/i.test(state.session)
        || !Number.isSafeInteger(state.taskId) || state.taskId < 0
        || !Number.isSafeInteger(state.touchEventCount) || state.touchEventCount < 0
        || !Array.isArray(state.deliveredDisplayIds) || !state.deliveredDisplayIds.every(id => id === displayId)
        || ![state.width, state.height].every(n => Number.isSafeInteger(n) && n > 0)) throw fail('FIXTURE_STATE_UNPROVEN');
    return { ...state, processSession: data.processSession, captureUptimeMs: data.capturedAtUptimeMs };
}
function buttonCenter(state, display) {
    if (state.displayId !== display.logicalId || state.width !== display.size.width || state.height !== display.size.height) throw fail('FIXTURE_DISPLAY_MISMATCH');
    const b = state.buttonBounds;
    if (!b || !['left','top','right','bottom'].every(k => Number.isSafeInteger(b[k]))
        || b.left < 0 || b.top < 0 || b.right <= b.left || b.bottom <= b.top
        || b.right > display.size.width || b.bottom > display.size.height) throw fail('FIXTURE_BOUNDS_UNPROVEN');
    return { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) };
}
function verifyTap(before, after) {
    return after.session === before.session && after.processSession === before.processSession
        && after.displayId === before.displayId && after.taskId === before.taskId
        && after.width === before.width && after.height === before.height
        && after.captureUptimeMs >= before.captureUptimeMs && after.taps === before.taps + 1
        && after.touchEventCount > before.touchEventCount && after.deliveredDisplayIds.includes(before.displayId);
}
function serverOptions(scid, displayId) {
    if (!/^[0-7][a-f0-9]{7}$/.test(scid)) throw fail('INVALID_SCID');
    if (displayId !== null && (!Number.isSafeInteger(displayId) || displayId < 1)) throw fail('NONDEFAULT_DISPLAY_REQUIRED');
    return ['5.0.1', `scid=${scid}`, 'log_level=debug', 'tunnel_forward=true', 'audio=false', 'control=true',
        'video_codec=h264', 'video_bit_rate=2000000', 'max_fps=15', 'power_on=false', 'clipboard_autosync=false',
        'stay_awake=false', 'keep_active=false', 'cleanup=false', 'display_ime_policy=hide',
        ...(displayId === null ? ['new_display=720x1280/260', 'vd_destroy_content=true', 'vd_system_decorations=false'] : [`display_id=${displayId}`])];
}
module.exports = { PACKAGE, fail, installedApkPath, parseArgs, displayFlags, requireFocusFlags, validateFocusBuild, inventory, physical, samePhysical, newDisplay, sameTarget, fixtureState, buttonCenter, verifyTap, serverOptions };
