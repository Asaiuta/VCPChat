# Jev 驱动的受限连续搜索

日期：2026-11-06。新增 `RunTask decision=jev`：宿主观察当前页面、生成搜索候选、调用全局 Jev、执行所选目标并独立验证，连续推进到完成或停止。当前是**已集成并离线验证的实验模式**，不代表真实 Jev 决策质量或真实 App 联合验收。阶段与测试分母见[状态表](README.md)。

本轮与真实 App 测试并行，未发 ADB 命令、未调用上游模型，也未变更全局 Jev 设置。既有规则/影子模式保留；真实 App 测试原有记录独立维护。

## 使用方式

入口仍是 `RunTask`。与 `rules/shadow` 的区别是 `decision=jev` **不传 targets**，由当前控件树生成目标；调用方仍需提供明确包、设备、查询参数和独立完成标记。

```json
{
  "command": "RunTask",
  "task": {
    "serial": "YOUR_DEVICE_SERIAL",
    "package": "com.demo",
    "intent": "search",
    "decision": "jev",
    "inputs": { "query": "本次关键词" },
    "completion": { "type": "visible", "id": "com.demo:id/results" },
    "budget": { "timeoutMs": 60000, "maxActions": 6, "maxObservations": 96, "maxModelCalls": 8 }
  }
}
```

示例中的设备/包/结果ID需按实际任务填写。设备需在目标 App 前台且当前上下文完整可信；宿主需已启用并配置全局 Jev。没有新增插件侧模型客户端。现有链路为 `GlobalJevService → VCPDistributedServer services → androidTaskExecutor → task-port → ExecuteStep`。

## 行为边界

宿主确定 entry/fill/submit 阶段、允许动作与后置条件。候选必须具有搜索相关资源ID或固定词表中的原始 text/desc，具有唯一完整同包资源ID，且当前可见、启用、非密码；文字字段的值不能用于推断搜索意图。无可定位搜索字段的表单不降格为入口页。词表在 `androidSearchLoop.js` 中明确列出，不做模糊匹配，也不使用坐标或过期 index。

Jev 每轮只选择最多8个当前候选之一、`wait` 或 `escalate`。实际输入来自任务参数；模型的自由文本、动作数组和成功声明不参与执行。传给模型的是候选ID、资源ID、动作类型、搜索证据来源与后置条件类别，不包含查询值或原始页面文本。

多级入口每一步必须独立观察到新的搜索字段或尚未使用的搜索入口；同一入口目标不会重放。Fill 沿原动作链精确读回，提交前还要求被填字段仍唯一且值与本次参数一致。提交以独立可见完成标记验证；起始或提交前已有该标记时停止。完成只表示声明的 UI 条件成立，不证明结果内容、业务正确性或结果采集已经完成。

每轮模型返回后重新采样，观察摘要/上下文不一致时不派发。最终动作还经过 task-port 的整树摘要、epoch、TTL 与现有策略检查。所有观察（包括验证轮询）均消耗同一任务预算。任务最多8轮、2次等待，默认6动作/96采样/8模型调用；每个模型请求最多2秒且零重试。取消、总截止、在途依赖排干和未知 RPC 隔离沿用现有运行时。

`search-v1` 使用完整概率映射、概率和校验、最高项≥0.9、领先差≥0.2。**这是冻结的暂定策略，不是经任务数据校准的可靠性阈值**；回执包含 `experimental:true` 和 `decisionPolicy.calibrated:false`。本次没有把原 `Observe mode=arbitrate` 的 advisory 结果直接变成执行许可。

## 实现与验证证据

| Evidence | Finding | Path |
| --- | --- | --- |
| [预先固定协议](../../artifacts/android-jev-loop-2026-11-06/protocol.md) | 限定搜索意图、候选上限、模型输出、停止规则与验收集合 | [候选及循环](../../modules/services/androidSearchLoop.js) |
| [专项日志](../../artifacts/android-jev-loop-2026-11-06/focused.log)：多入口、多字段，选择 c1 实际操作第二目标 | 连续执行由模型选择驱动，未退化成仅记 shadow；独立模拟 App 状态证明真实 Service 原子动作落到所选目标，主模型调用为零 | [Service集成测试](../../tests/android-search-loop.test.js)、[模拟 App](../../tests/helpers/android-search-world.cjs) |
| 同上：错误概率/跨候选/不确定/升级/等待、页面变化、最后派发复采、密码/无地址字段/歧义/候选过多 | 模型响应受有限契约约束，观察与候选不会跨页沿用 | [执行器](../../modules/services/androidTaskExecutor.js)、[设备端口](../../VCPDistributedServer/Plugin/AndroidController/lib/task-port.js) |
| 同上：重复页面、无进度点击、缺完成、预算/取消/未知RPC | 点击成功不等于步骤成功；不会因模型自报或后续正常页面而重放未知写 | 同一 task-port/step-runtime 与现有 owner 隔离路径 |
| 同上：生产 GlobalJevService + 离线 client；共享租约持续到模型依赖 settle | 全局设置适配与调用契约已连接；没有真实上游服务准入证据 | [GlobalJevService](../../modules/services/globalJevService.js) |
| 同上：真实 JSONL 文件、候选白名单/访问器/跨包拒绝 | 轨迹新增候选、源字段类别、选择、策略版本；不存输入、屏幕原文或模型自由输出 | [轨迹模块](../../modules/services/androidTaskTrace.js)、[轨迹测试](../../tests/android-task-trace.test.js) |
| [限定回归](../../artifacts/android-jev-loop-2026-11-06/regression.log) | 既有 Android 规则/影子、原子动作、隔离、显示等与 Jev/分布式取消测试通过；范围不是全仓 | 选集与文件哈希见[清单](../../artifacts/android-jev-loop-2026-11-06/evidence.json) |

结构调整仅提取共用模型预算/取消调用和原固定搜索流程；新候选/循环独立成模块，共用执行、验证、轨迹与设备租约，没有另造设备仲裁器。设备端口仅新增内部可信后置条件回调，不接受用户代码。原规则/影子请求形状和默认行为保留。

开发首跑候选溢出测试把第九个按钮放到了测试屏幕外，实际候选未溢出，正确返回升级；已修正离线布局再验，未修改生产候选阈值。原始失败日志保留在 `search-loop.log`。

## 复跑

项目根目录执行以下离线命令，不访问设备或上游模型：

```powershell
node --test tests/android-search-loop.test.js tests/android-task-executor.test.js tests/android-task-trace.test.js tests/android-step-runtime.test.js tests/android-sequence-contract.test.js tests/global-jev-service.test.js
$testFiles = @(rg --files tests -g 'android-*.test.js' -g 'android-*.test.mjs' -g 'global-jev-service.test.js' -g 'jev-client.test.js' -g 'distributed-cancellation.test.js')
node --test --test-concurrency=4 @testFiles
```

本轮变更前文件与文档快照在 `artifacts/android-jev-loop-2026-11-06/before/`；更新共享文档前另存 `before-doc-merge/`，保留并行真实 App 工作写入的状态。

## 尚未交付

- 真实 Jev + 真实 App 的联合任务集、概率门槛校准和长稳验收；固定注入回答验证的是控制逻辑，不能外推模型成功率。
- 当前语义词表以中英文搜索为主；无唯一资源ID、词表外入口、多窗口/跨包、IME-only 提交、任意导航/表单流程会停止或升级。`escalate` 返回任务停止原因，不会偷偷发起主模型请求。
- Skill 学习、草稿编译、持久恢复和页面变化修复。本轮候选轨迹仍是受控摘要，不能冒充完整教学轨迹。

下一步可在正在进行的真实 App 工作选出稳定搜索任务后，用其真实工作负载分别对照 `rules` 和 `jev`，保留完整分母、误操作、unknown、升级与调用成本；该验收不由本轮离线通过代替。
