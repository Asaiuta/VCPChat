# AndroidController 文档索引与当前状态

本目录是 `VCPDistributedServer/Plugin/AndroidController` 的全部文档。

**这个 README 是「现在完成了吗」的唯一答案面。** 任何进度数字、任何阶段状态，只在这里写一次；其余文档引用它，不复制。看到别处的数字与这里不一致，以这里为准，并把那一处改掉。

最后更新：2026-11-07（J系列首批：J1.1共用完成契约已实现；J0.1完成策略身份与离线夹具已补，其余校准证据待补。M4.1、Jev受限搜索与虚拟屏状态分别记录）。

---

## 1. 当前状态总表

状态档位：`未开工` → `已落代码` → `已集成` → `离线验证` → `真机通过`。
逐档升级需各自的证据；「离线验证」不等于真机可用，「真机通过」限单 ROM 固定靶场，不外推分辨率、参数组合或其它 ROM。

| 阶段 | 状态 | 证据锚点 | 阻塞 / 边界 |
| --- | --- | --- | --- |
| M0 把账对上 | **部分完成** | `tests/android-config-surface.test.js`；[性能基线](android-performance-baseline.md) | M0.4 代码身份已落，旧基线未迁移；soak 未做 |
| M1 设备端 RPC | **真机通过 6/6**（2026-11-03） | `scripts/verify-android-m1.cjs` | 密码框分支未覆盖 |
| M1.5 动作语汇 | **真机通过 14/14**（2026-11-05 当前代码） | `scripts/verify-android-m15.cjs --suite`；[M1.5 记录](android-m15-device-validation.md)；[本轮验收](2026-11-05-device-acceptance.md) | 单 ROM 单 portrait；`DoubleTap` 连续 4 次通过，但无长稳重复 |
| M2 寻址与验证 | **真机通过 14/14**（2026-11-05 当前代码） | `scripts/verify-android-m2.cjs --suite`；[M2 记录](android-m2-device-validation.md) | 单 ROM、单 portrait；idle 运动用例仍为设计内 unknown |
| M2.5 身份与证据 | **已集成**；owner 绑定/隔离/恢复与无线断线重绑已验证 | [context 集成](../../tests/android-m3-context-service.test.js)、[重绑修复](2026-11-05_android-owner-rebind-report.md) | 单 ROM；连接别名统一、长时间断网与跨 ROM 未验收 |
| 旋转 / 方向切换 | **真机通过 8/8**（2026-11-05 夜间） | `scripts/verify-android-rotation.cjs --suite`；[旋转验收](2026-11-05-rotation-acceptance.md) | 单 ROM；横屏下仅验 9/14 |
| M2.6 策略与呈现 | **真机通过**：原生批准/交还 4/4，结构关系与 Collect 5/5 | [人工交互](../../tests/android-human-interaction.test.js)、[无OCR流程](../../tests/android-no-ocr-workflows.test.js)；[本轮验收](2026-11-05-device-acceptance.md) | typed intent 暂缓；批准按钮由真人在现场点击，不可合成 |
| M3 视觉中间层 | **未开工（零实现）** | 无 | 硬前置未闭；OCR/模板一行代码都没有 |
| M4 人机协同 | **首批已集成、离线及隔离浏览器验证**：M4.1默认屏显式设备、原生批准能力、socket写会话/epoch、真实排干、有限快照点击/滑动/按键；M4.0历史原生交互已通过，M4.2队列与M4.3边界仍各自保留 | [首批接管记录](2026-11-06_android-m4-takeover.md)；[lease](../../tests/android-takeover-lease.test.js)、[Service](../../tests/android-takeover-service.test.js)、[HTTP/WS](../../tests/android-takeover-channel.test.js)、[viewer](../../tests/android-takeover-viewer.test.js) | 接管未真机/真实Electron批准；临时全局门阻止所有Agent与管理，canonical identity、跨进程、多屏、连续pointer/scrcpy control未做 |
| M4.5 后台虚拟屏 | **P0 技术可行性单机通过，生产未接入**：focus1 候选不抢焦点（20/20）；在因果判据下，生产 u2 carrier 按 display 读到虚拟屏元素树，加上 scrcpy control 触摸，F3W 矩阵 20/20（用户全程使用手机，carrier p50 64ms） | [焦点修复报告](2026-11-06_android-m4-focus-report.md)；[P0真机报告](2026-11-06_android-m4-p0-report.md)；[冻结协议](../../scripts/android-m4/README.md) | P0原失败保留；首批矩阵因物理屏外部变化0/1/19中止。未做：A3语义树、control socket输入、IME/PASTE、同App迁移、权限弹窗、跨ROM；研究靶场已卸载并复核无残留 |
| M5 长任务与生态 | **受限切片继续完善，完整准入未通过**：原靶场复验 8/8；独立读取改用单次采样进程和有界完整树重采 | [独立采集复验](2026-11-06_m5-independent-verification-report.md)；[前批稳定性](2026-11-06_m5-stability-report.md)；[生产路径测试](../../tests/android-task-executor.test.js) | 最新v5固定20次：独立匹配20/20、联合通过19/20；1次任务UI_CONTEXT_CHANGED，第二App未扩展 |
| M5 上下文差异证据 | **已集成、离线验证**：UI_CONTEXT_CHANGED/上下文不明附封闭词表维度名，完成阶段逐样本谓词与容器内外HMAC摘要；完成等待仍为整页稳定（判断与v6准入条件见报告） | [记录](2026-11-06_m5-context-diff-report.md) | 限定回归1865/1865（113文件，不与1952混比）；未真机，生产已变，v5 19/20不覆盖本版 |
| M5.1a Jev连续搜索 / J1.1 | **已集成、离线验证**：自动生成搜索候选、Jev选择/等待/返回升级停止码、多级入口与填入/提交独立验证；首批已统一三种decision的空容器/旧结果判据与完整结果稳定等待，容器和条目共用5秒窗口 | [首批契约与证据](2026-11-07_jev-j1-completion.md)；[完成回归](../../tests/android-task-completion.test.js)；[J系列路线图](2026-11-07_jev-loop-roadmap.md) | experimental搜索词表/唯一同包ID；J0.1模型版本/概率/usage证据待补，J1.2未派发stale重决策、实际Agent升级未接入；真实模型/App联合准入和校准未做；历史真机不覆盖本批 |
| 独立显示窗口（与 M5 并行） | **已集成、离线及真实 Electron 宿主验证**：应用入口、主题、安全单实例、就绪错误重试、独立订阅生命周期、画质热应用与横竖屏比例贴合 | [窗口实现](../../modules/services/androidDisplayWindow.js)；[宿主测试](../../scripts/test-android-display-electron.cjs)；[画质与布局记录](2026-11-05_android-display-quality-report.md) | 使用替身设备验证真实 HTTP/Cookie/WS/PNG 和 ASAR 载体；H.264 编码器替身，无真机参数效果/完整安装包验收；窗口历史证据不替代新增M4.1接管验收 |

### 关键数字（只在这里维护）

| 指标 | 数值 | 取数日期 | 备注 |
| --- | --- | --- | --- |
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
| M1.5 真机 | **14/14** | 2026-11-05 晚间 | `DoubleTap` 复跑 4/4；`ScrollUntilHost` 已通过 |
| M2 真机 | 14/14 | 2026-11-05 | 无 case 重试，正常 cleanup |
| 旋转真机（2026-11-05 夜间） | **8/8** | 2026-11-05 | context/epoch 前进、旧 index/frame 失效、转回后仍失效 |
| M5 受限搜索真机 | **8/8**（靶场）；Legado 真实应用 3/5 完成，2 次过渡期安全停止 | 2026-11-05 夜间 | 2 成功 + 6 停止边界（歧义/密码/完成预存/只读策略/观察预算/预取消），无 case 重试，模型调用 0，7 份轨迹无输入泄露；[日志](../../artifacts/android-m5-device-2026-11-05/run5.log) |
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

跨 ROM 矩阵、旋转与多 display、真实在途未知 RPC 注入、30–60 分钟 soak、历史性能基线迁移。这些没做完，就不说「M3 前置全部完成」。

---

## 2. 阻塞与已解除项

1. **M3 前的真机矩阵已补齐，仅限单 ROM 固定靶场**：M1.5 14/14、M2 14/14、结构/Collect 5/5、原生批准 4/4，均 exit 0。靶场模式是内存态，跨矩阵不自动复位（人工组会留下 `m2`，随后 M1.5 会以 `FIXTURE_STATE_INVALID` 停在 gate）；`ELECTRON_RUN_AS_NODE=1` 会让原生组在第一行崩掉。两条都记在[本轮验收](2026-11-05-device-acceptance.md)。
2. **owner 重绑缺口已修复并通过本机专项**：失效控制转发核验重建、认证续约与设备端超时自退出、停止时排干续约并独立证明消失；无线 ADB 重连后 RPC 与 CLI 均可恢复。历史旧版孤儿不自动清理，连接别名与跨 ROM 仍待验收。见[修复记录](2026-11-05_android-owner-rebind-report.md)。
3. **跨 ROM 未做**：需要第二台设备先采原始 `dumpsys`/`uiautomator` 格式，再按正向证据扩白名单；不用模拟器或猜想代替。
4. **M4.5 的 P0 探针**：PJZ110首轮已证明scrcpy建屏/启动/真实出图，但默认屏焦点丢失；overlay路线启动被系统拒绝。隔离判据未过，停止输入与后续矩阵，资源和物理屏均已恢复。详见[P0真机报告](2026-11-06_android-m4-p0-report.md)。同日以focus1候选修复焦点抢占（R2矩阵20/20），见[焦点修复报告](2026-11-06_android-m4-focus-report.md)；仍不是生产准入。

---

## 3. 文档地图

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
| [2026-11-05_audit-android-pre-m3-report.md](2026-11-05_audit-android-pre-m3-report.md) | M3 前收口报告（本轮证据汇总，含保留失败） | 复核 2026-11-05 这一轮时 |
| [2026-11-05_audit-android-pre-m3-report.md](2026-11-05_audit-android-pre-m3-report.md) | M3 前收口报告（历史证据汇总，含保留失败） | 复核 2026-11-05 早年那轮时 |
| [2026-11-05-device-acceptance.md](2026-11-05-device-acceptance.md) | **此前四组真机矩阵**、离线回归与两条工程问题 | 复核 2026-11-05 晚间真机轮结果时 |
| [2026-11-05-m5-first-slice.md](2026-11-05-m5-first-slice.md) | M5 首批搜索模板、所有权/轨迹、验证与复审边界 | 继续实现或准备M5真机准入时 |
| [2026-11-06_m5-context-diff-report.md](2026-11-06_m5-context-diff-report.md) | M5 上下文差异脱敏证据、完成等待范围判断与v6准入规则 | 恢复真机或决定完成等待策略时 |
| [2026-11-06_m5-stability-report.md](2026-11-06_m5-stability-report.md) | M5 有界稳定等待、原始结果条目证据、固定20次及独立核验缺口 | 继续排查真实App独立采样或准备新批次时 |
| [2026-11-06_m5-independent-verification-report.md](2026-11-06_m5-independent-verification-report.md) | 独立CLI idle失败、单次采样器与有界树重采固定20轮 | 复核采集修复与剩余任务上下文失败时 |
| [2026-11-06_android-jev-loop-report.md](2026-11-06_android-jev-loop-report.md) | Jev有限候选连续搜索、实验策略与离线证据 | 对接真实Jev任务验收、继续Skill前置工作时 |
| [2026-11-07_jev-loop-roadmap.md](2026-11-07_jev-loop-roadmap.md) | J系列唯一详细计划：共用完成契约、有界恢复、显式升级、语义/动作/多字段与逐版本校准；含mobile-jev取舍 | 实施M5.1a/b/f补齐、讨论自修复与终止判据时；J1.1已实现，其余按状态表 |
| [2026-11-07_jev-j1-completion.md](2026-11-07_jev-j1-completion.md) | J系列首批契约、完成策略身份、修复前证据和离线回归范围 | 复核J1.1或继续J0.1/J1.2时；不代表真实模型校准 |
---

## 4. 本目录的版本控制口径

2026-11-07 用户明确要求将 `docs/android-controller/` 与当前 Android/Jev 基线一起提交，本目录从本批起纳入版本控制；本次不推送。`.git/info/exclude` 的旧目录规则仍在，已有文档照常追踪，新增文档需按本范围显式暂存。

本次不纳入 `.env`、`config.env`、`config.env.example` 等环境配置，以及无关桌面、音频改动。历史本机 artifact 链接仍指向本地证据，不承诺克隆仓库即包含历史设备运行产物。

原规则对 `scripts/verify-android-*.cjs`、`scripts/android-perf-baseline.cjs`、`scripts/android-m15-fixture/` 与 `tests/android-perf-baseline-runner.test.js` 的排除保持独立。
