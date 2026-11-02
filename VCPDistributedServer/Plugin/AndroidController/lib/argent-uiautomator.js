'use strict';

/**
 * Android `uiautomator dump` 解析器 —— software-mansion/argent 的忠實移植。
 *
 * 来源：https://github.com/software-mansion/argent
 *       packages/tool-server/src/tools/describe/platforms/android/uiautomator-parser.ts
 * 许可：Apache License 2.0（Copyright 2026 Software Manson S.A.）
 *
 * 移植约定：
 * - 算法、判定顺序、注释要点逐条保留，不改成「更顺手」的写法。
 *   这份实现被上游的大量真机样本打磨过，改动前先确认是在修 bug 而不是改口味。
 * - TypeScript 类型擦除，`Map<T, U>` 直接映射到 `Map`。
 * - 唯一的结构性增补：DescribeNode 上多挂一个非契约字段 `pixel`（像素 bounds，
 *   与归一化 `frame` 并存）。上游只给归一化坐标，而本项目的 Tap 动作需要像素点；
 *   由下游从 `pixel` 换算，不参与 prune 判定。
 *
 * 对外只有 parseUiAutomatorDump 是稳定入口，其余导出供测试直接验证单条规则。
 */

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * uiautomator dump 的极简解析器：只用属性，无 CDATA，零依赖。
 */
function parseUiAutomatorXml(xml) {
    const body = String(xml ?? '').replace(/^\s*<\?xml[^?]*\?>\s*/, '');

    // 属性值里可以出现裸 `>`（XML 只转义 `<` 和 `&`），所以 attr 块按「引号内的
    // 整段内容」匹配；未加引号的字符集排除 `/`，以免吃掉自闭合标记。
    //
    // 用贪心 `*` 而非懒情 `*?`：属性块内的字符集已排除 `/` 与 `>`，
    // 贪心匹配到终止符后不会跨越标签边界，实测快约 2x（336μs → 164μs / 97KB），
    // 截断输入的退化场景也实测不劣化。
    const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^"'/<>])*)\s*(\/?)>/gs;

    const stack = [];
    let root = null;
    let match;

    while ((match = tagRe.exec(body)) !== null) {
        const [, closing, tag, rawAttrs, selfClose] = match;

        if (closing) {
            if (stack.length > 0) stack.pop();
            continue;
        }

        const attrs = parseAttributes(rawAttrs ?? '');
        const node = { tag, attrs, children: [] };
        const parent = stack[stack.length - 1];

        if (parent) {
            parent.children.push(node);
        } else if (root === null) {
            root = node;
        } else {
            // 输入被截断时栈上下文丢失（典型是少了 `</hierarchy>`）；
            // 把孤儿挂回根，保证后序兄弟仍然可达。
            root.children.push(node);
        }

        if (!selfClose) stack.push(node);
    }

    return root;
}

/**
 * 手写属性扫描器。不用正则：每个节点都新建 RegExp 的开销远比扫描本身贵
 * （实测 264 节点 327μs vs 手写 300μs，且手写在短属性块上更明显）。
 * 单遍推进，不回溯，不构造中间数组。
 */
function parseAttributes(raw) {
    const attrs = {};
    const n = raw.length;
    let i = 0;

    while (i < n) {
        // 跳过 `=` 之前的空白
        while (i < n && raw.charCodeAt(i) <= 32) i += 1;
        const keyStart = i;
        while (i < n && raw.charCodeAt(i) !== 61) i += 1; // '='
        if (i >= n) break;

        let keyEnd = i;
        while (keyEnd > keyStart && raw.charCodeAt(keyEnd - 1) <= 32) keyEnd -= 1;
        const key = raw.slice(keyStart, keyEnd);

        i += 1; // 跳过 '='
        while (i < n && raw.charCodeAt(i) <= 32) i += 1;

        // 引号可以是双或单：uiautomator 遇到值本身带双引号时（微信消息正文
        // 常见 "解." 这种）会改用单引号包裹。两种都要认，否则那段文本全丢。
        //
        // 【本地修正】上游只认双引号，且遇到其它字符直接 continue 不推进 i，
        // 于是下一次循环从单引号值内部开始扫 '=' —— 真机上会拼出
        // 键名 =『[3条] "解."...' resource-id』这种脏项，把后面的
        // resource-id 一并吃掉。这里既补上单引号，也保证无法识别时必定推进。
        const quote = raw.charCodeAt(i);
        if (quote !== 34 && quote !== 39) {
            while (i < n && raw.charCodeAt(i) > 32) i += 1; // 未知形态：跳过这个 token
            continue;
        }

        i += 1;
        const valueStart = i;
        while (i < n && raw.charCodeAt(i) !== quote) i += 1;
        // 未闭合的引号（截断的 dump）：收下到结尾，不让整块属性作废。
        const value = raw.slice(valueStart, i);
        if (i < n) i += 1;

        if (key) attrs[key] = decodeXmlEntities(value);
    }

    return attrs;
}

/**
 * 单趟替换，不做逐实体链式 replace：
 * 链式会把 `&amp;lt;`（字面量 `<` 的编码）二次解码，一路变成 `<`。
 */
function decodeXmlEntities(s) {
    // 短路：绝大部分属性值（类名、包名、坐标）不含实体。
    // indexOf 一次线性扫比无条件启动替换引擎便宜一个数量级。
    if (typeof s === 'string' && s.indexOf('&') === -1) return s;
    return String(s ?? '').replace(
        /&(?:#x([0-9A-Fa-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/g,
        (whole, hex, dec, name) => {
            if (hex) return safeFromCodePoint(Number.parseInt(hex, 16));
            if (dec) return safeFromCodePoint(Number.parseInt(dec, 10));
            switch (name) {
                case 'amp': return '&';
                case 'lt': return '<';
                case 'gt': return '>';
                case 'quot': return '"';
                case 'apos': return "'";
                default: return whole;
            }
        },
    );
}

function safeFromCodePoint(n) {
    // 数字引用可以指向超出 Unicode 的值或代理区半体；丢弃字形而不是抛错。
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
    if (n >= 0xd800 && n <= 0xdfff) return '';
    try {
        return String.fromCodePoint(n);
    } catch {
        return '';
    }
}

function parseUiAutomatorBounds(bounds) {
    const m = String(bounds ?? '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!m) return null;
    const x1 = Number.parseInt(m[1], 10);
    const y1 = Number.parseInt(m[2], 10);
    const x2 = Number.parseInt(m[3], 10);
    const y2 = Number.parseInt(m[4], 10);
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/**
 * 把 uiautomator 像素矩形裁到屏幕内。
 * parseUiAutomatorBounds 保留负原点和越界角点，方便调用方识别「部分出屏」的视图；
 * 本函数返回可见部分，供 describe 归一化到 [0,1] 使用。
 */
function clipBoundsToScreen(b, screenW, screenH) {
    if (screenW <= 0 || screenH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
    const x1 = Math.max(0, Math.min(b.x, screenW));
    const y1 = Math.max(0, Math.min(b.y, screenH));
    const x2 = Math.max(0, Math.min(b.x + b.w, screenW));
    const y2 = Math.max(0, Math.min(b.y + b.h, screenH));
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------

function deriveUiAutomatorRole(className) {
    const short = String(className ?? '').split('.').pop() ?? String(className ?? '');
    const lower = short.toLowerCase();

    // radiobutton 包含 button，具体类必须先判。
    if (lower.includes('radiobutton')) return 'RadioButton';
    if (lower.includes('checkbox')) return 'CheckBox';
    if (lower.includes('button')) return 'Button';
    if (lower.includes('edittext') || lower.includes('textinput')) return 'TextField';
    if (lower.includes('textview') || lower === 'text') return 'StaticText';
    if (lower.includes('image')) return 'Image';
    if (lower.includes('switch')) return 'Switch';
    if (lower.includes('scrollview') || lower.includes('recyclerview') || lower.includes('listview')) return 'ScrollView';
    if (lower.includes('webview')) return 'WebView';
    return short || 'View';
}

/** v2 interactables-only 修剪：丢弃脚手架与装饰，保留每个可点、文本、content-desc 与 resource-id。 */
const NOISY_CLASSES = new Set([
    // react-native-svg 图标内部：永不可点，且父节点已带图标 content-desc。
    'com.horcrux.svg.PathView',
    'com.horcrux.svg.GroupView',
    'com.horcrux.svg.SvgView',
]);

/** 某个原始类名是不是该连同子树一起丢掉的装饰性实现细节。 */
function isNoisyUiAutomatorClass(className) {
    return NOISY_CLASSES.has(className);
}

const SYSTEM_PACKAGES = new Set([
    // 状态栏 / 导航栏 / 快捷设置。只列 systemui 是有意为之：
    // 前台系统应用（设置、权限弹窗）必须照常暴露。
    'com.android.systemui',
]);

const SYSTEM_RID_PREFIXES = [
    'android:id/navigationBarBackground',
    'android:id/statusBarBackground',
    'com.android.systemui:id/',
];

const LAYOUT_CONTAINERS = new Set([
    'android.widget.FrameLayout',
    'android.widget.LinearLayout',
    'android.widget.RelativeLayout',
    'androidx.constraintlayout.widget.ConstraintLayout',
    'androidx.coordinatorlayout.widget.CoordinatorLayout',
    'android.view.ViewGroup',
    // Compose 对没有组件映射的语义节点会发裸 android.view.View。
    'android.view.View',
]);

function isUiAutomatorLayoutContainer(className) {
    return !className || LAYOUT_CONTAINERS.has(className);
}

const SCROLL_CLASSES = new Set([
    'android.widget.ScrollView',
    'android.widget.HorizontalScrollView',
    'androidx.recyclerview.widget.RecyclerView',
    'android.widget.ListView',
]);

/**
 * 节点是否滚动其内容 —— 已知滚动类，或标记了 `scrollable`
 * （RN 的 ScrollView dump 成 scrollable 的 ViewGroup）。
 * 它的 bounds 会成为滚动裁剪的窗口。
 */
function isUiAutomatorScrollable(attrs, inWebView = false) {
    // WebView 内部，类名是 Chromium 对 HTML 标签的映射而非滚动容器：
    // `<div>` 会以 android.widget.ListView + scrollable="false" 到达，并不滚动。
    // 那里只认框架标志，否则列表盒子会把页面裁掉一圈。
    if (inWebView) return attrIsTrue(attrs, 'scrollable');
    return SCROLL_CLASSES.has(attrs.class ?? '') || attrIsTrue(attrs, 'scrollable');
}

const WEBVIEW_CLASSES = new Set(['android.webkit.WebView', 'android.webkit.WebViewChromium']);

function hasGestureFlag(attrs) {
    return attrIsTrue(attrs, 'clickable')
        || attrIsTrue(attrs, 'long-clickable')
        || attrIsTrue(attrs, 'checkable')
        || attrIsTrue(attrs, 'scrollable');
}

/**
 * Chromium 为 HTML 元素发布的节点角色。
 * 一段纯文本是无手势标志、带标签的叶子 `android.view.View`
 * （focusable 在这里说明不了什么 —— Chromium 会给某些文本段设上），
 * 而 `<div>` 是不滚动的 `android.widget.ListView`。
 */
function deriveWebRole(cls, attrs, label, hasRawChildren) {
    if (cls === 'android.view.View' && label && !hasRawChildren && !hasGestureFlag(attrs)) {
        return 'StaticText';
    }
    const role = deriveUiAutomatorRole(cls);
    if (role === 'ScrollView' && !attrIsTrue(attrs, 'scrollable')) return 'List';
    return role;
}

function attrIsTrue(attrs, key) {
    return attrs[key] === 'true';
}

function isInteractive(attrs) {
    if (hasGestureFlag(attrs)) return true;
    // 有 focusable 但没标签，只是布局壳上的焦点陷阱。
    if (attrIsTrue(attrs, 'focusable') && labelOf(attrs) !== '') return true;
    return false;
}

function labelOf(attrs) {
    // content-desc 优先：EditText 带 content-desc="Email" text="x@y" 时
    // 输出 label="Email"，并通过 makeUiNode 输出 value="x@y"。
    const cd = String(attrs['content-desc'] ?? '').trim();
    if (cd) return cd;
    return String(attrs.text ?? '').trim();
}

function isVisibleRect(b, sw, sh) {
    if (!b) return false;
    if (b.w <= 0 || b.h <= 0) return false;
    if (b.x >= sw || b.y >= sh || b.x + b.w <= 0 || b.y + b.h <= 0) return false;
    return true;
}

function isSystemChrome(attrs) {
    if (SYSTEM_PACKAGES.has(attrs.package ?? '')) return true;
    const rid = attrs['resource-id'] ?? '';
    return SYSTEM_RID_PREFIXES.some((p) => rid.startsWith(p));
}

function rectsEqual(a, b) {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * 矩形是否完全落在裁剪窗口之外 —— 即被滚出容器视口的视图。
 */
function rectFullyOutside(kid, clip) {
    return kid.x + kid.w <= clip.x || kid.x >= clip.x + clip.w
        || kid.y + kid.h <= clip.y || kid.y >= clip.y + clip.h;
}

/**
 * 拼接 `parsed` 下所有非空 text / content-desc，去重并截断，
 * 让没有自身标签的可点容器借用后代标签（「整行即点击目标」模式）。
 */
/**
 * 拼接 `parsed` 下所有非空 text / content-desc，去重并截断，
 * 让没有自身标签的可点容器借用后代标签（「整行即点击目标」模式）。
 *
 * 【本地偏离】上游会把后代里「自己就是点击目标」的文本也借上来。
 * 真机后果：卡片容器的标签变成「消息标题 / 删除」，而那个删除按钮本来
 * 会单独成条 —— 模型看到两个标签都提到「删除」，分不清点哪个才是标题区。
 * 这里跳过自身可点的后代（它们的文本归它们自己），并在 out.labelBox
 * 里记录被借用文本的像素盒，供点击落点使用（上游只给归一化 frame，
 * 丢了吸收掉的文本几何，落点只能退回容器中心）。
 */
function descendantText(parsed, maxChars = 120, out = null) {
    const parts = [];
    const seen = new Set();
    const stack = [parsed];
    const boxes = [];

    while (stack.length > 0) {
        const x = stack.pop();

        // 密码字段的 text 是密钥本身，而这里走的是原始 XML，
        // 绕过了节点自身 label 上的 [password] 脱敏。
        if (attrIsTrue(x.attrs, 'password')) {
            if (!seen.has('[password]')) {
                seen.add('[password]');
                parts.push('[password]');
            }
            continue;
        }

        const ownLabel = String(x.attrs['content-desc'] ?? '').trim()
            || String(x.attrs.text ?? '').trim();
        const ownTapTarget = ownLabel !== ''
            && (attrIsTrue(x.attrs, 'clickable') || attrIsTrue(x.attrs, 'long-clickable'));

        if (!ownTapTarget) {
            for (const k of ['text', 'content-desc']) {
                const v = String(x.attrs[k] ?? '').trim();
                if (v && !seen.has(v)) {
                    seen.add(v);
                    parts.push(v);
                    const b = parseUiAutomatorBounds(x.attrs.bounds ?? '');
                    if (b) boxes.push(b);
                }
            }
        }

        // 逆序压栈，保证按文档顺序弹出。
        for (let i = x.children.length - 1; i >= 0; i -= 1) {
            const c = x.children[i];
            if (c.tag === 'node') stack.push(c);
        }
    }

    if (out && boxes.length > 0) out.labelBox = unionPixelBounds(boxes);

    const s = parts.join(' / ');
    return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** 像素矩形的并集（本地增补，供 labelBox 使用）。 */
function unionPixelBounds(boxes) {
    if (!boxes.length) return null;
    let x1 = boxes[0].x;
    let y1 = boxes[0].y;
    let x2 = boxes[0].x + boxes[0].w;
    let y2 = boxes[0].y + boxes[0].h;
    for (const b of boxes) {
        x1 = Math.min(x1, b.x);
        y1 = Math.min(y1, b.y);
        x2 = Math.max(x2, b.x + b.w);
        y2 = Math.max(y2, b.y + b.h);
    }
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

function makeUiNode(attrs, role, pixelBounds, label, children) {
    const out = {
        role,
        pixelBounds,
        children,
        interactive: isInteractive(attrs),
        clickable: attrIsTrue(attrs, 'clickable'),
        longClickable: attrIsTrue(attrs, 'long-clickable'),
        scrollable: attrIsTrue(attrs, 'scrollable'),
        checkable: attrIsTrue(attrs, 'checkable'),
        checked: attrIsTrue(attrs, 'checked'),
        disabled: attrs.enabled === 'false',
        password: attrIsTrue(attrs, 'password'),
        scrollHidden: 0,
    };
    if (label) out.label = label;
    if (attrs.class) out.cls = attrs.class;
    if (attrs.package) out.pkg = attrs.package;
    const rid = attrs['resource-id'];
    if (rid) out.identifier = rid;

    // text 与 label 不同（label 来自 content-desc）时，它是输入内容的当前值。
    // 密码字段跳过：label 已脱敏，但 attrs.text 仍是密钥。
    if (!out.password) {
        const text = String(attrs.text ?? '').trim();
        if (text && text !== label) out.value = text;
    }
    return out;
}

/**
 * 对 `root` 子树应用 v2 修剪规则，返回取代它的 UiNode：
 *   []          丢弃
 *   [n]         保留，可能已折叠 / 聚合
 *   [a,b,...]   透传包装；其保留的子节点内联到父级
 */
function pruneSubtree(root, opts) {
    // 迭代后序。每帧携带自己必须施加给子节点的裁剪窗口，
    // 于是过滤发生在「被裁剪节点的父节点」上。
    const stack = [{ parsed: root, scrollClip: null, inWebView: false, visited: false }];
    const outputs = new Map();

    while (stack.length > 0) {
        const top = stack[stack.length - 1];

        if (!top.visited) {
            top.visited = true;
            const attrs = top.parsed.attrs;
            const myBounds = parseUiAutomatorBounds(attrs.bounds ?? '');
            const isScroll = isUiAutomatorScrollable(attrs, top.inWebView);

            // 我滚动就把我的 bounds 作为子节点的裁剪窗口，否则继承我收到的那个。
            const childClip = isScroll && myBounds ? myBounds : top.scrollClip;
            const childInWebView = top.inWebView || WEBVIEW_CLASSES.has(attrs.class ?? '');

            for (let i = top.parsed.children.length - 1; i >= 0; i -= 1) {
                const c = top.parsed.children[i];
                if (c.tag === 'node') {
                    stack.push({
                        parsed: c,
                        scrollClip: childClip,
                        inWebView: childInWebView,
                        visited: false,
                    });
                }
            }
        } else {
            outputs.set(
                top.parsed,
                computeNodeOutput(top.parsed, top.scrollClip, top.inWebView, outputs, opts),
            );
            stack.pop();
        }
    }

    return outputs.get(root) ?? [];
}

function computeNodeOutput(parsed, scrollClip, inWebView, outputs, opts) {
    const attrs = parsed.attrs;
    const cls = attrs.class ?? '';

    if (NOISY_CLASSES.has(cls)) return [];
    if (!opts.includeSystem && isSystemChrome(attrs)) return [];

    const bounds = parseUiAutomatorBounds(attrs.bounds ?? '');
    const visible = isVisibleRect(bounds, opts.screenW, opts.screenH);

    // The current scroll viewport applies to its children, not its grandchildren.
    const childClip = isUiAutomatorScrollable(attrs, inWebView) && bounds ? bounds : scrollClip;
    let keptChildren = [];
    let hiddenInScroll = 0;
    for (const c of parsed.children) {
        if (c.tag !== 'node') continue;
        const kids = outputs.get(c);
        if (!kids) continue;
        for (const kid of kids) {
            if (childClip && kid.pixelBounds && rectFullyOutside(kid.pixelBounds, childClip)) {
                hiddenInScroll += 1;
                continue;
            }
            keptChildren.push(kid);
        }
    }

    // Chromium 把 web DOM 发布成 WebView 的子节点，上面的修剪已经跑过一遍。
    // 自己宿主 WebView 的应用会在同一个类名下 dump 出嵌套的一对 ——
    // 应用自己的视图，再是 Chromium 的根 web area（把页面承载为文本），
    // 于是把内层折进外层；浏览器标签页到达时就是单个节点。
    // 这里提前返回也让下面的标签去重不会作用到页面内容：
    // 重复标题的页内标题必须保留。
    if (WEBVIEW_CLASSES.has(cls)) {
        if (!visible) return keptChildren;
        let label = labelOf(attrs);
        let children = keptChildren;
        const inner = children.length === 1 && children[0].webHost ? children[0] : undefined;
        if (inner) {
            children = inner.children;
            if (!label && inner.label) label = inner.label;
        }

        // Chromium 在第一次请求时才构建树，所以底下空的 WebView 通常是页面还没读；
        // describeAndroid 会再读一次。若仍为空，页面确实没有可访问内容。
        if (!label && children.length === 0) label = '(no web content exposed)';

        const node = makeUiNode(attrs, 'WebView', bounds, label, children);
        node.webHost = true;
        if (inner) {
            node.clickable = node.clickable || inner.clickable;
            node.longClickable = node.longClickable || inner.longClickable;
            node.scrollable = node.scrollable || inner.scrollable;
            if (!node.identifier && inner.identifier) node.identifier = inner.identifier;
        }
        const hidden = hiddenInScroll + (inner ? inner.scrollHidden : 0);
        if (hidden > 0) node.scrollHidden = hidden;
        return [node];
    }

    const interactive = isInteractive(attrs);
    let label = labelOf(attrs);
    let labelBox = null;

    // 在派生 label 的地方脱敏，而不是在 makeUiNode：
    // 下面几处折叠会把这个 label 复制到幸存子节点上并提前 return，
    // 事后再脱敏会漏掉这些路径。
    if (attrIsTrue(attrs, 'password')) {
        label = '[password]';
    }

    // 装饰性 ImageView —— 丢弃，透传幸存的子节点。
    if (cls.endsWith('.ImageView') && !interactive && !label) {
        return keptChildren;
    }

    // 无自身信息的布局容器 —— 透传子节点，压平
    // FrameLayout > LinearLayout > ConstraintLayout 这种 --compressed 留下的长链。
    if (LAYOUT_CONTAINERS.has(cls) && !interactive && !label) {
        return keptChildren;
    }

    if (!visible && keptChildren.length === 0) return [];

    // 无自身标签的复合可点容器：借用后代标签。
    // 纯滚动容器排除 —— 它们的后代是一整屏文本。
    //
    // 【本地偏离】上游注释已声明排除滚动容器，但条件里漏了 scrollable 判定。
    // 真机后果：微信会话列表的 ListView 带 long-clickable="true"（长按弹菜单），
    // 于是它把整屏会话列表的标题全借到自己名下 —— 表首多出 700+ 字节纯重复，
    // 而且模型会以为那个长标签本身是可点目标。补上 scrollable 排除。
    if ((attrIsTrue(attrs, 'clickable') || attrIsTrue(attrs, 'long-clickable'))
        && !isUiAutomatorScrollable(attrs, inWebView)
        && !label && keptChildren.length > 0) {
        const aggOut = {};
        const agg = descendantText(parsed, 120, aggOut);
        if (agg) label = agg;
        labelBox = aggOut.labelBox || null;
    }

    // 重复包装折叠：可点父节点唯一的幸存后代也是可点、且 bounds 完全相同，
    // 那就是同一个点击目标出现两次；保留内层。
    if (interactive && bounds && keptChildren.length === 1) {
        const c = keptChildren[0];
        if (c.clickable && c.pixelBounds && rectsEqual(c.pixelBounds, bounds)) {
            // 标签可能只活在外层包装上（RN 的 Pressable accessibilityLabel 套裸可点原生视图），
            // 这时回填外层的值而不是丢掉。
            if (!c.label && label) c.label = label;
            const rid = attrs['resource-id'];
            if (!c.identifier && rid) c.identifier = rid;
            return [c];
        }
    }

    // 丢弃 label 已被父标签包含的子节点，
    // 免得模型同时看到「赞（634 次赞）」和一个光秃秃的「634」。
    //
    // 【本地偏离】上游只对 role === 'StaticText' 去重。真机发现不够：
    // 微信会话列表每一行都是自绘 View（role=View），于是同一段标题会以
    // 『行（借用标签）』+『子 View（自有标签）』两份同时进表 —— 43 条里
    // 有近一半是重复行。意图明显是「同一段文字不要出现两次」，
    // 仅去重无交互的叶子；包装节点即使不可点，也不能连同后代一起删除。
    if (interactive && label) {
        const lower = label.toLowerCase();
        keptChildren = keptChildren.filter((c) => !(
            c.label
            && lower.includes(c.label.toLowerCase())
            && !c.interactive
            && c.children.length === 0
            && c.role !== 'TextField'
        ));
    }

    const role = inWebView
        ? deriveWebRole(cls, attrs, label, parsed.children.some((c) => c.tag === 'node'))
        : deriveUiAutomatorRole(cls);

    const node = makeUiNode(attrs, role, bounds, label, keptChildren);
    if (hiddenInScroll > 0) node.scrollHidden = hiddenInScroll;
    if (labelBox) node.labelBox = labelBox;
    return [node];
}

/**
 * 把 UiNode 树下沉到公开的 DescribeNode 契约。
 * 迭代后序，深树（RN 页面能堆到约 30 层）不会爆栈。
 */
function describeFromUiTree(root, sw, sh) {
    const out = new Map();
    const stack = [{ node: root, visited: false }];

    while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (!top.visited) {
            top.visited = true;
            for (let i = top.node.children.length - 1; i >= 0; i -= 1) {
                stack.push({ node: top.node.children[i], visited: false });
            }
        } else {
            const childDns = [];
            for (const c of top.node.children) {
                const dn = out.get(c);
                if (dn) childDns.push(dn);
            }
            out.set(top.node, finalizeUiNode(top.node, childDns, sw, sh));
            stack.pop();
        }
    }

    return out.get(root) ?? null;
}

function finalizeUiNode(n, children, sw, sh) {
    let frame;
    let pixel = null;

    if (n.pixelBounds) {
        // 先裁再归一化：分别把 x 和 width 夹到 [0,1] 会让 x + width 超过 1
        // （1080 宽屏上 bounds=[1090,0][1280,200] 得到 x=1、width≈0.176，
        // 点击中心就落到屏外了）。
        const clipped = clipBoundsToScreen(n.pixelBounds, sw, sh);
        frame = {
            x: sw > 0 ? clipped.x / sw : 0,
            y: sh > 0 ? clipped.y / sh : 0,
            width: sw > 0 ? clipped.w / sw : 0,
            height: sh > 0 ? clipped.h / sh : 0,
        };
        // 本地增补：保留裁后的像素矩形容器，供 Tap 动作换算坐标。
        pixel = { x: clipped.x, y: clipped.y, w: clipped.w, h: clipped.h };
    } else {
        // 无 bounds 的 Compose 组容器：空壳丢弃，单子脚手架透传，否则取子节点 frame 的并集。
        // 带自身 label / identifier 的单子包装保留不压平，好让那个 label 活下来。
        if (children.length === 0) return null;
        if (children.length === 1 && !n.label && !n.identifier) return children[0];
        const x1 = Math.min(...children.map((c) => c.frame.x));
        const y1 = Math.min(...children.map((c) => c.frame.y));
        const x2 = Math.max(...children.map((c) => c.frame.x + c.frame.width));
        const y2 = Math.max(...children.map((c) => c.frame.y + c.frame.height));
        frame = { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
    }

    const out = { role: n.role, frame, children };
    if (pixel) out.pixel = pixel;
    if (n.label) out.label = n.label;
    if (n.identifier) out.identifier = n.identifier;
    if (n.value) out.value = n.value;
    if (n.clickable) out.clickable = true;
    if (n.longClickable) out.longClickable = true;
    if (n.scrollable) out.scrollable = true;
    if (n.checkable) out.checkable = true;
    if (n.checked) out.checked = true;
    if (n.disabled) out.disabled = true;
    if (n.password) out.password = true;
    if (n.scrollHidden > 0) out.scrollHidden = n.scrollHidden;
    // 本地增补：原始类名与来源包。DescribeNode 不带它们，
    // 但渲染层要区分 ImageView / Button，过滤层要按包名剔除系统壳。
    if (n.cls) out.cls = n.cls;
    if (n.pkg) out.package = n.pkg;
    // 本地增补：被借用标签的像素盒，供点击落点取「文本中心」而不是容器中心。
    if (n.labelBox) out.labelBox = n.labelBox;
    return out;
}

/**
 * 把 `uiautomator dump` 输出解析成与 iOS describe 契约一致的 DescribeNode 树，
 * 让同一套「frame + 点击点」指引同时适用。上面那些 v2 修剪在此生效。
 *
 * `includeSystem` 默认 false：SystemUI 外壳在应用级任务里是噪声。
 */
function parseUiAutomatorDump(rawOutput, screenW, screenH, options = {}) {
    let xml = String(rawOutput ?? '');
    const xmlEnd = xml.lastIndexOf('</hierarchy>');
    if (xmlEnd !== -1) xml = xml.slice(0, xmlEnd + '</hierarchy>'.length);

    const root = parseUiAutomatorXml(xml);
    if (!root) {
        const got = String(rawOutput ?? '').trim()
            ? `${String(rawOutput).length} chars: ${JSON.stringify(String(rawOutput).slice(0, 200))}`
            : 'empty';
        const err = new Error(`Failed to parse uiautomator dump output (${got})`);
        err.code = 'ANDROID_UIAUTOMATOR_PARSE_FAILED';
        throw err;
    }

    return parseUiAutomatorTree(root, screenW, screenH, options);
}

/**
 * 同 parseUiAutomatorDump，但接收已解析的根节点。
 * 供已经为了其它目的（节点统计 / 屏幕推断）解析过一次的调用方复用，
 * 97KB 的 dump 单次解析约 1ms，不该为拿个计数再来一遍。
 */
function parseUiAutomatorTree(root, screenW, screenH, options = {}) {
    const includeSystem = options.includeSystem === true;
    const opts = { screenW, screenH, includeSystem };
    const topChildren = [];

    for (const c of root.children) {
        if (c.tag !== 'node') continue;
        const ui = pruneSubtree(c, opts);
        for (const n of ui) {
            const dn = describeFromUiTree(n, screenW, screenH);
            if (dn) topChildren.push(dn);
        }
    }

    return { role: 'Screen', frame: { x: 0, y: 0, width: 1, height: 1 }, children: topChildren };
}

module.exports = {
    attrIsTrue,
    clipBoundsToScreen,
    decodeXmlEntities,
    deriveUiAutomatorRole,
    deriveWebRole,
    descendantText,
    unionPixelBounds,
    isInteractive,
    isNoisyUiAutomatorClass,
    isSystemChrome,
    isUiAutomatorLayoutContainer,
    isUiAutomatorScrollable,
    labelOf,
    parseAttributes,
    parseUiAutomatorBounds,
    parseUiAutomatorDump,
    parseUiAutomatorTree,
    parseUiAutomatorXml,
    rectFullyOutside,
    rectsEqual,
    LAYOUT_CONTAINERS,
    NOISY_CLASSES,
    SCROLL_CLASSES,
    SYSTEM_PACKAGES,
    WEBVIEW_CLASSES,
};
