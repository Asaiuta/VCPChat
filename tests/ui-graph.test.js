'use strict';

/**
 * UI 控件语义图（ui-graph）契约测试。
 *
 * 每条 test 对应一条对模型可见的行为契约。用合成 fixture 而不是真机 dump：
 * 真机 dump 96KB 且随 App 版本漂移，断言会变成维护负担。
 */

const assert = require('assert/strict');
const test = require('node:test');

const graph = require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph');

// 微信首页式：状态栏 + 可滚动会话列表（双层同 bounds 包装 + 头像图标）+ 底部 tab 栏
const CHAT_LIST_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.tencent.mm" bounds="[0,0][1440,3168]">
    <node index="0" class="android.view.View" resource-id="android:id/statusBarBackground" package="android" bounds="[0,0][1440,80]" />
    <node index="1" class="android.widget.ListView" resource-id="com.tencent.mm:id/j8g" package="com.tencent.mm" scrollable="true" bounds="[0,160][1440,2880]">
      <node index="0" class="android.widget.LinearLayout" resource-id="com.tencent.mm:id/cj1" package="com.tencent.mm" clickable="true" long-clickable="true" bounds="[0,160][1440,348]">
        <node index="0" class="android.widget.LinearLayout" resource-id="com.tencent.mm:id/cj0" package="com.tencent.mm" focusable="true" bounds="[0,160][1440,348]">
          <node index="0" class="android.widget.ImageView" resource-id="com.tencent.mm:id/a_4" package="com.tencent.mm" bounds="[32,180][200,328]" />
          <node index="1" class="android.widget.TextView" resource-id="com.tencent.mm:id/kbq" text="微信支付" package="com.tencent.mm" bounds="[240,196][640,280]" />
          <node index="2" class="android.widget.TextView" resource-id="com.tencent.mm:id/otg" text="11:41" package="com.tencent.mm" bounds="[1260,196][1400,270]" />
        </node>
      </node>
      <node index="1" class="android.widget.LinearLayout" resource-id="com.tencent.mm:id/cj1" package="com.tencent.mm" clickable="true" long-clickable="true" bounds="[0,348][1440,536]">
        <node index="0" class="android.widget.LinearLayout" resource-id="com.tencent.mm:id/cj0" package="com.tencent.mm" focusable="true" bounds="[0,348][1440,536]">
          <node index="0" class="android.widget.ImageView" resource-id="com.tencent.mm:id/a_4" package="com.tencent.mm" bounds="[32,368][200,516]" />
          <node index="1" class="android.widget.TextView" resource-id="com.tencent.mm:id/kbq" text="微信支付" package="com.tencent.mm" bounds="[240,384][640,468]" />
          <node index="2" class="android.widget.TextView" resource-id="com.tencent.mm:id/otg" text="11:41" package="com.tencent.mm" bounds="[1260,384][1400,458]" />
        </node>
      </node>
    </node>
    <node index="2" class="android.widget.RelativeLayout" resource-id="com.tencent.mm:id/nvt" package="com.tencent.mm" clickable="true" long-clickable="true" bounds="[0,2880][360,3168]">
      <node index="0" class="android.widget.ImageView" resource-id="com.tencent.mm:id/h6y" package="com.tencent.mm" bounds="[120,2900][240,3020]" />
      <node index="1" class="android.widget.TextView" resource-id="com.tencent.mm:id/icon_tv" text="微信" package="com.tencent.mm" bounds="[100,3030][260,3090]" />
    </node>
    <node index="3" class="android.widget.RelativeLayout" resource-id="com.tencent.mm:id/nvt" package="com.tencent.mm" clickable="true" long-clickable="true" bounds="[360,2880][720,3168]">
      <node index="0" class="android.widget.ImageView" resource-id="com.tencent.mm:id/h6y" package="com.tencent.mm" bounds="[480,2900][600,3020]" />
      <node index="1" class="android.widget.TextView" resource-id="com.tencent.mm:id/icon_tv" text="通讯录" package="com.tencent.mm" bounds="[460,3030][620,3090]" />
    </node>
  </node>
</hierarchy>
`;

test('ui-graph: 可点击祖先吸收后代文本，形成单个语义控件', () => {
    const result = graph.parseUiGraph(CHAT_LIST_XML);

    // 列表容器 + 两个会话 + 两个 tab
    assert.equal(result.controls.length, 5);

    const list = result.controls[0];
    // 角色名取自 port 的 DescribeNode 契约（ScrollView / StaticText / Button …），
    // 呈现层只做小写化，不另起一套词表。
    assert.equal(list.role, 'scrollview');
    assert.ok(list.flags.includes('scroll'));

    const first = result.controls[1];
    assert.equal(first.label, '微信支付 / 11:41', '标题与时间必须折叠进同一条控件');
    assert.ok(first.flags.includes('click') && first.flags.includes('long'));
    assert.equal(first.cls, 'LinearLayout');
});

test('ui-graph: 同 bounds 的多层包装合并，保留外层点击源 id', () => {
    const result = graph.parseUiGraph(CHAT_LIST_XML);
    const first = result.controls[1];

    // 真机形态：cj1 可点、cj0 只是同 bounds 的布局壳（focusable 但不可点）。
    // 壳必须被压平，否则同一个会话会出两条，而不可点的那条还没有文字。
    assert.equal(first.id, 'com.tencent.mm:id/cj1');
    assert.equal(first.bounds.left, 0);
    assert.equal(first.bounds.right, 1440);
    assert.equal(result.controls.filter((c) => c.cls === 'LinearLayout').length, 2);
    assert.ok(!result.controls.some((c) => c.id === 'com.tencent.mm:id/cj0'), '同 bounds 的布局壳不得重复成条');
});

test('ui-graph: 点击落点取文本区域中心，不取容器中心', () => {
    const result = graph.parseUiGraph(CHAT_LIST_XML);
    const first = result.controls[1];

    // 文本并集 [240,196][1400,280] 的中心；容器中心是不带信息的 (720,254)
    assert.equal(first.x, 820);
    assert.equal(first.y, 238);
    assert.notEqual(first.y, Math.round((first.bounds.top + first.bounds.bottom) / 2));
});

test('ui-graph: 状态栏、系统包、无描述图标一律剔除', () => {
    const result = graph.parseUiGraph(CHAT_LIST_XML);

    assert.ok(!result.controls.some((c) => /statusBarBackground|navigationBarBackground/.test(c.id)));
    assert.ok(!result.controls.some((c) => c.package === 'com.android.systemui'));
    // 三张无 content-desc 的 ImageView 不应产生控件
    assert.ok(!result.controls.some((c) => c.cls === 'ImageView'));

    // 输入法键帽是典型的「有文本且可点击」的系统噪声
    const withKeyboard = CHAT_LIST_XML.replace('</hierarchy>', `
    <node class="android.widget.Button" resource-id="com.android.inputmethod.latin:id/key_q" text="q" package="com.android.inputmethod.latin" clickable="true" bounds="[0,2400][140,2500]" />
  </hierarchy>`);
    const filtered = graph.parseUiGraph(withKeyboard);
    assert.ok(!filtered.controls.some((c) => c.label === 'q'), '输入法键帽默认不应进表');
    assert.ok(filtered.stats.droppedSystem >= 1);

    const withSystem = graph.parseUiGraph(withKeyboard, { includeSystem: true });
    assert.ok(withSystem.controls.some((c) => c.label === 'q'));
});

test('ui-graph: 内层独立可点击按钮不被外层卡片吞掉', () => {
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1000,2000]">
      <node class="android.widget.FrameLayout" resource-id="com.demo:id/card" package="com.demo" clickable="true" bounds="[0,0][1000,400]">
        <node class="android.widget.TextView" text="消息标题" package="com.demo" bounds="[20,20][800,80]" />
        <node class="android.widget.Button" resource-id="com.demo:id/del" text="删除" package="com.demo" clickable="true" bounds="[860,300][980,380]" />
      </node>
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    assert.equal(controls.length, 2);
    assert.equal(controls[0].label, '消息标题');
    assert.equal(controls[0].id, 'com.demo:id/card');
    assert.equal(controls[1].label, '删除', '内层可点按钮必须单独成条');
    assert.equal(controls[1].id, 'com.demo:id/del');
});

test('ui-graph: 文本错位到容器外时落点被夹回容器内', () => {
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.Button" resource-id="com.demo:id/b" clickable="true" text="错位按钮" package="com.demo" bounds="[0,500][400,700]" />
      <node class="android.widget.TextView" text="游离文本" package="com.demo" bounds="[600,900][700,960]" />
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    const button = controls.find((c) => c.label === '错位按钮');
    assert.ok(button.x >= 0 && button.x <= 400, `落点 x=${button.x} 必须在控件 bounds 内`);
    assert.ok(button.y >= 500 && button.y <= 700, `落点 y=${button.y} 必须在控件 bounds 内`);
});

test('ui-graph: 无标签无交互容器透传，子文本各自成条', () => {
    // 不做「兄弟文本聚合成信息块」：那是自造的启发式，成熟实现都不这么做。
    // 聚合会把本可单独寻址的两段文字塔成一条，反而丢失定位能力。
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.LinearLayout" resource-id="com.demo:id/meta" package="com.demo" bounds="[40,100][1000,300]">
        <node class="android.widget.TextView" text="作者" package="com.demo" bounds="[40,100][300,160]" />
        <node class="android.widget.TextView" text="2026-11-01" package="com.demo" bounds="[320,100][700,160]" />
      </node>
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    assert.deepEqual(controls.map((c) => c.label), ['作者', '2026-11-01']);
    assert.ok(controls.every((c) => c.role === 'statictext'));
    assert.ok(controls.every((c) => c.id === ''), '容器 id 不应泄到子节点上');
});

test('ui-graph: 重复文本各自成条且 selector 唯一', () => {
    const result = graph.parseUiGraph(CHAT_LIST_XML);
    const selects = result.controls.map((c) => c.selector);
    assert.equal(new Set(selects).size, selects.length, 'selector 必须全局唯一');

    const dup = result.controls.filter((c) => c.id === 'com.tencent.mm:id/cj1');
    assert.equal(dup.length, 2);
    assert.notEqual(dup[0].selector, dup[1].selector);
});

test('ui-graph: selector 可在下一帧重绑到新坐标', () => {
    const frameA = graph.parseUiGraph(CHAT_LIST_XML);
    const target = frameA.controls[2];
    assert.equal(target.id, 'com.tencent.mm:id/cj1');

    // 第二帧：列表下滚 200px，元素 id 不变、文本位置变化
    const frameB = graph.parseUiGraph(CHAT_LIST_XML
        .replace('[240,384][640,468]', '[240,184][640,268]')
        .replace('[1260,384][1400,458]', '[1260,184][1400,258]'));
    const rebind = graph.resolveSelector(frameB, target.selector);

    assert.ok(rebind, '同一 selector 必须能在新帧命中');
    assert.equal(rebind.id, target.id);
    assert.notEqual(rebind.y, target.y, '重绑后坐标应来自新帧');

    assert.equal(graph.resolveSelector(frameB, 'id=com.demo:id/不存在'), null);
});

test('ui-graph: 页面签名稳定且能区分不同页面', () => {
    const a = graph.parseUiGraph(CHAT_LIST_XML);
    const b = graph.parseUiGraph(CHAT_LIST_XML);
    assert.equal(a.signature, b.signature);
    assert.match(a.signature, /^[0-9a-f]{12}$/);

    const other = graph.parseUiGraph(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo.other" bounds="[0,0][1080,2400]">
      <node class="android.widget.TextView" text="完全不同的页面" package="com.demo.other" bounds="[10,10][500,80]" />
    </node></hierarchy>`);
    assert.notEqual(a.signature, other.signature);
    assert.equal(graph.samePage(a, other), false);
    assert.equal(graph.samePage(a, b), true);
});

test('ui-graph: limit 截断保留真实总数', () => {
    const { controls, total, truncated } = graph.parseUiGraph(CHAT_LIST_XML, { limit: 2 });
    assert.equal(controls.length, 2);
    assert.equal(total, 5);
    assert.equal(truncated, true);
});

test('ui-graph: 屏幕尺寸从根节点推断，可用参数覆盖', () => {
    const inferred = graph.parseUiGraph(CHAT_LIST_XML);
    assert.deepEqual(inferred.screen, { width: 1440, height: 3168 });

    const overridden = graph.parseUiGraph(CHAT_LIST_XML, { screen: { width: 720, height: 1584 } });
    assert.deepEqual(overridden.screen, { width: 720, height: 1584 });
});

test('ui-graph: 视口外的节点默认剔除，可显式保留', () => {
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.Button" text="屏内" package="com.demo" clickable="true" bounds="[0,0][200,100]" />
      <node class="android.widget.Button" text="屏外" package="com.demo" clickable="true" bounds="[0,2600][200,2700]" />
    </node></hierarchy>`;

    const clipped = graph.parseUiGraph(xml);
    assert.deepEqual(clipped.controls.map((c) => c.label), ['屏内']);

    const kept = graph.parseUiGraph(xml, { includeOffscreen: true });
    assert.deepEqual(kept.controls.map((c) => c.label), ['屏内', '屏外']);
    assert.equal(kept.controls[1].inViewport, false);
});

test('ui-graph: 渲染成折叠视图，字节数远小于扁平表', () => {
    const result = graph.parseUiGraph(CHAT_LIST_XML);
    const view = graph.renderView(result);

    assert.ok(view.includes('控件'), '表头应带控件计数');
    assert.ok(view.includes('[1] 微信支付 / 11:41'), '索引从 1 起、可被模型直接引用');
    assert.equal(view.includes('(820,238)'), false, 'coordinates are opt-in presentation detail');
    assert.ok(graph.renderView(result, { includeCoordinates: true }).includes('(820,238)'));
    const lines = view.split('\n');
    assert.ok(lines.some((line) => /^\s+\[2\]/.test(line)), '列表项应相对容器缩进');
    assert.ok(Buffer.byteLength(view) < 800, `折叠视图应紧凑，实际 ${Buffer.byteLength(view)} 字节`);
});

test('ui-graph: 异常输入不抛异常', () => {
    for (const input of ['', 'ERROR: could not get idle state.', '<hierarchy rotation="0" />', '<hierarchy rotation="0"><node class="a" bounds="[0,0][10,10]']) {
        const result = graph.parseUiGraph(input);
        assert.ok(Array.isArray(result.controls));
        assert.equal(result.signature.length, 12);
    }
    assert.equal(graph.renderView(graph.parseUiGraph('')), '(未识别到可交互控件)');
});

test('ui-graph: 禁用节点默认剔除', () => {
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.Button" text="可用" package="com.demo" clickable="true" bounds="[0,0][200,100]" />
      <node class="android.widget.Button" text="禁用" package="com.demo" clickable="true" enabled="false" bounds="[0,200][200,300]" />
    </node></hierarchy>`;

    assert.deepEqual(graph.parseUiGraph(xml).controls.map((c) => c.label), ['可用']);
    assert.deepEqual(
        graph.parseUiGraph(xml, { includeDisabled: true }).controls.map((c) => c.label),
        ['可用', '禁用'],
    );
});

test('ui-graph: 缩进按真实树中的 list 归属，不按几何包含', () => {
    // 工具栏控件在 y=264，列表从 y=400 开始；但 RecyclerView 的 bounds 覆盖了整页，
    // 几何包含会把工具栏错判成列表项。层级必须看真实祖先链。
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1440,3168]">
      <node class="android.widget.RelativeLayout" resource-id="com.android.settings:id/coui_toolbar" package="com.android.settings" bounds="[0,0][1440,400]">
        <node class="android.widget.ImageView" resource-id="com.android.settings:id/back" package="com.android.settings" clickable="true" content-desc="返回" bounds="[40,200][160,320]" />
        <node class="android.widget.TextView" resource-id="com.android.settings:id/title" text="无线调试" package="com.android.settings" bounds="[600,200][1000,320]" />
      </node>
      <node class="androidx.recyclerview.widget.RecyclerView" resource-id="com.android.settings:id/recycler_view" package="com.android.settings" scrollable="true" bounds="[0,0][1440,3168]">
        <node class="android.widget.LinearLayout" package="com.android.settings" clickable="true" bounds="[0,400][1440,700]">
          <node class="android.widget.TextView" text="设备名称" package="com.android.settings" bounds="[80,450][600,530]" />
        </node>
      </node>
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    const back = controls.find((c) => c.label === '返回');
    const title = controls.find((c) => c.label === '无线调试');
    const row = controls.find((c) => c.label === '设备名称');

    assert.equal(back.level, 0, '工具栏控件不在列表里，不应缩进');
    assert.equal(title?.level ?? 0, 0);
    assert.equal(row.level, 1, '真正在 RecyclerView 里的条目才缩进');
});

test('ui-graph: 开关行保留两个目标，状态挂在开关上', () => {
    // port 的行为：整行可点（带标签）+ 右侧 Switch（带 checkable 无标签）两条都留。
    // 取舍说明：曾经尝试把状态上挂到行上只留一条，但那等于替模型决定
    // 「点整行 == 拨开关」—— 有些设置页两者行为不同（行是进入子页）。
    // 保留两条并让状态紧邻行，信息不丢，也不替上层做主。
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.android.settings" bounds="[0,0][1440,3168]">
      <node class="android.widget.LinearLayout" resource-id="com.android.settings:id/pref_row" package="com.android.settings" clickable="true" bounds="[0,400][1440,700]">
        <node class="android.widget.TextView" text="无线调试" package="com.android.settings" bounds="[80,450][600,530]" />
        <node class="android.widget.Switch" resource-id="com.android.settings:id/switch_widget" package="com.android.settings" checkable="true" checked="true" bounds="[1200,450][1380,630]" />
      </node>
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    assert.equal(controls.length, 2, '行与开关各自成条');
    assert.equal(controls[0].label, '无线调试');
    assert.ok(controls[0].flags.includes('click'));
    assert.equal(controls[1].role, 'switch');
    assert.ok(controls[1].flags.includes('checked'), '开关状态必须在表里可见');

    // 但祖先不可点时，checkable 子控件必须自己保留
    const orphan = graph.parseUiGraph(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.LinearLayout" package="com.demo" bounds="[0,400][1080,700]">
        <node class="android.widget.TextView" text="通知" package="com.demo" bounds="[40,450][400,530]" />
        <node class="android.widget.Switch" resource-id="com.demo:id/sw" package="com.demo" checkable="true" checked="false" bounds="[900,450][1060,630]" />
      </node>
    </node></hierarchy>`);
    assert.ok(orphan.controls.some((c) => c.id === 'com.demo:id/sw'), '不可点行里的开关必须保留');
});

test('ui-graph: 占位 desc 不作为标签，但可点控件不因此消失', () => {
    // 实测：Pinterest 桌面小组件的 ImageView 带 text="Image" content-desc="Image"。
    // 这串字对模型零信息量，必须剥掉；但控件本身可点，丢掉等于剥夺操作能力。
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.pinterest" bounds="[0,0][1440,3168]">
      <node class="android.widget.Button" resource-id="com.pinterest:id/widget_image" class="android.widget.ImageView" package="com.pinterest" text="Image" content-desc="Image" clickable="true" bounds="[758,302][1338,882]" />
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    assert.equal(controls.length, 1, '可点控件不能凭空消失');
    assert.equal(controls[0].label, '', '但 "Image" 这种占位文本不能当标签');
    assert.equal(controls[0].text, 'Image', 'raw source survives placeholder display filtering');
    assert.equal(controls[0].desc, 'Image');
    assert.match(graph.renderView(graph.parseUiGraph(xml)), /\(无标签\)/, '渲染时明说是无标签，而不是编一个名字');

    // 纯装饰（不可点、无有效描述）仍应剔除
    const decor = graph.parseUiGraph(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.ImageView" class="android.widget.ImageView" package="com.demo" content-desc="icon" bounds="[40,40][80,80]" />
    </node></hierarchy>`);
    assert.equal(decor.controls.length, 0);

    // 真正的语义 desc 必须保住：返回按钮就是 ImageView + content-desc
    const back = graph.parseUiGraph(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.ImageView" resource-id="com.demo:id/back" class="android.widget.ImageView" package="com.demo" content-desc="返回" clickable="true" bounds="[40,200][160,320]" />
    </node></hierarchy>`);
    assert.equal(back.controls.length, 1);
    assert.equal(back.controls[0].label, '返回');
});

test('ui-graph: XML 原语（转义、剥尾巴、bounds 校验）', () => {
    assert.equal(graph.decodeEntities('登录 &amp; 注册'), '登录 & 注册');
    assert.equal(graph.decodeEntities('&#x4E2D;&#25991;'), '中文');
    assert.equal(graph.decodeEntities('&unknown;'), '&unknown;', '未知实体原样保留');

    const hierarchy = graph.extractHierarchy(`${CHAT_LIST_XML}\nUI hierchary dumped to: /data/local/tmp/vcp_ui_dump.xml`);
    assert.ok(hierarchy.startsWith('<hierarchy'));
    assert.ok(hierarchy.endsWith('</hierarchy>'));
    assert.ok(!hierarchy.includes('dumped to'));

    assert.deepEqual(graph.parseBounds('[0,0][100,200]'), { left: 0, top: 0, right: 100, bottom: 200 });
    assert.equal(graph.parseBounds(''), null);
    assert.equal(graph.parseBounds('garbage'), null);
    assert.equal(graph.parseBounds('[100,200][0,0]'), null, '倒置矩形无效');
});

test('ui-graph: 密码字段一律脱敏，明文不得进表', () => {
    // 登录页密码框：text 里是用户刚输入的明文。若照常输出，
    // 整个感知层就成了密码外泄通道。
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.EditText" resource-id="com.demo:id/pwd" package="com.demo" password="true" text="hunter2" content-desc="密码" clickable="true" focusable="true" bounds="[0,200][600,300]" />
      <node class="android.widget.LinearLayout" package="com.demo" clickable="true" bounds="[0,400][600,500]">
        <node class="android.widget.EditText" resource-id="com.demo:id/pwd2" package="com.demo" password="true" text="secret" focusable="true" bounds="[0,400][600,500]" />
      </node>
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    const rendered = graph.renderView(graph.parseUiGraph(xml));
    assert.ok(!rendered.includes('hunter2'), '渲染结果不得包含密码明文');
    assert.ok(!rendered.includes('secret'), '借后代标签时也不得带出密码明文');
    assert.ok(controls.every((c) => !c.value), '密码框不得暴露 value');
    assert.ok(controls.some((c) => c.flags.includes('password')));
    assert.ok(rendered.includes(graph.PASSWORD_LABEL));
});

test('ui-graph: 像素画布（SurfaceView/FlutterView）被识别并降级提示', () => {
    // 自绘引擎的硬边界：SurfaceView / TextureView / FlutterView 里画的是像素，
    // uiautomator 拿到的只是一个空壳节点。不告诉模型这一点，它就会去点空壳。
    const frame = (inner) => `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.game" bounds="[0,0][1080,1920]">${inner}</node></hierarchy>`;

    // 纯画布：只有一个按钮，其余全是像素
    const pure = graph.parseUiGraph(frame(
        '<node class="android.view.SurfaceView" resource-id="com.game:id/surface" bounds="[0,0][1080,1920]" />'
        + '<node class="android.widget.Button" text="开始" bounds="[400,800][680,900]" clickable="true" />',
    ));
    assert.equal(pure.canvas.present, true);
    assert.deepEqual(pure.canvas.kinds, ['SurfaceView']);
    assert.equal(pure.canvas.coverage, 1);
    assert.equal(pure.canvas.dominant, true, '占大头且可读控件少 → dominant');
    const pureView = graph.renderView(pure);
    assert.ok(pureView.includes('像素'), '必须明确告知内容是像素');
    assert.ok(pureView.includes('screenshot'), '必须给出可执行的下一步');

    // 混合：地图 App —— 地图本身不可读，但搜索栏等功能入口还在
    const mixed = graph.parseUiGraph(frame(
        '<node class="android.view.SurfaceView" bounds="[0,0][1080,1920]" />'
        + ['搜索', '公交', '打车', '骑行'].map((t, i) =>
            `<node class="android.widget.Button" text="${t}" clickable="true" bounds="[0,${i * 100}][300,${i * 100 + 80}]" />`).join(''),
    ));
    assert.equal(mixed.canvas.mixed, true, '占大头但控件可读 → mixed，不当作纯画布');
    assert.equal(mixed.canvas.dominant, false);
    assert.ok(graph.renderView(mixed).includes('不在控件树里'));

    // Flutter 也是画布：需系统无障碍服务开启才会填充语义树
    const flutter = graph.parseUiGraph(frame(
        '<node class="io.flutter.embedding.android.FlutterView" bounds="[0,0][1080,1920]" />',
    ));
    assert.equal(flutter.canvas.present, true);
    assert.deepEqual(flutter.canvas.kinds, ['FlutterView']);

    // 原生页面不得误报：微信会话列表没有画布
    const native = graph.parseUiGraph(frame(
        '<node class="android.widget.ListView" scrollable="true" bounds="[0,0][1080,1800]">'
        + '<node class="android.widget.LinearLayout" clickable="true" bounds="[0,0][1080,200]">'
        + '<node class="android.widget.TextView" text="会话甲" bounds="[20,20][400,80]" /></node></node>',
    ));
    assert.equal(native.canvas.present, false, '普通原生页面不得被判为画布');
    assert.ok(!graph.renderView(native).includes('像素'));

    // 全屏无标签 ImageView 不算画布（背景层 / 开屏图常长这样，误报会稀释提示价值）
    const bg = graph.parseUiGraph(frame(
        '<node class="android.widget.ImageView" bounds="[0,0][1080,1920]" />'
        + '<node class="android.widget.Button" text="重试" clickable="true" bounds="[400,800][680,900]" />',
    ));
    assert.equal(bg.canvas.present, false);
});

test('ui-graph: 单引号属性值要解析，且不污染后续属性', () => {
    // uiautomator 在文本自身包含双引号时会改用单引号包裹。
    // 真机微信消息正文就长这样：text='[3条] "解."通过扫描"小雪球…'
    // 旧实现只认双引号，且在无法识别时 continue 不推进游标，
    // 导致下一次循环从单引号值内部开始找 '=' —— 拼出一个脏键，
    // 把后面的 resource-id 一并吃掉。
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="p" bounds="[0,0][1080,1920]">
      <node class="android.view.View" text='[3条] "解."通过扫描"小雪球' resource-id="p:id/ht5" bounds="[10,10][500,60]" />
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].label, '[3条] "解."通过扫描"小雪球', '单引号内的文本必须完整保留');
    assert.equal(controls[0].id, 'p:id/ht5', '后续属性不得被吞掉');
    assert.equal(controls[0].shortId, ':id/ht5');
});

test('ui-graph: 属性值包含裸 > 时不截断标签', () => {
    // XML 只强制转义 < 和 &，`>` 在属性值里可以是裸的。
    // 用 [^>]*? 切标签会在 `text="a > b"` 处提前结束，整棵树错位。
    const xml = '<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">'
        + '<node class="android.widget.Button" text="价格 > 100" package="com.demo" clickable="true" bounds="[0,0][300,100]" />'
        + '<node class="android.widget.Button" text="后续按钮" package="com.demo" clickable="true" bounds="[0,200][300,300]" />'
        + '</node></hierarchy>';

    const { controls } = graph.parseUiGraph(xml);
    assert.deepEqual(controls.map((c) => c.label), ['价格 > 100', '后续按钮'], '裸 > 之后的节点必须仍可见');
});

test('ui-graph: 深层嵌套不爆栈', () => {
    // RN 页面能堆到 30 层以上，但真实脏数据里出现过更深的链。
    // 递归下降遇到几千层就 RangeError，感知层必须能活下来。
    const depth = 4000;
    const open = Array.from({ length: depth }, () => '<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">').join('');
    const close = '</node>'.repeat(depth);
    const xml = `<hierarchy rotation="0">${open}<node class="android.widget.Button" text="深层按钮" clickable="true" bounds="[0,0][300,100]" />${close}</hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    assert.deepEqual(controls.map((c) => c.label), ['深层按钮']);
});

test('ui-graph: 滚动容器不借用后代文本（否则整屏重复）', () => {
    // 真机故障：微信会话 ListView 带 long-clickable="true"（长按弹菜单），
    // 于是「无标签可点容器借后代文本」的规则把整屏会话标题全吸到列表自己名下。
    // 表首多出 700+ 字节纯重复，模型还会误以为那个长标签是可点目标。
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.ListView" resource-id="com.demo:id/list" scrollable="true" long-clickable="true" bounds="[0,0][1080,2000]">
        <node class="android.widget.LinearLayout" clickable="true" bounds="[0,0][1080,200]">
          <node class="android.widget.TextView" text="会话甲" bounds="[20,20][400,80]" />
        </node>
        <node class="android.widget.LinearLayout" clickable="true" bounds="[0,200][1080,400]">
          <node class="android.widget.TextView" text="会话乙" bounds="[20,220][400,280]" />
        </node>
      </node>
    </node></hierarchy>`;

    const { controls } = graph.parseUiGraph(xml);
    assert.equal(controls[0].role, 'scrollview');
    assert.equal(controls[0].label, '', '滚动容器不得把整屏文本借成自己的标签');
    assert.deepEqual(
        controls.slice(1).map((c) => c.label),
        ['会话甲', '会话乙'],
        '会话标题必须留在各自的会话行上',
    );

    // 反过来：不可滚动的可点容器仍应借用（「整行即点击目标」要继续生效）
    const card = graph.parseUiGraph(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="android.widget.LinearLayout" resource-id="com.demo:id/row" clickable="true" bounds="[0,0][1080,200]">
        <node class="android.widget.TextView" text="标题" bounds="[20,20][400,80]" />
        <node class="android.widget.TextView" text="副标题" bounds="[20,100][600,160]" />
      </node>
    </node></hierarchy>`);
    assert.equal(card.controls.length, 1);
    assert.equal(card.controls[0].label, '标题 / 副标题');
});

test('ui-graph: 滚动容器的视口外子项被裁掉并计数', () => {
    // 列表把滚出视口的项也留在树里。不裁就会把整屏之外的几十条
    // 一起发给模型，而它们根本不可点。
    const xml = `<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][1080,2400]">
      <node class="androidx.recyclerview.widget.RecyclerView" resource-id="com.demo:id/list" scrollable="true" bounds="[0,400][1080,1000]">
        <node class="android.widget.LinearLayout" clickable="true" bounds="[0,400][1080,600]">
          <node class="android.widget.TextView" text="可见项" bounds="[20,420][400,500]" />
        </node>
        <node class="android.widget.LinearLayout" clickable="true" bounds="[0,1400][1080,1600]">
          <node class="android.widget.TextView" text="滚出项" bounds="[20,1420][400,1500]" />
        </node>
      </node>
    </node></hierarchy>`;

    const result = graph.parseUiGraph(xml);
    assert.equal(result.controls[0].role, 'scrollview');
    assert.ok(!result.controls.some((c) => c.label.includes('滚出项')), '滚出视口的文本不得进表');
    assert.ok(result.controls.some((c) => c.label === '可见项'));
    assert.equal(result.stats.hiddenInScroll, 1, '被裁条数要可观测');

    // 行即使处于屏幕 bounds 内，落在滚动视口之外也不是可见点击目标。
    // 整行应被裁掉，而不是只裁其文本后留下可点空壳。
    assert.equal(result.controls.length, 2);
    assert.deepEqual(result.controls.map((c) => c.label), ['', '可见项']);
});


