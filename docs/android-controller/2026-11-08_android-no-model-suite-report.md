# 无模型设备套件与 MuMu 扩展验证

当前结果和阶段状态统一见 [README](README.md)。本轮使用 MuMu Android 15 / API 35、x86_64、display 0，以及两只没有权限、网络或持久化数据的隔离 App。测试目录为 [android-no-model-suite-2026-11-08](../../artifacts/android-no-model-suite-2026-11-08/)。

## 实现与入口

[正式入口](../../scripts/verify-android-device-suite.cjs)支持 journeys、m5、m15 三套矩阵。m5 与 m15 直接复用原设备 runner；journeys 使用生产 `RunTask`、有限候选、观察、动作执行、完成检查、租约与轨迹，仅把决策提供器替换为本地确定性函数。没有更改生产策略门槛或完成契约。

[用法](../../scripts/android-device-suite/README.md)包含离线构建、安装、MuMu 的显式 32 位 ContentProvider 读取、批次选择及失败边界。设备地址、ADB、APK、输出目录均由命令行指定。输出目录排他创建，安装前后校验 APK SHA-256；系统 RPC APK 有身份核对，不接受不明旧版本。清理前要求排干，清理本身设截止。

靶场增加独立 [JourneyFixture](../../scripts/android-m15-fixture/src/com/vcpchat/m15fixture/JourneyFixture.java)，每次真实 Android 回调更新只读状态，不读取控制器回执。伴随包 `com.vcpchat.fixturepeer` 只显示一个标签并记录自己的会话和 resumed 状态，用于跨包启动检查。旧靶场模式保持原样，并以新 APK 复验旧矩阵。

## 判据与证据

| 证据 | 发现 / 验证内容 | 执行与判定路径 |
| --- | --- | --- |
| journeys 的 `events.jsonl`：independent、receipt | 长按同时记录 MotionEvent 时间和 SystemClock uptime；一次 DOWN/UP，无取消或短按 | 生产 LongPress → 靶场 TouchPad → 独立 provider；固定时长容差在 freeze.json |
| TouchCancel 的 external-touch 与 independent | 系统 DOWN/CANCEL 实际抵达靶场，没有 UP/点击/长按计数 | 外部 ADB 注入到当前观察绑定的靶场坐标；只验证事件与检查器，不冒充生产长按在途取消 |
| SelectedState 的 provider 投影与 independent | selected 从 false 变为 true，并进入下一轮语义变化反馈 | 生产 Tap 与元素投影；任务无 selected 完成谓词，回执保持 unverified；外部测试独立判定 |
| MultiPage / LostInputStops 的轨迹与终态 | 填第一字段、下一页填第二字段、Back、Review；返回丢失第一字段时硬停，不补写 | 原始树字段绑定 → 生产候选/执行 → provider 核对文本、写入/返回/提交次数 |
| ScrollThenOpen 的终态 | 滚动后点击唯一目标，记录滚动位移和一次目标回调 | 生产 Scroll/Tap → ScrollView 与按钮回调 |
| Loading / TransientCompletion 的事件 | 正常加载和短暂完成标记后均等待最终状态，没有多次 Start 或多余模型决策 | 靶场定时器 → 宿主算法等待/稳定采样 → Done 前独立状态核对 |
| LoadingDeadline 的停止回执 | 持续加载在固定截止内返回停止，保留一次 Start 和未完成状态 | 原预算与加载窗口 → TASK_WAIT_TIMEOUT；不延长预算继续跑 |
| LaunchApp 的两个 provider | 从伴随包启动主靶场，主会话不变，伴随包变为 paused | 生产 LaunchApp → 新鲜前台/包证据 → 双 App 独立状态 |
| 搜索 / 无效果改选 / stale / 取消事件 | 原 MuMu 探索场景迁入正式矩阵 | 生产 ui_task，原判据和固定预算；stale 的外部编辑及预聚焦单独记录 |
| `runner-tests.log` 与后续 runner 测试日志 | 首次测试用例的 observation UUID 不是 v4，被生产契约拒绝 | 修正测试 UUID，保留失败日志；没有修改生产校验 |

受控瞬态只持续 80 ms。本次检查能证明没有因它提前返回成功，但采样可能未覆盖这段瞬态，不能宣称必然观察或拒绝了这一帧。持续加载、瞬态标记和真实 App 加载的工作负载不同，后者仍需后续真实任务验证。

## 批次身份与保留记录

`journeys-r1` 是首次完整设备矩阵。随后正式工具补上缺失 RPC 产物准备、额外脚本身份和清理截止，再以新批次复验；原结果仍对应原摘要。APK 在两轮之间未修改。源码和编译产物保存在本轮独立 `fixture-build` 中，未覆盖之前的 MuMu 靶场构建。

每轮 `freeze.json` 固定任务、预算、读取运行时、用例和源码/APK摘要；`events.jsonl` 保存独立真值及本地决策输入，`traces/` 保存生产轨迹。模型调用计数表示本地提供器调用；HTTP 模型请求始终为零。失败和未执行分开报告，不复用旧批绿色结果补齐新批分母。

## 不覆盖的范围

这轮没有实现原生 LONG_CLICK，没有测 RPC 进程被杀、锁屏/前台抢占故障矩阵或长时间稳定性。触摸取消与宿主 AbortSignal 分别有自己的证据，不能推导出未知写可重试。多字段、开关和 LaunchApp 是隔离通用循环验证，不替代 search/toggle/route 各任务族真实模型准入。

AndroidWorld / AndroidLab 官方环境、真实 App 工作负载、模型质量与独立校准均属于后续批次。当前测试不积累独立真实准入样本，所有策略保持 calibrated:false。
