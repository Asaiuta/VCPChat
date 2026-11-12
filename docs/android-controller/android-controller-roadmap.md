# AndroidController 路线图

状态（2026-11-05 晚间）：**进展数字与阶段档位一律见 [README 的状态表](README.md)，本文件不复制。** 这里只重复一句结论：M3 的硬前置（M2.5 身份与上下文、M2.6 策略门）已集成并离线验证，并在 PJZ110 上跑过真机矩阵（M1.5 14/14、M2 14/14、结构/Collect 5/5、原生批准 4/4）；M3 本体仍是零实现，M4.5 的最新 P0 结论见下文——单 ROM 固定靶场通过不等于「M3 前置全部验收完成」，跨 ROM、旋转/多 display、在途未知 RPC、soak 仍是欠账。

本文§0.1/0.4/0.5的“无/缺/待做”矩阵为相应调查时快照，当前代码以§M2.5/M2.6状态为准。M0.4分层摘要模块已实现并接入Observe证据，旧性能采集脚本/基线迁移、ROM环境补全与soak未因新增hash自动完成。范围为AndroidController及与VCPChat/VCPToolBox接缝。

本文件只写依赖真实扩展点的项。凡标「未实测」的，都是还没跑过的判断，不是结论。

2026-11-07：M5 的 Jev 补齐顺序、恢复/升级边界与准入协议已细化为 [J 系列路线图](2026-11-07_jev-loop-roadmap.md)，随后启动 J1.1 完成契约首批实现，见 [首批记录](2026-11-07_jev-j1-completion.md)。J 系列细化 M5.1a/b/f，Skill 学习和持久恢复仍归 M5.1c/d/e、M5.2；实际验收档位以 README 为准。

**状态标记**（全文统一，逐档升级需各自证据）：`未开工` → `已落代码` → `已集成` → `离线验证` → `真机通过`。「已落代码」只表示契约测试绿；「真机通过」限单 ROM 固定靶场，不外推分辨率、参数组合或其它 ROM。

**当前阻塞**：M1.5 `ScrollUntilHost` 的可见性分歧已由 `scroll-axis-interior` 契约收口并在本机通过，不再阻塞；M4.5 卡在 P0 五条探针（A1–A5），探针不过不排期。仍欠的环境准入：跨 ROM、旋转/多 display、真实在途未知 RPC 注入、30–60 分钟 soak、历史性能基线迁移。

## 0. 判断

Android 侧缺的不是能力，是**分层**。

Windows 侧的 `ScreenPilot` 已经把「UI Automation 原生动作 → OCR 文本点击 → 图生图视觉定位」三级降级链跑通（`Plugin/ScreenPilot/screenpilot_core/interaction.py:9`，`DEFAULT_CHANNELS = ("uia", "ocr", "image_edit")`），并配了 `WaitForText` / `Interact` 这类语义入口。

Android 侧原先只有链条的两端：**语义树**（`ui-graph.js`）和**像素**（`vision.js`）。中间层（OCR、模板）仍待补齐。M1 正在把原先仅用于 `ping/dumpWindowHierarchy` 的设备端 RPC 接到动作层：Fill、触摸与剪贴板粘贴复用现有 APK，不新增任意反射入口；详细实施与验收状态见 M1。

所以路线图的主体是**把已有的接上、把已验证的分层搬过来**，不是新造框架。

### 0.1 外部对标：动作语汇的差距（2026-11-03 调查）

§0 的判断对**感知层**成立（缺的是分层），对**动作语汇层**不成立：动作集本身就短，分层再漂亮也表达不出来。

本节分四层：能力对照（0.1.1）→ 参考实现索引（0.1.2）→ **随包 APK 的实测能力面（0.2）** → 由实测修正的判断（0.3）。0.1.1 表里的「判定」已按 0.2 的实测重标：原来记作「缺通道」的几项，实测是「缺接线」。

#### 0.1.1 能力对照

> **本表是 2026-11-03 的调查快照，不是现状。** 「双击：无」「长按：同点 swipe 模拟」这类行在 M1.5 后已全部失效。读现状请看 [README 的状态表](README.md)；本表留着的唯一理由是记录「当时依据什么下的判断」，以及 §0.3 那五条被实测推翻的结论。

对照对象与定位：uiautomator2（设备原语最全）、Appium UiAutomator2 driver（`mobile:` 动作集）、scrcpy（control 协议）、mobilerun / droidrun（同为「设备端常驻 APK + ADB」架构，最可比的同类）、Open-AutoGLM（Agent 侧 10 个动作）、Maestro（流程 DSL）、AndroidWorld（评测动作空间）。

| 能力 | 本插件现状 | 外部最强参照 | 随包 APK 实测 | 判定 |
| --- | --- | --- | --- | --- |
| 双击 | 无，`Tap` 只发一次 | u2 `double_click`；AndroidWorld `double_tap`；AutoGLM `Double Tap`；Maestro `doubleTapOn` | 无 `doubleClick` 原语（-32601） | 缺实现（两次 `click` 组合） |
| 长按 | 起止同点 `swipe` 模拟 | 各家原生 `long_click` / `longPressOn` | **有**：`click(x,y,ms)` 三参重载 | 应改原生，现为绕路 |
| 拖拽 | 无。`LongPress` + `Swipe` 是**两条独立触摸流**，不等价 | u2 `drag` / `dragTo`；Appium `mobile: dragGesture` | **有**：`drag` / `dragTo` | 缺接线 |
| 多指捏合 | 无，签名表里没有多指形状 | u2 `gesture` / `pinchIn` / `pinchOut`；Appium `pinchOpen/CloseGesture` | **有**：`gesture` / `pinchIn` / `pinchOut` | 缺接线 |
| 路径 / 惯性 / 到边界 | 无，`Scroll` 只做单次定长手势，且不声称到达边界 | u2 `swipePoints`、`flingToEnd`、`scroll.to(text)` | **有**：`swipePoints` / `flingTo*` / `scrollTo*` | 缺接线 |
| 滚动到目标出现 | 无，只能模型反复 Observe+Scroll 逼近 | Maestro `scrollUntilVisible` | **有**：`scrollTo(Selector, targetObj, isVertical)` | 缺接线 |
| 清空字段 / 删除字符 | 仅 `Fill` 空串清空 | Maestro `eraseText`（默认 50、上限 100，模拟退格） | **有**：`clearTextField` / `clearInputText`；退格需自组 | 部分缺实现 |
| IME action / 组合键 | 无 | u2 `send_action`（客户端组合）；Maestro `hideKeyboard` | `sendAction` **不存在**（-32601），但 `pressKeyCode(keyCode, metaState)` **有** | 缺实现（宿主侧自组） |
| 焦点输入 / Unicode | RPC `setText`；非 ASCII 走系统剪贴板 + `KEYCODE_PASTE`，不依赖当前 IME | mobilerun 靠 Portal 键盘；AutoGLM 要求手工安装并启用 ADBKeyboard | `setText` / `setClipboard` / `getClipboard` 均在 | **优** |
| 字段替换 + 读回 | `setText` → 窗口内轮询 `getText` 精确比对；密码框只记 `dispatched` 不读回 | u2 有 `set_text` 不读回；Maestro 只能 `assertVisible` 间接断言 | `getText` 在 | **显著优** |
| 等待空闲 | `Wait` 只靠 `expect` 轮询 | u2 `waitForIdle`；`waitForExists` / `waitUntilGone` | **有**：`waitForIdle(timeout)` | 缺接线（M2.3） |
| 动作凭据 | `index` 需 `snapshotId`、像素需 `frameId`，15s 过期，执行前复核内容与布局 | 无同类：AndroidWorld 裸 `index`，AutoGLM 纯坐标 | 无（宿主侧概念） | **显著优** |
| 回执语义 | 五态 + `retryable=false` | 大多只有成功 / 抛异常 | — | **显著优** |
| 有界序列 / 重试 | 8 步上限、中间步必验；**无内置重试** | Maestro `retry` 有界（`maxRetries` 0–3，默认 1） | — | 持平（上一版「无界」有误） |
| 动作历史 | 无。`sequence` 只在单次回执里活着，跨轮次即丢 | Appium `mobile: getActionHistory` / `scheduleAction` | — | 缺（低优先） |
| 系统动作（旋转 / 定位 / 权限 / 网络 / 通知栏） | 仅 `System` 白名单：固定读取 + 四项绝对设置 + 拨号短信草稿 | Appium `mobile:` 全套；Maestro `setOrientation` / `setLocation` / `setPermissions` | **有**：`openNotification` / `openQuickSettings` / `setOrientation` / `freezeRotation` / `wakeUp` / `takeScreenshot` | 设备端有，**授权面仍收窄** |

#### 0.1.2 参考实现索引

| 能力 | 参考实现（源码锚点） |
| --- | --- |
| 双击 | u2 客户端 [`double_click`](https://github.com/openatx/uiautomator2/blob/master/uiautomator2/__init__.py)（`__init__.py:244`：`touch.down().up()` + `sleep(0.1)` + `click`）；Maestro [`doubleTapOn`](https://docs.maestro.dev/reference/commands-available/doubletapon)（`delay` 默认 100ms）；Appium [`mobile: doubleClickGesture`](https://github.com/appium/appium-uiautomator2-driver/blob/master/lib/commands/gestures.ts) |
| 长按 | 设备端 [`AutomatorServiceImpl.click(int,int,long milliseconds)`](https://github.com/openatx/android-uiautomator-server/blob/master/app/src/androidTest/java/com/github/uiautomator/stub/AutomatorServiceImpl.java)（`touchDown` → `sleep(ms)` → `touchUp`）；u2 客户端 `long_click` 就是调这个三参重载 |
| 拖拽 | 设备端 `drag(startX,startY,endX,endY,steps)` → `UiDevice.drag`（按下→保持→移动）；`dragTo(Selector, x, y, steps)`；Appium `mobile: dragGesture` |
| 多指 | 设备端 `gesture(Selector, p1, p2, p3, p4, steps)` → `UiObject.performTwoPointerGesture`；`pinchIn/pinchOut(Selector, percent, steps)`；Appium 走私有 `/appium/gestures/pinch_close`；scrcpy [`TYPE_INJECT_TOUCH_EVENT`](https://github.com/Genymobile/scrcpy/blob/master/server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java)（`pointerId` + `pressure`） |
| 路径 / 惯性 | 设备端 `swipePoints(int[] segments, int steps)` → `UiDevice.swipe(Point[], steps)`；`flingForward/Backward/ToBeginning/ToEnd`；u2 客户端 `swipe_points` 把点列展平成 `int[]`（`__init__.py:293`） |
| 滚动到目标 | 设备端 `scrollTo(Selector obj, Selector targetObj, boolean isVertical)`（一次 RPC 内循环滚动）；Maestro [`scrollUntilVisible`](https://docs.maestro.dev/reference/commands-available/scrolluntilvisible)（`timeout` 默认 20000、`speed`、`visibilityPercentage`、`centerElement`） |
| 清空 / 删除 | 设备端 `clearTextField(Selector)` / `clearInputText()`；Maestro [`eraseText`](https://docs.maestro.dev/reference/commands-available/erasetext)（按字符退格）；AndroidWorld `clear_text` 字段 |
| 键盘 | 设备端 `pressKeyCode(int)` 与 `pressKeyCode(int, int metaState)`、`pressKey(String)`；Maestro `hideKeyboard`；u2 的 `send_action` 是**客户端组合**，设备端无此方法 |
| 等待 | 设备端 `waitForIdle(long)`、`waitForExists(Selector, long)`、`waitUntilGone(Selector, long)`、`waitForWindowUpdate(String, long)` |
| 剪贴板 | 设备端 `getClipboard` / `setClipboard`；scrcpy `TYPE_SET_CLIPBOARD(sequence, paste, text)`（设备内粘贴，不碰 IME） |
| Agent 动作空间 | [AndroidWorld `json_action.py`](https://github.com/google-research/android_world/blob/main/android_world/env/json_action.py)（14 类 + `keycode` / `clear_text`）；[Open-AutoGLM](https://github.com/zai-org/Open-AutoGLM)（Launch/Tap/Type/Swipe/Back/Home/Long Press/Double Tap/Wait/Take_over）；[mobilerun `AndroidDriver.supported`](https://docs.mobilerun.ai/framework/sdk/adb-tools)（`drag` 未实现、用 `swipe`；Unicode 靠 Portal） |

### 0.2 随包 APK 的实测能力面（PJZ110 / Android 17 / u2-server-0.5.0）

原因很直接：上一版的对照表是从各工具的**文档**推的，而不是从**我们自己随包的那个 APK** 量的。两者不是一回事——u2 客户端里有 `swipe_ext`、`send_action`，设备端却根本没这两个方法。所以补一支探针，直接问设备。

探针手法：每个方法都用 **9 个 int 参数**调用。没有任何 RPC 方法有 9 个参数，因此存在的会先在方法解析处报 `-32602 (method parameters invalid)`，不存在的报 `-32601 (method not found)`；**不存在「参数校验通过 → 真的执行」的可能**，所以不点击、不滑动、不改设置。三个重载另用零副作用调用区分（见下表）。

**存在的（-32602）**：`click`（2/3 参）、`longClick`、`drag`、`dragTo`、`swipe`、`swipePoints`、`gesture`、`pinchIn`、`pinchOut`、`scrollTo`、`scrollForward`、`scrollBackward`、`flingToBeginning`、`flingToEnd`、`pressKey`、`pressKeyCode`（1/2 参）、`getText`、`setText`、`clearTextField`、`clearInputText`、`getClipboard`、`setClipboard`、`waitForIdle`、`openNotification`、`openQuickSettings`、`setOrientation`、`freezeRotation`、`takeScreenshot`、`deviceInfo`、`getConfigurator`、`dumpWindowHierarchy`、`wakeUp`、`isScreenOn`、`injectInputEvent`。

**不存在的（-32601）**：`scrollIntoView`、`sendAction`、`swipeExt`、`doubleClick`。

重载判定（真派发，逐个列出副作用）：

| 调用 | 结果 | 说明 |
| --- | --- | --- |
| `click [-1,-1,800]` | `false` | 服务端首行 `if (x<0\|\|y<0) return false`，负坐标在触摸注入前返回；返回 `false` 而非 `-32602` ⇒ **三参重载存在**。无触摸注入 |
| `click [-1,-1]` | `false` | 同上 ⇒ 两参重载存在 |
| `pressKeyCode [0,0]` | `true` | `KEYCODE_UNKNOWN` + `metaState=0` ⇒ **双参重载存在**。**会真实注入一个无意义按键**，是全部探针里唯一有派发的 |

推论：u2 客户端的 `send_action` / `swipe_ext` / `double_click` 都是**客户端组合**，设备端没有对应原语。这直接决定了 M1.5 里哪些项是「接线」、哪些项是「写组合」。

### 0.3 由实测修正的判断

1. **多指 / 拖拽 / 路径 / 滚动到目标 / 等待空闲是「缺接线」，不是「缺通道」。** 上一版记成动作语汇硬缺口，方向对、严重度错：这些方法一直躺在 `u2-server-0.5.0.apk` 里，只是 `lib/rpc-methods.js` 的签名表没放行。成本是加条目 + 写动作分支，不是新通道，也**不需要**动 scrcpy control。
2. **`click` 第三参是按压时长，不是 `displayId`。** 这是明确错误，上游源码与真机双向否定：
   - 历史 tag `1.1.7` / `2.0.0` / `2.2.0` 的 `click` 只有 `(int,int)`；`2.4.0` 起加入 `click(int x, int y, long milliseconds)`，实现是 `touchDown` → `sleep(ms)` → `touchUp`。**没有任何版本把它当过 `displayId`。**
   - 真机 `click [-1,-1,800]` 返回 `false` 而非 `-32602`，证明本机 0.5.0 收的是三参重载。
   - 因此 M1 缺陷 2 里「用起止同点 `swipe` 模拟长按」不是唯一安全解，而是**绕开了设备端原生的长按原语**。`swipe` 同点仍可用，只应降为回退。
3. **`longClick` 真机报错的真因是「方法形状不对」。** 上游所有版本的 `longClick` 只接受 `Selector` / `String`，从来没有 `(int,int)` 重载；用坐标调它必然 `JsonMappingException`。之前记成「build 之间签名漂移」，把一个「根本没有这种形状」误读成了「版本不稳」。
4. **`pressKeyCode` 支持 `metaState`**：组合键能力在设备端已具备，宿主侧只是没暴露。上一版记成「缺」不准确。
5. **Maestro 的 `retry` 是有界的**（`maxRetries` 0–3，默认 1），上一版写「无界」有误。准确说法是：它**没有动作凭据、也没有「已派发不可重放」的判定**，重试怎么写完全由 DSL 作者决定。

**由本探针规定的通用做法**：以后任何「某通道有没有」的判断，不许再从客户端库或文档倒推，一律用「9 参哨兵 + 零副作用重载探测」直接问设备，并记入 §6.1 的 conformance 基线。

**已随 M1.5.0 同步的实现注释**：`lib/rpc-methods.js`、`lib/ui-server.js`、动作预算、LongPress 及模型可见说明中的「click 第三参是 displayId」已纠正为按压时长 ms；旧长按测试期望依据 §0.2/0.3 的随包 APK 证据更新，不再把错误论据固化成契约。

### 0.4 二轮对标（2026-11-04）：差距从「动作语汇」转到「身份与证据」

§0.1 的结论是「动作集短」，这件事已被 M1.5 关闭；§0.2 的实测把五项从「缺通道」改成「缺接线」。本轮换问法：**动作已经够多，那么「这个控件还是不是刚才那个控件」「设备上跑的是不是我随包的那个 APK」这两个问题，本插件能不能回答？** 都不能。完整矩阵、证据分层、外部来源与逐条落地建议见[生态对照与差距分析](android-controller-competitive-gap-2026-11.md)，本节只留会改变路线图的部分。

本轮核到的外部版本：scrcpy v5.0.1（2026-10-08）、appium-uiautomator2-driver 9.0.1 / server 10.7.10、openatx/uiautomator2 3.7.1、Maestro 2.12.1、Airtest 1.4.3（Poco 停更于 2024-01）、Mobile-Agent v3.5、droidrun Portal、mobile-mcp。随包 `vendor/scrcpy-server-v5.0.1` 的 SHA-256 与 GitHub Release 资产 digest 逐字符一致（资产级核对，不含真机）。

三条改变判断的外部事实：

1. **uiautomator2 3.x 移除了 atx-agent，改为运行时拉起设备端服务**——但这句话曾被本节误读成「本插件的形态过时」，2026-11-04 复核后更正。3.x 的设备端启动命令仍是 `CLASSPATH=… app_process / <Main> -p <port>`（[core.py](https://github.com/openatx/uiautomator2/blob/master/uiautomator2/core.py)：`/data/local/tmp/u2.jar` + `com.wetest.uia2.Main`），与本插件的 `/data/local/tmp/u2-server-0.5.0.apk` + `com.github.uiautomator2.Console` **只差两个 token，形态相同**。被移除的 atx-agent 是一个常驻 HTTP 守护（服务管理 / 装包 / `device_info` / `connect_wifi` / `app_icon`），本插件从未使用；[2to3 的移除清单](https://github.com/openatx/uiautomator2/blob/master/docs/2to3.md)几乎全是 Python 客户端 API 表面（`d.http` / `d.service()` / `healthcheck`），不是 RPC 协议。

   **真正的差异只有两条，都属选档不属落后**：上游转为 `u2.jar` + `com.wetest.uia2.Main`，本插件留在 APK 分支（该分支上游不再构建，是自有维护债，不是路线失效）；本插件选择常驻以规避 2.3s 冷启，上游改为按需拉起——后者服务的是「跑一轮就退」的测试脚本，前者服务「连续二十步 Observe」的 Agent，冷启成本按步数摊销，两者不该同构。

   **因此 G4（载体版本自校验）仍需自己做**，且上游已有可借鉴实现：`_setup_jar()` 里的 `_check_device_file_hash()` 就是推送前比对设备端哈希，正是 G4 要的东西。另据 dex 符号实测，vendor APK 含 `AdbKeyboard`、不含 `FastInputIME`，即至少是 `android-uiautomator-server` 2.4.0 之后的构建，不是陈旧二进制。
2. **注入保真度的上限不在 adb**：scrcpy 控制协议 `INJECT_TOUCH_EVENT` 原生带 `pointer_id` 与 `pressure`，UHID/uinput 能生成 deviceId≠0 的新输入设备。本插件走 RPC→instrumentation，与 Appium 同档。**这是选档，不是缺陷**（§4 已定不动 root/uinput）。
3. **GUI Agent 九成是「截图+坐标+adb」**：Mobile-Agent 全系不读无障碍树，Portal 的 UI 树/手势/截图仍依赖 a11y，但已有 no-a11y 非 UI 子集。它们的评测口径（AndroidWorld 每任务手写 checker、AndroidLab 用 judge model 判子目标）恰好暴露整条生态缺的东西——**步级可验证契约**。本插件的 `expect` + 五态回执 + unknown 禁重放 + 凭据 TTL 在这条线上没有对等物。

#### 0.4.1 差距矩阵（G1–G13）

性质：`正确性`＝结果是错的或证据是假的 / `表达力`＝能做的少 / `工程化`＝能跑但不好维护 / `刻意`＝设计取舍。判据沿用 A/B/C/D 分层：A=真机效果，B=本地生产路径离线复现，C=静态代码链与外部源码核对，D=产品能力差距判断。

> 本节 G1–G13 与 §0.5.1 的 H1–H7 均为对应调查轮的快照，行状态随批次演进可能滞后；完整对照与更新说明见[competitive-gap](android-controller-competitive-gap-2026-11.md)，里程碑现状以[状态表](README.md)为准。

| # | 维度 | 本插件现状 | 社区最强 | 性质 | 判据 |
| --- | --- | --- | --- | --- | --- |
| G1 | 元素身份 | 每步按语义 rebind；`index` 靠位置 + 15s 快照 | Appium：UUID=`windowId`+`sourceNodeId`，miss 时按 `By` 重定位后重算 UUID 二次校验才判 stale | 正确性 | C |
| G2 | text / content-desc 分源 | 调查时合并label；本批严格text/desc/any已落代码，设备新验收未做 | Appium / u2 分列 `text` 与 `contentDescription` | 正确性 | B |
| G3 | 显示/窗口维度 | 本批普通语义链与frame统一新鲜上下文/epoch；多root仅诊断，完整窗口元数据与多屏输入未交付；虚拟屏已立为 M4.5（零实现） | Appium `listWindows/listDisplays` + `currentDisplayId`；scrcpy `--display-id` | 正确性 | C |
| G4 | 载体身份 | 本批SHA内容路径+每generation启动文件证据；运行owner已按wrapper绑定并通过本机专项（2026-11-05，见状态表） | scrcpy：启动首参=客户端版本，不等直接失败 | 正确性 | B |
| G5 | stable 语义 | 本批统一200ms完整raw布局/上下文，动态text与像素不在保证内；设备未准入 | Maestro层级settle与像素static分开，部分超时仍成功 | 正确性 | B |
| G6 | 选择器关系 | 一层 `within`、`nth` 位置 | Maestro 关系选择器 + traits + state + 容差；u2 child/sibling/上下左右 | 表达力 | C |
| G7 | 多点手势 | 仅 `pinchIn/Out` 固定两指 | 设备端 `gesture` / `swipePoints` / `flingTo*`（已证存在，未接线） | 表达力 | A |
| G8 | IME 语义 | `ImeAction` 只是 `KEYCODE 66/84` | Appium `performEditorAction` / `hideKeyboard`（人造 IME） | 表达力 | C |
| G9 | 等待原语 | 仅 `expect` 轮询 + 有界 idle | 设备端 `waitForExists` / `waitUntilGone` / `waitForWindowUpdate`（已证存在，未接线） | 表达力 | A |
| G10 | 每步产物 | 文本回执 + 脱敏历史 | Maestro：每步截图 + `commands.json` + 失败层级快照 | 工程化 | C |
| G11 | 泛化数字 | 单 ROM 单靶场 14 项 | AndroidWorld 116 任务 / 20 App | 工程化 | C |
| G12 | scrcpy 闲置能力 | `control=false audio=false`，无虚拟显示；立项见 M4.5 | `--new-display` 虚拟显示器、剪贴板同步、file drop、UHID | 工程化/刻意 | C |
| G13 | 能力指纹门禁 | 有签名表 + 只读探针，未自动化成闸门 | 无对等物（u2/Appium 靠版本号硬绑） | 工程化 | D |

#### 0.4.2 本轮改动的优先级

- **G2、G4 由 P2 升为 P1。** 两条都能追到代码行，且都属于「静默给出与事实不符的东西」：G2 让「观察到的东西」与「真实控件」不再一对一，G4 让设备上跑的可能是旧载体而回执一切正常。落地见 M2.5。
- **G3、G5 维持 P1**，与 [M3 前复审](android-pre-m3-gap-review.md)一致，不再重复论证。
- **G1 仍是正确性问题，但排在 G2/G3 之后**：稳定身份要先有干净的字段与上下文数据，否则是把脏输入喂进哈希。
- **G6/G7/G8/G9 维持 P2**；其中 G7、G9 是接线（规模 S），G6、G8 需要新的授权或能力决策。
- **G13 排入 M2.5.5**：共享代码/载体内容摘要，但 code identity、性能环境与设备能力证据分层；Node/OS/ROM/配置/workload 仍影响基线可比性，不能因为代码hash没变就合并基线。

### 0.5 三轮对标（2026-11-04）：手机端同机闭环，与「模型看到什么、被允许做什么、做不了时有什么出口」

§0.1 问「动作够不够」，§0.4 问「身份与证据可不可信」。本轮换了第三问：对象是 **DSH-Go**（[`ccch1mneyyy/dsh-Go`](https://github.com/ccch1mneyyy/dsh-Go)，AGPL-3.0，核查固定commit `f75d4a19dd0846ae2764fa63758c7abdb25ab44d`），它把 MCP server 放进 App 进程、让手机里的引擎当 MCP client 连自己，因此**没有 adb 边界**。它的架构与本插件不同档（见 §4 「明确不做」本轮新增的「把 DSH-Go 的同机闭环搬进来」一行），所以本轮只取「与架构无关、纯宿主侧就能落地」的差距。完整证据、实测数字与不算欠账的四件事见[生态对照与差距分析](android-controller-competitive-gap-2026-11.md) §2.4 与 §9，本节只留会改变路线图的部分。

#### 0.5.1 差距矩阵（H1–H7）

判据口径同 §0.4.1。

| # | 维度 | 本插件现状 | DSH-Go | 性质 | 判据 |
| --- | --- | --- | --- | --- | --- |
| H1 | 屏幕文本字符预算 | 本批textLength默认120、detail默认false，坐标/短ID按需，公开裁剪不改完整证据；通用收益未实采 | 坐标仅 `detail:true` 才附，短 id 不给模型，flags 折进角色名，标签上限 60，分区 顶部/中部/底部，`+` 标新增、`…另有 N 项` 记账 | 工程化 | B |
| H2 | 敏感动作预标记 | 本批唯一短标签/ID风险词表与派发共用，启发式不证明完整敏感效果 | 词表单源，`SafetyGate` 与渲染器同读，`⚠` 即会被问的 | 正确性 | C |
| H3 | 包级拒绝名单 | 本批deny读写/readOnly禁写/confirmEveryWrite拒绝门已落代码，System grant仍独立必需 | `DEFAULT_DENY` 30+ 包（支付/银行/券商，连读都不给）+ `SYSTEM_PACKAGES`（可读绝不动作）+ `DEFAULT_CONFIRM_EVERY_WRITE` | 正确性 | C |
| H4 | 交还用户的通道 | 调查时无独立动作；本插件 `Handoff` 已于 2026-11-05 落地（M4.0，真机 4/4） | `handoff(reason)`，等「继续」/「停止」，最长 10 分钟 | 表达力 | D |
| H5 | stale 拒绝时回什么 | 本批保留原错误，读策略/预算/取消/隔离允许才附一次新屏，否则screen=null+reason | 拒绝时先 observe，把新屏幕随错误回执一起返回 | 工程化 | B |
| H6 | Intent 优先 | `LaunchApp` 仅 `url`；`System` 的 `navigate/set/draft` 只碰白名单四项设置 | 8 类固定 intent：alarm/timer/calendar/dial/sms_draft/share/navigate/settings，**全不需要无障碍** | 表达力 | C |
| H7 | 整列表收集 | `ScrollUntil` 必须给 `container` + `target`；本插件 `Collect`（M2.6.6）已落地 | `collect`：自动翻页、按文字去重，实际调用 scroll 翻页改变 UI，不点业务控件但不是零输入只读，`max_pages 1–30` | 表达力 | C |

#### 0.5.2 本轮改动的优先级

- **H3、H2 定为 P1，且排在 H1 之前。** 两者都是「派发链路上没有任何拦截点」：`flagsOfNode` 只标状态不标风险，一屏里 `[4] 立即购买 (850,615) #:id/btn_buy [click]` 这样的行配一句 `Tap id=…` 就付了。§0.4 的「可验证契约」解决的是**事后能不能证明**，这一条解决的是**事前要不要问**，不能互相替代。
- **H1 定为 P1，但它是成本项不是正确性项。** 本机实测（同一份 6 控件样本、同一棵树、两套渲染器）：本插件 258 字符 / 43 每控件，紧凑格式 99 / 16 每控件。按 `DEFAULT_LIMIT=60` 推算一屏 **2580 vs 990**，白烧约 1590 字符（≈800 token）；二十步任务累计约 16000 token 纯坐标与短 id。这是 6 控件样本的线性外推，只说明量级，不是通用实测收益（外推禁令见 [competitive-gap §9.1](android-controller-competitive-gap-2026-11.md)）。**这是每步都在漏，不是某一步会错**，所以放 P1。
- **H5 维持 P2**：纯机械改动，但影响每一步的往返次数（拒绝后要模型多走一次 Observe）。
- **H6 高于 H7**：定闹钟/日程/导航/短信/分享这几件事，走固定 intent 不点界面，稳定性差一个量级；`collect` 只省调用次数。
- **H4 不进 M2.6，单列为 M4.0**：它是 M4「人机协同」的**不依赖 `control=true` 的前置路径**——交还用户不需要开 scrcpy 控制通道，也不需要接管状态机。这也让 M4 第一次有了「即使接管决定不做，也能先交付一半」的可能。

#### 0.5.3 由本轮修正的一条既有判断

§0.4.1 的 G12 把 scrcpy 的 `--new-display` 写成「值得单独评估：在虚拟显示器里跑 Agent 可以不打扰用户」。DSH-Go 用 VirtualDisplay + shell uid 把这件事做成了产品，**但它需要的通道（Shizuku / Sui / Root / 自连 ADB）与 §4「不引入 root / Magisk 通道」直接冲突**，且它是无障碍架构的产物。结论修正：这条收益是真的，但本插件要落地只能走 M4 之后的独立评估，**不并入 M2.6，也不随 scrcpy 升级顺手打开**。2026-11-05 补：已按此结论单列为 M4.5（见 §2），但编号不等于排期，P0 探针事实先行，未过不排。

## 1. 可用扩展点（路线图的地基）

| 扩展点 | 位置 | 路线图怎么用 |
| --- | --- | --- |
| 设备端 RPC 客户端 | `lib/ui-server.js:93/222/259` | 加 `invoke(method, params)` 即可，启动/端口/forward/就绪轮询全部复用 |
| 承运 APK 能力面 | `vendor/u2-server-0.5.0.apk` | 动作原语与 Fill 的设备侧通道，无需自研 instrumentation |
| 动作派发与租约 | `AndroidControllerService.js` 的 `dispatchInput` + `lib/step-runtime.js` | 新动作**必须**走同一套租约/预算/取消，不得绕过 |
| 回执契约 | `observed/dispatched/verified/unknown/failed` + `retryable` | 新通道必须产出同一套 outcome，不允许自建一套 |
| 语义表与寻址 | `lib/ui-graph.js:494/577` | selector 表达力扩展落在这里，不动树的剪枝 |
| 视觉映射 | `lib/vision.js` | 元素级截图、OCR 坐标归一化落在这里 |
| 插件配置 | `plugin-manifest.json` `configSchema` + `VCPDistributedServer/Plugin.js:73` | 新开关必须同时进 configSchema，否则设置界面不可见、只能改 `config.env` |
| 人类授权面 | `modules/settings/schema/android-system.js` | 人类可见的风险开关（如接管）走这里，不塞进插件正文 |
| 显示通道 | `lib/stream-server.js` + `lib/scrcpy-hub.js` + Loom 侧栏 | 人类观察当前已通；人类操作见 M4 |
| 宿主已有能力 | `ScreenPilot`（OCR/降级链）、`FileOperator`（文件） | 只借设计，不复制实现；手机文件传输只补 push/pull 原语 |
| 用户侧 App | `VCPMobileSync` | 与 Agent 控制是两条线，不合并 |

## 2. 阶段

### M0 把账对上（半天级，先做）

| 项 | 交付 | 判据 |
| --- | --- | --- |
| M0.1 | `UI_SERVER` 进 `plugin-manifest.json` 的 `configSchema` | 设置界面能关掉常驻 RPC；默认值仍为开 |
| M0.2 | 复采 Observe 基线 | 现基线（`android-performance-baseline.md:89`，p50 2345ms）是 CLI 路径的数字，`ui-server.js` 落盘后未复采；文档第 139 行「2.1 秒本体未优化」已与代码矛盾 |
| M0.3 | README 划掉已不成立的自述 | 「Fill 尚不支持：UIAutomator 只有 dump/解析」在 M1 后失效 |
| M0.4 | 基线指纹补「代码状态」 | 现有指纹只有 host/serial/platform/arch/node/adb/vendor/model/android/sdk（`lib/perf-baseline.js:23`），**不含任何代码标识**：换 node 会生成新文件，改代码不会。本次「基线描述旧代码」正是这个洞的直接后果 |

> **执行记录（2026-11-02）**：M0.1–M0.4 的实际执行结果、复采数字，以及期间发现并修掉的 `_ensureApk` 静默回退缺陷，见 [history](history.md) 的「2026-11-02 · M0 执行与期间发现的问题」。上面这张表只留交付与判据。

### M1 接通设备端 RPC（动作层）

| 项 | 交付 | 契约测试锚点 |
| --- | --- | --- |
| M1.1 | `UiServer.invoke()` + **方法签名表**（方法名 + 参数个数，不做任意反射调用） | `tests/android-rpc-client-contract.test.js`：未知方法必须拒绝；`click [x,y,800]` 这类形状错误本地红灯、`dispatched=false`、不写 body |
| M1.2 | **Fill**：非空 `setText` / 空串 `clearTextField` + `getText` 读回；仅可见、enabled 且设备身份唯一的文本字段 | `tests/android-fill-contract.test.js`：替换语义、读回不一致即为 `unknown`、密码框不读回 |
| M1.3 | Tap / LongPress / Swipe 优先 RPC，只有明确未执行才 shell 回退；长按用起止同点 `swipe` 表达 | `tests/android-rpc-actions-contract.test.js`：起点=终点、`steps↔duration` 成比例、通道顺序 rpc→shell；超时/取消/断连不重放 |
| M1.4 | 非 ASCII：**先只读探针、后副作用**，`setClipboard` + （`pasteClipboard` 或 `KEYCODE_PASTE`），不依赖 IME | `tests/android-rpc-client-contract.test.js`：探针只读、只下一次结论、超时不算不可用、停服作废结论；`tests/android-rpc-actions-contract.test.js`：get 族不可用时不走 pasteClipboard、`CLIPBOARD_PASTE_FALLBACK=off` 时不发按键 |

> **执行记录（2026-11-03）**：真机 6/6 的逐项结论、四项真机暴露缺陷（`maxDepth=0` 空树、包裹 View 误拒、非 ASCII 静默损坏、清空后 `\n`）、两项硬缺陷的处理与 charset 根因，见 [history](history.md) 的「2026-11-03 · M1 真机验收与缺陷处理」。

**为什么这是第一优先**：它一次性解掉四个现存问题——Fill（插件自己承认不做的那项）、非 ASCII 依赖用户手工切输入法、每次动作一个新 adb+shell 进程、`input swipe` 画不出曲线。

规模 M。风险：`setText` 依赖 UiAutomation 连接；目标不可用时 Fill 拒绝，派发后未知不重试，不模拟 shell 替换。只有触摸动作在明确未执行时保留 shell 回退，回执区分 `failed` 与 `unknown`。

### M1.5 动作语汇补齐（后五项是接线，不是新通道）

M1 把通道接通了，动作集却只有十个。**§0.2 的实测把这件事的性质改了**：多指、拖拽、路径、滚动到目标、等待空闲这五项，设备端原语**已经全在随包 APK 里**，缺的只是宿主侧的签名表条目与动作分支。真正需要新通道的只剩「动作历史」这种宿主概念。

| 项 | 交付 | 契约测试锚点 |
| --- | --- | --- |
| M1.5.0 | **修正 LongPress 与签名表**：`click` arity 放行 `[2,3]`，第三参标注为**按压时长 ms**；LongPress 改走 `click(x,y,duration)`，同点 `swipe` 仅作明确未执行时的回退；同步修正 `lib/rpc-methods.js:18` 与 `lib/ui-server.js:350` 的「displayId」错误注释 | `tests/android-rpc-actions-contract.test.js`：三参 `click` 通过、四参本地拒绝；LongPress 首选通道 `channels[0]==='rpc'` 且方法为 `click`；`steps↔duration` 断言只约束回退通道 |
| M1.5.1 | `DoubleTap`：两次 `click`，间隔 60–120ms（实现档：目标派发间隔 100ms、第二击须在 120ms 内开始派发，见插件 README DoubleTap 节）；第二击前重新 `check()` 预算与取消 | `tests/android-double-tap-contract.test.js`：间隔落入窗口、两击间取消不补第二击、两击各记一条 attempt、不得提前置 `verified` |
| M1.5.2 | `ScrollUntil`：优先 `scrollTo(containerSelector, targetSelector, isVertical)` 一次 RPC 完成；RPC 不可用或需每轮重采样时退到宿主有限循环（轮数上限 + 共享总预算 + 到上限报 `unknown`） | `tests/android-scroll-until-contract.test.js`：只滚不点、不唤醒、轮数上限生效、总预算不被拉长、两条路径不静默互切 |
| M1.5.3 | 键盘补齐：`imeAction`（`pressKeyCode(KEYCODE_ENTER` / `SEARCH`, `metaState`)）、`EraseText count`（`pressKeyCode(DEL)` × N，上限 100）、`KeyCombo`（双参 metaState） | `tests/android-keyboard-contract.test.js`：`eraseText` 不越删到空、组合键 meta 透传、`imeAction` 不越权成提交 |
| M1.5.4 | `Drag`：接设备端 `drag` / `dragTo`（按下→保持→移动→抬起），不是「长按 + Swipe」 | `tests/android-drag-contract.test.js`：一条触摸流、终点落在目标可见矩形内、失败不重放 |
| M1.5.5 | `Pinch`：接设备端 `pinchIn/pinchOut(selector, percent, steps)`；需自定义两指轨迹时用 `gesture(selector, p1, p2, p3, p4, steps)` | `tests/android-pinch-contract.test.js`：`percent` 范围、目标必须可见、参数形状错误本地拒绝；`experimental` 标记随 conformance 结论变化 |
| M1.5.6 | 动作历史：`Observe mode=history` 或 `Manage operation=actionHistory`，只读回看最近 N 步 | 不改变调度、不重放、不含动作参数原文 |

> **执行记录（2026-11-03）**：M1.5 首批增量与余项收束的逐项数字（135/929/1231、14/14 真机矩阵、`-99` 安装失败到最终通过）见 [history](history.md) 的「2026-11-03 · M1.5 交付与余项收束」。

**原执行次序（已执行）**：M1.5.0 先做——它纠正的是一个写错的注释加一个绕路的原语，成本最低、收益最大。M1.5.4 / M1.5.5 只加签名表条目与动作分支，规模 S。M1.5.2 有两条路径，必须先定「何时允许退到宿主循环」，否则很容易把两种语义混进一个 outcome。M1.5.3 的 `hideKeyboard` 设备端无专用原语，需真机定策略（退格 / 返回键 / IME 切换），**未定**。

**不再适用的一条旧判断**：上一版写过「M1.5.5 的多指通道与 M4.1 的人类接管争同一个 scrcpy control socket」。§0.2 实测证明设备端自带多指，scrcpy control 由「唯一路径」降为「备选」，两者不再互斥。

**不做**：照搬 Appium `mobile:` 的旋转 / 定位 / 权限 / 网络 / 通知栏动作面。设备端确实有 `openNotification` / `setOrientation` / `freezeRotation`，但**能力存在不等于授权面放宽**：宿主仍只经 `System` 白名单放行。

### M2 寻址与验证（跨帧寻址与有界稳定性）

**实施前核对（2026-11-03）**：用户指出的动态文案、局部视觉与等待缺口成立；但 M2 不能让旧 snapshotId/frameId 续命，也不能免掉动作前实时 dump。sequence 不必显式 Observe，每一步仍重新采样、重新定位，保留 15s 凭据、租约、总预算、取消与五态回执。原文「规模 S、纯宿主侧」只适用于简单属性匹配，不适用于本轮完整交付。

| 项 | 最新交付 | 契约测试锚点 |
| --- | --- | --- |
| M2.1 | 宿主 selector 扩展 contains / 安全受限 regex / class / role / 显式 nth，以及一层 within 祖先锚点 | `tests/android-selector-expressiveness.test.js`：动态文案、组合约束、歧义拒绝、视觉排序、真实后代关系、截断与恶意正则；公共动作/expect/sequence 集成 |
| M2.2 | `Observe mode=image target=element`，当前 selector 或 index+snapshotId 定位，可选 padding | `tests/android-element-shot.test.js`：实时定位、祖先/屏幕裁剪、padding、原元素中心不变、缩放与设备坐标映射、采集前后目标/尺寸变化拒绝 |
| M2.3 | `Wait action.mode=idle`：一次短原生 waitForIdle hint + 必须通过的有界完整布局双采样 | `tests/android-idle-wait.test.js`：原生void不得洗绿、动态文案不影响布局、上下文改变/空树/锁屏不洗绿、取消/预算/租约 |

#### M2.1 寻址契约

- 当前分源契约为 `id=…` / `text=…` / `desc=…` / `any=…`，字面 `%/#` 仍编码；text仅原始XML text，desc仅content-desc，any仅完整聚合label，不互相回退。contains/regex仅原始text，class/role保持已有含义。对象 `{id?,text?,desc?,any?,contains?,regex?,class?,role?,nth?,within?}` 严格拒绝未知字段/空条件/错误类型，每条件最多4096 UTF-16字符；regex最多512字符、原始text最多16384、查询工作预算8Mi，超限证据不能证明absent。未发布接口直接切新义，不留旧text聚合兼容层。
- **无显式序号时多匹配拒绝**。`nth` 是数字、零基，按 `(top,left,bottom,right,原控件index)` 确定排序；这是明确选择当前第 N 项，不是持久身份。旧 `#N` 保持一基、原遍历顺序的兼容行为，不悄悄改义。匹配必须覆盖完整候选集，不能因 limit 截断把重复项误当唯一。
- `within` 只支持一层父锚点，父须唯一，依据原始树严格后代关系；不做 near/上下左右距离推断。剪枝、角色归纳不改，role 只代表已有适配器角色，不凭 class=View 猜 Compose 编辑能力。
- **宿主与设备 Selector 是两个能力面**：nth 视觉序不等于 UiSelector.instance；role、within、聚合 label 和受限 JS regex 不做有损下推。M1.5 ScrollUntil 仍严格 id/text，Fill/EraseText 仍严格字段身份，Drag/Pinch 仍复核原始唯一 RPC 身份；不因 nth 消歧就越过设备唯一性。未来扩展 scrollTo 前，必须核对随包 APK ABI、原始文本语义与跨包限制，不能照抄上游 master mask。

#### M2.2 元素图像契约

- `target=element` 与显式 region/canvas 互斥；必须给 selector、id 或 index+snapshotId，不接受像素坐标作为元素身份。元素目标在本次截图前重新采树；复用原有图像编码与 mapping，不另造坐标系。
- padding 为设备像素整数 0–128，默认 0；先计算原控件与祖先滚动视口/屏幕交集，再外扩上下文并夹到屏幕。分别返回 elementBounds、visibleBounds、crop region、原元素中心；padding 不移动语义点击锚点。
- 树与截图不能原子获取；截图后再采样复核目标/上下文/尺寸，变化即拒绝发新 frameId，不以两帧相同声称中间绝对没变。只做元素截图不会自动减少 screencap 的设备流量。
- **遮挡只报告证据，不虚构 hit-test**：当前 XML 不保证多窗口/Z-order 完整，也没有可信键盘/顶层窗矩形接口。始终返回 occlusion=unknown 与可能遮挡警告；没有证据不能标 clear。自动键盘/Dialog 区域检测与真实点击遮挡保证留作后续独立能力，不把空警告冒充无遮挡。

#### M2.3 有界 idle 契约

- 现有 Wait 并非固定 sleep：必须 expect，复用 visible/absent/foreground 轮询。新增 `action={command:"Wait",mode:"idle"}` 可无 expect；普通 Wait 保持不变。有 expect 时必须先满足 idle 再验证条件，idle 未成立不得被外层 expect 洗绿。序列中间步仍须显式 expect。
- 原生仅在已有 RPC ready 时调用一次，设备 timeout 上限1500ms（签名门禁最大2000ms），给布局采样留出同一 waitTimeoutMs/整段总预算；不在短等待里冷启动独立服务。**随包 APK 会吞 TimeoutException 并正常 void 返回，因此原生成功仅作 best-effort hint，绝不直接标 ui_automation_idle 或 verified**。无现成 RPC 时走单次受截止约束的CLI采样，不复用旧采集链的多级重试。
- 原生正常返回、确定性设备 idle 超时、方法不支持或服务未就绪都必须再做布局确认；传输超时/断连/取消、未知在途不可伪装成功或立刻并发补 RPC。连续两次完整返回树的可见原始节点布局摘要，相隔200ms；包括 bounds/身份/可见启用及控件状态，忽略动态文案；比较全量，不复用前40项页面 signature，不接受空树/锁屏/缺失上下文。前台窗口/包或尺寸变化立即停止。
- 后备成功标 `idleMode:"layout_stable"`，只证明采样布局相同，不证明像素静止、无遮挡或业务完成。耗尽为 unknown，`retryable=false`，不输入、不唤醒、不重放原生调用；取消/总截止继续抛错且依赖排干前不释放租约。
- 当前普通写RPC、普通dump、bounded读均统一经 withDeviceRpc 隔离未知传输：后续同设备Observe/ExecuteStep、自动选设备及管理变更拒绝，同调用afterObserve不再请求。socket销毁/reconnect/ping及人工断言不能解除；当前Manage recoverOwner必须显式serial，仅本会话owner独立消失证明released后清隔离并撤销旧凭据，不接受force/approval，不重放。owner默认wrapper与Service隔离已集成，本机绑定、公开恢复与独立进程/端点消失检查通过；真实在途未知RPC真机注入仍未覆盖。元素末次dump后继续复核前台/窗口与新尺寸。

**对外部对标的修正**：关系定位、下推语义、现代框架暴露不足与遮挡确实是差距，但不把其它工具等同于万能穿透。Compose testTag 需要应用暴露（如 testTagsAsResourceId），Flutter/Canvas 受自身无障碍语义约束；waitForIdle 的事件静默不是每次动态重绘都可见，故「动画 App 100%超时」「各家固定500ms」「所有主线程停稳」均不能作为通用事实；本随包构建的500ms静默窗口则已由DEX证实。M2 仅补轻量祖先锚点与布局后备，不照搬重型框架。

**准入**：2026-11-03当时完整隔离回归1425/1425通过、0失败/跳过，15.140s（含两套CLI安全测试33条）；含真实loopback HTTP、有界正则独立参考、跨入口sequence/expect、未知传输隔离、hidden/disabled/长label、真实carrier声明与CLI尾行，以及安全切出传输cleanup。JS语法与限定差分空白检查通过。真机独立验证已经执行；首轮5/14暴露XML声明、次轮12/14暴露CLI尾行与运动存活断言，第三轮因切前台安全停，用户切回后第四轮13/14，host CLI已通过，动态idle截止边缘ADB_TIMEOUT收尾已先红后绿（定向87/87）；第五轮安全停止；第六轮运动窗口12秒过期，操作员显式授权后仅fixture延至30秒，第七轮完整13/14、0未执行、正常cleanup/exit1。动态运动前后存活、ticks48→157，idle却verified/layout_stable，独立断言未过；两次同布局与连续运动的采样轨迹/期望契约仍需核清，不直接归因为生产漏运动或改期望追绿，该轮真机记 NOT_PASSED（2026-11-05 基线改造后已复验 14/14，档位见[状态表](README.md)）；详见[M2真机记录](android-m2-device-validation.md)，不复用M1/M1.5或拼接局部绿灯。仍为experimental，固定单ROM靶场不代表跨ROM准入。

#### M2 实施前发现的 carrier ABI 与证据（2026-11-03，离线只读）

- 随包 `vendor/u2-server-0.5.0.apk` SHA256：`6d16845d28fea01d5ae069221d9df307c74e70b780eb99ac0b28cf8f6135a50f`。从ZIP内DEX读取静态值/方法代码，未连接设备、未执行动作。`classes6.dex` 的 `com.wetest.uia2.stub.Selector`：PACKAGENAME=`524288/0x80000`，INSTANCE=`16777216/0x1000000`，TEXTCONTAINS=2，TEXTMATCHES=4，CLASSNAME=16，RESOURCEID=2097152。现有通用RPC校验与Drag/Pinch/scrollTo构造误用INSTANCE作包位，漏包过滤风险必须先修。Fill已有package位+显式instance0，不在本次改动范围。测试旧常量按实际ABI修正，不以旧测试绿为正确依据。
- 原生idle链：`classes6.dex AutomatorServiceImpl.waitForIdle(J)V` code_item `0x7fa0` → `classes2.dex UiDevice.waitForIdle(J)V` `0x12318` → `QueryController.waitForIdle(J)V` `0x1001c`。后者在code-unit6装入500，unit8调用 `UiAutomation.waitForIdle(500,timeout)`；try(start0,count11)捕获 `java.util.concurrent.TimeoutException`，handler unit12，unit15字符串 `Could not detect idle state.`，unit17 Log.w，unit20 return-void。因此不能从RPC正常完成推导idle成立；本轮未运行序列化器，不把预期null当作真机实收。
- 证据层级：9参哨兵只证明方法可解析；DEX只证明该SHA构建静态实现；上游源码不等于carrier同commit可复现构建；任何一项都不替代ROM效果验收。M1.5已通过的动作矩阵不因此撤销，但它未证明跨包约束，本次修正仍需独立准入。

#### M3前成熟实现复审（2026-11-03）

完整证据、外部源码链接与排序见[差距审查](android-pre-m3-gap-review.md)。旧§0.1.1是实施前快照，Drag/Pinch/DoubleTap/键盘/滚动/历史/idle已接入，不应再作当前缺口。P1优先是完整可见断言/长标签证据（本轮已修）、真实carrier XML声明（真机首轮暴露已修）、frame的前台/rotation/display上下文、远端载体身份与写RPC未知后隔离/owner排干、旧Observe stable契约统一。后四项未因固定portrait靶场通过而消失。

P2为真正IME editor action（现仅key-event别名）、滚动可见比例/居中/无进展、更多类型化raw结构关系与query-vs-identity、多窗口/物理设备别名、像素稳定独立模式、代码/载体/ROM性能指纹和有界soak。不将系统权限收窄、禁自动重放或不启Accessibility/IME视为短板，不为追功能数扩大授权。

**2026-11-04 历史代码核查（当前结果见文首与2026-11-05报告）**：会话/传输已拆分，普通业务RPC未知隔离和像素fresh复核继续保留；本批严格分源、普通语义链上下文/epoch及完整布局stable已落代码。远端owner默认wrapper已编译且14项专项离线通过，旧fixture适配和最终集成验证仍在收口；恢复仅Manage recoverOwner显式serial+独立消失证明，不由文件SHA、ping、本地stop或人工断言清隔离，不重放。固定靶场idle诊断未产生新真机归因，不改变M2 NOT_PASSED。

- 参考：[上游Selector](https://github.com/openatx/android-uiautomator-server/blob/master/app/src/androidTest/java/com/github/uiautomator/stub/Selector.java)、[AndroidX QueryController](https://github.com/androidx/androidx/blob/androidx-main/test/uiautomator/uiautomator/src/main/java/androidx/test/uiautomator/QueryController.java)、[UiAutomation](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/core/java/android/app/UiAutomation.java)、[Compose semantics](https://github.com/androidx/androidx/blob/androidx-main/compose/ui/ui/src/commonMain/kotlin/androidx/compose/ui/semantics/SemanticsProperties.kt)、[Flutter identifier](https://api.flutter.dev/flutter/semantics/SemanticsProperties/identifier.html)、[Maestro稳定性实现](https://github.com/mobile-dev-inc/maestro/blob/main/maestro-client/src/main/java/maestro/utils/ScreenshotUtils.kt)。

### M2.5 身份与证据收口（M3 之前的正确性闸门）

M2 交付的是「寻址表达力」，M2.5 交付的是「寻址所依赖的事实是否可信」。G2/G4 是 §0.4 本轮新核出的可复现代码缺陷，G3/G5 是 [M3 前复审](android-pre-m3-gap-review.md)遗留的 P1，四项合起来构成 M3 的硬前置：OCR 与模板匹配都要把一个文字锚点绑定到「当前这一屏的某个控件」，身份与上下文不干净时，M3 只会把误差放大。

| 项 | 交付 | 契约测试锚点 |
| --- | --- | --- |
| M2.5.1 | **已集成，M2固定矩阵通过**：text仅原始text、desc仅content-desc、any仅完整聚合label；字符串/对象/within/生成selector/expect共用严格分源，呈现预算不改完整匹配 | [分源与预算测试](../../tests/android-selector-sources-budget.test.js)；离线全量回归见 [README](README.md) |
| M2.5.2 | **启动文件内容身份（本批已实现）**：本地SHA-256内容寻址，远端读回相等标verified；缺失/不符push一次后复核，仍不符拒绝启动。不可校验明确unknown，ADB/push失败不降格；generation缓存/失效。证据scope=startup_file，不认证运行owner；删除旧固定路径/存在即可信规则 | `tests/android-carrier-identity.test.js`：匹配不推、缺失/不符推后再验、不可读unknown、传输失败拒绝、升级换路径、stop/hash迟到/旧RPC迟到不污染新代，回执可见/history脱敏 |
| M2.5.3 | **已集成，本机portrait验证通过**：普通Observe/语义/像素共用新鲜display0/包组件窗口/旋转/逻辑尺寸/明确未锁上下文与epoch；变化/未知撤销旧凭据，未知OEM/多显示不猜 | [context纯模块](../../tests/android-m3-context.test.js)、[生产路径集成](../../tests/android-m3-context-service.test.js)；不声称原子防外部UI变化 |
| M2.5.4 | **已集成，M2 idle本机通过，stable专项见离线**：Observe stable:true与Wait idle均完整可见raw布局+200ms+新鲜上下文；忽略纯动态text，不证明像素/无遮挡。请求stable后false/unknown快照不授权index；stable=false仅not-sampled | [context生产集成](../../tests/android-m3-context-service.test.js)：limit=1尾部几何变化、前台变化、动态文案、间隔与未知证据 |
| M2.5.5 | **纯模块与Observe接入已实现**：当前生产JS/vendor/manifest字节code摘要；Node/OS/ROM/config/workload独立perf摘要，缺维度不完整；能力绑定carrier+session generation+device evidence，摘要不是授权，旧基线迁移未自动完成 | [identity测试](../../tests/android-code-identity.test.js)：脏内容/缺失/不可读/读时变化、独立摘要、跨realm/getter/secret拒绝 |

**边界（不因为这一阶段放宽）**：

- M2.5 不新增动作、不扩大授权面、不改 `System` 白名单。M2.5.1 只改匹配来源，不改剪枝与角色归纳。
- M2.5.2 不重打包/patch APK。SHA只证启动文件，不证endpoint后的owner；CLASSPATH非PM安装，versionCode不是SHA后备。当前另以wrapper绑定endpoint socket inode+远端PID/startTime/uid/cmdline/nonce，并精确自退出、独立确认消失；owner不明继续隔离。内容路径不删除未知旧世代文件，不杀非本会话进程。
- M2.5.3 不能声称「原子防外部 UI 变化」。能给的只有「派发前最后一次复核」，与既有凭据 TTL 的口径一致。
- **G1（元素身份）不在 M2.5 交付**。它需要 M2.5.1 的干净字段与 M2.5.3 的稳定上下文作为输入，排在 M3 之后单独准入；XML结构哈希不能冒充Appium真实sourceNodeId+windowId身份；没有独立身份依据前不静默恢复句柄。

**当前次序与未闭环项**：身份/分源/上下文/布局stable/分层摘要/策略门及owner集成已完成本轮离线验证（见 [README](README.md) 状态表）。2026-11-05 晚间的真机矩阵：M2 本机 14/14、M1.5 14/14（`DoubleTap` 单独复跑 3 次连续通过，连首轮共 4 次）、结构/Collect 5/5、原生批准/交还 4/4，均 exit 0；owner 生命周期验证通过。仍欠：真实在途未知RPC注入、跨ROM/多display、长稳与性能基线迁移。Manage recoverOwner只凭本会话独立消失证明解隔离，不收force/approval、不重放；不以单ROM固定靶场结果宣布全部M3前置完成。

**为什么 M3 要等**：M3 的 OCR 通道对同一个文字会给出与语义树不同的 bbox，既有约定是「语义树优先、OCR 只填空」。这个约定只有在语义树的字段来源（M2.5.1）与上下文（M2.5.3）可信时才有意义；否则「谁优先」的争论会变成在两个都不可信的来源之间挑一个。

### M2.6 动作前置策略与呈现成本

M3硬前置只包含安全门与读返回策略，不把新intent/Collect当作安全收口。M2.6.1–4已通过完整离线回归（数字见 [README](README.md)）；本机矩阵不替代跨包混合树、策略变更等全部离线边界，亦不构成完整跨ROM准入。策略每次动态读取；宿主可信原生对话框已接逐次确认，无可信服务仍拒绝。当前离线证据、真机边界见状态表。

| 项 | 交付 | 契约测试锚点 |
| --- | --- | --- |
| M2.6.1 | **统一读/写策略门**：denyPackages读返回与写派发均拒绝；readOnlyPackages禁止输入。Observe/图像/stale附屏/afterObserve共享读门，坐标/键盘/语义/System同走写门。逐次确认经主进程原生对话框，批准后重采样并比较设备/任务/动作/完整树/策略；无服务或变化拒绝，不接受模型confirmed=true | deny读不得泄露新屏/图片，写前拒绝不产生attempt；策略变更即时生效；明确System能力授权与包策略优先级 |
| M2.6.2 | **敏感风险同源**：唯一词表供风险标记与派发决策使用；先验证短标签/view-id/边界，长内容不误当控件。名单不是完整安全证明。审批已绑定serial/任务/上下文/完整树/动作摘要/policy摘要，单次等待最多60秒且受任务截止限制，换屏/撤销/到期失效；旧index/frame不能续期 | 标记与风险决策集合一致；缺批准拒绝，模型自批无效；读写及像素/键盘不得绕过 |
| M2.6.3 | **呈现预算（分源后）**：坐标/短ID按需、标签预算、截断计数；内部完整匹配和布局证据不裁。字符预算用多类fixture衡量，不把6控件样本线性外推成通用token收益 | detail控制坐标；完整匹配不受呈现裁剪；截断有剩余数；保留底部导航与歧义信息 |
| M2.6.4 | **stale附新屏**：仅读策略允许、设备未隔离且预算/取消允许时补一次观察；否则screen=null并保留原错误/原因，不唤醒、不重放 | 隔离/deny/超时不补采；新快照或明确null；不吞原错误、不产生写attempt |

**暂缓，非M3硬前置**：

- **M2.6.5 typed intent**：先去重现有dial/sms/calendar/settings；alarm/timer/share/navigate逐类列权限、effect（开页/草稿/立即变更）与唯一resolver。固定白名单不保证用户末尾确认，也不等于未扩权；需独立授权与ROM准入，不借现有schedule“不会自动响铃”授权。
**M2.6.6 Collect 已接入，离线验证，非M3硬前置**：按容器采可见启用后代，经现有Scroll翻页，复用租约/总预算/取消/策略/attempt/未知禁重放。maxPages=1–30，保留page/ordinal和重复，partial/truncated/stopReason明确；无进展不证明列表末尾，只有未截断的UNTIL_MATCH验证声明范围。maxPages=1仅采当前页。见tests/android-no-ocr-workflows.test.js。

**当前实现边界**：统一读/写门与短控件风险词表已接生产入口，INTERACTION_POLICY在manifest/env模板声明为string默认'{}'；全局系统授权页仅披露边界，不添加未消费的全局开关。呈现textLength/detail不裁完整匹配；stale仅读策略/隔离/预算/取消允许时附新屏，否则screen=null+reason并保留原错误。windows=true只读root诊断不等于完整窗口元数据、无遮挡或全窗口输入。可信一次性批准已由宿主原生对话框提供，缺服务拒绝，不依赖M4 handoff代批准；离线回归数字见 [README](README.md)，原始证据与设备限制见 [2026-11-05 收口报告](2026-11-05_audit-android-pre-m3-report.md)。

### 当前无OCR增量契约（2026-11-05）

- ScrollUntil改为scroll-axis-interior：可见区域须严格离开滚动轴两端边缘，host/RPC同判据，不推断原始元素可见百分比，不降低靶场32dp独立断言。
- selector增加childOf/siblingOf/hasDescendant，复用原始树provenance与查询预算；不建立跨页面句柄。
- 逐次批准与Handoff共用宿主注入的原生对话框服务，分布式层消费VCPToolBox已有cancel_tool；无第二套审批服务器/renderer批准入口。旧连接结果不发给重连后的连接。
- 真正IME editor action与完整窗口ID/type/layer证据需要新的设备能力，本批未实现，不把66/84按键或多root XML当替代证明。虚拟屏、事件订阅、持久化断点仍独立排期。

### M3 视觉中间层（与 ScreenPilot 对齐）

| 项 | 交付 | 契约测试锚点 |
| --- | --- | --- |
| M3.1 | OCR 通道：截图 → 文本 + bbox + 设备坐标，常驻引擎避免每次冷启 | `tests/android-ocr-channel.test.js`（fixture 图驱动，锁坐标换算口径） |
| M3.2 | `ClickText` / `WaitForText` 与 ScreenPilot **同名同参** | `tests/android-interact-degradation.test.js`：u2 → ocr → visual 顺序、每级失败原因保留、不静默改走下一级 |
| M3.3 | 模板匹配（离线兜底，可选） | 同一模板跨分辨率命中的归一化断言 |
| M3.4 | `Observe mode=ui` 在 `canvas.dominant` 时自动附 OCR | 画布页面从「只有坐标」变为「有文字锚点」 |

**岔路（我的建议）**：OCR 引擎不要复制 ScreenPilot 的 Python worker，而是把 `screenpilot_core/ocr.py` 的部署形态抽成共享能力。理由：两个插件各自带一份 RapidOCR 会让安装体积与模型加载翻倍，而 OCR 是纯函数、无状态，天然适合抽出。代价是要新增一个跨插件共享层，目前仓库没有。若不想动架构，退化方案是 Android 插件自带、仅在 `canvas.dominant` 时懒加载。

规模 L（含共享层决策）。风险：OCR 与语义树对同一文字的 bbox 可能不一致，必须明确「谁优先」——按 ScreenPilot 的既定顺序，语义树优先，OCR 只填空。

### M4 人机协同与多设备

| 项 | 当前状态 / 交付 | 契约测试锚点 |
| --- | --- | --- |
| M4.0 | **Handoff 已接入**：同一调用/序列内暂停；宿主原生对话框选择继续或停止；共享设备租约；前后使旧 snapshot/frame 失效；停止、取消、超时和迟到继续不重放。不是 viewer takeover，没有持久 resume token。 | 当前状态见[状态表](README.md)，原生交互历史见[本机验收](2026-11-05-device-acceptance.md) |
| M4.1 | **首批已集成**：默认屏/显式设备/原生批准/socket绑定会话与epoch；Agent/Handoff/M5共用运行时接管门，真实排干后移交，未知先隔离；有限快照点击/滑动及返回/主页/最近任务。状态与数字见[状态表](README.md)，连续 pointer/scrcpy control未做。 | [lease](../../tests/android-takeover-lease.test.js)、[Service](../../tests/android-takeover-service.test.js)、[HTTP/WS](../../tests/android-takeover-channel.test.js)、[viewer](../../tests/android-takeover-viewer.test.js)；[实现与边界](2026-11-06_android-m4-takeover.md) |
| M4.2 | **传输层已实现并离线验证**：`AdbCommandQueue` 全局容量 64；按 serial FIFO；不同 serial 并行；null key 为全局管理屏障；运行中取消直到 transport settle 才释放 key。它不是高层任务排队。 | `tests/adb-device-scheduling.test.js`、`tests/adb-budget-contract.test.js`；补公开诊断与别名契约 |
| M4.3 | **部分完成**：序列禁止中途覆盖 serial，后续步骤不能复用旧 index/snapshot/frame/坐标，中间步骤必须 expect；仍需 canonical device identity、display/session 维度和跨宿主边界。 | `tests/android-sequence-contract.test.js`、`tests/android-frame-context*.test.js`；新增别名、断线、跨设备和 unknown 矩阵 |

M4 的详细源码、协议和验收研究见[2026-11-05 M4 调研报告](2026-11-05_android-m4-research.md)。

**M4.0 的边界**：Handoff 只提供可信的人类回执，不授予 viewer 写入权限；继续是在同一调用内恢复，仍需根据新界面重新 Observe。历史原生交互验收见状态表，不外推到新 M4.1 接管；Handoff已有unknown状态被取消时，不能洗成安全移交。

**M4.1 的正确顺序**：先统一 serial ownership（Agent、Handoff、viewer、M5 连续执行器共用）；再做显式 takeover start/end、session token、epoch 失效和断开处理；最后接 scrcpy control 或有限事件。scrcpy 控制消息没有通用触控/按键 ACK，socket 写入只能算 dispatched，独立 expect 才能升级 verified；不能因为开启 `control=true` 就绕过现有 lease、预算、取消和风险策略。

**M4.1 首批限制**：接管使用独立新截图凭据而非直播帧；令牌仅当前WS内存有效。开始/结束撤销旧凭据，结束/断开不恢复旧AI。临时全局门同时封其它serial与管理，保守防USB/Wi-Fi别名绕过；跨物理身份/外部主机互斥仍未交付。14秒快照、10分钟会话、100–1500ms有限滑动；沿用风险策略，不授任意文本/剪贴板或副屏输入。

**M4.2 的实现口径**：源码实际是一个全局容量的 `AdbCommandQueue`，不是持久 `Map<serial, SerialQueue>`。传输并行不等于业务任务共享；`step-runtime` 仍对同 serial 第二个高层操作返回 `DEVICE_BUSY`。USB serial、Wi-Fi/IP serial 和 mDNS 名称目前不是同一物理身份，外部 ADB 客户端也不受进程内队列保护。

**M4.3 的验收边界**：序列的 serial/device/deviceSerial 覆盖和未来凭据复用必须在首个写动作前拒绝；每一步重新定位、验证并绑定当前设备。补齐别名 canonicalization、display/session generation、断线重连和 `DEVICE_STATE_UNCERTAIN` 恢复矩阵后，才可宣称跨设备边界闭合。

### M4.5 后台虚拟屏（独立 P0 已启动，生产未接入）

目标是在第二显示上执行 AI 任务，同时不干扰用户显示。scrcpy v5.0.1 的 server 静态源码支持 `new_display`、`start-app`、控制 socket、虚拟屏触控和 `display-ime-policy`，但仓库当前没有把它接入 FrameHub/ScrcpyHub、UI 证据、viewer 或统一回执。Android 10+、具体 ROM 和 App 任务模型仍需实测。

先修正三个旧假设：

- scrcpy 控制协议是可变长度消息；视频帧的 12 字节 header 不能当作 control 通用 header。触控/按键没有通用 ACK，只有剪贴板序列有 `AckClipboard`。
- `screencap -d` 的 SurfaceFlinger display ID 与 window/UI 的 logical `mDisplayId` 不能盲目当作同一命名空间；必须建立映射和 generation。
- `UiAutomation` 可查询 all displays，但带 displayId 的构造路径在 AOSP 源码中是内部/private 形态；当前承运 RPC 的 `dumpWindowHierarchy` 固定三参，第四参是否存在只能由设备探针确认。

**P0 探针（设备在线后执行，任一硬阻塞即停止）**：

| 探针 | 内容 | 通过条件 |
| --- | --- | --- |
| A1 | `dumpsys display`、`dumpsys SurfaceFlinger --display-id`、`dumpsys window displays` | 得到 logical/SF 映射、尺寸和 generation |
| A2 | overlay 副屏截图、`input -d` 点击、物理屏 focus/用户操作 | 截图非黑、点击只落副屏、物理屏焦点不变 |
| A3 | 承运 RPC 第四参和多 root 返回 | 明确支持 display 或明确降级为 vision 坐标；不从 APK 字符串推断 |
| A4 | scrcpy `new_display`，真实连接 video/control socket | 建屏、首帧、起 App、控制和清理均有证据 |
| A5 | 冷/热任务、IME/权限弹窗、建屏循环 20 次 | 记录任务迁移、焦点、弹窗落点；允许数字 ID 改变但 generation 不可混淆、无残留。**2026-11-06 PJZ110 已特征化**：热启动复用 task；singleTask 双向整体迁移（物理→虚拟会被搬走，虚拟→物理会被拉回）；IME 不显示；权限弹窗落在虚拟屏上。见 [A5 结果](../../artifacts/android-m4-a5-r2/RESULT.md) |

**交付序列**：P1 `DisplayTarget` 与按 display 分域的 frame/snapshot/context（2026-11-06 库层完成，默认屏回归 1932/1932，服务未暴露，见[P1 记录](2026-11-06_android-m4-p1-display-target.md)）；P2 双 display 采集和 viewer session；P3 `cmd input -d` 实验性兜底（仅 dispatched）；P4 承运 display RPC 或 scrcpy control（再谈 verified）；P5 人类授权卡、双屏只读镜像和能力声明。默认屏现有行为必须逐字回归。

**硬约束（A5 新增）**：虚拟屏启动 App 前，若该包已有 task 在其他 display 上，必须拒绝或请求人工同意，否则会把用户的界面整个搬走；运行中任务一旦离开目标屏（`wm_task_moved`），立即失去目标并停止写入；虚拟屏上出现的权限弹窗禁止代点，只能交由人工处理；不依赖软键盘输入文本。
**硬约束**：目标 display 与焦点 display 不一致时禁止 `KEYCODE_PASTE`/剪贴板 IME；系统权限弹窗最多 dispatched；`AUTO_WAKE` 不得无条件点亮物理屏；默认关闭后台写入；不以 root/Shizuku 作为隐含依赖。M4.5 不依赖 M3 OCR；它依赖 M2.5 上下文/身份和 M2.6 策略/回执，M3 只在需要 OCR/视觉候选时可选加入。

2026-11-06 更新：独立P0工具/靶场已实现。PJZ110上overlay建屏后启动App被系统拒绝；scrcpy自建屏可启动靶场并解码720×1280实帧，但默认屏mCurrentFocus变为null，隔离判据失败。0虚拟屏输入，已独立验证资源清理与物理屏恢复；A3、A4控制输入、A5矩阵保持NOT_RUN。详见[P0真机报告](2026-11-06_android-m4-p0-report.md)。P1–P5不因出图成功而获准入。

2026-11-06 F1：根因是scrcpy只设`OWN_FOCUS`、未设`STEAL_TOP_FOCUS_DISABLED`（Android 14+）。focus1候选只加这一个flag，PJZ110上冷启动+实帧+1次`input -d`点击时物理屏焦点不变，R2矩阵20/20；首批因物理屏外部变化0/1/19中止，原始记录保留。判据口径修正：生产只把**由虚拟屏动作引起**的物理屏焦点迁移算违规，用户自己操作物理屏属于预期。A3、control输入、IME/PASTE、同App迁移、权限弹窗、跨ROM仍未验证，详见[焦点修复报告](2026-11-06_android-m4-focus-report.md)。

<a id="M5"></a>

### M5 长任务与生态沉淀

**2026-11-07 补齐路线与首批启动**：意图执行 → 可追溯轨迹 → Skill 草稿/复用 → 版本修复的方向保留，但基础恢复必须前移。J1.1 已统一 rules/shadow/jev 的预存结果与完整完成等待，容器和条目共用提交尝试的 5 秒窗口；J0.1 模型标识/usage/拒绝证据、J5.3 共享夹具与 J1.2 有界未派发重决策随后已实现，详见 [续批记录](2026-11-07_jev-evidence-recovery.md)。随后 J1.3 声明加载等待与进度边界、J5.1 结构化升级证据已落地，见 [等待/升级记录](2026-11-07_jev-wait-escalation.md)。此后 J5.2 实际主 Agent/Handoff 升级、J2 语义、J3.1/J3.2a/J3.3a 动作与开关、J4a 双字段路线和 J5.3 统一夹具回放均已完成限定离线验收（档位见 README）；下一步为 J0.2 真实校准协议或其余任务族。正常路径中间主模型调用为零，异常升级单独计数。当前 Jev 限 search-v8 / toggle-v1 / route-v1 三个声明任务族，可恢复明确未派发的内容 stale，连续第三次停止；上下文变化硬停止，`escalate` 仅在任务显式声明 assistance 且通道存在时同任务升级一次，否则停止；本批修复不代表完整自修复。详细证据、取舍和 Gate 统一见 [J 系列](2026-11-07_jev-loop-roadmap.md)，不另设第二份 Jev 详细计划。

**2026-11-06 增量**：`decision=jev` 受限搜索循环已集成并离线验证，支持当前完整树候选生成、Jev候选/wait/escalate选择、多级入口、Fill读回与独立完成验证；不再只记录shadow。搜索词表与唯一同包资源ID仍是边界，暂定概率策略未校准，真实Jev与App联合准入未做。最新数字见[状态表](README.md)，契约及证据见[Jev循环记录](2026-11-06_android-jev-loop-report.md)。以下首批段落保留2026-11-05切片范围。

**首批实现（2026-11-05 夜间）**：M5.1a/b/f 的受限搜索模板已接入宿主，状态与回归只见 [README](README.md)；实现说明见[首批记录](2026-11-05-m5-first-slice.md)。`RunTask` 接受显式设备/单包/default display/同包资源ID/参数query，固定可选进入→Fill读回→提交→独立可见标记；不要求主模型逐步点击，但仍需调用方绑定资源目标。不是本节最终的任意意图探索：没有自动候选生成/泛化流程、Skill编译复用修复或持久恢复。Jev仅影子建议无写授权，模型返回不证明完成。主任务共用现有设备租约与独立子动作作用域，未交付viewer takeover/ownership session或跨别名物理身份；完整M4.1a仍待后续。

| 项 | 交付 | 边界 |
| --- | --- | --- |
| M5.1 | **宿主意图执行与流程 Skill 学习**：主模型一次提交意图，宿主内部连续执行；成功后由 Agent 总结、编译为 Skill，随后直接复用，页面变化时分级适配。实施拆分见下表 | 初次探索使用规则 + Jev；稳定复用优先流程状态机，异常再调用 Jev 或升级。AndroidController 保留原子动作与证据职责 |
| M5.2 | 序列断点：`execution.sequence` 与宿主任务轨迹落盘，可从已确认的断点续跑 | **不自动重放已派发步骤**；启动时重新获取设备/包/上下文证据；在途写或结局未知不得凭第 N 步编号恢复 |
| M5.3 | 跨端动作命名与回执字段对齐（Android ↔ ScreenPilot），提供第三方可消费的轨迹/Skill schema | 保留派发、验证和 unknown 禁重放语义；Android 与 Loom/ScreenPilot 分别校验自己的目标身份，不直接互换句柄 |
| M5.4 | 跨 ROM 矩阵 + 30–60 分钟 soak，以及首次探索、Skill 复用与页面变化任务集 | 分别报告成功率、误操作率、unknown 率、升级率和成本；完整任务分母、失败与未跑项必须保留，历史单 ROM 动作通过不能代替任务验收 |

**M5.1：意图 → Jev 探索 → Agent 总结 Skill → 连续复用 → 页面变化适配**

可行性判断：这条链路可在现有原子能力上增建，适合先交付有完整 UI 树、目标可验证的搜索、导航、表单和采集任务。主模型提供意图和任务参数，无需逐步指定点击对象；宿主把意图编译成受限任务契约，独立运行观察、决策、执行与验证循环。主模型只在任务结束或需要重新规划时介入，成功后再做一次流程总结。业务 API 或既有受控 Intent 有明确契约时优先直达；已知流程优先状态机；树缺失和开放式陌生流程另行接入视觉/更强模型能力，不承诺仅靠 Jev 覆盖任意 App。

首批实现前的基础与缺口（2026-11-05源码核对；最新切片见上）：[text-arbiter.js](../../VCPDistributedServer/Plugin/AndroidController/lib/text-arbiter.js) 已有 target/page/recovery 选择，但只返回 `advisory`，单候选可直接绕过 Jev，阈值明确 `calibrated=false`，输入尚无任务进度；不能直接把建议接成自动点击。[GlobalJevService](../../modules/services/globalJevService.js) 可复用。[action-history.js](../../VCPDistributedServer/Plugin/AndroidController/lib/action-history.js) 仅保留内存脱敏元数据，不含可重建流程的动作参数/selector，`execution.sequence` 也不是完整教学轨迹，需新增宿主轨迹。VCPToolBox 的 `SkillBridge` 目前只索引 `SKILL.md`，不编译或执行流程；[LoomSkillService](../../VCPDistributedServer/Plugin/LoomController/LoomSkillService.js) 已有结构化参数与持久 Skill 机制，可评估复用参数校验和存储思想，但 DOM 目标、超时与互斥语义不能直接用于 Android。

| 子项 | 交付 | 验收判据 |
| --- | --- | --- |
| M5.1a 意图契约与宿主执行器 | 任务含目标包/设备、意图、类型化输入、独立完成谓词、允许动作和总预算；编排层生成绑定当前观察的有限动作候选，Jev 不生成任意工具参数。先补共用完成验证、未派发 stale 重决策和显式升级，再扩候选/任务族，见 J1/J2/J3/J4/J5 | 正常路径一次下发后完成多步任务，中间主模型调用数为0；升级路径另计真实调用。输入不完整、完成谓词不可表达或能力不足时在首个写动作前返回缺口；取消、等待、模型、升级与排干共用预算和所有权 |
| M5.1b 结构化任务轨迹 | 最小证据随执行器同步，记录步骤意图、语义目标/角色/关系、输入引用、动作/expect/结果、观察与身份摘要、候选/选择/恢复因果，以及模型/策略版本和可得usage；完整教学字段另行完善，见 J0.1/J5.3 | 能关联原始回执与独立验证；unknown 不因后续正常页面消失；参数值、密码、凭据和原始聊天不进入持久 Skill。摘要轨迹不能还原完整 UI，回放需单独维护去标识化环境夹具，不能从 actionHistory 臆造 |
| M5.1c Agent 总结与 Skill 编译 | Jev 流程成功后由 Agent 提取有效路径、参数、前后置条件及已观察分支；编译器把总结变成版本化声明式步骤图，同时生成 `SKILL.md` 说明及可执行产物，说明引用同一版本 | 一次成功先产草稿，不推断未见过的分支；所有步骤可追溯到轨迹或显式定义，拒绝任意代码/隐式动作；参数字段结构化替换，缺失参数零输入失败；完成谓词不因总结而被弱化 |
| M5.1d Skill 连续执行 | 以已验证 Skill 作为状态机，普通路径直接调用原子动作/已有1–8步短序列，控制器持有任务进度与验证边界；每次动作重新定位，流程无歧义时零模型调用 | 用不同输入和起始状态独立复跑，逐步与最终条件均验证；8步是单批上限，分批不得丢任务预算、所有权或取消；未知在途动作仍按设备隔离/排干规则停止 |
| M5.1e 已保存 Skill 的页面适配与修复版本 | 区分布局、定位、分支与业务语义变化；复用 M5.1a 已具备的有界重新决策和升级，再生成 Skill 修复候选版本。基础 stale 恢复不等待此项 | 修复目标和前后条件重新校验，受原意图、动作及包范围约束；独立复跑后才启用新版本，保留旧版、不就地覆盖。已发生误操作的补偿是新写动作，须预声明且独立验证；unknown 不补偿重放 |
| M5.1f 固定任务集与推广 | J0.1 先固定任务/变化类型、最小证据和验收协议；J0.2 随每个候选版本划分校准与独立集，再评探索、恢复、升级、复用和适配 | 完整报告成功/误操作/误报完成/unknown/升级/未跑、候选漏选、恢复分母、调用数、p50/p95和可得成本；小样本零失败不等于已校准。新意图有自己的门槛，离线/真实模型/真机/跨ROM/长稳分别验收 |

| J 系列实施项 | M 系列归属 / 接缝 | 顺序约束 |
| --- | --- | --- |
| [J0 协议与校准](2026-11-07_jev-loop-roadmap.md#J0) | M5.1b/f | 协议和最小证据先行；真实校准随版本验收，不阻塞已知逻辑缺陷的离线修复 |
| [J1 完成与观察恢复](2026-11-07_jev-loop-roadmap.md#J1) | M5.1a | 先统一完成谓词/等待，再补未派发 stale；不能把模型/写后超时一起 retry |
| [J5 升级与回放](2026-11-07_jev-loop-roadmap.md#J5) | M5.1a/b；人工依赖 M4.0 | 最小轨迹/夹具同步，升级接缝前移；跨调用恢复归 M5.2，viewer 接管另按 M4.1 移交 |
| [J2 语义与协议](2026-11-07_jev-loop-roadmap.md#J2) | M5.1a/b | 先提供可区分候选；多头协议仅在确有收益时采用，分布乘积不证明联合正确 |
| [J3 动作](2026-11-07_jev-loop-roadmap.md#J3) / [J4 多字段](2026-11-07_jev-loop-roadmap.md#J4) | M5.1a 与对应 M1/M2 原语 | 按同包搜索、新任务族、类型化多字段分别准入，不把已有 RPC 当作组合任务验收 |
| [J6 可选视觉](2026-11-07_jev-loop-roadmap.md#J6) | M3 感知 → M5 候选 | 不阻塞语义树与升级；不假定当前 Jev 支持图片/Box |

**连续执行契约。** 宿主任务所有权与现有 per-serial 租约、RPC 排干/隔离共用一条仲裁边界；禁止只在每次工具调用内加锁、却在模型等待和批次之间允许另一任务改屏。主模型取消/断线必须传到同一任务，异步创建只表示接受任务；预算耗尽后不再派发新动作，在途不确定仍保留隔离。候选由动作白名单和当前控件的角色、可见/启用状态、原始结构关系及任务允许输入产生，含动作类型、目标与可检查后置条件；输入内容来自任务参数/业务规则。一个候选也要证明与当前步骤意图相关，候选不足、观察截断或上下文不可信不能当作已找到唯一目标。Jev 的页面/完成分类只是路由建议，动作和业务完成仍由独立谓词证明；概率阈值须以任务数据准入，不能沿用当前未校准阈值声称自动执行可靠。

**Skill 的保存与启用。** Agent 可自动总结并保存草稿；可执行步骤图是运行依据，`SKILL.md` 用于发现、说明和异常升级，不能每次都把整份文档再交主模型解释。Skill 保存原始 text/desc/显式any的来源、语义目标与参数引用，不保存过期 index/snapshotId/frameId 或把绝对坐标作为持久目标。独立复跑通过才标记为该包/版本/任务范围可复用；已验证普通路径可自动启用，不要求用户逐次确认保存。敏感写的批准仍按每次实时状态判断，历史批准和 Skill 版本不能带入下一次任务。人工交还后的可验证续跑可进入候选流程，但人工代做步骤不能被伪造为自动能力。

**页面变化分级。** 坐标移动但语义 selector 和前后条件成立时直接重定位，无需模型；文字/结构改变时先重观察，在同一步意图与上下文中生成新候选，由 Jev 选择，再实时验证唯一身份后派发。未知弹窗、路径分支或前置条件变化可转入 M5.1a 的有界探索，并只从独立确认的状态衔接未执行部分；需要修改业务目标、完成谓词、动作权限或无法区分已派发效果时返回主模型/人工。屏幕文本始终是证据，不能成为新增任务或放宽授权的指令。修复不得把未校验长序列盲发出去，也不能重放结局未知的写。

上述为目标行为，当前 J1.2 已实现有可信未派发证明的内容 stale 重决策；上下文/epoch 变化仍停止。任何缩小派发检查范围或完成等待范围的方案，都需 [区域证据](2026-11-06_m5-context-diff-report.md) 支持并另立策略/批次。J5 的同调用升级沿用租约/截止；M4.1 viewer 接管会取消原任务，不能当作暂停后自然恢复。

**例子（规划用任务，非已交付接口）：** 首次“在指定App搜索本次关键词并读取前十条结果”，宿主依次定位搜索入口、填写参数、提交、验证结果页并采集；任务有证据完成后，Agent 提炼带关键词参数、搜索框/结果列表语义定位和结果完成谓词的 Skill。下次同类任务直接运行；入口仅换位置无需 Jev，文案改变则局部候选重定位，改为新的搜索流程则进入有界探索，验证后的修复保存新版本。结果不足十条而又无可证明的列表结束时返回部分结果，不把“队列执行完”当成任务成功。

## 3. 依赖与顺序

```text
M0 → M1
M1 → M1.5、M2（并行：一个补动作语汇，一个补寻址表达力）
M2 含 M2.1 / M2.2 / M2.3（其中 M2.3 的完整布局证据被 M2.5.3/M2.5.4 复用）
M2实现与验收收口 → M2.5（含owner生命周期）
M2.5字段/上下文 → M2.6.1/2安全门
M2.5、M2.6安全门 → M3（typed intent/Collect不是硬前置）
M2.5/M2.6证据与策略准入 + M1/M2所用动作准入 → M5.1a语义树执行器；M5.1b最小轨迹同步
J0.1协议/证据 → J1完成契约/未派发恢复 → J5升级接缝 → J2语义 → J3/J4任务扩展
每个候选版本 → M5.1f/J0.2校准与独立验收；已通过范围 + M5.1b教学轨迹 → M5.1c草稿 → M5.1d复用 → M5.1e版本适配
M5.1b轨迹 + 所有权/剩余步骤/副作用证明 → M5.2持久恢复；taskId不等于恢复许可
M3视觉能力 → M5所需OCR/视觉候选；M4.0可信人类回执 → M5所需人工交还
M4 → M4.5（虚拟屏独立评估，不阻塞 M5）；P0 探针事实 → 才排 P1–P5
宿主可信人类回执通道 → M4.0；M4.1需接管产品决定
M4.2设备队列已实现，M4.3只补跨设备凭据/序列边界
```

写成逐条边而不是方框线，是因为中文字符宽度不可控，`─` 与 `▶` 在不同字体下占位不同，方框图必然错位。

- M1.5 与 M2 可并行（一个补动作语汇、一个补寻址表达力），两者都不依赖 M3 的 OCR 决策。
- **M2.5 与 M2.6 都必须是 M3 的硬前置，不是并行于 M3 的可选项**。M3 的 OCR 锚点、模板匹配的归一化、以及「语义树优先、OCR 只填空」的既有约定，全都建立在「字段来源可信 + 上下文可信」之上（M2.5）；而 M3 同时把**可点击面积扩大**——在闸门（M2.6.1/M2.6.2）之前做 M3，等于先放大可点击范围再补「哪些不该点」的名单，中间那段窗口期是纯风险。
- M2.5/M2.6共享Service、图数据与工具表，不能按阶段名并行写同一边界；先冻结分源/上下文/策略契约，再按函数与测试责任拆批。
- M2.5.2（载体身份）与 G7/G9 的接线互不阻塞：前者改推送判定，后者改签名表放行，但两者共用同一个 `UiServer` generation 生命周期，改动要错开批次，避免把「能力结论作废」和「新方法首派」混进同一轮验收。
- 多指 / 拖拽 / 路径 / `scrollTo` / `waitForIdle` 都是**宿主侧接线**（§0.2），与 M4.1 的 control socket 不再冲突。
- **M4.0不依赖OCR/control，但依赖宿主可信回执**；handoff是人工交还，不是逐次写批准协议，不能拿它给M2.6自动放行。
- M4.1 独立于其他项，取决于是否接受「人类接管」这个产品决定。
- **M4.5 不是 M4.1 的技术前置，也不是它的替代**：M4.1 解决「人怎么接管」，M4.5 解决「AI 在用户看不见的屏上干活」。两者都要改产品口径，但 M4.5 额外要求 P0 五条探针的事实，且 `DISPLAY_FOCUS_MISMATCH` 的 PASTE 禁令必须**先于**任何注入实现落地——否则第一批虚拟屏动作就是事故。
- **M5.1 可先做语义树版本**，前置是所用动作、M2.5上下文/身份和M2.6策略的相应准入，不必等待 M3 OCR、M4.1 接管或 M4.5 虚拟屏。只有使用这些通道时才依赖对应阶段；没有人类通道就停止返回，不能假装 Handoff 成功。M5.2 持久恢复与 M5.1c Skill 学习分别立契约；M5.3公共schema先定最小字段，不为复用先造跨端通用框架。

## 4. 明确不做

| 项 | 理由 |
| --- | --- |
| AndroidController 插件内自主规划 / 多步任务记忆 | 宿主任务编排器负责连续执行、轨迹和 Skill；插件只提供原子动作与证据，避免和 VCPChat 会话历史打架 |
| 通用 deep link、任意 intent / shell | 现安全边界（`LaunchApp` 只允许 http/https VIEW）是刻意设计，不为功能让步 |
| 照搬 Appium `mobile:` 的系统动作面（旋转 / 定位 / 权限 / 网络 / 通知栏） | `System` 白名单是刻意收窄的授权面；动作语汇补齐（M1.5）不该顺手把系统改动面一并放开 |
| 手机文件管理器 | `FileOperator` 已在宿主侧；Android 侧只需补 `push/pull` 原语 |
| root / Magisk 通道 | 一旦引入，全部设备兼容性判断失效 |
| 全屏 OCR 常态化 | token 成本与延迟都不划算；只在画布主导或显式请求时开 |
| 把 `VCPMobileSync` 并入控制链 | 那是用户侧 App 同步，与 Agent 操作是两条独立链路 |
| XPath 定位 | 类型化结构关系（child / descendant / sibling / hasDescendant，见 §0.4 G6）能覆盖 Agent 场景的绝大多数需求；XPath 在 Appium 侧是唯一非原生路径，官方自述明显更慢，且它会诱使匹配语义滑向「任意表达式」 |
| 把注入保真度再提一档（sendevent / UHID） | 现在走 RPC→instrumentation，与 Appium 同档。再往上要 deviceId≠0 的新输入设备，代价是 root 或系统签名，与「不引入 root」直接冲突。保真度不是 Agent 场景的瓶颈，可验证性才是 |
| judge-model 式步骤验证 | AndroidLab 用 LLM 判子目标。本插件的 `verified` 必须是可独立复算的谓词（同一份布局证据能重跑出同一结论），不接受模型裁决，否则「证明」退化成「投票」 |
| 把 DSH-Go 的同机闭环搬进来 | 它把引擎与 MCP server 放同一台手机，因此没有 adb 边界——那是它的形态，不是本插件能迁的目标。`VCPChat` 的定位是宿主侧 Agent 操作设备 |

> 2026-11-05：「VirtualDisplay后台屏（暂缓）」已移出本表，单列为 §2 的 M4.5。移出的理由不是 display 凭据、输入所有权、生命周期与 ROM 兼容那几项复杂度消失了——它们一条没少——而是「暂缓」被读成「不做」，它因此长期既没有编号也没有人跟进。`root / Magisk 通道` 那行的否决不变：M4.5 走 ADB shell + `app_process`，不引 root。

## 5. 每阶段的停止条件

避免「越做越像 Appium」：

- M1：若目标 ROM 上 `setText` 不可靠，Fill 标 `experimental` 或暂停，不用 shell 全选/删除模拟替换。触摸动作仅在 RPC 明确未执行时允许 shell 回退；超时或未知结果不重放。
- M1.5：若双击窗口在目标 ROM 上不稳定（两次 `click` 落不进系统的双击判定），就把它标 `experimental` 并说明「模型应两次 `Tap` + 自行裁决」，**不要改用两次 shell `input tap` 连发**——两个 adb 进程的间隔本来就更长，只会更不稳，且丢掉了 rpc 通道的状态回执。`ScrollUntil` 若真机抽样证明目标多数不在同一滚动容器内（换页而非滚动），砍掉循环、只留单次 `Scroll`，不要为了「像 Maestro」硬撑。
- M2：若固定靶场证明某条动作在目标 ROM 上只能靠宿主循环逼近（`ScrollUntil` 换页而非滚动、`idle` 靠布局双采样兜底仍耗尽），就砍到该动作的单次原语，**不要为了「像 Maestro / 像 Appium」堆循环预算**。`ScrollUntil` 的可见性契约未定之前（主机认正面积相交、靶场要求 ≥32dp），**不许引入任意阈值去迁就靶场，也不许降低靶场断言追绿**——先定义「可见」是面积比例、中心区还是无进展，再改算法；拿不到独立完整几何时，宁可让该 case 保持红灯。`idle` 的 `layout_stable` 只保证采样布局相同，任何「像素静止」「业务完成」的推断都不许写进停止条件之外的成功路径。
- M2.5：插件未发布，分源直接切新契约，text只匹配原始text、desc只匹配content-desc、聚合显式any；同步字符串/对象/within/自动selector/expect/sequence/文档测试，不留旧义兼容。SHA不可读显式unknown且不作为已绑定准入证据，不拿versionCode后备；已知不符复核仍不符拒绝。
- M2.6：若 `⚠` 预标记在真机抽样上误报过多（把聊天内容当控件），**只收紧判据不关掉闸门**——缩小短标签启发范围或改为只认view-id，但预标记与派发仍须同源；已判敏感而无可信批准的写继续拒绝，绝不通过关闭闸门追求低误报，也不让denyPackages跟着失效。若 M2.6.5 的八类 intent 里某类在目标 ROM 上解析不到唯一组件（如 `navigate` 无高德无百度），该类单独标 `experimental` 并在能力探针里置否，**不引入兜底去猜其它地图包**。若 M2.6.3 的字符预算导致模型定位错误上升（对比同一批任务的成功率），退回 `DEFAULT_TEXT_LENGTH=120` 但**保留短 id 与坐标的按需化**——这两项省的是纯冗余，不会减少可用信息。
- M3：若 OCR 对语义树已有文字的命中率提升不足（真机抽样），砍掉 M3.4 自动附加，只保留显式 `ClickText`。
- M4.0：若暂停态与既有执行序列的取消语义冲突（暂停被实现成「取消后重排」），宁可不做 `handoff` 也不要把「继续」做成新任务——那会让 `unknown` 禁重放这条契约失效。
- M4：若接管状态机无法在不破坏回执契约的前提下实现，宁可不做控制通道——只读显示屏不是缺陷，是当前定位。
- M4.5：A2 三判据任一不成立（截图黑图、点击落到物理屏、物理屏 `mCurrentFocus` 被改），整阶段**立即降级为「只读双屏镜像 + 不注入」**，不做任何注入实现，也不拿「反正用户看不见」说服自己。若 A3 证明承运没有 display 维，感知走独立 `UiAutomation(displayId)`；再不通就 `perception=vision` 如实播报，**不许用 scrcpy control 绕过去补**——那会绕过凭据、预算与 `dispatchInput` 的排干语义。P3 的 `input -d` 永久封顶 `dispatched`，不因为跑通就升格 `verified`。
- M5：策略/设备/身份/上下文不可信、未知写、取消、总截止及预算/循环上限是硬停止；未知传输保留隔离排干。J1规划只允许明确未派发 stale 在原预算内重决策，有证据的加载只读等待；模型超时、写后验证失败不混入 retry。缺候选、低置信度或无法证明进展时按J5显式升级，通道缺失则停止。Skill缺参数/前置/独立完成谓词时拒绝；修复未独立复跑保留草稿与旧版。误派发、误报完成或重复写阻止该候选版本推广，完整判据见[J系列](2026-11-07_jev-loop-roadmap.md)。

## 6. 后续工作（基础项为2026-11-05复核，M5于2026-11-07更新）

1. **M1.5 当前回归与推广边界**：历史14项通过不覆盖本次代码；新回归发现主机滚动正面积可见与靶场至少32dp标准不一致，须单独定义可见性契约（2026-11-05 已由 `scroll-axis-interior` 契约收口并通过 14/14，不再列为保留失败，见[状态表](README.md)）；后续若推广到其它ROM/分辨率、选区/Unicode/空字段删除、其它键码meta、Pinch极值或横向滚动，应另按明确矩阵独立准入。M1既有6/6不复用新增证据，本机14项也不外推所有参数。unknown不直接重放，不拿shell补动作或放宽时序/读回标准；未覆盖形状继续experimental。
2. **IME 租约（技能型优化，非阻塞）**：现在 `ADB_KEYBOARD_NOT_ACTIVE` 把「用户没手工装/没手工切输入法」当成能力缺失。若真要做成能力而非环境要求，就实现 `ime enable` → 记录 `settings get secure default_input_method` → `ime set` → 广播 base64 → 还原。风险开关进 `plugin-manifest.json` 的 `configSchema` 与 `modules/settings/schema/android-system.js`（与 M4 接管同一张人类授权面），默认关。
3. **M2.5.5实现后续**：分层摘要纯模块及Observe接入已实现；后续迁移历史性能采集/基线并补齐ROM/workload，不以同一code hash合并不可比性能条件或推导设备授权。
4. **M2 按 §2 最新契约实施**：完整宿主匹配、一层祖先锚点、元素图像与有界idle；设备 Selector 下推与真实遮挡检测不混进本轮承诺。
5. **owner与设备推广边界**：启动文件、分源、上下文/布局stable与owner已集成；完整离线回归与 M2/owner 真机结论见 [README](README.md) 状态表。真实网络故障注入、跨ROM与长稳仍独立验收。Manage recoverOwner仅凭独立消失证明解隔离，不重放；历史idle失败当轮根因仍未确定。G1真实元素身份暂缓，不拿XML结构hash冒充sourceNodeId+windowId。
6. **M2.6代码与准入分开**：统一读写门/风险同源/呈现/stale附屏已落代码，最终全回归待补录；宿主逐次批准与有界Collect已落代码并完成离线验证，缺可信服务仍拒绝。呈现收益需独立任务数据；Intent、全窗口输入和B App后端暂缓，不借收口扩大授权。
7. **M4.0（handoff）可以随时插入，不必等接管决定**：它只要暂停态与人的回执，不碰 `control=true`。现已提供原调用内人工交还；不含viewer控制通道或持久化任务恢复。
8. **A/B/C路线复核**：当前继续ADB+app_process(A)，不启动安装helper直连(B)或自维护shell后端(C)；明确窗口/事件/owner协议缺口才评估小范围C。随包DEX已确认rootInActive=false遍历窗口根、API30+全display枚举及内部event listener，当前host默认true且未建window envelope，不把这些底层能力误归B独占。B的理由应是无需开发者调试与用户安装启停/直连体验；普通App不继承shell权限，需新后端/认证/生命周期/能力协商，非只换Transport。61ms不能否定事件价值，敏感数据空壳也不构成确定归因；完整hash/分支证据与官方边界见[路线复核](android-controller-route-review-2026-11.md)。
9. **M4.5 虚拟屏（2026-11-06 P0首轮未通过；同日F1焦点修复单机20/20，见[报告](2026-11-06_android-m4-focus-report.md)）**：独立探针/靶场及真机建屏出图已完成，默认屏焦点保持未通过，尚无生产准入。P1之前不改`parseFreshScreenProbe`的单display硬判；本轮没有输入、IME或20次生命周期验证。后续新启动/焦点方案须保留既有失败重新验证，不能通过删除隔离判据晋级。
10. **M5.1/J 系列补齐**：J1.1 已实现共用预存完成判据与有界完整谓词等待，J0.1 已补完成策略身份和离线夹具，见[首批记录](2026-11-07_jev-j1-completion.md)。同日续批已补最小模型证据、共享夹具和可信未派发 stale 重决策，见[续批记录](2026-11-07_jev-evidence-recovery.md)。随后显式主Agent/Handoff升级、语义、操作、开关、双字段路线与统一夹具回放均已离线落地，下一批按[J路线图](2026-11-07_jev-loop-roadmap.md)冻结真实校准协议或扩展其余任务族。各版本分别校准和独立验收；已通过范围才进入Skill草稿/复用/版本修复。复用GlobalJevService与原子动作/策略/租约/排干链；不新增设备RPC查询，不以脱敏摘要冒充完整回放，不因已有动作原语放开任意导航。跨调用恢复、真实校准与其余扩展仍为规划，实施档位以README为准。

### 6.1 通用闸门：device conformance

M1 的四个真机缺陷全是「隔离回归全绿、真机才发现」。现在已经有了两道闸门（`lib/rpc-methods.js` 的参数形状表 + 只读能力探针），但它们只管「形状」与「单条通道的死活」，管不了「这条通道在这台设备上到底干了什么」。

建议把 `scripts/verify-android-m1.cjs` 升格为**准入门槛**：新通道先进 conformance（参数形状校验 + 语义等价检查 + 副作用前后快照），没过的一律 `experimental`、不进默认降级链。M2 的 selector、M3 的 OCR/模板通道会踩同一个坑，这道闸门是唯一能拦住它的东西。

§0.4 的 G13 把这件事补全成两半：conformance 记录必须同时含**随包 APK hash** 与**设备端实收 hash**（M2.5.2），两者不等即视为未准入，而不是等真机动作才发现跑的是旧载体。G4 的教训正是「隔离回归全绿 + 真机动作全绿，但设备上那份 APK 不是你以为的那份」——旧载体不会报错，它只会以旧行为正常返回。

### 6.2 不要做

- **不要重打包 / 替换 u2 APK 的剪贴板实现**：那是在维护一个随 Android 版本崩的反射分支。`KEYCODE_PASTE` 已经把绕开它的路走通了。
- **不要用 `service call clipboard` 或 root**：§4 已定，不动。
- **不要恢复 `setText` 的非 ASCII 本地拒绝**：§1 M1 真机已证明根因是缺 UTF-8 charset，修复后中文原样读回；保留正确请求头与 Unicode 回归，不把已修缺陷固化成永久限制。
- **不要因上游产物换JAR或移除atx-agent就迁形态**：现有与上游均可走app_process，文件扩展名不是权限或生命周期差异。迁移须有可复现的协议、owner、窗口证据或维护缺口；能否绑定文件hash不是唯一理由，也不是运行owner证明。见[A/B/C复核](android-controller-route-review-2026-11.md)。
- **不要把 Appium 的 `waitForIdleTimeout` 默认值搬过来**：它默认 10000ms，官方 troubleshooting 自己承认遇持续动画会显著变慢。本插件的 idle 是「一次短原生 hint + 有界布局双采样」，性质不同，不要用一个更大的超时去换「更稳」的错觉。
