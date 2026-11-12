# 通用任务 v20：原始树目标与长流程离线验证

本批完成 `ui-task-v20 / ui-elements-v11 / ui-predicates-v2`：完成目标、加载标记和输入绑定支持精确文字、描述、角色、类及结构关系，并修复返回页面后输入丢失导致自动重填的问题。复用已有 selector 引擎，通过完整原始树取证，避免另建匹配系统。仅离线执行，真实设备和模型请求为零，`calibrated:false`，acceptanceSamples=0。

当前契约见 [v20 协议](2026-11-08_jev-ui-task-protocol-v20.md)。v19 与 v18/r21 的报告保留，真机结果不继承到本版；J0.2 多任务批次工具泛化留待后续，不在本批实现范围。原概率门槛、加载与完成窗口、任务预算上限均未放宽。

## 证据、结论与代码路径

| Evidence：离线证据 | Finding：验证的行为 | Path：实现 |
| --- | --- | --- |
| [目标专项](../../tests/android-ui-task-target.test.js) | 无 ID 目标可匹配原始 text/desc/class/role 与四种单层关系；隐藏重复仍算歧义，缺失锚点不能证明 absent，另一 App 不能证明原 App 目标不存在；同一行字段必须对应不同节点 | [目标匹配器](../../VCPDistributedServer/Plugin/AndroidController/lib/task-ui-target.js)、[原始树证据](../../VCPDistributedServer/Plugin/AndroidController/lib/task-ui-evidence.js)、[任务契约](../../modules/services/androidUiTaskContract.js) |
| [长流程专项](../../tests/android-ui-task-journeys.test.js) | 跨页双字段填写、Back 后继续、允许包之间 LaunchApp、人工接管复核；已验证声明字段丢失即停，不自动重填；12步流程遵守动作/模型/观察预算，后段 stale/未知写/取消保持已执行前缀 | [通用循环](../../modules/services/androidUiTaskLoop.js)、[Service 设备替身](../../tests/helpers/android-ui-task-world.cjs) |
| [容量专项](../../tests/android-ui-task-capacity.test.js) | 96元素/128候选边界可进入决策，超限在模型前停止；32步操作完成，独立核对实际写入及终态；真实 JSONL 文件在事件数或字节耗尽时均保留停止记录 | 通用循环 → [轨迹存储](../../modules/services/androidTaskTrace.js)，512KiB及终止预留不变 |
| [统一回放](../../tests/fixtures/android-jev/replay.json)、[断言入口](../../tests/android-jev-replay.test.js) | 增加无 ID 语义目标的正常/stale/unknown 三例，逐条核对实际设备写与独立世界终态；成功写入案例另有全拒绝反事实 | [通用适配器](../../tests/helpers/android-ui-task-replay.cjs) → 生产 Service/执行器 → 注入设备与模型 |
| [上游日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/toolbox-final-regression.log) | 主 Agent 证据投影接受 v20/v2，拒绝旧身份；仍沿用发起请求模型、候选与预算约束 | sibling VCPToolBox `androidUiTaskReplanEvidence.js`，由原分布式请求链调用 |

输入进度只针对顶层 text/inputRef 声明。唯一可编辑目标已精确匹配后，宿主记录有界引用/布尔状态；该目标再次可见却失值或歧义时停止。导航期间字段缺席不证明丢失，也不证明隐藏状态仍保存。无 ID 声明字段的协助复核使用相同目标证据；未声明字段仍用保守身份规则。该改动不绕过底层 Fill 的唯一性和精确读回要求。

模型仍可能接收目标、输入及有界非密码界面文字；完成检查使用完整原文，持久轨迹与结果不保存文字。新内部进度账本不进入模型载荷。无检查器不能报告 verified；结果标记本身只证明声明 UI 状态，业务成功仍需独立检查器。

## 失败证据与修复

[首次长流程日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/journeys-initial.log) 为7/8，复现了真实循环缺陷：Fill第一字段 → 下一页 → Fill第二字段 → Back；App 在返回时改掉第一字段，循环随后再次 Fill 并完成。修复后同一反例在 Back 后停止为 TASK_PROGRESS_LOST，之前两次填写均不重放。保留原失败，不删样本或增加预算。

[首次容量日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/capacity-initial.log) 为4/7，三项为新增测试夹具错误：一项把循环观察事件数误当作包括原子动作内部读取的总观察预算；两项给轨迹传入了上游原始 usage 键，而轨迹要求 inputTokens/outputTokens/totalTokens。测试已改为独立计数全部采样、使用生产规范化 usage；没有修改生产容量、超时或轨迹 schema 来迁就测试。

修复后的 [目标/长流程/协助日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/targets-journeys-fixed.log)、[容量/回放日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/capacity-replay-fixed.log)、[最终长流程日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/journeys-final.log) 均保留。各次专项有重叠，不相加充作最终回归分母。

源码复核另发现资源 ID 简写及 selector.id 会误接受第二段 `:id/` 后缀；[反例日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/malformed-id-before.log) 证实未按 TASK_INVALID 拒绝。现在对完整资源名称校验，两个入口均有反例，见 [最终目标专项](../../artifacts/android-ui-task-offline-v20-2026-11-08/targets-final.log)。首轮完整回归通过后仍重新冻结修复后的字节执行最终回归；[首轮日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/vcpchat-regression.log) 与 [首轮身份核验](../../artifacts/android-ui-task-offline-v20-2026-11-08/identity-initial-regression.json) 保留。

## 冻结、复现与限制

[最终汇总](../../artifacts/android-ui-task-offline-v20-2026-11-08/final-audit.json) 给出两个仓库各自分母、退出码、失败日志与身份核验；关键总数统一维护在 [状态索引](README.md)。[selection.json](../../artifacts/android-ui-task-offline-v20-2026-11-08/selection.json) 是实际选择集，文件并发固定4。[before.json](../../artifacts/android-ui-task-offline-v20-2026-11-08/before.json) / [after.json](../../artifacts/android-ui-task-offline-v20-2026-11-08/after.json) 逐项记录同一执行源与测试清单的 SHA-256，见 [身份核验](../../artifacts/android-ui-task-offline-v20-2026-11-08/identity-audit.json)。这些是离线回归冻结项，不是正式 J0.2 准入冻结。

在 `D:\AI\VCPChat` 可复跑选择集；上游须位于 `D:\AI\VCPToolBox`：

```powershell
$selection = Get-Content -LiteralPath 'artifacts/android-ui-task-offline-v20-2026-11-08/selection.json' -Raw | ConvertFrom-Json
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

测试只用手写离线世界、注入的模型回答/传输和本地 loopback。容量上限不代表所有极端组合都可跑满：候选很多时可能先到512KiB轨迹上限，此时应停止并保留终态。

真实多 App 成功率、真实模型候选区分度、各任务族校准、跨 ROM/多屏与长时间稳定性仍未验证。下一步真机覆盖按用户安排，需另建冻结批次和真实任务；本批不为取得 calibrated:true 调整拒绝率或风险门槛。
