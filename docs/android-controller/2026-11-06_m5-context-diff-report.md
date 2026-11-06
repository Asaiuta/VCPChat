# M5 上下文差异证据与完成等待范围判断

2026-11-06，续接[独立采集复验](2026-11-06_m5-independent-verification-report.md)的两项下一步。**仅离线；未连设备、未调用模型、未改任何停止/通过策略。** v5 的 19/20、exit 1、NOT_PASSED 分母保持不变，旧轨迹不回填新字段。

## 1. 脱敏字段差异证据（已实现）

| 位置 | 新证据 | 脱敏方式 |
| --- | --- | --- |
| `captureGraph` 抛 `UI_CONTEXT_CHANGED` / `CONTEXT_UNPROVEN` | `error.contextDiff`：前后探针失败维度、前后上下文差异维度、epoch、图与上下文不符原因 | 封闭词表 [`CONTEXT_DIFF_TOKENS`](../../VCPDistributedServer/Plugin/AndroidController/lib/context.js)，只有维度名，不含包名/组件/窗口/尺寸/旋转值 |
| task-port 观察 | `TASK_CONTEXT_UNPROVEN` 原因（`task_*`）；两次各自一致的采样之间的上下文漂移（之前只会让稳定等待静默超时） | 同上 |
| 完成阶段每个观察行 | `matched` 与 `completion{present,containers,items,inputMatched,absent}` | 只记布尔和计数 |
| 观察摘要 | `targetDigest`（完成容器子树）/ `outsideDigest`（容器外） | 每个任务独立 HMAC 密钥，只能在同一轨迹内比对，跨任务不可逆推页面 |
| 停止事件、任务回执、Legado 驱动结果行 | `contextDiff` | 执行器和轨迹两层白名单校验，不认识的 token 直接丢弃或拒写 |

窗口区分 `window_token`（同标题窗口被重建，如 `Window{a1 u0 X}`→`Window{b2 u0 X}`）和 `window_title`（换成别的窗口或弹窗）。v5 第 15 轮正好要区分这两种情况：前者多半是 ROM/App 重建窗口，后者才是真正的安全边界变化。

## 2. 完成等待是否只围绕声明目标（判断：目前不是；本批不改）

**事实（源码）：** rules 模式的完成阶段走 `settle(completed)`，要求连续两次采样的整页 HMAC 摘要相同，采样期间上下文也不能变。这个摘要覆盖全部节点的属性，包括文本，所以容器外任何节点变化都会推迟或阻断完成。jev 模式只做单次观察，不等稳定。[新测试](../../tests/android-task-executor.test.js)已固化这一点：目标容器和匹配条目保持不变，只有容器外一个节点持续变化时，每个样本 `matched=true`、`targetDigest` 唯一，任务仍然停止。

**历史轨迹（只能看整页摘要）：** v3 与 v5 共 40 轮的上下文摘要在完成阶段都只有 1 个值，整页摘要却每轮都在变：成功轮通常 3–4 个样本、2–3 个不同摘要。两次失败（v3#20 `TASK_COMPLETION_UNPROVEN`、v5#15 `UI_CONTEXT_CHANGED`）都是 5 个样本、5 个不同摘要。Legado 结果页在完成阶段确实一直在变，但旧轨迹没有区域摘要，**分不清变化发生在结果容器内（例如多书源陆续返回）还是容器外。**

**判断：**
1. v5#15 来自 `captureGraph` 的上下文一致性检查，与稳定等待的范围无关。把等待收窄到目标也不会让它通过，这项检查也不应因此放宽。
2. 收窄等待范围只可能影响 v3#20 这类“页面一直不静止”的失败，前提是变化只发生在容器外。如果变化在容器内，可选方案是“完成谓词连续 N 次成立”，而不是只比对目标摘要。
3. 两种方案都会改变准入策略，必须另立版本（v6），再跑完整 20 次新批次。当前没有区域证据，本批不做选择。

**真机恢复后的判定规则：** 新批次轨迹里，完成阶段若 `targetDigest` 稳定而 `outsideDigest` 在变，说明目标限定的稳定等待有依据；若 `targetDigest` 本身在变，就考虑谓词连续成立。`UI_CONTEXT_CHANGED` 按 `contextDiff` 归因：只有 `window_token` 时，先查 ROM/App 窗口重建；出现 `window_title`、`component`、`after_keyguard` 等时按安全停止处理。

## 验证

| 项 | 结果 |
| --- | --- |
| 专项：上下文 + 轨迹 | 33/33，exit 0 |
| 专项：执行器（新增 3 条：窗口重建、样本间漂移、等待范围判定） | 27/27，exit 0 |
| [限定 Android+宿主回归](../../artifacts/android-m5-context-diff-2026-11-06/offline-final.log) | **1865/1865**，exit 0，0 取消/跳过，97s；[113 文件选择集](../../artifacts/android-m5-context-diff-2026-11-06/offline-files.txt)，与历史 119 文件 1952 分母不同集合，不混比 |

改前快照在 `artifacts/android-m5-context-diff-2026-11-06/before/`。开发中有 2 次失败，都是测试写错，已改：一次 graph 构造缺 `rpcTarget`，另一次漏写同时成立的 `graph_package`。生产代码修改的是 `context.js`、`task-port.js`、`AndroidControllerService.js`、`androidTaskExecutor.js`、`androidTaskTrace.js`、`tool-catalog.js`，验收驱动改了 `verify-android-m5-legado.cjs`。生产代码哈希已变，此前所有真机结论都不覆盖本版。
