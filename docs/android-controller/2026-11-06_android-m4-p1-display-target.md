# M4.5 P1：DisplayTarget 与按 display 分域的上下文（2026-11-06）

**结论**：库层已经能按 display 采集上下文。默认屏的所有既有调用都没有被改动：Android 全套 1922 个测试在 P1 后仍然通过，加上 10 个新测试共 1932/1932。生产服务的公开工具**还没有暴露虚拟屏目标**：虚拟屏的创建属于 P2，授权属于 P5。

| Evidence | Finding | Path |
| --- | --- | --- |
| `displayTarget()` | 不传参数、传 `null`/`0`/`{displayId:0}` 都表示默认屏。非默认屏必须同时带 logical id、`uniqueId`（来自 DisplayDeviceInfo）和 `generation`，因为 logical id 在虚拟屏销毁后会被复用（PJZ110 上 135→206 递增，但不保证不复用） | [display-target.js](../../VCPDistributedServer/Plugin/AndroidController/lib/display-target.js) |
| `probeScreen(serial,{fresh:true, display})` | 默认屏仍走原命令和原解析器，多屏时照旧 `displayId=null` 失败关闭。非默认目标会额外采 `dumpsys display`，必须恰好命中一个 `Display: mDisplayId=N` 段，且 `uniqueId` 必须一致，否则返回 `displayId=null`。焦点、尺寸、旋转从该 display 段读取；唤醒和锁屏是设备全局状态，解析方式与默认屏相同 | [adb.js](../../VCPDistributedServer/Plugin/AndroidController/lib/adb.js) `parseScopedScreenProbe` |
| `frameContext(probe, target)` / `sameContext` / `contextKey` | 非默认屏的上下文携带 `uniqueId`+`generation`；同一 logical id 换了 generation 就视为不同上下文。默认屏的 key 和判定与之前完全相同 | [context.js](../../VCPDistributedServer/Plugin/AndroidController/lib/context.js) |
| `createContextTracker()` | 每个 display 有独立的 epoch：虚拟屏变化不推进默认屏的 epoch，反之亦然。设备级 `invalidate(serial)`（重连、输入、未知结果）会同时推进该 serial 下所有 display 的 epoch。`forget` 用于丢弃已销毁虚拟屏的分区；默认屏不可被 forget | 同上 |
| `filterHierarchyByDisplay` / `displayScopedGraph` | 先按根节点的 `display-id` 从 carrier 返回的多根 XML 里切出目标屏，再交给 `parseUiGraph`。只要有一个根节点缺少或带着非法的 `display-id` 就失败关闭。在真实 F3W 的 dump 上，67.5KB 被切到 3.1KB | [window-evidence.js](../../VCPDistributedServer/Plugin/AndroidController/lib/window-evidence.js) |
| 测试 | 回归：默认屏在多屏时仍拒绝，命令里没有 `dumpsys display`，显式传 `display:0` 时结果与原路径逐字段相同。新增：logical id 复用、段缺失、帧格式错误、重复段、generation 绑定、epoch 分区、过滤时失败关闭。fixture 从 PJZ110 的真实多屏 dump 缩减而来；完整的真实 dump 也在离线环境验证过 | [android-display-target.test.js](../../tests/android-display-target.test.js) |

**留给后续阶段**

- P2 负责虚拟屏创建与生命周期（在生产中使用 focus1 jar 需要单独决定）、双屏采集和 viewer。届时 `AndroidControllerService` 中的 `lastObserve`/`lastVision`/`contextTracker` 调用点需要传入目标。
- 虚拟屏带有 `FLAG_ALWAYS_UNLOCKED`，但 P1 仍要求设备 Awake 且已解锁：放宽属于策略问题，留到 P5 决定。
- 现在要在宿主侧过滤，是因为 carrier 只能返回所有屏的树，物理屏越复杂越慢。在设备端只导出目标屏需要换用新的承运方式（自建 dex），不在 P1 范围内。
