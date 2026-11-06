'use strict';

/**
 * UI 控件语义图（ui-graph）—— 适配层。
 *
 * 职责边界（不要把剪枝逻辑塞回来）：
 * - **剪枝 / 角色 / 标签聚合**：全部由 `argent-uiautomator.js` 负责。
 *   那是一份经过上游大量真机样本打磨的实现，规则改动必须落在那边。
 * - **本文件只做形态转换**：把 DescribeNode 树摊成模型可直接寻址的平表，
 *   补上动作层需要的东西 —— 唯一 selector、点击落点、层级缩进、过滤器与统计。
 *
 * 为什么不让服务层直接用树：
 * 1. 模型要按序号引用控件，「第 7 条」比在一棵 44 行缩进树里数位置可靠。
 * 2. Tap 要像素坐标，树里只有归一化 frame（上游契约如此）。
 * 3. selector 要跨帧重绑，树里没有稳定寻址概念。
 *
 * 额外过滤（树层不做、属于「呈现决策」的规则）：
 * - 占位标签（Pinterest 的 content-desc="Image"）不算标签。
 * - 输入法键帽默认剔除：几十个「q/w/e」会把真内容挤出表外。
 * - disabled 默认保留 —— 按钮暂时不可用本身是信息，不是噪声。
 * - 视口外默认剔除，可按需保留。
 */

const crypto = require('node:crypto');
const { parseSelector, validateSelector, evaluateSelector, findControls, resolveSelector, MATCH_LABEL } = require('./selector');

const {
    decodeXmlEntities: decodeEntities,
    parseAttributes,
    parseUiAutomatorBounds,
    isSystemChrome,
    parseUiAutomatorTree,
    parseUiAutomatorXml,
    unionPixelBounds,
    SYSTEM_PACKAGES,
    deriveUiAutomatorRole,
    deriveWebRole,
    FULL_LABEL,
} = require('./argent-uiautomator');

const DEFAULT_LIMIT = 60;
const DEFAULT_TEXT_LENGTH = 120;
const PASSWORD_LABEL = '[password]';
const SIGNATURE_SAMPLE = 40;
const LABEL_SEPARATOR = ' / ';

const PRESENTATION_SOURCE = Symbol('presentationSource');
const PRESENTATION_OPTIONS = Symbol('presentationOptions');

/** Original decoded XML fields, never inherited from a folded wrapper or aggregate. */
function rawSources(raw) {
    const attrs = raw?.attrs || {};
    if (attrs.password === 'true' || attrs['visible-to-user'] === 'false' || attrs.displayed === 'false') {
        return { text: '', desc: '' };
    }
    return { text: String(attrs.text ?? ''), desc: String(attrs['content-desc'] ?? '') };
}
/** 通用图标词：与控件类名同源的占位文本，对模型零信息量。 */
const PLACEHOLDER_LABEL = new Set([
    'image', 'img', 'icon', 'button', 'btn', 'view', 'item', 'picture', 'photo',
    'thumb', 'thumbnail', 'widget', 'banner', 'logo', 'avatar', 'cover',
    '图片', '图标', '按钮', '图像', '图形', '控件', '视图', '项目', '头像', '封面',
]);

/** 输入法：不放进 port 的 SYSTEM_PACKAGES（那是「系统外壳」语义），属于呈现决策。 */
const IME_PACKAGE_RE = /inputmethod|ime$|inputmethod\.latin/i;

/** 滚动容器角色：其子节点相对它缩进一级。 */
const SCROLL_ROLES = new Set(['ScrollView', 'List']);

/**
 * 渲染时值得占位的角色。其余（LinearLayout / RelativeLayout / View / Image /
 * Button / StaticText）对模型没有额外信息 —— 要么是容器名，要么标签已说明一切。
 * 每行省 15-20 字节，二十行就是几百字节。
 */
/**
 * 像素画布类名。这些节点的内部由 GPU / 原生渲染直接绘制，
 * uiautomator 拿到的只是一个空壳节点 —— 除非引擎自己实现了无障碍桥
 * （Flutter 有，但需系统无障碍服务开启；Unity/Cocos/UE 基本没有）。
 */
const CANVAS_CLASS_RE = /(SurfaceView|TextureView|GLSurfaceView|GLTextureView|FlutterView|VideoView|UnityPlayer)/i;

/** 画布占屏比超过这个值，就认为「这一屏主要是图像」，需要走视觉通道。 */
const CANVAS_DOMINANT_RATIO = 0.55;

const NOTEWORTHY_ROLES = new Set([
    'switch', 'checkbox', 'radiobutton', 'textfield', 'scrollview', 'list', 'webview',
]);

// ---------------------------------------------------------------------------
// XML 原语（转发 + 本地整理）
// ---------------------------------------------------------------------------

/** 剥掉 `uiautomator dump` 混进 stdout 的尾巴（"UI hierchary dumped to: ..."）。 */
function extractHierarchy(xml) {
    const text = String(xml ?? '');
    const start = text.indexOf('<hierarchy');
    if (start < 0) return '';
    const end = text.lastIndexOf('</hierarchy>');
    if (end > start) return text.slice(start, end + '</hierarchy>'.length);
    const closing = text.indexOf('>', start);
    return closing > start ? text.slice(start, closing + 1) : '';
}

/**
 * bounds 解析成 {left,top,right,bottom}。
 * port 那边给的是 {x,y,w,h}（DescribeNode 契约），两层各用顺手的形式；
 * 本文件对外统一 left/top/right/bottom。
 */
function parseBounds(value) {
    const box = parseUiAutomatorBounds(value);
    if (!box) return null;
    if (box.w <= 0 || box.h <= 0) return null;
    return { left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h };
}

function fromPixel(p) {
    return p ? { left: p.x, top: p.y, right: p.x + p.w, bottom: p.y + p.h } : null;
}

function toPixel(b) {
    return b ? { x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top } : null;
}

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

function area(box) {
    return box ? Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top) : 0;
}

function intersectArea(a, b) {
    if (!a || !b) return 0;
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return width > 0 && height > 0 ? width * height : 0;
}

function intersectBox(a, b) {
    if (!a || !b) return null;
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function centerOf(box) {
    return { x: Math.round((box.left + box.right) / 2), y: Math.round((box.top + box.bottom) / 2) };
}

function clampTo(value, min, max) {
    if (!Number.isFinite(value) || max < min) return Math.round((min + max) / 2);
    return Math.round(Math.min(Math.max(value, min), max));
}

function clipToScreen(box, screen) {
    if (!box || !screen) return box;
    const left = Math.max(0, Math.min(box.left, screen.width));
    const top = Math.max(0, Math.min(box.top, screen.height));
    const right = Math.max(0, Math.min(box.right, screen.width));
    const bottom = Math.max(0, Math.min(box.bottom, screen.height));
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom };
}

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

function normalizeText(value, maxLength) {
    const text = String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 占位标签不算标签：通用词，或与控件类名同源（ImageView → "Image"）。 */
function meaningfulLabel(value, className) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text === PASSWORD_LABEL) return text;
    const normalized = text.replace(/[\s_.-]+/g, '').toLowerCase();
    if (PLACEHOLDER_LABEL.has(normalized)) return '';
    const classToken = String(className ?? '').replace(/^.*\./, '').replace(/[\s_.-]+/g, '').toLowerCase();
    if (classToken && normalized === classToken) return '';
    return text;
}

function shortId(resourceId) {
    const text = String(resourceId ?? '');
    if (!text) return '';
    const colon = text.indexOf(':id/');
    return colon >= 0 ? text.slice(colon) : text;
}

// ---------------------------------------------------------------------------
// 树 → 平表
// ---------------------------------------------------------------------------

function roleKey(role) {
    return String(role ?? '').toLowerCase();
}

function flagsOfNode(node) {
    const flags = [];
    if (node.clickable) flags.push('click');
    if (node.longClickable) flags.push('long');
    if (node.scrollable) flags.push('scroll');
    if (roleKey(node.role) === 'textfield') flags.push('edit');
    if (node.checkable) flags.push(node.checked ? 'checked' : 'unchecked');
    if (node.password) flags.push('password');
    if (node.disabled) flags.push('disabled');
    return flags;
}

/** 深度优先摊平，附带层级：祖先里滚动容器的个数，最多一级。 */
function flattenTree(roots) {
    const ordered = [];
    const stack = roots.map((n) => ({ node: n, listDepth: 0 })).reverse();
    while (stack.length) {
        const { node, listDepth } = stack.pop();
        ordered.push({ node, level: Math.min(listDepth, 1) });
        const childDepth = listDepth + (SCROLL_ROLES.has(String(node.role)) ? 1 : 0);
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
            stack.push({ node: node.children[i], listDepth: childDepth });
        }
    }
    return ordered;
}

function detectScreen(tree) {
    // 屏幕尺寸取面积最大的节点：hierarchy 只是壳，个别 ROM 会在前面插 1×1 占位。
    if (!tree) return null;
    let best = null;
    let bestArea = 0;
    const stack = [tree, ...tree.children];
    while (stack.length) {
        const node = stack.pop();
        const box = fromPixel(node.pixel);
        const size = area(box);
        if (box && size > bestArea) {
            best = box;
            bestArea = size;
        }
        for (const child of node.children) stack.push(child);
    }
    return best ? { width: best.right, height: best.bottom } : null;
}

/**
 * 一遍遍历同时拿三样东西：节点总数、bounds 最大矩形（推断屏幕用）、
 * 以及允许越界时的最大右下角。
 *
 * 为什么不拆成三个函数：每个都要 parseUiAutomatorXml 一遍，97KB 的 dump
 * 单次解析约 1ms。拆开写看起来整洁，实测把 parseUiGraph 拖到比
 * 它调用的 parseUiAutomatorDump 还慢 —— 自己重复劳动的典型。
 */
function scanRawTree(tree) {
    const scan = { nodes: 0, systemNodes: 0, screen: null, maxRight: 0, maxBottom: 0, canvases: [] };
    if (!tree) return scan;
    let bestArea = 0;
    const stack = [{ node: tree, system: false }];
    while (stack.length) {
        const { node, system } = stack.pop();
        const filteredSystem = system || isSystemChrome(node.attrs);
        if (node.tag === 'node') {
            scan.nodes += 1;
            if (filteredSystem) scan.systemNodes += 1;
        }
        const box = parseBounds(node.attrs.bounds);
        if (box) {
            if (box.right > scan.maxRight) scan.maxRight = box.right;
            if (box.bottom > scan.maxBottom) scan.maxBottom = box.bottom;
            const size = area(box);
            if (size > bestArea) {
                bestArea = size;
                scan.screen = { width: box.right, height: box.bottom };
            }
            // 像素画布：内部内容不进 a11y 树，只能靠截图看。
            const cls = String(node.attrs.class ?? '');
            const hasLabel = String(node.attrs.text ?? '').trim() !== ''
                || String(node.attrs['content-desc'] ?? '').trim() !== '';
            if (CANVAS_CLASS_RE.test(cls)) {
                scan.canvases.push({
                    cls: cls.replace(/^.*\./, ''),
                    bounds: box,
                    area: size,
                    selfLabeled: hasLabel,
                });
            }
        }
        for (const child of node.children) stack.push({ node: child, system: filteredSystem });
    }
    return scan;
}

/** 从原始 XML 推断屏幕尺寸（供未显式传入 screen 时使用）。 */
function detectScreenFromXml(xml) {
    return scanRawTree(parseUiAutomatorXml(extractHierarchy(xml))).screen;
}

function countNodes(xml) {
    return scanRawTree(parseUiAutomatorXml(extractHierarchy(xml))).nodes;
}

/**
 * 点击落点。
 * 优先取「文本盒」中心：长卡片 / 带 padding 的容器，几何中心常落在空白处。
 * 文本盒来自 port 的本地增补 labelBox（被吸收的文本几何），再裁回控件自身。
 */
function clickPointOf(control, screen) {
    const bounds = control.bounds;
    if (!bounds) return { x: 0, y: 0 };

    const textBox = control.labelBox ? intersectBox(control.labelBox, bounds) : null;
    const base = textBox && area(textBox) > 0 ? centerOf(textBox) : centerOf(bounds);

    const limit = screen
        ? {
            left: Math.max(0, bounds.left),
            top: Math.max(0, bounds.top),
            right: Math.min(screen.width, bounds.right),
            bottom: Math.min(screen.height, bounds.bottom),
        }
        : bounds;

    return {
        x: clampTo(base.x, limit.left, limit.right),
        y: clampTo(base.y, limit.top, limit.bottom),
    };
}

function makeSignature(pkg, controls) {
    const payload = [
        pkg || '',
        ...controls.slice(0, SIGNATURE_SAMPLE).map((c) => JSON.stringify([
            c.cls, c.id, c.text || '', c.desc || '', c[MATCH_LABEL] ?? c.label, c.value || '', c.flags || [],
        ])),
    ].join('\n');
    return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

/**
 * The port forwards attrs.package -> UiNode.pkg -> DescribeNode.package unchanged.
 * A boxed package on a private input copy carries exact provenance through flattening
 * and wrapper folding; public controls immediately normalize it back to a string.
 * System packages remain primitive when filtering, preserving Set-based chrome checks.
 * Explicitly hidden nodes lose their own semantics only in this private copy; children
 * remain traversable. Original XML attributes and ancestor identity remain unchanged.
 */
function provenanceInput(rawRoot, includeSystem) {
    const provenance = new WeakMap();
    if (!rawRoot) return { root: null, provenance, scopes: [] };
    const scopes = [];
    const root = { tag: rawRoot.tag, attrs: { ...rawRoot.attrs }, children: [] };
    const stack = [{ raw: rawRoot, copy: root, parent: null, inWebView: false }];
    while (stack.length) {
        const { raw, copy, parent, inWebView } = stack.pop();
        Object.defineProperty(raw, 'parent', { value: parent });
        const hidden = raw.attrs['visible-to-user'] === 'false' || raw.attrs.displayed === 'false';
        if (hidden) {
            for (const key of ['text', 'content-desc', 'resource-id', 'clickable', 'long-clickable',
                'scrollable', 'checkable', 'checked', 'focusable', 'focused', 'selected', 'password']) delete copy.attrs[key];
            copy.attrs.class = 'android.view.View';
        }
        const pkg = String(raw.attrs.package || '');
        if (includeSystem || !SYSTEM_PACKAGES.has(pkg)) {
            const token = new String(pkg);
            provenance.set(token, raw);
            copy.attrs.package = token;
        }
        const cls = String(raw.attrs.class || '');
        const label = hidden ? '' : raw.attrs.password === 'true' ? PASSWORD_LABEL
            : String(raw.attrs['content-desc'] || raw.attrs.text || '').trim();
        if (raw.tag === 'node') {
            const scope = {
                index: scopes.length, id: String(raw.attrs['resource-id'] || ''), label, ...rawSources(raw),
                cls: cls.replace(/^.*\./, ''),
                role: roleKey(inWebView ? deriveWebRole(cls, raw.attrs, label, raw.children.length > 0)
                    : deriveUiAutomatorRole(cls)),
                bounds: parseBounds(raw.attrs.bounds),
            };
            Object.defineProperties(scope, { rawNode: { value: raw }, fullClass: { value: cls } });
            scopes.push(scope);
        }
        copy.children = raw.children.map((child) => ({ tag: child.tag, attrs: { ...child.attrs }, children: [] }));
        for (let i = raw.children.length - 1; i >= 0; i -= 1) {
            stack.push({ raw: raw.children[i], copy: copy.children[i], parent: raw,
                inWebView: inWebView || cls === 'android.webkit.WebView' || cls === 'android.webkit.WebViewChromium' });
        }
    }
    return { root, provenance, scopes };
}

/**
 * @param {string} xml
 * Full safe controls are retained for actions and assertions. Use projectUiGraph for public output.
 * @param {{screen?: {width:number,height:number}, limit?: number, textLength?: number,
 *          includeDisabled?: boolean, includeSystem?: boolean, includeOffscreen?: boolean,
 *          detail?: boolean, includeCoordinates?: boolean, includeShortId?: boolean,
 *          rpcTarget?: boolean}} [options]
 */
function parseUiGraph(xml, options = {}) {
    const limit = Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : DEFAULT_LIMIT;

    const stats = {
        rawNodes: 0,
        droppedSystem: 0,
        droppedDisabled: 0,
        droppedOffscreen: 0,
        droppedPlaceholder: 0,
        hiddenInScroll: 0,
    };

    const hierarchy = extractHierarchy(xml);
    // Parse XML once; scan the original and prune a provenance-carrying private copy.
    const rawRoot = hierarchy ? parseUiAutomatorXml(hierarchy) : null;
    const rawScan = scanRawTree(rawRoot);
    stats.rawNodes = rawScan.nodes;
    if (options.includeSystem !== true) stats.droppedSystem = rawScan.systemNodes;
    const source = provenanceInput(rawRoot, options.includeSystem === true);

    const screen = options.screen && Number.isFinite(options.screen.width) && options.screen.width > 0
        ? { width: Math.round(options.screen.width), height: Math.round(options.screen.height) }
        : rawScan.screen;

    // includeOffscreen 的实现方式：把「屏幕」临时放大到覆盖全部 bounds，
    // 让 port 的可见性判定放行。比在树里后补节点干净，也不用改 port 的剪枝。
    let pruneScreenW = screen ? screen.width : 0;
    let pruneScreenH = screen ? screen.height : 0;
    if (options.includeOffscreen === true) {
        pruneScreenW = Math.max(pruneScreenW, rawScan.maxRight);
        pruneScreenH = Math.max(pruneScreenH, rawScan.maxBottom);
    }

    let roots = [];
    if (rawRoot) {
        try {
            const tree = parseUiAutomatorTree(
                source.root,
                pruneScreenW || 1,
                pruneScreenH || 1,
                { includeSystem: options.includeSystem === true },
            );
            roots = tree.children || [];
        } catch {
            roots = [];
        }
    }

    const screenArea = screen
        ? { left: 0, top: 0, right: screen.width, bottom: screen.height }
        : null;

    // ---- 树 → 平表，同时做呈现级过滤 ----
    const includeDisabled = options.includeDisabled === true;
    const includeSystem = options.includeSystem === true;
    const includeOffscreen = options.includeOffscreen === true;

    const flat = [];
    for (const { node, level } of flattenTree(roots)) {
        const pkg = String(node.package || '');
        if (!includeSystem && IME_PACKAGE_RE.test(pkg)) {
            stats.droppedSystem += 1;
            continue;
        }
        if (!includeDisabled && node.disabled) stats.droppedDisabled += 1;
        const raw = source.provenance.get(node.package);
        if (raw?.attrs['visible-to-user'] === 'false' || raw?.attrs.displayed === 'false') continue;

        const bounds = fromPixel(node.pixel);
        if (!includeOffscreen && screenArea) {
            if (!bounds || intersectArea(bounds, screenArea) <= 0) {
                stats.droppedOffscreen += 1;
                continue;
            }
        }

        const rawLabel = String(node.label ?? '');
        const matchLabel = node.password ? PASSWORD_LABEL : meaningfulLabel(node[FULL_LABEL] ?? rawLabel, node.cls);
        const label = rawLabel === PASSWORD_LABEL ? PASSWORD_LABEL : meaningfulLabel(rawLabel, node.cls);
        if (rawLabel && !label) stats.droppedPlaceholder += 1;

        // 占位标签被剥掉后变成「无标签、不可交互、无子节点」的纯装饰叶子。
        // port 层无法提前判断（它不知道哪些词是占位），这一层才能判。
        // 注意不能误伤可点控件：那种情况 interactive 为真，不会走到这里。
        const interactive = Boolean(node.clickable || node.longClickable || node.scrollable
            || node.checkable || roleKey(node.role) === 'textfield');
        if (!label && !interactive && node.children.length === 0) {
            stats.droppedPlaceholder += 1;
            continue;
        }

        const rawValue = String(node.value ?? '');
        const value = node.password ? '' : meaningfulLabel(rawValue, node.cls);

        flat.push({
            node,
            level,
            label,
            matchLabel,
            value,
            id: String(node.identifier ?? ''),
            cls: String(node.cls ?? '').replace(/^.*\./, ''),
            role: roleKey(node.role),
            package: pkg,
            bounds,
            labelBox: fromPixel(node.labelBox),
            flags: flagsOfNode(node),
            enabled: !node.disabled,
            scrollHidden: Number(node.scrollHidden) || 0,
        });
    }

    // 整树累加滚动裁剪计数：scrollHidden 记在被裁节点的父级上，不在顶层。
    {
        let sum = 0;
        const stack = [...roots];
        while (stack.length) {
            const n = stack.pop();
            sum += Number(n.scrollHidden) || 0;
            for (const c of n.children) stack.push(c);
        }
        stats.hiddenInScroll = sum;
    }

    const evidenceControls = flat.map((item) => {
        const point = clickPointOf(item, screen);
        const clipped = clipToScreen(item.bounds, screen);
        const control = {
            index: -1,
            level: item.level,
            selector: '',
            label: item.matchLabel,
            value: item.value,
            ...rawSources(source.provenance.get(item.node.package)),
            id: item.id,
            shortId: shortId(item.id),
            cls: item.cls,
            role: item.role,
            package: item.package,
            bounds: item.bounds,
            labelBox: item.labelBox,
            clipped,
            x: point.x,
            y: point.y,
            center: item.bounds ? centerOf(item.bounds) : point,
            flags: item.flags,
            enabled: item.enabled,
            inViewport: screenArea && item.bounds ? intersectArea(item.bounds, screenArea) > 0 : true,
        };
        Object.defineProperties(control, {
            [MATCH_LABEL]: { value: item.matchLabel },
            rawNode: { value: source.provenance.get(item.node.package) || null },
            fullClass: { value: String(item.node.cls || '') },
        });
        return control;
    });

    const allControls = evidenceControls.filter(control => includeDisabled || control.enabled);
    allControls.forEach((control, index) => { control.index = index; });
    const total = allControls.length;

    // Count every exact source across the complete actionable universe, including id-backed rows.
    const escapeKey = (key) => key.replace(/[%#]/g, (char) => char === '%' ? '%25' : '%23');
    const keysOf = (c) => [['id', c.id], ['text', c.text], ['desc', c.desc], ['any', c[MATCH_LABEL]]]
        .filter(([, value]) => value.trim()).map(([kind, value]) => `${kind}=${escapeKey(value)}`);
    const counts = new Map();
    for (const c of allControls) {
        for (const key of keysOf(c)) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const seen = new Map();
    for (const c of allControls) {
        const keys = keysOf(c);
        for (const key of keys) seen.set(key, (seen.get(key) || 0) + 1);
        const key = keys[0];
        const candidate = counts.get(key) > 1 ? `${key}#${seen.get(key)}` : key;
        // counts/seen already prove uniqueness and the ordinal in the complete universe.
        // Validate wire encoding and parser budgets without scanning that universe again.
        try {
            const parsed = parseSelector(candidate);
            const field = ['id', 'text', 'desc', 'any'].find(name => Object.hasOwn(parsed, name));
            c.selector = parsed[field] === (field === 'any' ? c[MATCH_LABEL] : c[field]) ? candidate : null;
        } catch { c.selector = null; }
    }
    const controls = allControls.slice(0, limit);
    const scopeByRaw = new Map(source.scopes.map((scope) => [scope.rawNode, scope]));
    for (const control of evidenceControls) {
        const scope = scopeByRaw.get(control.rawNode);
        if (scope) {
            scope.label = control.label;
            scope.role = control.role;
            Object.defineProperty(scope, MATCH_LABEL, { value: control[MATCH_LABEL] });
        }
    }
    Object.defineProperties(controls, {
        matchingControls: { value: allControls }, evidenceControls: { value: evidenceControls }, scopeControls: { value: source.scopes },
    });

    const pkg = controls.find((c) => c.package)?.package || '';

    // 画布占比：取最大的一个像素画布节点相对屏幕的面积比。
    // 超过 CANVAS_DOMINANT_RATIO 就认为「这一屏主要靠图像传达信息」——
    // 画布内部的东西（地图标注、游戏场景、图表数据）在 a11y 树里不存在，
    // 模型对着控件表是看不到的，必须告诉它可以要截图。
    const screenAreaPx = screen ? screen.width * screen.height : 0;
    const canvasNodes = (rawScan.canvases || []).filter((c) => c.area > 0);
    const canvasCoverage = screenAreaPx > 0 && canvasNodes.length
        ? Math.max(...canvasNodes.map((c) => c.area)) / screenAreaPx
        : 0;
    const labeled = controls.filter((c) => c.label !== '').length;
    // 最大画布的矩形（设备坐标）。视觉通道靠它裁图放大 —— 地图 / 游戏
    // 的信息密度全在这里面，整屏截图再缩小等于什么都没看清。
    const biggest = canvasNodes.reduce((best, c) => (!best || c.area > best.area ? c : best), null);
    const canvasBounds = biggest && biggest.bounds
        ? {
            left: biggest.bounds.left,
            top: biggest.bounds.top,
            width: biggest.bounds.right - biggest.bounds.left,
            height: biggest.bounds.bottom - biggest.bounds.top,
        }
        : null;
    const canvas = {
        present: canvasNodes.length > 0,
        coverage: Math.min(1, canvasCoverage),
        kinds: [...new Set(canvasNodes.map((c) => c.cls))],
        bounds: canvasBounds,
        // 画布占大头但可读控件很少 → 几乎可以肯定关键信息在图像里。
        dominant: canvasCoverage >= CANVAS_DOMINANT_RATIO && labeled <= 3,
        // 画布占大头但确实有一堆可读控件 → 混合界面（如地图 App：
        // 地图本身不可读，但搜索栏、功能入口都还在，仍能操作）。
        mixed: canvasCoverage >= CANVAS_DOMINANT_RATIO && labeled > 3,
    };

    const graph = {
        package: pkg,
        signature: makeSignature(pkg, allControls),
        screen,
        controls,
        total,
        truncated: total > controls.length,
        // 锁屏时整棵树落在 systemui 下被过滤干净，剩 0 条。
        // 上层据此提示「先点亮屏幕」，而不是让模型对着空表猜。
        keyguard: controls.length === 0 && stats.droppedSystem > 0,
        canvas,
        stats,
    };
    Object.defineProperties(graph, {
        matchingControls: { value: allControls }, evidenceControls: { value: evidenceControls }, scopeControls: { value: source.scopes },
        [PRESENTATION_OPTIONS]: { value: {
            textLength: options.textLength, detail: options.detail,
            includeCoordinates: options.includeCoordinates, includeShortId: options.includeShortId,
        } },
    });
    if (options.rpcTarget === true) {
        // Retain unfiltered identity evidence without serializing raw field values.
        Object.defineProperty(graph, 'rawRoot', { value: rawRoot });
    }
    return graph;
}

// ---------------------------------------------------------------------------
// 寻址
// ---------------------------------------------------------------------------

function samePage(a, b) {
    if (!a || !b) return false;
    return a.signature === b.signature && (a.package || '') === (b.package || '');
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/**
 * Public-only projection. Reprojection starts from full evidence, never a clipped display string.
 * Coordinates and short ids are opt-in; selectors and full resource ids remain consumable.
 * Matching metadata is deliberately non-enumerable on both graph and controls array.
 */
function projectUiGraph(graph, options = {}) {
    const source = graph?.[PRESENTATION_SOURCE] || graph;
    const settings = { ...source?.[PRESENTATION_OPTIONS], ...graph?.[PRESENTATION_OPTIONS], ...options };
    const textLength = Number.isFinite(settings.textLength) && settings.textLength > 0
        ? Math.floor(settings.textLength) : DEFAULT_TEXT_LENGTH;
    const coordinates = settings.includeCoordinates ?? settings.detail === true;
    const ids = settings.includeShortId ?? settings.detail === true;
    const limit = Number.isFinite(settings.limit) && settings.limit > 0 ? Math.floor(settings.limit) : Infinity;
    const controls = (source?.controls || []).slice(0, limit).map((control) => {
        const { x, y, bounds, clipped, center, labelBox, shortId: identifier, ...rest } = control;
        const row = { ...rest, presentationOnly: true };
        for (const field of ['label', 'text', 'desc', 'value']) row[field] = normalizeText(control[field], textLength);
        if (coordinates) Object.assign(row, { x, y, bounds, clipped, center, labelBox });
        if (ids) row.shortId = identifier;
        return row;
    });
    const projected = { ...source, controls, presentationOnly: true,
        truncated: (source?.total ?? controls.length) > controls.length };
    const metadata = {};
    for (const key of ['matchingControls', 'evidenceControls', 'scopeControls']) {
        if (source?.[key]) metadata[key] = { value: source[key] };
    }
    Object.defineProperties(controls, metadata);
    Object.defineProperties(projected, {
        ...metadata, [PRESENTATION_SOURCE]: { value: source }, [PRESENTATION_OPTIONS]: { value: settings },
    });
    return projected;
}

/**
 * 画布提示语。说人话：uiautomator 只看得见视图树，看不见像素。
 * 写得含糊模型就会去点一个空壳节点，然后疑惑为什么没反应。
 */
function canvasNote(canvas) {
    if (!canvas || !canvas.present) return '';
    const pct = Math.round((canvas.coverage || 0) * 100);
    const kind = (canvas.kinds || []).join('/') || '画布';
    if (canvas.dominant) {
        return `⚠ 这一屏主要是 ${kind}（占屏 ${pct}%），内部内容为像素，无法从控件树读取。\n`
            + '  下面只有少量外围控件。如果需要操作画布里的东西，请先要截图（screenshot:true）用视觉判断位置，再按坐标点击。';
    }
    if (canvas.mixed) {
        return `提示：存在 ${kind}（占屏 ${pct}%），其内部内容（地图标注 / 图像 / 场景）不在控件树里，仅外围控件可读。`;
    }
    return '';
}

function renderView(graph, options = {}) {
    const view = projectUiGraph(graph, options);
    const controls = view.controls;
    const note = canvasNote(view.canvas);
    if (!controls.length) {
        if (note) return `${note}\n(未识别到可交互控件)`;
        return '(未识别到可交互控件)';
    }

    const screen = view.screen ? `${view.screen.width}×${view.screen.height}` : '未知分辨率';
    const indent = options.indent === undefined ? '  ' : String(options.indent);
    const header = [
        `页面 ${view.package || '(未知包名)'}  ${screen}`,
        `控件 ${controls.length}${view.truncated ? ` / 共 ${view.total}（已截断，可提高 limit）` : ''}`,
    ].join('  ');

    const lines = controls.map((control) => {
        const pad = indent.repeat(control.level || 0);
        const flags = control.flags.length ? ` [${control.flags.join(',')}]` : '';
        const ident = control.shortId ? ` #${control.shortId}` : '';
        const role = NOTEWORTHY_ROLES.has(control.role) ? ` <${control.role}>` : '';
        const value = control.value ? ` =${control.value}` : '';
        const label = control.label || '(无标签)';
        const addressing = control.selector === null ? '（仅限本次快照 index+snapshotId）' : '';
        const coordinates = control.x !== undefined && control.y !== undefined ? ` (${control.x},${control.y})` : '';
        return `${pad}[${control.index}] ${label}${value}${role}${coordinates}${ident}${flags}${addressing}`;
    });

    return `${note ? `${note}\n` : ''}${header}\n${lines.join('\n')}`;
}

module.exports = {
    DEFAULT_LIMIT,
    DEFAULT_TEXT_LENGTH,
    LABEL_SEPARATOR,
    PASSWORD_LABEL,
    CANVAS_DOMINANT_RATIO,
    canvasNote,
    clickPointOf,
    clipToScreen,
    countNodes,
    decodeEntities,
    detectScreen,
    detectScreenFromXml,
    extractHierarchy,
    findControls,
    makeSignature,
    meaningfulLabel,
    normalizeText,
    parseAttributes,
    parseBounds,
    parseUiGraph,
    projectUiGraph,
    parseSelector,
    validateSelector,
    evaluateSelector,
    renderView,
    resolveSelector,
    samePage,
    shortId,
    toPixel,
    unionPixelBounds,
};
