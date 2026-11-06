# AndroidController M1.5 真机验收记录

日期：2026-11-03；初轮停止后采样18:22:14 +08:00，完整矩阵于18:36前后完成（+08:00）。
设备：PJZ110，Android 17 / API 37；已授权无线 ADB，固定包 `com.vcpchat.m15fixture`。

## 最终结论

**完整矩阵 deviceAcceptance=PASSED：14/14 PASS，0失败、0未执行、0跳过；进程退出码0。** 全部14项在同一轮`--suite`中完成，未使用`--only`拼接绿灯，单case无重试/重放。设备PJZ110 / Android17 / API37，仅固定零权限靶场；不外推到其它ROM、应用、分辨率或未覆盖参数边界。新增动作继续experimental，表示推广边界未取消，不表示本轮未验。

## 首次单长序列结果（历史，不是最终矩阵）

**deviceAcceptance=NOT_PASSED。原生 LongPress 的本次形状通过；DoubleTap 的宿主派发窗口未通过，随后计划立即停止。其它新增动作 NOT_RUN。**

这是本次一次串行计划的结果，不是跨 ROM 准入，也不能把长按通过外推给其它方法或形状。所有新增动作仍保持 experimental。

## 前置条件与修复分类

- 前轮首次安装返回 `Failure [-99]`、未运行；本轮用户明确要求再次验收后，使用相同 APK 与 `adb install --no-streaming` 再次安装，返回 `Success`。
- 显式打开唯一固定靶场 Activity，无安装权限请求、无网络、无用户内容持久化，不跳转用户应用，不改系统安全开关，不唤醒/解锁或切换输入法。
- 首次只读探测返回 `UNSAFE_OR_UNPROVEN_TARGET_STOP`，没有加载 Service 或派发动作。独立原始证据为：前台精确靶场、用户0、`showing=false`、`inputRestricted=false`，但 power dump 同时含 `mWakefulness=Awake` 和 `mWakefulness=1`。
- **分类：验收脚本对厂商输出格式的兼容问题，不是设备睡眠或动作实现错误。** Android WAKEFULNESS_AWAKE 常量为1；脚本仍要求显式命名态 Awake，同时只容许伴随的数值1。数字单独出现、0/2/3、Asleep 或未知/矛盾态一律拒绝。不移除前台、锁屏、用户或会话闸门。
- 补充上述真实双格式与矛盾/数字单独证据回归，CLI 安全测试 **10/10通过**；修复后只读 probe 返回 `READY_NOT_RUN`。

## 执行命令与顺序

```powershell
node scripts/verify-android-m15.cjs --run --sdk F:/AndroidSdk --serial adb-beca2585-utuYDs._adb-tls-connect._tcp --scroll-strategy host
```

执行日志（合成靶场，不含用户数据）：

```json
{"phase":"probe","status":"READY_NOT_RUN","package":"com.vcpchat.m15fixture","mode":"gestures","foreground":true,"awake":true,"unlocked":true,"serviceInitialized":false,"deviceAcceptance":"NOT_RUN"}
{"phase":"action","name":"fixture:gestures","status":"PASS","independentReadback":true,"outcome":"dispatched"}
{"phase":"action","name":"LongPress","status":"PASS","independentReadback":true,"outcome":"dispatched"}
{"phase":"stopped","status":"NOT_PASSED","code":"DOUBLE_TAP_WINDOW_MISSED","retried":false}
```

进程退出码1，finally 已执行 Service.cleanup；未自动重试或重放。

## 各项判定

- **靶场导航：PASS。** 单次 RPC click 后固定 Provider 独立读回 mode=gestures。
- **LongPress：PASS（仅本次形状）。** 原生 RPC `click(x,y,800)`；校验唯一 rpc/click/dispatched attempt，不接受回退；靶场 GestureDetector 的 longPress 从0增加到1。不只是插件自报 dispatched。
- **DoubleTap：NOT_PASSED，DOUBLE_TAP_WINDOW_MISSED。** 目标宿主派发间隔100ms，第二击须在首击开始派发后120ms内开始。首击RPC完成后，第二击就绪/派发前窗口检查拒绝；不补发迟到第二击，不改成两次shell点击，不放宽窗口。此处未采集分段单调时钟数据，不能进一步把超窗归因到网络、ACK或服务就绪中的某一项，也不声称测量了设备实际触摸间隔。
- **语义 Drag、Pinch in/out、ImeAction enter/search、KeyCombo、EraseText、ScrollUntil host、动作历史：NOT_RUN。** 全部位于失败步骤之后，没有继续执行。脚本参数 host 仅为计划选择，不代表实际已运行host滚动。
- **ScrollUntil RPC、像素 Drag、其它键码/选区/Unicode/百分比边界与真机取消/截止时间矩阵：NOT_RUN。** 本轮没有另开绕过失败的计划。

## 停止后独立读回

进程停止并清理传输后只读固定 Provider 与前台包；没有追加输入：

```json
{"package":"com.vcpchat.m15fixture","resumed":true,"mode":"gestures","longPress":1,"doubleTap":0,"dragDrops":0,"scaleMilli":1000,"imeActions":0,"keyCombos":0,"pinchBegins":0,"pinchUpdates":0,"deleteEvents":0,"scrollY":0,"targetClicks":0,"text":""}
```

前台仍为固定靶场。靶场保留安装并留在前台，未清除用户数据、未自动切回其它应用。

## 完整验收与双击修复

用户明确要求全部验收，不能因单长序列首项失败而跳过所有后项。新增 `--suite` 完整14个独立case，保留旧 `--run` 的fail-fast兼容行为。每case真实runtime租约/ADB队列排干、独立导航重建基线、执行、Provider独立读回、cleanup并再确认安全gate；case失败只记该项，未排干或安全状态失去则全停。不是在未知状态下重放同一case。

**DoubleTap根因分类：实现与随包原语的时长选择不匹配。** 随包APK SHA256=`6d16845d28fea01d5ae069221d9df307c74e70b780eb99ac0b28cf8f6135a50f`。只读解析classes6.dex，AutomatorServiceImpl method_id500 `click(I,I)Z` 在touchDown后使用 `const-wide/16 0x64`、`SystemClock.sleep(J)`，即默认100ms按压；method_id501 `click(I,I,J)Z` 直接把传入J用于sleep。顺序等首击ACK后再发第二击，120ms窗口仅余20ms传输/调度余量。不是未经测量认定的UiServer.start每击ping。

最小修复仅把DoubleTap两击改为已支持三参 `click(x,y,20)`，回执增加pressDurationMs=20；普通Tap与LongPress不变，100ms目标派发间隔/120ms硬窗不变，首击未知不补第二击、ACK顺序、总预算、取消与租约排干契约均保留。拒绝并发click：vendor TouchController共享mDownTime，HTTP可并发不证明触摸流可并发。原合同两次参数期望基于真实vendor行为改为三参20ms，继续验证ACK121ms时只一击、未知不补击；DoubleTap25条+真实RPC门禁1条通过，完整既定隔离回归1231/1231、0失败/0跳过（13.625s）。CLI与suite安全测试22/22通过。

实际全矩阵使用可选只读计时preload，不改变原语/参数/重试或派发策略：

```powershell
node -r ./scripts/android-m15-fixture/rpc-timing.cjs scripts/verify-android-m15.cjs --suite --sdk F:/AndroidSdk --serial adb-beca2585-utuYDs._adb-tls-connect._tcp
```

计时仅方法白名单、参数个数、单调时间、ACK状态，不输出坐标/文本/selector或错误原文。最终矩阵结果记录于下节。

## 最终完整矩阵

| case | 结果 | 独立效果判据与通道 |
| --- | --- | --- |
| LongPress800 | PASS | 原生rpc/click三参800ms，GestureDetector长按计数0→1，无回退 |
| DoubleTap | PASS | 两次rpc/click三参20ms，GestureDetector双击计数0→1；首击ACK108.623ms，两次invoke开始差111.554ms，第二击ACK116.363ms |
| DragSemantic | PASS | 单次rpc/dragTo，抬起落入目标框，dragDrops 0→1 |
| DragPixels | PASS | 实时语义bounds定位后取image frameId，单次rpc/drag，独立落框计数0→1 |
| PinchIn | PASS | 单次rpc/pinchIn，percent60/steps80；ScaleGestureDetector begin/update均增加，scaleMilli<1000 |
| PinchOut | PASS | 独立重置到scale1000后单次rpc/pinchOut，begin/update增加，scaleMilli>1000 |
| ImeActionEnter | PASS | 单次rpc/pressKeyCode(66)，事件计数增加、lastImeKey=66、文本不变且仍focused |
| ImeActionSearch | PASS | 独立准备后rpc/pressKeyCode(84)，事件计数增加、lastImeKey=84、文本不变且仍focused；不提交外部业务 |
| KeyComboCtrlA | PASS | rpc/pressKeyCode(29,4096)，Ctrl+A回调及meta与全选起止位置读回一致 |
| KeyComboMOVE_END | PASS | 先全选证明非末尾单光标状态，再rpc/pressKeyCode(123,0)，选区折叠到文本末尾 |
| EraseText2 | PASS | 焦点/末尾光标明确后恰2个DEL事件、文本等于原串去尾2字；六条getText/DEL/getText/getText/DEL/getText回执完全匹配 |
| ScrollUntilHost | PASS | 实际4条shell/swipe/dispatched，目标从不可见变可见、scrollY增加、targetClicks=0；总动作4136.206ms |
| ScrollUntilRpc | PASS | 独立重置后仅一次rpc/scrollTo，目标可见、scrollY增加、targetClicks=0；RPC ACK6667.756ms，总动作7364.668ms |
| ActionHistoryPure | PASS | 同初始化内导航/Focus/Fill requestId全部存在，键白名单、不含合成输入串，两次查询结果一致 |

所有case在独立模式重建后验证计数/文本/比例基线；准备导航、Focus、Fill与观察不是被测动作的替代效果。每case前后精确前台包/主用户/Awake/未锁/同Provider会话，结束前后真实租约与ADB队列排干。原语返回dispatched只是通道回执，PASS由Provider效果断言决定。

最终原始摘要（日志第103行）：

```json
{"phase":"summary","status":"PASS","deviceAcceptance":"PASSED","matrixTotal":14,"selected":["LongPress800","DoubleTap","DragSemantic","DragPixels","PinchIn","PinchOut","ImeActionEnter","ImeActionSearch","KeyComboCtrlA","KeyComboMOVE_END","EraseText2","ScrollUntilHost","ScrollUntilRpc","ActionHistoryPure"],"explicitSelection":false,"executed":14,"passed":14,"failed":0,"notExecuted":0,"stopped":false,"retried":false}
```

可选计时preload日志为本地忽略产物 `scripts/android-m15-fixture/.build/suite-first-20261103.log`（103行）；保留的本文摘要与矩阵不依赖该构建目录。完整Android隔离回归1231/1231与CLI/suite安全测试22/22均通过，语法及限定git diff --check通过；两种测试统计不混入14项真机结果。

## 未外推的边界

本次有限矩阵覆盖M1.5所有新增动作主通道及host/RPC两滚动策略，不代表全部参数笛卡尔积。其它键码/修饰键、选区/空字段/Unicode删除、横向滚动、Pinch百分比/步数极值、Drag其它凭据组合、其它ROM/分辨率、真实取消/截止时间异常矩阵仍未真机覆盖。无自主规划、用户业务应用操作或自动GUI降级。所有新增动作保留experimental，无已知阻塞本次14项完成的重大问题。
