# J4a 类型化双字段路线查询实现与离线证据

2026-11-07。对应[冻结契约](2026-11-07_jev-j4-route-contract.md)。当前验收档位、测试分母、容量和身份文件数统一见 [README 状态表](README.md)，本文件说明实现与证据边界。

## 实现范围

新增 `RunTask intent:route_search, decision:jev`：调用方声明同表单的 origin、destination、submit 和结果标记，宿主绑定两个实际输入值。Jev 只能选择尚未验证字段的候选或请求升级；已正确预填的字段不重写。两个字段均经稳定验证后才生成提交候选，每字段最多一次 Fill、最多一次提交 Tap。

原始树校验覆盖完整资源身份、同包/窗口/form、完整可见性、属性、祖先、额外输入和焦点；隐藏重复仍参与歧义判定。输入不 trim，拒绝 C0/C1 控制字符，保留其它空白与 Unicode。字段的 RPC 精确读回和两次稳定原始树读回必须同时通过；已有进度缺失或变值硬停。提交复核全部字段、焦点、未预存结果，完成只证明指定 UI 标记稳定出现。

版本独立为 `route-v1` / `route-feedback-v1` / `route-completion-v1`，仍为 `calibrated:false`。每次 Fill 的验证截止在派发前启动，提交验证与最终核验共用提交前的截止；不以慢响应或重采样重新开窗。沿用原租约、总截止、动作/观察/模型预算、可信未派发 stale 和取消排干。

## 职责调整

没有把路线逻辑继续堆进搜索循环。新增 `androidRouteLoop.js`、原始表单证据 `task-route-evidence.js` 和路线轨迹约束 `androidRouteTrace.js`；执行器和 task-port 只负责意图调度、宿主值绑定、写前检查与回执。

将搜索原有的概率分布/观察 key 校验提取为 `androidTaskDecision.js`，搜索原导出保留，三个意图共用验证实现；将轨迹基础数据校验提取为 `androidTaskTraceData.js`，路线 schema 独立。改前搜索/开关执行器和循环通过工作区字节备份加载对照；底层 Service/task-port 共用当前实现，因此对照不是整仓旧版快照，也不是模型质量测量。

VCPToolBox 新增 `androidRouteReplanEvidence.js`，将受限角色、参数引用、已验证进度、历史回执和原预算投影到实际主 Agent 适配器。候选引用不可改绑，输入值、原始标签、XML、设备序列号和摘要不外发。升级只能 select/reobserve/stop，一次交还不重置预算或已验证字段。提交前明确未派发的 stale 回执允许保留；已派发未知写不能借升级继续。

## 验收覆盖

| 测试入口 | 独立验证内容 |
| --- | --- |
| [Service 路线专项](../../tests/android-jev-route.test.js) | 两种填写顺序、预填跳过、相同值/空白/Unicode、实际字段值与独立提交快照；原始树/焦点/密码/隐藏重复/额外字段反例；RPC 与树读回矛盾、已验证值丢失、预存/无效/不稳定结果；stale、预算、模型无效与低置信、主 Agent/Handoff、跨窗口、取消排干与验证/总截止 |
| [轨迹专项](../../tests/android-route-evidence.test.js) | 实际部分填写升级包 round trip、版本/字段闭词表、目标/引用/完成标记绑定、旧意图隔离、最大预算容量与终止预留 |
| VCPToolBox `tests/android-route-replanner.test.js` | 实际离线包投影与隐私；伪造角色、引用、进度、回执、命令、版本、预算和权限在 fetch 前拒绝 |
| [改前/后对照](../../artifacts/android-jev-j4-route-2026-11-07/compare.cjs) | 搜索语义准入、普通搜索、单次 IME/滚动/Back、开关正反目标/已满足/stale/升级/unknown；比较实际动作、独立结果、调用次数、预算和回执 |
| [跨仓选择集](../../artifacts/android-jev-j4-route-2026-11-07/final-selection.json) | 继承上批限定全集，加入本批三组专项，记录实际命令和源文件 SHA-256；不是全仓测试或设备准入 |

路线容量夹具是序列化压力上界样本：长 ID 候选、最大观察预算、带回执升级包，再以长 ID 动作事件填满事件额度并追加终止记录。它不声称是一条可执行任务轨迹，也不把填充记录计作真实观察或派发。

## 失败证据与修复

- 最初正常夹具的按钮含敏感 `Submit` 文义，触发既有策略。改用普通查询按钮，并保留敏感按钮拒绝专项；未放宽生产策略。新增提交 expect 后补齐路线轨迹对固定完成标记的绑定校验。
- `guard-before.log` 复现 RPC getText 失败被树验证覆盖、已验证字段暂时消失后恢复仍继续。task-port 要求路线 Fill 明确 RPC 验证成功才进入树验证；进度丢失不再进入通用缺目标等待。修后证据见 `guard-after.log`。
- `dispatch-before.log` 复现最后写前采样的进度丢失被当成普通 stale；路线安全与进度检查现先于摘要漂移判断，修后硬停且无第二字段写入，见 `dispatch-after.log`。
- `boundaries-r1.log` 记录上游误拒绝提交前未派发 stale 回执，以及测试误用超时错误码。上游只接受该阶段明确的未派发 stale；总截止断言改为运行时已有的 `STEP_DEADLINE`。修后见 `boundaries-r2.log`。
- `capacity-r1.log` 是容量测试共享对象被修改后，使最后的溢出探针本身无效；改用有效观察事件测试事件上限，未修改生产容量或 schema。
- 首轮跨仓默认并发的既有搜索完成测试返回 `VERIFICATION_TIMEOUT`，见 `final-r1-VCPChat.log`；原测试单独通过，见 `legacy-isolated-result.json`。最终选择集限制文件并发，生产等待器、截止和该测试断言保持原样，首轮失败不作为验收通过。

所有本批证据位于 [artifacts/android-jev-j4-route-2026-11-07](../../artifacts/android-jev-j4-route-2026-11-07/evidence.json)。`before.json` / `before/` 是修改前工作区字节；`changes.diff` 基于这些字节，不以 Git HEAD 覆盖既有脏改动。`collect-evidence.py` 复核备份、当前文件、测试日志、静态检查、对照和产物摘要，输出 `final-audit.json`。

## 后续边界

本批没有真实模型请求、真机操作、提交或推送。它不证明路线结果内容、业务成功、任意表单能力或持久化。搜索、开关、路线策略均未校准；真实模型/App 联合准入仍需各任务族自己的协议。

下一项离线工作优先推进 J5.3 可复现夹具回放：将三个任务族的场景来源、去标识化变换、环境转移、注入回答和独立副作用判据整理为统一入口。J3.2 其余导航、J3.3 多部分目标和 J4 其它字段类型仍独立限定范围，不因本批通过而宣称整个 J 系列完成。
