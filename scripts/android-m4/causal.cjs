'use strict';

// M4-F3 causal isolation: only physical-display changes caused by the virtual-display
// session are violations. Human use of the physical display is recorded, not failed.
// Event field layouts verified on PJZ110 / Android 17 events buffer:
//   wm_task_moved            [taskId, rootTaskId, displayId, toTop, index]
//   wm_focused_root_task     [userId, displayId, focusedRootTaskId, lastFocusedRootTaskId, reason]
//   wm_set_resumed_activity  [userId, component, reason]
const P = require('./protocol.cjs');

const EVENT_LINE = /^\s*(\d+\.\d+)\s+\d+\s+\d+\s+I\s+(wm_task_moved|wm_focused_root_task|wm_set_resumed_activity)\s*:\s*\[(.*)\]\s*$/;

function parseEvents(text) {
    const events = [];
    for (const line of String(text).split(/\r?\n/)) {
        const m = EVENT_LINE.exec(line);
        if (!m) continue;
        const fields = m[3].split(',').map(s => s.trim());
        events.push({ t: Number(m[1]), tag: m[2], fields, line: line.trim() });
    }
    return events;
}

function judgeEvents(events, { pkg = P.PACKAGE, targetId, taskIds = [] }) {
    const tasks = new Set(taskIds.map(String));
    const violations = [], external = [];
    let coverage = false;
    for (const e of events) {
        if (e.tag === 'wm_task_moved') {
            const [task, root, display] = e.fields;
            const ours = tasks.has(task) || tasks.has(root);
            if (ours && Number(display) === targetId) coverage = true;
            if (ours && Number(display) !== targetId) violations.push({ code: 'FIXTURE_TASK_LEFT_TARGET', line: e.line });
            else if (!ours && Number(display) === targetId) violations.push({ code: 'FOREIGN_TASK_ON_TARGET', line: e.line });
        } else if (e.tag === 'wm_focused_root_task') {
            const [, display, focused] = e.fields;
            if (Number(display) === targetId) violations.push({ code: 'TARGET_TOOK_TOP_FOCUS', line: e.line });
            else if (tasks.has(focused)) violations.push({ code: 'FIXTURE_TOOK_PHYSICAL_FOCUS', line: e.line });
            else external.push(e.line);
        } else if (e.tag === 'wm_set_resumed_activity') {
            const component = e.fields[1] || '';
            if (component.startsWith(pkg + '/')) violations.push({ code: 'FIXTURE_BECAME_TOP_RESUMED', line: e.line });
            else external.push(e.line);
        }
    }
    return { violations, external, coverage };
}

function parseTopFocused(text) {
    const ids = [...String(text).matchAll(/^\s*mTopFocusedDisplayId=(-?\d+)\s*$/gm)].map(m => Number(m[1]));
    if (ids.length !== 1) throw P.fail('TOP_FOCUS_UNPROVEN');
    return ids[0];
}

// Physical identity must hold; its focused window may change if the change is not ours.
function physicalCheck(original, snapshot, { pkg = P.PACKAGE, targetId, topFocused }) {
    const found = snapshot.displays.filter(d => d.logicalId === 0);
    if (found.length !== 1) return { ok: false, code: 'PHYSICAL_DISPLAY_LOST' };
    const now = found[0];
    if (now.uniqueId !== original.uniqueId || now.size.width !== original.size.width || now.size.height !== original.size.height) return { ok: false, code: 'PHYSICAL_IDENTITY_CHANGED' };
    if (topFocused === targetId) return { ok: false, code: 'TARGET_TOOK_TOP_FOCUS' };
    if (now.focus.includes(` ${pkg}/`)) return { ok: false, code: 'FIXTURE_ON_PHYSICAL' };
    if (!/^Window\{/.test(now.focus)) return { ok: false, code: 'PHYSICAL_FOCUS_NULL', retry: true };
    return { ok: true, changed: now.focus !== original.focus, focus: now.focus };
}

module.exports = { parseEvents, judgeEvents, parseTopFocused, physicalCheck };
