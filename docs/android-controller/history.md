# AndroidController 执行记录（时间线）

本文件只放**按时间排列的执行日志**：某天跑了什么、红了什么、改了什么、当时的数字是多少。
契约、判据、边界与当前状态不在这里——那三样分别在 [roadmap](android-controller-roadmap.md)、
[README（当前状态总表）](README.md) 与 [pre-m3 差距审查](android-pre-m3-gap-review.md)。

**引用规则**：正文里的进度数字一律视为「当时快照」。要回答「现在完成了吗」，看 [README](README.md) 的状态表，别从这份时间线里挑一个旧数字。

---

## 2026-11-02 · M0 执行与期间发现的问题

**执行状态（2026-11-02 23:05，M0 部分完成；M0.3 随 M1 更新）**：

- **M0.1 完成**。`UI_SERVER` / `AUTO_WAKE` / `LOOM_APP_ID` / `STREAM_CAPTURE_MODE` 四个键原先「代码在读、schema 未声明」，现已全部声明，`config.env.example` 补齐 15 个键。
  锚点：`tests/android-config-surface.test.js` 5/5（键集合双向相等、模板完备、默认值与代码回退一致、`UI_SERVER=false` 时连启动都不尝试）。
- **M0.2 完成**。真机复采两轮（PJZ110 / node v22.22.2）：静态页 Observe p50 429ms；动态页（手机QQ）**p50 400ms、p95 466ms**，60/60 成功，同页 H.264 **13.43 fps（821 帧/60s）**、三订阅 2256/2259/2254 帧。
  基线取动态页那轮（`rawDir = 2026-11-02T15-03-40-884Z`），除 soak 外全部 pass，判定 `incomplete`。
  数字与可比性说明见 `android-performance-baseline.md` §5「第二 / 第三轮复采」。
  附带效果：`android-perf-baseline-runner.test.js` 原先 6 条红（基线只在 node v24 下存在）随新指纹落盘自然转绿，未改任何断言。
- **M0.4历史部分完成，本批补分层代码身份**。三个采集脚本曾先改运行时设备解析；本批新增 [code-identity](../../VCPDistributedServer/Plugin/AndroidController/lib/code-identity.js)，代码内容、Node/OS/ROM/config/workload与能力会话证据分别摘要，并接入Observe。旧采集脚本/基线尚未全部迁移或重新实采，不能把模块实现等同完整性能可比性验收。
- **M0.3 文档已更新**。README 与插件命令说明已加入 Fill，删除「只有 dump/解析」与「语义 fill 未实现」的旧声明；同时说明 Unicode InputText 的系统剪贴板副作用和未知结果不重放边界。已随 M1 最终完整隔离回归通过。

**M0 期间发现并修掉的问题（不在原计划内，属「把账对上」范围）**：

`lib/ui-server.js:_ensureApk` 的 apk 存在性探测在文件缺失时退出码为 1，被 `_exec` 当作失败抛出 ⇒ 冷设备上常驻 RPC 从未生效，静默回退 CLI。这条解释了「Observe 为什么比文档慢一个量级」。修法与红绿证据见基线文档 §5。

对后续阶段的影响：M1 的所有 RPC 动作都建立在 `UiServer` 可用之上，这个洞不修，M1 会在冷设备上同样静默退化。Observe 真实延迟按「dump 占 91%」推算应在 200–300ms 量级，未实测。

---

## 2026-11-03 · M1 真机验收与缺陷处理

**执行状态（2026-11-03，M1 真机验收已复跑，结论：6/6 通过）**：

真机验收用 `scripts/verify-android-m1.cjs SERIAL --fill|--unicode|--touch`，判据不采信插件自报 outcome，每项都用新的 Observe 独立读回。设备 PJZ110 / Android 17 / 1440×3168 / 无线调试；靶场 `com.coloros.note` 新建便签编辑页（用户指定的备忘录类页面）；密码框分支按用户要求跳过，标为未覆盖。

首轮隔离回归（README 完整命令）：**886 tests / 886 pass / 0 fail**；两项缺陷修复后重跑：**894 tests / 894 pass / 0 fail**。任何一轮都不等于真机动作可用。

| 项 | 真机结论 | 证据 |
| --- | --- | --- |
| M1.1 RPC 客户端与白名单 | **可用** | `start()` ok；未白名单方法本地拒绝且 `dispatched=false` |
| M1.2 Fill 非空 `setText` | **可用（含中文）** | 回执 `verified`，独立读回 `Ayari-M1-2026` 一致；charset 修复后中文也一致 |
| M1.2 Fill 空串 `clearTextField` | **可用** | 回执 `verified`，独立读回为空 |
| M1.2 密码框 | **未覆盖** | 用户明确跳过 |
| M1.3 Tap / LongPress / Swipe | **走 RPC 可用** | `channels=["rpc"]`，method 依次 `click`/`swipe`（长按=起止同点）/`swipe` |
| M1.4 Unicode 剪贴板粘贴 | **可用（KEYCODE_PASTE）** | 回执 `dispatched`，独立读回 `绫织M1验收` 一致；WebView 与原生 EditText 两类控件都验过 |

**真机暴露并已修的缺陷**（隔离回归此前全绿，说明契约没盖住这些面）：

1. **`maxDepth=0` 让 RPC 快路径永远空树**。uiautomator2 的 `maxDepth<=0` 不是「不限制」而是「只到根」：同一屏实测 `0`/`-1` 回 1 个 `<node>`，`>=60` 回 130 个。旧代码传 0，于是 Observe `controls=0` 却自认成功、永不回退 CLI——这正是「Observe 比文档慢一个量级」的另一面。改为正深度默认值 `DEFAULT_DUMP_MAX_DEPTH=200`，并在 `UiServer.dump` 里把非法值校正为正整数。
2. **无 `resource-id` 的输入框被同 bounds 的包裹 View 误拒**。`fieldSelector` 的第一道唯一性把 `android.view.View` 容器也算作候选（两者 bounds 完全相同），命中 2 个即拒绝，导致这类常见输入框永远填不了。改为只在可编辑节点（`EditText`/`AutoCompleteTextView`）里算唯一性。
3. **`setText` 静默损坏非 ASCII**——当时判成 ROM 限制，于是让 Fill 在本地拒绝非 ASCII。**这个处置后来被真机推翻**：根因是 RPC 请求头缺 charset（见下方第 5 条），修好之后 `setText` 能正确写入中文（独立读回 `绫织原生写入`）。那条拒绝规则已撤销；留着它会把一个可修的问题当成永久限制。
4. **清空后 `getText` 返回 `"\\n"`**，严格相等会把「已清空」误判成 `unknown`。改为只归一化首尾空白，中间内容仍逐字比对。

**两项硬缺陷的处理（2026-11-03，已改实现与契约测试；真机复验待跑）**：

两项的共同点不是「某个方法写错了」，而是**宿主侧没有任何一层能在本地拦住参数形状错误**。所以修法分两层：一层是具体缺陷，一层是让它不再复发的通用闸门。

1. **新增 `lib/rpc-methods.js`：白名单从 `Set<string>` 升为签名表**。`INVOKE_METHODS` 原先只校验方法名在不在，`Array.isArray(params)` 之后直接发出去——于是 `click [x,y,duration]` 这种形状错误能一路到设备，而 u2 的 `click` 照样回 `true`。现在每个方法声明 `arity` / `write` / `experimental`，`UiServer.invoke`（通往设备的唯一入口）在发出前校验参数个数，失败即 `UI_SERVER_INVALID_ARGUMENT` + `dispatched=false`，绝不写 body。参数错位从此是本地红灯，不是真机惊喜。
2. **`LongPress` 改用起止同点的 `swipe`**（`swipe(x,y,x,y,steps)`，`steps ≈ duration/5`）。不再考据 carrier APK 的 `click` 重载语义（`displayId` / 时长 / 不存在随构建漂移），也不依赖 `longClick`（`[x,y]` 抛 `JsonMappingException`，`[x,y,800]` 报参数无效）。`swipe` 各代形状一致，且与 shell 回退（`input swipe x y x y duration`）同口径。**（本条论证依据已被 §0.3 第 2、3 条推翻：三参 `click` 就是原生长按，`longClick` 报错是因为它从来没有坐标重载。改用原生见 M1.5.0；本条作为「当时的应急处置」保留原文。）**
3. **预算不再从方法名猜时长**：`rpcActionTimeoutMs(method, params)` 里原先有 `if (method === 'click') durationMs = params[2]`，与缺陷 2 是同一个错误假设泄漏到预算层。改为调用方显式 `{ durationMs }`；`swipe` 的 `steps*5` 保留在签名表语义里。
4. **测试改断语义，不断字节**：`tests/android-rpc-actions-contract.test.js` 原先钉死 `LongPress → click [50,20,800]`，等于把错误写成契约。现在断的是「起点=终点」「steps↔duration 成比例」「通道顺序 rpc→shell」，方法名与参数个数由签名表那一条用例集中守护。
5. **M1.4 的真根因不是 ROM，是宿主侧的 `Content-Type` 没声明 charset**。
   - 真机逐条实测（PJZ110 / Android 17）：`setClipboard` 成功、`getClipboard` 成功、`pasteClipboard` 抛 `java.lang.AssertionError`。**不是整组不可用**，所以不能按组一刀切——那会连 `setClipboard`/`getClipboard` 一起封掉。能力记账因此按**方法**走。
   - 更关键的一层：RPC 请求头原本是 `application/json`（无 charset），设备端按 ISO-8859-1 解请求体、按 ASCII 编响应体。于是**每个非 ASCII 字符按 UTF-8 字节裂成 U+FFFD**。同一段 POST 分别用三种写法跑：无 charset → `绫织` 回 6 个替换符；`application/json; charset=utf-8` → 原样往返（`e7bbab e7bb87`）；ASCII 转义 → 原样往返。
   - 这一条同时解释了之前被误判为「ROM 不支持中文」的两个现象：`setText` 把「绫织M1验收」写成 12 个 U+FFFD（4 汉字 = 12 字节）、`setClipboard` 把剪贴板内容写坏。修好头之后，`setText` 能正确写入中文（独立读回 `绫织原生写入`）。**之前那条「Fill 遇非 ASCII 在本地拒绝」的规则因此不再需要**，属于被证据推翻的误判，不做保留。
   - 粘贴原语：默认改发 `KEYCODE_PASTE(279)`。它在**原生 EditText**（日历 `etEventTitle`，读回 `绫织粘贴测试`）与 **WebView**（随手记 `WVJBWebView`，读回 `绫织WebView粘贴`）两类控件上都实测能贴进去。`pasteClipboard` 在本 ROM 上是**确定性**失败，先撞一次再回退等于每次非 ASCII 输入都牺牲一次，所以默认不走它。开关 `CLIPBOARD_PASTE=keyevent|rpc|off` 已同时进 `configSchema` 与 `config.env.example`；选 `rpc` 时仍保留失败学习（一次 `AssertionError` 后同一 UiServer 世代内改走 keyevent）。
   - 能力只由**实际失败**学习，没有只读探针。曾经加过「用只读的 `getClipboard` 探整组」，真机直接证伪（get 活、paste 死），已删除——拿错的传感器比没有传感器更糟。
6. **`getText` 读回与 `setText` 提交之间存在竞态**。真机实测：`setText` 返回后立即 `getText` 读到的是**上一次**的旧值，`+20ms` 才是新值。原先只读一次，于是「写成功了」被报成 `FILL_READBACK_MISMATCH` / `unknown`。改为窗口内（默认 1200ms，受单步预算约束）**只重复读、绝不重发写**；传输类失败立即止损不空转；回执只落一条汇总并按实际结果标 `dispatched`/`not-dispatched`。

回归：隔离回归 **894 tests / 894 pass / 0 fail**；真机验收 `scripts/verify-android-m1.cjs SERIAL --fill --unicode --touch` → **6/6 通过**。

**历史（2026-11-02，仅隔离回归，未做真机动作）**：

- `invoke(method, params=[], options={})` 使用固定方法白名单、数组参数、1–120000ms 单步总预算与可信 AbortSignal；共享 HTTP 传输校验状态码、JSON-RPC version/id/result/error 结构并限制响应为 8 MiB。本地拒绝与随包 APK 确认调用前的 `-32601/-32602` 标记 `dispatched=false`；其他发出后的错误均视为可能执行，禁止盲目回放。当日契约测试 15 条跑红后转绿，客户端与原生命周期回归合跑 32/32。
- Fill 只接受 `id`、`selector=id=…` 或 `index+snapshotId`，目标须可见、enabled 且原始树中的 class/package/resource-id 身份元组唯一；重复字段拒绝，不依赖 instance 猜测。密码字段不读回、不用外层 expect 冒充值验证，只记录派发。边界测试 9/9，覆盖在途取消/总截止与租约保留、不回退/不回车、无效目标与快照、原始重复字段、读回失败与脱敏、Scroll steps 换算及剪贴板已修改后的失败回执。触摸优先 RPC，明确未执行才 shell 回退。
- 当日只跑通只读服务连通（Awake、1440×3168、`keyguard=false`），Observe 为 observed 但 controls=0（原因见上方 maxDepth 缺陷）；未执行 Fill、触摸、粘贴、唤醒或解锁。

---

## 2026-11-03 · M1.5 交付与余项收束

**执行状态（2026-11-03，M1.5 首批增量）**：

- **M1.5.0 代码与定向契约已完成，原生长按效果待真机准入**。`click` arity 为 `[2,3]`，四参在真实 `UiServer.invoke` 入口本地拒绝且不发 HTTP；同时纠正 `longClick` 为单参 Selector/String（没有坐标重载，继续 experimental）。LongPress 优先 `click(x,y,duration)`，仅明确未执行才降级同点 RPC `swipe`，仍明确未执行才 shell。持续时长显式进入预算，超时/断连/false/未知不重放。按 §0.2/0.3 修正的定向测试先红 15 条，实现后含清理/参数边界合跑 **135/135 通过**；这不是原生长按触发菜单的真机证据。
- **M1.5.1 已实现，独立标记 experimental**。显式 `ExecuteStep.action.command=DoubleTap`，一次定位、同一设备租约内两次 RPC `click`；以首击开始调用 RPC 的单调时刻计窗，目标派发间隔100ms，ACK 延迟从等待中扣减，第二击须在120ms内开始派发（ACK 和第二击就绪等待均计入窗口），错过即 `DOUBLE_TAP_WINDOW_MISSED`。不补迟到单击、不采树、不唤醒、不重定位、不退 shell；首击成功后第二击未派发/取消/超时，整步仍 unknown、retryable=false。无 expect 仅 dispatched，expect 的 verified 只证明指定条件。实验状态同时进入 Describe、正常与异常模型可见回执；未做真机准入，不进自动降级链。
- **验证与集成边界**：`tests/android-double-tap-contract.test.js` **25/25 通过**，覆盖首击 ACK 50/110/121ms 延迟、调度/就绪超窗、间隔取消、共享预算、RPC 排干前租约、凭据失效、序列停止和回执隔离；与触摸/预算/序列定向合跑 **69/69 通过**。复审曾复现 ACK 后才起窗导致150ms仍派发，已修成首击派发起计；受控时钟同时覆盖 VM 与宿主，不修改生产过期阈值。sequence 每步清空动作专属回执，避免实验标记污染下一步，整段累计派发状态不清空。
- **最终完整隔离回归**：按插件 README 的完整命令，Node v24.22.2 下 **929 tests / 929 pass / 0 fail / 0 skipped，13.366s**（较 M1 的894条新增35条）。`node --check` 与限定变更文件的 `git diff --check` 通过；无真机动作。仍有仓库原有 ESM package-type 提示，未为此修改根包配置。
- 上述为首批 M1.5.0/1 交付快照；剩余项的当前收束状态见下文。M1 既有6/6只证明原验收范围，不为本轮新增动作背书。


**M1.5 余项收束（2026-11-03）**：

- **M1.5.2 ScrollUntil 已实现**：`container=id=…`、`target=id=…|text=…`、`strategy=auto|rpc|host`。auto 在写前以 readiness 选择 RPC，显式 maxSwipes 或 up/left 固定选 host；RPC 显式 maxSwipes/up/left 本地拒绝，不静默忽略。RPC 一次 scrollTo，目标搜索细节由设备端控制；host 默认10、最多20次，每轮实时采样再滑一次。目标须同包唯一、属于容器子树且在祖先裁剪视口可见；只滚不点、不唤醒。任何 RPC 写调用失败（含明确未派发）不跨策略；次数耗尽 unknown、外层 expect 不洗绿，所有路径共享总预算。70条专项契约通过。
- **M1.5.3 键盘已实现**：ImeAction 显式 enter/search → pressKeyCode(66/84[,metaState])；KeyCombo 固定输入键集合+Android metaMask=0x7770ff；EraseText count 数字1–100表示最多DEL次数，不承诺字符数。稳定id、唯一真实focused、可见启用非密码字段，每击重新getText且复核身份/焦点，空停止、不变/异常 unknown 不补写。最终焦点证明放在 RPC ready 等待之后的 beforeDispatch 闸门；已复现并修复 ready期间换焦点仍错误DEL的宿主时窗。原始字段值/错误消息不入历史。无shell回退，不实现未定的hideKeyboard/自动IME切换；设备外部瞬时焦点竞态仍存在，保持experimental。
- **M1.5.4 Drag 与 M1.5.5 Pinch 已实现**：Drag 语义源dragTo或像素源drag单一触摸流，两端同一次实时采样/尺寸与凭据检查，终点在祖先滚动裁剪内；Pinch 绑定原始唯一完整class/package/resourceId，调用pinchIn/Out一次。两动作 steps1–2000（默认60）或 duration1–10000ms互斥，Pinch percent1–100。无shell/scrcpy降级、不重放、不主动verified。124条专项契约通过。自定义gesture两指点列没有需求/效果证据，明确不暴露，不影响pinch原语交付。
- **M1.5.6 动作历史已实现**：Manage operation=actionHistory，纯内存纯读，离线/忙时不连设备不抢租约。每设备100条、最多32设备，limit仅数字整数1–100；只存UUID/固定command/outcome/耗时/stepIndex和白名单最后attempt摘要，不含参数、URL、坐标、selector、expect、错误原文。单动作与序列每步恰一次终态，取消后的迟到排干不改写历史。13条专项契约通过。
- **安全验收交付**：`scripts/android-m15-fixture/`为固定零权限、无网、无持久化用户内容的原生Java靶场；已用本地SDK实际构建并校验APK签名，产物`.build`被git忽略。`scripts/verify-android-m15.cjs`默认probe不加载Service，显式--run每步前后精确靶场包/主用户/Awake/未锁/同会话闸门，独立只读Provider验证效果，unknown/fallback/读回不符即终止。离线CLI与完整suite安全测试 **22/22通过**；其中真实Service harness验证EraseText count2的六条RPC回执（每击重新读前值），不靠手造五条假回执自证。所有未覆盖变体继续experimental。
- **跨模块接缝**：仍只有Describe/Observe/ExecuteStep/Manage四个公共入口。新增RPC参数在真实UiServer.invoke入口验证arity、类型、范围及selector mask与字段精确一致；非法形状不发HTTP。Drag嵌套target的设备覆盖/后续旧凭据亦纳入序列第一步之前的结构预检，不能藏在对象里绕过原约束。模型可见catalog、manifest与README已同步。
- **最终隔离回归**：完整既定Android/ADB/显示流/UI图/视觉/连接/JEV/分布式错误链套件 **1231/1231通过、0失败、0跳过**（15.20s），包含新集成与真实HTTP签名门禁；专项语法检查及限定 `git diff --check` 通过。后续安全验收CLI测试单独记录，数字不混加为ROM通过。
- **首次准备历史（非最终状态）**：起初 adb devices/mDNS 为空、既有缓存私网端点单次连接超时；18:14 PJZ110 重新以已授权无线serial上线，独立确认Awake、用户0、keyguard showing/inputRestricted均false、预置RPC APK存在。仅对零权限固定包com.vcpchat.m15fixture尝试一次 `adb install --no-streaming`，返回 **Failure [-99] / exit1**；随后纯读 `pm path`确认未安装，最小安装器日志未提供进一步分类。未执行am start、未执行验收--run，未触摸/输入用户应用，未切换输入法/解锁/改安全策略，未重试安装或以另一种方式绕过。另显式serial只读 `--probe` 在非靶场前台返回 `UNSAFE_OR_UNPROVEN_TARGET_STOP`，确认未初始化Service、未派发动作。此为靶场安装前置环境失败，**新增动作deviceAcceptance=NOT_RUN，非动作失败亦非通过**；设备在线不等于安全靶场可用。全部保留experimental。
- **最终真机实况**：用户再次授权后相同APK安装成功；先修只读探测对Awake+数值1的厂商格式兼容，保留显式Awake与矛盾态拒绝。旧单长序列暴露DoubleTap超窗，随包DEX实证两参click固定按压100ms；仅双击改三参20ms短按，100/120派发窗、顺序ACK、未知不补击全保留。新增独立case串行`--suite`：单项失败不跳过其它项，但租约/队列排干、cleanup与同会话安全闸门不放松。最终同轮 **14/14 PASS、0失败、0未执行，deviceAcceptance=PASSED，exit0**：原生长按800、双击（派发差111.554ms、独立GestureDetector计数增加）、语义/像素Drag、PinchIn/Out、IME enter/search、Ctrl+A/MOVE_END、EraseText2、ScrollUntil host（4 swipes）/RPC（单scrollTo）、脱敏历史纯读。完整实证与未覆盖范围见[真机记录](android-m15-device-validation.md)。不是拼接局部复验，也不外推其它ROM/应用/参数笛卡尔积；全部新增动作保持experimental。


---

## 2026-11-05 晚间 · 四组真机矩阵补齐

**执行状态**：同一台 PJZ110（Android 17 / 1440×3168，无线 `192.168.137.193:45947`）上，只跑零权限固定靶场 `com.vcpchat.m15fixture`，四组矩阵全部 exit 0：

| 矩阵 | 结果 | 日志 |
| --- | --- | --- |
| M1.5 动作语汇 | 14/14 PASS | `artifacts/android-accept-2026-11-05/m15-suite-run1.log` |
| M2 寻址与验证 | 14/14 PASS | 同上 `m2-suite-run1.log` |
| 结构关系 + Collect | 5/5 PASS | 同上 `structural-collect-run1.log` |
| 原生人工批准/交还 | 4/4 PASS | 同上 `native-human-run1.log` |

完整离线回归 **1925/1925**、0 失败/取消/跳过、exit 0（`offline-final.log`）。详细边界见[本轮验收记录](2026-11-05-device-acceptance.md)。

- **历史红灯去向**：12:42 那轮的红灯是 `DoubleTap`（`INDEPENDENT_READBACK_MISMATCH_STOP`，两击均已 dispatched），不是 `ScrollUntilHost`。本轮 `ScrollUntilHost` 4 次 shell swipe 后 PASS；`DoubleTap` 套件内通过、另单独复跑 3 次全过（合计 4/4）。双击窗口仍是 100ms 间隔 / 120ms 派发窗 / 20ms 短按，没有放宽。
- **给验收脚本补可分类证据（不改生产代码）**：`scripts/verify-android-m15.cjs` 在读回不匹配时附带白名单 fixture 计数前后值与变化列表（不含文本/坐标/selector），`verify-cli.test.cjs` 锁定「零移动 → changed 为空」与「重复计数 → doubleTap 偏移 2」两种签名。加上这 2 条后离线由 1923 变 1925。首次实现把「零移动」误断言成「有移动」，红灯后改正；另有一步替换多留一个闭合括号，用 `node --check` 抓到后删掉。
- **原生组由真人操作**：4 次 Electron 原生对话框由用户本人在键盘前点击（拒绝/允许这一次/继续/停止），每项断言恰好多一次人工提示，不是空跑。
- **两条工程问题（非产品缺陷但会伪装成失败）**：① 靶场模式是内存态，人工组留下 `m2` 后直接跑 M1.5 会以 `FIXTURE_STATE_INVALID` 停在 gate 读取（早于它自己的 `nav_gestures` 复位），用 `am force-stop` + `am start` 复位，该次停止留存为 `m15-doubletap-precondition-stop.log`；② 环境带 `ELECTRON_RUN_AS_NODE=1` 时 `require('electron')` 返回路径，原生组第一行就 `TypeError` 退出，启动前必须清掉。
- **不动的边界**：靶场由 agent 用 `am start` 切前台（门禁要求是「已安装隔离靶场在前台」，非「人手动点开」）；没有解锁、改系统设置、装包。生产 JS/vendor/manifest 未改，摘要仍 `b6f1689e…45c`。跨 ROM、旋转/多 display、在途未知 RPC 注入、soak、性能基线迁移仍全欠。

---

## 2026-11-05 夜间 · 旋转验收与靶场可转向化

**结论**：旋转能力真机 **8/8 PASS**；竖屏基线改造后仍 **M1.5 14/14、M2 14/14**；横屏 M1.5 只到 **9/14**，其余 5 项因链路瞬断 + owner 重绑失败未验收。细节见[旋转验收记录](2026-11-05-rotation-acceptance.md)。

- **靶场原本物理上转不了**：`AndroidManifest.xml` 钉死 `screenOrientation="portrait"`。本轮解除锁定，并加 `configChanges="orientation|screenSize|...|keyboardHidden"`——不加则旋转重建 Activity、session 变化，三个验收脚本都会以 `FIXTURE_SESSION_CHANGED_STOP` 停。
- **旋转入口放在靶场内**：新增 `nav_rotate` 调用 `setRequestedOrientation`，因此旋转验收不需要 `settings put system user_rotation`，不触碰系统设置。状态里新增 `rotation`/`rotateRequests`/`width`/`height` 作为独立证词。
- **动画窗口从 20s/30s 改为到 STOP 为止（上限 10 分钟）**：本轮先出现一次 `IdleMotionTimeout` 报 `FIXTURE_MOTION_EXPIRED`，实测是链路变慢让 30 秒窗口在用例中途耗尽；那是环境信号冒充产品信号。改的是靶场，不是产品阈值。
- **8 项断言**：竖屏 context 一致 → 旋转后宽高互换且 session 不变 → 横屏 context/epoch 前进、裁剪区不换轴 → 旧 `index+snapshotId` 被 `STALE_SNAPSHOT` 拒 → 旧 `frameId` 被 `STALE_FRAME` 拒 → 横屏 Scroll 真滚动（scrollY 0→520）→ 横屏 idle 判 `layout_stable` → **转回原方向后旧凭据仍死**（epoch 1→3）。最后一条是关键：几何一样也不行，撤销依据是 epoch。
- **横屏半程与 ADB_FAILED 根因**：第 10 项 `KeyComboMOVE_END` 后 gate 判不安全、整轮停止（设计内）；定向补跑 5/5 报 `ADB_FAILED`。诊断到根因不是旋转：`uiautomator dump` 稳定 exit 137（SIGKILL），因为设备上残留 `app_process`（`com.vcpchat.uiautomator.Owner`）占着 UiAutomation；同时 `UiServer.start()` 返回 `UI_SERVER_OWNER_UNBOUND`、`owner.jar` 已不在设备、`forward --list` 留有两条指向死端口的转发。清掉残留转发后仍不能重绑，`recoverOwner` 也不适用（它解隔离，不负责重绑）。
- **没有做的处置**：未对该孤儿进程做定向 kill——项目约定 stop 走 owner 自退出 + 独立消失证明，宽泛 kill 明确禁止。这条缺口单独立项，不算旋转欠账。
- **收尾**：设备已用 `am force-stop` + `am start` 复位到竖屏（系统 `user_rotation=0`、`accelerometer_rotation=0`，未改任何设置）。
- **仍欠**：跨 ROM（需第二台设备采原始格式）、横屏下剩余 5 项与结构/Collect、多 display（仍拒绝策略）、旋转中途派发。
