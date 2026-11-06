# AndroidController：受控原子动作与宿主任务

插件接受 `Describe / Observe / ExecuteStep / RunTask / Manage`。`RunTask` 是新增实验性宿主任务入口；原子动作仍统一放入 ExecuteStep.action，截图使用 Observe mode=image，设备管理使用 Manage。旧顶层动作别名已删除，不提供兼容转译。工具发现沿用 VCPToolBox 的 `{{VCPDynamicTools}}`；联网搜索、文档处理与主机维护使用已有工具，不在安卓插件中复制实现。

**当前状态以[文档状态表](../../../docs/android-controller/README.md)为准。** M2有固定portrait靶场历史证据；本轮新增结构关系、人工确认、Handoff、Collect与滚动可见性契约，不沿用旧代码的真机结论。

**M3 前收口状态：** 分源、上下文/epoch、完整布局stable、分层摘要、策略门与远端owner已接入；可信逐次批准/Handoff有单机固定靶场证据。数字、跨ROM与环境准入欠账只看[状态表](../../../docs/android-controller/README.md)，不沿用旧代码的通过结论。M3 OCR/模板、安装App新后端与全窗口输入未交付。

**数字与阶段档位以 [docs/android-controller/README.md](../../../docs/android-controller/README.md) 为唯一来源**，本 README 不再维护第二份回归数字。

## 打开显示屏与调整画质

从应用启动台、常用应用抽屉或 V 桌面的「安卓」打开独立显示屏。主页面只保留标题栏和视频画面；标题栏齿轮进入独立设置页，分为「画面」「连接」「控制器」「状态」。显示方式、画质、重连收在「画面」，配对与连接收在「连接」，自动唤醒、输入与应用策略收在「控制器」，实际分辨率、帧率、延迟和帧信息收在「状态」。返回画面或按 Esc 关闭设置，不重复建立正在使用的视频连接；「重连画面」则明确重新建立连接。

独立窗口使用 VCPChat 自绘标题栏与最小化 / 最大化或还原 / 关闭按钮，不使用 Electron 原生标题栏覆盖层。标题栏按钮样式、设置控件样式和设计 token 直接取自项目现有样式文件，并应用当前主题与明暗模式；不另建一套配色或原生控件外观。人工接管入口收在标题栏手形菜单中，默认关闭，不额外占据视频高度。仅暴露受限的窗口适配接口；窗口控制由隔离 preload 的固定消息处理，不向投屏网页暴露通用 Electron API。

「视频分辨率」提供原始分辨率和按短边选择的 540p / 720p / 1080p / 1440p / 2160p。例如源画面为 1080 × 2400 时，720p 预计为 720 × 1600，而不是长边 720 px。读取有效源屏幕尺寸后等比缩小，不拉伸、不裁切、不放大，不修改手机分辨率；横竖屏沿用同一短边档位。设置中显示预计宽高，编码器对齐后的实际视频宽高以「状态」为准。旧长边配置会显示为「旧配置 · 长边 ≤ … px」，修改帧率或码率不会顺手改变原有分辨率策略。

选择帧率上限、目标码率和分辨率后点击「应用」。画质与显示方式保存在 AppData 的 `android-display-preferences.json`，重新打开窗口或重启后保留；应用会短暂重启共享 H.264 流，其他查看窗口也会受影响；JPEG 兼容画面不受这些参数控制。新 HTTP 字段 `maxShortEdge` 为 `0`（原始）或 `180..2160` 安全整数，与旧 `maxSize` 互斥；旧 `maxSize` API 和环境配置仍可用。短边模式若无法读取源尺寸会明确报错，而不以错误尺寸假装成功。

「恢复默认显示设置」将画质与显示方式在同一次原子保存中恢复为完整显示、30 fps、2 Mbps、长边 540 px，并沿既有视频切换流程应用。保存失败保留旧配置；编码器重启失败会明确提示兼容画面回退，已保存的默认值仍供下次启动使用。

「控制器」提供自动唤醒、剪贴板粘贴方式、禁止访问／只读应用列表与逐次操作确认。「连接与高级选项」提供 ADB 路径、默认设备、命令超时、显示端口与常驻控件服务；「兼容画面」提供 JPEG／PNG 格式、JPEG 质量、刷新间隔、最大宽度和采集方式。这些选项保存到插件原有 `config.env`，重启 VCPChat 后生效；当前连接和在途任务保持原配置。保存按版本检查并原子替换，冲突或失败保留界面草稿，显式「重新读取」会放弃草稿。显示偏好独立于这些启动配置，已保存画质优先于环境中的 H.264 默认值。

控制器设置仅由桌面独立设置窗口的受限 IPC 提供，普通浏览器查看器不提供配置文件写入。系统能力授权按钮跳转到主窗口的「Android 系统授权」，复用分设备风险确认和授权保存，不新增授权副本；包策略仍独立约束通用操作。`LOOM_APP_ID` 保留在插件配置中。

窗口在首帧和横竖屏比例变化时自动贴合。手动调整大小后保持用户尺寸，也可在设置中点击「贴合窗口」返回画面并恢复；最大化或全屏时不自动缩放。设置打开期间不自动调整窗口大小。「适合宽度」可滚动查看超出窗口的画面。无设备时显示简短空状态，可进入连接设置，不自动扫描或连接。此前画质与布局的验证范围见[历史记录](../../../docs/android-controller/2026-11-05_android-display-quality-report.md)；本次布局以当前实现为准。

## 人工接管（experimental，默认屏）

标题栏手形菜单选择「开始接管」，在电脑原生对话框批准后操作。只绑定当前显示的明确设备；没有可信宿主批准服务时不可用。开始会停止原 Agent/M5 调用并等待真实在途操作排干，未知设备保持隔离，不强行交接。最长十分钟，结束、关窗、断线或超时均撤销会话，不自动恢复原 AI 任务。

首版展示独立「接管快照，操作后刷新」，支持点击、100–1500ms有限滑动、返回/主页/最近任务。快照十四秒有效，加载与尺寸校验完成才可操作，每次输入后重新采图。过期/旋转/上下文变化须刷新，直播画面不能当作可操作坐标。回执只报已派发，不声称设备或业务完成；派发后截图失败不会重试原动作。

现有包拒绝/只读/敏感动作策略仍有效，批准接管不覆盖逐次确认。首版不开放文本、剪贴板、长按、连续pointer或副屏。为防连接别名绕过，接管期间临时全局拒绝其它设备的Agent操作及连接管理；不代表跨主机或外部ADB客户端互斥。阶段与验证范围见[当前状态](../../../docs/android-controller/README.md)及[接管记录](../../../docs/android-controller/2026-11-06_android-m4-takeover.md)。加载新后台需要重载插件宿主/重启 VCPChat，仅刷新旧viewer不替换已加载Service。

## Describe：按需读取参数

```json
{"command":"Describe"}
{"command":"Describe","topic":"devices"}
{"command":"Describe","topic":"packages","serial":"YOUR_DEVICE_SERIAL","filter":"example"}
{"command":"Describe","topic":"system"}
{"command":"Describe","topic":"api"}
```

- `overview`（默认）：动作参数、观察模式、单步执行边界和设备管理用法，不访问设备。
- `devices`：连接设备及授权/离线状态。
- `packages`：设备应用包名，接受 `serial/filter`，沿用设备租约。
- `system`：固定系统能力声明与风险组，不代表当前机型支持。
- `api`：当前唯一正式业务 API：匿名只读 GitHub 公开 issue/PR 查询。

## Observe：统一感知

```json
{"command":"Observe","serial":"YOUR_DEVICE_SERIAL","wake":"never"}
{"command":"Observe","serial":"YOUR_DEVICE_SERIAL","mode":"image","region":{"left":0,"top":100,"width":500,"height":500}}
```

`mode=ui`（默认）返回语义控件表、页面签名和 `snapshotId`。`limit` 默认60；`textLength` 默认120，只接受数字安全整数16–4096；`detail=false` 默认省略坐标/短ID，`detail=true` 或独立布尔 `includeCoordinates/includeShortId` 按需显示。公开text/desc/value/label的预算预览不裁剪内部完整匹配或布局证据，不能把截短预览当作原文selector；直接使用返回的完整selector。

`screenshot=true` 同时附图。`stable=true` 比较相隔200ms、同一新鲜前台/显示上下文与epoch下的完整可见原始布局，`settled=true/false/null` 分别代表布局稳定、变化、未知；不因limit截断漏比较尾部节点。它与Wait idle使用同类布局证据，忽略纯文案变化，不证明像素静止、无遮挡、网络完成或业务成功；请求stable后变化/未知的快照不得授权index输入。`stable=false` 仅不请求第二次采样，状态为not-sampled，不是动作禁令。采集失败报错，不伪装空树。`wake=never` 禁止点亮屏幕；默认 `ifAllowed` 沿用 `AUTO_WAKE` 配置，不自动解锁。

`windows=true`（仅布尔，默认false）额外请求多root XML只读诊断；返回根数、可证明的display-id/bounds及treeState，不输出窗口文字。缺少windowId/type/layer/null-root等结构化元数据时保持null，`occlusion=unknown`、`actionable=false`。这不是完整窗口枚举，不切换动作窗口、不授权全窗口/多display输入；空根也不能确定归因为应用敏感策略。

`mode=image` 默认不依赖 UI 树。可用 `region`、`target=canvas`、`maxWidth`（默认1080）、`format=jpeg|png`、`quality`、`grid=false`；返回真实 `image_url` 和坐标映射。图像采集及编码前后额外采样新鲜前台、窗口、逻辑尺寸、旋转、电源及锁屏状态；只有完整证据一致且原始截图尺寸匹配逻辑屏幕才返回可操作 `frameId`、`image.actionable=true`、`image.reason=READY`。否则图片仍可查看，但 `frameId=null`、`actionable=false`，reason 为 `CONTEXT_UNKNOWN`、`CONTEXT_CHANGED` 或 `SOURCE_SIZE_MISMATCH`，不能用该图授权像素动作；映射只供查看，不当作已验证设备坐标。开始替换截图就撤销旧图像凭据，失败也不恢复旧凭据。

fresh采样不读写 `wm size` 缓存，不依赖 UI dump；当前仅保守支持可明确解析的单默认显示器AOSP格式，未知OEM格式、多显示器、锁屏证据缺失都不猜。未做真机/ROM准入，可能返回仅可查看的图。缩图、裁剪只改变主机输出，图片仍全屏采集，不降低设备截图/ADB流量。实时viewer是人类观察通道，不等于模型收到截图。

M2 实验性元素图使用 `mode=image,target=element`，与 `region`、`target=canvas` 互斥，只能选择一种寻址：`id`、`selector`（字符串或组合对象），或 `index+snapshotId`；不接受 `frameId`/像素寻址。`padding` 默认为0，只接受数字安全整数0–128（设备像素，不接受数字字符串），仅用于元素图；可见矩形加 padding 后按屏幕裁剪。返回 `element.elementBounds`（原始 bounds）、`element.visibleBounds`、`element.center`（原始 bounds 的设备坐标中心）、裁剪 region 和图像到设备的 mapping。中心不保证处于裁剪后的可见范围，不能直接当作安全点击点。`occlusion=unknown`，不证明没有其它窗口遮挡。

元素图额外依赖实时 UI：采图前定位并确认当前前台、未锁定与尺寸，采图后再采样复核身份、可见 bounds 和上下文；索引寻址同时复核布局。检测到变化即拒绝签发 `frameId`，不拿旧树配新图。图片仍来自全屏采集后的主机裁剪，不是设备侧元素截图。

```json
{"command":"Observe","serial":"YOUR_DEVICE_SERIAL","mode":"image","target":"element","selector":{"id":"com.demo:id/list","role":"scroll"},"padding":8}
```

`mode=arbitrate` 显式传 `arbitration={mode:target|page|recovery,snapshotId,goal?,candidates?,targetSelector?,requestTimeoutMs?}`，复用已有快照，不额外 dump。target 最多8个合法索引；规则可确定时不调用模型，歧义复用主进程注入的 GlobalJevService；默认2秒、最多5秒、零重试。只外发脱敏短文本，不发图片、坐标或控件值；其他屏幕标签仍可能含个人信息。结果始终 advisory，不点击、不自动授权；概率门槛尚未完成项目数据校准。

`mode=api` 传 `capability=github-public-issue`、`params={owner,repo,number}`，不访问设备。固定 GitHub HTTPS 匿名GET，无任意URL、凭据、重定向、写入或自动GUI回退。默认5秒、最多15秒、响应上限256KiB。PR closed 不代表 merged。

## RunTask：受限宿主搜索任务（experimental）

```json
{
  "command": "RunTask",
  "task": {
    "serial": "YOUR_DEVICE_SERIAL",
    "package": "com.demo",
    "intent": "search",
    "inputs": { "query": "本次关键词" },
    "targets": {
      "entry": "com.demo:id/open_search",
      "field": "com.demo:id/query",
      "submit": "com.demo:id/search_go"
    },
    "completion": { "type": "visible", "id": "com.demo:id/results" },
    "decision": "rules",
    "budget": { "timeoutMs": 60000, "maxActions": 3, "maxObservations": 64, "maxModelCalls": 0 }
  }
}
```

宿主固定执行「可选进入搜索页 → Fill精确读回 → 提交 → 新出现的唯一完成标记」。这不是任意App意图规划器：需要显式设备、前台单包/default display、同包完整资源ID、唯一可见启用目标，输入框不得是密码。`entry` 可省略；起始已在表单则跳过进入步骤，不重放。缺输入、未知字段、跨包ID或已知不足预算在首次设备访问前拒绝。完成标记在首写前/提交前已经出现则停止，避免用旧结果洗绿；完成只证明声明UI状态，不证明业务结果正确或已经采集搜索内容。

整任务沿现有设备租约持有，原子子动作独立回执/历史，但不新建锁或重置截止。`maxObservations` 覆盖全部图采样，包括动作重定位、安全复核与验证轮询；默认64，上限256。动作默认2或3、上限8，时间默认60000ms、上限300000ms，模型次数上限16。`rules` 无模型；`shadow` 在规则执行前仅记录Jev有限建议，缺服务/超时停止，模型输出不参与授权，不发送查询值/原始屏幕文本。影子等待后重新采样且最后派发前再次校验观察摘要/epoch/TTL；未知写不重放，取消/断线沿现有可信signal传播，依赖未排干不解锁。

`rules/shadow` 每个阶段复用 M2 idle 采样器，最多等待 5 秒，要求连续两次完整观察一致、目标已就绪；等待也计入总任务时间和观察预算。仅 `rules` 的 `TASK_OBSERVATION_CHANGED` 且子回执明确为 `failed` 时允许重新观察，每个逻辑动作最多尝试 3 次；失败回执全部保留，`counts.actions` 按逻辑动作计数。策略拒绝、上下文不明、歧义/密码框、已派发后的 unknown 都停止。

完成条件可增强为：

```json
{
  "type": "visible",
  "id": "com.demo:id/results",
  "item": "com.demo:id/result_title",
  "minItems": 1,
  "itemMatchesInput": true,
  "absent": "com.demo:id/search_help"
}
```

`item` 要求唯一可见容器内的可见非密码后代条目，`minItems` 为 1–50（默认 1）；`itemMatchesInput` 要求至少一项原始文本包含本次输入，二者须配合 `item`。`absent` 独立可选，可引用先前的输入目标，要求对应原始节点消失；不能与正向完成 ID 相同。条目证据来自原始树，避免非点击书名折叠到可点击行后丢失；只向宿主传计数和布尔值。声明条目条件时，空结果占位容器不算预存完成，但已满足的完整完成谓词仍拒绝。这个检查证明声明的 UI 条件，不代表全文语义相关性、全部搜索结果或业务质量。

生产装配由宿主注入执行器，独立插件缺服务返回 `TASK_HOST_UNAVAILABLE`。脱敏轨迹在宿主 `AppData/android-task-traces/<taskId>.jsonl`：保存参数引用、同包资源目标/后置条件、带随机内存密钥的观察摘要、决策来源、prepared/settled原子回执和独立验证；不保存查询值、原始树、模型自由输出或原始错误。轨迹事件容量按任务预算计算：`maxObservations + 9 × maxActions + 2 × maxModelCalls + 2`，全局最多362事件（不含文件头）/512KiB；预留1个终止事件及4KiB，容量耗尽返回 `TASK_TRACE_LIMIT` 并记录停止原因。逐条写入文件、不在内存累积轨迹，独占创建、不覆写；写失败停止后续动作。取消可能先返回taskId而后台仍排干/关闭轨迹；最后的prepared不代表动作未执行，更不是恢复许可。

本版没有Skill编译/复用、自动修复、持久断点、viewer接管、虚拟屏或通用任务队列。只验证所声明搜索模板，推广前仍须目标App/ROM真机准入。

### Jev 连续搜索（实验性，离线验证）

`decision: "jev"` 时省略 `targets`，仍显式提供 `serial`、`package`、`inputs.query` 与 `completion`。宿主从完整当前控件树生成最多8个唯一同包资源ID候选，搜索相关性由固定中英文标签/资源ID词表建立；Jev选择候选、`wait` 或 `escalate`。支持多级搜索入口→选择输入框→Fill精确读回→选择提交→验证新出现的完成标记。

```json
{
  "command": "RunTask",
  "task": {
    "serial": "YOUR_DEVICE_SERIAL",
    "package": "com.demo",
    "intent": "search",
    "decision": "jev",
    "inputs": { "query": "本次关键词" },
    "completion": { "type": "visible", "id": "com.demo:id/results" },
    "budget": { "timeoutMs": 60000, "maxActions": 6, "maxObservations": 96, "maxModelCalls": 8 }
  }
}
```

复用全局 Jev 设置与宿主服务，每次请求最多2秒、零重试。固定最多8轮、2次等待；模型等待期间持有设备租约，返回后复采、最后派发前再次核对观察/epoch/TTL。任一未知写、页面失配、循环、候选歧义、预算耗尽或无法证明进度均停止，不重放。密码表单直接拒绝；缺搜索语义或唯一资源ID时不猜测目标。模型只能选宿主生成的候选，不能改变输入、完成条件或批准策略。

`search-v1` 采用最高概率≥0.9、领先差≥0.2的暂定策略，**尚未通过真实模型任务数据校准**，返回 `experimental:true`、`decisionPolicy.calibrated:false`。本轮只有注入模型响应的离线闭环证据，未调用上游模型、未操作真机。它不使既有 `Observe mode=arbitrate` 建议获得执行权。词表外页面、无资源ID控件、任意表单/导航、业务结果内容验证、Skill学习仍未交付。见[Jev循环记录](../../../docs/android-controller/2026-11-06_android-jev-loop-report.md)。

## ExecuteStep：动作、验证与下一次观察

```json
{
  "command":"ExecuteStep",
  "serial":"YOUR_DEVICE_SERIAL",
  "action":{"command":"Tap","id":"com.demo:id/open"},
  "expect":{"type":"visible","selector":"text=详情"},
  "afterObserve":true,
  "timeoutMs":15000
}
```

`action/expect` 接受对象或 JSON 对象字符串。动作仅允许 Wait、Tap、DoubleTap、Swipe、Scroll、ScrollUntil、Drag、Pinch、LongPress、InputText、Fill、ImeAction、EraseText、KeyCombo、KeyEvent、LaunchApp、KillApp、System、Handoff、Collect；DoubleTap、ScrollUntil、Drag、Pinch 及新增键盘动作仍为实验状态；Click/Type/PressKey 别名已删除；不允许递归、连接管理或覆盖外层设备。

- `id/text/selector`：动作前重新采样定位；M2 selector 规则见下节。显式字符串 `id=/text=` 的字面量 `%/#` 编码为 `%25/%23`，直接 id/text 与对象条件无需编码。
- `index`：必须携带同设备 `snapshotId`，15秒过期，执行前复核内容、布局和尺寸。
- 像素坐标：必须携带同设备可操作的 `frameId`，15秒过期；使用设备坐标，不是图片坐标。动作前重新采样上下文，比对前台包/组件/窗口、逻辑尺寸、旋转、默认显示器、唤醒及明确未锁定状态，变化或无法确认返回 `STALE_FRAME` 并撤销凭据；采样后再次检查过期/取消。Tap、LongPress、DoubleTap、Swipe及Drag所有像素端点共享该规则，混合Drag还拒绝语义树与图像的包名/旋转冲突。该检查不保证截图后内容/布局没变化，也不提供检查到派发之间的原子性。坐标、索引及动作时长只接受安全整数或十进制整数字符串，不取整、不把布尔值转换为数字、不接受十六进制或科学计数法字符串；Swipe 时长1–10000ms，LongPress 时长300–10000ms。
- 所有输入动作使旧 UI/图像凭据失效。InputText 只向当前焦点的光标/选区输入，不自动清空或定位字段。非 ASCII 通过设备 RPC 设置系统剪贴板，再用 `KEYCODE_PASTE` 贴入光标（默认；`CLIPBOARD_PASTE=rpc|keyevent|off` 可切换）。两条路都不依赖当前 IME；都会替换系统剪贴板，**不自动恢复**，派发成功不代表粘贴结果已验证。`pasteClipboard` 在本机 ColorOS / Android 17 上是确定性 `AssertionError`，故默认不走它；选 `rpc` 时一旦被拒，同一服务世代内会改走 `keyevent`，不会对着死通道反复敲。仅 RPC 明确未执行时才尝试 ADBKeyboard 回退；每次广播前读取当前输入法，不匹配或无法确认时返回 ADB_KEYBOARD_NOT_ACTIVE，不自动切换输入法。
- Fill 是目标文本字段的替换操作：`text` 必填且支持空字符串；用 `id`、`selector=id=…` 或 `index+snapshotId` 寻址，目标必须是当前可见、enabled 的 textfield，且原始树中设备 RPC 身份唯一。非空文本通过设备 RPC `setText` 替换，空字符串调用 `clearTextField`；非密码字段用 `getText` 字符串逐字读回，首尾空白也须一致；仅清空操作允许随包载体已实证的单个结构性换行 `\n` 等同空串。非字符串读回立即停止验证；不匹配或无法验证为 `unknown`，匹配才是 `verified`。密码字段不读回，只有 `dispatched`，外层 `expect` 也不会将其洗成字段值 `verified`，不回显字段值。RPC 不可用时拒绝，不用 shell 全选/删除模拟替换。
- Tap、LongPress、Swipe（包括 Scroll 的受限手势）优先 RPC，只有明确未执行时才回退 shell。RPC 超时、断连、取消或其他未知执行结果均不重放，防止一次触摸变双击；最终通道与结果以动作回执为准。长按优先原生 `click(x,y,duration)`，第三参是**按压时长 ms**；仅明确未执行才降级到起止同点的 RPC `swipe`（`steps ≈ duration/5`），仍明确未执行才使用 shell。所有 RPC 调用在发出前按 `lib/rpc-methods.js` 的签名表校验参数形状，形状错误一律本地拒绝（`dispatched=false`），不会发到设备上赌。

### M2 selector：组合定位（experimental，当前代码待真机复验）

字符串支持 `id=…`、`text=…`、`desc=…`、`any=…` 及旧 `#N` 后缀：`id=…#2` 仍按 **XML 顺序、一基** 取第2个，不改成屏幕排序。`text` 仅原始XML text，`desc` 仅原始content-desc，`any` 仅完整聚合label，三源不互相回退。`contains=…`、`regex=…` 仅匹配原始text；`class=…` 匹配短类名或完整类名，`role=…` 为语义角色。不存在anyContains/anyRegex。未发布接口直接切新分源契约，不保留旧text聚合含义。

组合对象为 `{id?,text?,desc?,any?,contains?,regex?,class?,role?,nth?,within?,childOf?,siblingOf?,hasDescendant?}`，至少包含一个匹配条件，条件取 AND；各字符串条件保留原文空白、最多4096 UTF-16字符。`nth` 只接受非负**数字安全整数**（不接受字符串），按 `top,left,bottom,right,index` 升序取**零基**第 n 个；它只消歧当前屏幕，不是可跨页面复用的身份。裸 selector 多匹配拒绝，不默认取首个。`within` 限定唯一原始树祖先的严格后代；`childOf` 限定唯一父节点的直接子节点；`siblingOf` 限定唯一锚点的同父兄弟，不含锚点自己；`hasDescendant` 要求存在匹配后代，多个后代不使父节点歧义。关系值可为字符串或组合 selector，关系不可嵌套，遍历消耗查询工作预算，证据不足不能证明 absent。

regex 模式最多512字符、待匹配原始text最多16384字符，总查询工作预算8Mi；超预算证据不完整，不得当作absent。优先使用可用的 RE2，否则只接受线性时间受限语法：字面量、`.`、字符类、边界 `^/$`、基础转义及单个 `* + ?`。后备语法拒绝分组、交替、计数重复、回溯引用及前后瞻，不交给 JS 回溯正则赌运行时间；不支持外置 flags。

```json
{"selector":{"text":"确定","class":"Button","within":{"id":"com.demo:id/dialog"},"nth":0}}
{"selector":"text=确定#2"}
```

扩展 selector 不下推到 ScrollUntil：它仍仅接受精确 id/text，拒绝 ordinal/组合/模糊/正则。**Fill / EraseText 的严格寻址与字段约束完全不变**，不因扩展 selector 放开 contains/regex/class/role/nth/within。Drag / Pinch 即使通过 nth/within 唯一选中可见控件，原始树中的完整 class/package/resourceId RPC 身份仍须唯一；屏幕消歧不能消除原始身份歧义。

`expect` 支持 `{type:visible|absent,selector}`、`{type:foreground,package}`。截断或锁屏不能证明 absent；UI条件不能证明自绘画布中不存在目标。前台包名只证明前台状态，不证明业务提交。

`afterObserve` 默认false。`true` 返回新语义观察；也可对象或JSON对象字符串：`{mode:ui|image,limit?,screenshot?,region?,target?,id?,selector?,index?,snapshotId?,padding?,maxWidth?,format?,quality?,grid?}`。`mode=image,target=element` 返回上述实验性元素图，复用相同寻址、互斥、padding 和前后采样验证规则；未指定 target 时仍为普通图像，不自动改为元素图。参数在派发前校验，不允许设备覆盖、额外 stable/settled 采样或仲裁；元素图自身所需的前后复核不省略。limit（1–500）、maxWidth（64–4096）、quality（10–95）只接受安全整数或十进制整数字符串；布尔值、数组、空值、十六进制和科学计数法字符串在输入前拒绝，padding 仍只接受数字。成功且新鲜的UI验证采样直接复用，保留原采集时间与来源，不把之后读取的前台信息拼到旧树上。普通UI条件样本仅声明树中包名、不声明组件/窗口；idle样本保留已采集上下文。其他情况重新采样，禁止在动作后观察中唤醒屏幕。回执位于 `details.observation`；采集失败独立标记 failed，保留原动作结果，不重放。取消和总预算到期继续抛错，不吞成普通采集失败。

### DoubleTap：实验性双击

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"DoubleTap","id":"com.demo:id/target"},"afterObserve":true}
```

寻址与 Tap 相同，一次定位后固定设备和坐标，在同一租约内发两次 RPC `click(x,y,20)` 短按。随包服务两参click固定按住100ms，会耗尽ACK顺序双击窗口；显式20ms只调整按压时长，不放宽窗口。以首击开始调用 RPC 的单调时刻为起点，目标派发间隔100ms；首击 ACK 延迟从等待中扣除，第二击开始派发必须仍在120ms内，ACK 和服务就绪等待都计入窗口。总 `timeoutMs`、可信取消和后置验证仍共用原预算；不在两击之间采树、唤醒或重定位。窗口错过报 `DOUBLE_TAP_WINDOW_MISSED`，不补一个迟到的单击；宿主派发窗口不等于设备实际触摸时序。**PJZ110 / Android17固定靶场已独立识别双击**（本轮invoke开始差111.554ms），不外推其它ROM/App或更慢链路。

只供显式调用，不进入自动降级链。无 shell 回退、无重试，每击独立记录 attempt；首击成功但第二击取消、超时或明确未派发，整体仍为 `unknown`，保留首击副作用、`retryable=false`。成功与异常回执均标 `experimental=true`，`pressDurationMs=20` 是每击原生按压时长，`intervalMs=100` 是两次宿主 RPC 的目标派发间隔，不是设备触摸间隔测量。无 `expect` 只有 `dispatched`；有 `expect` 时的 `verified` 只证明该条件，不证明 Android 将其识别为双击。


### Wait：只读条件等待

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Wait"},"expect":{"type":"visible","selector":"text=加载完成"},"waitTimeoutMs":5000,"afterObserve":true}
```

普通 Wait 必须声明 expect，action 只接收命令标识；M2 新增 `action={command:"Wait",mode:"idle"}`，独立单步或序列末步可不带 expect。两种模式都不接收 duration/坐标/输入参数或动作内设备字段，不输入、不唤醒、不提供固定 sleep。普通模式复用 visible/absent/foreground 条件轮询；两种模式共享 `waitTimeoutMs`（默认5000ms，范围1–30000ms）及整步/整段 timeoutMs、可信取消预算，idle 后若另有 expect 不重置等待预算。

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Wait","mode":"idle"},"waitTimeoutMs":5000,"afterObserve":true}
```

idle 为 experimental，当前代码待真机复验。原生 `waitForIdle(timeoutMs)` 最多调用一次，设备等待上限1500ms，仅是 best-effort hint。随包 APK 的 QueryController 已实证吞掉 TimeoutException，所以 native void/null/成功返回都**不能**直接标记 `ui_automation_idle` 或 verified。之后必须有两次间隔200ms、同一前台/屏幕上下文、完整且可见的原始布局采样一致，才以 `idleMode=layout_stable` 验证；隐藏/裁剪状态也纳入完整性检查，不以截断语义表代替原始布局。布局稳定不等于像素静止、网络完成或业务成功。native 传输超时、断连、取消及执行状态未知不后备采样、不重试；仅已排干且明确不支持/设备 idle 超时或原生不可用时可转布局采样，仍不放宽证据要求。

普通 Observe、动作定位、动作/读回 RPC，以及 M2 等待/元素采样统一使用同一隔离边界。错误中的 `dispatched=false` 证明本次请求明确未派发/未执行；`drained=true` 表示本次请求未发出，或已收到完整、匹配且结构有效的 JSON-RPC 响应，不代表业务成功、设备静止或远端服务进程终止。已派发且缺乏排干证据（超时、取消、断连、HTTP错误、无效/超大响应等）的业务 RPC 会使设备进入 `DEVICE_STATE_UNCERTAIN`：旧 UI/图像凭据失效，同调用不再 CLI 回退、稳定性补采或 afterObserve 采集；后续同设备 Observe/ExecuteStep、自动选设备及设备管理变更拒绝。显式指定的其它未隔离设备仍可操作，动作历史与宿主状态仍可查询。

明确未执行或已完整响应的普通读失败仍可受预算约束地回退 CLI；错误 payload 或完整响应解析后超过请求预算不自动等于远端未排干。写动作仅 `dispatched=false` 才允许原有受限回退：即使 `drained=true`，设备业务错误、返回 false 或迟到响应都不能授权重放。Fill 读回的派发结局未知会如实标记 `unknown`，不伪装成未派发。

隔离不会被普通reconnect、销毁本地socket、停止本地adb、ping成功或人工“已停止”断言解除。恢复入口是 `Manage operation=recoverOwner` 且必须显式serial：仅本会话可信owner记录经独立消失证明返回released后才清隔离，并撤销snapshot/frame与上下文epoch；缺记录或无法证明则继续隔离。它不接受force/approval，不重放失败动作、不自动启动新业务。启动失败携带quarantined时不得回退CLI，新Service即使UI_SERVER=false也必须遵守原owner隔离。2026-11-05已通过本机owner生命周期、无线ADB重连与失联租约专项；真实在途未知写入注入仍未做，不把文件SHA当运行owner身份。

owner 每5秒通过认证控制通道续约，连续30秒未续约由设备端自行退出；失效控制转发会核验归属后重建。主机退出、ADB断开或隔离会停止续约，停止/恢复仍等待独立进程与端点消失证明。该机制只适用于新版owner，不会自动清理缺少可信记录的旧版孤儿。验收与边界见[修复记录](../../../docs/android-controller/2026-11-05_android-owner-rebind-report.md)。


满足条件为 verified，未证实为 unknown；这里 unknown 不表示 Wait 派发过输入。idle 失败不能被额外 expect 洗绿，必须先确认 idle 才可验证额外条件。序列中间步仍必须显式 expect（包含 idle），未证实立即停止，取消/总超时抛错；若先前步骤已输入，整段仍可能有副作用，不能整段重试。锁屏/截断不能证明 absent，foreground 只证明前台包名，不证明页面加载。afterObserve 可复用成功且新鲜的UI采样，元素图仍执行自身前后复核。


### Scroll：单次语义滚动

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Scroll","id":"com.demo:id/list","direction":"down","distance":0.6},"afterObserve":true}
```

目标用 id/text/selector 或 index+snapshotId 指向当前可见、启用并带 scroll 标记的容器。不用先截图，不接受像素坐标；实时复核目标并将手势限制在屏幕内可见矩形。direction是浏览方向：down手指向上、up手指向下、right手指向左、left手指向右；不推断RTL或反向布局。distance为可见容器对应轴长比例，默认0.6、范围0.1–0.9；duration默认300ms、范围1–10000整数。容器太小拒绝执行。

只派发一次，不自动重试、不循环寻找目标、不声称已到边界或列表实际移动；用expect验证目标出现，或afterObserve查看新页面。输入后旧凭据失效，沿用设备租约、取消和总预算。它是基于语义目标的受限触摸手势，不是常驻无障碍服务的原生scroll事件。


### ScrollUntil：有界寻找可见目标（实验）

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"ScrollUntil","container":"id=com.demo:id/list","target":"text=目标","strategy":"host","direction":"down","maxSwipes":10},"timeoutMs":30000,"afterObserve":true}
```

`container` 必须是当前可见、启用、身份唯一的滚动容器 ID；`target` 为精确 `id=` 或 `text=`，可不在初屏。只解码 `%25/%23`，不支持 ordinal `#N`、模糊/正则或像素坐标。目标须在同包、同容器子树内且与祖先裁剪后的可见视口相交，不把别处同名控件算成功；重复身份拒绝。

- `strategy=auto` 默认优先已就绪 RPC；显式 `maxSwipes` 或 `direction=up|left` 在写前选择 host。readiness 状态未知则失败，不靠试写判断策略。
- `strategy=rpc` 单次 `scrollTo(containerSelector,targetSelector,isVertical)`，设备内部如何搜索由设备端控制；只提供 down/right 的轴选择，不承诺宿主逐轮方向/次数。与 `maxSwipes`、up/left 混用本地拒绝。
- `strategy=host` 每轮实时采样并执行一次 shell swipe，`maxSwipes` 默认10、范围1–20；方向和现有 Scroll 相同。坐标受容器/屏幕/祖先滚动视口共同裁剪。

策略一旦进入写调用就固定，RPC 明确未派发也不静默转 host；任何未知结果、采样失败、前台包/尺寸变化或取消都停止。只滚不点、不唤醒、不解锁。初始已可见可无输入 verified；写后独立采样可见才 verified；次数耗尽未见目标为 unknown，保留进度，外层 `expect` 不得洗绿。全部轮次与 RPC 共用一份总预算。`swipes` 仅计 host 实际派发次数，RPC 路径不猜设备内部次数。

### Drag / Pinch：设备原生触摸流（实验）

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Drag","id":"com.demo:id/source","target":{"id":"com.demo:id/destination"},"steps":60}}
```

Drag 源沿用 Tap 寻址；终点为语义 `target={id|text|selector 或 index+snapshotId}`，或 `x2,y2,frameId`（不得同时指定）。源像素参数是 `x,y,frameId`，不是 `x1,y1`。两端共享一次实时采样、屏幕尺寸和旧快照检查；语义终点取可见裁剪矩形内中心。语义源调用 `dragTo(selector,x,y,steps)`，像素源调用 `drag(x,y,x2,y2,steps)`；不是长按+Swipe。

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Pinch","id":"com.demo:id/canvas","direction":"out","percent":50,"steps":60}}
```

Pinch 只接受当前可见启用语义目标，绑定原始树完整 class/package/resourceId 唯一身份，调用 `pinchIn/Out(selector,percent,steps)` 一次。`percent` 为必填1–100整数；尚不暴露自定义两指 `gesture` 点列。

两动作可设 `steps=1–2000`（默认60），或 `duration=1–10000ms`，互斥；duration 按5ms/step换算（最少1step）。参数只接受安全整数或十进制整数字符串，隐藏/祖先不可见目标、重复原始身份、过期或跨设备凭据均在写前拒绝；M2 selector 的 nth/within 不会放宽原始 RPC 身份唯一约束。RPC 失败不回退 shell/scrcpy，不重放；无 expect 仅 dispatched。RPC 成功不证明拖放/缩放已被应用识别。

### 键盘：显式动作与有限退格（实验）

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"ImeAction","imeAction":"search"}}
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"KeyCombo","keyCode":29,"metaState":4096}}
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"EraseText","id":"com.demo:id/query","count":3}}
```

`ImeAction` 仅接受小写 enter/search，对应 `pressKeyCode(66/84)`；显式 `metaState` 则调用双参重载。不存在设备 `sendAction` 原语，不把 Enter/Search 等同业务提交成功。`KeyCombo` 要求数字 `keyCode` 与数字 `metaState`，只允许模块固定文本/导航键集合，修饰掩码为 Android `0x7770ff` 的子集；不拆成可能遗留按下状态的多步按键。

`EraseText count` 为数字整数1–100，含义是**最多 DEL 次数，不是删除字符数**。需实时唯一可见启用、稳定 resource-id、原始树唯一 focused 的非密码字段；不点其它字段聚焦，不猜光标/选区。每击重新采样与逐字 `getText`，不裁剪空白；读到空即停止，初始为空报 `ERASE_EMPTY` 且零 DEL；无变化/异常/目标变化立即 unknown 停止，不补发。旧值读回也可能安全停止为 `ERASE_NO_PROGRESS`，不通过重发掩盖时序问题。没有光标 API，选区可使一次 DEL 删除多字符。焦点检查与系统按键注入无法原子化，故保留实验标记。密码拒绝，回执/历史不含字段内容。

三动作都只走 `pressKeyCode` RPC、无 shell 回退，复用同一租约/取消/总预算，未知不重放。`hideKeyboard` 没有稳定设备原语，仍不提供自动返回键或 IME 切换策略。

### Manage actionHistory：纯读脱敏历史

```json
{"command":"Manage","operation":"actionHistory","serial":"YOUR_DEVICE_SERIAL","limit":20}
```

不连接设备、不抢动作租约、不重放；在线动作执行中及设备离线时均可读取。每设备最多100条、最多32设备，按最近写入淘汰；进程内内存，重启丢失，不落盘。`limit` 只接受数字整数1–100，不接受数字字符串；省略 serial 仅在历史恰有一台设备时允许。

返回 `entries` 新→旧：requestId、固定 command/outcome、durationMs、序列 stepIndex，以及可选最后 attempt 的白名单 channel/method/status/code。每步终态恰记录一次；取消/总超时后迟到 RPC 排干不改写历史。没有动作参数、坐标、字段内容、selector、URL、expect 或错误原文，不是重放日志。

### LaunchApp：受限网页导航

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"LaunchApp","package":"com.example.browser","url":"https://example.com/"},"afterObserve":true}
```

url模式要求明确package，只允许1–4096字符http/https地址；拒绝账号密码、控制字符（含百分号编码）、空白、反斜杠及activity/stop=true。不接收任意intent、scheme、extras或系统设置URI。先解析指定包内唯一VIEW+BROWSABLE组件，再显式启动一次；解析失败不派发，不回退其他应用或monkey。参数经过设备shell引用，URL和原始ADB输出不进入回执。

verified仅表示指定包处于前台，pageLoaded=null，不证明URL路径到达或网页加载完成。浏览器/应用仍可能重定向、跳转其它应用或执行网页逻辑；这不是网络沙箱，不应用于未知副作用链接。需要页面证据时用afterObserve或显式expect；既有应用前台本身不能证明此次导航完成。


### 有界短序列

```json
{
  "command":"ExecuteStep",
  "serial":"YOUR_DEVICE_SERIAL",
  "steps":[
    {"action":{"command":"Tap","id":"com.demo:id/search"},"expect":{"type":"visible","selector":"id=com.demo:id/query"}},
    {"action":{"command":"Tap","id":"com.demo:id/query"}}
  ],
  "afterObserve":true,
  "timeoutMs":15000
}
```

steps接受数组或JSON数组文本，1–8步；每步只允许action/expect/waitTimeoutMs，与外层action/expect/waitTimeoutMs互斥。只组合已有GUI动作，禁止System、管理和递归。整段结构在第一步前校验，具体动作参数仍在各步派发前检查，因此不保证后续无效参数会在第一步前被发现。

中间步必须显式expect，满足才继续；末步允许仅派发。整段共享一个设备租约、可信取消信号和总timeoutMs；waitTimeoutMs不能延长总预算。后续步骤必须实时语义定位，禁止index/snapshotId/frameId/像素坐标及设备覆盖。输入当前焦点的风险不因批执行消失，InputText不是Fill。

结果details.sequence及模型正文保存逐步index/command/outcome/verification，execution.sequence也保存同一进度。unknown立即停止；异常/取消/硬超时返回已完成和在途状态，未执行步骤不伪造结果。afterObserve只在末尾或验证停止后采集，不回传各中间页面截图；异常不自动再采集。当前步派发后未知不会继续下一步，也不会自动回滚或整段重试。completed只说明队列走完，不证明业务任务完成。


### 模型可见回执

正文的独立 JSON text part 与 `details.execution` 同时保留 `requestId/serial/outcome/verification/timings/retryable`。VCPToolBox 的富内容回灌只使用 content，不能只把关键信息放在 details。

- `observed`：只读观察或系统读取结果。
- `dispatched`：仅派发，不代表业务成功。
- `verified`：指定条件或系统读回满足，不等于业务全局成功。
- `unknown`：动作可能已生效，但未证实，禁止直接重试。
- `failed`：异常时未记录派发；不因此保证任意重试安全。

`retryable=false` 表示插件不批准自动重放。异常保留 `code/execution`，error.message 追加最小回执，兼容只传错误文字的现有链路；不序列化动作参数或原始采集错误。耗时为主机入口内测量，不含上游推理、外部传输或真实输入到光子的延迟。

### System：继续使用现有授权

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"System","operation":"read","capability":"batteryLevel"}}
```

必须外层显式 serial，不使用默认设备。到全局设置 → Android 系统授权，确认设备、风险与分项授权并保存。撤销同样保存后生效；每个变更派发前重新检查。只支持主用户0，不接受模型 approved、任意 shell/URI/intent/extras/provider。

支持固定读取、公开设置页、四项绝对设置（brightnessMode/screenTimeout/autoRotate/userRotation）和用户完成的拨号/短信/联系人/日程草稿。设置前读→写一次→读回；unknown不重试。草稿不自动拨打、发送或保存，但无法保证第三方处理程序行为；接收人、正文不回显。系统授权不覆盖通用GUI工具，不是全局安卓沙箱。详细边界见[系统适配记录](../../../docs/android-controller/android-system-adaptation.md)。

## Manage：连接与显示

`operation=connect|reconnect|disconnect|startDisplay|stopDisplay|displayStatus|actionHistory|recoverOwner`。`recoverOwner`必须显式serial，按本会话owner独立消失证明解除隔离，不接受force/approval，不重放动作；证据不足继续隔离。connect 支持 mode=auto|wireless|usb、address/serial；首次配对优先用显示屏向导。startDisplay 的 open=true 复用 Loom 侧栏。管理事务与设备动作互斥，不能打断已占用设备。disconnect 先释放对应设备的RPC会话，再断开ADB；未指定设备时先释放全部会话。owner退出未证明时保留连接与恢复证据，返回 `UI_SERVER_OWNER_QUARANTINED`，不执行ADB断开。

设备操作 `timeoutMs` 默认60000，范围1–300000，覆盖准备、排队、动作、验证及动作后观察；waitTimeoutMs 默认5000，范围1–30000，限制条件等待及 idle 等待，二者共用同一等待预算，不延长总预算。可信取消来自执行上下文，不从模型JSON接收。已派发动作不能自动回滚；无法中止的依赖排干前仍保留设备租约。ADB容量默认64，队列满立即失败，排队消耗总预算。分布式远程取消协议尚未端到端补齐。

显示屏只监听loopback；viewer导航获取内存会话cookie，WS要求精确Origin和会话，写API额外检查Origin。这防浏览器跨站，不隔离恶意本机进程。scrcpy按代隔离socket；无观众停采，静屏不因没有新帧而重启。

VCPChat 的应用启动台、常用应用抽屉和 V 桌面提供「安卓」入口，打开同一个独立显示窗口。窗口等待现有分布式服务与插件就绪，使用实际分配的回环地址；不可用时显示可重试错误页，不另建控制器。显示页沿用应用主题，无设备时不自动扫描或连接；扫描、配对、连接由用户显式触发。关闭窗口仅释放自身订阅，不停止共享显示服务或 M5 任务。此页是人类只读原始屏幕通道，不受 AI 的 denyPackages 读门遮屏；没有触控、键盘接管或任务恢复功能。多设备列表只声明就绪状态，不把列表行当成独立设备选择器。

## 交互策略与分层身份

在插件配置中设置 `INTERACTION_POLICY`，类型为JSON对象字符串，默认 `{}`：

```json
{"denyPackages":["com.example.blocked"],"readOnlyPackages":["com.example.readonly"],"confirmEveryWrite":false}
```

`denyPackages` 拒绝对应包的读返回和写派发；`readOnlyPackages` 只禁止写。启用包规则但无法确认归属时拒绝，配置错误也拒绝，不静默退回默认值。Observe UI/图像/仲裁、afterObserve和stale附屏共享读门；语义/像素/键盘/System输入共享写门，派发前再次读取当前策略并核对当前/目的包。既有System设备分项grant仍独立必需，不因包策略允许而扩大系统白名单。

风险预标记与派发共享 [interaction-policy](lib/interaction-policy.js) 的唯一词表，只分类短完整控件标签/desc和ID，不扫描长聊天/字段全文。启发式不证明覆盖所有敏感效果。默认 `{}` 对敏感写要求逐次确认；`confirmEveryWrite=true` 要求每次写均确认。VCPChat 主进程注入可信原生对话框服务，批准绑定设备、当前任务、动作、完整原始界面及策略摘要；最多等60秒，且不超过任务剩余时间，批准后重采样，不一致拒绝执行。取消、超时和迟到的批准不生效；无服务时仍拒绝。模型 `confirmed`、`approval` 或 executionContext 不能代替人的回答，deny/readOnly和System分项授权不能被覆盖。index/frame旧凭据不能借等待延长TTL，需要实时语义目标。DoubleTap同一有界双击只确认一次，第二击仍复核策略。

STALE类凭据拒绝保留原错误；仅设备未隔离、读策略允许且预算/取消允许时补一次 `wake=never` 观察。否则 `details.screen=null` 并返回 `screenReason`，附屏失败不覆盖原错误，不唤醒、不重放原动作；附屏的新快照也不是批准。

[code-identity](lib/code-identity.js) 每次摘要当前生产JS、vendor与manifest字节；不读Git对象/配置秘密，不执行命令，不用mtime缓存替代内容。缺失、不可读、符号链接或读时变化使 `identity.code.complete=false`。Node/OS/ROM/config/workload各自形成性能环境摘要，与代码身份分离；缺ROM等维度不冒充性能可比。能力摘要另绑定carrier、session generation与设备证据；必须代码/能力均complete才可复用证据，`identity.authorization=false`，不凭同一hash批准输入或声称ROM准入。历史性能采集脚本与旧基线未因此自动迁移。

## 人工交还与有界列表采集

`Handoff` 用于验证码、人工登录等需要人在手机上处理的步骤：

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Handoff","reason":"请在手机上完成登录，然后选择继续"},"afterObserve":true}
```

它持有当前设备租约，在原调用中等人选择“继续”或“停止”；等待前后撤销snapshot/frame。包含Handoff的单步或序列，timeoutMs默认及上限为600000ms，仍共享整段截止时间。继续只证明人已交还，设备效果仍需expect验证；中间步骤必须expect。停止或超时为unknown，不重放先前步骤，也不保存跨调用的恢复令牌。Handoff不批准后续敏感写。宿主复用现有服务注入和VCPToolBox的cancel_tool传输，断线/停止取消等待；旧连接迟到的结果不进入新连接。

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Collect","container":"id=com.demo:id/list","maxPages":5,"direction":"down","until":"text=结束"}}
```

Collect采容器当前可见启用后代，需要翻页时调用现有Scroll，受同一租约、策略、总预算和取消约束，因此是可能产生输入的动作。maxPages默认10、范围1–30，仅数字整数。每页最多100项，text/desc/label预览120字符，包含来源page与ordinal；保留合法重复，不按文字合并。只有未截断的UNTIL_MATCH验证声明的停止范围；NO_PROGRESS、MAX_PAGES或截断为unknown/partial，listEndProven始终false，不代表全列表完整。异常不附带已采文本；未知输入停止，不自动重试。maxPages=1不会翻页。

ScrollUntil使用`visibility.contract=scroll-axis-interior`：目标的观察到的可见区域必须在滚动轴上严格离开容器两端边缘，贴边碎片不算成功。它不推断Android已裁剪bounds背后的完整元素尺寸，不给出虚构可见百分比，也不证明无遮挡。RPC和host采用同一判据；RPC动作之后不切换策略补滚。

真正IME editor action、完整窗口ID/type/layer、跨display输入、持久化长任务与后台虚拟屏仍未交付；ImeAction明确是66/84按键语义，windows=true仍是只读多root诊断。

## 模块边界

- AndroidControllerService：四入口路由、设备选择、观察凭据及动作编排；设备执行沿用 step-runtime 的租约、预算与回执。
- lib/expectation-wait：单个条件的有界只读轮询，一次编译选择器；沿用外层租约、取消与截止时间，成功时返回原始采样供后置观察复用。
- lib/device-network：地址/配对码解析、网络诊断与有截止时间的 LAN 发现，不访问控制器状态。
- lib/loom-display-url：可选宿主地址同步；读取并保留已有 manifest/CSS/JS，读取失败不覆盖应用。
- lib/stream-server：观众订阅与恢复；同 socket 共享在途就绪 Promise，probe 单飞，最后 H.264 意图撤销时停止编码器，不中断 JPEG 观众。

服务 `cleanup()` 同步关闭工具、设备管理及显示启动入口，再取消并等待真实在途操作、管理事务和截图排干，最后释放资源；显式 `initialize()` 完成后才重新接收调用。已隔离设备即使在清理时成功释放 owner，也保留恢复证明，仍需 `Manage recoverOwner` 显式解除隔离。

H.264 新观众和重同步只接收当前配置及可连续解码的关键帧；旧关键帧之后已有增量帧时，等待新关键帧，超时临时显示 JPEG，关键帧到达后释放 JPEG 订阅并恢复 H.264。旋转后旧配置与关键帧一起失效。流解析器按包分配独立缓冲，分片复制量随输入线性增长，消费完立即释放组包缓冲；单包上限为 16 MiB。

删除了仅测试使用的 scanHostPorts 和同步 defaultGateway；实际发现只保留一个异步、有总预算的 LAN 扫描实现。不引入新的服务容器或兼容注册层。

## 范围与回归

回归数字、真机结论与阶段档位见 [docs/android-controller/README.md](../../../docs/android-controller/README.md) 的状态表（含同日首跑 `adb-budget` 抖动的记录）。原始日志、失败轮次和代码摘要见[收口报告](../../../docs/android-controller/2026-11-05_audit-android-pre-m3-report.md)。历史32项policy/identity专项不再作为当前全量数字。

2026-11-04 历史首批：**1740/1740离线通过，0失败/取消/跳过，14.213s**（完整隔离矩阵含M1.5/M2 CLI测试）；生产JS与验收runner语法检查、限定差分空白检查通过。载体改为本地SHA-256内容寻址、设备读回复核与每generation文件证据；已知不符push后仍不符拒绝，不可校验明确unknown，ADB/push错误不降格。scope=startup_file，不证明运行owner或远端已终止；能力失败缓存随世代失效，旧paste RPC迟到错误不污染新代。固定靶场idle仅由可信context hook输出已有sample/dump时间、完整摘要与有界纯几何，不加设备请求、不改稳定判据或验收断言；dumpFreshness仍unproven，真机NOT_PASSED不变。

[A/B/C路线复核](../../../docs/android-controller/android-controller-route-review-2026-11.md)：随包APK已有rootInActive=false多窗口根分支、API30+多display枚举和内部事件listener；宿主默认仍active root，未建立结构化窗口/通用事件订阅契约，不因API/DEX存在宣布设备准入。不启动已安装helper App重写，不切换multi-root；B需新设备后端与认证生命周期，不只是替换Transport。

代码审查与有界重构（2026-11-03）：本轮完整离线回归 **1462/1462通过，0失败/取消/跳过，14.564s**，较既有套件新增37条；`node --check` 与限定差分空白检查通过。修复精确Fill读回、采样来源混拼、取消后额外请求、UI forward生命周期/所有权、原始节点来源与隐藏后代布局证据；条件轮询独立、动作工厂只装配一次、移除聚合全文的图层二次扫描。未操作真机，不替代下面的M2真机NOT_PASSED结论；边界、证据与未修问题见[代码审查记录](../../../docs/android-controller/android-controller-code-review.md)。

第二轮架构收敛：**1496/1496通过，0失败/取消/跳过，14.947s**，新增34条（ADB调度18+生成选择器16）。ADB按设备串行、跨设备并行，管理命令为全局FIFO屏障；精确host只读发现可与设备并行但不跨屏障，总容量仍默认64且无闲置serial队列累积。提交参数副本固定分类与执行，避免可变argv绕过屏障。生成selector复用真实解析器确认原样可消费，无法表达的行返回`selector:null`并提示仅用新鲜`index+snapshotId`；不扩大4096条件预算、不降级成其它匹配身份。同文本ordinal按完整动作匹配全集计数，修复带ID/无ID混排指错行。预算测试仅适配VM相对依赖解析，原断言未改。未跑真机；完整边界与剩余P1见[代码审查记录](../../../docs/android-controller/android-controller-code-review.md#第二轮设备调度与可消费的选择器契约)。

尚未实现：自主规划、持久化长任务、通用deep link、手机文件传输、写业务API、自动GUI回退、Jev图片/Box、常驻无障碍服务、H.264模型共享帧。VCP异步结果保存/通知不等于自动续跑Agent，不另造并行执行框架。历史真机与API证据见[P2验证记录](../../../docs/android-controller/android-p2-validation.md)，不作为本轮真机验收。

M2 RPC ABI 实证：随包 APK selector 的 `PACKAGE_NAME=524288`，`INSTANCE=16777216`；两者不是同一位，不允许拿旧 INSTANCE 误位表示 packageName。`waitForIdle` 是只读、experimental 的一参 RPC，参数仅数字安全整数1–2000；idle 编排进一步限原生等待≤1500ms。真实 loopback HTTP 签名测试覆盖有效调用与本地拒绝，invalid 请求不得发 HTTP；不代表已连接真机验收。M1.5 手造 package mask 测试按此 ABI 更正，不为迁就旧测试保留错误生产掩码。

仓库根目录运行隔离测试，不运行 live 脚本，不执行真实设备动作：

```bash
node --test tests/android-*.test.js tests/android-*.test.mjs tests/adb-*.test.js tests/frame-hub-contract.test.js tests/scrcpy-*.test.js tests/stream-recovery.test.js tests/subscriber-init.test.js tests/ui-graph.test.js tests/vision*.test.js tests/launch-app.test.js tests/focus-parse.test.js tests/auto-connect*.test.js tests/device-reconnect.test.js tests/*jev*.test.js tests/distributed-*.test.js
```

M2（2026-11-03）最新完整隔离回归：**1425 tests / 1425 pass / 0 fail / 0 skipped，15.140s**（含M1.5/M2两套CLI安全测试33条）。覆盖选择器/元素图/idle/公共入口/真实loopback HTTP、受限正则独立参考、raw祖先、隐藏/禁用/长标签完整证据、carrier声明/CLI精确尾行、预算/取消/传输未知隔离，前台切出仍排干清传输，以及idle局部deadline耗尽后已排干ADB只读超时归unknown（提前超时/取消/STEP/UI未知仍抛）。JS语法与限定差分空白检查通过。M2最终第七轮完整真机**13/14，0未执行，NOT_PASSED**。仅动态几何idle未通过：运动前后仍存活/ticks增加，但返回verified/layout_stable；尚未记录两份采样几何，需核清往返轨迹采样重合与期望契约，不能直接声称算法漏运动或改期望盖PASS。定位/序列6项、元素图4项、其它idle3项同轮通过，进程正常cleanup/exit1；见[本轮证据](../../../docs/android-controller/android-m2-device-validation.md)；M3前仍存的可靠性短板见[对标审查](../../../docs/android-controller/android-pre-m3-gap-review.md)。新增能力保持experimental，不把隔离回归或单ROM靶场外推为普遍准入。



M1.5.0–M1.5.6（2026-11-03）实现阶段收束，按上列完整命令独立回归：**1231 tests / 1231 pass / 0 fail / 0 skipped，15.20s**（Node v24.22.2）。含首批929条基线、新增ScrollUntil/键盘/Drag/Pinch/历史、RPC真实HTTP门禁、嵌套target序列预检与RPC ready期间焦点转移回归。另通过 `node --check` 与限定变更文件的 `git diff --check`。现有 ESM package-type 提示不影响结果，未改根包配置。

用户再次授权后，相同APK安装成功。本机PJZ110 / Android17完整独立串行矩阵 **14/14 PASS、0失败、0未执行，deviceAcceptance=PASSED，exit0**：长按800、双击、语义/像素Drag、Pinch in/out、IME enter/search、Ctrl+A/MOVE_END、EraseText2、host/RPC ScrollUntil、历史纯读。双击修复vendor两参click默认100ms按压造成的超窗，改明确20ms短按而不放宽100/120ms派发窗。每项Provider效果独立读回，非插件自报dispatched。完整证据含前次[-99]与初次超窗历史见[真机记录](../../../docs/android-controller/android-m15-device-validation.md)；[路线图](../../../docs/android-controller/android-controller-roadmap.md)同步收束。隔离全回归1231/1231（修复后13.625s）、CLI/suite安全测试22/22通过。未覆盖的其它ROM、App与参数极值不外推，全部新增动作保持experimental。

## M1.5 隔离靶场与准入

[零权限靶场说明](../../../scripts/android-m15-fixture/README.md)包含离线构建、只读探测、串行验收、安装失败实况和未覆盖范围。[安全验收脚本](../../../scripts/verify-android-m15.cjs)默认只列设备、不初始化Service；`--run`要求显式serial且每步前后精确前台包/Awake/未锁/同一会话，通过独立Provider读回，不把派发回执当效果。`--run`首次unknown、fallback或读回不符即结束长序列；完整验收使用`--suite`，每case独立重置并读回，case失败后须先确认租约/队列排干与同会话安全条件才能继续其它case，不重放未知动作。14项同轮通过才记完整PASSED。

```powershell
node scripts/verify-android-m15.cjs --probe --sdk F:/AndroidSdk
node --test scripts/android-m15-fixture/verify-cli.test.cjs
# 必须先正常安装并打开固定靶场；脚本不安装/启动/唤醒/解锁
# 完整14项，host/RPC滚动独立验收
node scripts/verify-android-m15.cjs --suite --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
# 修复后显式局部复验，不将局部绿灯写成完整PASSED
node scripts/verify-android-m15.cjs --suite --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk --only DoubleTap,DragPixels
```

M2完整14项须独立跑新矩阵：

```powershell
node scripts/verify-android-m2.cjs --probe --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
node scripts/verify-android-m2.cjs --suite --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
node --test scripts/android-m15-fixture/verify-m2-cli.test.cjs
```

包含动态文案/原始祖先/nth/歧义/sequence、Provider独立ROI与解码像素、动态几何拒签及原生hint+布局确认/动态超时/无RPC CLI idle。脚本不安装/启动/唤醒/解锁；unknown传输、安全/会话变化停止，前台切出也不跳过排干后的传输cleanup。不提供局部拼接最终PASSED。


## 既有真机烟测

```bash
node scripts/check-android-scroll.cjs SERIAL
node scripts/check-android-scroll.cjs SERIAL --scroll
```

默认只读：先检查电源态，非Awake即失败，不唤醒、不解锁、不输出页面文字。显式--scroll仅在当前页面恰有一个合适滚动容器时，复核前台和设备状态，再按快照执行一次down滚动并返回新观察；无容器、锁屏或前台变化立即停止，不导航应用、不做反向恢复。独立进程只能验证本地插件执行链，不替代运行中VCPChat/ToolBox端到端验收。

URL真机烟测：`node scripts/check-android-url.cjs SERIAL BROWSER_PACKAGE`。只允许固定 https://example.com/，先检查屏幕已亮且未锁定，再导航一次并读取新观察；不唤醒、不输入、不提交、不自动返回原页面。
