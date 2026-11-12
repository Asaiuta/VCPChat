# J3.3a 单个应用内布尔开关离线实现

2026-11-07。对应[实现前冻结契约](2026-11-07_jev-j33-toggle-contract.md)。当前阶段、最终测试分母与耗时统一见 [README 状态表](README.md)，具体命令、退出码与文件身份见[选择集](../../artifacts/android-jev-j33-toggle-2026-11-07/final-selection.json)和[结果](../../artifacts/android-jev-j33-toggle-2026-11-07/final-result.json)。

## 行为与实现边界

`RunTask` 增加 `intent:set_toggle`，必须显式 `decision:jev`，声明 `targets.toggle` 和布尔 `inputs.checked`。完成谓词由宿主固定，拒绝调用方另传 completion、loading、searchActions。只处理已在前台同包同窗口中的单个控件，不导航到设置页面。已满足时经过稳定采样后零写、零模型完成；外层回执表示声明条件通过，原子子回执列表为空，没有虚构点击。

原始 XML 的 `checked` 必须明确为 true/false；归一化图默认 false 不参与证明。唯一性包含隐藏/折叠节点；目标必须完整可见、启用、可点击、可勾选，且与动作图中的原始节点一致。拒绝密码、editable、文本框及隐藏/禁用/交互祖先。模型只收到声明 ID、布尔状态、候选和受限反馈，不接收标签、描述、XML 或自由文本。

未满足时只提供绑定目标的 c0/Tap 与 escalate。派发前再次采样及原子 fence；可信未派发 stale 可在原预算内重决策。最多派发一次点击，后置原始值稳定读回和最终完成核验共享点击前启动的局部截止。未知写、状态回退、不稳定或上下文变化不会触发重放或补偿。单次主 Agent/Handoff 复用原调用、预算、租约和排干链；人工改变开关后交还，宿主可读回完成而不再点击。

策略身份为 `toggle-v1`、`toggle-feedback-v1`、`toggle-completion-v1`，`calibrated:false`；搜索继续使用 `search-v8`。真实模型质量、真机适配、持久化及业务效果均没有由离线通过得到证明。

## 职责拆分

- [androidToggleLoop.js](../../modules/services/androidToggleLoop.js)：开关循环、稳定初态、候选/反馈及后置状态验证，不把开关分支堆入搜索阶段。
- [task-toggle-evidence.js](../../VCPDistributedServer/Plugin/AndroidController/lib/task-toggle-evidence.js)：原始属性、唯一性、完整可见性与祖先证明。
- [androidTaskExecutor.js](../../modules/services/androidTaskExecutor.js)：受限第二意图准入；复用模型、计数、原子回执、升级、取消和轨迹生命周期。没有新建运行时、锁或依赖容器。
- [task-port.js](../../VCPDistributedServer/Plugin/AndroidController/lib/task-port.js)：开关样本、一次 Tap 作用域与写前检查。新意图不再装配搜索文本字段。
- [androidTaskTrace.js](../../modules/services/androidTaskTrace.js)：按意图绑定闭词表、目标布尔值及版本。旧搜索协议不接受开关证据，开关协议拒绝搜索候选、等待、参数和标签。
- VCPToolBox 的 `modules/androidToggleReplanEvidence.js` 与原 `androidTaskReplanner.js`：独立开关投影、同一实际主 Agent 传输和取消链；无需调整工具执行主链。

Describe 目录、插件 manifest 和插件 README 已同步公开声明范围与限制。

## 验收内容

真实 Service 入口连接离线 XML、RPC 和 Jev 替身，独立检查环境中的开关值、非目标状态、坐标与写次数，并检查任务终态及子动作回执。覆盖开/关、目标已满足、缺失/非法 checked、隐藏重复、裁剪/不安全祖先、错误效果、状态回退、页面不稳定、观察/派发 stale、第三次停止、模型分布及观察绑定、预算、超时、主 Agent 与 Handoff、单次采树和跨采样窗口变化、模型/回调/RPC 在途取消与排干。

跨仓测试以模拟 fetch 调用实际主 Agent 适配器，检查固定模型身份、投影内容、调用次数、错误协议在发送前被拒绝。轨迹测试覆盖 false 保留、目标/完成/候选绑定、旧搜索版本隔离与终止预留。容量夹具使用最大观察/模型预算与最大包名、资源 ID、设备 ID 字段；不表示模型成功率或性能基线。

[固定回答对照](../../artifacts/android-jev-j33-toggle-2026-11-07/comparison.json)加载本批改前工作区的实际搜索 executor、loop、semantics。两组使用同一生产 Service/task-port 接缝及离线环境；除了普通搜索，还覆盖 IME、Scroll、ScrollUntil 和首个 Back。对比候选准入、终态、实际动作、预算、原子回执、模型/升级次数和请求字节。故意错误高置信场景的误派发保留在分母中；这个对照不衡量真实模型质量，也不把固定回答替身称为完整反事实回放。

最终选择集继承前批两仓限定全集，加入新意图、证据与上游专项。它不是全仓测试。所有源码修改均相对改前脏工作区记录，未清理、暂存、提交或推送无关工作。

## 失败与复核记录

1. [toggle-r1.log](../../artifacts/android-jev-j33-toggle-2026-11-07/toggle-r1.log)：测试误读不存在的外层 dispatched 字段。改为核对真实 RPC、独立状态和子回执，外层保留真实 verification 语义；生产代码未为该断言添加假字段。
2. [toggle-r2.log](../../artifacts/android-jev-j33-toggle-2026-11-07/toggle-r2.log)：在单次采树中切换窗口会由底层先报 UI_CONTEXT_CHANGED。修正此特定测试的精确停止码，并增加两次完整采样之间漂移的独立用例，仍要求零新写。
3. 代码复核发现内部 verifyAfter 直接采样，没有经过 executor 外层上下文检查。补上开关后置同窗口检查，并要求跨窗口点击保留 unknown、verifiedActions 不增加。[受控复现](../../artifacts/android-jev-j33-toggle-2026-11-07/inner-context-result.json)通过从当前模块去掉精确检查段重建修复前行为；其来源明确标为重建，非独立历史 checkout。修复前外层会停止但子回执误记 verified，修复后子回执为 unknown，无重放。
4. [final-r1-result.json](../../artifacts/android-jev-j33-toggle-2026-11-07/final-r1-result.json)：测试进程均通过，但运行期间进行了上述复核修复，前后摘要变化使聚合验收失败。该轮没有冒充最终验收；最终轮使用修复后的固定文件集。

最终完整性证据见 [evidence.json](../../artifacts/android-jev-j33-toggle-2026-11-07/evidence.json)、[final-audit.json](../../artifacts/android-jev-j33-toggle-2026-11-07/final-audit.json)和[相对工作区差异](../../artifacts/android-jev-j33-toggle-2026-11-07/changes.diff)。没有真实上游请求、设备动作、提交或推送。

## 后续范围

这只完成 J3.3a 单控件首批。J3.2 的 LaunchApp、跨 Activity 导航和有明确用途的 LongPress，J3.3 多部分目标，J4 类型化多字段，以及完整教学/回放仍待独立契约与实现。下一项离线优先评估 J4 的少量声明字段、宿主参数绑定、逐字段读回和提交前复核；继续沿用已有身份、预算与升级链，不开放自由生成输入。真实模型校准与真机/App 联合准入继续单列。
