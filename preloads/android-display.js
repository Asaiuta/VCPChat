'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('androidDisplay', Object.freeze({
    fitWindow: geometry => ipcRenderer.invoke('android-display:fit-window', geometry),
    openSettings: (section = 'display') => ipcRenderer.invoke('android-display:open-settings', section),
    requestViewerAction: action => ipcRenderer.invoke('android-display:request-viewer-action', action),
    readControllerSettings: () => ipcRenderer.invoke('android-display:controller-settings', 'read'),
    saveControllerSettings: request => ipcRenderer.invoke('android-display:controller-settings', 'save', request),
    openSystemAuthorization: () => ipcRenderer.invoke('android-display:controller-settings', 'authorization'),
}));

const CONTROL_CHANNEL = 'android-display:window-control';
const STATE_CHANNEL = 'android-display:window-state';
const VIEWER_ACTION_CHANNEL = 'android-display:viewer-action';
const SVG_NS = 'http://www.w3.org/2000/svg';
let maximizeButton = null;
let stateRevision = 0;

function icon(path) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(SVG_NS, 'path');
    shape.setAttribute('d', path);
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke', 'currentColor');
    svg.append(shape);
    return svg;
}

function showState(state) {
    if (!maximizeButton || typeof state?.maximized !== 'boolean') return;
    maximizeButton.title = state.maximized ? '还原' : '最大化';
    maximizeButton.setAttribute('aria-label', maximizeButton.title);
    maximizeButton.replaceChildren(icon(state.maximized ? 'M4 2h6v6M2 4h6v6H2Z' : 'M2 2h8v8H2Z'));
}

async function control(action) {
    const revision = stateRevision;
    try {
        const state = await ipcRenderer.invoke(CONTROL_CHANNEL, action);
        if (revision === stateRevision) showState(state);
    } catch { /* Window navigation or closure may invalidate an in-flight request. */ }
}

const onState = (_event, state) => {
    stateRevision += 1;
    showState(state);
};
const onViewerAction = (_event, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).length !== 1 || !['fit', 'reconnect'].includes(payload.action)) return;
    window.dispatchEvent(new window.CustomEvent('android-display-viewer-action', { detail: { action: payload.action } }));
};
ipcRenderer.on(STATE_CHANNEL, onState);
ipcRenderer.on(VIEWER_ACTION_CHANNEL, onViewerAction);
window.addEventListener('beforeunload', () => {
    ipcRenderer.removeListener(STATE_CHANNEL, onState);
    ipcRenderer.removeListener(VIEWER_ACTION_CHANNEL, onViewerAction);
}, { once: true });

function installControls() {
    const header = document.querySelector('header');
    if (!header || header.querySelector('[data-android-window-controls]')) return;
    const controls = document.createElement('div');
    controls.className = 'title-bar-controls';
    controls.dataset.androidWindowControls = 'true';
    for (const [action, label, path] of [
        ['minimize', '最小化', 'M2 6h8'],
        ['toggle-maximize', '最大化', 'M2 2h8v8H2Z'],
        ['close', '关闭', 'M2 2l8 8M10 2l-8 8'],
    ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `title-bar-button${action === 'close' ? ' close-button' : ''}`;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.append(icon(path));
        button.addEventListener('click', () => { void control(action); });
        if (action === 'toggle-maximize') maximizeButton = button;
        controls.append(button);
    }
    header.append(controls);
    void control('state');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installControls, { once: true });
else installControls();
