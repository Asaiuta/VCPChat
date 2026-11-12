# J0.2 search-v8 准备与首批真实探索

2026-11-07。**协议与探索工具已落地；J0.2 准入未完成，三个任务族均 calibrated:false。** 用户指定的真实任务“搜索魔女之旅，找到作者为白石定规的那本”已执行一次候选探索；一次本地 Jev 调用尝试被执行器截止中止，是否实际发送 HTTP、是否到达网关均无本地证据。未找到并证明目标书，未补跑、未调参。

**网关反馈后的更正。** 用户报告网关未看到 Jev 调用。旧版报告把 `modelCalls=1` 写成真实上游请求1次，证据不足，现撤回该表述。该计数在 `jev.decide()` 前递增，requestedModel 元数据也在底层客户端调用前写入；2秒截止能够在没有HTTP调用时产生相同轨迹。原始 protocol/report/summary/trace 保持原字节，机器可读解释更正见 [request-accounting-correction.json](../../artifacts/android-j02-search-exploration-r1/request-accounting-correction.json)，读取旧机器字段时必须合并此更正。报告中的 `escalation` 事件也只是 hard_stop 诊断包，不能计为请求了主Agent/Handoff升级。

入口：[准备协议](2026-11-07_jev-j02-search-protocol.md)、[探索 schema](j02/report.schema.json)、[驱动](../../scripts/android-j02-search.cjs)、[独立检查器测试](../../tests/android-j02-checker.test.js)。生产控制器、提示、词表和预算实现没有因本次失败而修改。

## 冻结身份

| 对象 | 本批记录 |
| --- | --- |
| 设备 | PJZ110 / Android 17 / display 0；ROM `OnePlus/PJZ110/OP5D0DL1:17/CP2A.260605.016/V.487427a-2227f32-224bc4c:user/release-keys` |
| App | `io.legado.app.release` 3.25 / versionCode 15604；已记录安装 APK 路径与设备侧 SHA-256；书源集合未完整冻结，所以只做探索 |
| 候选 | search-v8 / search-completion-v2 / search-semantics-v1 / search-feedback-v4；0.9 概率、0.2 领先差 |
| 输入与检查器 | 用户真实搜索词；独立 DOM 同行精确书名+作者检查 `legado-title-author-v1`；生产完成谓词只证明含搜索词的 UI 结果，两者分别报告 |
| 模型 | 请求 `typesafe / jev-latest`；实际返回版本未知；不以 alias 代填 |
| 预算 | 120000ms 任务截止、3 动作、96 观察、8 模型调用；最多8轮；单次模型2000ms，maxRetries=0；完成/加载窗口5000ms |
| 样本 | 1个真实任务、1个 cluster；exploration；校准样本0、独立验收样本0 |
| 冻结完整性 | 88个当前文件/采样器身份，运行后重算0差异；设置和设备/App身份复核无变化 |
| 协议摘要 | SHA-256 `c41122b9fdcfdcc774161cbf263388220c18774526466737e5d33879f9131ce4` |

完整记录见 [protocol.json](../../artifacts/android-j02-search-exploration-r1/protocol.json)。这是当前 dirty 工作区的逐文件身份，不以 Git HEAD 代替。

## 结果及各自分母

| 指标 | 结果 | 分母/说明 |
| --- | --- | --- |
| 三臂执行 | 候选1；rules未跑1；原Jev未跑1 | 预列3臂；本批明确仅候选探索，另外两臂不能当作配对失败或成功 |
| 任务终止 | `stopped / TASK_JEV_TIMEOUT` | 当前候选1个真实任务；本地调用流程2018ms后停止，不是服务端推理耗时 |
| 结果分类 | success 0、failed 0、unknown 1、refused 0、escalated终态0、cancelled 0、not_run 2 | 报告的互斥业务结果以独立检查为准；执行器失败码另列，不把“终止失败”和“业务未知”相加 |
| 独立业务成功 | 0/1 | 独立采样未建立结果容器/书名作者，`RESULT_CONTAINER_UNPROVEN`；没有宣称找到目标书 |
| 派发 | actionAttempts=0、actions=0、verifiedActions=0、receipts=[] | 生产控制链记录，独立逐写审计尚未建立，不能据此声称风险已校准为0 |
| 误派发/重复写 | 未评估，准入风险分母0 | 没有已独立审计的派发任务；unassessable=1；不计算置信界 |
| 误报完成 | 不适用，完成声明分母0 | 执行器未报完成；不能写成0/1完成风险 |
| 恢复 | eligible=0，成功0，rate=null | 无符合恢复条件任务，不记100% |
| 升级证据 | hard_stop诊断包1/1；真正升级请求0/1 | trace的disposition=hard_stop、continuation=not_authorized；本任务assistance=none，主Agent回调0、主模型HTTP请求0、Handoff 0 |
| 模型成本 | Jev本地尝试1；实际HTTP发送未知；网关到达未证实；主模型0 | 输入/输出/总tokens和费用全部未知；实际返回版本未知。usage已知记录0/1指本地尝试，不能当作1次服务端调用 |
| task p50/p95 | 5022 / 5022ms | n=1，仅描述该次运行，不作稳定性能结论 |
| reset+initialLoad p50/p95 | 4726 / 4726ms | n=1 |
| 独立采样 p50/p95 | 2555 / 2555ms | n=1 |
| 端到端 p50/p95 | 24133 / 24133ms | n=1，含准备和清理 |
| 路径分桶 | 无恢复/实际升级的本地硬停止1；recovery 0、escalation 0、recovery_and_escalation 0 | 原report把任何escalation事件都算升级，是统计错误；本任务只留下诊断包。未完成正常业务路径，不作正常路径准入结论 |
| 工具退出/清理 | runner exit 1；reader removed=true / processAbsent=true | 运行流程结束不等于任务成功；本轮设备辅助进程/临时JAR清理已证明 |

原始报告：[report.json](../../artifacts/android-j02-search-exploration-r1/report.json)、[完整分母与路径摘要](../../artifacts/android-j02-search-exploration-r1/summary.json)、[轨迹](../../artifacts/android-j02-search-exploration-r1/traces/d4098e87-dabb-4092-9312-446188f7f6a7.jsonl)、[审计](../../artifacts/android-j02-search-exploration-r1/audit.json)。`status:completed` 仅表示探索流程已收口；业务 outcome=unknown、promotion=not_evaluated。

## Evidence → Finding → Path

| Evidence | Finding | Path |
| --- | --- | --- |
| 真实设备轨迹：entry仅1个候选、本地尝试1次、2018ms、TIMEOUT；用户网关未见调用 | 只能确认本地截止，不能确认HTTP发送/网关到达/上游执行；没有中性候选区分度样本 | 后续真实工作负载需记录脱敏传输阶段和HTTP响应/请求关联标识；如改时限，另立代码/协议身份和新批次，保留本次失败 |
| 同一 trace 的 escalation/stopped，assistance=none、disposition=hard_stop | 仅形成终止诊断包，不存在真正升级请求或主Agent/Handoff调用闭环 | 正式路径统计必须看disposition和assistance事件，不能只按事件名分类 |
| 当前策略表与决策器 | 0.2是领先差；不能描述为“低于0.2升级” | 协议冻结 minProbability/minMargin，其他策略变化另起版本 |
| 旧Legado驱动固定 decision=rules，旧13/20报告指向旧验证工具 | 不能把13/20视为search-v5的Jev成绩；旧样本均不进入本批 | 基线明确为原始search-v1完整可运行代码；当前未冻结，not_run |
| 设备已装高德，只有现成离线route/toggle夹具 | “没有真实App”尚不能下定论；“没有已冻结适配任务与检查器”已确认 | route/toggle另指定真实目标、验证可见字段和独立检查器后排期 |

## 验证和剩余准入条件

离线命令：`node --test tests/android-j02-checker.test.js tests/android-independent-snapshot.test.js tests/android-m5-legado-runner.test.js`，17/17通过、0失败/取消/跳过，exit 0。覆盖同行书名作者、跨行混配、模糊书名、旧查询、隐藏/跨包作者、歧义容器、XML不可读和探索schema禁止true。首次本地测试有一项统计算式断言把指数误写为n，已在开跑前修为1/n并通过；未以测试替身调用真实模型。

采样器从当前源码本地重建，exit 0，JAR SHA-256 `7026f75c0aa689b4b2e52dd2175a83ed1edeb96628b7e078469f79224b155433`；这是工具身份可复现，不是旧真机结果复用。探索报告通过JSON Schema校验；88项冻结身份结束后零差异。当前schema特意只接受exploration与calibrated:false；正式准入报告的字段/门槛已在协议规定，完整准入运行器尚未实现。

J0.2准入仍缺：HTTP发送/网关到达的传输证据、当前2秒请求预算下的真实任务可行性、完整App/书源与模型实际版本冻结、三臂公平重置和完整对照、逐写独立审计、事先隔离的校准与独立任务集，以及各声明子范围的足够独立样本。一次本地截止不说明上游处理慢或概率门槛该降低，也不能通过压低拒绝率解决。

网关反馈后新增离线复现：`node --test tests/android-jev-request-accounting.test.js`，1/1通过，exit 0。真实GlobalJevService与执行器、离线阻塞客户端，网络调用0，同样产生modelCalls=1、requestedModel=jev-latest、TASK_JEV_TIMEOUT和hard_stop诊断包。它证明旧字段不足以推出网关到达，不重建或猜测历史网络过程。已核对设置字节仍与冻结摘要一致；设置超时30000ms被执行器2000ms覆盖。未发新上游请求、未变更预算或原冻结代码。

协议说明了单项风险零事件149例与三项同时95%覆盖203例的区别；每项使用自己的有效分母。同一任务重复和三臂配对均不增加独立任务数。当前没有任何范围可标calibrated:true。
