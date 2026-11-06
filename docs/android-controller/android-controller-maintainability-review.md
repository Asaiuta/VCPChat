# AndroidController：算法与显示生命周期有界审查

日期：2026-11-03。基线为本轮开始时的工作区，不是 Git HEAD。已有大量未提交的插件、测试及文档修改，本轮保留这些改动；此前审查成果不计入本轮成果。无真实设备操作、无部署或重启运行中的插件。

## 判断与范围

主要问题是重复解释/遍历同一份数据、资源是否可用被对象存在性替代、异步失败后的资源所有权不完整。现有设备租约、预算、未知写不重放、选择器唯一性及脱敏回执是应保留的边界，不是删掉就能精简的“冗余检查”。

范围：标签适配器到 UI 图/选择器、Service 到显示服务及 FrameHub/scrcpy、元素截图前后证据。没有全仓格式化，没有为减少大文件行数引入容器或第二套接口。

## 本轮修复

### 1. 重复子树扫描：聚合标签采用后序摘要

[标签适配器](../../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator.js)原来每个无自身标签的可点节点都重扫原始子树。既有50/100/200层重复标签测试在本轮基线分别产生2650/10300/40600次文本读取，全部违反已有操作数门槛。

现在在既有后序遍历中按需建立摘要，采用小 Map 合并到大 Map，记录每个词最早文档序与该次几何，物化标签后才允许父级消费子级摘要。保留密码节点整个子树的聚合脱敏、独立点击节点只排除自身标签、不排除其后代、文档序去重、首次出现的 bounds、120字展示与完整选择器匹配文本。原有导出辅助函数保持兼容，不新增包依赖。

复杂度声明仅针对标签子算法：预期 Map 合并 O(n log n)，每个目标 k 个独特词的物化为 O(k log k + 输出长度)。多个嵌套目标的完整输出本身可能二次增长；其余裁剪/压平逻辑不因此获得整体线性保证。

[新增性质与操作数测试](../../tests/android-label-complexity.test.js)使用独立递归前序参考，在100棵分支树的3100个目标上比对完整文本、展示文本及几何；另外计量 Map 操作/遍历与 raw 文本读取，防止只把重复扫描换成重复复制。

### 2. 流解析器的伪安全上限导致完整包积压

[scrcpy解析器](../../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub.js)每次push最多循环1000次，却没有后续调度。4次各2000个完整小包只交付4000/8000；若没有下一次网络事件，完整包永久滞留。

去掉无续调度的截断；每轮必消费字节或推进握手，不足完整包即返回。现有16MiB单包上限保留。没有宣称这是分片缓存的零拷贝优化或事件循环时间片保证。

### 3. 显示启停的对象存在性冒充就绪状态

[显示服务](../../VCPDistributedServer/Plugin/AndroidController/lib/stream-server.js)原并发start可能返回null；停止等待设备清理时start可能返回即将失效的旧端口。现在启动/停止分别单飞，启动等待停止排干，停止等待当前绑定结束；绑定失败释放资源后才允许重试。

[Service的ensureDisplay](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js#L1878-L1893)同时收紧就绪快路径：先等待displayStarting；必须存在实际端口且无启停在途、未停止，才返回现有实例。重复已就绪启动不重写Loom URL。

Service的Manage仍受管理互斥约束，并发Manage不能靠本轮修复绕过DEVICE_BUSY。[入口集成测试](../../tests/android-display-start-review.test.js)主动构造真实回环StreamServer绑定/停止在途，再通过真实Service的Manage入口验证等待及URL同步，并断言并发Manage仍被拒绝。测试证明类与调用者的组合边界，不声称已证明用户环境必然发生该交错。最初同时调用两个Manage的测试错误地期待允许并发；识别互斥契约后改为上述底层在途场景，没有放宽生产互斥。

### 4. JPEG发送失败后订阅残留/复活

初始状态发送失败已dispose，但attachFrames仍继续订阅；帧发送抛错也只等待未来close事件。现在初始发送后重新检查已释放状态，帧发送失败立即dispose，统一走已有退订路径。[生命周期回归](../../tests/android-stream-lifecycle-review.test.js)验证无需close事件也可释放。

### 5. FrameHub终止后仍可新发采集

[帧采集](../../VCPDistributedServer/Plugin/AndroidController/lib/frame-hub.js)的循环已停止，但显式capture/captureOneShot还会访问ADB。两入口现在在终止态直接拒绝；不改变仍有效Hub的单次采集与推送参数隔离。

这不等于取消已在途ADB。已有raw短读重试/PNG回退可能继续排干，不能把本地停止声明成远端进程已经终止。

### 6. 元素截图遗漏同尺寸旋转变化

[元素截图](../../VCPDistributedServer/Plugin/AndroidController/lib/element-shot.js)原前后校验只绑定前台、尺寸及元素身份。180度旋转可保持尺寸、元素bounds和标签相同，却仍签发frameId。本轮新增raw hierarchy rotation基线及末次比对，变化返回ELEMENT_CONTEXT_CHANGED。

[公开Observe回归](../../tests/android-element-context-review.test.js)先复现“应拒绝却成功”，再验证不变上下文正常、旋转变化拒绝。测试曾错误要求拒绝发生在图片编码前；实际生产契约是编码后末次复核、签发凭据前拒绝，故只纠正这一测试期望，没有移动生产验证顺序追绿。瞬时变化后又恢复、两个采样间的页面运动仍不是此证据可证明的事实。

## 离线性能证据

同一[既有基准脚本](../../scripts/benchmark-android-labels.cjs)，Node v24.22.2，每例预热后7组×40次，取组均值中位数。before来自本轮实际修改前工具执行，不使用或覆盖用户原有before文件。以下是负责算法修改的独立代理本轮前后测量，绝非真机Observe延迟。

| 样本 | 文本读取 前→后 | 适配器ms 前→后 | 图层ms 前→后 |
| --- | ---: | ---: | ---: |
| 重复链50 | 2752→154 | 0.6071→0.3110 | 1.2593→1.0513 |
| 重复链100 | 10502→304 | 1.2417→0.5086 | 3.3730→1.9904 |
| 重复链200 | 41002→604 | 3.2898→1.1968 | 9.3689→3.6570 |
| 独特词链80 | 13442→484 | 5.4151→1.7585 | 9.7501→4.5017 |
| 宽树256聚合 | 1028→772 | 1.5486→1.4032 | 6.1077→4.9814 |
| 宽树256自有标签 | 514→515 | 1.4927→1.0734 | 4.8282→4.2847 |

六例controls/fullLabelChars不变。基准的链形状不同于既有属性读取回归，所以200层的41002与40600不可混为同一个样本。耗时受JIT/GC/主机负载影响；确定性操作数与独立语义验证是主要验收依据，不强设耗时百分比门槛。

## 验证记录

本轮全套修改前基线：1510 tests，1507 pass，3 fail；失败均为既有重复标签线性属性读取测试，见[基线日志](../../android-review-current-baseline.log)。不能沿用旧审查文档的1496全绿声称当前基线全绿。

最终全套回归：**1530 tests / 1530 pass / 0 fail / 0 cancelled / 0 skipped，16.157秒**，见[最终日志](../../android-review-current-final.log#L1557-L1564)。新增20条测试；既有复杂度期望未修改。六个本轮生产文件和四个新增测试的node --check、限定git diff --check通过。静态影响分析覆盖可识别引用，但动态绑定仍有不可判定项，不作为完整运行时证明。

完整离线命令：

```powershell
node --test tests/android-*.test.js tests/android-*.test.mjs tests/adb-*.test.js tests/frame-hub-contract.test.js tests/scrcpy-*.test.js tests/stream-recovery.test.js tests/subscriber-init.test.js tests/ui-graph.test.js tests/vision*.test.js tests/launch-app.test.js tests/focus-parse.test.js tests/auto-connect*.test.js tests/device-reconnect.test.js tests/*jev*.test.js tests/distributed-*.test.js scripts/android-m15-fixture/verify-cli.test.cjs scripts/android-m15-fixture/verify-m2-cli.test.cjs
```

该命令只用于离线契约与本机回环测试，没有连接真实安卓设备。完整suite耗时变化不作为性能收益证据。

## 剩余风险及建议顺序

1. **P1，远端owner/代际恢复仍未闭环。** 下述续轮已统一Service业务RPC的未知结局隔离，普通dump不再在传输未知时走CLI；但启动期ping、远端owner身份与终止证据、独立显示流及外部ADB不在该边界内。[既有审查](android-controller-code-review.md)中的远端生命周期问题仍需单独解决，不能把隔离当作自动恢复。
2. **P1，屏幕内容与输入之间仍非原子。** 下述图像续轮已绑定普通frame的前台/窗口/旋转/逻辑尺寸/电源/锁屏上下文；不证明同窗口内容和布局未变化，也不保证采样到输入之间无切换。新鲜采样只保守支持单默认显示器可解析格式，真机/ROM准入仍未执行。
3. **P2，主Service仍职责过多。** 连接、显示装配、采样、动作编排共存；下一次拆分应围绕设备会话所有权，而非把函数随意搬进utils并产生双向回调。
4. **P2，显示剩余性能边界。** 分片Buffer.concat仍可能重复拷贝，subarray可能保留大底层Buffer；慢存活探测可能重叠。在途ADB取消也未闭环。需要针对性复现后再改，不把本轮局部修复写成显示流全面重构。
5. **真机与兼容矩阵未执行。** 多ROM、无线长稳、真实H.264吞吐、操作时延均未验收；离线成功不能撤掉既有experimental标识。


## 续轮：统一业务RPC失败边界（2026-11-03）

### 根因及最小结构收敛

此前只有部分M2读取经过boundedRead；普通Observe/动作定位的dump失败会异步stop并转CLI，写RPC和Fill读回的未知结局不进入设备隔离。错误分类又靠code前缀/排除名单，完整有效响应后的超预算或坏业务payload反而可能被误判为远端未结束。

本轮只修改两个生产文件：

- [UI传输](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js)：在现有dispatched之外补明确drained证据，不改JSON-RPC协议、不增加依赖。既有response id和信封结构校验原本已存在，本轮没有冒领为新增。
- [Service](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)：将boundedRead改为withDeviceRpc并接入所有Service的业务dump/invoke。仅当dispatched不是false且drained不是true时隔离；没有证据默认不安全，删除旧UI/图像凭据。去掉按错误code枚举猜测远端状态的路径，不增加第二个隔离集合。

### 分类契约

| 状态 | dispatched | drained | 隔离/回退 |
| --- | --- | --- | --- |
| 本地拒绝，或写出前取消/过期 | false | true | 不隔离；仍受总预算/取消约束 |
| 完整匹配的-32601/-32602 | false | true | 不隔离；保留已有明确未执行的受限回退 |
| 完整匹配的其它设备error | true | true | 不隔离，但写操作不得重放 |
| 完整result后的BAD_PAYLOAD或解析超预算 | true | true | 不冒充未排干；普通读可按原策略回退，写不得重放 |
| 写出后超时/取消/断连/HTTP错误/坏JSON/坏信封/超大响应 | true | false | 隔离，不CLI回退、不自动重启掩盖 |

这里drained=true只表示本次协议请求没有未完成的响应：可能没有发出，也可能收到并验证完整响应。不表示业务成功、设备idle、后台任务停止或远端owner终止；不把本地socket destroy当成远端完成证明。

### 同调用与后续调用的约束

普通dump未知立即抛错，不先stop再CLI；安全回退先等待本地stop完成。稳定Observe第二次采样的未知异常不再被吞成unknown后继续截图。captureGraph、dispatchInput、captureVisionShot也检查隔离，防止同调用追加动作。动作rpcAction保留脱敏错误的dispatched/drained/rpcCode，完整false结果仍为动作unknown而非可重放。

Fill聚合读回回执不再把“没拿到成功值”写成“未派发”：实际已派发且结果未知标unknown；确实未派发仍not-dispatched。已成功派发的setText不会被读回失败抹掉。同调用afterObserve被拒，后续同设备Observe/ExecuteStep与管理变更被拒；显式其它设备不受连坐，历史/宿主状态仍可读。普通reconnect不清隔离。

### 验证与证据

- [隔离与回执矩阵](../../tests/android-rpc-isolation-review.test.js)：初始21项中17项失败、4项通过；后补动作前定位、stable二采样、合法shell回退、可信取消及Fill回执断言。Fill回执断言另先红复现not-dispatched误标。独立只读审查又发现：RPC成功响应后step取消/截止会把包装错误误标drained=false；两条真实rpcAction函数的VM隔离测试先红复现，再记录rpcCompleted保留完成证据。新增VM暴露仅用于测试，不修改生产导出，不冒充公开入口集成。最终28项。
- [传输排干证据矩阵](../../tests/android-rpc-drain-evidence.test.js)：受控HTTP事件与时钟，新增42项先红，随后覆盖未派发、合法设备error、坏信封、过大、中断、超预算及业务payload；不改既有期望。
- [真实HTTP到Service集成](../../tests/android-rpc-isolation-http.test.js)：10项使用真实UiServer与本机回环HTTP，Service公开入口消费真实错误分类。包括错误id的-32601不能被当成未派发、完整设备error不能授权写重放、BAD_PAYLOAD允许读回退。
- **最终完整离线回归1610/1610通过，0 fail/cancelled/skipped，15.588秒**，见[续轮最终日志](../../android-rpc-isolation-verified.log#L1642-L1649)。较前轮新增80项；两生产文件与三新增测试语法检查、限定diff空白检查通过。

本轮未改既有测试期望、未连接真机、未部署/重启插件。旧1496/1530的结果均是历史快照，不替代这里的当前验证。完整命令与上文相同，测试文件glob自动包含新增矩阵。

### 仍需保留的边界

启动期ping/服务就绪失败、APK/协议握手及精确远端owner清理尚未纳入统一模型；隔离只覆盖Service业务RPC，不承诺阻断独立viewer抓帧、外部ADB或所有设备背景工作。恢复仍需人工确认旧服务终止后重启插件，不能靠新的RPC成功自动解封。

普通frame上下文、主Service职责与显示分片复制等前述余项不因这一轮通过而关闭。另只读审查发现剪贴板能力记账可能将setClipboard失败误归到pasteClipboard；本轮未扩展为能力策略重构，保留后续单独复现。


## 续轮：普通图像凭据绑定上下文（2026-11-03）

### 修复范围与行为变化

旧frame只记录ID、年龄与缓存尺寸，180°旋转、Activity切换、锁屏都可能继续接受旧坐标；缓存自然方向wm尺寸也会误拒合法横屏坐标。新增生产入口23项基线22失败、1通过，见[复现日志](../../android-frame-context-red.log)。

- [adb fresh采样](../../VCPDistributedServer/Plugin/AndroidController/lib/adb.js) 保留默认probeScreen行为，新增显式fresh模式。一次shell往返按序读取window displays、window policy、power；不查询UI树、不读写wm尺寸缓存。逻辑尺寸取DisplayContent cur，rotation只取DisplayRotation当前mRotation，不拿user/sensor rotation替代。焦点只取唯一默认display的mCurrentFocus，不用focusedApp猜。锁屏只接受KeyguardStateMonitor当前字段，未知为null。
- [Service](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js) 截图开始即撤销旧凭据，新鲜前后采样包住采图、编码及原有元素验证。只有package/component/window、display=0、逻辑尺寸、rotation、Awake、明确未锁定完全一致，且[vision](../../VCPDistributedServer/Plugin/AndroidController/lib/vision.js)实际原始图像尺寸匹配，才签发frameId。未知/变化/尺寸冲突仍可显示图片，但frameId=null、actionable=false，reason明确说明。元素原有定位与前后验证未放宽。
- 所有像素Tap/LongPress/DoubleTap/Swipe/Drag统一异步消费验证：ID/15秒TTL、fresh完整上下文、采样后再次TTL/取消检查；未知/变化撤销凭据并拒绝，不派发输入。逻辑尺寸用于坐标边界。纯语义动作不增加fresh采样。
- 混合Drag用frame逻辑尺寸采语义树，拒绝树package/rotation与frame冲突，再fresh复核。独立只读审查发现该组合漏洞后，两条回归先红复现、再收紧生产路径。
- [Describe目录](../../VCPDistributedServer/Plugin/AndroidController/lib/tool-catalog.js)、[manifest](../../VCPDistributedServer/Plugin/AndroidController/plugin-manifest.json)、[README](../../VCPDistributedServer/Plugin/AndroidController/README.md) 同步声明nullable frameId与仅查看状态。调用者不得把存在mapping等同坐标授权。

### 验证与失败分类

新增56项：

- [frame公开入口33项](../../tests/android-frame-context.test.js)：前台/Activity/window、0→180°、锁屏/息屏、尺寸/显示器/未知字段、五种像素动作、采图/编码过程变化、替换失败撤旧凭据、Observe附图、混合Drag冲突、TTL采样中越界、可信取消与缺尺寸仅查看。
- [fresh解析21项](../../tests/android-frame-probe.test.js)：AOSP源码派生缩减fixture而非真机输出，0/90/180/270、逻辑override、未知格式、歧义、多display、截断、超时/取消、缓存隔离与默认模式兼容。源码依据见测试文件中的AOSP android-14.0.0_r1链接。
- [实际解析器及实际编码集成2项](../../tests/android-frame-context-integration.test.js)：真实AdbClient解析+真实sharp/vision编码+Service公开入口，稳定上下文通过、同尺寸旋转拒绝；ADB输出仍为fixture，不连接设备。

既有fixture变化均有语义依据而非追绿：共享[harness](../../tests/helpers/android-service-harness.cjs)的显式fresh模式补完整证据、vision替身补source尺寸；[元素rotation用例](../../tests/android-element-context-review.test.js)补相同字段；[Drag用例](../../tests/android-drag-contract.test.js)补真实树rotation，尺寸变化同时作用fresh逻辑尺寸而不只改旧wm缓存。既有测试期望未修改。

新测试的Drag helper最初误传被禁止的x1/y1，按既有固定原语契约改为x/y源（期望错误，不放宽生产）。完整回归另发现preflight抢先报FRAME_REQUIRED压过INVALID_ARGUMENT/expect诊断，收窄为预检已提供的凭据，缺失凭据沿原参数校验顺序处理；未修改原错误期望。另一替身mapping缺screen暴露了多余依赖，shot改为明确返回自己的size，不依赖编码器重复提供尺寸。

**最终完整离线1666/1666通过，0 fail/cancelled/skipped，29.944秒**，见[最终日志](../../android-frame-context-final.log#L1699-L1706)。修改JS/CJS语法检查与限定diff空白检查通过。命令与前轮相同，新增文件由glob纳入。完整suite耗时不是采图性能基准，不宣称本轮提速。

### 支持与安全边界

保守仅支持唯一默认显示器的已知AOSP dump格式；未知OEM/多显示器/缺锁屏证据不会猜测，会降为仅查看图像，可能影响旧调用方。新增两次采图上下文采样、每次像素动作一次复查会增加设备往返；未做真机延迟测量。

前后采样与动作前检查不是原子快照；同窗口的内容/布局变化、采样间先变后恢复仍不能被排除。不能因此声称所有像素动作安全或屏幕idle。远端owner、自动恢复、独立显示流以及剪贴板能力记账余项仍保留；未部署、未重启插件、未连接真实设备。


## 续轮：结构精简与可读性（2026-11-03）

本轮按“不过度兼容、易维护”的要求收敛已有代码，不扩展功能、不再建立通用manager或utils层。生产修改限定[Service](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)，新增[步骤计划回归](../../tests/android-step-plan-review.test.js)，保留已有未提交修改。

### 消除的结构问题

1. **重复解码、重复验证。** 公共入口负责JSON输入归一化，内部执行仅消费已解析结构。单步与序列共享executeStepPlan；序列先检查所有步骤结构/expect，再执行准备好的计划，不再逐步回调单步公开形状的解析流程。afterObserve只解析一次并在尾部/停止时使用。原先合法的字符串首step被preflight错误当成没有action，现按同一既有JSON输入契约解析，不新增别名。
2. **把序列化字符串当内部数据模型。** frameContext改为结构化证据和sameFrameContext比较，不再JSON.stringify保存、JSON.parse读回。默认display、Awake、明确未锁定仍是构造证据的硬前提，不把恒定字段重复存储；frame的尺寸只来自context.size，删除平行size副本。
3. **重复分类与误导缩进。** 多目标只计算一次是否包含语义目标，删除不可能分支；修正resolveTarget和parseAfterObserve的多余缩进，保留校验无条件执行。等待执行分支明确区分普通Wait、idle及动作派发，不靠嵌套三元压缩成一行。

### 不以删行为目标

本轮主要删除重复的执行路径，不宣称源码行数大幅减少，也不把拆成更多函数当作性能优化。没有给Map套机械get/set管理器；没有强行合并prepareTarget和prepareTargets，两者的唯一性及混合上下文约束确实不同。index:null/空字符串在不同旧路径的语义有分歧，本轮不靠通用predicate掩盖或偷偷改掉。

前后frame检查、异步采样后的TTL/取消复查、RPC未知隔离、派发副作用记账、序列全部结构校验均保留。长按明确未执行后的既有回退有明确测试契约，不为了减少几行就擅自删掉或将未知结果变成可重试。

### 验证策略

新增5个步骤计划测试通过真实processToolCall入口计数JSON解码与selector验证，不复制生产算法；覆盖字符串步骤/首帧动作、自动选设备、后续错误零输入、System显式serial和afterObserve诊断顺序。不修改既有测试期望。

成功执行完整N步序列时，expect解析/Wait校验/等待预算转换由2N次降至N次，afterObserve解析函数调用由N+1次降至1次；有指定设备的单步JSON action解码由3次降至1次，序列steps JSON解码由2次降至1次。内部steps字符串解码实现由2处变成公共入口1处，不为私有函数保留双输入形状。自动选设备的畸形steps JSON现在在租约内、发现设备前拒绝，这是统一边界的明确时点变化；合法请求及全部结构先验证的原则不变。

**最终完整离线回归1671/1671通过，0 fail/cancelled/skipped，17.377秒**，见[精简轮最终日志](../../android-structure-cleanup-final.log#L1704-L1711)。Service与新增测试语法检查、限定diff空白检查通过。测试耗时变化不作为性能基准；未连接真机、未部署或重启。


## 续轮：剪贴板失败归因与状态精简（2026-11-03）

此前记录的setClipboard失败误记pasteClipboard问题已通过[新增生产入口测试](../../tests/android-clipboard-attribution.test.js)复现并关闭：初始3项中2项失败；无论setClipboard是否明确未执行，只要它返回RPC错误，旧外层catch就把尚未调用的pasteClipboard标为不可用，污染下一次请求策略。

[Service](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)改为只在paste RPC自己的catch记录已完整响应的RPC错误，不再由覆盖set、paste、keyevent及enter的外层catch猜测失败方法。删除单调用方的通用noteClipboardCapability和clipboardPasteUsable包装，直接使用闭合策略值；删除UiServer已确定接口的typeof方法存在性猜测。失败学习只影响后续请求，当前写入未知仍立即停止，不重放、不发ADBKeyboard广播。

[UiServer](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js)只保存当前世代失败方法Set，去掉从未写入的available状态及每次记账时整对象复制。capability/noteCapability的既有接口、unknown语义、只接受unavailable、stop清空规则保持不变；现有客户端契约测试验证生命周期。清除关于WebView粘贴支持互相矛盾的长注释，改为准确声明“派发不证明字段插入”，不冒领新的真机结论。

本轮只解决跨方法错误污染，保留既有“完整paste设备错误后同世代改用keyevent”的策略，不声称所有设备错误都证明方法永久不支持。未引入新的重试、探针、别名或通用管理器；已知远端owner与恢复问题仍不在本轮范围。

**最终完整离线1674/1674通过，0 fail/cancelled/skipped，17.700秒**，见[最终日志](../../android-clipboard-cleanup-final.log#L1707-L1714)。两个生产文件及新增测试语法检查、限定diff空白检查通过。已有测试期望未修改；未连接真实设备、未部署或重启。


## 批量精简：启动、RPC、几何与选择器（2026-11-03）

按用户要求改为多项集中实施、统一验证后汇报。本轮5个生产文件、4个新增测试文件，既有测试期望未修改。

- [Service](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)：LaunchApp先选择component，再走唯一am start分支；无component才走monkey。合并显式activity/resolve-activity的重复派发和receipt构造，launchedBy由component派生，包查询失败改用null表达未知而不维护queryFailed+错误文本双状态。查询catch补取消检查；派发失败不回退monkey，最终仍独立验证前台。删除“每一步验证”这一与实际单次派发流程不符的注释。新增[4个启动测试](../../tests/android-launch-cleanup.test.js)。
- [UiServer](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js)：dump/invoke共用rpcOptions校验，删除options/signal/timeout校验分叉；dump入口记录绝对deadline，准备耗时计入总预算，不在HTTP边界重置。新增[10个RPC测试](../../tests/android-rpc-cleanup-review.test.js)，修复前7失败3通过，修复后局部109项通过。非对象options、null/残缺signal现在明确本地INVALID_ARGUMENT、dispatched=false/drained=true；NOT_READY诊断优先级及maxDepth旧规则不变。
- [vision](../../VCPDistributedServer/Plugin/AndroidController/lib/vision.js)：normalizeRegion删除parseInt+层叠clamp容错，改为整数几何解析与端点求交。显式坏输入不再悄悄变原点/整屏。保留整数数值字符串、x/y、null/undefined整屏、缺省尺寸和负起点夹裁；明确拒绝小数、非有限值、unsafe整数、部分数字串、空白/布尔/对象字段、非矩形region。screen须正safe-integer number，不再round/接受字符串。
- [element-shot](../../VCPDistributedServer/Plugin/AndroidController/lib/element-shot.js)：仅index目标计算layout基线，id/selector不生成永不消费的全图派生状态；原始节点证据、identity/visibleBounds、前后屏幕与rotation检查不变。几何与元素合计新增[15项测试](../../tests/android-vision-cleanup-review.test.js)，局部78通过，含真实sharp独立像素裁剪参考。
- [selector](../../VCPDistributedServer/Plugin/AndroidController/lib/selector.js)：普通findControls不再先controlsOf再让evaluateSelector重复取证；仅legacy空text路径保留独立取证。新增[3项测试](../../tests/android-selector-wait-cleanup.test.js)，先复现getter读取2次而非1次，修复后局部100项通过。匹配、regex预算、唯一性与unknown不变；不兼容任意带副作用Proxy的重复访问时序。

没有新增通用框架或兼容开关，没有把所有目标/等待逻辑强并成一个函数。RPC未知不重放、drain与生命周期代际、帧上下文凭据与取消仍保持；等待模块经审查本轮不改。

**组合后的完整离线1706/1706通过，0 fail/cancelled/skipped，18.162秒**，见[批量最终日志](../../android-batch-cleanup-final.log#L1739-L1746)。5个生产文件和4个新增测试语法检查、限定diff空白检查通过。未部署、重启或连接真机；未将总测试耗时当性能基准。


## 测试去冗余与键盘证据精简（2026-11-03）

审计截图/元素/几何、RPC/UI生命周期、步骤/序列/启动三个测试簇，仅删除严格被更强测试覆盖的3项；不以测试数量目标牺牲独立行为覆盖。删除映射：

- [frame-context](../../tests/android-frame-context.test.js)：`Tap rejects same-size rotation before any input` → `frame consumption refuses rotation180 without dispatch`。同一公开Tap/rotation180/零派发路径，保留者还验证签发及context恢复后旧凭据仍失效。
- [cleanup-contract](../../tests/android-cleanup-contract.test.js)：`display URL synchronization preserves the existing application sources` → `display restart syncs the new URL preserving current application sources, running start is a no-op`。后者包含name/css/js保留且额外覆盖初始化、运行中no-op、重启URL更新。
- [ui-server-restart](../../tests/android-ui-server-restart.test.js)：`failed forward acquisition never deletes a forward it does not own` → `a forward claimed after probing cannot be rebound by startup`。保留者包含所有原断言，另验证port=null及真实--no-rebind触发条件；删除专属rejectForward假分支。

[android-dump-fallback](../../tests/android-dump-fallback.test.js)的4项源码/注释正则检查替换成3项真实Observe入口测试：idle重试恢复且不走file、持续idle返回诊断且不走file、tty不可用按顺序dump文件再读取。原测试可被一段注释满足，现在实际删除重试或改变调用顺序会失败。没有把多个无关测试并成大用例假降数。

生产仅改[keyboard-actions](../../VCPDistributedServer/Plugin/AndroidController/lib/keyboard-actions.js)：删除attributesOf全量数组与两次filter，单遍原始树计数目标与焦点，保留隐藏/禁用重复节点拒绝及焦点唯一性。直接在[既有键盘测试矩阵](../../tests/android-keyboard-contract.test.js)新增hidden-duplicate一项，不再新建一份回归文件。

首轮全套1702通过/1失败：与本轮生产路径无关的[step-runtime测试](../../tests/android-step-runtime.test.js)15ms预算在并发调度下可能于进入withContext前过期，故abort监听尚未注册；这是测试环境/时序前提错误，不修改生产实现。预算调整到250ms，外部watchdog到2秒并及时清除；deadline、abort、未排空保留租约及排空后恢复的断言全部保留。不是删除不稳定测试或改成功期望。

测试数1706−3−4+3+1=1703；独立sharp参考、RPC未知不重放/drain/迟到响应/代际、TTL/rotation/context/取消全部保留。

**最终组合回归1703/1703通过，0 fail/cancelled/skipped，19.208秒**，见[验证日志](../../android-test-pruning-verified.log#L1736-L1743)。数量净减3，不宣称运行速度提升。未连接真机、未部署或重启。
