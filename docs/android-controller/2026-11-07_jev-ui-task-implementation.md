# 通用 UI 任务循环与算法等待：实现及真实探索

本文件记录 v18/r21 的历史实现与真实探索。当前 v19 的显式协助、统一回放及离线回归见 [后续报告](2026-11-07_jev-ui-task-offline-v19.md)；以下真机证据不能外推给 v19。

用户要求参照 jev-android 提供自主导航、多步骤操作和目标判断，并用真实任务“在 Legado 搜索魔女之旅，找到作者白石定规”验证。当前策略为 `ui-task-v18 / ui-elements-v10 / ui-predicates-v1`；准入状态仍为 `calibrated:false`。最终 r21 已端到端通过：模型选择 Done 后，宿主稳定核验与独立检查器均满足原书名/作者条件；[原始报告](../../artifacts/android-j02-ui-task-exploration-r21/report.json)、[身份与调用核验](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-final-verification.json)，计数汇总见[文档索引](README.md)。

## 实现边界

`RunTask intent=ui_task` 从当前观察生成绑定节点的有限候选，支持 Tap、Fill、四向 Scroll、Back、ImeAction、LongPress、白名单内 LaunchApp。输入只能引用调用者给出的具名准确值。无 ID 和重复 ID 的目标绑定当前快照索引，Fill 另须 RPC 唯一性与精确读回；显式完成条件中的字段/inputRef 绑定约束填写。每次模型选择后重新观察，可信未派发 stale 可在原预算内重决策；未知写停止，已接受的同页面/同动作不重复派发。

Jev 接收目标、具名输入、有界非密码文字/字段值、当前条件满足情况与近期动作。匿名或同名容器保留逐观察身份，模型可区分同名列表各行，避免把多个书名和作者归并到同一个容器。轨迹保存引用与摘要，不保存目标、输入或屏幕原文。无检查器的 Done 只返回 unverified；有检查器时仍须两次完整、稳定且满足谓词的读回。

已实际参考 `D:/AI/_research/jev-android` 的提交 `be8364ad1a7596172f8cd79c70d2462f4dd0f4dc`，主要是有限动作、具名输入、观察后重决策及 Done 非业务成功的契约；没有复制 Kotlin 实现。

## 页面加载为何交给算法

旧实现每次等五秒后再次调用 Jev 选择 wait，导致真实任务三次写完成后，剩余模型预算全部耗在加载等待上。现在明确的加载标记和页面未稳定状态直接进入宿主只读循环：每段最多五秒，两次完整采样稳定且加载结束或原目标满足后才调用 Jev。所有观察仍计入原观察预算，所有窗口共用原总截止；剩余不足完整采样余量或不能取得新完整样本时停止。模型主动 wait 仍保留，用于缺少显式加载证据但模型能判断有待变化的场景。

轨迹 `wait.source` 区分 host/model，`reason` 区分 loading/page_unsettled/model_requested。宿主等待不消耗模型调用或写动作预算；持久轨迹为这些等待预留由观察预算界定的事件容量，原 512 KiB 字节上限及终止预留不变。

本任务仍冻结 3 次写、8 次模型调用、96 次观察、120 秒总截止、5 秒单窗口、200ms 稳定采样间隔、0.90 概率及 0.20 领先差。未扩大预算，未放宽完成谓词。后台其它书源尚在加载时，若指定书名/作者已经出现在同一行，可申请完成验证。

## 证据及保留的失败

全部探索是用户同一个真实任务的相关重复，不构成独立验收样本。批次逐项见[台账](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-batch-ledger.json)，旧 report、invalid-report、launch-failure 与源字节均保留。

- r18 / v15：三次写后五次模型等待，耗尽八次模型调用，TASK_LOOP_LIMIT。
- r19 / v16：算法等待已找到目标，独立检查 pass；Done=0.61 被原门槛拒绝。修正后台加载与目标满足时 wait/Done 提示冲突。
- r20 / v17：独立检查 pass；Done=0.89 仍被拒绝。只读诊断发现匿名结果行被模型投影丢弃，不同行作者共享同一列表引用；v18 修复容器身份，没有降低概率门槛。

r10/r11 源码变化导致 invalidated；r12 隔离副本漏依赖导致启动失败；r7 报告 enum 未同步，仅保留 invalid-report。后续运行从逐文件 SHA-256 核验的隔离源码执行，递归追踪本地 CommonJS 依赖，运行前验证报告策略枚举。设置通过本地目录联接读取，不复制密钥；批次仍核验设置、代码、APK、ROM 身份。

请求别名与返回版本分别记录；HTTP 响应证据不能冒充用户网关业务日志。服务使用已配置的 Jev 单次截止并受任务剩余时间限制，零网络重试。usage 仅记录实际返回字段，缺失 totalTokens 保持 null，不用输入/输出自行估算。正常路径主 Agent 和 Handoff 均没有调用。

## 验证与限制

最终专项包含生产 Service/dispatch、结构证据、预算、取消、未知写、完成条件丢失、轨迹存储及独立检查器，见[日志](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-v18-tests.log)。离线模型全部为替身；真实模型只接收上述用户真实任务，无合成上游探针。

相关文件集回归的选择清单见[selection](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-v16-regression-selection.json)，[完整日志](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-v16-regression.log)保留全部失败。该回归执行时通用循环为 v16，后续 v17/v18 改动已做专项复验。失败项均是 `android-takeover-viewer` / `android-viewer-presentation` 中“零定时器”的断言；当前 viewer 的设备状态轮询留下一个定时器。不能据此声称整仓全绿，也没有为了本任务修改并行 viewer 行为。

独立检查器在任务服务清理排干后，使用单次 Android 采样 JAR 和独立 DOM 逻辑，要求搜索框精确查询，并在同一直接结果行匹配精确书名/作者；允许 NFC、trim 及作者前缀。它与生产检查共用设备 accessibility 数据源，不宣称传感器独立。成功不能替代逐写风险审计。

结论只限 PJZ110 / Android 17 / 当前单 ROM / display 0 / 指定 Legado 工作负载 / 实际返回模型版本。开关、路线、其它 App、跨 ROM、多屏和长稳未通过此次准入；不能宣称支持绝大多数真实任务。正式 J0.2 仍需独立样本、校准/验收划分、冻结书源、配对基线及风险审计；零风险事件也须足够独立分母和预注册置信区间。协议见[冻结协议](2026-11-07_jev-ui-task-protocol.md)。
