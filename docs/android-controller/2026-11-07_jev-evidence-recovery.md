# J0.1 最小证据、J5.3 夹具与 J1.2 观察恢复

2026-11-07。基线提交 `dc5855dffb96d7eb6ba148835f1dc0efc189a389` 包含当前 Android 搜索环及 J1.1 完成修复，已纳入 `docs/android-controller/`；不含 `.env` / `config.env.example`，未推送。本批在该基线上继续实现，阶段状态及测试数字见 [README](README.md)。

## 模型与决策证据

每次模型调用新增一条 `model` 事件，以 `modelCalls` 和观察 ID 关联候选与决策。`GlobalJevService` 在解析本次实际配置后，通过宿主内部回调提供 provider/requestedModel；回调不传给 HTTP 客户端。returnedModel 只取实际响应 `model`，不以请求别名代替解析版本。

白名单字段为 provider、requestedModel、returnedModel、elapsedMs，以及 usage.inputTokens/outputTokens/totalTokens。usage 只接受整数计数，兼容 input_tokens/output_tokens 与 prompt_tokens/completion_tokens 两组字段名，不推算缺失 total 或费用；缺失/不合法值均为 null。模型标识最长 128 字符，仅接受限定字符，未知字段、getter、原始响应、异常正文、URL、Key、屏幕原文与输入值不落轨迹。

决策事件保存合法分布的最高概率与 margin。拒绝原因封闭为 invalid_distribution、low_probability、low_margin、escalate、model_timeout、model_unavailable、cancelled、deadline。模型超时及服务错误只记录并停止，不归入 stale。模型调用仍为零传输重试；固定替身回答验证协议，不证明真实模型可靠性。

`traceEventLimit` 调整为 `maxObservations + 3 * MAX_ACTION_ATTEMPTS * maxActions + 4 * maxModelCalls + 2`。每次模型额度覆盖候选、模型证据、决策与至多一条 recovery；最终验证和终止仍有独立槽位。字节上限保持 512 KiB，终止预留 4096 字节；最大合法预算夹具实际检查容量与最终停止可写，不通过增大上限掩盖溢出。源字段或事件再扩展时须重验该边界。

## J1.2 恢复规则

策略版本为 `search-v2`，完成策略仍为 `search-completion-v2`，calibrated=false。

1. 模型返回后的复采只有整页内容变化、可信上下文一致时可恢复。旧回答作废，下一轮重新观察、生成候选并调用模型。
2. 最后派发检查由 task-port 标记自己产生的 stale，通过 owned 子回执确认 failed / 未派发后，才登记在内部 WeakSet。宿主只认此证明，不能仅凭错误码、伪造 failed 回执或后来的正常页面放行。
3. 包、设备、完整性、窗口/组件、epoch 或上下文变化硬停止。恢复后的首个新观察也须与恢复前上下文一致；不得重新建立上下文基线来消除错误。
4. 连续第三次 stale 返回 TASK_STALE_LIMIT，最多两次额外决策。仅独立验证的动作进展清零连续计数，wait 不清零；已执行目标与循环历史不清空。
5. 每次恢复消耗原模型、观察、轮数和总时间额度；原 8 轮、2 次 wait 与总预算不提高。同租约持有至依赖排干；取消/截止后晚返回的模型结果不能继续写。
6. 已派发或 unknown 的动作、验证失败与模型错误不恢复；不重填、不重交，不用 Back 作为默认补偿。J5 实际 Agent/Handoff 升级仍未接入。

计数口径：`actions` 是已占用动作额度，可信未派发 stale 归还该额度，其余失败保守保留；它不是所有情况的实际派发次数。`actionAttempts` 记录进入 act 的次数，`verifiedActions` 记录有独立验证的进展，`staleEvents` 记录所有恢复资格事件（含触发终止的第三次）。逐次回执仍保存 requestId/outcome，prepared 事件关联模型调用及 attempt；未派发尝试不提前加入已执行目标集合。

## 可复现夹具和验收范围

[夹具清单](../../tests/fixtures/android-jev/cases.json) 先收空结果容器、延迟条目两个已知问题，再加入模型期间与最后派发检查的一/二/三次 stale。共用 [完成世界](../../tests/helpers/android-completion-world.cjs) 与 [搜索世界](../../tests/helpers/android-search-world.cjs)，从真实 Service、原始 XML 证据、策略门一直执行到原子回执；仅设备和模型回答注入。

[恢复测试](../../tests/android-jev-recovery.test.js) 另验证进展清零、wait 不清零、模型/动作/轮数/截止预算、取消、上下文变化、unknown、轨迹失败与真实 JSONL 因果记录。[证据测试](../../tests/android-jev-evidence.test.js) 验证实际请求配置身份、usage/拒绝字段白名单、缺失值、隐私和容量上界。每个场景断言具体写目标、次数和终止码，不只比较两次运行输出相同。

夹具为人工构造的离线环境，不是生产脱敏轨迹的反向重建，也不代表未观察分支或真实模型质量。本轮无上游请求、无真机动作。真实任务集、模型返回契约的真实覆盖、J0.2 校准和独立准入仍待完成。

本批 [测试选择和代码身份](../../artifacts/android-jev-j12-2026-11-07/final-selection.json)、[最终日志](../../artifacts/android-jev-j12-2026-11-07/final-tests.log)、[退出码](../../artifacts/android-jev-j12-2026-11-07/final-result.json) 与 [基线文件清单](../../artifacts/android-jev-j12-2026-11-07/baseline-files.json) 保留在本机证据目录。

首次限定回归保留在 `r1-final-tests.log`：旧测试仅按 source=shadow 统计决策，新增 model 事件后计数失配；修正为同时限定 type=decision，写入次数、权限及所有权断言不放宽。最终通过后只将抽取过夹具的测试文件恢复为基线 LF 行尾，规范化文本一致且语法检查通过；原测试摘要与最终字节差异见 `format-only-change.json`。本批源码与文档摘要、差异和检查汇总见 [证据清单](../../artifacts/android-jev-j12-2026-11-07/evidence.json)。
