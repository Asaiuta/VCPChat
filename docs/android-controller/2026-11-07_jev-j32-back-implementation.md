# J3.2a 同窗口返回搜索实现

本批把预声明的一次 Back 接入原 Jev 搜索循环，可从同包、同窗口的非编辑面板返回指定搜索入口或输入框。当前档位、测试数字、容量及对照结果统一见 [当前状态](README.md)。范围及实现期审查补充见 [冻结契约](2026-11-07_jev-j32-back-contract.md)，命令与源码摘要见 [选择集](../../artifacts/android-jev-j32-back-2026-11-07/final-selection.json)，两仓退出码见 [结果](../../artifacts/android-jev-j32-back-2026-11-07/final-result.json)，汇总见 [证据](../../artifacts/android-jev-j32-back-2026-11-07/evidence.json)。

## 实现及边界

`searchActions.back:{from,target}` 只接受 Jev 模式下两个不同的同包完整资源 ID，不得占用完成、条目、负向完成条件或加载标记。只有当前原始树存在唯一、安全、启用、完整可见的非交互来源标记，且目标原始身份尚不存在时才提供 back 候选。整棵原始树含输入框、editable、password 或 checkable 节点时直接停止，隐藏节点也不能绕过。它要求调用方声明已知非编辑面板；UI 属性不能证明应用没有其它隐藏业务状态。

原始树判据提取到局部 `task-back-evidence.js`，循环保留编排职责，复用原执行器、task-port、原子 KeyEvent、写前 fence、策略、预算与租约。无需新增设备 RPC、服务容器或通用导航执行器。该动作只能作为任务首个写动作，固定 key=back，每任务最多派发一次；可信未派发 stale 可重新观察决策，已派发 unknown 不重试、不升级补偿。

返回后来源必须消失，指定搜索入口或输入框必须唯一、启用、完整可见且符合原搜索词表。两次连续独立观察完整摘要与可信上下文稳定才确认进展。返回后仍临时绑定目标，不能改填另一个搜索框；验证入口转入新表单或 Fill 后才解除绑定。来源再次出现、目标丢失、窗口/Activity/包变化均停止。主 Agent 或人工交还保留已用 Back 和原预算，取消仍等待实际依赖排干。

策略为 `search-v8`、反馈为 `search-feedback-v4`，完成仍为 `search-completion-v2`，语义仍为 `search-semantics-v1`，`calibrated:false`。新增 back 阶段、固定 `{key:back,revealId}`、`search_back_progress` 与 `verified_back`；候选 targetId 是来源证据标记，不是按键的元素目标。轨迹与 VCPToolBox 投影绑定同一声明，旧版本不能承载 Back，输入与屏幕原文不外发。现有主 Agent 请求归属、零重试和取消链保持原语义。

## 复现、测试与对照

专项使用生产 Service、原始 XML、task-port、策略/fence、原子回执、真实轨迹文件与主 Agent 投影器；设备、模型、原生人工交互和网络载体为离线替身。场景覆盖返回输入框/搜索入口、IME 组合、无需 Back、声明准入、隐藏编辑控件、密码/可修改选项、来源及目标歧义、来源未消失、无变化/装饰变化、错误目标、模型及最终派发 stale、回访、目标丢失、原预算、主 Agent 选择/重观察、人工交还、Activity/窗口变化、只读/敏感策略、unknown、取消排干和轨迹/上游参数篡改。判断包含确切设备写入、调用次数、终态与原子回执。

首轮专项通过后，额外审查发现旧入口验证接受“下一阶段存在不同候选”；加入 Back 后，这可能把错误点击进入来源面板视为进展，并继续用 Back 补偿。先新增独立反例，保存失败 [entry-boundary-r1.log](../../artifacts/android-jev-j32-back-2026-11-07/entry-boundary-r1.log)，再将 Back 收窄为首个写动作，同时明确禁止入口后置验证接受 back 阶段。修正后的专项见 [back-r2.log](../../artifacts/android-jev-j32-back-2026-11-07/back-r2.log)，最终限定集包含新增策略与夹具修改。未放宽上下文、结果谓词或写前检查。

第一次完整限定回归保存在 [final-r1-VCPChat.log](../../artifacts/android-jev-j32-back-2026-11-07/final-r1-VCPChat.log)。旧“屏幕外结果容器”测试仅接受 TASK_ACTION_UNVERIFIED，但采样跨过局部截止时，现有 expectation-wait 会记录 VERIFICATION_TIMEOUT；两条路径都未验证且保持 unknown。[固定时钟复现](../../artifacts/android-jev-j32-back-2026-11-07/verification-deadline-control.cjs) 直接执行该生产等待器，分别控制在采样间到期和采样内跨期，[结果](../../artifacts/android-jev-j32-back-2026-11-07/verification-deadline-control.json) 确认两个合法分支。仅修正该测试接受的停止码，并加强 stopped、精确写入序列、回执数量及最终 unknown 断言；生产等待器和时间预算均未改变。

[夹具目录](../../tests/fixtures/android-jev/README.md) 新增 `backCases`，固定返回输入框、IME 组合及原动作预算的输入、预期写入、终态和模型次数，由同一专项实际消费。其余反例保留在专项代码中。J5.3 因此增加了可追溯离线场景，但仍不具备完整生产轨迹反向重建，也不能覆盖尚未实现的任务族。

[固定回答对照](../../artifacts/android-jev-j32-back-2026-11-07/comparison.json) 从本批改前快照加载实际 search-v7 循环、执行器和语义模块，与当前 search-v8 共用替身转移及回答。比较普通搜索候选准入、实际动作、独立结果和调用次数，并对照既有 IME/单次查找路径的状态、动作、预算计数及回执。实际退出码见 [comparison-result.json](../../artifacts/android-jev-j32-back-2026-11-07/comparison-result.json)。故意错误高置信普通搜索场景仍会误派发后停止，不能将行为一致解释为模型质量改善。请求字节只计 UTF-8 JSON `{state,questions}`，不含供应商封装、token 或计费。

[差异](../../artifacts/android-jev-j32-back-2026-11-07/changes.diff) 基于本批 [改前工作区快照](../../artifacts/android-jev-j32-back-2026-11-07/before.json)，保留两仓此前修改；[静态检查](../../artifacts/android-jev-j32-back-2026-11-07/static-checks.json) 包含备份摘要、源码语法、JSON 与限定文件空白检查。本批没有提交、推送、真实上游请求或真机动作。

这只完成 J3.2 的首个受限子范围。LaunchApp、跨 Activity 导航、LongPress、J3.3 第二意图、J4 多字段与更完整的 J5.3 回放仍待后续离线工作；J0.2 真实模型/App 联合准入保持未完成。
