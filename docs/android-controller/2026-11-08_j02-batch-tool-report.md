# J0.2 正式批次工具

`scripts/android-j02-batch.cjs` 将单任务探索扩展为版本化批次：冻结真实任务、两阶段样本划分、三个对照臂及完整预算；逐项执行、独立审计、计算精确置信界，并输出限定范围的准入结论。旧探索脚本及历史报告保留。本次仅离线实现和验证，没有 ADB、真实设备或模型请求，生产策略仍为 `calibrated:false`。

## 准备清单与运行

入口为 [android-j02-batch.cjs](../../scripts/android-j02-batch.cjs)。无参数或 `help` 只显示用法。`freeze`、`audit`、`report` 和 `init-legado` 不访问设备或模型；`inspect` 是设备只读操作；只有 `run <批次目录> --real` 执行冻结的真实任务。每次 run 最多执行一个计划项，随后等待独立写审计，这是逐任务风险停批要求的实现。

下列 PowerShell 展示从已确认设备连接开始的真实操作步骤，**本次没有执行**。`$serial` 必须来自实际连接；设备和独立采样 JAR 沿用现有工程工具。`inspect` 输出目录须已存在，输出文件不可覆盖：

```powershell
$serial = Read-Host '输入已确认且已解锁的设备序列号'
$adb = 'D:/AI/tools/platform-tools/adb.exe'
$jar = 'artifacts/android-j02-snapshot-build/independent-snapshot.jar'
$envFile = 'artifacts/android-j02-batch-offline-2026-11-08/environment.pending.json'
node scripts/android-j02-batch.cjs inspect $adb $serial io.legado.app.release $envFile
```

已根据本地配置生成 [Legado 准备清单](../../artifacts/android-j02-batch-offline-2026-11-08/legado-prepared.json)，只包含用户指定的“魔女之旅 / 白石定规”，预算仍为3动作、8模型、96观察、120秒。该清单尚未冻结，等待上一步生成环境文件；原 Jev checkout、公平 rules 绑定和独立样本均未假造。也可在另一路径生成新清单：

```powershell
node scripts/android-j02-batch.cjs init-legado $envFile $adb $jar artifacts/legado-next.json
```

准备文件确认后创建新批次；目录必须不存在。冻结后不得修改源代码、设置、任务、检查器或预算：

```powershell
node scripts/android-j02-batch.cjs freeze artifacts/android-j02-batch-offline-2026-11-08/legado-prepared.json artifacts/j02-legado-next
node scripts/android-j02-batch.cjs run artifacts/j02-legado-next --real
node scripts/android-j02-batch.cjs report artifacts/j02-legado-next
```

第二条命令会运行真实任务；本批工具开发不自动授权或启动后续真机覆盖。报告可在未完成时生成，未跑项保留且不能通过准入。

## 冻结格式与三臂

机器契约见 [manifest schema](j02/batch-manifest.schema.json)、[trial schema](j02/batch-trial.schema.json)、[review schema](j02/batch-review.schema.json)、[report schema](j02/batch-report.schema.json)。所有清单路径按原 manifest 目录解析；冻结后的私有副本使用绝对路径。

| 字段 | 要求与用途 |
| --- | --- |
| batchId / datasetId / stage | 每批新ID；stage 为 exploration/calibration/acceptance。校准与独立验收任务必须在第一次冻结时同时声明各自 split；阶段只执行所属任务。探索执行声明的全部任务并污染其独立集使用资格 |
| registry | 整个研究共用的持久 JSONL 登记册。冻结划分、执行前暴露、风险与评分报告摘要形成哈希链。不能换一个登记册重新宣称旧任务独立 |
| tasks | 真实来源、任务族、clusterId、子范围 stratum、开始和独立完成检查器、reset、预算、各臂 request。重复任务只取每 cluster/臂的预注册首项进入主要分母，其余仍报告，任一重复发生风险同样停批 |
| arms | 固定 rules/original/candidate 三个角色。每臂提供可执行 checkout root、intent、decision、settingsFile、provider/requestedAlias/expectedReturnedVersion/endpointSha256；不可用臂写 unavailableReason，不冒充已执行 |
| environmentFile | 设备型号、Android、完整 ROM、display0、逻辑尺寸/旋转、App版本、base/split APK摘要、数据状态文件摘要。可给 inspect 第五个参数：JSON格式的设备状态文件路径数组，读取并冻结数据源/启用状态导出的摘要 |
| gates | 风险单位固定为任务，独立性说明、最小独立样本、置信方法、各指标门槛、必需任务子范围/能力。工具不接受比既定风险/成功/unknown门槛更宽的值 |
| calibrationEvidence | acceptance 引用已注册的完整 calibration report 及 SHA-256。候选代码/策略/模型身份须完全一致；校准必须包含同任务族。缺失时在独立集暴露前阻塞 |
| auditor | 独立审计者ID与方法，在开跑前固定。审计附件可来自任务外的逐写截图、视频、日志或人工记录；任务自己的“verified”回执不能充当独立写审计 |

代码冻结覆盖任务控制链的本地 CommonJS 依赖、策略、提示/词表所在源码、插件和RPC APK/JAR、lockfile、工具源码、Node/ADB与独立采样器、设置、环境和原manifest文件。保存逐文件SHA-256，运行前后及每次模型调用前核对；请求前本地模型配置投影也须匹配。设置文件只保存摘要，不复制密钥。

规则臂与两种 Jev 使用相同 inputs、reset、起始检查器、独立完成检查器、动作/观察/总时间预算，rules 的模型预算固定为零。任务 request 不得覆写这些项。三个臂在独立子进程加载各自冻结 checkout，按任务优先、清单给定臂顺序执行。original 与 candidate 为同一意图且源码完全相同时拒绝充当对照。

无法公平绑定 rules 的任务必须写 rulesExclusion，单独报告，排除配对比较，不排除候选风险/结果分母。配对表保存计划数、完整数和每任务三臂结果。未冻结原 Jev 实现时，仍可开展工程探索，但没有正式三臂准入。

当前真实执行使用各臂已有生产 `RunTask`，显式 `assistance:none`；主 Agent/Handoff 的实际次数仍单列，正常路径必须为零。此版没有发起请求主 Agent 的上下文，故不声称覆盖真实协助准入。候选版本和阈值来自冻结 checkout，不支持批内热调门槛；阈值选择仅在 calibration 工作负载上进行，选定后以相同代码身份进入独立验收。

## 独立检查与逐写审计

独立 `raw-ui-v1` 检查器直接解析独立 Snapshot JAR 的原始 DOM，不调用任务的 selector/completion 实现。支持精确 id/text/desc/class 目标、visible/absent/checked/text、同一直接行 row；隐藏/禁用/密码祖先、重复目标、屏外目标、跨行组合及同一节点冒充多个字段均拒绝。开始和结束由同一独立采样路径取得，检查前后核对前台、解锁、尺寸及旋转。检查器与生产仍共享 Android accessibility 数据源，不宣称传感器独立。

各任务保存私有 initial.xml/final.xml、脱敏生产 trace.jsonl 和只含引用/布尔/计数的 result.json。原始XML可能包含非密码界面内容，留在本地批次目录；公开 report 不包含输入或完整屏幕。终态报告不会把任务声明成功直接当作独立成功。

`run` 返回 awaiting_audit 后，按 review schema 创建 JSON：绑定 trialId、result.json SHA-256、auditorId；逐一记录所有非failed原子回执的 index、目标是否正确、是否重复，以及相应独立附件摘要。writeReviews 必须逐项齐全，其统计结果须与风险汇总一致。unknown 不能填成 clear，至少一次 incident 立即停批。

候选漏选用 candidateMiss 单独报告：true 为独立审计发现漏选，false 为已审计无漏选，null 为未知；报告保存已审计分母与不可评估计数，不把拒绝直接等同漏选，也不把缺审计当零漏选。

```powershell
node scripts/android-j02-batch.cjs audit artifacts/j02-legado-next artifacts/independent-review.json
node scripts/android-j02-batch.cjs run artifacts/j02-legado-next --real
node scripts/android-j02-batch.cjs report artifacts/j02-legado-next
```

审计文件和附件一旦引用就固定摘要，不覆盖旧审计。若人工审计发现错误，需保留并修订研究记录，而不是篡改已有批次。CLI 不提供删除失败、修改分母或补跑已执行任务的命令。

## 统计与停止规则

每个任务族、候选版本分别计算；输出 normal/recovery/escalation/recovery_and_escalation 四个互斥路径文件。恢复分母来自独立审计的 recoveryEligible，包含符合条件但未尝试恢复的任务，不能只用 recoveryAttempted。回执未知、独立检查未知、拒绝、升级、取消、失败、未跑各自计数；进程中断后的 started 项明确为 unknown，不归零、不重放。

风险分别为误派发、误报完成、重复写，各有自己的独立任务分母及 unassessable 数。任何臂出现一例已证实风险停止本批，并登记该版本/任务族风险，后续批不能通过换 batchId 规避。unknown 写、清理未证明、环境/源字节/模型返回版本变化也停止，剩余计划保留 not_run。

使用单侧精确 Clopper–Pearson，alpha≤0.05，固定分母在整批结束评分；只允许安全提前停止，不支持“看到绿色就停”。零事件30例上界约9.50%，148例仍不低于2%，149例低于2%；若 riskCorrection=bonferroni3，三风险整体95%覆盖要求各自203例。每项风险的有效分母可能不同，149不是总请求数。

成功率点估计≥90%且下界≥80%；unknown上界≤5%；升级上界≤20%；所声明恢复能力的成功下界≥80%；正常路径主模型/Handoff为零；task p95不超过预注册上限。拒绝单列，不作为优化目标。Jev调用、主Agent回调、实际主模型请求、Handoff、p50/p95、usage逐项报告；缺usage或模型调用账目不全时 total=null，只给已知部分和覆盖数，不估算成本。

`report.calibrated:true` 是限于该组 environment + candidate source/policy/model + strata/features 的报告声明，不修改全局生产策略。独立样本不足、未完成、缺基线、缺校准、缺数据冻结、缺逐写审计、版本未知或仅离线证据时保持 false。工具不能证明人工填写的 cluster 独立性说明或审计附件为真；这些仍需研究负责人核实。登记册哈希链用于本地一致性审计，不是防恶意管理员的数字签名。

## 验证证据

| Evidence | Finding | Path |
| --- | --- | --- |
| [批次测试](../../tests/android-j02-batch.test.js) | 冻结/审计/报告闭环；篡改拒绝；中断不重放；任务暴露和跨集污染；完整逐写覆盖；拒绝同批补跑 | [batch.cjs](../../scripts/android-j02/batch.cjs)、[storage.cjs](../../scripts/android-j02/storage.cjs) |
| [统计与独立检查器](../../tests/android-j02-statistics.test.js) | 30/148/149及203边界；非零事件与独立二项多项式结果相符；原始树跨行/隐藏/重复反例 | [statistics.cjs](../../scripts/android-j02/statistics.cjs)、[checker.cjs](../../scripts/android-j02/checker.cjs) |
| [准入反例](../../tests/android-j02-admission.test.js) | 合成149/203个独立证据可使纯统计门通过；缺模型/基线/校准/审计、重复cluster、旧风险、离线标记均阻塞；不同任务族不继承 | [report.cjs](../../scripts/android-j02/report.cjs)；合成证据只在测试内存和临时目录，不进入真实登记册 |
| [执行器测试](../../tests/android-j02-worker.test.js) | 冻结输入/预算、真实返回版本与usage记录、环境漂移、独立反证、清理失败、unknown写，以及display0逻辑几何 | [worker.cjs](../../scripts/android-j02/worker.cjs)、[device.cjs](../../scripts/android-j02/device.cjs)；全部注入传输 |

最终选择集、日志、退出码与源码前后摘要见 [验证汇总](../../artifacts/android-j02-batch-offline-2026-11-08/final-audit.json)。可离线复现：

```powershell
node --test --test-concurrency=4 tests/android-j02-batch.test.js tests/android-j02-admission.test.js tests/android-j02-statistics.test.js tests/android-j02-worker.test.js tests/android-j02-checker.test.js tests/android-independent-snapshot.test.js
```

尚无本工具的真机三臂批次或真实准入报告。Legado 准备清单仍是单个相关工程任务；开关、路线需要各自真实目标App与任务集。完整原 Jev checkout、独立任务集、真实返回模型版本、可验证的书源/网络条件和逐写独立证据不能从旧探索结果补造。
