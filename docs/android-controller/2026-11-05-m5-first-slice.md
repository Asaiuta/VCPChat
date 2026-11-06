# M5 首批：共享任务作用域与受限搜索闭环

日期：2026-11-05 夜间。阶段档位、测试数字唯一维护于 [README](README.md)。离线交付后在 PJZ110 固定靶场完成真机准入（见文末「真机准入」）；未调用真实 Jev 服务。

## 判断与交付范围

首批交付 M5.1a/b/f 的**参数化搜索模板**，不是完成 M5 整阶段，也不是任意App自主探索。公开实验入口 `RunTask` 由调用方提供显式 serial/package、query、同包稳定资源ID targets，以及可独立检验的完成标记。宿主负责可选进入→字段替换/读回→提交→最后可见断言，中途不再向主模型请求下一步。

默认只按规则执行。可选 Jev shadow 仅记录有限候选判断；即使建议 none 或声称成功，也不改变规则动作/完成谓词。未校准建议没有写授权。没有 Skill 编译/复用/修复、持久恢复、任意流程DSL、viewer接管或虚拟屏。完整 M4.1a ownership session/epoch、跨设备别名身份仍未交付；本批只统一当前宿主任务与原子动作的租约作用域。

## 生产接缝

- [宿主执行器](../../modules/services/androidTaskExecutor.js)：严格复制/冻结任务数据，拒未知字段、访问器、跨包目标、缺参数/预算、重复资源；一次prepared任务仅执行一次。固定进度、预算、影子选择、脱敏回执，不把语义树/XML解析搬进宿主。
- [宿主轨迹](../../modules/services/androidTaskTrace.js)：独占JSONL文件，白名单header/event，随机UUID文件名、不覆写，有限事件/字节；访问器/自由文本/原始输入/原始错误拒绝。先记prepared，再写settled；崩溃留下prepared不能推导是否执行，更不是重放许可。
- [任务设备端口](../../VCPDistributedServer/Plugin/AndroidController/lib/task-port.js)：完整单包/default-display观察投影，随机仅内存HMAC密钥保护持久摘要；捕获全部图采样预算；规则目标与最后派发前的完整树/上下文/epoch/TTL比对。仅资源ID与角色/可见/启用/密码/clickable状态进入宿主。
- [运行时](../../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime.js)：根run持有设备，runOwned只创建独立子回执/历史，不重新租约或重置deadline/signal。串行子作用域、禁止嵌套/切设备；父保留派发事实和粘性unknown。取消可以先返回，但外层operation实际等待子依赖排干，不能提前释放设备。
- [Service入口](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)：RunTask沿现有ensureActiveDevice、隔离、stepRuntime、真实executeStepPlan；不递归调用公开processToolCall。缺宿主服务拒绝。首写前先预检搜索所需Fill RPC就绪；已知能力缺失不先点入口。
- [分布式装配](../../VCPDistributedServer/VCPDistributedServer.js)：构造宿主executor/traceStore，经既有services注入；任务取消和主连接断线复用原有可信signal/cancel_tool，不创建第二个服务器或模型自批入口。

## 边界与成功含义

只接受单包资源ID，GUI目标必须唯一可见启用，字段必须非密码。截断、多包、上下文未知、缺目标、歧义和页面变化均停止；不依据唯一候选猜任务相关性，资源绑定本身是显式任务契约。完成标记在起始/提交前出现会拒绝；成功只证明本次声明的UI标记与字段读回，不证明任意业务成功或搜索结果语义。当前不返回/采集搜索结果条目。

预算覆盖任务墙钟、动作数、**所有captureGraph**（含动作实时定位、策略复采、验证轮询）和模型请求。总预算/取消不重置，动作未证实停止；读/写策略、可信逐次批准、RPC owner隔离全部沿用。模型等待不释放租约；不合作依赖一直不settle时仍保留占用，不提供force解锁。

输入query只在内存经真实Fill送往设备；轨迹仅留inputRef=query，Jev不接收输入值/界面文字。观察HMAC无法脱离任务内存密钥离线猜query；它用于绑定证据而非重建原始屏幕。后续学习需要更丰富、独立定义的受控轨迹，不从本版摘要假造完整教学材料。

## 固定验证与失败分类

主要入口是[生产路径搜索测试](../../tests/android-task-executor.test.js)、[运行时测试](../../tests/android-step-runtime.test.js)和[轨迹测试](../../tests/android-task-trace.test.js)。成功任务使用不同query、起始首页/表单；独立模拟App状态/字段RPC读回/最终XML状态验证，不读模型自报成功。另覆盖缺字段、歧义、密码、预存完成标记、策略拒绝、能力关闭、trace失败、影子争用/页变、真实JSONL、观察耗尽、任务deadline、在途RPC取消/unknown与后续隔离。

失败处理记录：

1. 搜索fixture最初使用submit ID，触发既有敏感写门正确拒绝。归为fixture期望错误：改低风险搜索ID，保留生产策略不变。
2. 图采样预算最初只计显式观察。归为实现边界不足：预算下沉captureGraph，成功用例期望据实际独立采样次数更新，不通过少记安全复采追绿。
3. 清单分派测试仍硬编码四入口。新增显式RunTask是本轮允许的未发布接口变更，更新两个清单期望；每条声明必须有真实handler的检查保留。
4. 有界复审复现：shadow写轨迹失败被归为模型故障、零派发停止被标unknown。均修复并锁定定向回归；模型try/catch与trace边界分离，外层按实际派发区分failed/unknown。

限定整套回归日志与定向日志在 [本轮产物](../../artifacts/android-m5-2026-11-05/)；数字看README。选择集为tests下 `android-* / adb-* / scrcpy-* / ui-graph / launch-app / distributed-cancellation / frame-hub-contract / global-jev-service / jev-client` 的 `.test.js/.test.mjs`，加 `scripts/android-m15-fixture/verify-cli.test.cjs` 与 `verify-m2-cli.test.cjs`，用 `node --test` 执行。定向集为 `android-task-executor / android-task-trace / android-step-runtime / android-interaction-guard / distributed-cancellation`。JS语法与限定git diff空白检查通过。不是全仓回归，不与此前不同选集的测试分母混比。

## 简洁性与有界复审

没有引入依赖、全局任务队列、通用工作流引擎或第二套设备锁。宿主模板/trace与设备port各负一责；step-runtime共用回执/错误收尾而非复制整套单步代码。性能策略是有限图投影/计数、串行await写入、小型状态与WeakMap、任务观察不走全量公开渲染/codeIdentity复算；未做真实性能基准，不宣称吞吐提升。

独立复审只检查本轮宿主executor/trace、设备port、Service/guard接缝和实际排干路径；实质问题修复后定向重验，不扩成全仓重构。workspace原先大量未提交变更均保留，没有reset/批量格式化/改依赖。

## 后续顺序

受控搜索fixture已过真机准入；下一步是指定真实App的任务准入，保留拒绝/unknown与完整分母，不合成人工批准。已有无线瞬断owner重绑缺口仍是设备准入风险，见[旋转记录](2026-11-05-rotation-acceptance.md)。跨ROM/长稳、设备别名物理身份、Jev校准分别验收。

固定模板过关后再考虑一般化候选生成、任务轨迹丰富化与Skill草稿编译；不能将本版resourceID模板冒充已学得流程，也不能从一轮成功推断未见分支。

## 真机准入

PJZ110 单 ROM、portrait、隔离靶场 `com.vcpchat.m15fixture`（`fixtureMode=m5`），`node scripts/verify-android-m5.cjs --suite --serial <serial> --adb <adb>`：**8/8 PASSED**，无 case 重试，[日志](../../artifacts/android-m5-device-2026-11-05/run5.log)、[轨迹](../../artifacts/android-m5-device-2026-11-05/run5/traces/)。

- 成功：SearchFromHome（3 动作）、SearchFromForm（2 动作），均以靶场 Provider 独立计数与结果可见证明，不采信任务自报。
- 停止边界：歧义 `TASK_TARGET_AMBIGUOUS`、密码框 `TASK_TARGET_UNSAFE`、完成预存 `TASK_COMPLETION_PREEXISTS`、只读策略 `POLICY_DENIED`、观察预算 `TASK_BUDGET_EXHAUSTED`（已派发未证实 → unknown）、预取消；均 0 次模型调用，前五项靶场状态未变。
- 轨迹不含任何查询输入。
- 准入轮中修正：冷启动先 RPC 预热再采决策快照（CLI 压缩树与 RPC 树摘要不同会误判页面变化）；靶场 `setSingleLine` 覆盖了密码 TransformationMethod，导致首轮密码用例实为普通框，已修靶场，并要求 Provider 独立报告 `passwordField`。
- 操作注意：重装 APK 会让靶场退出前台，gate 以 `UNSAFE_OR_UNPROVEN_TARGET_STOP` 停；先 `am start ... --es fixtureMode m5 --es m5Variant home` 再跑。

## 真实应用试跑（2026-11-06，阅读 Legado）

`artifacts/android-m5-realapp-2026-11-05/run-legado.cjs`：`menu_search` → `search_src_text` → `search_go_btn`，完成标记 `recycler_view`，查询词取自用户已有搜索历史。

- 暴露两处生产缺陷并已修：`AutoCompleteTextView` 被判为静态文本致字段 `TASK_TARGET_UNSAFE`（[argent-uiautomator](../../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator.js)）；AOSP SearchView 提交钮「提交查询」命中「提交」被要求人工确认（[interaction-policy](../../VCPDistributedServer/Plugin/AndroidController/lib/interaction-policy.js) 仅豁免 `search_go_btn` + 原生标签这一对，经用户同意）。
- 修复后 5 次：3 次 completed/verified（屏上独立确认出现同名书目结果，轨迹无查询词）；2 次在入口后停止（`TASK_TARGET_MISSING`、`TASK_OBSERVATION_CHANGED`），均为页面仍在过渡时的安全停止，未重试。入口后不等页面稳定是真实应用的主要失败面。
- 局限：`recycler_view` 只证明结果列表容器出现，不证明结果非空或与查询相关；单次真实应用、单 ROM，不作准入。

## 2026-11-06 续接

以上 3/5 为此前批次。中断会话留下的稳定等待和增强完成条件已继续修正；本轮代码、离线与真实 App 固定分母结果见 [M5 稳定性续接记录](2026-11-06_m5-stability-report.md)。历史 8/8 和 3/5 保留为各自代码快照的证据。
