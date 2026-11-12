# AndroidController：M3 前成熟实现对照审查

日期：2026-11-03 初审，2026-11-05 收口复核。范围M0/M1/M1.5/M2，不实施M3 OCR/模板、不引入完整Appium/Portal。比较对象：uiautomator2、Appium UiAutomator2、Maestro、scrcpy；Portal仅用于部署权限取舍。官方源码/文档由搜索定位后抓取核实；master/latest为查阅时滚动版本，不等于随包APK。外部能力存在不证明本设备/本包支持。

## 判断

现有Drag/Pinch/DoubleTap/键盘/滚动/历史已实现，M1.5历史14/14是原快照的证据。严格分源、统一新鲜上下文/epoch、完整布局stable、分层摘要、读写策略、预算呈现、stale附屏与只读多root诊断现已集成，完整离线1885/1885。2026-11-05本机M2新矩阵14/14，owner绑定/隔离恢复/独立消失检查通过；M1.5新完整回归13/14，唯一失败为主机滚动正面积可见与靶场32dp标准不一致，当时保留失败（同日晚间已由 `scroll-axis-interior` 收口并通过 14/14，不再保留，见下文收口节与[状态表](README.md)）。详情见[本轮报告](2026-11-05_audit-android-pre-m3-report.md)。不把当前M2通过改写成历史动态idle根因已确定，不外推跨ROM或全部前置完成。

证据分层：A=本轮真机效果；B=本地生产路径离线复现；C=静态代码链与外部源码核对；D=产品能力差距/尚未故障注入的风险。优先级P1为错误效果/错误证据或在途生命周期，P2为可用性/覆盖/工程化差距。各条不表示跨ROM已复现。

## P1：先修正确性，再扩语汇

### 1. 隐藏/禁用/长标签的断言证据（B，本轮修复）

离线生产harness复现：`visible-to-user=false`且屏内bounds的Button被`expect visible`标verified；`enabled=false`节点在呈现时被丢弃，`expect absent`标verified；123字标签尾部`ZZZ`被120字呈现裁剪丢失，`contains=ZZZ`得到完整空集。前两项混淆displayed、enabled与exists，第三项把显示限长混入匹配语义，均非有意授权收窄。

实际修复：公开可动作表仍剔除disabled/hidden；保留非枚举完整断言集合与完整匹配label，呈现label继续限长。`evaluateSelector(graph,query,{includeDisabled:true})`专供断言；隐节点不视为可见但继续遍历孩子，避免盲砍Compose invisible-parent/visible-child。密码仍脱敏，正则仍有文本/总工作预算；没有扩动作权限。隐子节点被clickable父借成label的残余也先红复现后修：私有输入副本清空显式hidden自身语义、保留children/raw祖先，全文恢复读净化副本；不把hidden文案回灌到父、scope或私有匹配。

本地：[UI图](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph.js)、[选择器](../../VCPDistributedServer/Plugin/AndroidController/lib/selector.js)、[专项回归](../../tests/android-m2-evidence-contract.test.js)。外部：[Appium allowInvisibleElements/alwaysTraversableViewClasses](https://appium.github.io/appium-uiautomator2-driver/latest/reference/settings/)、[Maestro状态选择器](https://docs.maestro.dev/reference/selectors/state-selectors.md)、[u2 text/description与enabled字段](https://raw.githubusercontent.com/openatx/uiautomator2/master/uiautomator2/_selector.py)。本批已严格分源：text/contains/regex只原始text，desc只content-desc，any只完整聚合label；公开呈现预算不裁内部证据，不保留旧text聚合含义兼容层。

### 2. bounded采样拒绝真实carrier XML声明（A+B，本轮修复）

M2首轮固定靶场14项全部执行，5通过9失败：普通定位可用，sequence expect/元素图/idle出现`UI_ACQUISITION_FAILED`。同根：普通dump经extractHierarchy移掉XML声明，有界分支直接validateHierarchy；随包返回合法`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>`却被当无效标签。新增carrier形状生产harness先红2条再绿；仅规范化位于文首的合法XML声明，保留根/属性/实体/尾部完整性严格检查，不用截出一段掩盖破损XML。

本地：[Service validateHierarchy](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)、[carrier回归](../../tests/android-m2-carrier-xml.test.js)。不是设备/ROM限制，亦不是改测试期望追绿。第二轮12/14，host CLI又暴露精确`UI hierchary dumped to: /dev/tty`尾行；受gate约束实收元信息确认declaration=true/completeRoot=true/精确尾行=true/32字符。仅剥白名单文末carrier notice后严格验证，错误拼写/路径/DTD/垃圾/重复attr/坏entity/多root等仍拒。carrier专项25/25；完整隔离回归先1411/1411，随后补安全切出传输cleanup测试后最终1412/1412，0失败/跳过，14.779s。第二轮动态idle已正确unknown/IDLE_TIMEOUT，但独立运动存活断言红，未洗成通过，另查测试时序。

### 3. 统一新鲜上下文/epoch已落代码，设备准入未新增（B+C）

历史frame只看尺寸的漏洞已先被fresh前台/窗口/旋转/display0/逻辑尺寸/电源锁屏复核关闭。本批普通Observe/语义定位/索引/像素继续统一到新鲜上下文与epoch；上下文变化或证据丢失撤销旧snapshot/frame，未知OEM/多display不猜，不回退旧size/focus拼证据。实现与集成测试不等于横屏、多ROM或设备效果准入，也不提供检查到派发间的原子性。

本地：[Service requireFrame/prepareTargets/captureVisionShot](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)、[ADB probeScreen/screenSize/parseScreenSize](../../VCPDistributedServer/Plugin/AndroidController/lib/adb.js)、[视觉映射](../../VCPDistributedServer/Plugin/AndroidController/lib/vision.js)。外部：[u2 window_size横屏返回说明](https://raw.githubusercontent.com/openatx/uiautomator2/master/README.md)、[scrcpy旋转/折叠session新尺寸](https://raw.githubusercontent.com/Genymobile/scrcpy/v4.1/doc/develop.md)、[Appium display/window上下文](https://raw.githubusercontent.com/appium/appium-uiautomator2-driver/master/docs/guides/multiwindow.md)。

代码锚点为 [context](../../VCPDistributedServer/Plugin/AndroidController/lib/context.js) 与 [context生产集成测试](../../tests/android-m3-context-service.test.js)，包含同尺寸切组件/窗口、180°、display变化、未知unlock及恢复后旧凭据仍失效。只swap宽高或停止缓存不构成同等修复；本批没有新portrait/横屏设备验收。

### 4. RPC未知隔离、启动文件与运行owner已接入（A+B+C）

会话/传输已拆分：载体启动在AdbTransport。withDeviceRpc覆盖普通写、普通dump、bounded读，已派发且缺排干证据即设备隔离、清snapshot/frame；同调用不补CLI/afterObserve，普通reconnect不清白。启动文件采用本地SHA-256内容路径、设备读回与每generation证据；缺失/不符push后再验，已知仍不符拒绝，hash不可读明确unknown。当前stop先由本会话nonce认证的同JVM owner自退出，再以独立ADB读取PID/startTime及owner/RPC监听消失证据，最后清本地adb/forward；不能凭ping或文件SHA替代。

初审的第二写仍可执行是历史复现；现有RPC isolation与真实loopback HTTP测试锁定普通写/读未知后拒绝后续同设备操作，旧RPC迟到错误不污染新世代能力结论。2026-11-05另修启动隔离误回退CLI和跨Service实例忽略tombstone；本机验证真实owner绑定、显式隔离状态注入、公开恢复及独立消失检查，未注入真实在途RPC网络故障。

本地：[UiServer](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js)、[Service rpcAction/boundedRead/dumpViaUiServer](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)、[step-runtime租约](../../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime.js)、[scrcpy scid精确清理](../../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub.js)。外部：[u2固定commit _setup_jar hash/stop/jsonrpc_call](https://raw.githubusercontent.com/openatx/uiautomator2/e53484d6898acb130bbd463aaae67f37d683f7ac/uiautomator2/core.py)、[scrcpy exact-version/ownership](https://raw.githubusercontent.com/Genymobile/scrcpy/v4.1/doc/develop.md)。

owner默认wrapper已编译且重建byte-identical，endpoint socket inode与远端PID/startTime/uid/cmdline/nonce绑定已通过本机验证；完整离线1885/1885包含owner集成与真实loopback测试。`Manage operation=recoverOwner`必须显式serial，仅本会话owner独立消失证明released才解除隔离并废弃旧凭据；缺记录或证据不足继续隔离，不接受force/approval，不重放动作。载体CLASSPATH直接加载，PM versionCode不是hash后备；startup_file与remote_owner分别记录。

### 5. 完整布局stable已统一，文案/像素稳定不在保证内（B，代码已落）

历史Observe stable:true只比较公开前缀曾被limit=1尾部节点变bounds复现假稳定。本批改为与Wait idle同类证据：两次完整可见raw布局、相隔200ms、新鲜前台/显示上下文与epoch；公开limit/truncated不缩小比较范围。请求stable后settled=false/unknown的快照不授权index输入，stable=false仅not-sampled，不等于禁止实时重定位动作。布局比较忽略纯动态text，不证明内容/像素静止、无遮挡或业务完成；M2动态idle旧真机红灯未由离线修改洗绿。

本地：[Service observe/graphLayout](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)、[UI图signature](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph.js)、[M2完整布局证据](../../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence.js)。外部：[Maestro ScreenshotUtils完整层级/像素静态采样](https://raw.githubusercontent.com/mobile-dev-inc/maestro/main/maestro-client/src/main/java/maestro/utils/ScreenshotUtils.kt)。本批已复用完整布局证据，并由 [context集成测试](../../tests/android-m3-context-service.test.js) 约束尾部变化、上下文变化与采样间隔；仍不以布局相同宣称整页业务idle。

## P2：能力质量和工程化

- **真正IME editor action缺口。** 当前ImeAction enter/search只是KEYCODE66/84，靶场证明key callback，不是InputConnection.performEditorAction。Appium委托settingsApp.performEditorAction，u2更丰富action需helper/IME。当前应明确key-event alias；真正action/hideKeyboard另建显式授权/恢复策略，不盲发Back或切IME。[本地键盘](../../VCPDistributedServer/Plugin/AndroidController/lib/keyboard-actions.js)；[Appium keyboard.ts](https://cdn.jsdelivr.net/npm/appium-android-driver@14.2.2/lib/commands/keyboard.ts)。
- **ScrollUntil停止质量。** 当前正面积相交即可visible，缺比例/居中/无进展；host固定60%/300ms，RPC不支持up/left/maxSwipes。建议先可见比例/可点击中心与无进展证据，保留预算/不点目标/写后不换策略。Maestro有visibilityPercentage/centerElement/speed，但文档也承认整屏swipe对sheet可miss；本地容器raw祖先+clip应保留。[本地滚动](../../VCPDistributedServer/Plugin/AndroidController/lib/scroll-until.js)；[Maestro命令](https://docs.maestro.dev/reference/commands-available/scrolluntilvisible.md)。
- **关系与身份策略。** 一层within正确但无child/sibling/has-descendant/唯一anchor-relative；nth仅位置，每步query rebind不等于同一业务实体。建议先类型化raw结构关系与显式identity-vs-query，不上任意XPath。Appium恢复缓存校验UUID，u2有child/sibling与几何相对定位，Maestro也明确相对位置不保证相邻。[本地selector](../../VCPDistributedServer/Plugin/AndroidController/lib/selector.js)；[Appium ElementsCache](https://raw.githubusercontent.com/appium/appium-uiautomator2-server/master/app/src/main/java/io/appium/uiautomator2/model/ElementsCache.java)；[Maestro关系](https://docs.maestro.dev/reference/selectors/relational-selectors)。
- **多窗口/显示器与物理身份。** 本批 `Observe windows=true` 仅额外rootInActive=false的多root XML只读诊断；display-id/bounds/rootCount有证据才返回，windowId/type/layer/null-root数量缺失保持null，occlusion=unknown、actionable=false，不等同完整AccessibilityWindowInfo列表，也不切换动作窗口或允许全窗口输入。普通动作仍单默认display0。USB/mDNS/IP物理别名互斥与稳定device-token仍未闭环，同endpoint重用也非会话身份；不能拿单一androidId当万能安全身份。[Appium多窗口](https://raw.githubusercontent.com/appium/appium-uiautomator2-driver/master/docs/guides/multiwindow.md)、[deviceInfo](https://appium.github.io/appium-uiautomator2-driver/latest/reference/execute-methods/#mobile-deviceinfo)。
- **像素稳定单独定义。** layout_stable忽略动态文案、不检测纯像素动画是已披露边界，不是OCR缺陷；未来ROI/阈值/连续窗口pixel_stable可独立补。Maestro waitForAnimationToEnd超时也succeeds，不能把它的命令成功当动画已结束。[Maestro说明](https://docs.maestro.dev/reference/commands-available/waitforanimationtoend.md)。
- **性能指纹与长稳。** 本批 [code-identity](../../VCPDistributedServer/Plugin/AndroidController/lib/code-identity.js) 已按生产JS/vendor/manifest当前字节计算代码身份，缺失/不可读/读时变化不完整，无Git遍历、命令或陈旧缓存；Node/OS/ROM/config/workload另分层，能力另绑定carrier/session/device evidence，不凭代码hash授权。旧性能runner/基线迁移、ROM维度补全及soak未因此自动完成，仍可能incomplete。真实RPC Observe p50=400ms/p95=466ms/n60，非旧2.3s；没有同条件外部benchmark不能说快慢领先。半开socket/编码器卡死须独立probe故障注入，不能把静屏无帧误判故障。[baseline实现](../../VCPDistributedServer/Plugin/AndroidController/lib/perf-baseline.js)、[性能记录](android-performance-baseline.md)。

## 应保留的设计与不算欠账的边界

完整匹配/歧义拒绝、安全受限regex、raw祖先、不把dispatched洗verified、未知写不重放、预算/取消/本地排干、白名单脱敏历史、非密码Fill读回和独立靶场效果断言有明确agent安全价值。不要声称外部“都只有成功/异常、没历史”：Appium已有getActionHistory/scheduleAction；本地优势是收窄和回执语义。当前Fill已逐字读回，首尾空白不裁剪；历史trim归一化描述已过时。

系统旋转/定位/权限/通知/网络、个人通信、自主规划、云反连、文件等授权面收窄不是缺陷。scrcpy control=false是刻意；Portal的UI树/手势/截图需Accessibility，当前no-a11y local mode仍可运行部分非UI能力；overlay/IME各自授权，不能写无a11y全瘫。[Appium历史/调度](https://raw.githubusercontent.com/appium/appium-uiautomator2-driver/master/docs/reference/execute-methods.md)、[Portal部署](https://raw.githubusercontent.com/droidrun/mobilerun-portal/main/README.md)。

## 建议顺序

1. 本轮先关闭已复现的断言完整性与carrier XML采样阻断，并重新跑完整M2真机矩阵。
2. display/foreground、布局stable、owner与统一读写门已完成本轮离线集成及限定设备验证；后续补跨ROM、旋转/多display、真实传输故障与长稳，不能由固定靶场结果外推。
3. 主机ScrollUntil仅正面积可见与靶场32dp标准的差异现有实证，应先定义可见性契约和独立原始几何，再改算法；不能凭已裁剪XML bounds假装可计算完整面积比例。无可信逐次批准协议时needsConfirmation继续拒绝。性能迁移、真正IME、全窗口输入及B后端另行交付；结构关系已随 2026-11-05 批次真机通过（5/5，见状态表）；M3 OCR/模板暂缓。

详细本轮真机证据与局限见后续M2验收记录；本审查不把源码推导伪装成多ROM真机通过。

## 2026-11-05 当前实施与验收边界

严格分源、上下文/epoch、完整布局stable、纯policy/identity、生产读写gate、短控件风险预标记、textLength/detail预算、stale附屏与windows只读诊断均已落代码。INTERACTION_POLICY由manifest/config.env模板声明string默认'{}'；denyPackages拒读写、readOnlyPackages禁写，配置错误/包未知时fail closed；System原grant仍独立必需。默认仍拒敏感写，confirmEveryWrite亦拒，不能由模型confirmed/approval批准。风险启发式只扫短标签/ID，不把长聊天全文当控件。

当前完整离线1925/1925（含新增读回诊断契约）；2026-11-05晚间本机矩阵M1.5 14/14（`DoubleTap`复跑4/4、`ScrollUntilHost`已过）、M2 14/14、结构/Collect 5/5、原生批准/交还 4/4，均exit0；owner实际绑定、恢复与独立清理验证通过。混合package树策略绕过、隔离启动回退、PJZ110 fresh解析均有先红后绿回归。M1.5主机滚动可见性的标准差异已由`scroll-axis-interior`收口，不再列入保留失败；历史动态idle误判无当轮几何，不能追认归因。详见[本轮验收](2026-11-05-device-acceptance.md)。M3 OCR/模板、B App后端、全窗口输入与可信批准协议均暂缓；单ROM固定靶场结果不外推，不标全部前置验收完成。

## 2026-11-04 历史首批实施边界

固定靶场 idle 诊断已补宿主单调采样/dump区间、完整布局/几何SHA、节点计数和有界纯几何；只经可信executionContext hook启用，不进公共schema/回执/history，不加设备请求、不改200ms/1500ms/总预算或原验收断言。宿主区间不是设备精确取样时刻；dumpFreshness=unproven，未收每sample独立Provider几何，仍不能最终区分周期重合与陈旧dump。M2第七轮13/14 NOT_PASSED不变。

最新外部源码复核与应吸收/暂缓/不吸收能力见[对标结论](android-controller-competitive-gap-2026-11.md#10-本次取舍吸收机制不复制权限面)，执行顺序见[路线图](android-controller-roadmap.md)。插件未发布，后续分源直接切新契约，不保留聚合text旧义兼容层。

本批最终完整隔离矩阵1740/1740通过（14.213s，0失败/取消/跳过），含两套CLI安全测试；生产JS与runner语法、限定差分空白检查通过。全回归曾暴露两个旧mock不再经真实能力记账路径，已让harness复用生产UiServer.invoke；设备AssertionError替身改为已派发/完整排干RPC错误证据，未改unknown禁重放或后续降级断言。

另补[A/B/C路线复核](android-controller-route-review-2026-11.md)：随包APK已具rootInActive=false的窗口枚举与内部事件监听，不是B独占；host默认true和缺窗口envelope是另层问题。普通App不能凭安装继承shell UiAutomation权限，B需设备端后端/认证/生命周期；不启动B、不切换multi-root，不把空壳确定归因为敏感策略。完整二进制SHA/偏移与官方边界见专项文档。
