# AndroidController M2 真机验收记录

日期：2026-11-03（Asia/Shanghai）。设备PJZ110 / Android17 / API37，已授权无线ADB；固定零权限包`com.vcpchat.m15fixture`。Node v24.22.2。仅固定portrait、既有分辨率和有限参数，不外推其它ROM/应用、分屏/旋转、全部参数或长稳。

## 当前结论（2026-11-05）

新完整矩阵 **14/14通过，0失败/未执行，无case重试，正常cleanup后exit0**。生产代码摘要 `94c26727ed8b8f3c2a37016f5b19f36223890189c7fd066d4b545cd5580c33e7`。本轮运动idle四份完整布局的色块left=144/80/48/104，返回unknown/IDLE_TIMEOUT，4574.238ms；Provider motion前后均true、ticks51→165。静页1892.875ms、动态文案3060.082ms、host fallback6304.723ms；仍为原4.5秒运动预算与1500ms native上限。完整离线1885/1885。原始日志、首轮ROM解析拒绝、owner验证及限制见[收口报告](2026-11-05_audit-android-pre-m3-report.md)。

历史第七轮仍保留NOT_PASSED及归因未决：它没有当轮采样几何，不能由本次通过倒推周期重合或陈旧dump。新的通过结论只限当前代码、单ROM与固定矩阵；不保证连续静止、像素或业务完成。

## 历史结论（2026-11-03）

**本轮有界验收已结束，最终真机NOT_PASSED：第七轮完整14项执行、13通过/1失败/0未执行、无case重试，正常cleanup后exit1。** 动态几何idle在运动前后均存活、ticks48→157时返回verified/layout_stable，独立断言报MOTION_IDLE_FALSE_SUCCESS。当前契约仅为两次完整布局相同，往返轨迹可能采样重合；尚未取得该次两份采样几何，不能直接归因为算法实现错误，也不能删掉断言盖PASS。定位/序列6项、元素图4项、其它idle3项均通过；后续须核清采样轨迹与期望契约再复验，不靠拼历史签收。

最新生产完整隔离回归**1425/1425通过，0失败/取消/跳过，15.140s，exit0**（含两套CLI安全测试33条），不替代真机14项。第七轮仅经操作员明确授权更新零权限靶场motion12→30秒（构建/签名/安装成功）；生产4.5秒等待、原生1500ms上限、安全闸和独立断言未放宽。所有失败轮次及代码指纹保留。

## 安全与独立效果判据

- 显式serial，每动作前后精确前台靶场/主用户0/Awake/未锁；固定Provider协议与同一内存session。无个人内容，不操作用户App、不改设置、不切IME/无障碍、不唤醒/解锁、不自动重试未知动作。
- 每case前排干真实runtime租约与ADB队列，导航重建靶场并独立核对计数基线；已知断言失败记红后可在排干/同会话安全条件下继续下一case，RPC未知/安全/会话变化立即全停。
- Tap效果以Provider点击计数增量、A/B互不误触判定，不以dispatched当成功。sequence要求completed并独立计数+2。
- 元素ROI以Provider的`getGlobalVisibleRect`几何为独立参考；PNG由sharp解码检查中心RGB=[32,160,96]，校验padding/region/mapping且occlusion必须unknown。不是拿生产mapping当唯一参考。
- idle显式记录native次数/上限1500ms；静页须layout_stable+verified，动态文案须Provider ticks实际增加，动态几何须运动有效且unknown/IDLE_TIMEOUT，无RPC时须nativeCalls=0并由CLI完整双采样verified。
- 运动/文案timer有有限自动停止窗口，脚本不延长动作总预算、不修改生产idle采样间隔或把unknown洗成verified。

## 历史轮次与分类

### 首轮：5/14，exit1

同轮14项全部执行，无case重试；定位contains/regex-class-role/within/nth/裸重复拒绝5项通过。sequence验证、元素图及idle9项失败。根因：新bounded采样直接validateHierarchy，将随包合法XML声明当无效标签；普通Observe既有extractHierarchy会去声明。真实carrier形状新测试先红后绿，生产只规范化合法文首XML声明，保留完整root/属性/实体/尾部检查，不剪任意XML片段掩盖错误。

### 第二轮：12/14，exit1

修正声明后，定位6项、元素图4项、静页/动态文案idle2项全部通过。元素padding8图像1080×523，中心RGB=[32,160,96]；静页native1500ms+布局验证总1851.189ms，动态文案3434.329ms。

- `IdleMotionTimeout`：生产已返回unknown、IDLE_TIMEOUT，总4563.262ms；独立运动存活/计数断言失败，不能只看正确回执就盖PASS。增加脱敏精确证据后继续分类，未改预期。
- `IdleHostFallback`：UI_ACQUISITION_FAILED。固定前台gate后只读真实CLI实收：declaration=true、completeRoot=true、精确尾行=true、tailLength=32；尾行是故意拼错的`UI hierchary dumped to: /dev/tty`。仅白名单文末notice可剥除；错误路径/拼写、重复wrapper、前后垃圾、DTD/坏root/重复属性/坏实体/第二root继续拒绝。carrier专项25/25通过。

### 隔离回归过程

首全回归1386/1387：新disabled成功断言只给5ms，在并行调度开销下变unknown；独跑4/4。分类为测试时限而非生产错误，成功样本预算改1000ms，失败截止5ms保留，未改生产/状态期望。随后hidden子标签被clickable父聚合残余先红复现，私有copy清除hidden自身语义但保留显式可见child与raw祖先；长聚合匹配读净化copy，不回灌hidden/password。最终全回归1411/1411通过。

### 第三轮安全停止与继续

最终生产快照开始后首项导航回执dispatched，但后安全gate检测到前台已非靶场；只读分类foreground=false/awake=true/unlocked=true。没有尝试切回、唤醒或继续13项。原脚本finally在cleanup前也调用gate，导致安全停止同时跳过传输清理、留下本地进程；已停止该本地job并最小修复为先真实drain再cleanup（不依赖前台安全，不发送新GUI输入）。新增Service mock证明切出后仅1次operation、NOT_PASSED、cleanup恰1次，11/11 CLI测试通过。用户回复「已经切回，继续验收」后重新完整14项；此前轮次不拼接为最终PASS。

### 第四轮：13/14，exit1

用户切回后完整14项执行；定位6/6、元素图4/4、静页与文字变化idle、无RPC CLI idle均PASS。静页1779.742ms，动态文案3449.751ms；host CLI idle6150.753ms/nativeCalls=0。唯一`IdleMotionTimeout`在4.5s本地截止边缘抛`ADB_TIMEOUT`，而非返回unknown/IDLE_TIMEOUT。分类为生产只读probe的deadline收尾归类缺陷，不延长预算或隐藏提前失败/RPC未知/取消；限定修复只在请求已落定、error.code=ADB_TIMEOUT且本次idle deadline已耗尽时归为idle unknown/IDLE_TIMEOUT。catch内先stepRuntime.check，取消/总STEP截止优先；未耗尽的ADB错误和所有UI_SERVER未知仍原样抛出。离线公共入口先红复现后修，下一完整第五轮采用新Service指纹，不加预算、不续请求。

### 第五轮：安全停止，12通过/1失败/1未执行，exit1

定位6/6、元素图4/4、静页idle与动态文案idle共12项通过。元素padding8图像1080×523、中心RGB=[32,160,96]；静页1943.155ms，文字3613.581ms。第13项`IdleMotionTimeout`导航准备回执后安全gate检测到前台切离靶场，故没有开始本项idle请求，也未执行第14项。只读复核foreground=false/awake=true/unlocked=true。此次finally按修复正常drain+cleanup、进程自动exit1，不需要强杀、未唤醒或切应用。此轮不能验证新的idle截止补丁，亦不能把前轮host PASS拼为最终PASS。

截止补丁公共入口先红后绿，定向87/87（其中13条新测含deadline等号、提前1ms、首/末probe、取消/STEP/UI错误），完整隔离回归1425/1425，0失败/跳过，15.140s；生产与测试已冻结。等待操作员再次确认前台后完整复验。

### 第六轮：运动fixture窗口耗尽，12通过/1失败/1未执行，exit1

当前只读probe返回READY_NOT_RUN，沿原验收授权完整从头执行。前12项PASS，静页1838.110ms、动态文案3384.249ms、元素padding8为1080×523/RGB=[32,160,96]。`IdleMotionTimeout`生产返回unknown/IDLE_TIMEOUT，4570.198ms，nativeCalls=1/nativeMs=1500；独立读回elapsedMs=9905、motionBefore=true/motionAfter=false、ticksBefore=67/ticksAfter=149。原靶场80ms/tick且12秒自动止，149 ticks对应约11.92秒，证实运动窗口已在安全闸/读回开销下到期；没有删除存活断言。FIXTURE_MOTION_EXPIRED按全局终止，不运行第14项，不拼前轮host PASS。

分类为测试设施时序不足，不是生产idle又失败。仅MainActivity的运动上限12000→30000ms；原4.5秒idle/1500ms原生上限/双采样/独立motion+ticks断言及全部gate不变。切页/onPause/destroy/STOP仍立即撤销timer。新靶场已本地离线build+签名验证成功（Java8过时警告3条），deviceAcceptance=NOT_RUN，未安装/未启动。旧APK指纹仍对应前六轮；后续更新需另记新SHA与完整矩阵。

### 第七轮：完整13/14，exit1（已授权更新固定靶场）

操作员通过明确选项授权「覆盖更新并打开手机上的零权限固定靶场com.vcpchat.m15fixture，再完整验收14项」。本机仅执行该包`install --no-streaming -r`（Success）、显式固定MainActivity启动（top-most实例收到intent），随后显式serial只读probe返回READY_NOT_RUN/mode=gestures/serviceInitialized=false。无其它包、设置、IME或权限变更；生产Service和runner SHA未改。新靶场运动30秒仍受STOP/pause/destroy取消；生产idle仍4.5秒。同轮14项全部执行，13通过/1失败/0未执行，无case重试。静页1898.485ms、动态文案3432.774ms均verified；host CLI6701.733ms/nativeCalls=0亦verified。元素padding8图像1080×523、中心RGB=[32,160,96]。

唯一失败IdleMotionTimeout：操作总4285.525ms，outcome=verified/idleMode=layout_stable；nativeCalls=1/nativeMs=1500。独立前后读回elapsedMs=8762、motionBefore=true/motionAfter=true、ticksBefore=48/ticksAfter=157，报MOTION_IDLE_FALSE_SUCCESS。与第六轮不同，本轮不是运动到期；脚本在排干/同会话安全后继续第14项并独立通过，最终正常cleanup/exit1。

**分类边界**：motion与ticks证明测试窗口内运动timer持续且位置有更新，但不证明生产两个采样时刻的bounds必然不同；当前fixture为9.6秒往返三角轨迹，存在对称位置采样重合可能。生产layout_stable本就只宣称两次完整布局一致，并非连续静止；因此保留为未决的采样/期望契约问题，不能在未采到两份几何前宣称生产解析漏运动，也不能直接改测试期望为verified。下一次应先仅记录靶场采样bounds/digest/时间，区分周期重合、dump陈旧或实现丢证据；若确认仅周期重合，再用严格单调且不裁剪的有界运动验证原定timeout，并另留周期运动契约测试。当前结束7轮有界验收，保留NOT_PASSED，不无限改靶场直到绿。

## 固定14项矩阵定义

| case | 独立通过标准 |
| --- | --- |
| ContainsRebind | 动态标签连续两次实时匹配，counter每次+1 |
| RegexClassRole | 正则+完整class+button role匹配，counter+1 |
| WithinRawAncestor | 原始B祖先下同名按钮，仅B+1、A不变 |
| ExplicitNth | screen nth=1，仅B+1、A不变 |
| DuplicateRejected | 裸同名多匹配拒绝，两计数均不变 |
| SequenceRebind | 中间expect通过才执行第二步，completed且counter+2 |
| ElementPixels | 当前id、padding8、独立ROI与PNG颜色 |
| ElementIndex | 当前Observe index+snapshotId、padding0与实际像素 |
| ElementAfterObserve | 动作效果+1，后观察element成功且独立ROI |
| ElementChangingRejected | 运动中采集拒签ELEMENT_TARGET_CHANGED/CONTEXT_CHANGED |
| IdleStaticNative | 一次native≤1500，布局双采样verified |
| IdleTextChanges | Provider ticks增加时仍layout_stable，不误当纯文案动画影响几何 |
| IdleMotionTimeout | Provider仍运动且ticks增加，预算耗尽unknown、idleMode=null |
| IdleHostFallback | 显式UI_SERVER=false，nativeCalls=0，CLI布局双采样verified |

## 命令

脚本默认probe不加载Service、不派发动作；只支持显式完整suite，不提供拼接局部PASS的入口。操作员须先准备并打开固定靶场，远端已有预配置carrier。

```powershell
node scripts/verify-android-m2.cjs --probe --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
node scripts/verify-android-m2.cjs --suite --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
node --test scripts/android-m15-fixture/verify-m2-cli.test.cjs
```

完整回归沿README既定命令，加`node --test`参数`scripts/android-m15-fixture/verify-cli.test.cjs scripts/android-m15-fixture/verify-m2-cli.test.cjs`。保留忽略目录`.build`中的first/second/third日志与最终回归日志，仅输出合成靶场白名单元数据，不保存用户页面或图像。

## 验收代码指纹

SHA256；工作树未提交，不用git HEAD假装代表实际代码。随包与远端carrier本轮人工sha256sum一致；这不代表生产已自动验证载体身份。

| 文件 | SHA256 |
| --- | --- |
| AndroidControllerService.js（第三/四轮） | ea8d52d51055e18c8feb566b56a081c922f15906ccf4a5aa4c972e2696000ec8 |
| AndroidControllerService.js（idle deadline归类补丁） | b6fa0bce5de1e67b7cc7c910a48d3b6827e3f4f994449a9b61deb39100b48cbe |
| lib/ui-graph.js | 509cc4d71d847de051acb19e6c1fdb74457da90b692e3c00fb12ea925bde4e02 |
| lib/selector.js | 5456a52ab3f500459b1efb1b6c33e33f0b2c0d09fd6d3cc674e79dc80fc0bc66 |
| scripts/verify-android-m2.cjs（第三轮） | 0726376aa98590947a915badc298867b4c7fcf9a29948610e34843a2e57e302b |
| scripts/verify-android-m2.cjs（第四轮，仅finally cleanup修正） | 238f6736ea8cb118ada5ed7274f7f855d7551cef9f188ad1a13e2949d991464f |
| m15-fixture.apk（第1–6轮设备旧版，motion12s） | 21239aacbedbe9fb4e2124d6bbb118a0d0d1815feb1f56cb161edfff29856496 |
| m15-fixture.apk（第七轮已授权安装新版motion30s） | 4986325c44cdaf79e3fec054ff9648eb0d35b4c1abf314d30e442f85bc914edc |
| u2-server-0.5.0.apk | 6d16845d28fea01d5ae069221d9df307c74e70b780eb99ac0b28cf8f6135a50f |

## 证据一致性复核

最终回归日志逐项包含13条idle deadline新增边界，汇总1425/1425、0失败/取消/跳过、15139.6509ms；第五轮原始矩阵日志汇总12通过/1安全停止/1未执行，与上文一致。当前Service、ui-graph、selector及验收脚本四个SHA256均与表内最终快照匹配；限定git diff --check通过。复核本身不访问设备、不替代新矩阵。

最终完整复验前，显式serial只读`--probe`已返回READY_NOT_RUN、serviceInitialized=false；沿用户既有验收授权启动第六轮，仍逐动作前后gate，不做唤醒/切应用。第六轮结果见上文，未预写PASS。

## M3前的准入优先级

这是后续独立交付建议，不在本轮验收内顺手扩大重构范围；详证与外部源码对照见[M3前差距审查](android-pre-m3-gap-review.md)。

0. **立即处理：动态几何idle证据与契约。** 第七轮真实运动窗口内verified但验收期望unknown；先补本次采样几何/时间/digest证据，核清周期采样重合与实现丢证据，不混淆两次同布局、连续静止、像素静止与业务完成。此项未关闭前不签发M2全部通过。
1. **P1：统一远端未知隔离与owner生命周期。** 所有写RPC及普通dump也接统一generation/不确定状态；超时或取消后不能仅凭宿主Promise settled允许下一次写。最低验证：模拟远端仍pending、本地请求已reject时后续读写拒绝且零新请求；恢复必须证明对应owner终止/排干，旧generation迟到响应不得解除新隔离。生产载体hash/ABI握手绑定generation；不以路径存在或普通reconnect洗白，不自动重放未知写。
2. **P1：统一frame/snapshot的display与foreground凭据。** 采集前后及动作派发前复核逻辑尺寸、rotation、displayId、前台/window和epoch；不能仅检查frame年龄/宽高。最低验证：同尺寸换前台、180°旋转、display变更、采集中/派发前变更均使旧凭据失效且零输入；无法证明上下文时fail closed。它降低竞态窗口，不承诺屏幕与输入能原子锁定。
3. **P1：收敛旧Observe stable与M2 layout_stable契约。** 复用完整raw布局+上下文+连续采样证据，或将旧结果诚实命名为局部呈现相同。最低验证：公开limit之外/第40节点之后变化仍不标整页稳定；截断或上下文不完整不能成为完整稳定证据。纯文本/纯像素动画另定义，不宣称业务完成。

P2随后做带源码/载体/协议/ROM/config指纹的有界性能与soak、滚动可见比例/中心及无进展停止；真正IME editor action、结构关系、多窗口按需求独立设计授权，不为追外部功能数量扩大权限面。M3 OCR/模板不能修复上述凭据或生命周期问题。

## 历史审查边界（后续已更新）

[M3前差距审查](android-pre-m3-gap-review.md)与[2026-11-05收口报告](2026-11-05_audit-android-pre-m3-report.md)记录后续实现：统一fresh上下文/epoch、普通读写RPC未知隔离、owner精确释放、启动文件SHA与完整布局stable均已接入；不能再将旧实现缺口描述为当前未做。长soak、其它ROM、旋转、多display、真机传输故障注入及VCPChat/ToolBox完整在线端到端仍不在本次14项中。
