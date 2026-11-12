'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { minimatch } = require('minimatch');
const { LaunchpadIcons, LAUNCHPAD_ICON_ACCENTS } = require('../modules/ui-system/next-shell/launchpad-icons');
const { paintLaunchpadIcon } = require('../modules/ui-system/next-shell/launchpad-icon-art');
const { LaunchpadController } = require('../modules/ui-system/next-shell/launchpad-controller');
const allowlist = require('../modules/shared/embeddedAppAllowlist');
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = 'VCPDistributedServer/Plugin/AndroidController';
const ACTION = 'open-android-display-window';
const VENDOR = ['scrcpy-server-v5.0.1', 'u2-server-0.5.0.apk', 'vcp-ui-owner.jar']
    .map(name => `${PLUGIN}/vendor/${name}`);
const FILES = [
    `${PLUGIN}/*.js`, `${PLUGIN}/plugin-manifest.json`, `${PLUGIN}/lib/*.js`,
    `${PLUGIN}/lib/viewer.html`, ...VENDOR,
];
const source = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function fixture() {
    const dom = new JSDOM(`<body><div id="appTrayDrawerGrid"></div><div id="nextUiAppGrid"></div>
        <div id="desktop-canvas"></div><div id="desktop-dock-items"></div>
        <div id="desktop-dock-drawer"></div></body>`, {
        url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    const launched = [];
    const api = { desktopLaunchVchatApp: async action => { launched.push(action); return { success: true }; } };
    w.chatAPI = w.desktopAPI = api;
    w.VCPEmbeddedAppAllowlist = allowlist;
    w.VCPDesktop = { state: { dock: { items: [] } } };
    for (const file of ['modules/trayManager.js', 'Desktopmodules/builtinWidgets/vchatApps.js']) w.eval(source(file));
    const calls = [];
    const record = name => (...args) => {
        for (const arg of args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg), `${name}: non-finite coordinate`);
        calls.push([name, ...args]);
    };
    const context = {};
    for (const name of ['beginPath', 'roundRect', 'fill', 'moveTo', 'lineTo', 'stroke', 'arc',
        'setTransform', 'clearRect', 'save', 'restore', 'translate', 'scale', 'rotate',
        'clip', 'bezierCurveTo', 'closePath']) context[name] = record(name);
    for (const name of ['createLinearGradient', 'createRadialGradient']) {
        context[name] = (...args) => { record(name)(...args); return { addColorStop: record('addColorStop') }; };
    }
    w.HTMLCanvasElement.prototype.getContext = () => context;
    w.matchMedia = () => Object.assign(new w.EventTarget(), { matches: true });
    w.VCPNextShell = { LaunchpadIcons, paintLaunchpadIcon };
    w.eval(source('Desktopmodules/ui/livingIcons.js'));
    return { dom, w, launched, calls, context, close() { w.VCPDesktop.livingIcons.dispose(); w.close(); } };
}

function matches(relative, patterns) {
    let included = false;
    for (const pattern of patterns) {
        assert.equal(typeof pattern, 'string', 'test expects explicit string packaging rules');
        const negative = pattern.startsWith('!');
        if (minimatch(relative, negative ? pattern.slice(1) : pattern, { dot: true })) included = !negative;
    }
    return included;
}

function controllerScripts() {
    return [
        ...fs.readdirSync(path.join(ROOT, PLUGIN)).filter(name => name.endsWith('.js')).map(name => `${PLUGIN}/${name}`),
        ...fs.readdirSync(path.join(ROOT, PLUGIN, 'lib')).filter(name => name.endsWith('.js')).map(name => `${PLUGIN}/lib/${name}`),
    ];
}

test('tray and desktop expose one consistent standalone Android entry and both launch the same action', async () => {
    const f = fixture();
    try {
        const trayApps = f.w.trayManager.getApps().filter(app => app.id === 'vchat-app-android');
        const desktopApps = f.w.VCPDesktop.vchatApps.list().filter(app => app.id === 'vchat-app-android');
        assert.equal(trayApps.length, 1);
        assert.equal(desktopApps.length, 1);
        const [tray] = trayApps, [desktop] = desktopApps;
        assert.equal(tray.name, '安卓');
        assert.equal(desktop.name, tray.name);
        assert.equal(tray.icon, 'android');
        assert.equal(tray.action, ACTION);
        assert.equal(desktop.appAction, ACTION);
        assert.equal(tray.embed, false);
        assert.equal(allowlist.isEmbeddable(ACTION), false);
        assert.equal(allowlist.get(ACTION), null);
        assert.match(desktop.svgIcon, /<svg/);
        const svgHost = f.w.document.createElement('span');
        svgHost.innerHTML = f.w.trayManager.getIcon('android');
        const svg = svgHost.querySelector('svg');
        assert.ok(svg?.classList.contains('lucide-smartphone'));
        assert.equal(svg.getAttribute('stroke'), 'currentColor');
        assert.ok(svg.querySelector('rect'));
        await f.w.trayManager.launchApp(tray);
        await f.w.VCPDesktop.vchatApps.launch(desktop);
        assert.deepEqual(f.launched, [ACTION, ACTION]);
        f.w.VCPDesktop.vchatApps.inject();
        f.w.VCPDesktop.vchatApps.inject();
        const injected = f.w.VCPDesktop.state.dock.items.filter(item => item.id === desktop.id);
        assert.equal(injected.length, 1);
        assert.equal(injected[0].type, 'vchat-app');
        assert.equal(f.w.VCPDesktop.livingIcons.keyFor(injected[0]), 'android');
        assert.equal(f.w.VCPDesktop.livingIcons.keyFor({ ...injected[0], icon: 'data:image/png;base64,custom' }), null);
    } finally { f.close(); }
});

test('Next and desktop mount the same dimensional phone artwork without embedded routing', () => {
    const f = fixture();
    const desktop = f.w.VCPDesktop.vchatApps.list().find(app => app.id === 'vchat-app-android');
    const app = f.w.trayManager.getApps().find(app => app.id === desktop.id);
    const opened = [];
    const controller = new LaunchpadController({
        document: f.w.document, getExternalApps: () => [app],
        getIcon: key => f.w.trayManager.getIcon(key),
        openExternal: entry => opened.push(entry.action),
        openEmbedded: () => assert.fail('Android display must remain a native window'),
    });
    try {
        assert.match(LAUNCHPAD_ICON_ACCENTS.android, /^#[0-9a-f]{6}$/);
        controller.mount();
        const button = f.w.document.querySelector('#nextUiAppGrid button');
        assert.equal(button.dataset.openMode, 'window');
        assert.ok(button.querySelector('canvas'));
        button.click();
        assert.deepEqual(opened, [ACTION]);
        const desktopButton = f.w.document.createElement('button');
        f.w.document.getElementById('desktop-dock-items').append(desktopButton);
        assert.equal(f.w.VCPDesktop.livingIcons.attach(desktopButton, { ...desktop, type: 'vchat-app' }, 'dock', 'icon'), true);
        assert.ok(desktopButton.querySelector('canvas'));
        assert.ok(f.calls.some(([name, x, y, width, height]) =>
            name === 'roundRect' && x === -29 && y === -47 && width === 54 && height === 91),
        'phone shell must be drawn, not just the common ground shadow');
        assert.ok(f.calls.some(([name, x, y, width, height]) =>
            name === 'roundRect' && x === -22 && y === -40 && width === 40 && height === 77),
        'phone artwork must contain its inset screen');
    } finally { controller.dispose(); f.close(); }
});

test('phone artwork paints finite static and animated frames and reduced motion is stable', () => {
    const f = fixture();
    try {
        const state = {
            canvas: f.w.document.createElement('canvas'), c: f.context,
            data: ['android', '', '', LAUNCHPAD_ICON_ACCENTS.android],
            size: 224, energy: 0, x: 0.5, y: -0.5, kick: 0,
        };
        paintLaunchpadIcon(state, 0);
        assert.equal(state.canvas.width, 224);
        assert.equal(state.canvas.height, 224);
        const resting = f.calls.splice(0);
        paintLaunchpadIcon(state, 10);
        assert.deepEqual(f.calls.splice(0), resting, 'inactive/reduced-motion phone must not animate');
        state.energy = 1;
        state.kick = 0.5;
        for (const time of [0, 0.5, 10]) assert.doesNotThrow(() => paintLaunchpadIcon(state, time));
        assert.notDeepEqual(f.calls, resting);
    } finally { f.close(); }
});

test('package rules explicitly include Android runtime resources and unpack only adb vendor payloads', () => {
    assert.deepEqual(pkg.build.files.filter(pattern => pattern.startsWith(`${PLUGIN}/`)), FILES);
    assert.deepEqual(pkg.build.asarUnpack.filter(pattern => pattern.startsWith(`${PLUGIN}/`)), VENDOR);
    for (const relative of [...controllerScripts(), `${PLUGIN}/plugin-manifest.json`, `${PLUGIN}/lib/viewer.html`, ...VENDOR]) {
        assert.ok(matches(relative, pkg.build.files), `missing runtime resource: ${relative}`);
        assert.ok(fs.statSync(path.join(ROOT, relative)).size > 0, `empty runtime resource: ${relative}`);
        assert.equal(matches(relative, pkg.build.asarUnpack), VENDOR.includes(relative), `unexpected unpack: ${relative}`);
    }
    for (const name of [
        'config.env', 'config.env.example', '.env', '.env.local', 'README.md',
        'cache/frame.png', 'cache/secret.js', 'logs/session.log', 'debug.log',
        'lib/config.env', 'lib/cache/secret.js', 'lib/logs/trace.jsonl',
        'vendor/config.env', 'vendor/cache/frame.png', 'vendor/debug.log',
        'vendor/unknown.apk', 'vendor/scrcpy-server-v5.0.2',
    ]) {
        const relative = `${PLUGIN}/${name}`;
        assert.equal(matches(relative, pkg.build.files), false, `private/non-runtime file included: ${relative}`);
        assert.equal(matches(relative, pkg.build.asarUnpack), false, `private/non-runtime file unpacked: ${relative}`);
    }
});

test('packaged controller relative imports stay within its whitelisted code closure', () => {
    for (const relative of controllerScripts()) {
        const requires = source(relative).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g);
        for (const [, specifier] of requires) {
            if (!specifier.startsWith('.')) continue;
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
            const sharedAtomicWriter = ['display-preferences.js', 'controller-settings.js']
                .some(name => relative === `${PLUGIN}/lib/${name}`) && target === 'modules/utils/atomicReplace';
            // This reviewed host utility is packaged by modules/**/* and imports Node built-ins only.
            assert.ok(target.startsWith(`${PLUGIN}/`) || sharedAtomicWriter, `external controller dependency must be reviewed: ${relative} -> ${specifier}`);
            if (sharedAtomicWriter) {
                const sharedImports = [...source(`${target}.js`).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
                assert.ok(sharedImports.every(specifier => specifier.startsWith('node:')), 'shared writer must not expand the package closure');
            }
            const resolved = [target, `${target}.js`, `${target}/index.js`]
                .find(candidate => fs.existsSync(path.join(ROOT, candidate)) && fs.statSync(path.join(ROOT, candidate)).isFile());
            assert.ok(resolved, `unresolved relative import: ${relative} -> ${specifier}`);
            assert.ok(matches(resolved, pkg.build.files), `dependency omitted from pack: ${resolved}`);
        }
    }
});
