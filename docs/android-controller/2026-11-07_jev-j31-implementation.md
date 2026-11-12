# J3.1 同包聚焦、IME 与单次目标查找

本批在现有 RunTask 执行链增加显式声明的聚焦、IME 提交和单次滚动查找，不引入新的执行框架。档位、回归数字、容量及固定对照统一见 [当前状态](README.md)。实现前冻结范围见 [契约](2026-11-07_jev-j31-contract.md)，命令与代码身份见 [选择集](../../artifacts/android-jev-j31-2026-11-07/final-selection.json)，退出码见 [结果](../../artifacts/android-jev-j31-2026-11-07/final-result.json)，汇总见 [证据](../../artifacts/android-jev-j31-2026-11-07/evidence.json)。

## 行为与边界

`decision=jev` 可在任务中声明非空 `searchActions`，包含 `imeAction: enter|search` 和/或 `scroll: {command, container, target, direction}`。原普通搜索仍使用既有精确词表。新命令、目标与方向由宿主从冻结声明生成，模型只选绑定当前观察的候选，不能改写参数。rules/shadow 不接受该声明；跨包 ID、未知字段、getter、完成标记作为查找目标等在采样前拒绝。

IME 路径先证明只有一个原始安全输入框，再执行原 Fill 精确读回。尚未唯一聚焦时新增 focus 阶段，用 Tap 聚焦原框；全原始树唯一焦点、原输入匹配和上下文一致才算成功。submit 阶段提供声明的 ImeAction，不同时提供普通按钮。新观察及最终写前 fence 继续证明焦点和输入，按键 ACK 不证明业务完成，仍由原独立完成谓词验收。已验证聚焦后再次丢失焦点不能重复点击同一目标。

seek 阶段仅在输入前缺少普通搜索候选时出现。原始树必须证明声明容器身份唯一、可见启用且明确可滚动。目标可以暂不存在；出现后必须是该容器后代中的唯一安全控件，符合既有搜索词表，并离开滚动轴两端边缘。原始父子关系、焦点计数和输入值只在宿主内部使用，不发送给模型。

本批滚动限定为单次 swipe：Scroll 使用现有单次 RPC/设备手势通道，固定距离及时间；ScrollUntil 使用现有 host 路径并固定 maxSwipes=1，不使用 RPC scrollTo 的内部多次滚动。每次均消耗原动作预算，成功必须由指定搜索目标可用证明。装饰变化、目标在容器外、边缘、重复或密码字段均不能成为进展；派发后未证实保持 unknown，不重放、不降级，也不宣称到达列表边界。

本批策略身份为 `search-v6`，反馈为 `search-feedback-v2`，语义仍 `search-semantics-v1`，完成仍 `search-completion-v2`，`calibrated:false`。新阶段、固定参数和已验证历史进入同一白名单轨迹和 VCPToolBox 主 Agent 投影，原循环、预算、等待、stale、升级和隔离规则继续有效。历史轨迹按旧协议读取，不能借旧版本容纳新增动作。

## 验证与失败记录

专项使用真实 AndroidControllerService、XML 采集、执行器、task-port、原子动作、策略和最终 fence，配合模型、设备和 HTTP/WS 替身。轨迹实际落盘，主 Agent 使用实际投影器。覆盖两种 IME 键、已有焦点/先聚焦、四方向的两种滚动、组合路径、重复/多输入框、原始焦点歧义、最终派发前输入或焦点变化、重复聚焦、外包权限窗口、错误目标、unknown、动作预算、取消排干、升级与参数篡改。两种供应商的实际 JevClient 请求体隐私回归和此前跨仓主 Agent 链路也保留。

首轮专项暴露同时存在多个原始焦点时仍可生成聚焦候选，现已收紧为直接停止，并将 IME 输入框唯一性检查提前到 Fill 之前。另有夹具未模拟 Scroll 的实际 RPC swipe 路径，以及短总截止测试把外层 STEP_DEADLINE 错当作内部正常停止回执；分别补齐替身和使用足够的原验证窗口，未缩短或放宽生产后置验证。初轮 [actions-r1.log](../../artifacts/android-jev-j31-2026-11-07/actions-r1.log) 保留，修正后 [actions-r2.log](../../artifacts/android-jev-j31-2026-11-07/actions-r2.log)、[actions-r3.log](../../artifacts/android-jev-j31-2026-11-07/actions-r3.log) 分开保存。旧 search-v5 版本断言的首次失败保留在 [core-r1.log](../../artifacts/android-jev-j31-2026-11-07/core-r1.log)。最终限定集还覆盖新增容器反例及收尾修订。

[固定对照](../../artifacts/android-jev-j31-2026-11-07/comparison.json) 从本批改前快照加载实际 search-v5 循环、执行器及语义模块，与当前版本共用设备转移和固定回答。未声明新动作的普通场景在候选准入、实际动作、停止结果、调用次数和请求字节上保持一致。故意错误高置信场景仍会误派发后停止，不能把行为一致或单元通过解释为真实模型质量提升。输入大小仅测 UTF-8 JSON `{state,questions}`，不包含供应商封装、token 或计费。

[本批差异](../../artifacts/android-jev-j31-2026-11-07/changes.diff) 相对 [改前工作区快照](../../artifacts/android-jev-j31-2026-11-07/before.json)，保留两仓已有修改。[静态检查](../../artifacts/android-jev-j31-2026-11-07/static-checks.json) 和最终摘要复核与测试结果共同构成本批证据，不等同全仓发布验收。

本批无真实模型请求或真机动作。J3.1 的多屏连续查找仍未实现：需要先明确每次滚动的独立进展、目标未出现时的停止判据、逐写预算与新观察绑定，再决定是否扩展。当前同包上下文规则继续拒绝外包键盘树和窗口/尺寸变化，因此不能宣称适配所有 IME/App。J0.2 真实任务校准与设备/App 联合准入仍是独立门槛。
