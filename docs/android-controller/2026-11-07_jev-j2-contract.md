# J2 最小语义、近期反馈与观察绑定契约

实现前冻结，2026-11-07。基线为上批实际工作区 search-v4；本批候选 search-v5，完成策略 search-completion-v2，calibrated:false。不改变词表准入集合、阈值、动作种类、预算、完成谓词或隔离/升级规则。不向真实模型发送合成测试流量。

## 最小改动与所有权

把现有精确词表及封闭语义投影集中到 `androidSearchEvidence.js`，避免循环、轨迹和请求各自推断语义。不建立通用配置框架。保留单问联合候选，模型不能拼接动作/目标/输入引用。

- 词表与语义规则版本 `search-semantics-v1`，沿用原完整匹配。候选仅增加 `inputRef`（Fill=query，Tap=null）及 `semantics`：固定 role、最多4个 hints（search/query_field/search_entry/search_submit）、fieldRelation（none/same_parent/other_parent/unproven/ambiguous）。entry/submit 标签只来自明确的既有资源 ID 子集；通用 Search 文本不能推断业务效果。
- 结构关系只依据完整树中已准入查询框与候选的直接原始父节点。task-port 发出仅内部使用的临时 parentGroup；hierarchy 根、无父节点、多查询框均不得伪装为唯一相关表单。它不外发类名、结构路径、父 ID、原始标签或查询值，也不增加动作授权。
- `search-feedback-v1` 的 decisionContext 绑定本次 observationId，包含 round、queryVerified、screenChanged（首次为null）、stale/wait计数、最多3条已验证动作（step/command/targetId/postcondition）、lastEvent（初始/已验证入口或输入/两种未派发stale/加载结束/两种升级交还）及原6类剩余预算。剩余预算采集于本次 Jev 调用前，包含尚待消耗的本次调用；screenChanged 只表示摘要变化。
- 历史只记独立验证成功的动作，未知写或硬失败不会变成可继续反馈；wait、stale和交还均不清空历史。候选和 decisionContext 同时进入普通 candidates 事件及升级历史包，上游主 Agent 也只接收同一白名单投影。

## 决策绑定

利用现有 Jev 自定义问题 key，唯一问题命名为 `next_<当前观察UUID去横线>`；候选 ID 仍为 c0…c7，回答只准包含这个问题的 answer。上一观察的回答或额外 operation/target 头拒绝。

单个 answer 仅接受 probabilities 与供应商已文档化的 type/choice/confidence。type若有必须choice，choice若有须与最高概率项一致，confidence若有须为有限0…1但不参与授权。分布仍严格覆盖当前候选/wait/escalate且归一；不接受模型提供输入引用、动作、目标或完成声明。响应顶层仅保留常规返回元信息的兼容，所有执行相关额外字段拒绝。所有选择仍经过新观察、写前 fence、策略与后置条件。

## 验证与停止规则

离线用实际 Service/XML/请求体替身测试精确词表等价、中性 ID 有/无语义、结构父关系、敏感 label、指令注入、历史/预算连续、已填值丢失、旧回答/额外头/输入越界、非法分布、升级、取消与容量。真实 JevClient 的两供应商请求体必须只包含声明的最小字段，原始标签和参数值不得出现。

固定对照场景：普通成功、中性ID有搜索标签、中性ID无语义、敏感文本但明确ID、注入文本无语义、错误高置信选择、一次观察stale、三次连续stale、已填后stale、声明加载、主Agent升级、人工交还。对 search-v4 与 v5 使用相同设备转移和固定回答规则；逐项比较独立成功、错误派发、停止/升级、实际动作、模型次数与请求字节数。对照证明控制行为及成本变化，不能证明真实模型质量提升。结构信息可辨性的专项用例单独报告，不混入模型质量分母。

总轨迹仍为512 KiB、4096字节终止预留；普通事件上限不增加，只扩展现有 candidates 事件的白名单。隐私泄漏、跨观察答复授权、额外写、预算重置或误报完成任一发生即修复并保留失败证据；不能放宽谓词、增加预算或删反例追绿。真实模型质量比较和 J0.2 校准/独立验收仍需独立真实任务批次。
