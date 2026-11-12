'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { extractThemePreviewVariables } = require('./themePreviewVariables');
const cssTree = require('css-tree');

const THEME_FIELDS = Object.freeze({
    bg: ['--primary-bg', '#101316'],
    panel: ['--secondary-bg', '#171b20'],
    'panel-2': ['--accent-bg', '#222930'],
    line: ['--border-color', '#2f3942'],
    text: ['--primary-text', '#f1f5f9'],
    muted: ['--secondary-text', '#94a3b8'],
    accent: ['--button-bg', '#e53935'],
    'on-accent': ['--text-on-accent', '#f8fafc'],
    ok: ['--success-color', '#4caf50'],
    warn: ['--warning-color', '#c58d2d'],
    bad: ['--danger-color', '#e53935'],
    'input-bg': ['--input-bg', '#222930'],
    'scrollbar-track': ['--scrollbar-track', 'transparent'],
    'scrollbar-thumb': ['--scrollbar-thumb', '#64748b'],
    'scrollbar-thumb-hover': ['--scrollbar-thumb-hover', '#94a3b8'],
    'highlight-text': ['--highlight-text', '#ef5350'],
    'button-hover-bg': ['--button-hover-bg', '#ef5350'],
    'font-family': ['--font-family-sans-serif', '"Segoe UI", "Microsoft YaHei UI", sans-serif'],
});

function themeVariablesCss(variables, dark, dependencies) {
    const palette = new Map();
    function include(token) {
        const value = variables[token];
        if (!value || palette.has(token) || /url\(/i.test(value)) return;
        palette.set(token, value);
        for (const [, dependency] of value.matchAll(/var\(\s*(--[\w-]+)/g)) include(dependency);
    }
    Object.values(THEME_FIELDS).forEach(([token]) => include(token));
    for (const [, token] of dependencies.matchAll(/var\(\s*(--[\w-]+)/g)) include(token);
    const inherited = [...palette].map(([key, value]) => `${key}:${value} !important;`).join('');
    const values = Object.entries(THEME_FIELDS).map(([field, [token, fallback]]) => {
        const value = variables[token] || fallback;
        return `--${field}:${value} !important;`;
    }).join('');
    return `:root{${inherited}color-scheme:${dark ? 'dark' : 'light'} !important;${values}}
header{min-height:48px;app-region:drag;}
header button,header a,header input,header details,header summary{app-region:no-drag;}`;
}

// Keep project declarations and conditional groups, without unrelated selectors or cascade layers.
function selectedCss(source, select, important = false) {
    const render = children => {
        let output = '';
        children.forEach(node => {
            if (node.type === 'Rule' && node.prelude?.type === 'SelectorList') {
                const selectors = node.prelude.children.toArray().map(selector => select(cssTree.generate(selector))).filter(Boolean);
                if (!selectors.length) return;
                const copy = cssTree.clone(node);
                copy.prelude = cssTree.parse(selectors.join(','), { context: 'selectorList' });
                if (important) copy.block.children.forEach(declaration => {
                    if (declaration.type === 'Declaration') declaration.important = true;
                });
                output += cssTree.generate(copy);
            } else if (node.type === 'Atrule' && node.block && ['layer', 'media', 'supports'].includes(node.name)) {
                const inner = render(node.block.children);
                if (inner) output += node.name === 'layer' ? inner : `@${node.name} ${cssTree.generate(node.prelude)}{${inner}}`;
            }
        });
        return output;
    };
    return render((typeof source === 'string' ? cssTree.parse(source) : source).children);
}

function chromeCss(scriptorium) {
    const ast = cssTree.parse(scriptorium);
    const root = ast.children.toArray().find(node => node.type === 'Rule' && cssTree.generate(node.prelude) === ':root');
    const soft = root?.block.children.toArray().find(node => node.type === 'Declaration' && node.property === '--scriptorium-accent-soft');
    const variable = soft ? `:root{--scriptorium-accent-soft:${cssTree.generate(soft.value)}!important;}` : '';
    const buttons = selectedCss(ast, selector => /^\.window-button(?:[.:][\w-]+)*$/.test(selector)
        ? selector.replace(/^\.window-button/, '.title-bar-button') : null, true);
    return variable + buttons
        + 'header>.title-bar-controls{display:flex!important;align-items:center!important;gap:2px!important;flex:none!important;align-self:center!important;margin-left:0!important;app-region:no-drag!important;}'
        + 'header:not(:has(.header-actions))>.title-bar-controls{margin-left:auto!important;}'
        + 'header .title-bar-button{min-width:34px!important;min-height:32px!important;app-region:no-drag!important;}'
        + 'header .title-bar-button svg{width:12px!important;height:12px!important;stroke-width:1.2!important;}'
        + '@media(prefers-reduced-motion:reduce){header .title-bar-button{transition:none!important;}}';
}

function tokenPalettes(tokens) {
    const tokenAst = cssTree.parse(tokens);
    const palettes = { dark: [], light: [] };
    cssTree.walk(tokenAst, { visit: 'Rule', enter(node) {
        if (node.prelude?.type !== 'SelectorList') return;
        const selectors = node.prelude.children.toArray().map(selector => cssTree.generate(selector));
        const themes = ['dark', 'light'].filter(theme => selectors.some(selector => selector === ':root'
            || selector === `body[data-vcp-theme=${theme}]` || selector === `body[data-vcp-theme="${theme}"]`));
        if (themes.length) {
            const declarations = node.block.children.toArray().filter(item => item.type === 'Declaration' && item.property.startsWith('--'));
            const css = `:root{${declarations.map(item => cssTree.generate(item)).join(';')}}`;
            themes.forEach(theme => palettes[theme].push(css));
        }
    } });
    return Object.fromEntries(Object.entries(palettes).map(([theme, rules]) => [theme, rules.join('')]));
}

function primitivesCss(components) {
    return selectedCss(components, selector => {
        if (!/\.vcp-ui-(?:button|icon-button|native-input|native-select)(?![\w-])/.test(selector)) return null;
        // Do not pull parent components (dialogs, async boundaries, etc.) into this viewer.
        const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
        if (classes.some(name => name.startsWith('vcp-ui-') && !['vcp-ui-scope', 'vcp-ui-button', 'vcp-ui-icon-button',
            'vcp-ui-native-input', 'vcp-ui-native-select', 'vcp-ui-native-textarea'].includes(name))) return null;
        return selector;
    });
}

function compilePalettes([source, tokens, components, scriptorium]) {
    const variables = extractThemePreviewVariables(source);
    const palettes = tokenPalettes(tokens);
    const common = primitivesCss(components) + chromeCss(scriptorium);
    return Object.fromEntries(['dark', 'light'].map(theme => {
        const selected = palettes[theme] + common;
        return [theme, themeVariablesCss(variables[theme], theme === 'dark', selected) + selected];
    }));
}

// One source revision and two small CSS strings per host. ASTs and input text
// are released after compilation; concurrent windows share the same load.
function createAndroidDisplayTheme({ projectRoot, io = fs, compile = compilePalettes }) {
    const files = ['styles/themes.css', 'styles/ui-system/tokens.css',
        'styles/ui-system/components.css', 'ScriptoriumModules/scriptorium.css'].map(file => path.join(projectRoot, file));
    let cached = null, pending = null, disposed = false;
    const identity = async () => (await Promise.all(files.map(async file => {
        const stat = await io.stat(file, { bigint: true });
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    }))).join('|');
    async function load() {
        const revision = await identity();
        if (cached?.revision === revision) return cached.palettes;
        const sources = await Promise.all(files.map(file => io.readFile(file, 'utf8')));
        if (revision !== await identity()) throw new Error('主题文件正在更新，请稍后刷新。');
        if (disposed) throw new Error('显示主题服务已退出。');
        const palettes = Object.freeze(compile(sources));
        cached = { revision, palettes };
        return palettes;
    }
    return {
        async get(dark) {
            if (disposed) throw new Error('显示主题服务已退出。');
            if (!pending) pending = load().finally(() => { pending = null; });
            return (await pending)[dark ? 'dark' : 'light'];
        },
        dispose() { disposed = true; cached = null; },
    };
}

module.exports = { createAndroidDisplayTheme, compilePalettes };

