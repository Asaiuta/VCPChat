# M4.5 P0：虚拟屏出图成功，前台隔离未通过

> 后续：焦点抢占已由F1候选修复并单机验证，见[焦点修复报告](2026-11-06_android-m4-focus-report.md)。本文的失败结论保持原样，不改写。

2026-11-06，PJZ110 / Android 17：**scrcpy 自建虚拟屏能启动独立 App，并输出真实720×1280画面；但启动后默认屏焦点变为null，未达到“不干扰用户前台”的门槛。** overlay路线被Android拒绝在目标显示启动App。本轮未发送虚拟屏触摸、按键、剪贴板或文本，未进入P1–P5。

两轮实际显示实验均已清理并验证物理屏上下文恢复；最终另行卸载本轮靶场，确认没有遗留显示、服务、转发或临时jar。A3、A4控制输入及A5任务/IME/权限/20次循环保持NOT_RUN。生产AndroidController、M5和显示窗口实现均未由本轮修改。

## 证据与结论

| Evidence | Finding | Path |
| --- | --- | --- |
| [基线](../../artifacts/android-m4-p0-2026-11-06-baseline-r1/result.json) | 默认屏logical ID0，1440×3168；uniqueId为local:4630946756802996883，与SF ID精确对应。64位ID按字符串保留。虚拟屏SF映射未知，未猜测screencap参数 | [显示契约](../../scripts/android-m4/protocol.cjs) |
| [overlay实验](../../artifacts/android-m4-p0-overlay-r3/result.json)、[命令原文](../../artifacts/android-m4-p0-overlay-r3/commands.json) | logical display135 / overlay:1创建成功，真实video/control握手取得720×1280元数据；am start返回SecurityException / Permission Denial，调用者shell UID2000。App未启动，输入0次，A2不通过 | settings overlay → scrcpy mirror → am start |
| [scrcpy自建屏](../../artifacts/android-m4-p0-new-display-r1/result.json)、[真实帧](../../artifacts/android-m4-p0-new-display-r1/frame.png) | logical display137，uniqueId为virtual:com.android.shell,2000,scrcpy,133；靶场独立报告display137/task49340/resumed。收到14帧，FFmpeg解码为720×1280 PNG，非黑像素约99.975%。这证明建屏/启动/采集，未验证输入 | new_display → 双socket → Activity → H.264 → PNG |
| [启动后显示清单](../../artifacts/android-m4-p0-new-display-r1/ready.json) | 默认屏mCurrentFocus=null，虚拟屏焦点指向靶场。默认屏mFocusedApp仍指向原M1.5靶场，无证据表明原任务被迁移；焦点保持判据已失败，停止点击/IME验证 | runProbe → physical/samePhysical → PHYSICAL_CONTEXT_UNPROVEN |
| [最终清理](../../artifacts/android-m4-p0-final-cleanup/result.json)、[命令记录](../../artifacts/android-m4-p0-final-cleanup/commands.json) | 校验APK身份后卸载，pm path确认缺失；仅默认屏，原窗口token/尺寸/Awake恢复；overlay=null；两轮scid的服务/转发/jar均无残留 | 研究进程finally + 独立ADB复核 |
| [最终离线清单](../../artifacts/android-m4-p0-final-checks/evidence.json)、[日志](../../artifacts/android-m4-p0-final-checks/tests.log) | 41 tests / 41 pass / 0 fail、cancelled、skipped，exit0；被检查源码运行前后哈希一致。覆盖焦点变化停止、缓存拒绝、无效果不重放、未知转发清理、外部overlay不覆盖及真实本机TCP双socket握手。替身服务器测试不混为真机结果 | [P0专项测试](../../tests/android-m4-probe.test.js)、既有scrcpy parser测试 |
| [构建清单](../../scripts/android-m4-fixture/.build/build-evidence.json) | SDK35/build-tools36，本地构建、APK v3签名、manifest/zipalign核查通过。运行前与设备base.apk哈希核对一致 | [独立靶场](../../scripts/android-m4-fixture/README.md) |

APK SHA-256：`83e160f1f6d789c7610cffb47cc0856249dd2affe49103d6358fa5049b591c40`。原始H.264：`08655e1037cde445c9bf5a0a1ca2e146e6d6e2dabfab924fa0b404468f9f050e`；PNG：`0db12aeeb88fee850ef60ec8aebcf09f335a5453bcfdfb0467c3361a638af05b`。输入哈希保存于各轮input-hashes.json，最终工具字节封存在final-checks目录。

## 前置失败与分母

实际显示实验为overlay-r3与new-display-r1，两轮均未满足完整隔离判据。此前还有两次前置失败，不计为已执行A2：

- [overlay-r1](../../artifacts/android-m4-p0-overlay-r1/result.json)：ColorOS安装引导导致adb安装12秒超时，当时包缺失但安装引导仍在前台，恢复检查失败。系统随后完成安装，说明结束宿主adb不等于取消系统安装。旧result将A2标为FAILED过早，原始字段保留，此处更正为**安装前置失败、A2未执行**。之后的安装页面上下文校验发现已回原App，零点击退出，见同目录installer-setup.json。
- [overlay-r2](../../artifacts/android-m4-p0-overlay-r2/result.json)：解析器遗漏Android随机安装路径中的标准前缀`~~`，进入建屏前拒绝。修正有对应测试；未放宽隔离判据。

本轮没有重放虚拟屏动作。`writes=0`仅计触摸派发，不表示安装、建屏、启动等零副作用；完整命令记录保留所有变更。没有用空屏建删循环代替A5。

## 实施边界

[探针](../../scripts/android-m4/probe.cjs)默认baseline只读，运行于独立研究目录。显示ID、uniqueId和generation分别记录；SF映射未知就为null。scrcpy显式关闭power_on、clipboard_autosync、stay_awake、keep_active，移除虚拟屏时销毁内容。control socket为完成握手而连接，本轮未向它发送控制消息。

独立Provider只接受fresh采样。未来的点击验证要求同实例/进程UUID、taskId、displayId、尺寸、按钮计数精确加一及触摸事件计数增长。原始事件displayId若因隐藏API不可读，单独标记，不用Activity displayId代替；这些输入读回字段本轮尚无真机验证。

安装准备与实验分开：显式`--use-installed-fixture`仅复用与本地APK SHA-256完全相同的包，本轮结束时保留它；本次最终独立清理卸载了最初安装尝试产生的包。未知安装结局保留INSTALL_RESULT_UNKNOWN，瞬时包缺失不代表系统安装已取消。默认首次安装模式仅清理自己创建的包。

探针没有跨宿主设备租约。用户明确确认手机空闲后才执行变更模式，未与M5真机任务并行。焦点、尺寸、电源或目标身份变化即停止输入。所有失败仍进入清理；即使forward已创建但动态端口返回丢失，也按serial和精确localabstract/scid枚举、删除并核验。其它参与者修改过的overlay设置不被覆盖，无法证明清理时退出非零。

## 复跑与下一步

从仓库根目录复跑离线验证或只读基线。输出目录必须尚不存在，设备地址以当次清单为准：

```powershell
node --test --test-reporter=tap tests/android-m4-probe.test.js tests/scrcpy-parser.test.js
node scripts/android-m4-fixture/build.cjs --sdk F:/AndroidSdk --jdk F:/AndroidSdk/jbr
node scripts/android-m4/probe.cjs --serial 192.168.137.193:41117 --output artifacts/android-m4-p0-baseline-recheck
```

本轮实际隔离实验调用形状如下。靶场已卸载，复跑需先明确完成安装准备；停止条件仍适用，不能直接续跑输入：

```powershell
node scripts/android-m4/probe.cjs --serial 192.168.137.193:41117 --mode overlay --use-installed-fixture --apk scripts/android-m4-fixture/.build/m4-fixture.apk --ffmpeg D:/AI/ComfyUI-aki-v3.2/python/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe --output artifacts/android-m4-p0-overlay-recheck
```

只读差异诊断使用`--mode new-display`及新输出目录，不覆盖A2失败。当前结果支持继续研究Activity启动时的显示焦点归属与OEM策略，不支持合并后台输入。新启动/焦点方案须另立候选和协议，保留既有失败并重新验证物理屏连续可操作性，不能删掉focus不变判据使现有路线通过。A3语义树、A4输入及A5冷/热/同App/singleTask、IME/权限、20次生命周期，在隔离前置修复后再进入。
