# 通用任务 v19：离线协助、回放与 viewer 收尾

本批完成 `ui-task-v19 / ui-elements-v10 / ui-predicates-v1` 的离线工作：通用循环接入显式主 Agent/Handoff，加入统一回放，并修复 viewer 关闭后的异步响应竞态。按用户指示，本批没有真机或真实模型请求。当前档位、测试总数和历史失败统一见 [状态索引](README.md)；策略仍为 `calibrated:false`，独立准入样本为零。

v18/r21 的 Legado 成功仅对应当时冻结字节，保留在[历史报告](2026-11-07_jev-ui-task-implementation.md)。v19 不继承该真机结论。算法加载等待、概率门槛、完成谓词和任务预算均未放宽。

## 使用与边界

`RunTask intent=ui_task` 可显式指定 `assistance=main_agent` 或 `assistance=human`，默认 `none`。有效低置信决策或模型显式选择 escalate 后，才可调用一次协助；正常路径中间主模型/Handoff 调用为零。非法响应、未知写、无法证明的上下文及传输失败继续停止。

所有任务族共用 [androidTaskAssistance.js](../../modules/services/androidTaskAssistance.js)：主 Agent 最长 10 秒，Handoff 最长 60 秒，均受原任务总截止和取消信号约束。取消后等待实际依赖排干，再释放设备租约。协助不能刷新动作、观察、模型预算或抹掉既有回执。

主 Agent 使用发起调用实际选中的模型，只能选择本次已有候选、要求重观察或停止。不能生成新动作参数、输入值或新的完成条件。协助后必须取得新观察：上下文不一致立即停止；内容变化使旧候选选择失效；已经匹配的可见输入值必须保持，变化后无法唯一证明字段和值时停止为 `TASK_PROGRESS_LOST`。人工交还也经过这些检查，继续按钮不代表任务完成或敏感写授权。

通用主 Agent 收到有界目标、非密码候选描述（可能含当前字段值）、输入引用、完成条件类型和满足布尔值、回执及剩余预算。不会收到完整 inputs 映射、原始树、设备序列号或完整聊天。此契约与旧类型化任务的文字外发范围不同；持久轨迹和结果仍只保存摘要及引用。候选描述不是可执行指令。

## 证据、结论与代码路径

| Evidence：离线证据 | Finding：验证的行为 | Path：实现与调用链 |
| --- | --- | --- |
| [协助专项](../../tests/android-ui-task-assistance.test.js)，包含身份/候选变异、超时、未知写、进度丢失、轨迹失败与终止预留 | 默认零协助；显式协助最多一次，交还后复核，硬停止不可绕过；普通轨迹容量耗尽仍尝试保留终止事件 | [通用循环](../../modules/services/androidUiTaskLoop.js) → [共享协助调用器](../../modules/services/androidTaskAssistance.js) → 新观察/派发前检查 |
| [分布式主 Agent 链测试](../../tests/android-main-agent-chain.test.js)；[上游日志](../../artifacts/android-ui-task-offline-v19-2026-11-07/toolbox-regression.log) | 通用证据经过真实分布式路由和上游投影器，再进入注入的 originating-model fetch；取消会排干，不发真实模型请求 | VCPChat Service → Android replan channel → VCPToolBox `androidTaskReplanner.js` / `androidUiTaskReplanEvidence.js` |
| [统一回放目录](../../tests/fixtures/android-jev/replay.json)与[入口断言](../../tests/android-jev-replay.test.js) | 通用导航、Back、Scroll、算法加载、stale、非法回答、unknown 写、主 Agent、Handoff、取消均可复现；比较实际写入与独立世界终态，成功写入案例有拒绝全部决策的反事实对照 | 目录 → [通用适配器](../../tests/helpers/android-ui-task-replay.cjs) → 生产 Service/执行器 → 注入设备与模型 |
| [viewer 专项日志](../../artifacts/android-ui-task-offline-v19-2026-11-07/viewer-focused.log)及两个在途设备响应回归用例 | 关闭 takeover 后只读设备轮询不会重开流；卸载后迟到响应不会更新界面或复活定时器 | [viewer.html](../../VCPDistributedServer/Plugin/AndroidController/lib/viewer.html) 的 `refreshDevices`、`scheduleDevicePoll` 与卸载处理 |

VCPToolBox 新投影器独立核对策略、task/observation 身份、候选结构、包/参数引用白名单、预算与计数、完成条件布尔一致性、无 unknown 回执及载荷上限。HTTP 尝试数与协助回调数分开，缺失的模型版本/usage/请求数保持未知。需要同时使用本工作区的 VCPChat 与 sibling VCPToolBox 变更；旧上游不支持 v19 通用投影。

viewer 的旧零定时器断言已改为精确区分只读设备轮询和写会话重连：主动关闭后允许保留一个只读轮询，页面卸载仍要求零定时器。补充的迟到响应测试覆盖实际竞态，避免仅修改旧断言追绿。

## 冻结与复现

测试选择集见 [selection.json](../../artifacts/android-ui-task-offline-v19-2026-11-07/selection.json)。[before.json](../../artifacts/android-ui-task-offline-v19-2026-11-07/before.json) 与 [after.json](../../artifacts/android-ui-task-offline-v19-2026-11-07/after.json) 记录执行源、viewer、相关上游模块、选择集测试、回放辅助及目录的 SHA-256；[身份核验](../../artifacts/android-ui-task-offline-v19-2026-11-07/identity-audit.json) 使用相同清单逐项比较。依赖使用本机已安装版本，测试通过注入设备/模型及本地 loopback 验证，不启动真实 App 或设备命令。

在 `D:\AI\VCPChat` 中执行以下 PowerShell，可复跑相同选择集；上游需存在于 `D:\AI\VCPToolBox`：

```powershell
$selection = Get-Content -LiteralPath 'artifacts/android-ui-task-offline-v19-2026-11-07/selection.json' -Raw | ConvertFrom-Json
$files = @($selection.files)
node --test --test-concurrency=4 @files
if ($LASTEXITCODE -ne 0) { throw 'VCPChat regression failed' }
Push-Location 'D:\AI\VCPToolBox'
try {
    $upstream = @($selection.upstream)
    node --test --test-concurrency=4 @upstream
    if ($LASTEXITCODE -ne 0) { throw 'VCPToolBox regression failed' }
} finally { Pop-Location }
```

最终主仓 [日志](../../artifacts/android-ui-task-offline-v19-2026-11-07/vcpchat-regression-concurrency4.log) / [退出结果](../../artifacts/android-ui-task-offline-v19-2026-11-07/vcpchat-result-concurrency4.json)，上游 [日志](../../artifacts/android-ui-task-offline-v19-2026-11-07/toolbox-regression.log) / [退出结果](../../artifacts/android-ui-task-offline-v19-2026-11-07/toolbox-result.json) 均保留；汇总及静态检查见 [final-audit.json](../../artifacts/android-ui-task-offline-v19-2026-11-07/final-audit.json)。

初次不限文件并发的[完整回归](../../artifacts/android-ui-task-offline-v19-2026-11-07/vcpchat-regression.log)有一个 3 秒调度保护失败；同源码、同断言在文件并发 4 下通过，被阻塞 A 通道存在时 B 观察在约 897ms 内完成。该初次失败保留，未修改生产时限或测试断言。另保留[旧 viewer 失败](../../artifacts/ui-task-viewer-baseline-20261107.log)和[回放取消适配器失败](../../artifacts/ui-task-replay-final-20261107.log)。后者因外层 Service 提前报告 `STEP_ABORTED`，适配器现等待真实执行器排干后读取其终态，不伪造取消结果。

真机覆盖按用户要求后续再做。跨 App 实际成功率、真实主模型/Handoff、各任务族的独立 J0.2 准入、跨 ROM/多屏/长稳均未由本批离线结果证明。
