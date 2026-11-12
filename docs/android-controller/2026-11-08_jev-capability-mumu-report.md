# MuMu 上的 jev-android 能力对照验证

本次把参考项目已经测试的行为映射到当前 AndroidController，并在用户指定的 MuMu 实例上执行隔离靶场检查。结果计数与当前状态统一见 [README](README.md)；原始证据位于 [本批目录](../../artifacts/android-jev-capability-check-2026-11-08/)。本报告说明测试方法和证据边界。

## 参考范围

参考源码为本地 `D:/AI/_research/jev-android` 的 `be8364ad1a7596172f8cd79c70d2462f4dd0f4dc`，版本 v0.3.7。其 `VALIDATION.md` 当前设备记录包括输入与保存、无效果动作排除并选择替代动作、stale 刷新、selected 元数据、服务中断取消，以及 stale 点击与 WAIT 的差异。历史版本另有应用启动和长按等检查。

上游设备证据来自 Samsung Android 16 和早期 Android 13 官方模拟器；真实模型示例使用 DeepSeek。此次不是重跑上游 APK，也不是 AndroidWorld / AndroidLab 成绩，而是验证本项目对应的执行路径。

## 设备与冻结条件

设备为 MuMu 实例 0，ADB `127.0.0.1:16384`，Android 15 / API 35，CPU ABI `x86_64`，display 0。系统向 ADB 报告型号 PGBM10、fingerprint `OPPO/ali/ali:15/V417IR/1171:user/release-keys`；这些是模拟器报告值，不代表另测了一台 OPPO 手机。设备原始分辨率 1080×1920，靶场运行时为横屏 1920×1080。

靶场包为 `com.vcpchat.m15fixture`，仅保留内存状态，无网络权限。APK 由当前 fixture 源码复制到本批目录后构建，避免覆盖旧构建证据。每个实际批次记录源码与 APK SHA-256、固定用例、预算、设备身份及退出结果。开始前要求前台包、解锁和唤醒状态均可证明。

独立检查器通过只读 ContentProvider 获取真实应用事件计数、文本和结果状态，不以任务自己的完成回执作唯一依据。检查器读取方式、每次读取结果及场景初始化均留档。

## 能力与证据对应

| 对应行为 | 本项目执行路径 | 判据与限制 |
| --- | --- | --- |
| 找到输入框、写入、提交并检查结果 | M5 rules 搜索矩阵；通用 `ui_task` SearchFromHome | provider 精确核对查询值、提交次数、入口次数及结果可见；规则执行与通用决策分开计数 |
| 已派发但界面无效果 | NoEffectThenAlternative | provider 记录一次提交；下一次决策收到 `changed:false`，相同目标不再是候选；改选靶场编辑页 |
| 观察后目标变化 | StaleBeforeFill | 决策提供器返回前用 ADB 对已确认聚焦的靶场字段做一次外部编辑；旧回答丢弃，刷新后执行；外部编辑单独记账 |
| 等待决策时取消 | CancelWaitingProvider | 等待中的本地提供器收到 AbortSignal，排干后独立状态未改变；这是宿主取消路径，不是 Android 无障碍服务被系统杀掉 |
| 长按、双击、拖动、缩放、滚动、键盘操作 | M1.5 设备矩阵 | 靶场独立事件计数；长按只检查回调，未测 DOWN/UP 实际时长 |
| 重复目标、密码字段、只读策略、预算与预取消 | M5 停止用例 | 独立状态证明拒绝时未写；预算耗尽允许真实已派发提交保留 unknown，禁止重放 |
| 应用启动、更多恢复与取消边界 | 所选离线测试 | 注入设备证据；不可计入相应 MuMu 设备覆盖 |
| selected 元数据 | 生产源码包含 selected 投影与页面摘要 | 本批未做 selected 状态变化的专项设备验证，不能宣称与上游该用例对齐 |
| 原生 `LONG_CLICK` | 本轮没有对应设备用例 | 不能用定时 LongPress 结果代替 |

通用循环使用显式注入的确定性提供器，生产 Service、观察、候选生成、执行、排干和轨迹路径照常运行。提供器只在本机返回有限候选的概率；模型调用计数中的这些本地决策不代表网关请求。没有向 Jev、DeepSeek 或主模型发送靶场请求，也没有进行 Bilibili 点赞、投币、收藏。

## MuMu 兼容问题及失败保留

| 证据 | 发现 | 处理路径 |
| --- | --- | --- |
| `mumu-setup/error.json` | 系统 `pm path` 在未安装包时返回非零，被准备脚本当作异常 | 改为读取 `pm list packages` 判定未安装；新准备批次留在 `mumu-setup-r2` |
| `m5-r1/suite.log`、`content-diagnosis.jsonl`、`content-crash.log` | 系统 64 位 `content` 在 native shutdown 中 SIGSEGV，进程退出 139；即使有 JSON 也不接受 | 同一系统 `content.jar` 显式通过 `app_process32` 执行；仍要求退出 0 和严格状态解析，未吞掉错误或改判据 |
| `m15-r1/adb.jsonl`、`m15-r1/suite.log` | 前台 Activity 接收新 intent 后没有重新读取 fixtureMode，仍是上一套矩阵的页面 | 测试准备阶段先 force-stop 本次靶场，再以冻结模式启动；保留旧批次 |
| `m15-r2/suite.log`、`regression-before.log` | ScrollUntil 使用旧 probe 的自然方向尺寸，却与目标绑定使用的当前逻辑尺寸比较，横屏被拒绝 | 生产路径复用 `freshFrameProbe`，统一当前逻辑尺寸与已有取消/截止检查；新增横屏反例，按新源码冻结 `m15-r3` |
| `m15-r2/suite.log`、`regression-before.log` | actionHistory 保留先前用例失败；runner 错把历史中每一项都要求为成功 | runner 对当前 requestIds 要求成功，对其它历史只检查合法结构/结果；保留纯查询与输入不泄漏检查，并验证当前动作 failed/unknown 仍不能通过 |
| `ui-task-r1/provider.jsonl`、`ui-task-r1/receipts.jsonl` | MuMu 的初始 m5 字段未聚焦；本地提供器的外部编辑前置断言失败，被任务记为 `TASK_JEV_UNAVAILABLE`，未派发任务动作 | 新批次 `ui-task-r2` 显式预聚焦同一字段并记录准备回执；仍要求独立文本/提交计数未变，再开始原预算任务。此停止不代表网关错误 |

系统 content 的兼容调整位于本批证据目录的驱动中，仅替换精确匹配的靶场只读查询启动方式。生产修改限定为 ScrollUntil 使用已有新鲜采样接口，测试修改限定为历史断言范围；没有修改模型概率门槛、完成谓词、Android 系统设置或靶场 APK。用例执行遇到未知写或无法排干时沿用原停止规则。失败记录不会被后续批次覆盖。

初始离线与设备批次、修复后离线与设备批次各自绑定源码摘要，不互相改写。新增反例先在旧实现失败，再在修复后通过；专项回归日志在 `regression-before.log` / `regression-after.log`，扩展回归及其源码身份在 `fix-regression/`。

## 复现入口

在仓库根目录执行。当前包装脚本使用排他创建的批次目录，重跑前必须给它分配新的输出目录，不能覆盖已有结果。

```powershell
node artifacts/android-jev-capability-check-2026-11-08/run-device.cjs m5
node artifacts/android-jev-capability-check-2026-11-08/run-device.cjs m15
node artifacts/android-jev-capability-check-2026-11-08/run-ui-task.cjs
```

入口会调用既有正式设备 runner；通用循环驱动单独保留冻结任务、决定输入、独立检查器输出及生产轨迹。每轮结束检查相关源码是否漂移。使用其它 MuMu 地址或 ROM 必须新建批次并重新记录身份。

这些是工程能力检查，不是独立真实任务样本，没有风险率校准结论。它们不覆盖真实模型导航质量、其它 App、长时间稳定性、多屏或其它 ROM；J0.2 的独立验收集和任务族准入要求仍按原协议执行。
