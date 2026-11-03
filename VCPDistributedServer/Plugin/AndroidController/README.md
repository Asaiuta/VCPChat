# AndroidController：四入口、受控单步

插件只接受 `Describe / Observe / ExecuteStep / Manage` 四个入口。旧顶层动作、截图、设备管理及能力查询命令已删除，不提供兼容转译；动作统一放入 ExecuteStep.action，截图使用 Observe mode=image，设备管理使用 Manage。工具发现沿用 VCPToolBox 的 `{{VCPDynamicTools}}`，应用操作流程可放入 SkillBridge；联网搜索、文档处理与主机维护使用已有工具，不在安卓插件中复制实现。

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

`mode=ui`（默认）返回语义控件表、页面签名和 `snapshotId`。`limit` 默认60；`screenshot=true` 同时附图；`stable=true` 二次采样，`settled=true/false/null` 分别代表稳定、变化、未知。采集失败报错，不伪装空树。`wake=never` 禁止点亮屏幕；默认 `ifAllowed` 沿用 `AUTO_WAKE` 配置，不自动解锁。

`mode=image` 只采图，不依赖 UI 树。可用 `region`、`target=canvas`、`maxWidth`（默认1080）、`format=jpeg|png`、`quality`、`grid=false`；返回真实 `image_url`、`frameId` 和设备坐标映射。缩图只降低主机输出尺寸，不代表降低 ADB 流量。实时 viewer 是人类观察通道，不等于模型收到截图。

`mode=arbitrate` 显式传 `arbitration={mode:target|page|recovery,snapshotId,goal?,candidates?,targetSelector?,requestTimeoutMs?}`，复用已有快照，不额外 dump。target 最多8个合法索引；规则可确定时不调用模型，歧义复用主进程注入的 GlobalJevService；默认2秒、最多5秒、零重试。只外发脱敏短文本，不发图片、坐标或控件值；其他屏幕标签仍可能含个人信息。结果始终 advisory，不点击、不自动授权；概率门槛尚未完成项目数据校准。

`mode=api` 传 `capability=github-public-issue`、`params={owner,repo,number}`，不访问设备。固定 GitHub HTTPS 匿名GET，无任意URL、凭据、重定向、写入或自动GUI回退。默认5秒、最多15秒、响应上限256KiB。PR closed 不代表 merged。

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

`action/expect` 接受对象或 JSON 对象字符串。动作仅允许 Wait、Tap、Swipe、Scroll、LongPress、InputText、Fill、KeyEvent、LaunchApp、KillApp、System；Click/Type/PressKey 别名已删除；不允许递归、连接管理或覆盖外层设备。

- `id/text/selector`：动作前重新采样定位；显式 selector 的字面量 `%/#` 编码为 `%25/%23`，直接 id/text 无需编码。
- `index`：必须携带同设备 `snapshotId`，15秒过期，执行前复核内容、布局和尺寸。
- 像素坐标：必须携带同设备 `frameId`，15秒过期；使用设备坐标，不是图片坐标。凭据证明来源和年龄，不保证截图后页面未变化。坐标、索引及动作时长只接受安全整数或十进制整数字符串，不取整、不把布尔值转换为数字、不接受十六进制或科学计数法字符串；Swipe 时长1–10000ms，LongPress 时长300–10000ms。
- 所有输入动作使旧 UI/图像凭据失效。InputText 只向当前焦点的光标/选区输入，不自动清空或定位字段。非 ASCII 优先通过设备 RPC 设置系统剪贴板并粘贴，不依赖当前 IME；这会替换系统剪贴板，**不自动恢复**，派发成功不代表粘贴结果已验证。仅 RPC 明确未执行时才尝试 ADBKeyboard 回退；每次广播前读取当前输入法，不匹配或无法确认时返回 ADB_KEYBOARD_NOT_ACTIVE，不自动切换输入法。
- Fill 是目标文本字段的替换操作：`text` 必填且支持空字符串；用 `id`、`selector=id=…` 或 `index+snapshotId` 寻址，目标必须是当前可见、enabled 的 textfield，且原始树中设备 RPC 身份唯一。非空文本通过设备 RPC `setText` 替换，空字符串调用 `clearTextField`；非密码字段用 `getText` 精确读回，匹配才是 `verified`，不匹配或无法验证为 `unknown`。密码字段不读回，只有 `dispatched`，外层 `expect` 也不会将其洗成字段值 `verified`，不回显字段值。RPC 不可用时拒绝，不用 shell 全选/删除模拟替换。
- Tap、LongPress、Swipe（包括 Scroll 的受限手势）优先 RPC，只有明确未执行时才回退 shell。RPC 超时、断连、取消或其他未知执行结果均不重放，防止一次触摸变双击；最终通道与结果以动作回执为准。

`expect` 支持 `{type:visible|absent,selector}`、`{type:foreground,package}`。截断或锁屏不能证明 absent；UI条件不能证明自绘画布中不存在目标。前台包名只证明前台状态，不证明业务提交。

`afterObserve` 默认false。`true` 返回新语义观察；也可对象或JSON对象字符串：`{mode:ui|image,limit?,screenshot?,region?,target?,maxWidth?,format?,quality?,grid?}`。参数在派发前校验，不允许设备覆盖、额外稳定性采样或仲裁。limit（1–500）、maxWidth（64–4096）、quality（10–95）只接受安全整数或十进制整数字符串；布尔值、数组、空值、十六进制和科学计数法字符串在输入前拒绝。成功且新鲜的UI验证采样直接复用；其他情况重新采样，禁止在动作后观察中唤醒屏幕。回执位于 `details.observation`；采集失败独立标记 failed，保留原动作结果，不重放。取消和总预算到期继续抛错，不吞成普通采集失败。

### Wait：只读条件等待

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Wait"},"expect":{"type":"visible","selector":"text=加载完成"},"waitTimeoutMs":5000,"afterObserve":true}
```

Wait必须声明expect，只接收命令标识，不接收duration/坐标/输入参数或动作内设备字段。复用既有visible/absent/foreground条件轮询，不输入、不唤醒、不添加固定sleep；可用于短序列中等待页面状态后再继续。默认等待5000ms，可设1–30000ms，且受整步/整段timeoutMs和可信取消约束。

满足条件为verified，未证实为unknown；这里unknown不表示Wait派发过输入。序列中未证实立即停止，取消/总超时抛错；若先前步骤已输入，整段仍可能有副作用，不能整段重试。锁屏/截断不能证明absent，foreground只证明前台包名，不证明页面加载。afterObserve复用成功且新鲜的UI采样。


### Scroll：单次语义滚动

```json
{"command":"ExecuteStep","serial":"YOUR_DEVICE_SERIAL","action":{"command":"Scroll","id":"com.demo:id/list","direction":"down","distance":0.6},"afterObserve":true}
```

目标用 id/text/selector 或 index+snapshotId 指向当前可见、启用并带 scroll 标记的容器。不用先截图，不接受像素坐标；实时复核目标并将手势限制在屏幕内可见矩形。direction是浏览方向：down手指向上、up手指向下、right手指向左、left手指向右；不推断RTL或反向布局。distance为可见容器对应轴长比例，默认0.6、范围0.1–0.9；duration默认300ms、范围1–10000整数。容器太小拒绝执行。

只派发一次，不自动重试、不循环寻找目标、不声称已到边界或列表实际移动；用expect验证目标出现，或afterObserve查看新页面。输入后旧凭据失效，沿用设备租约、取消和总预算。它是基于语义目标的受限触摸手势，不是常驻无障碍服务的原生scroll事件。


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

支持固定读取、公开设置页、四项绝对设置（brightnessMode/screenTimeout/autoRotate/userRotation）和用户完成的拨号/短信/联系人/日程草稿。设置前读→写一次→读回；unknown不重试。草稿不自动拨打、发送或保存，但无法保证第三方处理程序行为；接收人、正文不回显。系统授权不覆盖通用GUI工具，不是全局安卓沙箱。详细边界见[系统适配记录](../../../docs/android-system-adaptation.md)。

## Manage：连接与显示

`operation=connect|reconnect|disconnect|startDisplay|stopDisplay|displayStatus`。connect 支持 mode=auto|wireless|usb、address/serial；首次配对优先用显示屏向导。startDisplay 的 open=true 复用 Loom 侧栏。管理事务与设备动作互斥，不能打断已占用设备。

设备操作 `timeoutMs` 默认60000，范围1–300000，覆盖准备、排队、动作、验证及动作后观察；waitTimeoutMs默认5000，范围1–30000，只收紧后置等待。可信取消来自执行上下文，不从模型JSON接收。已派发动作不能自动回滚；无法中止的依赖排干前仍保留设备租约。ADB容量默认64，队列满立即失败，排队消耗总预算。分布式远程取消协议尚未端到端补齐。

显示屏只监听loopback；viewer导航获取内存会话cookie，WS要求精确Origin和会话，写API额外检查Origin。这防浏览器跨站，不隔离恶意本机进程。scrcpy按代隔离socket；无观众停采，静屏不因没有新帧而重启。

## 模块边界

- AndroidControllerService：四入口路由、设备选择、观察凭据及动作编排；设备执行沿用 step-runtime 的租约、预算与回执。
- lib/device-network：地址/配对码解析、网络诊断与有截止时间的 LAN 发现，不访问控制器状态。
- lib/loom-display-url：可选宿主地址同步；读取并保留已有 manifest/CSS/JS，读取失败不覆盖应用。
- lib/stream-server：观众订阅与恢复；同 socket 共享在途就绪 Promise，probe 单飞，最后 H.264 意图撤销时停止编码器，不中断 JPEG 观众。

删除了仅测试使用的 scanHostPorts 和同步 defaultGateway；实际发现只保留一个异步、有总预算的 LAN 扫描实现。不引入新的服务容器或兼容注册层。

## 范围与回归

尚未实现：自主规划、持久化长任务、通用deep link、手机文件传输、写业务API、自动GUI回退、Jev图片/Box、常驻无障碍服务、H.264模型共享帧。VCP异步结果保存/通知不等于自动续跑Agent，不另造并行执行框架。历史真机与API证据见[P2验证记录](../../../docs/android-p2-validation.md)，不作为本轮真机验收。

仓库根目录运行隔离测试，不运行 live 脚本，不执行真实设备动作：

```bash
node --test tests/android-*.test.js tests/android-*.test.mjs tests/adb-*.test.js tests/frame-hub-contract.test.js tests/scrcpy-*.test.js tests/stream-recovery.test.js tests/subscriber-init.test.js tests/ui-graph.test.js tests/vision*.test.js tests/launch-app.test.js tests/focus-parse.test.js tests/auto-connect*.test.js tests/device-reconnect.test.js tests/*jev*.test.js tests/distributed-*.test.js
```


本轮 M1 主代理按上列命令独立回归：**852 tests / 852 pass / 0 fail / 0 skipped，13.200s**，包含 RPC 客户端、Fill、触摸/Unicode 输入和租约取消等边界契约。真机仅验证只读 Observe 与 RPC 服务连通：不存在节点的 `getText` 返回 `rpcCode=-32001`、`dispatched=true`，随后 stop 清理 ready/port；未执行 Fill、触摸或粘贴，不作为动作真机验收。

## 真机烟测

```bash
node scripts/check-android-scroll.cjs SERIAL
node scripts/check-android-scroll.cjs SERIAL --scroll
```

默认只读：先检查电源态，非Awake即失败，不唤醒、不解锁、不输出页面文字。显式--scroll仅在当前页面恰有一个合适滚动容器时，复核前台和设备状态，再按快照执行一次down滚动并返回新观察；无容器、锁屏或前台变化立即停止，不导航应用、不做反向恢复。独立进程只能验证本地插件执行链，不替代运行中VCPChat/ToolBox端到端验收。

URL真机烟测：`node scripts/check-android-url.cjs SERIAL BROWSER_PACKAGE`。只允许固定 https://example.com/，先检查屏幕已亮且未锁定，再导航一次并读取新观察；不唤醒、不输入、不提交、不自动返回原页面。
