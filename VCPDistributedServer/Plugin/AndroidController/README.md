# AndroidController：四入口、受控单步

插件只接受 `Describe / Observe / ExecuteStep / Manage` 四个入口。旧顶层动作、截图、设备管理及能力查询命令已删除，不提供兼容转译；动作统一放入 ExecuteStep.action，截图使用 Observe mode=image，设备管理使用 Manage。工具发现沿用 VCPToolBox 的 `{{VCPDynamicTools}}`，应用操作流程可放入 SkillBridge；联网搜索、文档处理与主机维护使用已有工具，不在安卓插件中复制实现。

**M2 状态：experimental，device 未测。** 本轮仅声明和隔离验证扩展选择器、元素图与 idle 等待契约；下文 M1.5 历史真机通过不构成 M2 设备验收。

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

`mode=image` 默认不依赖 UI 树。可用 `region`、`target=canvas`、`maxWidth`（默认1080）、`format=jpeg|png`、`quality`、`grid=false`；返回真实 `image_url` 和坐标映射。图像采集及编码前后额外采样新鲜前台、窗口、逻辑尺寸、旋转、电源及锁屏状态；只有完整证据一致且原始截图尺寸匹配逻辑屏幕才返回可操作 `frameId`、`image.actionable=true`、`image.reason=READY`。否则图片仍可查看，但 `frameId=null`、`actionable=false`，reason 为 `CONTEXT_UNKNOWN`、`CONTEXT_CHANGED` 或 `SOURCE_SIZE_MISMATCH`，不能用该图授权像素动作；映射只供查看，不当作已验证设备坐标。开始替换截图就撤销旧图像凭据，失败也不恢复旧凭据。

fresh采样不读写 `wm size` 缓存，不依赖 UI dump；当前仅保守支持可明确解析的单默认显示器AOSP格式，未知OEM格式、多显示器、锁屏证据缺失都不猜。未做真机/ROM准入，可能返回仅可查看的图。缩图、裁剪只改变主机输出，图片仍全屏采集，不降低设备截图/ADB流量。实时viewer是人类观察通道，不等于模型收到截图。

M2 实验性元素图使用 `mode=image,target=element`，与 `region`、`target=canvas` 互斥，只能选择一种寻址：`id`、`selector`（字符串或组合对象），或 `index+snapshotId`；不接受 `frameId`/像素寻址。`padding` 默认为0，只接受数字安全整数0–128（设备像素，不接受数字字符串），仅用于元素图；可见矩形加 padding 后按屏幕裁剪。返回 `element.elementBounds`（原始 bounds）、`element.visibleBounds`、`element.center`（原始 bounds 的设备坐标中心）、裁剪 region 和图像到设备的 mapping。中心不保证处于裁剪后的可见范围，不能直接当作安全点击点。`occlusion=unknown`，不证明没有其它窗口遮挡。

元素图额外依赖实时 UI：采图前定位并确认当前前台、未锁定与尺寸，采图后再采样复核身份、可见 bounds 和上下文；索引寻址同时复核布局。检测到变化即拒绝签发 `frameId`，不拿旧树配新图。图片仍来自全屏采集后的主机裁剪，不是设备侧元素截图。

```json
{"command":"Observe","serial":"YOUR_DEVICE_SERIAL","mode":"image","target":"element","selector":{"id":"com.demo:id/list","role":"scroll"},"padding":8}
```

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

`action/expect` 接受对象或 JSON 对象字符串。动作仅允许 Wait、Tap、DoubleTap、Swipe、Scroll、ScrollUntil、Drag、Pinch、LongPress、InputText、Fill、ImeAction、EraseText、KeyCombo、KeyEvent、LaunchApp、KillApp、System；DoubleTap、ScrollUntil、Drag、Pinch 及新增键盘动作仍为实验状态；Click/Type/PressKey 别名已删除；不允许递归、连接管理或覆盖外层设备。

- `id/text/selector`：动作前重新采样定位；M2 selector 规则见下节。显式字符串 `id=/text=` 的字面量 `%/#` 编码为 `%25/%23`，直接 id/text 与对象条件无需编码。
- `index`：必须携带同设备 `snapshotId`，15秒过期，执行前复核内容、布局和尺寸。
- 像素坐标：必须携带同设备可操作的 `frameId`，15秒过期；使用设备坐标，不是图片坐标。动作前重新采样上下文，比对前台包/组件/窗口、逻辑尺寸、旋转、默认显示器、唤醒及明确未锁定状态，变化或无法确认返回 `STALE_FRAME` 并撤销凭据；采样后再次检查过期/取消。Tap、LongPress、DoubleTap、Swipe及Drag所有像素端点共享该规则，混合Drag还拒绝语义树与图像的包名/旋转冲突。该检查不保证截图后内容/布局没变化，也不提供检查到派发之间的原子性。坐标、索引及动作时长只接受安全整数或十进制整数字符串，不取整、不把布尔值转换为数字、不接受十六进制或科学计数法字符串；Swipe 时长1–10000ms，LongPress 时长300–10000ms。
- 所有输入动作使旧 UI/图像凭据失效。InputText 只向当前焦点的光标/选区输入，不自动清空或定位字段。非 ASCII 通过设备 RPC 设置系统剪贴板，再用 `KEYCODE_PASTE` 贴入光标（默认；`CLIPBOARD_PASTE=rpc|keyevent|off` 可切换）。两条路都不依赖当前 IME；都会替换系统剪贴板，**不自动恢复**，派发成功不代表粘贴结果已验证。`pasteClipboard` 在本机 ColorOS / Android 17 上是确定性 `AssertionError`，故默认不走它；选 `rpc` 时一旦被拒，同一服务世代内会改走 `keyevent`，不会对着死通道反复敲。仅 RPC 明确未执行时才尝试 ADBKeyboard 回退；每次广播前读取当前输入法，不匹配或无法确认时返回 ADB_KEYBOARD_NOT_ACTIVE，不自动切换输入法。
- Fill 是目标文本字段的替换操作：`text` 必填且支持空字符串；用 `id`、`selector=id=…` 或 `index+snapshotId` 寻址，目标必须是当前可见、enabled 的 textfield，且原始树中设备 RPC 身份唯一。非空文本通过设备 RPC `setText` 替换，空字符串调用 `clearTextField`；非密码字段用 `getText` 字符串逐字读回，首尾空白也须一致；仅清空操作允许随包载体已实证的单个结构性换行 `\n` 等同空串。非字符串读回立即停止验证；不匹配或无法验证为 `unknown`，匹配才是 `verified`。密码字段不读回，只有 `dispatched`，外层 `expect` 也不会将其洗成字段值 `verified`，不回显字段值。RPC 不可用时拒绝，不用 shell 全选/删除模拟替换。
- Tap、LongPress、Swipe（包括 Scroll 的受限手势）优先 RPC，只有明确未执行时才回退 shell。RPC 超时、断连、取消或其他未知执行结果均不重放，防止一次触摸变双击；最终通道与结果以动作回执为准。长按优先原生 `click(x,y,duration)`，第三参是**按压时长 ms**；仅明确未执行才降级到起止同点的 RPC `swipe`（`steps ≈ duration/5`），仍明确未执行才使用 shell。所有 RPC 调用在发出前按 `lib/rpc-methods.js` 的签名表校验参数形状，形状错误一律本地拒绝（`dispatched=false`），不会发到设备上赌。

### M2 selector：组合定位（experimental，device 未测）

字符串兼容 `id=…`、`text=…` 及旧 `#N` 后缀：`id=…#2` 仍按 **XML 顺序、一基** 取第2个，不改成屏幕排序。新增 `contains=…`、`regex=…`（匹配语义 label）、`class=…`（短类名或完整类名）和 `role=…`。

组合对象为 `{id?,text?,contains?,regex?,class?,role?,nth?,within?}`，至少包含一个匹配条件，条件取 AND。`nth` 只接受非负**数字安全整数**（不接受字符串），按 `top,left,bottom,right,index` 升序取**零基**第 n 个；它只消歧当前屏幕，不是可跨页面复用的身份。裸 selector 多匹配拒绝，不默认取首个。`within` 是字符串或组合 selector，限定原始树中某个祖先的严格后代；祖先须唯一，最多一层，禁止嵌套 `within`，不能用仅“看起来在附近”的控件冒充祖先。

regex 模式最多512字符、待匹配 label 最多16384字符；优先使用可用的 RE2，否则只接受线性时间受限语法：字面量、`.`、字符类、边界 `^/$`、基础转义及单个 `* + ?`。后备语法拒绝分组、交替、计数重复、回溯引用及前后瞻，不交给 JS 回溯正则赌运行时间；不支持外置 flags。

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

idle 为 experimental，device 未测。原生 `waitForIdle(timeoutMs)` 最多调用一次，设备等待上限1500ms，仅是 best-effort hint。随包 APK 的 QueryController 已实证吞掉 TimeoutException，所以 native void/null/成功返回都**不能**直接标记 `ui_automation_idle` 或 verified。之后必须有两次间隔200ms、同一前台/屏幕上下文、完整且可见的原始布局采样一致，才以 `idleMode=layout_stable` 验证；隐藏/裁剪状态也纳入完整性检查，不以截断语义表代替原始布局。布局稳定不等于像素静止、网络完成或业务成功。native 传输超时、断连、取消及执行状态未知不后备采样、不重试；仅已排干且明确不支持/设备 idle 超时或原生不可用时可转布局采样，仍不放宽证据要求。

普通 Observe、动作定位、动作/读回 RPC，以及 M2 等待/元素采样统一使用同一隔离边界。错误中的 `dispatched=false` 证明本次请求明确未派发/未执行；`drained=true` 表示本次请求未发出，或已收到完整、匹配且结构有效的 JSON-RPC 响应，不代表业务成功、设备静止或远端服务进程终止。已派发且缺乏排干证据（超时、取消、断连、HTTP错误、无效/超大响应等）的业务 RPC 会使设备进入 `DEVICE_STATE_UNCERTAIN`：旧 UI/图像凭据失效，同调用不再 CLI 回退、稳定性补采或 afterObserve 采集；后续同设备 Observe/ExecuteStep、自动选设备及设备管理变更拒绝。显式指定的其它未隔离设备仍可操作，动作历史与宿主状态仍可查询。

明确未执行或已完整响应的普通读失败仍可受预算约束地回退 CLI；错误 payload 或完整响应解析后超过请求预算不自动等于远端未排干。写动作仅 `dispatched=false` 才允许原有受限回退：即使 `drained=true`，设备业务错误、返回 false 或迟到响应都不能授权重放。Fill 读回的派发结局未知会如实标记 `unknown`，不伪装成未派发。

隔离不会被普通 reconnect、销毁本地 socket 或停止本地 adb 子进程解除；恢复须人工确认旧设备 UI 服务已终止后重启插件，不凭 ping 成功清隔离。此边界覆盖 Service 发出的业务 RPC，不声称覆盖启动期 ping/远端 owner 身份认证、独立显示流或外部 adb 进程；这些生命周期机制尚未统一。


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

支持固定读取、公开设置页、四项绝对设置（brightnessMode/screenTimeout/autoRotate/userRotation）和用户完成的拨号/短信/联系人/日程草稿。设置前读→写一次→读回；unknown不重试。草稿不自动拨打、发送或保存，但无法保证第三方处理程序行为；接收人、正文不回显。系统授权不覆盖通用GUI工具，不是全局安卓沙箱。详细边界见[系统适配记录](../../../docs/android-system-adaptation.md)。

## Manage：连接与显示

`operation=connect|reconnect|disconnect|startDisplay|stopDisplay|displayStatus`。connect 支持 mode=auto|wireless|usb、address/serial；首次配对优先用显示屏向导。startDisplay 的 open=true 复用 Loom 侧栏。管理事务与设备动作互斥，不能打断已占用设备。

设备操作 `timeoutMs` 默认60000，范围1–300000，覆盖准备、排队、动作、验证及动作后观察；waitTimeoutMs 默认5000，范围1–30000，限制条件等待及 idle 等待，二者共用同一等待预算，不延长总预算。可信取消来自执行上下文，不从模型JSON接收。已派发动作不能自动回滚；无法中止的依赖排干前仍保留设备租约。ADB容量默认64，队列满立即失败，排队消耗总预算。分布式远程取消协议尚未端到端补齐。

显示屏只监听loopback；viewer导航获取内存会话cookie，WS要求精确Origin和会话，写API额外检查Origin。这防浏览器跨站，不隔离恶意本机进程。scrcpy按代隔离socket；无观众停采，静屏不因没有新帧而重启。

## 模块边界

- AndroidControllerService：四入口路由、设备选择、观察凭据及动作编排；设备执行沿用 step-runtime 的租约、预算与回执。
- lib/expectation-wait：单个条件的有界只读轮询，一次编译选择器；沿用外层租约、取消与截止时间，成功时返回原始采样供后置观察复用。
- lib/device-network：地址/配对码解析、网络诊断与有截止时间的 LAN 发现，不访问控制器状态。
- lib/loom-display-url：可选宿主地址同步；读取并保留已有 manifest/CSS/JS，读取失败不覆盖应用。
- lib/stream-server：观众订阅与恢复；同 socket 共享在途就绪 Promise，probe 单飞，最后 H.264 意图撤销时停止编码器，不中断 JPEG 观众。

删除了仅测试使用的 scanHostPorts 和同步 defaultGateway；实际发现只保留一个异步、有总预算的 LAN 扫描实现。不引入新的服务容器或兼容注册层。

## 范围与回归

代码审查与有界重构（2026-11-03）：本轮完整离线回归 **1462/1462通过，0失败/取消/跳过，14.564s**，较既有套件新增37条；`node --check` 与限定差分空白检查通过。修复精确Fill读回、采样来源混拼、取消后额外请求、UI forward生命周期/所有权、原始节点来源与隐藏后代布局证据；条件轮询独立、动作工厂只装配一次、移除聚合全文的图层二次扫描。未操作真机，不替代下面的M2真机NOT_PASSED结论；边界、证据与未修问题见[代码审查记录](../../../docs/android-controller-code-review.md)。

第二轮架构收敛：**1496/1496通过，0失败/取消/跳过，14.947s**，新增34条（ADB调度18+生成选择器16）。ADB按设备串行、跨设备并行，管理命令为全局FIFO屏障；精确host只读发现可与设备并行但不跨屏障，总容量仍默认64且无闲置serial队列累积。提交参数副本固定分类与执行，避免可变argv绕过屏障。生成selector复用真实解析器确认原样可消费，无法表达的行返回`selector:null`并提示仅用新鲜`index+snapshotId`；不扩大4096条件预算、不降级成其它匹配身份。同文本ordinal按完整动作匹配全集计数，修复带ID/无ID混排指错行。预算测试仅适配VM相对依赖解析，原断言未改。未跑真机；完整边界与剩余P1见[代码审查记录](../../../docs/android-controller-code-review.md#第二轮设备调度与可消费的选择器契约)。

尚未实现：自主规划、持久化长任务、通用deep link、手机文件传输、写业务API、自动GUI回退、Jev图片/Box、常驻无障碍服务、H.264模型共享帧。VCP异步结果保存/通知不等于自动续跑Agent，不另造并行执行框架。历史真机与API证据见[P2验证记录](../../../docs/android-p2-validation.md)，不作为本轮真机验收。

M2 RPC ABI 实证：随包 APK selector 的 `PACKAGE_NAME=524288`，`INSTANCE=16777216`；两者不是同一位，不允许拿旧 INSTANCE 误位表示 packageName。`waitForIdle` 是只读、experimental 的一参 RPC，参数仅数字安全整数1–2000；idle 编排进一步限原生等待≤1500ms。真实 loopback HTTP 签名测试覆盖有效调用与本地拒绝，invalid 请求不得发 HTTP；不代表已连接真机验收。M1.5 手造 package mask 测试按此 ABI 更正，不为迁就旧测试保留错误生产掩码。

仓库根目录运行隔离测试，不运行 live 脚本，不执行真实设备动作：

```bash
node --test tests/android-*.test.js tests/android-*.test.mjs tests/adb-*.test.js tests/frame-hub-contract.test.js tests/scrcpy-*.test.js tests/stream-recovery.test.js tests/subscriber-init.test.js tests/ui-graph.test.js tests/vision*.test.js tests/launch-app.test.js tests/focus-parse.test.js tests/auto-connect*.test.js tests/device-reconnect.test.js tests/*jev*.test.js tests/distributed-*.test.js
```

M2（2026-11-03）最新完整隔离回归：**1425 tests / 1425 pass / 0 fail / 0 skipped，15.140s**（含M1.5/M2两套CLI安全测试33条）。覆盖选择器/元素图/idle/公共入口/真实loopback HTTP、受限正则独立参考、raw祖先、隐藏/禁用/长标签完整证据、carrier声明/CLI精确尾行、预算/取消/传输未知隔离，前台切出仍排干清传输，以及idle局部deadline耗尽后已排干ADB只读超时归unknown（提前超时/取消/STEP/UI未知仍抛）。JS语法与限定差分空白检查通过。M2最终第七轮完整真机**13/14，0未执行，NOT_PASSED**。仅动态几何idle未通过：运动前后仍存活/ticks增加，但返回verified/layout_stable；尚未记录两份采样几何，需核清往返轨迹采样重合与期望契约，不能直接声称算法漏运动或改期望盖PASS。定位/序列6项、元素图4项、其它idle3项同轮通过，进程正常cleanup/exit1；见[本轮证据](../../../docs/android-m2-device-validation.md)；M3前仍存的可靠性短板见[对标审查](../../../docs/android-pre-m3-gap-review.md)。新增能力保持experimental，不把隔离回归或单ROM靶场外推为普遍准入。



M1.5.0–M1.5.6（2026-11-03）实现阶段收束，按上列完整命令独立回归：**1231 tests / 1231 pass / 0 fail / 0 skipped，15.20s**（Node v24.22.2）。含首批929条基线、新增ScrollUntil/键盘/Drag/Pinch/历史、RPC真实HTTP门禁、嵌套target序列预检与RPC ready期间焦点转移回归。另通过 `node --check` 与限定变更文件的 `git diff --check`。现有 ESM package-type 提示不影响结果，未改根包配置。

用户再次授权后，相同APK安装成功。本机PJZ110 / Android17完整独立串行矩阵 **14/14 PASS、0失败、0未执行，deviceAcceptance=PASSED，exit0**：长按800、双击、语义/像素Drag、Pinch in/out、IME enter/search、Ctrl+A/MOVE_END、EraseText2、host/RPC ScrollUntil、历史纯读。双击修复vendor两参click默认100ms按压造成的超窗，改明确20ms短按而不放宽100/120ms派发窗。每项Provider效果独立读回，非插件自报dispatched。完整证据含前次[-99]与初次超窗历史见[真机记录](../../../docs/android-m15-device-validation.md)；[路线图](../../../docs/android-controller-roadmap.md)同步收束。隔离全回归1231/1231（修复后13.625s）、CLI/suite安全测试22/22通过。未覆盖的其它ROM、App与参数极值不外推，全部新增动作保持experimental。

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
