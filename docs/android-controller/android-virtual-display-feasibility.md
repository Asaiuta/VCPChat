# 后台虚拟屏：能不能在现有 AndroidController 上做「不接管前台的 AI 操作」

调研对象：`VCPDistributedServer/Plugin/AndroidController`（HEAD `b4e34df0`，2026-11-04）。
调研时间：2026-11-04。设备当次不在线（`adb devices` 为空），所以本文把「代码事实」与「需真机闭合的探针」严格分开：前者给行号，后者给命令与判据，不冒充已验证。

---

## 0. 结论

**原理上可行，但不是开关，是补三层：显示、感知、注入。**

| 层 | 现状 | 后台虚拟屏要求 | 结论 |
| --- | --- | --- | --- |
| 显示 | 只有一个默认显示器（display 0） | 另起一个虚拟显示，App 跑在上面 | 随包 scrcpy 5.0.1 已实现，不用自研 |
| 采集 | scrcpy H.264 / `screencap` 均无 display 参数 | 按 display 采集 | 参数化即可，成本低 |
| 注入 | u2 RPC 手势 + `input` 兜底，都去打默认显示器 | 事件带 displayId | 需新增通道（承运 RPC 参数 / scrcpy control / `input -d`） |
| 感知 | `dumpWindowHierarchy(..., rootInActive=true)`，读「全局活动窗口」 | 读指定 display 的窗口树 | **唯一的硬约束**：承运 APK 的 RPC 面没有 display 参数 |
| 证据链 | 写死单显示器（见 §1.4） | 凭据按 display 分域 | 不改会 fail-closed 或给出跨屏错误坐标 |

**产品口径要提前钉死**：「不接管前台」有两层意思，技术上只有第一层成立。

1. 用户那块屏不被 AI 的动作打断 —— 可以做到：注入事件带 displayId 只落在虚拟屏。
2. AI 不把用户正在用的 App 任务搬走 —— **多数情况下做不到**。`am start --display` 命中的是任务栈，对 `singleTask`/同 affinity 的已有任务，系统会把任务迁到目标显示，用户那屏上的 App 就消失了。这不是代码缺陷，是 Android 的任务模型。

所以真实可交付的范围是：**跨 App 的后台操作（消息、签到、抓取、批量填写）成立；同一个 App「用户前台 + AI 后台并行」不成立**，除非该 App 支持多任务栈（`documentLaunchMode`/`FLAG_ACTIVITY_MULTIPLE_TASK` 且自身不假设默认显示器）。这一点必须写进能力声明，否则就是典型的能力越界。

---

## 1. 现状测绘（代码事实）

### 1.1 采集：一条 H.264 主路 + 一条 JPEG 兜底，都只认 display 0

- `lib/scrcpy-hub.js:296-305`：server 启动参数固定为
  `scid=… max_size=… video_bit_rate=… max_fps=… tunnel_forward=true audio=false control=false cleanup=false`。
  没有 `display_id=`，也没有 `new_display=`；`control=false` 意味着宿主根本没有 control socket，注入全部走 u2。
- `lib/frame-hub.js:199` / `:295`：兜底帧走 `exec-out screencap` / `screencap -p`，同样不带 `-d`。
- `lib/stream-server.js`：WS 只推一帧流，没有「哪块屏」的概念；viewer 也只有一个 canvas。

### 1.2 感知：语义树的入口没有 display 维度

- `lib/ui-server.js:300-323`：`dump()` 固定调用 `dumpWindowHierarchy(compressed, maxDepth, rootInActive)`，三个参数，没有 displayId。
- 三个调用点全部 `rootInActive: true`：`AndroidControllerService.js:506`、`:603`、`:2317`。
- CLI 兜底 `uiautomator dump --compressed /dev/tty`（`AndroidControllerService.js:604`、`:530` 附近）——`uiautomator dump` 本身没有 display 参数，永远只 dump 活动窗口。

### 1.3 注入：全部打到默认显示器

- `tap()`（`AndroidControllerService.js:1396-1399`）：首选 RPC `click(x,y[,ms])`，兜底 `shell input tap x y`。
- `lib/rpc-methods.js:15-41`：签名表白名单里 `click`/`swipe`/`setText`/`getText` 全是 `(x,y)` 形状，**没有任何方法接受 display 参数**；`validate()` 会按 arity 在本地拒绝第四个参数，不会发到设备上赌。
- 文本输入的非 ASCII 走 `setClipboard` + `KEYCODE_PASTE`（`configSchema.CLIPBOARD_PASTE`，manifest 描述 `keyevent` 为默认）——**这条路径跟随输入焦点所在的显示**，见 §3.2，是后台虚拟屏下最容易出事故的一处。

### 1.4 证据链：四处写死「单显示器」，其中最要命的是 fail-closed

| 位置 | 代码 | 多显示器下的行为 |
| --- | --- | --- |
| `lib/adb.js:387-437` `parseFreshScreenProbe` | 要求 `dumpsys window displays` 里**恰好一条** `Display: mDisplayId=0` 段，且 `cur=WxH` 唯一 | 多出第二段 → 整条证据 `null` |
| `AndroidControllerService.js:786` `frameContext` | `probe.displayId !== 0` 直接判 null | 虚拟屏的像素动作永远拿不到 frameId |
| `AndroidControllerService.js:773` | 坐标上下界用 `client.screenSize()`（`wm size`，默认屏） | 语义点在虚拟屏上会被按错误尺寸校验 |
| `lib/adb.js:325-330` / `wm size` 缓存 | 按 serial 缓存，不区分显示 | 换屏/换分辨率仍用旧几何 |

结果是：**加了第二块屏，现有像素动作路径会直接拒绝服务**（返回 `STALE_FRAME`/context 不可确认）。这是「坏得诚实」，不是给出假坐标——但它意味着不改造就完全不能用，而不是「勉强能用」。

### 1.5 已有的正确基础设施（不要重写）

- 设备串行租约、整步预算、取消：`lib/step-runtime.js` + `dispatchInput`。
- RPC 隔离与 `dispatched/drained/verified/unknown` 语义：`lib/ui-server.js:374-440`。
- 能力白名单 + 形状校验：`lib/rpc-methods.js`。
- 回执契约与动作历史：`action-history.js`。
- 显示服务生命周期（scrcpy 掉线重启、静态画面判定、H.264→JPEG 降级）：`lib/stream-server.js:200-400`。

后台虚拟屏应当复用以上全部，**只新增 display 维度**，不新建一套通道语义。

---

## 2. 技术底座：外部可核对的事实

### 2.1 随包 scrcpy 5.0.1 已经会建虚拟屏，也会往虚拟屏注入

从 `vendor/scrcpy-server-v5.0.1` 里 `classes.dex` 取字符串（本次实测，非据文档推测）：

- 参数键：`new_display`、`display_id`、`display_ime_policy`、`list_displays`、`flex_display`、`vd_destroy_content`、`vd_system_decorations`、`keep_active`、`power_on`。
- 两条建屏路径各带失败文案：`Display: using DisplayManager API` / `Display: using SurfaceControl API`、`Could not create display using DisplayManager`、`Could not initialize DisplayControl`。
- 虚拟屏标志常量：`VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY`、`PUBLIC`、`SUPPORTS_TOUCH`、`TRUSTED`、`OWN_FOCUS`、`OWN_DISPLAY_GROUP`、`DESTROY_CONTENT_ON_REMOVAL`、`ALWAYS_UNLOCKED`、`ROTATES_WITH_CONTENT`。
- 注入侧：`setDisplayId`、`EVENT_FLAG_DISPLAY_CHANGED`、`Cannot associate a display id to the input event`、`Controller$DisplayData`。
- 起 App：控制消息 `TYPE_START_APP`，以及 `No known display id to start app ` 的报错文案。
- 版本门槛：`New virtual display is not supported before Android 10`。

也就是说：「建虚拟屏 + 在上面起 App + 把触摸/按键事件绑定到该 display」这一整层，**随包二进制里已经实现好了**，缺的是宿主只用了其中一小块（只取视频，且不开 control）。

### 2.2 AOSP：显示维度在框架层是原生概念

| 能力 | 出处 | 关键事实 |
| --- | --- | --- |
| 按显示截图 | [`cmds/screencap/screencap.cpp`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/cmds/screencap/screencap.cpp) | `-d display-id`，`-a` 抓全部活动显示 |
| 按显示注入 | [`InputShellCommand.java`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/input/InputShellCommand.java) | `input [-d DISPLAY_ID] <command>`；`cmd input` 已经是 `input` 的实现 |
| 按显示取窗 | [`UiAutomation.java`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/UiAutomation.java) | 构造带 `displayId`，`getWindows()` 实际是 `getWindowsOnDisplay(connectionId, mDisplayId)`；另有 `getWindowsOnAllDisplays()` |
| 活动窗口是全局的 | [`AccessibilityService.java`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/accessibilityservice/AccessibilityService.java) | `getRootInActiveWindow()` 的文档明说「It could be from any logical display」 |

最后一条解释了为什么当前 `rootInActive=true` 在多显示下必然读到**用户那屏**：它拿的是全局活动窗口，不是「我要操作的那块屏」。感知改造的落点就在这里。

### 2.3 承运 APK：有 display 原语，但没有建屏能力，RPC 面是否有 display 参数未知

`vendor/u2-server-0.5.0.apk`（`com.github.uiautomator2` + `com.wetest.uicore`）dex 里：

- 有 `DisplayManager` / `IDisplayManager` / `SurfaceControl` 反射包装、`getDisplayIds` / `getDisplayById` / `getDisplayInfo`。
- 有 `getWindowsOnAllDisplays`（2 处）、`setDisplayId`（5 处）、`matchesDisplayId`，以及文案 `requested, but can't inject MotionEvent to display `、`Cannot click. Point (%d, %d) is outside display (%d, %d).`、`DISPLAY_ID='`、`display-id`。
- **没有** `VirtualDisplay` / `createVirtualDisplay` 符号 → 建屏不归它管，与 §2.1 分工清楚。

因此存在一条「承运 RPC 已经能按 display 取窗/注入，只是没暴露出来」的可能，但**字符串证据不足以定罪**：`dumpWindowHierarchy` 的 arity 是 3（`compressed,maxDepth,rootInActive`），宿主侧调用也按 3 参写死。这一点必须靠 §4 的探针 A3 用 `-32602` 反推 arity 来闭合，不能靠猜。

---

## 3. 三条路线

### A. scrcpy `new_display` + control 通道（推荐主线）

- 建屏与起 App：server 参数 `new_display=WxH/dpi`（可选 `display_ime_policy`），App 用 `am start --display <id>` 或 control 消息 `START_APP`。
- 采集：现成，仓库里已经有 H.264 解析、重连、降级。
- 注入：两选一 —— 实现 scrcpy control 协议（触控/按键/滚轮消息，display 由该 server 会话隐式绑定），或继续用 u2 但要它能带 display。
- 代价：control 协议要自己写（约 200–300 行，消息头 12 字节 + 类型体），并且要接进现有租约/预算，不能另开一条绕过 `dispatchInput` 的路。
- 收益：不需要 root，不需要装 App，不需要用户开无障碍；全部走 shell uid，和现在同一套信任模型。

### B. `settings put global overlay_display_devices` + `am start --display` + `input -d`

- 零新组件、当天可验证：系统开发者选项的「模拟副屏」，display id 通常从 2 起。
- 采集 `screencap -d`，注入 `cmd input -d`，起 App `am start --display`。
- 代价：`input` 是「无 ACK 的 shell 派发」，比 RPC 慢一个数量级，且 `dispatched` 之后无法验证（与现有 `unknown` 语义勉强兼容，但会显著拉低动作质量）；`overlay_display_devices` 是全局开发设置，退出/重启后行为需实测，部分 OEM 直接不认。
- 定位：**只作为 P0 探针**，用来在 30 分钟内确认「注入到非默认屏是否真的不打扰用户那屏」，不作为产品路径。

### C. root / Magisk / 容器（云手机、VirtualApp）

能做「整机克隆」，但引入 root 依赖、与现有「adb 免 root」定位冲突，且授权面完全不同。本轮不评估、不推荐。

| 维度 | A scrcpy | B overlay | C root |
| --- | --- | --- | --- |
| 需要 root | 否 | 否 | 是 |
| 采集质量 | H.264 10+ fps | `screencap` ~1 fps | 视方案 |
| 注入质量 | 原生 MotionEvent，带 ACK 语义 | shell 派发，无 ACK | 原生 |
| 感知 | 取决于 u2 是否可带 display | 同左 | 可自建 |
| 用户可见性 | 可只读镜像到 viewer | 同左 | 同左 |
| 工程成本 | 中（control 协议 + 证据链） | 低（仅探针） | 高 |

---

## 4. 会咬人的点（按「会不会给出假答案」排序）

### 4.1 任务被搬走 = 直接违反产品前提

`am start --display N` 对已有任务的 App，行为是「把任务迁到 N」，用户那屏的 App 会消失/白屏。必须实测三类：冷启动、已在前台、已有后台任务。若确认会搬，产品上只能限定「允许后台化的 App 白名单」，而不是宣称通用。

### 4.2 `KEYCODE_PASTE` 跟着焦点走 —— 会把 AI 的文本粘到用户正在用的输入框

`CLIPBOARD_PASTE=keyevent` 是当前默认（manifest 描述里 `keyevent` 为默认，`rpc` 在 ColorOS/Android 17 上确定性 `AssertionError`）。物理屏有焦点时，PASTE 落在**物理屏的焦点窗口**。在虚拟屏场景下这是隐私事故，不是精度问题。规则必须写死：**目标 display ≠ 焦点 display 时，禁止 KEYCODE_PASTE / IME 路径，只允许 `setText`（无障碍 ACTION_SET_TEXT，与显示无关）或明确失败**。同理，`ImeAction`/`EraseText` 里的按键语义也要重新审。

### 4.3 系统弹窗与权限框落在哪块屏

运行时权限、安装确认、`SYSTEM_ALERT` 类窗口按「发起方 display」还是「默认 display」显示，OEM 差异很大。AI 在虚拟屏触发授权框，用户可能在物理屏看不到（或反过来）。这属于「用户必须能看到并批准」的流程，需在能力声明里降级为 `dispatched`，不得 `verified`。

### 4.4 息屏 / 锁屏下的虚拟屏

`power_on`、`keep_active`、`stay_awake` 三个参数各自的语义要实测：设备 dozing 时虚拟屏上的 Activity 是否被 pause、`FLAG_SECURE` 是否黑屏。当前 `AUTO_WAKE` 会点亮物理屏——后台虚拟屏的产品前提恰恰是「不点亮、不打扰」，这条策略必须能按 display 分开。

### 4.5 成本

第二块 1080p 显示 + 硬件编码，持续推流约等于多跑一路游戏渲染。`SCRCPY_MAX_SIZE=540` 的现状是省出来的；虚拟屏建议默认更低（例如 720×1280 / 260dpi），并复用现有的静止帧判定避免无谓编码。

### 4.6 授权面

「后台虚拟屏」= AI 可以在用户看不见的屏幕上动手机。这必须是一张人类可见的授权卡（沿用 `modules/settings/schema/android-system.js` 的成对风险确认），默认关；打开时在 viewer 里同时给两块屏的只读镜像，让「后台」不等于「黑箱」。

---

## 5. 改造设计（最小切面）

原则：**display 只是新增维度，不新建第二套语义**。所有新通道仍产出 `observed/dispatched/verified/unknown/failed`。

### 5.1 证据链：`DisplayTarget`

```js
// lib/display-target.js（新增，纯数据 + 解析，不做 IO）
// { displayId, size:{width,height}, rotation, focus:{package,component,window}, isDefault }
```

- `adb.js`：`probeScreen` 从「恰好一条 Display 段」改为「按 displayId 取段」，`parseFreshScreenProbe(text, { displayId })`；找不到该段返回 null（保持 fail-closed），不再因为「多了一段」而整体 null。
- `screenSize(serial, { displayId })`：默认屏仍走 `wm size`（缓存键加 `displayId`），虚拟屏走 `dumpsys display` 里该 display 的 `cur=` 或 `wm size --display`（若该 ROM 支持）。
- `frameContext()`：`displayId` 不再硬判 0，改为「与凭据声明的 displayId 相等」；`lastVision` / `lastObserve` 的 key 从 `serial` 变成 `serial#displayId`，跨屏复用一律 `STALE_FRAME`/`STALE_SNAPSHOT`。
- 语义动作坐标校验用该 display 的 size，不用默认屏。

### 5.2 入口：`Manage.operation = startVirtualDisplay | stopVirtualDisplay | listDisplays`

- `startVirtualDisplay`：`{ width, height, dpi, startPackage?, destroyContent?: true, imePolicy?: 'local'|'hide' }`，返回 `{ displayId, size, startedIn: 'scrcpy'|'overlay', package? }`。
- 幂等：同 serial 已有虚拟屏则复用并如实回报，不重复建。
- 与设备租约同一把锁；建屏失败不影响默认屏操作（`MANAGE` 与 `EXECUTE` 分开计预算，沿用现有 `Manage` 语义）。
- `stopVirtualDisplay` 必须 `destroyContent`，否则残留窗口会让下次 `dumpsys` 解析出错。

### 5.3 采集

- `scrcpy-hub`：新增 `displayId` 选项，拼进 server 参数 `display_id=${id}`（镜像已有 display）或 `new_display=...`（自建）。会话与 data 结构带上 `displayId`，`FrameHub` 的 `screencap` 加 `-d ${id}`。
- `stream-server`：一个 display 一条流；viewer 增加 display 切换（两块屏并排或 tab），不复用同一个 canvas。

### 5.4 注入（按优先级）

1. **u2 RPC 带 displayId**（若探针证明承运支持）：在 `rpc-methods.js` 增加 `click(x,y,ms,displayId)` 之类的形状，本地校验 arity；未证实前一律 `experimental`。
2. **scrcpy control**：实现 `TYPE_INJECT_TOUCH_EVENT` / `TYPE_INJECT_KEYCODE` / `TYPE_INJECT_SCROLL_EVENT`，会话绑定 display；接进 `dispatchInput` 作为 `channel: 'control'`，享受同一份租约与回执。
3. **`cmd input -d <id>`**：兜底，永远只到 `dispatched`，`verified` 不可达；与现有 shell 兜底同一类证据强度。

`KEYCODE_PASTE` 在 display 不匹配时直接拒绝（§4.2），错误码新增 `DISPLAY_FOCUS_MISMATCH`。

### 5.5 感知（先探针，后选型）

- 若承运 `dumpWindowHierarchy` 可带 displayId：`ui-server.dump({ displayId })`，其余不变（最省）。
- 若不可：两条备选 —— (a) 给承运打补丁。证据：`vendor/u2-server-0.5.0.apk` 的 `versionName=0.5.0`、包名 `com.github.uiautomator2`，但 dex 里带着 `com.genymobile.scrcpy` 的 `DisplayControl`/`DisplayInfo`/`FakeContext`，明显不是上游原样二进制，说明这条 apk 的构建链在本项目侧可控；(b) 新增第二实例 `UiAutomation(displayId)` 的独立小服务（只做 dump，不做手势）。
- 两条都不通时，**如实降级**：`perception=vision`，只能截图 + 坐标动作，禁止 selector/id 寻址，并在 `Describe`/回执里声明。宁可少能力，不可假成功。

---

## 6. 探针计划（设备在线后按序执行）

设备当次不在线（`adb devices` 无设备），以下命令均未运行；每条给判据，**判据不过就停，不硬推**。

### A1 基线：display 清单

```bash
adb -s $S shell dumpsys display | grep -E "Display [0-9]+|mDisplayId=|mOverrideDisplayInfo|DisplayDeviceInfo"
adb -s $S shell dumpsys SurfaceFlinger --display-id
```

判据：能稳定拿到 display id 列表与各自 `cur=WxH`，用于建屏前后 diff 识别新 id。

### A2 overlay 副屏：注入是否真的离开用户那屏（30 分钟级验证）

```bash
adb -s $S shell settings put global overlay_display_devices "720x1280/260"
adb -s $S shell dumpsys display | grep -E "mDisplayId=|cur="        # 期望出现新 display（通常 2）
adb -s $S shell am start --display 2 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.android.settings/.Settings
adb -s $S shell screencap -p -d 2 /sdcard/vd.png                    # 拉回看是否为设置页
adb -s $S shell input -d 2 tap 360 640                              # 观察设置页是否响应
adb -s $S shell dumpsys window displays | grep mCurrentFocus        # 用户那屏焦点应保持不变
# 复位
adb -s $S shell settings put global overlay_display_devices ""
```

判据三条同时成立才算通：① `screencap -d 2` 拿到非黑图；② 点击生效在虚拟屏；③ 物理屏 `mCurrentFocus` 全程不变且用户可继续操作。

### A3 感知：承运 RPC 是否有 display 维（决定性）

在插件已起 u2 服务的会话里（`adb forward tcp:<port> tcp:<port>` 后）：

```bash
curl -s -X POST http://127.0.0.1:$P/jsonrpc/0 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"dumpWindowHierarchy","params":[false,200,true,2]}'
```

判据：`-32602 Invalid params` → arity 锁死 3，感知走 §5.5(b)；返回 XML 且含虚拟屏包名 → 直接可用，改造成本大幅下降。同一招可探 `click` 的 arity。

### A4 scrcpy 自建虚拟屏

```bash
adb -s $S push vendor/scrcpy-server-v5.0.1 /data/local/tmp/scrcpy-server.jar
adb -s $S shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / \
  com.genymobile.scrcpy.Server 5.0.1 scid=00000001 log_level=debug \
  new_display=720x1280/260 max_size=720 video_bit_rate=2000000 max_fps=30 \
  tunnel_forward=true audio=false control=false cleanup=true
adb -s $S shell dumpsys display | grep -E "mDisplayId=|cur="
adb -s $S logcat -d | grep -iE "scrcpy|virtual display"
```

判据：日志出现建屏成功（`using DisplayManager API` 或 `using SurfaceControl API`），`dumpsys` 多出一条 720×1280 的 display；随后 `am start --display <新id>` 能起 App，且物理屏 App 不消失（同 App 场景按 §4.1 单独判定）。

### A5 稳定性

建屏→起 App→截图→点击→停屏循环 20 次，记录 display id 是否漂移、是否有残留 display、scrcpy 恢复逻辑（`stream-server.js:200-400`）是否被新参数破坏。

---

## 7. 排期建议

| 阶段 | 内容 | 前置 | 估时 | 交付判据 |
| --- | --- | --- | --- | --- |
| P0 | A1–A5 探针，产出「一页事实」 | 设备在线 | 0.5d | 三条判据全绿才进 P1 |
| P1 | `DisplayTarget` 证据链改造（§5.1），默认屏行为不变 | P0 | 2d | 现有 1400+ 用例全绿；新增多显示解析用例 |
| P2 | 采集参数化（scrcpy `display_id`/`new_display`、`screencap -d`） | P1 | 1d | 双屏可同时出帧，viewer 可切 |
| P3 | 注入：`Manage.startVirtualDisplay` + `input -d` 兜底（先只到 `dispatched`） | P2 | 1.5d | 端到端能点，回执不撒谎 |
| P4 | 注入升级：u2 带 display 或 scrcpy control | P3 + A3 结论 | 3d / 8d | `verified` 可达；无重放 |
| P5 | 授权卡 + viewer 双屏 + 能力声明降级口径 | P4 | 2d | 默认关；`perception=vision` 如实播报 |

不建议跳过 P0 直接写代码：§4.1（任务搬走）和 §4.2（PASTE 串屏）都是产品级否决项，先花半天验证比返工便宜。

---

## 8. 与现有路线图的关系

`android-controller-roadmap.md` 的 G3（显示/窗口维度，判据 C）与 G12（scrcpy 闲置能力，判据 C）已经点到这条线，但都按「补齐表达力」写的。本文补的是另一半：**能力有了以后，证据链与产品口径不跟着改，会从「做不到」变成「做错」**。G3 的正确交付物因此不是「加个 displayId 字段」，而是 §5.1 那份按 display 分域的凭据模型 + §4.2 的串屏禁令。
