# M5 搜索稳定性续接

后续独立证据诊断已另立[新批次报告](2026-11-06_m5-independent-verification-report.md)：最新v5固定20次独立匹配20/20、联合通过19/20，完整准入仍未通过。本文13/20历史结果保持不变。

日期：2026-11-06。续接 Claude Code 会话 `07dbfe45-d3a5-4dc5-a53d-5de615f87d02` 最后获准实施的工作：有界页面稳定等待、增强完成条件、Legado 固定 20 次复测。原会话停在执行器测试 19/20，一项有效 `absent=输入框ID` 被误判为重复目标。

## 实现

- `androidTaskExecutor.js` 复用 M2 `waitForIdle`，使用完整任务 HMAC 摘要与上下文，连续两次一致且目标就绪才执行。单阶段最多 5 秒，总任务/采样预算和取消仍生效；首次诊断证明 2 秒会截断真实采样，故在固定实验前调整为 5 秒。
- 暂时缺目标时只读等待；仅规则模式的页变失败且子回执明确 `failed` 才重新观察，每个逻辑动作最多 3 次尝试。所有失败回执保留；已派发但未证实、传输未知、策略拒绝和歧义/密码目标停止，不回放。`counts.actions` 计逻辑动作，额外尝试由 receipts 显示。
- `completion.item/minItems/itemMatchesInput/absent` 可要求容器内条目数量、至少一项文本包含输入、旧页面节点消失。允许 absent 引用输入目标，拒绝正反条件使用同一完成 ID。
- 真机发现 Legado 非点击书名被控件图折叠进可点击列表行。端口改用现有 `rawEntries` 的可见性与原始父子关系统计容器后代；密码、不可见和容器外节点不作条目证据。查询与条目文字不进入轨迹，宿主只获计数/布尔值。
- 声明条目条件时允许预先存在的空列表；若完整完成谓词已成立仍停止。单纯 visible 完成契约继续拒绝预存标记。

## 实验协议

设备 PJZ110，ADB 连接别名 `192.168.137.193:32785`。Legado `io.legado.app.release`，查询沿用此前用户已有搜索历史中的词，`decision=rules`、0 模型调用。每次独立冷启动 App，最多 3 个逻辑动作、64 次观察、120 秒任务预算；单次任务不重跑。

完成条件固定为唯一可见 `recycler_view` 容器，至少一个可见非密码 `tv_name` 后代，且至少一个书名文本包含输入。`ll_input_help` 在该 App 结果页的无障碍树中仍存在，不将它声明为 absent；absent 功能另有隔离行为测试。任务后停止自身采集服务，通过 Android CLI 重新读取 XML，用独立 DOM 解析器核验容器、后代、输入框精确值和匹配条目。独立 XML 不可用计失败，不补跑；未知传输停止剩余试验并报告未执行分母。

驱动：[verify-android-m5-legado.cjs](../../scripts/verify-android-m5-legado.cjs)。固定 20 次的协议、逐轮结果、轨迹与源文件 SHA-256 位于 [legado20](../../artifacts/android-m5-continuation-2026-11-06/legado20/)。驱动逐轮核对身份，生产代码变化则停止。

## 验证记录

阶段状态和分母同步 [README](README.md)。本目录所有文档继续遵循本机保存策略。

- 最终离线：119 个文件，**1952/1952 PASS**，0 fail/cancelled/skipped，exit 0，75.210 秒。选集及命令口径沿首批 Android+宿主接缝，不是全仓回归；[文件清单](../../artifacts/android-m5-continuation-2026-11-06/offline-files.txt)、[日志](../../artifacts/android-m5-continuation-2026-11-06/offline-final.log)、[退出码](../../artifacts/android-m5-continuation-2026-11-06/offline-final.exit.txt)。
- 当前代码原靶场矩阵：**8/8 PASS**，0 未执行，exit 0，case 不重试。观察预算用例仍以 8 次采样在提交后 unknown 停止，独立 Provider 证实一次提交；未改动该用例预算或效果断言。[日志](../../artifacts/android-m5-continuation-2026-11-06/fixture.log)、[退出码](../../artifacts/android-m5-continuation-2026-11-06/fixture.exit.txt)。
- Legado 固定 20 次：**20/20 执行，13/20 独立通过，7/20 独立证据不可用，0 未执行，exit 1**。任务端均 completed/verified，60 个原子子动作均 verified，额外尝试 0，模型调用 0；这不替代独立验收分母。[逐轮日志](../../artifacts/android-m5-continuation-2026-11-06/legado20/results.jsonl)、[退出码](../../artifacts/android-m5-continuation-2026-11-06/legado20.exit.txt)。

13 个独立通过轮次均重新读到唯一结果容器、非空匹配书名和精确输入值。其余 7 次 `INDEPENDENT_XML_INVALID`，驱动缺少可信独立 XML，没有以任务自报填补，未补跑或删轮；本批 **NOT_PASSED**。原始协议未保存失败 XML/原始输出，无法据本批数据进一步断言是 CLI idle 超时、采集交接还是其他解析原因。后续应先为独立读取增加不含页面文字的失败分类，再以新批次身份验证，不能回填本批通过。

20 个任务轨迹均未包含查询输入。协议冻结的 47 个源文件逐轮及结束后哈希一致；[汇总与哈希清单](../../artifacts/android-m5-continuation-2026-11-06/evidence.json)。语法检查 6 个 JS 文件与限定 diff 空白检查通过。当前实现和这批证据不依赖真实模型服务。

离线中保留一次 1951/1952：缺目标等待结束时，墙钟截止可能在前台 probe 与 XML 派发之间到达，原子采样明确抛 `VERIFICATION_TIMEOUT`，而测试仅接受 `TASK_TARGET_MISSING`。调整该断言允许两种已定义停止原因，仍要求 stopped、failed 和零实际输入；生产代码未为此改变。后续上述全集通过，原日志保存在 `offline-local-deadline.log`。

保留的开发诊断：

1. 初始执行器 19/20：有效的 absent 输入 ID 被重复 ID 校验拒绝。
2. 2 秒等待诊断：进入、填入、提交通过，末次采样 `UI_SERVER_TIMEOUT`，未视为成功。
3. 5 秒严格完成诊断：图中条目被折叠，末段 `CONTEXT_UNPROVEN`；独立 XML 能看到 6 条匹配结果，促成原始条目证据修复。
4. 原始树诊断：空结果容器已存在，触发 `TASK_COMPLETION_PREEXISTS`；修正为检测完整增强谓词的预存成功。
5. 修正后严格任务 completed，但当轮独立 XML 不可用，仍记录 0/1；稍后单独读取确认 6 条匹配结果，没有回填那轮为通过。

原始诊断日志、失败测试与后续通过日志均保留在 [本轮产物](../../artifacts/android-m5-continuation-2026-11-06/)。这些开发诊断不并入固定 20 次，也不抹去。

## 范围

本轮仅完善参数化搜索规则模板，不代表 M5 全阶段完成。Jev 候选规划、跨 ROM/其他 App、无提交按钮的 IME 提交和更长时间稳定性没有新增准入；匹配输入子串不等于语义相关性或结果集完整性。未更改模型服务配置、未调用真实 Jev、未提交或推送。
