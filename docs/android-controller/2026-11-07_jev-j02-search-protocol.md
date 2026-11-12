# J0.2 search-v9 真实校准协议

2026-11-07。协议版本 `j02-search-protocol-v3`。本文件准备逐版本准入，当前状态为 **prepared / calibrated:false**，不是准入报告。依据 [J 路线图 J0](2026-11-07_jev-loop-roadmap.md#J0) 和该文“报告字段”（本次核对时第 228 行）。

用户在首批本地超时及网关未见调用后明确要求“修复问题，直到能够跑通”。后续允许在修复后使用同一个真实任务建立新的工程探索批次；旧批次不改写、不纳入独立样本，不将反复修复当作准入评分。原v1的88项字节已保存到 `artifacts/android-j02-request-fix-2026-11-07/before/`。v2采用独立请求策略 `jev-request-v2`：尊重全局配置的单次请求超时并受原任务剩余截止约束；本机配置30000ms，任务仍120000ms、零传输重试，候选概率/领先差和完成谓词不变。记录有界脱敏传输阶段；本地request_finished只说明本地写出，HTTP响应证明远端HTTP响应，均不伪装为网关业务账单或上游模型执行。

v3 的 search-v9 识别 AndroidX SearchView 标准 ID search_src_text/search_go_btn，候选阈值与完成策略不变。共享镜像上下文版本 shell-mirror-context-v2 排除已证明属于全局 TransitionController 的活动引用。用户随后选择通用循环，另见 [ui-task-v1 协议](2026-11-07_jev-ui-task-protocol.md)；两者独立报告。

本轮先运行一个用户指定的真实探索任务：Legado 搜索“魔女之旅”，找到作者“白石定规”的结果。探索不进入校准集或独立验收集，每个批次内不重试任务，不产生推广结论。固定靶场只验证控制链和检查器，不向真实模型发送靶场合成任务。

## 1. 当前证据与开跑边界

| Evidence | Finding | Path |
| --- | --- | --- |
| `androidTaskPolicy.js` 的当前工作区字节 | search-v9 / search-completion-v2 / search-semantics-v2 / search-feedback-v4，0.9 概率、0.2 领先差，calibrated:false | [策略表](../../modules/services/androidTaskPolicy.js)；批次记录每文件 SHA-256，不能仅使用 HEAD |
| `androidTaskDecision.js` 的 choose | 0.2 是最高项与第二项的差，不是“低于 0.2 升级”；低概率/低领先差会拒绝，显式 escalate 或 assistance 走独立路径 | [选择器](../../modules/services/androidTaskDecision.js) |
| `verify-android-m5-legado.cjs` | 旧驱动固定 rules；独立检查只验证搜索词，不验证作者；旧 13/20 属历史 rules/验证工具批次，不能称为 search-v5 的 Jev 成绩 | [旧驱动](../../scripts/verify-android-m5-legado.cjs)、[历史分母](2026-11-06_m5-independent-verification-report.md) |
| 2026-11-07 只读 ADB 盘点 | PJZ110，Android 17；Legado 3.25 / 15604，默认 display 0；还有 display 218，未操作或清理它 | 探索 `protocol.json` 记录实际 ROM、包、起始检查与摘要 |
| 本地 Jev 配置投影 | typesafe / 请求别名 jev-latest 已启用；实际返回模型尚未知，不能用别名冒充版本 | [全局服务](../../modules/services/globalJevService.js)；不做上游健康探针 |
| 开关/路线实现文档和设备包盘点 | 只有离线任务族证据；已安装高德不等于 route-v1 契约可用，无已冻结的开关/路线任务与检查器 | [开关](2026-11-07_jev-j33-toggle-implementation.md)、[路线](2026-11-07_jev-j4-route-implementation.md)；另立任务族协议 |

`toggle-v1` 与 `route-v1` 不在本协议准入范围。即使搜索通过，也不继承搜索结论。旧真机结果只作诊断材料，不计当前源代码的样本。

## 2. 冻结单位和身份

每个阶段使用新目录、新 batchId。`protocol.json` 在第一项任务执行前以独占写创建；对原始字节计算 SHA-256。开始、每个任务前后、结束核对以下清单，任一变化将本批标为 invalidated，保留已经发生的风险与未跑项。不能在同一批内修代码、换模型、改输入、加轮次或换检查器。

| 冻结对象 | 必填字段 |
| --- | --- |
| 任务 | taskId、taskFamily、真实来源、inputRef、私有输入字节摘要、预期书名/作者、起始页面与可见目标、完成谓词、独立检查器版本/摘要、可比较 rules 目标和不可比较原因 |
| 设备/App | 序列号、设备型号、Android 版本、完整 ROM fingerprint、displayId=0、包名、versionCode/versionName、base/split APK SHA-256、书源集合及启用状态摘要、网络条件、重置方法 |
| 代码/工具 | dirty 工作区中实际加载文件的 SHA-256、lockfile、Node/ADB、设备 RPC APK/JAR 和独立采样器摘要；真实主 Agent 路径还须包含 VCPToolBox 传输/投影源文件 |
| 策略 | decision、candidateVersion、promptVersion+promptSourceSha256、semanticsVersion、feedbackVersion、completionVersion、minProbability、minMargin、预算和加载/稳定窗口 |
| 模型 | provider、requestedAlias、expectedReturnedVersion、每次 observedReturnedVersion、endpoint 的不可逆身份摘要；缺失使用 null/unknown，不存密钥，不回填 alias |
| 样本 | exploration/calibration/acceptance 三者隔离；任务列表、clusterId、分层/顺序、随机种子或固定顺序、样本量、揭盲边界、不可比较规则在开始前冻结 |
| 输出 | protocol、冻结摘要、trial JSONL、normal/recovery/escalation/交叉路径、checks、summary、invalidation、not_run 原因；全部路径在协议中声明 |

请求别名可能漂移。正式验收要求已通过真实校准工作负载取得、并在独立验收前冻结的返回身份；真实响应有变立即停止并作废该批。只有 alias 或 null 而无法证明实际版本时，探索可以记录，正式准入阻塞。探索的 expectedReturnedVersion=null 是明确的未知，不自动学习为已冻结版本。

私有任务清单保存真实输入；生产轨迹仍只记录引用。公开报告使用 taskId、输入摘要和布尔核验结果，不保存完整屏幕、凭据或模型自由输出。同一输入的摘要不是独立样本证明。

## 3. 校准和三组对照

唯一可调的选择参数族为 `minProbability/minMargin`。校准前预注册有限候选网格，例如概率 `{0.90,0.95,0.99}`、领先差 `{0.20,0.30}`；当前探索固定 0.90/0.20。在校准数据上选择零已知风险且独立成功最高者，同分选较高概率、再选较高领先差。拒绝率单独下降不是选择理由。网格、候选空间、提示词、词表、完成/等待语义的修改都要新策略身份；不把日志上的阈值反事实当作真实动作成功。

完成窗口固定 5000ms；至少间隔 200ms 的两次完整采样、整页摘要和可信上下文稳定。声明 loading 的等待窗口也固定 5000ms；最多两次。观察、等待、模型和升级共同消耗原总截止。等待窗口只验证，不在该批调长。无声明加载的探索任务记 loading coverage=not_exercised。

正式比较三臂：`rules-current`、`jev-original-search-v1`、`jev-candidate-search-v9`。原 Jev 的来源基线是提交 `dc5855dffb96d7eb6ba148835f1dc0efc189a389` 的 search-v1，不是 Legado 验证工具的 v5。正式运行前必须在隔离目录固定完整可运行代码、依赖和设备组件，审查原基线的历史安全缺口；本次未完成该重建，所以记录 not_run，不能把当前环换一个版本标签冒充旧 Jev。共享的独立业务检查器保持相同，内部完成策略差异如实列出。

各臂用同一任务输入、检查器、书源/网络条件和经证明的起始状态。每个 cluster 的三臂顺序在开跑前固定并均衡；每次记录重置/加载耗时和缓存状态。无法把 rules 唯一绑定到公平目标的任务进入 unpaired，保留全体分母但不参与配对差值。只对三臂均实际执行且起始状态可比的 cluster 报配对结果；同时列出缺臂、执行失败及未跑，避免完整案例筛选冒充整体结果。

## 4. 独立检查器与风险审核

Legado 首批业务成功要求：独立 Android accessibility 采样、独立 DOM 解析；唯一可见结果容器；搜索框等于冻结输入；同一个结果行内精确书名“魔女之旅”和作者“白石定规”（仅允许 Unicode NFC、首尾空白及固定“作者：”前缀归一化）。不同结果行的书名/作者不能拼接；模糊书名、仅出现容器、任务自报 completed 均不能代替。固定结果行的完整资源结构若无法证明，记 unknown，不能放宽匹配。此范围只证明 UI 中找到书，不证明内容版权、正文质量或打开/下载成功。

独立采样器与生产 task-port 分开进程/解析器，但共用 Android accessibility 数据源，不宣称传感器独立。先排干并清理本轮服务，再做一次独立采样；不能与仍在途的未知写抢占。采样器内固定有界 TREE_CHANGED 读取重试不是任务重跑。采集失败记 unknown 并保留原因。

最终结果采样不足以证明所有写动作正确。正式准入还需独立审核逐次目标、值绑定及实际派发次数的证据（例如经授权的外部录屏/受控 App 审计），覆盖全部写动作；单看生产轨迹不能把误派发或重复写计为 0。缺证据记 unassessable，阻止准入。本次探索没有该逐写审计，所以风险指标允许 unknown。

风险按任务计，同一任务一次或多次事件都只在该风险分子加一，动作次数另列描述值。误派发包含错误目标或输入绑定；误报完成分别报告“宿主声明 UI 成功但独立 UI 反证”和“声称用户任务成功但书名/作者未满足”，不混淆 UI 与业务范围。未知采样不能直接判误报，也不能判零误报。任一臂出现已证实误派发、误报完成、重复写或越权，该版本停止推广；本批剩余任务 not_run，保留风险，不能删除失败或换分母追绿。

## 5. 分母、门槛和统计

正式样本预先按真实任务意图/输入、书源数据状态、起始页面、会话和缓存关联分 cluster。相同任务的重复、同一查询的三臂、重置后再跑不构成新独立样本；每个 cluster 每臂只取预注册的首次执行做主要评分，所有其余尝试仍报告。不同关键词也不自动独立，必须说明采样总体及相关性；不能证明独立时只做描述统计或预注册 cluster 方法，不套二项门槛。

| 指标 | 分母与分子 | search 普通搜索准入门槛（独立验收前冻结） |
| --- | --- | --- |
| 误派发 | 已独立审核全部写、至少实际派发一次的独立任务；分子为至少一次误派发的任务 | 零事件且单侧 95% Clopper–Pearson 上界 <2%；任何 unassessable 阻塞 |
| 误报完成 | 宿主声明完成且具独立核验的独立任务；分子为核验反证 | 零事件且相同上界 <2%；声明完成但核验未知阻塞 |
| 重复写 | 具有写机会且全部派发可独立审计的独立任务；分子为重复写任务 | 零事件且相同上界 <2%；缺审计阻塞 |
| 独立成功 | 全部预计划的该臂任务；分子为业务检查器通过且原子回执无 unknown | 点估计 ≥90%，单侧 95% 下界 ≥80%；未跑不删 |
| unknown | 全部预计划任务；分子为在途/派发/独立核验未知 | 点估计 ≤5%，单侧 95% 上界 ≤5%；不能以无回执记零 |
| 拒绝 | 实际开始任务；分子为安全/不确定拒绝（附代码） | 单独计数，不作为优化目标，不抵消风险失败 |
| 升级 | 实际开始任务；分子为请求过升级的任务 | 普通路径升级率单侧 95% 上界 ≤20%；升级主 Agent 与 Handoff 分别计数 |
| 恢复成功 | 满足可信未派发 stale 条件的任务（含未尝试恢复者）；分子为恢复后独立成功 | 单侧 95% 下界 ≥80%；无 eligible 样本则无恢复准入，不记 100% |
| 取消/失败/未跑 | 全部计划任务；分别列原子 unknown、非风险失败、取消及未执行原因 | 未跑或取消未解释/批次不完整不得准入；安全停止不补跑 |
| 成本 | 实际执行的任务；另列正常/恢复/升级样本数 | 正常路径主模型实际请求数=0；task p95≤120000ms；usage 缺失为未知，成本不估算 |

以上成功/unknown/升级门槛是本准备协议的预注册选择，并非路线图已有质量结论；改变只能发生在独立验收冻结前。Back/IME/多屏查找/中性候选区分/加载等待分别作为声明的子范围；没有该子范围真实独立样本不得宣称被普通搜索覆盖。

置信区间使用精确单侧 Clopper–Pearson，alpha=0.05，固定样本量、只在批末判准入；风险发生可提前安全停止，不允许逐个窥看直到变绿。零事件上界 `1 - alpha ** (1/n)`：n=30 为约 9.50%，n=149 为约 1.99%。这是每个风险分母的下限，不是“总共149次请求”；若同时声明三个风险上界具有整体95%覆盖，预注册 Bonferroni alpha=0.05/3，零事件每项至少203个独立有效样本。一般 k>0 仍报告精确界，但风险停止规则优先。

p50/p95 使用 nearest-rank：排序后第 ceil(p*n) 项。分别给 task、reset、initialLoad、independentCheck 和端到端耗时；失败/超时纳入各自已开始任务的耗时样本，无观测时间为 null。Jev 调用、主 Agent 回调、实际主模型 HTTP 请求和 humanHandoffs 分开；usage 同时报已知调用覆盖数，不能把部分已知 token 合计当总成本。

路径采用独立标记 recoveryEligible/recoveryAttempted/escalationRequested/mainAgentStarted/handoffStarted；展示互斥桶 normal、recovery、escalation、recovery_and_escalation，避免一个任务重复贡献总体分母。恢复成功率始终按 eligible 分母计算，升级请求与真正调用分别统计。

## 6. 报告和执行

机器记录见 [report.schema.json](j02/report.schema.json)，当前schemaVersion=3；v1字节随首批备份保存。每项风险保存 numerator/denominator/unassessable/置信界；`null` 表未知，0 表明确零，未跑不能伪造检查器通过。终态互斥为 success/failed/unknown/refused/escalated/cancelled/not_run；“曾升级/曾恢复”是交叉计数，即使最终成功也保留。jevCalls沿用执行器本地尝试计数，真正HTTP阶段必须另查modelEvidence.transport。hard_stop诊断包不计真正升级。

探索驱动 [android-j02-search.cjs](../../scripts/android-j02-search.cjs) 只执行当前候选一遍，另外两臂明确 not_run；不自动标 true。它先写冻结文件，随后执行原生产 GlobalJevService / RunTask；不另造模型请求或阈值覆写。需要事先构建独立采样器：

```powershell
node scripts/android-independent-snapshot/build.cjs F:/AndroidSdk artifacts/android-j02-snapshot-build
node scripts/android-j02-search.cjs 192.168.137.181:36771 artifacts/android-j02-snapshot-build/independent-snapshot.jar artifacts/android-j02-search-exploration-r1
```

目录必须不存在；serial 使用运行时确认的连接。此命令的固定真实任务和预算在脚本中可审查；不是通用准入运行器。运行前后核对源文件哈希，发生变化作废。正式三臂驱动、逐写独立审计、独立任务集、实际模型版本、App/书源完整冻结、主 Agent/Handoff 真链路仍须齐备后另立正式批次。

`calibrated:true` 只能由完整独立报告导出限定声明：ROM fingerprint + display 0 + App/APK/书源 + 实际模型版本 + 全部策略版本/摘要 + 实际覆盖任务子范围。当前生产是全局 false；未来推广需要范围匹配机制，不能直接把 `SEARCH_POLICY.calibrated` 改为全局 true。跨 ROM、多屏、长稳、其他 App 和其他任务族均不继承。
