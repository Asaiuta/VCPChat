'use strict';

/**
 * M4.5 P1: display-scoped identity for frames, snapshots and context.
 *
 * Default display (0) keeps every pre-existing contract byte-for-byte: callers that pass
 * no target get exactly the old single-display behaviour. A non-default target is only
 * accepted with an explicit identity (logical id + DisplayDeviceInfo uniqueId + generation),
 * because logical ids are reused after a virtual display is destroyed (PJZ110: 135→206).
 *
 * Evidence (2026-11-06, PJZ110 / Android 17):
 * - `dumpsys window displays` lists each display as `Display: mDisplayId=N (organized)` with its
 *   own cur=, mCurrentFocus and DisplayRotation sections; the virtual display may come first.
 * - The resident u2 carrier with rootInActive=false returns roots from every display, each root
 *   carrying `display-id`. Its size follows the physical UI (≥60 KB p50 97 ms vs 44 ms), so
 *   consumers must cut the target display out before parsing.
 */

const DEFAULT_DISPLAY = 0;
const MAX_DISPLAY_ID = 999999;
const MIRROR_CONTEXT_POLICY_VERSION = 'shell-mirror-context-v2';

class DisplayTargetError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

function isDisplayId(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DISPLAY_ID;
}

/** Normalise a caller target. `undefined`/`null`/0 all mean the default display. */
function displayTarget(input) {
    if (input === undefined || input === null || input === DEFAULT_DISPLAY) {
        return Object.freeze({ displayId: DEFAULT_DISPLAY, uniqueId: null, generation: null, isDefault: true });
    }
    if (typeof input !== 'object' || Array.isArray(input) || !isDisplayId(input.displayId)) {
        throw new DisplayTargetError('DISPLAY_TARGET_INVALID', 'display 目标必须给出合法的 displayId');
    }
    if (input.displayId === DEFAULT_DISPLAY) {
        return Object.freeze({ displayId: DEFAULT_DISPLAY, uniqueId: null, generation: null, isDefault: true });
    }
    if (typeof input.uniqueId !== 'string' || !/^[A-Za-z0-9:._,\-]{1,200}$/.test(input.uniqueId)
        || typeof input.generation !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(input.generation)) {
        throw new DisplayTargetError('DISPLAY_TARGET_IDENTITY_REQUIRED', '非默认 display 必须带 uniqueId 与 generation');
    }
    return Object.freeze({ displayId: input.displayId, uniqueId: input.uniqueId, generation: input.generation, isDefault: false });
}

/** Stable key for per-display state. The default display keeps the bare serial key. */
function displayKey(serial, target) {
    const t = target && typeof target === 'object' && 'isDefault' in target ? target : displayTarget(target);
    const base = String(serial ?? '');
    return t.isDefault ? base : `${base}#display=${t.displayId}@${t.generation}`;
}

function sameTarget(a, b) {
    const x = displayTarget(a), y = displayTarget(b);
    return x.displayId === y.displayId && x.uniqueId === y.uniqueId && x.generation === y.generation;
}

/**
 * Split `dumpsys window displays` text into per-display sections.
 * Returns [{ displayId, text }] in dump order; duplicates make the dump ambiguous.
 */
function windowDisplaySections(windowText) {
    // adb on Windows may deliver CRLF; a trailing \r would make every header look non-standard.
    const text = String(windowText ?? '').replace(/\r/g, '');
    const headers = [...text.matchAll(/^[ \t]*Display:[^\n]*$/gm)];
    const seen = new Set();
    return headers.map((match, index) => {
        const id = /^[ \t]*Display: mDisplayId=(\d+)(?: \(organized\))?[ \t]*$/.exec(match[0])?.[1];
        const displayId = id === undefined ? null : Number(id);
        if (displayId !== null && seen.has(displayId)) throw new DisplayTargetError('DISPLAY_SECTION_AMBIGUOUS', 'dumpsys 中 display 段重复');
        if (displayId !== null) seen.add(displayId);
        const end = index + 1 < headers.length ? headers[index + 1].index : text.length;
        return { displayId, text: text.slice(match.index, end) };
    });
}

/** `mPrimaryDisplayDevice=<name>(<uniqueId>)` from the logical display block of `dumpsys display`. */
function displayUniqueId(displayText, displayId) {
    if (!isDisplayId(displayId)) return null;
    const blocks = [...String(displayText ?? '').replace(/\r/g, '').matchAll(new RegExp(`^  Display ${displayId}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, 'gm'))];
    if (blocks.length !== 1) return null;
    const ids = [...blocks[0][1].matchAll(/^\s*mPrimaryDisplayDevice=.*\(([^()\n]+)\)\s*$/gm)];
    return ids.length === 1 ? ids[0][1] : null;
}

/** The standalone `DisplayDeviceInfo{...}` line for one uniqueId; nested `devInfo:` copies are ignored. */
function displayDeviceInfo(displayText, uniqueId) {
    if (typeof uniqueId !== 'string' || !uniqueId) return null;
    const lines = String(displayText ?? '').replace(/\r/g, '').split('\n')
        .filter(line => /^\s*DisplayDeviceInfo\{/.test(line) && line.includes(`uniqueId="${uniqueId}"`));
    if (lines.length !== 1) return null;
    const line = lines[0];
    const owner = /\bowner ([A-Za-z0-9._]+) \(uid (\d+)\)/.exec(line);
    return {
        uniqueId,
        type: /\btype ([A-Z_]+)\b/.exec(line)?.[1] ?? null,
        ownerPackage: owner?.[1] ?? null,
        ownerUid: owner ? Number(owner[2]) : null,
        flags: [...new Set(line.match(/\bFLAG_[A-Z_]+\b/g) || [])],
    };
}

/**
 * Evidence that an extra display is the shell-owned scrcpy mirror (ScreenCapture on Android 14+,
 * PJZ110 2026-11-06): VIRTUAL, owned by com.android.shell uid 2000, FLAG_PRIVATE without
 * OWN_CONTENT_ONLY/TRUSTED, and its window section hosts no focus and no activity.
 * Anything short of all of these is not a mirror and keeps the probe fail-closed.
 */
function isShellPrivateMirror(info, windowSection) {
    if (!info || info.type !== 'VIRTUAL' || info.ownerPackage !== 'com.android.shell' || info.ownerUid !== 2000) return false;
    if (!/^virtual:com\.android\.shell,2000,/.test(info.uniqueId)) return false;
    if (!info.flags.includes('FLAG_PRIVATE') || info.flags.includes('FLAG_OWN_CONTENT_ONLY') || info.flags.includes('FLAG_TRUSTED')) return false;
    const text = String(windowSection ?? '').replace(/\r/g, '');
    const focus = [...text.matchAll(/^[ \t]*mCurrentFocus=([^\n]*)$/gm)].map(m => m[1].trim());
    const focusedApp = [...text.matchAll(/^[ \t]*mFocusedApp=([^\n]*)$/gm)].map(m => m[1].trim());
    // DisplayContent dumps the shared TransitionController on every display. Its
    // participants can belong to display 0; they do not establish local ownership.
    // Only remove one fully delimited controller block at the observed indentation.
    // An incomplete/duplicate block or ActivityRecord elsewhere remains untrusted.
    const starts = [...text.matchAll(/^([ \t]+)TransitionController:[ \t]*$/gm)];
    const ends = [...text.matchAll(/^([ \t]+)BLASTSyncEngine:[ \t]*$/gm)];
    const local = starts.length === 1 && ends.length === 1 && starts[0][1] === ends[0][1]
        && starts[0].index < ends[0].index
        ? text.slice(0, starts[0].index) + text.slice(ends[0].index) : text;
    return focus.length === 1 && focus[0] === 'null' && focusedApp.length === 1 && focusedApp[0] === 'null'
        && !/ActivityRecord\{/.test(local);
}

/**
 * Cut one display out of a carrier multi-root dump (rootInActive=false).
 * Fail-closed: a top-level root without a parsable display-id makes attribution unproven.
 * Returns a standard single `<hierarchy>` XML containing only the target roots.
 */
function filterHierarchyByDisplay(xml, displayId) {
    if (!isDisplayId(displayId)) throw new DisplayTargetError('DISPLAY_TARGET_INVALID', 'displayId 非法');
    const text = String(xml ?? '');
    const open = /<hierarchy\b[^>]*?(\/?)>/.exec(text);
    if (!open) throw new DisplayTargetError('DISPLAY_TREE_INVALID', '不是控件树 XML');
    const header = open[0].replace(/\/>$/, '>');
    if (open[1] === '/') return { xml: `${header}</hierarchy>`, roots: 0, kept: 0 };
    const close = text.lastIndexOf('</hierarchy>');
    if (close < open.index) throw new DisplayTargetError('DISPLAY_TREE_INVALID', '控件树缺少结束标签');
    const body = text.slice(open.index + open[0].length, close);
    const kept = [];
    let depth = 0, start = -1, keep = false, roots = 0;
    const tag = /<(\/?)node\b([^>]*?)(\/?)>/g;
    let m;
    while ((m = tag.exec(body))) {
        const [, closing, attrs, selfClosing] = m;
        if (closing) {
            depth--;
            if (depth < 0) throw new DisplayTargetError('DISPLAY_TREE_INVALID', '控件树标签失衡');
            if (depth === 0) { if (keep) kept.push(body.slice(start, tag.lastIndex)); start = -1; }
            continue;
        }
        if (depth === 0) {
            roots++;
            const raw = /\bdisplay-id="([^"]*)"/.exec(attrs)?.[1];
            if (raw === undefined || !/^(?:0|[1-9][0-9]{0,5})$/.test(raw)) {
                throw new DisplayTargetError('DISPLAY_ATTRIBUTION_UNPROVEN', '控件树根节点缺少 display-id，无法按 display 归属');
            }
            keep = Number(raw) === displayId;
            start = m.index;
            if (selfClosing) { if (keep) kept.push(body.slice(start, tag.lastIndex)); start = -1; continue; }
        }
        if (!selfClosing) depth++;
    }
    if (depth !== 0) throw new DisplayTargetError('DISPLAY_TREE_INVALID', '控件树标签失衡');
    return { xml: `${header}${kept.join('')}</hierarchy>`, roots, kept: kept.length };
}

module.exports = {
    MIRROR_CONTEXT_POLICY_VERSION,
    DEFAULT_DISPLAY,
    DisplayTargetError,
    isDisplayId,
    displayTarget,
    displayKey,
    sameTarget,
    windowDisplaySections,
    displayUniqueId,
    displayDeviceInfo,
    isShellPrivateMirror,
    filterHierarchyByDisplay,
};
