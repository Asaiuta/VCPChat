# AndroidController：社区成熟实现对照与差距分析

**2026-11-05状态覆盖说明（2026-11-07 审计补注）：** 下文为2026-11-04的对标快照；其中“运行owner未绑定”“普通语义链未统一”“下一批分源/策略门”等旧状态已由[收口报告](2026-11-05_audit-android-pre-m3-report.md)更新。当前完整离线1885/1885（同日晚批已演进至1925/1925）、PJZ110 M2新矩阵14/14及owner生命周期验证通过；M1.5 13/14 的主机滚动可见性标准差异已由 `scroll-axis-interior` 收口并通过 14/14，不再列为保留失败。H4 的 Handoff 亦已落地（M4.0，真机 4/4）；§1 能力基线表「动作」行的 18 项，2026-11-06 起新增 Handoff/Collect 后为 20 项。外部研究记录与历史数字保持原样，不代表当前缺口清单。

日期：2026-11-04。范围 M0–M2 已实现面，不含 M3 OCR/模板与 M4 接管。下列版本号为历史调查记录，本次不重新实测所有软件；对照对象：scrcpy v5.0.1、appium-uiautomator2-driver 9.0.1 / server 10.7.10、openatx/uiautomator2 3.7.1、Maestro 2.12.1、Airtest 1.4.3（Poco 1.0.94，2024-01 后停更）、Mobile-Agent v3.5、droidrun Portal、mobile-mcp、AndroidWorld / AndroidLab。

证据分层沿用既有文档口径：**A**=本机真机效果，**B**=本地生产路径离线复现，**C**=静态代码链与外部源码核对，**D**=产品能力差距判断。外部能力存在不证明本设备/本 ROM 支持。

## 1. 本插件的能力基线（先立账，再对照）

| 层 | 现状 | 关键文件 |
| --- | --- | --- |
| 入口 | 四入口 `Describe / Observe / ExecuteStep / Manage`，旧命令无兼容转译 | `AndroidControllerService.js`、`plugin-manifest.json` |
| 动作 | 18 个（快照时点）：Wait/Tap/DoubleTap/Swipe/Scroll/ScrollUntil/Drag/Pinch/LongPress/InputText/Fill/ImeAction/EraseText/KeyCombo/KeyEvent/LaunchApp/KillApp/System | `lib/tool-catalog.js` |
| 感知 | `mode=ui` 语义表+snapshotId、`image` 截图+frameId、`arbitrate` 只读建议、`api` 只读 GitHub | `lib/ui-graph.js`、`lib/vision.js` |
| 寻址 | `id=/text=/contains=/regex=/class=/role=`、组合对象 AND、`nth`、一层 `within`；RE2 优先、线性语法兜底 | `lib/selector.js` |
| 凭据 | `index` 需同设备 snapshotId、像素需 frameId，15s TTL，执行前复核内容/布局/尺寸 | `Service.prepareTargets` |
| 回执 | `observed/dispatched/verified/unknown/failed` + `retryable`，unknown 不重放 | `lib/step-runtime.js` |
| 通道 | 设备端 RPC（u2-server-0.5.0）→ shell 明确未执行才回退；动作有签名表本地预校验 | `lib/rpc-methods.js`、`lib/ui-server.js` |
| 调度 | 单设备串行、跨设备并行、管理命令全局 FIFO 屏障、容量 64、排队消耗总预算 | `lib/adb.js`、`lib/adb-queue.js` |
| 显示 | scrcpy H.264（`control=false audio=false`）+ JPEG 回退；WebCodecs 解码；scid 精确清理 | `lib/scrcpy-hub.js`、`lib/stream-server.js`、`lib/viewer.html` |
| 授权 | 分设备分项授权 + `System` 白名单（读 / 四项绝对设置 / 设置页 / 四类草稿），无任意 shell/intent | `lib/system-api.js`、`modules/settings/schema/android-system.js` |

随包资产同一性（本轮实测）：`vendor/scrcpy-server-v5.0.1` 的 SHA-256 为 `764eb6f7…62e53bc536`，与 GitHub Release v5.0.1 资产 `scrcpy-server-v5.0.1` 的 `digest` 逐字符一致（**A**，资产级核对）。

## 2. 社区四条生态线的真实状态（2026-11）

### 2.1 测试自动化：引擎级只有两家

- **Appium UIA2**（driver 9.0.1 / server 10.7.10）是唯一「元素句柄 + 可调超时 + 多窗口」全给的一家。定位策略仅 5 种（id / accessibility id / class / `-android uiautomator` / xpath），其中 `-android uiautomator` 依赖的 `UiSelector` 已被 Google 标记废弃；xpath 是唯一非原生路径。
- **uiautomator2 3.7.1** 优势在客户端选择器表达力（child / sibling / child_by_text / 上下左右 / instance / position），但 **3.x 移除了 atx-agent**，改为运行时拉起设备端服务（9008）。

  **更正（2026-11-04）**：本节原先写「本插件『常驻 APK + `app_process`』在 u2 生态里属于上一代形态」，该判断不成立。3.x 的启动命令仍是 `CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main -p 9008`（[core.py](https://github.com/openatx/uiautomator2/blob/master/uiautomator2/core.py)），与本插件的 `…u2-server-0.5.0.apk` + `com.github.uiautomator2.Console` 只差 APK↔JAR 与类名两个 token——**u2 3.x 收敛到的正是本插件已在用的形态**。被删的 atx-agent 是常驻 HTTP 守护（装包 / 服务管理 / `device_info` / `connect_wifi`），本插件从未使用；[2to3](https://github.com/openatx/uiautomator2/blob/master/docs/2to3.md) 的移除项几乎全是 Python 客户端 API（`d.http` / `d.service()` / `app_icon` / `healthcheck`），与 RPC 协议无关。

  真实差异只剩两条，均属选档：产物转 `u2.jar` 而本插件留在不再被上游构建的 APK 分支（自有维护债）；本插件常驻以规避 2.3s 冷启，上游按需拉起以服务「跑一轮就退」的测试脚本。**「过时」若指 atx-agent / FastInputIME / minicap-minitouch，这三样本插件一个都没用。**
- **Maestro 2.12.1** 是 DSL 层：命令清单没有多点手势，能力被 YAML 命令表封顶；但它的 artifacts（每步截图 + commands.json）与 `scrollUntilVisible` 的 `visibilityPercentage / centerElement` 是产品化最好的。
- **Airtest/Poco** 已进入维护模式，Poco 对第三方 App 无效（需游戏内注入 SDK）。

### 2.2 GUI Agent：九成是「截图 + 坐标 + adb」

- **Mobile-Agent 全系（v1→v3.5）不读无障碍树**：截图 + OCR/Grounding 定位、ad 坐标点击；v2 自承 reflection 会死循环；v3.5 的 AndroidWorld 71.6 是纯视觉口径。
- **droidrun / Mobilerun Portal**：UI 树、手势和截图依赖 Accessibility；当前已有 explicit no-accessibility local mode，deep-link resolution、SMS、files 等非 UI 子集仍可工作，不是「无 a11y 即全瘫」。借其分能力权限矩阵和完整 state/context，不迁云反连、自动安装或短信权限面。[当前 README](https://raw.githubusercontent.com/droidrun/mobilerun-portal/main/README.md)。
- **mobile-mcp** 明确 a11y 优先、截图仅 fallback，工具集是扁平 RPC（无状态 diff、无步级验证）。
- 基准侧：AndroidWorld 每个任务手写 success checker（真 UI 树断言），AndroidLab 唯一有子目标口径（Sub-SR）但判定含 judge model 成分。

### 2.3 镜像与注入：能力上限在 UHID，不在 `input`

- **scrcpy v5.0.1（2026-10-08）**：控制协议 `INJECT_TOUCH_EVENT` 原生带 `pointer_id` 与 `pressure`；`INJECT_TEXT` 单条 ≤300B、帧 ≤256KB；三 socket 固定 video→audio→control；分辨率变化即重启编码会话、每会话 session packet 带 w/h；官方口径 30–120fps / 35–70ms。
- **注入保真度分档**（**C**）：`input tap/swipe/text` 最弱（无 duration、无多点、非 ASCII 丢字）→ `Instrumentation.sendPointerSync` / scrcpy `injectInputEvent`（中）→ `sendevent` / uinput / UHID（强，生成 deviceId≠0 的新输入设备，App 无法区分）。本插件走 RPC → instrumentation 派生，属中档，与 Appium 同级。
- **adb 硬边界**：`screenrecord` 180s 上限且仅 `video/avc`；`uiautomator dump` 基于无障碍树且等 idle（Appium 默认 `waitForIdleTimeout=10000ms` 是慢的根因）。

### 2.4 手机端同机闭环：DSH-Go（2026-11-04 补）

前三条线都把手机当被控端、把电脑当控制端。**DSH-Go**（[`ccch1mneyyy/dsh-Go`](https://github.com/ccch1mneyyy/dsh-Go)，AGPL-3.0，本次固定 commit `f75d4a19dd0846ae2764fa63758c7abdb25ab44d`）反过来：把 MCP server 放进 App 进程，让**手机里的**引擎当 MCP client 连自己。

- **形态**：Flutter 壳 + PRoot Ubuntu 内跑 `dsh web`；启动时往 rootfs 写 `relay.cjs`（stdio ⇄ socket 哑管道）和 `phone.patch.yml`（`--patch` overlay，往树根插 `@deepseek-ai/dsh-mcp-client`，`serverName: phone`），模型看到 `mcp__phone__*`。关开关或进安全模式时不传 overlay，DSH 根本不挂载，模型连工具名都看不见。
- **传输**：抽象 unix socket（proot 原样透传，文件 socket 路径会被重写且可能超 `sun_path`）+ `SO_PEERCRED` 查 uid + 每次启动随机 32 字节 token 常量时间比较；兜底才开 loopback TCP 并用 `/proc/net/tcp` 反查 uid（其自述更弱）。
- **两条屏幕通道**：主屏走 `AccessibilityService`（读树 + `performAction` / `dispatchGesture`）；后台屏（「不打扰模式」）跑在 **shell uid**（Shizuku UserService 或 adb 起 `app_process`），`createVirtualDisplay` 建虚拟屏、`ActivityOptions` 把目标 App 拉过去、`UiAutomation` 读控制树、`InputManager.injectInputEvent` 注入，短边 720。四个后端：Shizuku / Sui / Root / 自连 ADB。
- **13 个工具**：`apps` `open` `intent` `notify` `clipboard` `screen` `collect` `tap` `type` `scroll` `key` `tap_xy` `handoff`。寻址是**屏幕号 + 元素编号**（`s7` 主屏 / `b3` 后台屏，`[N]` 只在本屏有效，每次动作返回新屏），没有 CSS/XPath/组合定位。
- **安全在 Kotlin 里，不在提示词里**：包名单、逐次确认与 SensitiveWords 同源值得吸收，但不是绝对不可解除的硬规则。当前有用户 `PhoneUnlocks(systemPages,secretFields,ownApp)`，KEY 提前 Allow，SCROLL 在 deny 检查后、system-page 检查前 Allow；不能概括成系统页一律可读绝不动作。确认返回还复核 activeOwner，防迟到授权串任务；同源不代表词表完备。[固定 SafetyGate](https://raw.githubusercontent.com/ccch1mneyyy/dsh-Go/f75d4a19dd0846ae2764fa63758c7abdb25ab44d/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/SafetyGate.kt)。

它的无障碍/注入部分派生自 [`CikeSeven/phase`](https://github.com/CikeSeven/phase)（作者授权），`sdk/` 与 `examples/` 为 MIT。

## 3. 差距矩阵

图例：**性质**＝`正确性`（结果是错的或证据是假的）/`表达力`（能做的少）/`工程化`（能跑但不好维护）/`刻意`（设计取舍，不算欠账）。

| # | 维度 | 本插件 | 社区最强 | 性质 | 证据 |
| --- | --- | --- | --- | --- | --- |
| G1 | 元素身份 | 每步按语义 rebind；`index` 靠位置+15s 快照 | Appium：UUID=`windowId`+`sourceNodeId`，miss 时按 `By` 重定位 + 重算 UUID 二次校验，才抛 Stale | 正确性 | C |
| G2 | text / content-desc 分源 | 合并成一个 `label`（`content-desc \|\| text`），公开表 `desc` 恒为空串 | Appium/u2 分列 `text` 与 `contentDescription`/accessibility id | 正确性 | B（源码行） |
| G3 | 显示/窗口维度 | frame 已 fresh 复核前台/窗口/旋转/display0/逻辑尺寸；普通语义链仍未统一 epoch/缓存 | Appium display/window；scrcpy display-id | 正确性收口 | C |
| G4 | 载体身份 | 本批 SHA-256 内容路径、远端读回与 generation 文件证据已实现；运行 owner 未绑定 | scrcpy 协议版本校验；u2 文件 hash 比对 | 正确性收口 | B/C，未测设备 |
| G5 | stable 语义 | `Observe stable:true` 与 `Wait idle` 两套证据强度 | Maestro 层级 settle 与像素 static 为不同方法，部分超时仍成功 | 正确性 | B |
| G6 | 选择器关系 | 一层 `within`、`nth` 位置 | Maestro 关系选择器 + traits + state + 容差；u2 child/sibling/上下左右 | 表达力 | C |
| G7 | 多点手势 | 仅 `pinchIn/Out` 固定两指 | 设备端 `gesture(4点)` / `swipePoints` / `flingTo*`（随包 APK 已证存在）；scrcpy `pointer_id` | 表达力 | A（探针 §0.2） |
| G8 | IME 语义 | `ImeAction` 只是 `KEYCODE 66/84` | Appium `performEditorAction` / `hideKeyboard` / `isKeyboardShown`（人造 IME） | 表达力 | C |
| G9 | 等待原语 | 仅 `expect` 轮询 + bounded idle | 设备端 `waitForExists/waitUntilGone/waitForWindowUpdate` 全在，未接线 | 表达力 | A |
| G10 | 每步产物 | 文本回执 + 脱敏历史 | Maestro：每步截图 + `commands.json` + 失败层级快照 | 工程化 | C |
| G11 | 跨 App 泛化数字 | 单 ROM 单靶场 14 项 | AndroidWorld 116 任务 / 20 App | 工程化 | C |
| G12 | scrcpy 通道利用 | `control=false audio=false`，无虚拟显示 | `--new-display` 虚拟显示器、剪贴板同步、file drop、UHID | 工程化/刻意 | C |
| G13 | 能力指纹门禁 | 有参数形状表 + 只读探针，未自动化成闸门 | 无直接对等物（u2/Appium 靠版本号硬绑） | 工程化 | D |

## 4. P1：先修正确性

### G2 text/content-desc 合并（**B**，最小改动、收益最高）

`lib/ui-graph.js:363` 把 `content-desc` 优先于 `text` 合成一个 `label`；`flattenTree` 产出 `desc: ''` 恒空。后果：一个既有 `content-desc="提交"` 又有 `text="Save"` 的按钮，模型只能看到「提交」，`text=Save` 直接匹配不到；图标按钮与输入框无法分源。这不是「表达力少一点」，是**观察到的东西和真实控件不是一对一**。

修法：保留聚合 `label` 作为呈现，另加 `text` 与 `desc` 两个独立字段进入匹配集合，`text=`/`desc=` 各自只打各自来源；聚合匹配保留但必须在 selector 里显式写 `any=`。改动集中在 `flattenTree` 的 `flat.push` 与 `selector.js` 的匹配分支，不动树剪枝。

### G1 元素身份（**C**）

现状是 query rebind，不是持久元素身份。Appium 恢复 singleMatch 缓存时按 By 重找并复算 UUID，UUID 来自真实 sourceNodeId + windowId。当前 XML 不含该身份，结构路径/resource-id/bounds 哈希不能冒充等价句柄，也不能静默恢复到同位置另一条业务记录；继续保守 stale 拒绝，稳定句柄暂缓。[ElementsCache](https://raw.githubusercontent.com/appium/appium-uiautomator2-server/master/app/src/main/java/io/appium/uiautomator2/model/ElementsCache.java)、[UUID来源](https://raw.githubusercontent.com/appium/appium-uiautomator2-server/master/app/src/main/java/io/appium/uiautomator2/core/AxNodeInfoHelper.java)。

### G4 载体版本绑定（**B**，最短路径）

本批 [AdbTransport](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-transport.js) 删除旧固定远端路径/存在即复用规则：本地 SHA-256 生成内容路径，设备 hash 相等才标 verified；缺失/不符 push 一次并复核，仍不符拒绝。不可校验显式 unknown，不冒充已绑定；ADB 断连或 push 失败仍失败，不降格为 hash 不可用。generation 内复用，stop/restart 失效；能力失败缓存也随世代失效，旧 RPC 迟到错误不得污染新代。

证据限定 `scope=startup_file`，不是运行 owner 认证。后续须关联 endpoint + PID/starttime/uid/cmdline 或可信握手 nonce，精确终止并确认消失。载体由 CLASSPATH 加载而非安装，`dumpsys package versionCode` 不是同一性后备。上游 u2 会 hash 比对，但旧服务活着仍可能复用，HTTP 错误还可能 restart 后重发原方法；只学文件校验，不学自动重放。[u2 core](https://raw.githubusercontent.com/openatx/uiautomator2/master/uiautomator2/core.py)、[scrcpy版本检查](https://raw.githubusercontent.com/Genymobile/scrcpy/master/server/src/main/java/com/genymobile/scrcpy/Options.java)。

### G3 显示上下文（**C**，M3 前必须）

旧 frame 只看尺寸的漏洞已由当前 frameContext/requireFrame/captureVisionShot 补上：单默认 display0 要求 fresh package/component/window、rotation、logical size、Awake 与明确未锁；截图前后、像素派发前均复核，fresh probe 不走 wm size 缓存。剩余是普通 Observe/语义链的 displayContext/epoch 与缓存统一、多 display/ROM 准入，不得按旧漏洞重做。检查不具原子性，也不证明期间内容/布局不变。

### G5 stable 语义（**B**）

`Observe stable:true` 走两次直接 dump + `samePage/graphLayout`，没有 200ms 间隔、没有完整 raw 布局、没有前台复核；而 M2 的 `Wait idle` 已经是完整证据采样。两套同名不同强度的契约必须收敛到一套，否则模型学会「stable 可以信」之后会在错误的地方信。

## 5. P2：表达力与工程化

- **多点与路径（G7）**：设备端 `gesture` / `swipePoints` / `flingTo*` 已在随包 APK 上被探针证实存在（**A**），只是签名表没放行。补 `rpc-methods.js` 条目 + 动作分支即可，不动 scrcpy control。任意多指轨迹应另设显式授权，不进默认降级链。
- **IME（G8）**：`ImeAction` 现在是键码别名，不是 `InputConnection.performEditorAction`。真正做需要 helper 或人造 IME（Appium 用 `io.appium.settings`），并且要配恢复策略，不能盲发 Back。当前应先在文档与 tool-catalog 里明确「这是 key-event alias」。
- **等待原语（G9）**：`waitForExists` / `waitUntilGone` 接线成本低，收益是把「Observe+判断+再 Observe」的模型往返换成一次设备端有界轮询。
- **选择器关系（G6）**：先补类型化结构关系（`child` / `descendant` / `sibling` / `hasDescendant`），不做任意 XPath。XPath 在 Appium 侧是唯一非原生路径且明确更慢，不值得引。
- **每步产物（G10）**：`afterObserve` 已有；缺的是「失败时的证据包」——最后一个快照 + 动作参数白名单 + 前后布局差异，落盘成单文件，人可复现。
- **scrcpy 闲置能力（G12）**：`control=false` 是刻意（接管要先做状态机）。但 `--new-display` 值得单独评估：在虚拟显示器里跑 Agent 可以不打扰用户当前屏幕，这是「Agent 能不能在不占用手机的情况下工作」的产品级差异，且不触碰安全边界。剪贴板同步与 file drop 优先级低。
- **泛化数字（G11）**：现有 14 项是单 ROM 单 App 的效果矩阵，不是能力上限证明。要跨 App 说话，需要一套不依赖自研靶场的任务集；不一定照搬 AndroidWorld（它要 a11y forwarding app），但判定口径应对齐「真 UI 树断言 + 参数随机化」。

## 6. 不算欠账的四件事

1. **root / uinput / 系统签名**：一旦引入，全部兼容性判断失效，且 uinput 的「等价真实触摸」优势在 Agent 场景收益有限。
2. **`System` 白名单收窄**：Appium `mobile:` 全套系统动作是测试框架的定位，不是 Agent 的定位。
3. **`control=false`**：只读显示屏是当前定位，接管是产品决定，不是技术欠账。
4. **插件内 planner**：规划归宿主 Agent；插件做规划会和会话历史打架。

## 7. 那份社区普遍缺失的东西

对照下来最反直觉的一条：**没有一个生态层定义「一步成功的可验证契约」。**

- AndroidWorld 每个任务手写 checker，agent 侧拿不到；
- AndroidLab 用 judge model 判子目标，含 LLM 裁决成分；
- Mobile-Agent 靠「页面是否回退」当唯一步级信号，v2 自承会死循环；
- Appium / u2 / Maestro 只有「命令返回成功 / 抛异常」，Maestro 的 `retry` 怎么写完全由 DSL 作者决定。

本插件的 `expect` + 五态回执 + `unknown` 禁止重放 + 凭据 TTL，是这条线上唯一成形的答案。它的价值不在「多一个字段」，在于**模型可以知道自己不知道**。建议把它显式化成可被外部消费的 schema（同一份契约同时服务 Android 与 ScreenPilot），而不是继续只存在于回执文本里——这是当前最该做、也最容易被功能清单挤掉的一件事。

## 8. 建议顺序

1. **G2 分源** → 最小改动、影响所有后续匹配语义，先修。
2. **G4 载体绑定** → 半天量级，堵住「升级了但设备上还是旧 APK」这个静默坑。
3. **G3 + G5 上下文与 stable 收敛** → 一起做，都是「证据强度」问题，分开做会返工。
4. **G7 + G9 接线** → 成本低、收益直接，但都必须标 experimental 并走 conformance。
5. **G1 元素身份** → 需要先有 G2/G3 的干净数据，最后做。
6. **G10/G12 产品化** → 与 M4 接管一起排。

每步的停止条件沿用既有口径：新通道没过 conformance 就停在 `experimental`，不进默认降级链；局部绿灯不拼成完整 PASSED。

## 9. 三轮增量：DSH-Go 的 H1–H7（2026-11-04）

§2.4 那家换了一个问法：不是「动作够不够」，而是**「模型看到的东西有多贵」「模型被允许做什么」「做不了时它有什么合法出口」**。这三问在本插件这边分别有三处空白。

性质与判据口径同 §3：`正确性` / `表达力` / `工程化` / `刻意`；A=真机效果，B=本地生产路径离线复现，C=静态代码链核对，D=产品能力判断。

| # | 维度 | 本插件现状（已核对到代码行） | DSH-Go | 性质 | 判据 |
| --- | --- | --- | --- | --- | --- |
| H1 | 屏幕文本的字符预算 | `ui-graph.js` 的 `renderView` 每控件都内联坐标 `(x,y)`、短 id `#:id/…`、flags `[click,edit]`；`DEFAULT_TEXT_LENGTH=120` | 坐标仅在 `detail:true` 时附；短 id 不进模型视野；flags 折进角色名；软标签上限 60；分区 顶部/中部/底部；`+` 标新增、`…另有 N 项` 记账截断 | 工程化 | B |
| H2 | 敏感动作预标记 | 无词表。`flagsOfNode`（`ui-graph.js:194`）只输出 click/long/scroll/edit/checked/password/disabled 七种状态，不含风险 | 词表单源，`SafetyGate` 与渲染器同读；`⚠` 标的正是会被要求确认的 | 正确性 | C |
| H3 | 包级拒绝名单 | 无。`system-api.js` 的白名单管的是**系统能力**（四项绝对设置/设置页导航/四类草稿），不管**哪个 App** | `DEFAULT_DENY` 30+ 包（支付/银行/券商，连读都不给）+ `SYSTEM_PACKAGES`（默认写受限，有用户unlock与KEY/SCROLL例外）+ `DEFAULT_CONFIRM_EVERY_WRITE` | 正确性 | C |
| H4 | 交还用户的通道 | 无独立动作。模型遇到验证码/支付密码/人工登录只能硬试或反复失败 | `handoff(reason)`，等「继续」或「停止」，最长 10 分钟（MCP 超时为此单独设 660000ms） | 表达力 | D |
| H5 | stale 拒绝时回什么 | 有 `STALE_SNAPSHOT` / `STALE_FRAME`（`action-history.js:21`），但拒绝只给码，`text-arbiter.js:46` 返回动作 `reobserve` —— **要模型再发一次 Observe** | `stale()` 先 `observe()` 拿当前屏，把新屏幕塞进错误回执一起返回；模型一次就够 | 工程化 | B |
| H6 | Intent 优先 | `LaunchApp` 支持 `url`；`System` 的 `operation=navigate/set/draft` 只碰白名单四项设置 | 8 类固定 intent：`alarm` `timer` `calendar` `dial` `sms_draft` `share` `navigate`（高德/百度 + GCJ-02）`settings`（14 页），**全不需要无障碍** | 表达力 | C |
| H7 | 整列表收集 | `ScrollUntil` 必须指定 `container` + `target`（滚到某元素） | `collect(screen, list, max_pages 1–30, until)`：实际调用 scroll 改变 UI；不点业务控件不等于零输入只读 | 表达力 | C |

### 9.1 H1 的实测数字

拿同一份 6 控件样本跑 `parseUiGraph` + `renderView`，本机实测：

```
本插件：  258 字符 / 6 控件 = 43 字符每控件
紧凑格式： 99 字符 / 6 控件 = 16 字符每控件
```

以上仅是历史 6 控件样本字符差值。放大到 60 控件或 20 步属外推，token 依赖 tokenizer，不能写成通用实测收益。应测不同标签长度、底部导航和截断样本；完整匹配/证据不跟着裁剪。

### 9.2 H2/H3 为什么算 P1 而不是优化项

`flagsOfNode` 只标状态不标风险，所以一屏里会出现这样的行：

```
[4] 立即购买 (850,615) #:id/btn_buy [click]
```

该 Tap 目前没有包/敏感动作策略门；但是否直接付款取决于 App，不能从按钮名推导已支付。§7 说的「步级可验证契约」解决的是「事后能不能证明」，这一条解决的是「事前要不要问」，两者不是一回事，不能互相替代。

它的词表里有一条判据值得直接抄：**标签超过 24 字符就是内容不是控件**，敏感词只在「短标签」或「词在首尾」时命中。否则一条聊天消息里出现「发送」就会把整屏标红。英文用词边界正则（`buy` 不匹配 `buyer`）；view-id 按分隔符与 camelCase 拆词再拼相邻对（`btn_sendMsg` → `btn, send, msg, btnsend, sendmsg`，故 `verify_code` 也能命中 `verifycode`）。

### 9.3 不算欠账的四件事（本轮）

1. **同机闭环架构本身**：它把引擎与 MCP server 放进同一台手机，因此没有 adb 边界；本插件是跨 adb 的宿主插件，服务的是「电脑上的 Agent 操作手机」。这是选档，不是落后。
2. **VirtualDisplay 后台屏**：不必然 root，也不是无障碍架构专属。scrcpy 当前 newDisplay 拒绝 API<29，ADB shell 可承载该形态，不证明本机支持。暂缓因为 display 凭据、窗口/输入所有权、生命周期与 ROM 兼容成本，而非「要root所以冲突」。[scrcpy Server](https://raw.githubusercontent.com/Genymobile/scrcpy/master/server/src/main/java/com/genymobile/scrcpy/Server.java)。
3. **整套安全模型的判定位置**：它在 Android 进程内同时握着包名、节点、view-id、Intent 四份上下文；本插件这些要跨 adb 传回宿主。直接抄代码会把一道判定拆成两半——**词表与判据可以抄，判定点位置不能抄**。
4. **工具清单不随权限变化**：这一条**本插件已经做对了**。`tool-catalog.js` 是静态字面量，不随能力/授权改变；跑不了的调用返回可操作的解释。它的理由（工具名/描述/schema 进每次请求，任何变化从第一个改动 token 起废掉 KV cache）与本插件既有做法一致，无需改动。

### 9.4 许可边界

DSH-Go 是 **AGPL-3.0**（`sdk/`、`examples/` 为 MIT；名称、标识、Deepy/鲸娘素材不在开源授权内）。词表、格式规则、判据这些**思路**可以自由学习；整段代码搬进本仓库要连带开源义务，不能照抄文件。

---

G1–G13 已并入[路线图](android-controller-roadmap.md) §0.4，G2/G3/G4/G5 的落地排期见其中 M2.5 阶段；H1–H7 并入同一路线图 §0.5，落地排期见 M2.6（H1/H2/H3/H5/H6/H7）与 M4.0（H4）。

## 10. 本次取舍：吸收机制，不复制权限面

- **本批已吸收**：文件内容校验、内容寻址与明确 startup_file 证据；不复制错误后自动重发。固定靶场 idle 增加现有采样时间、完整布局摘要、有界纯几何诊断，不新增设备读、不改原稳定判据；dump freshness 仍 unproven。
- **下一批**：text/desc/any 严格分源（未发布，直接切契约，不留淘汰兼容）；完整 stable/display 证据统一；读返回与写派发共用策略门，风险同源。审批须绑定设备/任务/上下文/目标/动作摘要/策略版本/有效期；换屏、撤销、到期失效。无可信审批通道先拒绝并返回 needsConfirmation，不接受模型 confirmed=true，不保存自动恢复写动作。
- **呈现按需吸收**：坐标/短 ID 按需，保留完整内部匹配和布局证据。参考 [ScreenFormat](https://raw.githubusercontent.com/ccch1mneyyy/dsh-Go/f75d4a19dd0846ae2764fa63758c7abdb25ab44d/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/a11y/ScreenFormat.kt)，独立实现，不搬 AGPL 代码。
- **非 M3 硬前置**：typed intent 先去重现有 dial/sms/calendar/settings，再逐类声明 effect、授权、唯一 resolver。alarm 可能直接保存，timer skipUI=false 也不保证无副作用，不能统称末尾由人确认。[SystemActions](https://raw.githubusercontent.com/ccch1mneyyy/dsh-Go/f75d4a19dd0846ae2764fa63758c7abdb25ab44d/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/SystemActions.kt)。Collect 承认滚动是输入，复用租约/预算/取消/未知禁重放，定义 partial/truncated/stopReason/来源页和不抹合法重复的去重策略；当前暂缓。[collect循环](https://raw.githubusercontent.com/ccch1mneyyy/dsh-Go/f75d4a19dd0846ae2764fa63758c7abdb25ab44d/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/a11y/MainScreenDriver.kt)。
- **不吸收**：任意 shell/intent、自动重放未知写、整套 Appium/Portal、插件内 planner、root/uinput、未经接管状态机开放 scrcpy control。真实 sourceNodeId 句柄、VirtualDisplay、像素稳定独立评估，不能用 XML 哈希或两次采样替代真实保证。

外部核查是 C（官方源码/文档），本地离线契约是 B；本轮未执行 ADB/真机验证，M2 历史 13/14 NOT_PASSED 不变。

## 11. A/B/C 路线补核

当前默认继续A（ADB+app_process）；B（安装helper直连）不因无障碍API就更优，C（受控shell服务端/fork）也不预先立项。[专项复核](android-controller-route-review-2026-11.md)记录随包SHA、classes6/2精确分支和官方资料：rootInActive=true早返活动根，false遍历窗口，API30+多display；内部listener与waitForWindowUpdate已在APK，宿主窗口envelope/通用事件订阅仍未接。多窗口/事件非B独占；display-id不等于windowId/drawing-order不等于跨窗口Z序；API34数据敏感不能凭空壳确定归因。61ms样本不能否定轮询成本或推出B更快。B的价值是无需持续开发者调试与产品部署体验，代价包含新Android后端/权限/认证/截图/生命周期，而非只换start/stop。本次未操作设备或更换APK。

本批代码完整离线1740/1740通过（0失败/取消/跳过，14.213s），不替代M2历史13/14 NOT_PASSED；运行owner身份/终止、分源、统一上下文与stable、策略门仍待后续。
