# 未知触摸的持久隔离与恢复

当前状态与计数统一见 [README](README.md)。本轮修复的是：RPC 进程退出后，系统触摸状态可能仍残留，控制器不应因此直接解除隔离。

最终可核对产物包括[汇总](../../artifacts/android-input-recovery-2026-11-08/result.json)、[证据摘要](../../artifacts/android-input-recovery-2026-11-08/evidence-sha256.json)和[完整批次台账](../../artifacts/android-input-recovery-2026-11-08/batch-ledger.json)。离线、真实故障与正常动作使用相同生产文件身份；中间版本、失败批和事后环境恢复均保留，不覆盖旧结论。

## 生产行为

[InputRecovery](../../VCPDistributedServer/Plugin/AndroidController/lib/input-recovery.js)在真实触摸 RPC 派发前保存并同步一条持久记录。记录包含设备选择器、启动 ID、Android ID 的 SHA-256 和本次随机标识，不包含屏幕、坐标、输入文字或原始 Android ID。文件位于宿主数据目录的 `android-input-recovery` 下，文件名为选择器摘要。

适用方法由原 [RPC 签名表](../../VCPDistributedServer/Plugin/AndroidController/lib/rpc-methods.js)中的 `touch` 属性标识：click、swipe、longClick、drag、dragTo、pinchIn、pinchOut、scrollTo。成功的 RPC 或可信未派发拒绝清除自己的记录；false、设备执行错误和传输未知都保留记录。HTTP 已完整返回只能证明回执排干，不能证明半途失败的手势已释放。

[会话恢复](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-sessions.js)继续证明旧 owner 已退出，但存在未知触摸记录时，还要求原设备 Android ID 摘要匹配且 `boot_id` 已变化。旧进程退出而设备仍属同一次启动时，返回 `DEVICE_INPUT_STATE_UNCERTAIN`、`recovered:false`；控制器重启后的新进程同样读取持久记录并拒绝操作。

生产控制器不会自动重启设备或发送 CANCEL。用户重启原 Android 设备、连接后再次执行 `Manage operation=recoverOwner`，才进入额外证据核验；恢复不重放原动作。Android ID 缺失、变化或启动身份无法读取时停止，不能用人工确认清记录。Android ID 是本地一致性标识，不是硬件认证：克隆模拟器、跨用户或恶意设备伪造不在本轮证明范围。

触摸记录在当前运行时进行中时仍由原设备租约管理，避免把执行中的正常记录当作已隔离。结局未知或宿主进程重启后，记录才阻断准入；磁盘读取、同步或删除失败均不允许据此派发/继续写入。持久化采用排他创建与文件 fsync；不宣称抵抗文件系统损坏、人工删除数据目录或断电下目录项丢失。

## 执行接缝

启动身份只在每个已绑定 owner 上读取一次，且放在最后的新鲜目标检查之前。每个触摸请求的持久化仍在派发前进行，之后立即重查原截止和双击窗口。第二击没有额外 ADB 身份读取；磁盘耗时超过原窗口时不发第二击，不增加预算。

恢复证据失败属于硬停止，不进入 RPC → shell 降级。所有走共用写入检查的通道还会检查同设备的遗留记录，防止换设备地址后通过按键、剪贴板或 shell 输入绕过。设备别名的跨进程并发管理仍不是全局分布式锁；本轮只保证顺序调用和遗留记录检查。

这次没有给普通 shell 触摸新增完整的崩溃持久化协议，没有给普通键盘 RPC 增加相同标记，也没有改变设备端 vendor APK。它们的既有未知写停止规则仍在；本轮结论限定为生产触摸 RPC 及该记录对后续通道的封锁。

## 设备批次

[故障入口](../../scripts/verify-android-resilience.cjs)现在要求显式 `--restart-device`，仅用于专用测试设备。每个故障先核验独立 DOWN、unknown 回执、零重放、旧进程退出后仍隔离，然后以[独立宿主子进程](../../scripts/android-device-suite/recovery-child.cjs)再次检查 Observe、写入和恢复均被阻止。之后测试工具重启已选设备，核验新启动身份，调用生产恢复，再运行一条新长按并独立核对 DOWN/UP。重启是测试工具明确执行的环境动作，不是生产自动行为。

```powershell
node scripts/verify-android-resilience.cjs --mode faults --restart-device `
  --mumu-manager 'D:/Program Files/Netease/MuMu/nx_main/MuMuManager.exe' --mumu-instance 0 `
  --serial 127.0.0.1:16384 --adb D:/AI/tools/platform-tools/adb.exe `
  --apk artifacts/android-no-model-suite-2026-11-08/fixture-build/.build/m15-fixture.apk `
  --peer-apk artifacts/android-no-model-suite-2026-11-08/fixture-build/.build/m15-journey-peer.apk `
  --content-runtime 32 --output artifacts/android-input-recovery-new
```

`freeze.json` 冻结代码、APK、案例、六秒动作截止和两分钟重启截止。任何失败保留并停止，剩余场景未跑，不通过放宽截止追绿。每轮状态目录属于该批输出，跨宿主子进程共享；不删除隔离文件来使新批通过。

默认重启方式为ADB。该MuMu环境的ADB重启曾反复使端口长期offline，指定端口重新连接也未恢复，因此后续批次预先选择官方实例接口；工具先核验实例索引及ADB地址对应，只对指定实例调用restart。管理器文件摘要也冻结，命令退出码和JSON结果都必须成功。重启方式无运行时回退；包含实例控制耗时的原两分钟截止不变。此前ADB重启批次仍按超时失败保留。

## 证据 → 发现 → 路径

| 证据 | 发现 | 修复/判定路径 |
| --- | --- | --- |
| [此前系统触摸残留](../../artifacts/android-resilience-soak-2026-11-08-r1/preparation-after-failure.json) | owner 消失不等于输入状态清空；系统可拒绝下一次 DOWN | 引入输入持久记录和同设备新启动证明 |
| [首次设备探索](../../artifacts/android-input-recovery-device-2026-11-08-r1/events.jsonl) | 控制器退出后另起进程仍阻断，真实系统重启后可恢复 | Service → 触摸 RPC → 独立 provider → recoverOwner → 新宿主 → Android 重启 → 新动作 |
| [最终设备批](../../artifacts/android-input-recovery-device-2026-11-08-r4/result.json)与[完整事件](../../artifacts/android-input-recovery-device-2026-11-08-r4/events.jsonl) | 强杀后独立检查仍见activeTouch；旧owner消失和新宿主均不能绕过记录；同设备新启动后才接受新动作 | 在途取消、延迟/丢失回执、强杀分别冻结验证；仅环境工具使用MuMu实例重启，无外部CANCEL |
| [最终离线回归](../../artifacts/android-input-recovery-offline-2026-11-08-r4/result.json)与[日志](../../artifacts/android-input-recovery-offline-2026-11-08-r4/tests.log) | 持久化失败、清记录失败、别名、同次启动、错误设备、RPC降级及原双击截止均需保持保守行为 | 真实loopback故障、Service持久状态、任务语义及实例重启范围反例共同核验；完整选择集与摘要保留 |
| [存储删除反例](../../artifacts/android-input-recovery-offline-2026-11-08-r1/storage-counterexample.log) | 本地拒绝后的删除失败可能把记录误留在执行中集合 | 删除前先退出 active；异常仍保留可见隔离 |
| [降级反例](../../artifacts/android-input-recovery-offline-2026-11-08-r1/fallback-counterexample.log) | 新恢复错误若按普通 RPC 不可用处理会落入 shell | 将恢复失败定义为硬停止，共用写入检查同设备记录 |
| [第二设备批](../../artifacts/android-input-recovery-device-2026-11-08-r2/result.json) | MuMu 重启后 ADB offline 超过固定截止，不能判恢复通过 | 失败保留；仅对实例 0 使用 MuMu manager 恢复，后续新批重新冻结 |
| [第三设备批](../../artifacts/android-input-recovery-device-2026-11-08-r3/result.json)及[事后恢复](../../artifacts/android-input-recovery-device-2026-11-08-r3/recovery-after-deadline.json) | 相同ADB重启问题再次发生，端口重连也失败 | 原批失败不变；冻结新的MuMu实例重启后端，保留原启动身份与独立检查判据 |
| [第二离线批](../../artifacts/android-input-recovery-offline-2026-11-08-r2/result.json) | 测试执行通过但测试文件在运行中新增，摘要检查失败 | 不作最终准入证据；最终版本使用完整新批 |
| [正常动作首批](../../artifacts/android-input-recovery-m15-2026-11-08-r1/result.json)与[事后读取诊断](../../artifacts/android-input-recovery-m15-2026-11-08-r1/read-diagnostic.json) | DoubleTap准备后ADB读取失败，动作未派发；随后同组只读命令在原截止内完成，但原失败命令缺少退出明细，不能据此确认根因 | 原批失败与未跑项保留；新批保持生产源码、任务及截止，仅使用[观察包装](../../artifacts/android-input-recovery-2026-11-08/run-m15.cjs)保存命令耗时/退出信息，不改参数或返回值 |
| [最终正常动作批](../../artifacts/android-input-recovery-m15-2026-11-08-r2/result.json)与[命令退出/耗时](../../artifacts/android-input-recovery-2026-11-08/m15-r2-commands.jsonl) | 正常触摸、双击时窗、输入及滚动路径在新增持久化后通过原独立检查器 | 相同源码与APK，原动作/读取预算不变；此次通过不能抹去首批读取失败或证明长稳 |

旧的持续运行批次对应修复前生产源码，不继承为新版本长稳结论。本次无模型请求，不积累独立真实质量样本，策略仍为 `calibrated:false`。旋转、锁屏、前台抢占、公开测评环境与模型质量另立后续批次。
