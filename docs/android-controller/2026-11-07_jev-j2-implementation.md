# J2 最小语义、近期验证反馈与观察绑定

本批在 VCPChat 与 VCPToolBox 接入同一份封闭语义和决策反馈。当前档位、回归数量、容量及固定对照数字统一见 [当前状态](README.md)。实现前约束见 [冻结契约](2026-11-07_jev-j2-contract.md)，实际命令和源码身份见 [选择集](../../artifacts/android-jev-j2-2026-11-07/final-selection.json)，退出码见 [结果](../../artifacts/android-jev-j2-2026-11-07/final-result.json)，汇总见 [证据](../../artifacts/android-jev-j2-2026-11-07/evidence.json)。

## 输入与执行边界

`androidSearchEvidence.js` 集中原精确词表及封闭语义投影，避免候选、轨迹和请求分别推断语义。每个候选绑定命令、目标、后置条件及 `inputRef`（Fill 为 `query`，Tap 为 null），增加有限 role、hints 和 fieldRelation。资源 ID 与精确标签只映射到预声明词表，不发送原始标签、查询值、类名、父 ID 或树路径。资源 ID 本身仍是原有候选身份，模型指令明确将它视为不可信证据。

task-port 仅从直接原始 `node` 父节点生成本次采样内的临时组号，再投影为同父、异父、无输入框、未证实或多输入框歧义。hierarchy 根不能冒充表单分组。结构信息帮助区分已有候选，不扩大动作授权，也不保证每个中性候选都可区分。

每次决策携带绑定当前 observationId 的 `decisionContext`：本轮序号、已验证输入状态、画面摘要是否变化、stale/wait 计数、最近至多三条独立验证成功的动作、上次事件和原六类剩余预算。剩余预算在本次 Jev 调用前采集，包含尚待消耗的本次调用。stale、加载等待、主 Agent 重新观察及人工交还均保留已验证历史；画面变化本身不证明进度。候选与反馈深层冻结，正常轨迹、升级包和上游投影使用同一观察绑定快照。

保留单个联合候选问题，将 key 改为 `next_<当前观察UUID去横线>`。上一观察的回答不能选择新观察中同名的 c0；额外问题头、动作、目标或输入引用均拒绝。answer 仅接受 probabilities 与文档化的 type/choice/confidence，choice 须与最高概率项一致，confidence 不参与授权；顶层仅接受常规返回元数据白名单。校验先检查数据属性描述符，不读取未授权 getter。

策略身份升级为 `search-v5`，语义与反馈分别标记 `search-semantics-v1`、`search-feedback-v1`；完成策略仍为 `search-completion-v2`，`calibrated:false`。本批不新增动作、词表准入、循环预算、重试或模型调用。所有选择继续经过新观察、策略检查、写前 fence、后置验证及独立完成检查。旧版轨迹继续按原形状处理，v5 强制完整语义、反馈与观察绑定。

## 验证范围与对照解释

专项执行真实 AndroidControllerService/XML 采集、轨迹写入、升级包投影和 JevClient 请求构造；模型 HTTP、设备、原生交互及套接字载体使用替身。typesafe 与 openrouter 两种真实请求体构造均检查了敏感文本和查询值不外发，并验证供应商的合法 choice/type/confidence 元数据。结构父关系、无父/多输入框、历史截断、stale 连续性、预算连续性、旧观察回答、额外头、非法元数据、getter、越界轨迹和升级交还均有针对性断言。

[固定对照](../../artifacts/android-jev-j2-2026-11-07/comparison.json) 从本批改前备份加载实际 search-v4 循环和执行器，与当前版本共用设备转移和固定模型回答。它同时检查词表准入等价、控制结果、实际动作、模型调用次数及输入大小。两版动作、状态和调用次数相同；新增语义与反馈增加了请求字节。计量对象是 UTF-8 JSON `{state,questions}`，不含供应商外层协议，也不是 token 或账单成本。

故意选择错误目标的高置信场景在两版都发生一次写入，然后由后置验证停止。该负例说明置信阈值不能证明目标正确；本批没有以对照相等掩盖这一边界。固定回答对照不衡量真实模型选择质量，不支持“成功率提升”结论。真实模型/App 的质量比较须保留独立任务分母，在 J0.2 单独校准和验收。

## 失败记录与可复核性

首轮容量测试的旧元数据夹具携带顶层 `raw` 字段，新协议正确拒绝。修正合法元数据夹具后，保留 usage 内未知字段的隐私断言，并新增顶层自由数据拒绝负例；未放宽生产 schema。失败日志为 [capacity-r1.log](../../artifacts/android-jev-j2-2026-11-07/capacity-r1.log)。

首次完整限定回归中，共享完成页夹具仍以固定 `questions.next` 判断搜索请求，将新动态 key 误当成 shadow 请求。修正为识别独立 shadow 的 `target` 头，设备转移和完成断言保持不变，针对性复验见 [fixtures-r2.log](../../artifacts/android-jev-j2-2026-11-07/fixtures-r2.log)。该轮还在运行中同步了 manifest 工具说明，导致身份检查失败，因此不能作为最终证据；原 [结果](../../artifacts/android-jev-j2-2026-11-07/r1-final-result.json)、[Chat 日志](../../artifacts/android-jev-j2-2026-11-07/r1-final-VCPChat.log) 与 [ToolBox 日志](../../artifacts/android-jev-j2-2026-11-07/r1-final-VCPToolBox.log) 均保留。最终限定回归在源码定稿后重跑，并核验运行前后和收尾时的文件身份。

对照脚本初次相对路径错误已修正，原 [comparison-r1.log](../../artifacts/android-jev-j2-2026-11-07/comparison-r1.log) 保留；最终对照日志为 [comparison-r3.log](../../artifacts/android-jev-j2-2026-11-07/comparison-r3.log)。

[本批差异](../../artifacts/android-jev-j2-2026-11-07/changes.diff) 以 [改前工作区快照](../../artifacts/android-jev-j2-2026-11-07/before.json) 为基线，保留此前两仓既有修改。[静态检查](../../artifacts/android-jev-j2-2026-11-07/static-checks.json) 包含语法、manifest JSON、备份摘要与限定文件的 whitespace 检查；上游原有 CRLF 通过单次命令的 `core.whitespace=cr-at-eol` 处理，未更改 Git 配置。

本批没有真实上游模型请求或真机动作。下一代码批为路线图的 [J3.1 同包搜索动作](2026-11-07_jev-loop-roadmap.md#J3)，先冻结聚焦、滚动/有目标查找与 IME 提交各自的授权和独立后置条件，再扩展同一执行链；真实任务校准与联合准入继续作为单独门槛。
