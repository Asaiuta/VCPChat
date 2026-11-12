# AndroidController 文档索引与当前状态

本目录是 `VCPDistributedServer/Plugin/AndroidController` 的全部文档。

**这个 README 是「现在完成了吗」的唯一答案面。** 任何进度数字、任何阶段状态，只在这里写一次；其余文档引用它，不复制。看到别处的数字与这里不一致，以这里为准，并把那一处改掉。

最后更新：2026-11-08（未知触摸已增加持久隔离：旧RPC退出或宿主重启不能清除，显式恢复还需原设备新启动证明。MuMu真实故障与离线回归见下表；生产不自动重启或发送CANCEL。此前固定时长持续运行属于修复前源码，不继承至本版。`ui-task-v20 / ui-elements-v11 / ui-predicates-v2` 保留原阈值、预算和完成契约；真实模型/真实 App 扩展仍待进行。Legado r21 属于 v18 历史冻结字节，不覆盖 v20；各族仍 `calibrated:false`。search-v9、toggle-v1、route-v1 分开准入）。

---

## 1. 当前状态总表

状态档位：`未开工` → `已落代码` → `已集成` → `离线验证` → `真机通过`。
逐档升级需各自的证据；「离线验证」不等于真机可用，「真机通过」限单 ROM 固定靶场，不外推分辨率、参数组合或其它 ROM。

| 阶段 | 状态 | 证据锚点 | 阻塞 / 边界 |
| --- | --- | --- | --- |
| M0 把账对上 | **部分完成** | `tests/android-config-surface.test.js`；[性能基线](android-performance-baseline.md) | M0.4 代码身份已落，旧基线未迁移；MuMu固定靶场soak见下表，不覆盖真实任务长稳 |
| M1 设备端 RPC | **真机通过 6/6**（2026-11-03） | `scripts/verify-android-m1.cjs` | 密码框分支未覆盖 |
| M1.5 动作语汇 | **真机通过 14/14**（2026-11-05 批次） | `scripts/verify-android-m15.cjs --suite`；[M1.5 记录](android-m15-device-validation.md)；[本轮验收](2026-11-05-device-acceptance.md) | 单 ROM 单 portrait；`DoubleTap` 连续 4 次通过，但无长稳重复 |
| M2 寻址与验证 | **真机通过 14/14**（2026-11-05 批次） | `scripts/verify-android-m2.cjs --suite`；[M2 记录](android-m2-device-validation.md) | 单 ROM、单 portrait；idle 运动用例仍为设计内 unknown |
| M2.5 身份与证据 | **已集成**；owner 绑定/隔离/恢复与无线断线重绑已验证 | [context 集成](../../tests/android-m3-context-service.test.js)、[重绑修复](2026-11-05_android-owner-rebind-report.md) | 单 ROM；连接别名统一、长时间断网与跨 ROM 未验收 |
| 未知触摸持久隔离与恢复 | **已集成、离线及 MuMu 故障验证**：触摸RPC派发前持久化，未知结局跨宿主保留；旧owner退出后仍需同设备新启动证明，零动作重放 | [实现与边界](2026-11-08_android-input-recovery-report.md)；[存储](../../VCPDistributedServer/Plugin/AndroidController/lib/input-recovery.js) | 生产不自动CANCEL或重启；Android ID仅一致性标识；普通shell/键盘遵守已有触摸隔离，但未新增自身崩溃记录；非跨进程全局锁，新版长期运行待验 |
| 旋转 / 方向切换 | **真机通过 8/8**（2026-11-05 夜间） | `scripts/verify-android-rotation.cjs --suite`；[旋转验收](2026-11-05-rotation-acceptance.md) | 单 ROM；横屏下仅验 9/14 |
| M2.6 策略与呈现 | **真机通过**：原生批准/交还 4/4，结构关系与 Collect 5/5 | [人工交互](../../tests/android-human-interaction.test.js)、[无OCR流程](../../tests/android-no-ocr-workflows.test.js)；[本轮验收](2026-11-05-device-acceptance.md) | typed intent 暂缓；批准按钮由真人在现场点击，不可合成 |
| M3 视觉中间层 | **未开工（零实现）** | 无 | 硬前置未闭；OCR/模板一行代码都没有 |
| M4 人机协同 | **首批已集成、离线及隔离浏览器验证**：M4.1默认屏显式设备、原生批准能力、socket写会话/epoch、真实排干、有限快照点击/滑动/按键；M4.0历史原生交互已通过；M4.2 传输层已实现并离线验证（剩公开诊断与别名契约），M4.3 跨设备凭据边界未收口 | [首批接管记录](2026-11-06_android-m4-takeover.md)；[lease](../../tests/android-takeover-lease.test.js)、[Service](../../tests/android-takeover-service.test.js)、[HTTP/WS](../../tests/android-takeover-channel.test.js)、[viewer](../../tests/android-takeover-viewer.test.js) | 接管未真机/真实Electron批准；临时全局门阻止所有Agent与管理，canonical identity、跨进程、多屏、连续pointer/scrcpy control未做 |
| M4.5 后台虚拟屏 | **P0 技术可行性单机通过，生产未接入**：focus1 候选不抢焦点（20/20）；在因果判据下，生产 u2 carrier 按 display 读到虚拟屏元素树，加上 scrcpy control 触摸，F3W 矩阵 20/20（用户全程使用手机，carrier p50 64ms） | [焦点修复报告](2026-11-06_android-m4-focus-report.md)；[P0真机报告](2026-11-06_android-m4-p0-report.md)；[冻结协议](../../scripts/android-m4/README.md) | P0原失败保留；首批矩阵因物理屏外部变化0/1/19中止。未接入生产路径：A3 语义树（生产 uiautomator dump 仍只取活动窗口；F3W 多根读树 20/20 与 control 触摸 22/22 均为研究靶场内验证，见[焦点修复报告](2026-11-06_android-m4-focus-report.md)）、生产 control socket 输入、IME/PASTE、同App迁移、权限弹窗、跨ROM；研究靶场已卸载并复核无残留 |
| M5 长任务与生态 | **受限切片继续完善，完整准入未通过**：原靶场复验 8/8；独立读取改用单次采样进程和有界完整树重采 | [独立采集复验](2026-11-06_m5-independent-verification-report.md)；[前批稳定性](2026-11-06_m5-stability-report.md)；[生产路径测试](../../tests/android-task-executor.test.js) | 最新v5固定20次：独立匹配20/20、联合通过19/20；1次任务UI_CONTEXT_CHANGED，第二App未扩展 |
| M5 上下文差异证据 | **已集成、离线验证**：UI_CONTEXT_CHANGED/上下文不明附封闭词表维度名，完成阶段逐样本谓词与容器内外HMAC摘要；完成等待仍为整页稳定（判断与v6准入条件见报告） | [记录](2026-11-06_m5-context-diff-report.md) | 限定回归1865/1865（113文件，不与1952混比）；未真机，生产已变，v5 19/20不覆盖本版 |
| M5.1a Jev连续搜索 / J1、J2、J3.1、J3.2a、J5.1–J5.2 | **已集成、离线验证**：统一完成、可信未派发 stale、声明等待、封闭语义与反馈；当前 search-v9 保留聚焦、IME、有界目标查找及初始同窗口 Back，轨迹和实际主 Agent 投影绑定声明与验证历史 | [返回实现](2026-11-07_jev-j32-back-implementation.md) / [契约](2026-11-07_jev-j32-back-contract.md)；[多屏实现](2026-11-07_jev-multiscroll-implementation.md)；[J3.1 首批](2026-11-07_jev-j31-implementation.md)；[J2](2026-11-07_jev-j2-implementation.md)；[J5.2](2026-11-07_jev-j52-implementation.md)；[路线图](2026-11-07_jev-loop-roadmap.md) | Back 仅预声明非编辑面板且为首个写动作，不补偿错误入口；多屏须稳定唯一锚点，ScrollUntil仍单次；IME须唯一输入/焦点及读回。共享原预算。此类型化分支的其它导航、多部分目标/其它字段类型、外包键盘树及真实联合准入未做（J5.3 合成夹具回放已补，不等于生产轨迹回放）；viewer仍取消原任务，无跨调用恢复 |
| M5.1a 第二意图 / J3.3a | **已集成、离线验证**：单个声明应用内布尔开关，原始 checked 证明、稳定初态、已满足零写、最多一次 Tap 和独立读回；toggle-v1，主 Agent/Handoff 与轨迹已接通 | [本批实现](2026-11-07_jev-j33-toggle-implementation.md) / [冻结契约](2026-11-07_jev-j33-toggle-contract.md)；[专项](../../tests/android-jev-toggle.test.js) | 仅同包前台同窗口 display0，拒绝缺失 checked、隐藏重复与不安全目标；无导航、补偿、多目标或持久化保证。未知写不重试；真实模型与真机未验收，calibrated:false |
| M5.1a 类型化多字段 / J4a | **已集成、离线验证**：声明 origin/destination 双字段路线表单，宿主参数绑定、正确预填跳过、逐字段 RPC 与稳定原始树双重读回、提交前全量复核；route-v1，轨迹与实际主 Agent/Handoff 已接通 | [本批实现](2026-11-07_jev-j4-route-implementation.md) / [冻结契约](2026-11-07_jev-j4-route-contract.md)；[专项](../../tests/android-jev-route.test.js) | 仅同包前台同窗口 display0、声明 form；最多每字段一次 Fill 和一次 Tap。已验证值丢失硬停，unknown 不重放；不支持任意表单、导航或路线内容验证，calibrated:false，真实联合准入未做 |
| J0.2 正式批次工具 | **已实现、离线验证**：双集预冻结、逐臂执行、逐写独立审计、不可重放中断、身份漂移停批、精确置信界和任务族限定报告 | [工具与用法](2026-11-08_j02-batch-tool-report.md)；[入口](../../scripts/android-j02-batch.cjs)；[清单 schema](j02/batch-manifest.schema.json) | 未跑真机批次；原 Jev checkout、真实独立任务集、App数据状态和逐写外部证据仍须准备，生产策略保持 calibrated:false |
| 无模型正式设备套件 | **已集成、离线及 MuMu 隔离验证**：参数化设备/批次、安装/APK/RPC身份核验、确定性决策、独立检查器、固定预算与源码漂移检查；复用原 m5/m15 runner | [用法](../../scripts/android-device-suite/README.md)；[入口](../../scripts/verify-android-device-suite.cjs)；[本轮报告](2026-11-08_android-no-model-suite-report.md) | 工程能力证据，非 J0.2 真实校准；selected 任务仍 unverified；触摸取消使用外部 DOWN/CANCEL，不能外推在途生产长按取消；原生 LONG_CLICK 未覆盖；RPC 被杀及soak由下方独立批次限定验证 |
| AndroidWorld / AndroidLab | **执行适配已集成、离线验证**：物化参数、冻结绑定、持久生命周期桥、独立检查与原版评分分列，复用 RunTask 与审计报告 | [适配报告](2026-11-08_public-benchmark-adapter-report.md)；[冻结契约](2026-11-08_public-benchmark-adapter-contract.md)；[绑定入口](../../scripts/android-j02/benchmark-adapter.cjs) | 仅单 App 适配探索；World 原生依赖/环境联调未完成；缺匹配模拟器、初始资产、真实检查器及原 Jev 基线。contacts_2 提示/检查器冲突，map_1 缺答案与裁判通道。未运行设备或模型，calibrated:false |
| 通用任务循环 / J0.2 工程探索 | **v20 已集成、离线及 MuMu 隔离验证**：原始树精确selector完成目标/加载/输入绑定；跨页声明字段已验证值丢失即停；多页/多App/长流程及容量边界离线覆盖；保留显式一次主 Agent/Handoff | [MuMu 能力对照](2026-11-08_jev-capability-mumu-report.md)；[v20 离线报告](2026-11-08_jev-ui-task-offline-v20.md)；[冻结协议](2026-11-08_jev-ui-task-protocol-v20.md)；[v18 真实历史](2026-11-07_jev-ui-task-implementation.md) | MuMu 使用确定性提供器和隔离靶场；当前版本未跑真实 App/真实模型，v18/r21 指定 Legado 工作负载成功不继承。无独立真实逐写风险审计，acceptanceSamples=0、calibrated:false；无检查器只返回 unverified，不能外推其它 App 或长稳 |
| J5.3 统一夹具回放 | **离线验证**：search/toggle/route/ui_task 共 37 例，统一解释器走生产 Service 链路，逐条比对设备写、世界终态、回执、调用计数与隐私；19 例反事实对照 | [v20 扩展](2026-11-08_jev-ui-task-offline-v20.md)；[历史首批](2026-11-07_jev-j53-replay-implementation.md) / [冻结契约](2026-11-07_jev-j53-replay-contract.md)；[入口](../../tests/android-jev-replay.test.js) | 手写合成世界，不从生产脱敏轨迹重建 UI；固定回答不证明模型质量，不替代各族边界专项；通用模型可接收声明文字，持久轨迹仍不记录原文 |
| 独立显示窗口（与 M5 并行） | **已集成、离线及真实 Electron 宿主验证**：应用入口、主题、安全单实例、就绪错误重试、独立订阅生命周期、画质热应用与横竖屏比例贴合 | [窗口实现](../../modules/services/androidDisplayWindow.js)；[宿主测试](../../scripts/test-android-display-electron.cjs)；[画质与布局记录](2026-11-05_android-display-quality-report.md) | 使用替身设备验证真实 HTTP/Cookie/WS/PNG 和 ASAR 载体；H.264 编码器替身，无真机参数效果/完整安装包验收；窗口历史证据不替代新增M4.1接管验收 |

### 关键数字（只在这里维护）

| 指标 | 数值 | 取数日期 | 备注 |
| --- | --- | --- | --- |
| 未知触摸恢复：MuMu 故障批次 | **4/4 pass，exit 0** | 2026-11-08 | 在途取消、延迟/丢失回执、强杀；每项仅一次原写，旧owner消失后仍隔离，独立宿主再次阻断；同设备实例重启后生产恢复并完成新长按。无外部CANCEL，源码/APK一致，0模型请求。强杀仍复现DOWN未释放，证明不能仅凭owner退出恢复。[结果](../../artifacts/android-input-recovery-device-2026-11-08-r4/result.json)、[事件](../../artifacts/android-input-recovery-device-2026-11-08-r4/events.jsonl)。r1为中间源码通过；r2/r3各首项ADB重启超时失败、余3项未跑，保持原失败，新批预选MuMu实例重启，原两分钟截止不变 |
| 未知触摸恢复：最终离线回归 | **860/860 pass，0 fail/cancel/skip，exit 0** | 2026-11-08 | 45文件；持久隔离、错误设备/同次启动拒绝、存储错误、别名/降级绕过反例、原双击截止、Service重启及通用任务回归；源码/工具/测试摘要一致。[选择集](../../artifacts/android-input-recovery-offline-2026-11-08-r4/selection.json)、[结果](../../artifacts/android-input-recovery-offline-2026-11-08-r4/result.json)、[日志](../../artifacts/android-input-recovery-offline-2026-11-08-r4/tests.log)。r1旧断言与边界反例失败保留；r2虽测试通过但源码漂移，wrapper exit1，不作最终证据 |
| 未知触摸恢复：正常动作回归 | **14/14 pass，0 fail/notExecuted，exit 0** | 2026-11-08 | 长按、双击、语义/坐标拖动、双向缩放、IME、组合键、删除、host/RPC滚动及历史；源码/APK和观察包装摘要一致，557次同步命令退出均0，最长3420ms；全部测试批共享96项生产身份。[结果](../../artifacts/android-input-recovery-m15-2026-11-08-r2/result.json)、[汇总](../../artifacts/android-input-recovery-2026-11-08/result.json)、[证据摘要](../../artifacts/android-input-recovery-2026-11-08/evidence-sha256.json)、[完整台账](../../artifacts/android-input-recovery-2026-11-08/batch-ledger.json)。首批1通过、1准备后ADB读取失败、12未跑，根因未确认；新批未改生产、任务或截止，未重放未知动作；仍不代表长期稳定性 |
| 历史 MuMu RPC 故障注入（修复前） | **4/4 pass，exit 0** | 2026-11-08 | 真实在途取消、回执延迟/丢弃、核验身份后强杀；unknown不重放、隔离保持、显式恢复及旧进程/监听/转发消失。强杀后触摸仍按下，工具仅在原owner消失后对固定靶场外部CANCEL，当时未改生产恢复。[结果](../../artifacts/android-resilience-faults-2026-11-08-r3/result.json)、[事件](../../artifacts/android-resilience-faults-2026-11-08-r3/events.jsonl)、[方法和边界](2026-11-08_android-resilience-report.md)。r1工具同步轮询失败、r2缺触摸清理及后续soak-r1失败均保留 |
| 历史 RPC 故障工具离线回归 | **535/535 pass，0 fail/cancel/skip，exit 0** | 2026-11-08 | 31文件；真实loopback断流/迟到回执、异步读取退出139拒绝、监听残留/进程身份反例；当批测试及生产/工具源码前后摘要一致。无模型或设备请求。[选择集](../../artifacts/android-resilience-offline-2026-11-08/selection.json)、[结果](../../artifacts/android-resilience-offline-2026-11-08/result.json)、[日志](../../artifacts/android-resilience-offline-2026-11-08/tests.log) |
| 历史 MuMu 固定时长持续运行（修复前） | **30分钟、120/120轮，exit 0** | 2026-11-08 | 实测1800001ms；每10轮完整重建，12个采样owner、含末次只采树owner共13次独立退出证明，最终转发无新增残留；0重复/短按/取消，触摸802–826ms。含检查/重建的整轮p50/p95为3866/5442ms；RSS峰值87.15MiB、GC后heap峰值15.04MiB、末轮heap较首轮增0.83MiB；线程17–18、fd恒64，均满足冻结门槛。当批源码/APK一致，0模型请求、calibrated:false；不继承至新增持久化版本。首批强杀残留失败保留，显式靶场CANCEL后新开r2。[汇总](../../artifacts/android-resilience-2026-11-08/result.json)、[证据摘要](../../artifacts/android-resilience-2026-11-08/evidence-sha256.json)、[结果](../../artifacts/android-resilience-soak-2026-11-08-r2/result.json)、[原失败](../../artifacts/android-resilience-soak-2026-11-08-r1/result.json) |
| 无模型正式套件：MuMu 最终设备批次 | 扩展矩阵 **17/17**；旧动作 **14/14**；搜索/安全停止 **8/8**，全部 exit 0 | 2026-11-08 | 新APK、最终工具版本各批源码/APK身份一致；确定性提供器38次、真实模型请求0、独立真实样本0。长按请求800/2000/4000ms，事件实测813/2004/4020ms，uptime实测802/2001/4001ms；每次一个DOWN/UP、无CANCEL。首次17项全通过后补工具准备/清理，在新批再次完整执行；两批均保留。[汇总](../../artifacts/android-no-model-suite-2026-11-08/result.json)、[通用矩阵](../../artifacts/android-no-model-suite-2026-11-08/journeys-r2/result.json)、[动作](../../artifacts/android-no-model-suite-2026-11-08/m15-r1/result.json)、[搜索](../../artifacts/android-no-model-suite-2026-11-08/m5-r1/result.json) |
| 无模型正式套件最终离线回归 | **444/444 pass，0 fail/cancel/skip**，exit 0 | 2026-11-08 | 24文件，137项源码/测试摘要前后一致；10项检查器/runner测试含非零ADB退出、APK/RPC不匹配、提前抬起、取消误计、瞬态完成反例；首次UUID测试8/9失败保留，修正测试身份后通过。[结果](../../artifacts/android-no-model-suite-2026-11-08/final-offline/result.json)、[日志](../../artifacts/android-no-model-suite-2026-11-08/final-offline/tests.log)、[源码身份](../../artifacts/android-no-model-suite-2026-11-08/final-offline/source-before.json)、[构建源码比对](../../artifacts/android-no-model-suite-2026-11-08/build-source-verification.json)。不与历史434等分母相加 |
| jev-android 能力对照：MuMu 设备验证 | 搜索/安全停止 **8/8**；手势/键盘/滚动/历史 **14/14**；通用循环 **4/4**，各进程 exit 0 | 2026-11-08 | MuMu Android 15/API35、x86_64、display0、横屏隔离靶场；确定性决策12次，真实模型请求0，独立真实准入样本0，calibrated:false。[总证据](../../artifacts/android-jev-capability-check-2026-11-08/result.json)、[搜索](../../artifacts/android-jev-capability-check-2026-11-08/m5-r3/suite.log)、[动作](../../artifacts/android-jev-capability-check-2026-11-08/m15-r3/suite.log)、[通用循环](../../artifacts/android-jev-capability-check-2026-11-08/ui-task-r2/result.json)、[方法与限制](2026-11-08_jev-capability-mumu-report.md)。旧动作批11/14、旧通用批2/3且1未跑及准备阶段失败均保留；不覆盖实际按住时长、原生LONG_CLICK、selected专项或真实服务被杀 |
| MuMu 修复后限定离线回归 | **434/434 pass，0 fail/cancel/skip**，exit 0 | 2026-11-08 | 23文件；新增横屏自然/逻辑尺寸反例及历史失败隔离断言；[结果](../../artifacts/android-jev-capability-check-2026-11-08/fix-regression/result.json)、[日志](../../artifacts/android-jev-capability-check-2026-11-08/fix-regression/tests.log)、[源码摘要](../../artifacts/android-jev-capability-check-2026-11-08/fix-regression/source-before.json)。初始333项、修复专项95项为不同选择集，不相加；新增反例旧实现失败保留，最终测试前后及后续设备批生产源码摘要一致 |
| 公开基准目录及首批准备 | AndroidWorld **116项，首批7项**；AndroidLab **138项，首批6项**；共13项均 **not_run**，设备/模型执行0次 | 2026-11-08 | 固定源码全量登记；[AndroidWorld预检](../../artifacts/android-public-benchmarks-2026-11-08/androidworld/preflight.json)、[AndroidLab预检](../../artifacts/android-public-benchmarks-2026-11-08/androidlab/preflight.json)。AndroidLab 40项评分器引用答案裁判调用链；评分主入口含独立探针，未执行 |
| 公开基准准备工具离线回归 | **62/62 pass**：Node 55、Python 7，exit 0 | 2026-11-08 | 包含原J0.2冻结/审计/统计/worker回归；[验证摘要](../../artifacts/android-public-benchmarks-2026-11-08/verification.json)、[Node日志](../../artifacts/android-public-benchmarks-2026-11-08/node-tests.log)、[Python日志](../../artifacts/android-public-benchmarks-2026-11-08/python-tests.log)。仅准备与静态解析，不是公开基准模型成绩 |
| 公开基准适配范围 | AndroidWorld **7项生命周期接口**；AndroidLab **4项确定性评分**，另 **2项阻塞**；真实任务执行仍 **0次** | 2026-11-08 | World 接口经生命周期替身验证，未跑真实原生环境；Lab 原版确定性评分器与 XML 压缩器离线执行。参数物化、支持范围及环境缺口见[就绪记录](../../artifacts/android-public-adapter-2026-11-08/readiness.json)，不作为模型成绩或独立样本 |
| 公开基准适配与批次回归 | **102/102 pass**：Node 83、Python 19，exit 0，0 skip | 2026-11-08 | [验证摘要](../../artifacts/android-public-adapter-2026-11-08/verification.json)、[Node日志](../../artifacts/android-public-adapter-2026-11-08/node-tests.log)、[原版评分及生命周期测试](../../artifacts/android-public-adapter-2026-11-08/python-native-tests.log)、[导入器测试](../../artifacts/android-public-adapter-2026-11-08/python-extract-tests.log)。首次 unittest discovery 识别0项，已保留错误记录并按文件直接执行；包含取消后评分异常不覆盖任务结果的复核；未请求真实模型或设备 |
| 通用循环 v20 最终离线回归 | **3106/3106 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-08 | VCPChat 3016/3016（184文件，文件并发4）；VCPToolBox 90/90（4文件）。最终执行源及测试前后314项摘要一致；[汇总](../../artifacts/android-ui-task-offline-v20-2026-11-08/final-audit.json)、[选择集](../../artifacts/android-ui-task-offline-v20-2026-11-08/selection.json)、[主仓日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/vcpchat-final-regression.log)、[上游日志](../../artifacts/android-ui-task-offline-v20-2026-11-08/toolbox-final-regression.log)、[身份核验](../../artifacts/android-ui-task-offline-v20-2026-11-08/identity-audit.json)。长流程初次7/8暴露返回后重填问题；容量初次4/7为夹具计数/usage错误；另保留非法ID接受反例，均已修复。无真机/真实模型请求 |
| 通用循环 v19 历史离线回归 | **3062/3062 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 2972/2972（181文件，文件并发4）；VCPToolBox 90/90（4文件）。执行源及测试前后307项摘要一致；[选择集](../../artifacts/android-ui-task-offline-v19-2026-11-07/selection.json)、[主仓日志](../../artifacts/android-ui-task-offline-v19-2026-11-07/vcpchat-regression-concurrency4.log)、[上游日志](../../artifacts/android-ui-task-offline-v19-2026-11-07/toolbox-regression.log)、[身份核验](../../artifacts/android-ui-task-offline-v19-2026-11-07/identity-audit.json)。初次不限并发2971/2972，1项3秒调度保护失败保留；复跑未修改源码/断言。无真机/真实模型请求 |
| v19 viewer 专项 | **54/54 pass，exit 0** | 2026-11-07 | 原7项旧定时器断言已收口，并增加迟到设备响应不能重连/卸载后不能复活轮询的回归；[日志](../../artifacts/android-ui-task-offline-v19-2026-11-07/viewer-focused.log) |
| 通用循环 v18 历史专项 | **60/60 pass，exit 0，0 fail/cancel/skip** | 2026-11-07 | 5文件；[日志](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-v18-tests.log)；本批之后已升级为v19 |
| 通用循环 v16 历史回归 | **2899/2906 pass，7 fail，exit 1** | 2026-11-07 | 175文件；viewer设备轮询导致旧零定时器断言失败。历史失败保留，本批修复见v19行；[选择集](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-v16-regression-selection.json)、[日志](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-v16-regression.log) |
| 通用循环 v18 真实探索 r21 | **1/1 联合通过，exit 0；非准入样本** | 2026-11-07 | PJZ110/Android17/Legado3.25；3动作、4 Jev、53观察、10段宿主等待、0模型wait、0主Agent/Handoff/stale；任务70.765秒，含准备/独立检查85.915秒；四次HTTP200，jev-latest→jev-1.14.0；Done=0.93，原0.90/0.20门槛不变。103项身份只与当时v18工作区核对一致，不覆盖当前v20；[核验](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-final-verification.json)、[历史批次台账](../../artifacts/android-j02-request-fix-2026-11-07/ui-task-batch-ledger.json) |
| J5.3 回放跨仓限定回归 | **1105/1105 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 944/944（35文件=J4a 选择集+回放入口，131s）；VCPToolBox 161/161（7文件）；回放专项 36/36；首轮 exit 1 为解释器环境/期望错误，日志保留；[选择集](../../artifacts/android-jev-j53-replay-2026-11-07/final-selection.json)、[证据](../../artifacts/android-jev-j53-replay-2026-11-07/evidence.json)；运行于并行维护性整改之后的生产代码，回归后生产哈希零差异；无真实上游/真机请求 |
| J4a 路线跨仓限定回归 | **1056/1056 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 895/895（34文件，140.522s）；VCPToolBox 161/161（7文件，2.069s）；文件并发4；[选择集与身份](../../artifacts/android-jev-j4-route-2026-11-07/final-selection.json)、[结果](../../artifacts/android-jev-j4-route-2026-11-07/final-result.json)、[完整性核验](../../artifacts/android-jev-j4-route-2026-11-07/final-audit.json)、[实现记录](2026-11-07_jev-j4-route-implementation.md)；前后145文件摘要一致；新增专项144项（Service 81、轨迹30、上游33）；路线容量240163字节/356事件，4096字节终止预留；首轮旧搜索截止断言失败与单独复测保留，未放宽生产等待器或断言；无真实上游/真机请求 |
| J4a 旧搜索/开关固定回答对照 | **816组搜索准入、12普通搜索场景、7种单次动作及7个开关场景一致** | 2026-11-07 | [明细](../../artifacts/android-jev-j4-route-2026-11-07/comparison.json)、[退出码](../../artifacts/android-jev-j4-route-2026-11-07/comparison-result.json)，exit 0；改前/后search-v8普通场景各独立成功8/12、停止4/12、派发24次，故意错误高置信误派发1/24后停止；Jev各33次、主Agent各1次、人工各1次；请求总字节51639、单次最大1776。开关含true/false/已满足/stale/主Agent/人工/unknown，比较动作、状态、预算与回执；共用当前Service/task-port，不代表整仓旧版或模型质量校准 |
| J3.3a 开关跨仓限定回归 | **912/912 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 784/784（32文件，70.542s）；VCPToolBox 128/128（6文件，0.424s）；[选择集与身份](../../artifacts/android-jev-j33-toggle-2026-11-07/final-selection.json)、[结果](../../artifacts/android-jev-j33-toggle-2026-11-07/final-result.json)、[本批记录](2026-11-07_jev-j33-toggle-implementation.md)；前后130文件摘要一致；新增专项109项（Service 60、轨迹22、上游27）；搜索容量375383字节/401事件，开关容量349494字节/338事件，均保留4096字节终止预留；无真实上游/真机请求 |
| J3.3a 旧搜索固定回答对照 | **816组准入一致；12普通场景及7种单次动作路径行为一致** | 2026-11-07 | [明细](../../artifacts/android-jev-j33-toggle-2026-11-07/comparison.json)、[实际退出码](../../artifacts/android-jev-j33-toggle-2026-11-07/comparison-result.json)，exit 0；改前/后search-v8普通场景各独立成功8/12、停止4/12、派发24次、故意错误高置信误派发1/24后停止；各Jev 33次、主Agent 1次、人工1次，请求总字节51639、单次最大1776；单次路径含Back，不混入普通场景分母，不代表模型质量校准 |
| J3.2a 同窗口返回跨仓限定回归 | **803/803 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 702/702（30文件，70.194s）；VCPToolBox 101/101（5文件，0.468s）；[选择集与身份](../../artifacts/android-jev-j32-back-2026-11-07/final-selection.json)、[结果](../../artifacts/android-jev-j32-back-2026-11-07/final-result.json)、[本批记录](2026-11-07_jev-j32-back-implementation.md)；前后119文件摘要一致；容量375383字节/401事件，终止预留4096字节；Back专项37项；错误入口补偿反例与旧验证截止断言失败保留，未改生产等待器；仅离线替身 |
| J3.2a 固定回答对照 | **816组准入等价；12个普通场景及5种单次动作路径行为一致** | 2026-11-07 | [明细](../../artifacts/android-jev-j32-back-2026-11-07/comparison.json)、[退出码](../../artifacts/android-jev-j32-back-2026-11-07/comparison-result.json)，exit 0；search-v7/v8 普通场景各独立成功8/12、停止4/12、派发24次、故意错误高置信误派发1/24后停止；各Jev 33次、主Agent 1次、人工1次；请求总字节各51639、最大各1776；单次动作另比状态/动作/预算/回执，不衡量真实模型质量 |
| J3.1 多屏查找跨仓限定回归 | **765/765 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 665/665（29文件，71.606s）；VCPToolBox 100/100（5文件，0.805s）；[选择集与身份](../../artifacts/android-jev-j31-multiscroll-2026-11-07/final-selection.json)、[结果](../../artifacts/android-jev-j31-multiscroll-2026-11-07/final-result.json)、[本批记录](2026-11-07_jev-multiscroll-implementation.md)；前后115文件摘要一致；容量374030字节/401事件，终止预留4096字节；多屏专项23项；仅离线替身，无真实上游或真机请求 |
| J3.1 多屏续批固定回答对照 | **816组准入等价；12个普通场景及5种单次动作路径行为一致** | 2026-11-07 | [明细](../../artifacts/android-jev-j31-multiscroll-2026-11-07/comparison.json)、[实际退出码](../../artifacts/android-jev-j31-multiscroll-2026-11-07/comparison-result.json)，exit 0；search-v6/v7 普通场景各独立成功8/12、停止4/12、派发24次、故意错误高置信误派发1/24后停止；各 Jev 33次、主 Agent 1次、人工1次；请求总字节各51639、单次最大各1776；单次动作另比状态/动作/预算/回执，不与普通场景总数混算；不衡量真实模型质量 |
| J3.1 首批跨仓限定回归 | **741/741 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 642/642（28文件，70.037s）；VCPToolBox 99/99（5文件，0.504s）；[选择集与身份](../../artifacts/android-jev-j31-2026-11-07/final-selection.json)、[结果](../../artifacts/android-jev-j31-2026-11-07/final-result.json)、[本批记录](2026-11-07_jev-j31-implementation.md)；前后112文件摘要一致；容量370136字节/401事件，终止预留4096字节；新增动作专项38项；包含底层键盘/滚动原有契约；无真实上游或真机请求 |
| J3.1 普通搜索固定回答对照 | **816组准入等价；12场景动作、结果、调用次数及请求字节一致** | 2026-11-07 | [明细](../../artifacts/android-jev-j31-2026-11-07/comparison.json)、[最终日志](../../artifacts/android-jev-j31-2026-11-07/comparison-final.log)，exit 0；search-v5/v6 各独立成功8/12、停止4/12、派发24次、故意错误高置信误派发1/24后停止；各 Jev 33次、主 Agent 1次、人工1次；`{state,questions}` 总字节各51639、单次最大各1776；仅未声明新动作的固定替身场景，不衡量真实模型质量 |
| J2 跨仓限定回归 | **514/514 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 416/416（24文件，69.253s）；VCPToolBox 98/98（5文件，0.361s）；[选择集与身份](../../artifacts/android-jev-j2-2026-11-07/final-selection.json)、[结果](../../artifacts/android-jev-j2-2026-11-07/final-result.json)、[本批记录](2026-11-07_jev-j2-implementation.md)；前后106文件摘要一致；容量349106字节/401事件，终止预留4096字节；仅离线替身，无真实上游或真机请求 |
| J2 固定回答离线对照 | **816组词表准入等价；12场景控制行为一致** | 2026-11-07 | [对照明细](../../artifacts/android-jev-j2-2026-11-07/comparison.json)、[最终日志](../../artifacts/android-jev-j2-2026-11-07/comparison-r3.log)，exit 0；search-v4/v5 各独立成功8/12、停止4/12、派发24次、故意错误高置信场景误派发1/24后停止；各 Jev 33次、主 Agent 1次、人工1次；`{state,questions}` 总字节24351→51639、单次最大925→1776；不含供应商外层/token/费用，不代表真实模型质量提升 |
| J5.2 跨仓限定回归 | **493/493 pass，0 fail/cancel/skip**；两仓 exit 0 | 2026-11-07 | VCPChat 396/396（23文件，69.281s）；VCPToolBox 97/97（5文件，0.574s）；[选择集与身份](../../artifacts/android-jev-j52-2026-11-07/final-selection.json)、[结果](../../artifacts/android-jev-j52-2026-11-07/final-result.json)、[本批记录](2026-11-07_jev-j52-implementation.md)；前后103文件摘要一致；容量303591字节/401事件，终止预留4096字节；仅离线替身，无真实上游或真机请求 |
| J1.3/J5.1限定回归 | **306/306 pass，0 fail/cancel/skip**，exit 0，69.023s | 2026-11-07 | 16文件；35项新增等待/升级用例；[日志](../../artifacts/android-jev-j13-j51-2026-11-07/final-tests.log)、[选择集与身份](../../artifacts/android-jev-j13-j51-2026-11-07/final-selection.json)、[本批记录](2026-11-07_jev-wait-escalation.md)；运行前后77文件摘要一致；保守容量夹具302017字节/399事件，512KiB上限和4096字节终止预留不变；无上游请求/真机，非全仓与真实模型校准 |
| J0.1/J5.3/J1.2续批限定回归 | **271/271 pass，0 fail/cancel/skip**，exit 0，69.088s | 2026-11-07 | 15文件；新增模型证据、最大预算容量和stale恢复边界；[最终日志](../../artifacts/android-jev-j12-2026-11-07/final-tests.log)、[选择集](../../artifacts/android-jev-j12-2026-11-07/final-selection.json)、[续批记录](2026-11-07_jev-evidence-recovery.md)；最大预算夹具269038字节/394事件，512KiB上限和4096字节终止预留不变；无上游请求/真机，不代表校准或完整J系列准入 |
| J系列首批完成契约限定回归 | **240/240 pass，0 fail/cancel/skip**，exit 0，69.407s | 2026-11-07 | 13文件，含22项新增完成契约/窗口/轨迹用例；rules/shadow/jev真实Service路径、替身XML/模型及独立虚拟时钟；[最终日志](../../artifacts/android-jev-j1-2026-11-07/focused-final.log)、[选择集](../../artifacts/android-jev-j1-2026-11-07/test-selection.json)、[首批记录](2026-11-07_jev-j1-completion.md)；非全仓、无上游请求/真机，不代表J0完整或Jev校准 |
| M4.1首批接管限定回归 | **2113/2113 pass，0 fail/cancel/skip**，exit 0，77.989s | 2026-11-06 | 128测试文件：Android/ADB/scrcpy/UI graph/GlobalJev/jev-client/分布式取消；[日志](../../artifacts/android-takeover-2026-11-06/regression-accepted.log)，[选择集与内容摘要](../../artifacts/android-takeover-2026-11-06/after.json)；非全仓、非真机；并行UI变更原样保留 |
| M4.1隔离浏览器 | **通过**：同源真实HTTP/WS/Sharp截图→开始→点击→返回→刷新→结束→reload仍只读；fixture点击/按键/批准各1次 | 2026-11-06 | [截图](../../artifacts/android-takeover-2026-11-06/browser-takeover.png)；设备传输与原生批准为替身，不代表真实Electron dialog/手机通过；[记录](2026-11-06_android-m4-takeover.md) |
| M4专项离线核查 | **319 tests / 319 pass / 0 fail**，exit 0，4.098s | 2026-11-05 | 17个测试文件；mock/harness，不含真实对话框、双设备或虚拟屏；[日志](../../artifacts/android-m4-research-2026-11-05/offline-tests.log) |
| 本轮限定 Android+宿主接缝离线回归 | **1845 tests / 1845 pass / 0 fail**，exit 0，11.159s | 2026-11-05 M5 首批 | 无取消/跳过；Android/ADB/scrcpy/frame/Jev/分布式取消与两套CLI；非全仓测试，不与历史1925分母混比；[日志](../../artifacts/android-m5-2026-11-05/offline-final.log) |
| 独立窗口接入后限定 Android+宿主接缝离线回归 | **1967 tests / 1967 pass / 0 fail**，exit 0，16.802s | 2026-11-05 | 无取消/跳过；命令覆盖含新增窗口/目录/展示/启动权限及既有 Android/ADB/流/Jev/分布式测试，不与先前1845分母混比；[日志](../../artifacts/android-display-window/regression.log) |
| 独立窗口真实 Electron 宿主 | PASSED；3 个载体真实 ASAR 解包路径通过 | 2026-11-05 | 隔离 profile、替身设备、错误重试/明暗/窄窗/真实WS PNG/关窗保活/重开；[结果](../../artifacts/android-display-window/electron-result.json)；非真机准入 |
| 画质与比例贴合专项回归 | **172 tests / 172 pass / 0 fail**，exit 0，3.485s | 2026-11-05 | 12 个测试文件，无取消/跳过；涵盖窗口、展示、目录、配置、生命周期、鉴权、scrcpy 解析/就绪；[日志](../../artifacts/android-display-quality/tests.log)，不替代上列限定 Android 全集历史批次 |
| 画质与比例贴合真实 Electron | PASSED，exit 0；竖屏区域 360×720.219，横屏 1534×767.406 | 2026-11-05 | 明暗主题、无设备配置保存、真实 POST 失败回退、原生 IPC、工具栏换行重测、手动缩放保留、方向切换、关窗保活；[结果](../../artifacts/android-display-quality/electron-result.json)，替身编码器不代表真机 H.264 参数成功 |
| M1 真机 | 6/6 | 2026-11-03 | PJZ110 / Android 17 |
| M1.5 真机 | **14/14** | 2026-11-05 晚间 | `DoubleTap` 单独复跑 3 次连续通过（连首轮共 4 次）；`ScrollUntilHost` 已通过 |
| M2 真机 | 14/14 | 2026-11-05 | 无 case 重试，正常 cleanup |
| 旋转真机（2026-11-05 夜间） | **8/8** | 2026-11-05 | context/epoch 前进、旧 index/frame 失效、转回后仍失效 |
| M5 受限搜索真机 | **8/8**（靶场）；Legado 真实应用 3/5 完成，2 次过渡期安全停止 | 2026-11-05 夜间（靶场）；Legado 试跑为 2026-11-06 | 2 成功 + 6 停止边界（歧义/密码/完成预存/只读策略/观察预算/预取消），无 case 重试，模型调用 0，7 份轨迹无输入泄露；[日志](../../artifacts/android-m5-device-2026-11-05/run5.log) |
| M5 稳定性续接离线 | **1952/1952**，exit 0，0取消/跳过，75.210s | 2026-11-06 | 119文件的限定Android+宿主接缝；[选择集](../../artifacts/android-m5-continuation-2026-11-06/offline-files.txt)、[日志](../../artifacts/android-m5-continuation-2026-11-06/offline-final.log)；非全仓回归 |
| M5 稳定性续接真机 | 原靶场 **8/8**，exit 0；Legado固定20次 **13/20独立通过、7证据不可用、0未执行**，exit 1 | 2026-11-06 | 任务端20/20 completed不替代独立验收；0模型调用/额外动作尝试，20份轨迹无查询泄露，47源文件身份不变；[完整记录](2026-11-06_m5-stability-report.md) |
| M5 独立采集复验 | **19/20联合通过、1失败、0未执行**，exit 1；专项 **21/21**，exit 0 | 2026-11-06 | v5任务端19/20、独立匹配20/20；1次内部树重采，0额外动作/模型调用，51文件哈希不变；历史v3为15/20；[完整诊断](2026-11-06_m5-independent-verification-report.md) |
| owner 专项离线回归 | **110/110**，exit 0 | 2026-11-05 | 6 文件，转发失效/归属、并发停止、隔离与重绑；[日志](../../artifacts/android-owner-rebind-2026-11-05/focused-tests.log) |
| owner 修复后 Android 文件集回归 | **1728/1728**，exit 0，0取消/跳过 | 2026-11-05 | `tests/android-*.test.js` 与 `.mjs`；不含 ADB/scrcpy 等其它前缀，不能与历史1967分母混比；[日志](../../artifacts/android-owner-rebind-2026-11-05/android-regression.log) |
| owner 生命周期真机专项 | **8/8**，exit 0 | 2026-11-05 | 正常续约、转发丢失、无线ADB重连、停止续约30.861秒退出、错误nonce拒绝、主机终止、CLI与新owner采树；零残留测试转发；[结果](../../artifacts/android-owner-rebind-2026-11-05/device-result.json) |
| Jev连续搜索专项离线 | **103/103**，exit 0，0取消/跳过 | 2026-11-06 | 6文件：候选/真实Service路径/轨迹/运行时/序列/全局Jev适配；注入模型回答，无上游请求；[日志](../../artifacts/android-jev-loop-2026-11-06/focused.log) |
| Jev循环限定回归 | **1778/1778**，exit 0，0取消/跳过 | 2026-11-06 | Android前缀 + GlobalJevService/jev-client/分布式取消；不含其它前缀的ADB/scrcpy全集，不与历史分母混比；[日志](../../artifacts/android-jev-loop-2026-11-06/regression.log) |
| 历史真机对应生产代码摘要 | `b6f1689e4adfbdca7ead8c083a7a5a2108a773b2b3dd624502b4a8eed1f7f45c` | 2026-11-05 先前批次 | M5本轮生产已变，不再代表当前代码；当前快照见[首批清单](../../artifacts/android-m5-2026-11-05/evidence.json) |

此前真机矩阵原始日志、退出码与清单：[artifacts/android-accept-2026-11-05](../../artifacts/android-accept-2026-11-05/)，旋转轮在 [artifacts/android-rotation-2026-11-05](../../artifacts/android-rotation-2026-11-05/)；离线批次仍在 [artifacts/android-no-ocr-2026-11-05](../../artifacts/android-no-ocr-2026-11-05/)。这些真机批次未改生产；随后的M5批次已修改生产代码，不能把历史真机通过外推给本版。

旧真机证据对应生产摘要`94c26727ed8b8f3c2a37016f5b19f36223890189c7fd066d4b545cd5580c33e7`，见[历史产物](../../artifacts/android-pre-m3-2026-11-05/)。其旧evidence-manifest有一条报告路径/哈希因文档移动而失配（29/30），不声称整份清单完整有效；本轮产物另立清单。

### 环境准入欠账（不随上面任何「通过」消失）

跨 ROM 矩阵、当前版本旋转/锁屏/前台抢占/ADB断连与多 display、真实任务长稳、历史性能基线迁移仍待验证。MuMu未知触摸现已持久隔离并要求原设备重启后的显式证据恢复，不构成自动CANCEL或自动重启。修复前限定持续运行证据不继承至本版，也不代表「M3 前置全部完成」。下一批优先验证当前源码的环境变化与安全停止，公开评测仍需匹配环境。

---

## 2. 阻塞与已解除项

1. **M3 前的真机矩阵已补齐，仅限单 ROM 固定靶场**：M1.5 14/14、M2 14/14、结构/Collect 5/5、原生批准 4/4，均 exit 0。靶场模式是内存态，跨矩阵不自动复位（人工组会留下 `m2`，随后 M1.5 会以 `FIXTURE_STATE_INVALID` 停在 gate）；`ELECTRON_RUN_AS_NODE=1` 会让原生组在第一行崩掉。两条都记在[本轮验收](2026-11-05-device-acceptance.md)。
2. **owner 重绑缺口已修复并通过本机专项**：失效控制转发核验重建、认证续约与设备端超时自退出、停止时排干续约并独立证明消失；无线 ADB 重连后 RPC 与 CLI 均可恢复。历史旧版孤儿不自动清理，连接别名与跨 ROM 仍待验收。见[修复记录](2026-11-05_android-owner-rebind-report.md)。
3. **跨 ROM 未做**：需要第二台设备先采原始 `dumpsys`/`uiautomator` 格式，再按正向证据扩白名单；不用模拟器或猜想代替。
4. **M4.5 的 P0 探针**：PJZ110首轮已证明scrcpy建屏/启动/真实出图，但默认屏焦点丢失；overlay路线启动被系统拒绝。隔离判据未过，停止输入与后续矩阵，资源和物理屏均已恢复。详见[P0真机报告](2026-11-06_android-m4-p0-report.md)。同日以focus1候选修复焦点抢占（R2矩阵20/20），见[焦点修复报告](2026-11-06_android-m4-focus-report.md)；仍不是生产准入。

---

## 3. 文档地图

J0.2 当前入口：[通用循环冻结协议](2026-11-07_jev-ui-task-protocol.md)、[通用探索 schema](j02/ui-report.schema.json)、[v19 离线报告](2026-11-07_jev-ui-task-offline-v19.md)、[v18 历史真实结果](2026-11-07_jev-ui-task-implementation.md)。历史 [search-v8 校准协议](2026-11-07_jev-j02-search-protocol.md) 和[首次网关反馈更正](2026-11-07_jev-j02-search-exploration-report.md)保留；首次只有本地调用证据，后续真实批次已有 HTTP200 和返回模型身份，不能用后续结果改写旧批。正式独立验收及任一任务族 calibrated:true 均未完成。

| 文档 | 是什么 | 什么时候读 |
| --- | --- | --- |
| [android-controller-roadmap.md](android-controller-roadmap.md) | **路线图与契约**：阶段、判据、依赖顺序、明确不做、每阶段停止条件 | 要改设计或加阶段时 |
| [2026-11-05-rotation-acceptance.md](2026-11-05-rotation-acceptance.md) | **旋转验收**：靶场改造、8/8 矩阵、横屏半程与 owner 重绑诊断 | 复核旋转或方向切换时 |
| [2026-11-05-no-ocr-offline.md](2026-11-05-no-ocr-offline.md) | 本轮无OCR增量、复用边界与离线证据 | 准备本轮真机验证时 |
| [history.md](history.md) | **执行时间线**：某天跑了什么、红了什么、当时数字多少 | 要追「为什么这么改」时 |
| [android-pre-m3-gap-review.md](android-pre-m3-gap-review.md) | M3 前成熟实现对照审查，P1/P2 差距与落地顺序 | 决定 M3 之前先修什么时 |
| [android-controller-competitive-gap-2026-11.md](android-controller-competitive-gap-2026-11.md) | 与 u2 / Appium / Maestro / scrcpy / droidrun 的逐维对照（G1–G13、H1–H7） | 要判断「这算不算落后」时 |
| [android-virtual-display-feasibility.md](android-virtual-display-feasibility.md) | 后台虚拟屏可行性：外部事实、三条路线、探针命令与判据 | 做 M4.5 时 |
| [2026-11-05_android-m4-research.md](2026-11-05_android-m4-research.md) | M4源码调研、协议修正、接管状态机、跨设备与虚拟屏准入（历史快照） | 决定M4顺序或评估M5所有权时 |
| [2026-11-06_android-m4-takeover.md](2026-11-06_android-m4-takeover.md) | M4.1默认屏首批实现、排干/未知隔离/有限快照交互、离线和浏览器证据 | 使用接管或准备真实设备验收时 |
| [android-m2-device-validation.md](android-m2-device-validation.md) | M2 真机矩阵记录 | 复核 M2 结果时 |
| [android-m15-device-validation.md](android-m15-device-validation.md) | M1.5 真机矩阵记录 | 复核 M1.5 结果时 |
| [android-performance-baseline.md](android-performance-baseline.md) | Observe / 流性能基线与复采数字 | 谈性能时 |
| [android-p2-validation.md](android-p2-validation.md) | P2 阶段历史真机与 API 证据 | 追溯早期能力时 |
| [android-controller-code-review.md](android-controller-code-review.md) | 代码审查与有界重构记录（第一轮） | 查历史重构决策时 |
| [android-controller-maintainability-review.md](android-controller-maintainability-review.md) | 可维护性审查与第二轮架构收敛 | 查历史重构决策时 |
| [android-controller-route-review-2026-11.md](android-controller-route-review-2026-11.md) | A/B/C 三条设备后端路线复核 | 讨论要不要换后端时 |
| [android-system-adaptation.md](android-system-adaptation.md) | `System` 白名单与系统设置适配边界 | 改系统动作授权面时 |
| [2026-11-05_audit-android-pre-m3-report.md](2026-11-05_audit-android-pre-m3-report.md) | M3 前收口报告（2026-11-05 上午批次证据汇总；其保留失败当晚已收口） | 复核 2026-11-05 这一轮时 |
| [2026-11-05-device-acceptance.md](2026-11-05-device-acceptance.md) | **此前四组真机矩阵**、离线回归与两条工程问题 | 复核 2026-11-05 晚间真机轮结果时 |
| [2026-11-05-m5-first-slice.md](2026-11-05-m5-first-slice.md) | M5 首批搜索模板、所有权/轨迹、验证与复审边界 | 继续实现或准备M5真机准入时 |
| [2026-11-06_m5-context-diff-report.md](2026-11-06_m5-context-diff-report.md) | M5 上下文差异脱敏证据、完成等待范围判断与v6准入规则 | 恢复真机或决定完成等待策略时 |
| [2026-11-06_m5-stability-report.md](2026-11-06_m5-stability-report.md) | M5 有界稳定等待、原始结果条目证据、固定20次及独立核验缺口 | 继续排查真实App独立采样或准备新批次时 |
| [2026-11-06_m5-independent-verification-report.md](2026-11-06_m5-independent-verification-report.md) | 独立CLI idle失败、单次采样器与有界树重采固定20轮 | 复核采集修复与剩余任务上下文失败时 |
| [2026-11-06_android-jev-loop-report.md](2026-11-06_android-jev-loop-report.md) | Jev有限候选连续搜索、实验策略与离线证据 | 对接真实Jev任务验收、继续Skill前置工作时 |
| [2026-11-08_jev-capability-mumu-report.md](2026-11-08_jev-capability-mumu-report.md) | jev-android 能力映射、MuMu 隔离设备验证、横屏滚动修复及失败历史 | 复核当前控制器基本动作、通用循环、模拟器范围与真实模型证据的差异时 |
| [2026-11-08_android-no-model-suite-report.md](2026-11-08_android-no-model-suite-report.md) | 正式无模型设备套件、靶场扩展、独立判据和新批证据 | 运行 MuMu 扩展用例、复验原矩阵或核对长按/selected/加载与多页任务边界时 |
| [2026-11-08_android-input-recovery-report.md](2026-11-08_android-input-recovery-report.md) | 未知触摸持久隔离、同设备新启动恢复、宿主重启阻断及MuMu重启后端 | 复核强杀后残留输入、显式恢复与新动作准入时 |
| [2026-11-07_jev-loop-roadmap.md](2026-11-07_jev-loop-roadmap.md) | J系列唯一详细计划：共用完成契约、有界恢复、显式升级、语义/动作/多字段与逐版本校准；含mobile-jev取舍 | 实施M5.1a/b/f补齐、讨论自修复与终止判据时；J1.1–J1.3、J5.1及最小证据已实现，其余按状态表 |
| [2026-11-07_jev-j2-implementation.md](2026-11-07_jev-j2-implementation.md) / [冻结契约](2026-11-07_jev-j2-contract.md) | J2 封闭语义、近期验证反馈、观察绑定决策及固定对照边界 | 复核 search-v5 或推进 J3.1 时 |
| [2026-11-07_jev-j31-implementation.md](2026-11-07_jev-j31-implementation.md) / [冻结契约](2026-11-07_jev-j31-contract.md) | J3.1 受限首批：预声明聚焦/IME与单次目标查找、跨仓投影及离线证据 | 使用 searchActions、复核 search-v6 或设计连续查找时 |
| [2026-11-07_jev-multiscroll-implementation.md](2026-11-07_jev-multiscroll-implementation.md) / [冻结契约](2026-11-07_jev-multiscroll-contract.md) | J3.1 有界多屏查找、方向性锚点证明、次数/回访边界及跨仓证据 | 使用 maxSwipes 或复核 search-v7 时 |
| [2026-11-07_jev-j32-back-implementation.md](2026-11-07_jev-j32-back-implementation.md) / [冻结契约](2026-11-07_jev-j32-back-contract.md) | J3.2a 初始同窗口返回搜索、来源/目标检查、禁止补偿与跨仓证据；J5.3 返回夹具 | 使用 searchActions.back 或复核 search-v8 时 |
| [2026-11-07_jev-j4-route-implementation.md](2026-11-07_jev-j4-route-implementation.md) / [冻结契约](2026-11-07_jev-j4-route-contract.md) | J4a 类型化起点/终点、固定参数引用、双重读回、提交前复核、跨仓升级与离线验收 | 使用 route_search 时 |
| [2026-11-07_jev-j53-replay-implementation.md](2026-11-07_jev-j53-replay-implementation.md) / [冻结契约](2026-11-07_jev-j53-replay-contract.md) | J5.3 三任务族声明式回放目录、独立判据、反事实/变异检查与并行变更说明 | 新增任务族夹具或复核回放判据时 |
| [2026-11-07_jev-j33-toggle-implementation.md](2026-11-07_jev-j33-toggle-implementation.md) / [冻结契约](2026-11-07_jev-j33-toggle-contract.md) | J3.3a 单个应用内布尔开关、原始 checked 证据、零写完成与跨仓升级/轨迹；内层上下文回执复核 | 使用 set_toggle 或准备 J4 多字段时 |
| [2026-11-07_jev-j52-implementation.md](2026-11-07_jev-j52-implementation.md) / [冻结契约](2026-11-07_jev-j52-contract.md) | J5.2 跨仓主 Agent/Handoff 同任务升级、取消排干和离线证据 | 使用 assistance 或推进 J2 时 |
| [2026-11-07_jev-wait-escalation.md](2026-11-07_jev-wait-escalation.md) | J1.3声明加载等待/进度和J5.1结构化升级证据，冻结契约与离线边界 | 继续J5.2宿主升级或复核search-v3时 |
| [2026-11-07_jev-evidence-recovery.md](2026-11-07_jev-evidence-recovery.md) | 最小模型证据、容量边界、共享夹具与可信未派发stale恢复 | 复核J0.1/J5.3/J1.2、计数与停止边界时 |
| [2026-11-07_jev-j1-completion.md](2026-11-07_jev-j1-completion.md) | J系列首批契约、完成策略身份、修复前证据和离线回归范围 | 复核J1.1或继续J0.1/J1.2时；不代表真实模型校准 |
---

## 4. 本目录的版本控制口径

2026-11-07 用户明确要求将 `docs/android-controller/` 与当前 Android/Jev 基线一起提交，本目录从本批起纳入版本控制；本次不推送。`.git/info/exclude` 的旧目录规则仍在，已有文档照常追踪，新增文档需按本范围显式暂存。

本次不纳入 `.env`、`config.env`、`config.env.example` 等环境配置，以及无关桌面、音频改动。历史本机 artifact 链接仍指向本地证据，不承诺克隆仓库即包含历史设备运行产物。

原规则对 `scripts/verify-android-*.cjs`、`scripts/android-perf-baseline.cjs`、`scripts/android-m15-fixture/` 与 `tests/android-perf-baseline-runner.test.js` 的排除保持独立。
