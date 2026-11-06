# M4.5 焦点修复 F1：虚拟屏不再抢物理屏焦点（单机验证）

2026-11-06，PJZ110 / Android 17：给scrcpy自建虚拟屏补上`VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED`以后，**在虚拟屏冷启动App、出实帧、发一次定向点击，整个过程都不改变物理屏焦点窗口**。冻结批次R2：资格1/1、矩阵**20/20 PASSED**，每轮都清理通过。它修复的是[P0报告](2026-11-06_android-m4-p0-report.md)里的焦点缺陷，不代表M4.5可进生产。

## 根因

scrcpy v5.0.1的`NewDisplayCapture`本来就设了`VIRTUAL_DISPLAY_FLAG_OWN_FOCUS`。这个flag只让虚拟屏维护自己的焦点窗口，**不阻止它抢全局top focus**，所以Activity一启动，虚拟屏就被提到最上层，默认屏`mCurrentFocus`变成null。

AOSP（Android 14+）提供了`VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED = 1 << 16`：它经`DisplayWindowSettings`设置`mDontMoveToTop`，Activity启动不再把该显示屏移到最上层；WMS也不会因为对它的定向触摸把它提上去。定向输入照常由`OWN_FOCUS`接收。来源与哈希见[源码研究](../../artifacts/android-m4-focus-2026-11-06/research-agent/focus-research.md)。

注意：`DisplayInfo.toString()`不打印这两个flag，必须从**DisplayDeviceInfo**读取，不能因为逻辑显示信息里没有就推断flag缺失。

## 证据

| Evidence | Finding | Path |
| --- | --- | --- |
| [构建证据](../../scripts/android-m4-focus-server/.build/build-evidence.json)、[独立核查](../../scripts/android-m4-focus-server/.build/independent-verification.json) | 候选`scrcpy-5.0.1-focus1`，upstream `a60891aea193d92e7e5c3942700eca63f9d19a5f`。唯一改动：在`NewDisplayCapture`已有的SDK≥34分支加`1 << 16`。两次构建字节一致，95份源文件无漂移，6条构建命令exit 0 | [构建器](../../scripts/android-m4-focus-server/) |
| [冻结协议](../../scripts/android-m4/focus-protocol.md) | `M4-focus-F1`，在资格验证前冻结。要求三个flag（TRUSTED/OWN_FOCUS/STEAL_TOP_FOCUS_DISABLED），物理屏窗口token、焦点、尺寸、Awake不变 | [探针](../../scripts/android-m4/probe.cjs) `--mode focus1` |
| [qualification-1](../../artifacts/android-m4-focus-2026-11-06/qualification-1/result.json) | display138，物理屏焦点保持为AboutMeActivity；靶场`taps 0→1`、`touchEventCount 0→2`、`deliveredDisplayIds:[138]`；19帧实图；清理PASSED | — |
| [matrix-20（首批）](../../artifacts/android-m4-focus-2026-11-06/matrix-20/summary.json) | **0 pass / 1 fail / 19 NOT_RUN**：第1轮建屏前快照发现物理屏已从AboutMeActivity切到Launcher，报`MATRIX_PHYSICAL_BASELINE_CHANGED`。中止时零建屏、零输入。原始记录保留 | — |
| [R2说明](../../artifacts/android-m4-focus-2026-11-06/campaign-r2.md)、[qualification-r2](../../artifacts/android-m4-focus-2026-11-06/qualification-r2/result.json) | 设备操作前冻结，以当前Launcher为基线重新做资格验证：display139，物理屏焦点保持`Window{d75cf0d … Launcher}`，点击后虚拟屏焦点为靶场，清理后physicalRestored=true | — |
| [matrix-20-r2](../../artifacts/android-m4-focus-2026-11-06/matrix-20-r2/summary.json)、[汇总](../../artifacts/android-m4-focus-2026-11-06/campaign-r2-result.json) | **20 planned / 20 pass / 0 fail / 0 NOT_RUN**，display140–159。每轮新scid/generation、靶场进程冷启动、1次定向写入、清理PASSED；`sourceChanged=[]`。耗时3分04秒 | [矩阵脚本](../../scripts/android-m4/focus-matrix.cjs) |
| 离线回归 | `android-m4-probe` + `scrcpy-parser` + `android-m4-focus-matrix`：**51 tests / 51 pass / 0 fail**，exit 0 | [探针测试](../../tests/android-m4-probe.test.js)、[矩阵测试](../../tests/android-m4-focus-matrix.test.js) |

哈希：候选jar `96549eae69e2e00a4a0c9ac2d5237d482092bd3eeb43ef05a4edc111fc81df6b`（99,873 bytes）；靶场APK `83e160f1f6d789c7610cffb47cc0856249dd2affe49103d6358fa5049b591c40`。

设备拿不到原始MotionEvent的displayId（`NoSuchMethodException`），已显式记录。点击送达靠的是另一组独立证据：接收Activity所在display/task/进程UUID不变，按钮计数恰好+1，触摸事件计数增加。

## “物理屏不变”判据到底在测什么

做虚拟屏，就是为了让AI在后台屏上干活，用户继续正常用手机，所以这个判据**不是要求用户别碰物理屏**，而是验证**虚拟屏上的操作不会去动物理屏**。P0的失败正是这一条：AI在虚拟屏一启动App，就把用户当前前台的焦点抢走了。

本轮测试为了把因果归到虚拟屏，要求测试期间物理屏静止。首批中止就是因为物理屏在建屏**之前**被切到了桌面，不是虚拟屏造成的；把这个变化当成“隔离失败”，在测试设计上过严了。生产里应该改成：

- 只把**由虚拟屏动作引起**的物理屏焦点变化算违规，也就是比较动作前后的焦点迁移，并核对迁移是否指向虚拟屏display。
- 用户在物理屏上的正常操作视为预期。它会使旧的物理屏快照失效，但不阻断虚拟屏任务。

## 边界与剩余项

- 只验证了单设备（PJZ110/ColorOS/Android 17）、单靶场、`input -d`单次点击。scrcpy control socket已连接，但没有发控制消息。
- IME：非top-focus显示屏上的输入法受框架限制，保持`display_ime_policy=hide`；`KEYCODE_PASTE`、剪贴板、文本输入均未验证，继续禁止。
- 未覆盖：语义树/display-aware感知（A3）、同App跨屏迁移与singleTask、系统权限弹窗、跨ROM、Android 13及以下（flag不可用，应拒绝进入后台写入）、长时soak。
- 生产AndroidController与内置vendor jar均未修改；候选只在研究目录内。
- 下一阶段 F2（A3 shell 语义树归属 + A4 scrcpy control 触摸）：协议在上真机前冻结，离线 63/63 通过，详见 [f2-protocol.md](../../scripts/android-m4/f2-protocol.md)。R1 真机结果：资格验证通过，矩阵 5/1/14。第 6 轮因物理屏上的人工操作（logcat 记录了回桌面、打开 B 站）在输入前中止。control 触摸 6/6 生效。A3 共 12 次 dump，全部只读到默认屏，结论为 `NOT_SUPPORTED`。详见 [R1 结果](../../artifacts/android-m4-f2-r1/RESULT.md)。R2 矩阵 15/1/4，第 16 轮同样在派发前因人工回桌面、打开 B 站而中止，见 [R2 结果](../../artifacts/android-m4-f2-r2/RESULT.md)。合计 control 触摸 **22/22** 次实际派发全部生效。A3 失败的原因是 `uiautomator dump` 只取活动窗口，而活动窗口按 F1 设计本来就留在物理屏。候选方案为隐藏参数 `dump --windows`（多屏），用 `--a3-windows` 在真机单轮验证通过：靶场按钮被正确归到虚拟屏 183，点击前后的数据都是新鲜的，dump 约 2.2 秒。见 [A3 研究](../../artifacts/android-m4-f2-a3-research/README.md)。耗时主要来自每次冷启动 VM 加上 `waitForIdle` 至少 1 秒，所以改用常驻的生产 u2 server。F3W 单轮（因果判据）PASSED：carrier 用 `rootInActive=false` 时，节点自带 `display-id`，6 次都正确归到虚拟屏 184，热路径 39–67ms，见 [F3W 结果](../../artifacts/android-m4-f3w-q2/RESULT.md)。**F3W 20 轮 20/20**（因果判据下用户全程使用手机，外部焦点变化 66 次，因果违规 0；carrier 共 126 次 dump，p50 64ms、p95 505ms，慢尾来自物理屏界面过于复杂），见 [F3W 20 轮](../../artifacts/android-m4-f3w-m20-r2/RESULT.md)。
- **最终清理（15:34完成）**：设备重连后先核对远端`base.apk` SHA-256与靶场APK一致，再卸载`com.vcpchat.m4fixture`（Success），`pm path`为空。复核结果：只剩默认屏display0；无scrcpy进程、无adb forward；overlay=null；Awake。`/data/local/tmp/scrcpy-server.jar`是生产插件使用的通用文件名，不属于本研究的scid专属jar，未动。物理屏当时在设置页，是用户自己的操作，与本研究无关。
