# 无模型 RPC 故障与固定时长持续运行

当前结果、计数与阶段状态只在 [README](README.md) 维护。本报告解释证据范围、复现方法和仍未解决的触摸边界。

本报告保留修复前的历史批次。后续生产已增加未知触摸持久隔离及同设备新启动核验，当前故障入口要求 `--restart-device`；新用法与边界见[输入恢复报告](2026-11-08_android-input-recovery-report.md)。下方旧命令和外部靶场CANCEL只说明当时的测试，不代表当前生产恢复方式，旧持续运行结果不继承至新源码。

## 执行范围

[批次入口](../../scripts/verify-android-resilience.cjs)使用生产 AndroidController 的 Observe、ExecuteStep、Manage recoverOwner、cleanup。设备为 MuMu Android 15 / API 35 / x86_64 / display 0，系统报告的 PGBM10/OPPO 指纹不代表实体手机。使用已有隔离主靶场及伴随 APK，没有调用任务模型或本地决策提供器，没有调整生产策略。生产源码及 APK 沿用本轮前的版本。

输出目录必须不存在。`freeze.json` 固定源码/APK身份、设备参数、故障矩阵、预算、检查器和持续运行阈值。每个故障、每轮持续运行及结束时检查源码未变；安装 APK 在开始与结束校验。失败立即停止，不重放未知动作，不覆盖失败批次。

## 复现

设备须已连接、点亮并解锁，且安装的 APK 与指定文件一致。下面的路径指向本工作区保存的构建产物；替换 APK 后必须开新批次。

```powershell
node scripts/verify-android-resilience.cjs --mode faults `
  --serial 127.0.0.1:16384 --adb D:/AI/tools/platform-tools/adb.exe `
  --apk artifacts/android-no-model-suite-2026-11-08/fixture-build/.build/m15-fixture.apk `
  --peer-apk artifacts/android-no-model-suite-2026-11-08/fixture-build/.build/m15-journey-peer.apk `
  --content-runtime 32 --output artifacts/android-resilience-faults-new

node --expose-gc scripts/verify-android-resilience.cjs --mode soak `
  --serial 127.0.0.1:16384 --adb D:/AI/tools/platform-tools/adb.exe `
  --apk artifacts/android-no-model-suite-2026-11-08/fixture-build/.build/m15-fixture.apk `
  --peer-apk artifacts/android-no-model-suite-2026-11-08/fixture-build/.build/m15-journey-peer.apk `
  --content-runtime 32 --output artifacts/android-resilience-soak-new
```

`content-runtime 32` 显式使用系统 content.jar 的 32 位入口，仍要求退出码为零。异步独立读取避免在等待真实 DOWN 时阻塞宿主 RPC 及 AbortSignal 事件循环；正常读取保持原检查器。

## 故障判据

| 场景 | 注入位置 | 独立依据与硬判据 |
| --- | --- | --- |
| CancelInFlight | 独立 provider 看到 activeTouch 后触发 AbortSignal | 在途租约存在；返回 unknown / retryable:false；随后写入被隔离；原动作即使继续完成也不可重放 |
| DelayedResponse | 本机代理收到真实设备 click 回执后延迟发送 | 原请求字节只转发一次；超时后与迟到回执抵达后均保持隔离；靶场只有一次 DOWN |
| DroppedResponse | 收到真实设备回执后销毁客户端连接 | 物理动作可能已完成，控制器必须保留 unknown；禁止再次派发 |
| KillOwnedProcess | 独立看到 DOWN 后核对 PID、startTime、UID、完整 cmdline，再终止该进程 | 不使用广泛进程匹配；未知动作停止，后续写被阻止；恢复必须证明原进程和两个监听端口消失 |

代理仅监听 loopback，保留真实 RPC 请求/响应语义，改变回执送达时机；不修改 ADB 全局服务，也不制造模型请求。它不模拟整机网络断开或 ADB server 崩溃。恢复后重新采树，验证新的进程身份，且原触摸计数不增加。清理检查运行时租约、队列、owner 和 ADB 转发。

## 持续运行判据

协议固定 30 分钟，约每 15 秒执行一次受限长按，单轮最多 60 秒，至少完成 60 轮。每轮要求一次新增 DOWN、UP、长按，无短按、无取消、无活动触摸，并检查宿主队列已排干。长按事件时间固定容差为 700–1300 ms。

每十轮完整清理和重建 RPC，证明旧进程、监听端口和本批转发消失。最后一个重建的 owner 可能只用于采树后清理；`result.json` 的 `ownerGenerations` 统计被资源采样的 owner，全部清理身份以 `events.jsonl` 的 `owner-gone` 为准。

资源门槛在开跑前冻结：宿主 RSS 不超过 768 MiB、强制 GC 后 heapUsed 不超过 256 MiB；相对首轮分别最多增加 128 MiB / 64 MiB；设备 RPC 的线程和 fd 相对首轮最多增加 32 / 64。每轮记录完整周期耗时，包含独立读取、资源读取及到期的重建，不能称为单次 RPC 延迟。强制 GC 的测试条件、固定靶场和周期重建均限制了对正常长期运行的外推。

## 证据 → 发现 → 执行路径

| 证据 | 发现 | 执行与判定路径 |
| --- | --- | --- |
| [faults-r1](../../artifacts/android-resilience-faults-2026-11-08-r1/result.json) 与事件 | 同步 provider 查询阻塞宿主事件循环，未能在截止内观察到实际 DOWN | 注入工具改为异步读取；原批失败保留，新批重新冻结 |
| [faults-r2](../../artifacts/android-resilience-faults-2026-11-08-r2/events.jsonl) | 进程退出证明与触摸状态复位是不同事实 | 强杀后靶场 activeTouch 仍为 true，没有 UP/CANCEL；不把 owner released 当作手势撤销 |
| [soak-r1](../../artifacts/android-resilience-soak-2026-11-08-r1/result.json) 与 [系统证据及清理记录](../../artifacts/android-resilience-soak-2026-11-08-r1/preparation-after-failure.json) | 强杀遗留的系统触摸状态可跨靶场重启；下一次 DOWN 被系统以 pointers already down 拒绝 | 保留 unknown 和失败；独立确认原 owner 消失，固定包前台后显式 CANCEL；随后开新批 |
| [faults-r3](../../artifacts/android-resilience-faults-2026-11-08-r3/events.jsonl) | 未知结果没有重放；迟到回执没有解除隔离；测试环境 CANCEL 单独记账 | 真实 Service → loopback 代理 → 真实 RPC → TouchPad / provider；Manage 恢复 → /proc 独立消失证明 |
| [soak-r2](../../artifacts/android-resilience-soak-2026-11-08-r2/events.jsonl) | 正常固定工作负载、周期资源采样及完整重建的持续运行记录 | 生产 Observe / LongPress → 独立触摸计数 → 租约/队列 → 资源门槛 → 周期 cleanup |
| [离线选择集](../../artifacts/android-resilience-offline-2026-11-08/selection.json)、[结果](../../artifacts/android-resilience-offline-2026-11-08/result.json) | 实际 loopback 丢包/延迟、错误退出、监听残留和错误进程身份有反例检查 | Node tests；模型与设备调用均未进入此离线回归 |

## 尚未解决的生产边界

强杀 RPC 时，生产 recoverOwner 只证明原 owner 已消失，没有自动清除 Android 的触摸注入状态。批次工具执行的 CANCEL 是固定靶场的显式环境清理，独立记录且发生在失败结果和消失证明之后；没有加入生产恢复逻辑，不能外推到用户正在触摸或其它 App 的场景。正常 AbortSignal 取消也不保证远端长按立刻终止。

本轮持续运行只覆盖固定 TouchPad、单 display、单模拟器及周期重建。它不验证多步骤任务的长稳、实际网络断开、锁屏、前台抢占、旋转、多屏、其它 ROM，或无需外部干预的强杀后完整恢复。AndroidWorld / AndroidLab 官方任务环境和真实模型质量仍需各自的独立批次。所有策略保持 calibrated:false，测试不产生独立真实准入样本。
