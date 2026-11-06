# M5 独立证据采集修复与冻结复验

2026-11-06，续接 Claude Code 会话 `07dbfe45-d3a5-4dc5-a53d-5de615f87d02`。最新冻结协议 v5：**20/20 执行、独立采集匹配 20/20、任务与独立核验联合通过 19/20、1 失败、0 未执行，exit 1，NOT_PASSED**。第 15 轮任务在完成证据采样中触发 `UI_CONTEXT_CHANGED`，虽稍后独立读到匹配结果，仍保留失败。第二个 App 尚未扩展。

## 批次结果

| 批次 | 执行/计划 | 联合通过 | 失败 / 未执行 | 结论 |
| --- | --- | --- | --- | --- |
| [历史 v1](../../artifacts/android-m5-continuation-2026-11-06/legado20/results.jsonl) | 20/20 | 13/20 | 7 / 0 | 独立 XML 无效；当时缺分类信息，不能逐个追认为 idle timeout |
| [CLI 有界重采 v3](../../artifacts/android-m5-independent-2026-11-06/acceptance20/results.jsonl) | 20/20 | 15/20 | 5 / 0 | 4 轮两次 idle timeout；1 轮任务完成未证明；9 次第二读恢复 5 次 |
| [采样器 v4](../../artifacts/android-m5-independent-2026-11-06/acceptance20-snapshot/results.jsonl) | 1/20 | 0/20 | 1 / 19 | 首轮采样进程退出 1，按协议停止；不补跑 |
| [最新 v5](../../artifacts/android-m5-independent-2026-11-06/acceptance20-snapshot-v5/results.jsonl) | 20/20 | 19/20 | 1 / 0 | 独立匹配 20/20；任务完成 19/20；完整准入仍未通过 |

各批次都有独立目录、协议、退出码和轨迹。不同批次通过率不能直接证明统计上的改善，历史失败没有删去或回填。[evidence-final.json](../../artifacts/android-m5-independent-2026-11-06/evidence-final.json)包含结果汇总与关键文件 SHA-256。

最新批次共 60 个原子动作、额外动作尝试 0、模型调用 0；20 份轨迹无查询值泄露。51 个冻结文件（含采样源码、构建脚本、驱动和 JAR）逐轮及结束后保持一致。独立读取耗时 800–1380ms，中位数 898ms；仅 1 次遍历因子节点消失而从根重采，所有轮次仅启动一次独立采样进程。临时 JAR 删除和采样进程消失均已核验。生产控制器文件相比 v3 未变，仅验证驱动与新增采样工具变化。

## Evidence → Finding → Path

| Evidence | 观察与 Finding | Path / 处理 |
| --- | --- | --- |
| E1：[完整路径诊断](../../artifacts/android-m5-independent-2026-11-06/diagnostic5/results.jsonl) | 第 3、5 轮 CLI 退出 0、stdout 33 字节、无 XML、明确 idle timeout，约 11.7 秒。F1：本次缺失来自 CLI 全局 idle 等待失败，不是已证实的解析器问题 | `RunTask → cleanup → uiautomator dump`；结构化分类后，仅明确结束的 idle 读取允许重采一次 |
| E2：[Looper 异常栈](../../artifacts/android-m5-independent-2026-11-06/snapshot-diagnostic5b.json)、[修复后读取](../../artifacts/android-m5-independent-2026-11-06/snapshot-diagnostic6.json) | 第 4/5 版重复初始化主 Looper；移除后第 6 版成功读取。F2：这是原型调用错误，不能推断 ROM 禁止该 API | 系统 `UiAutomationShellWrapper.connect` 自己准备 Looper；原型不重复准备 |
| E3：[动态树失败](../../artifacts/android-m5-independent-2026-11-06/snapshot-diagnostic3/results.jsonl) | 第 2 轮 `snapshotStage=TREE / TREE_CHANGED`，无半成品 XML。F3：动态列表遍历时子节点消失 | 丢弃该次未完成 XML，在同一连接中重新取根，最多 3 次、共 3 秒；仅此错误可重采 |
| E4：[v5 协议](../../artifacts/android-m5-independent-2026-11-06/acceptance20-snapshot-v5/protocol.json)、[完整结果](../../artifacts/android-m5-independent-2026-11-06/acceptance20-snapshot-v5/results.jsonl) | 独立匹配 20/20，1 次内部树重采，无采样失败。F4：新采集路径在本设备本批通过；整体 19/20 | 不等全局 idle，完整遍历后用独立 DOM 解析校验唯一结果容器、容器内可见匹配条目、精确输入值 |
| E5：[第 15 轮轨迹](../../artifacts/android-m5-independent-2026-11-06/acceptance20-snapshot-v5/traces/72bb98c3-7bf8-4762-91cf-459fb9ff524c.jsonl) | 三动作 verified；完成阶段多次页面摘要变化，随后 `UI_CONTEXT_CHANGED`。F5：任务端采集前后上下文未通过；具体不一致字段未保留 | `captureGraph` 检查窗口/包/尺寸/旋转、epoch 和图上下文；不能从错误码认定某个具体字段，也不以晚到独立结果洗绿 |
| E6：[专项测试](../../artifacts/android-m5-independent-2026-11-06/final-tests.log)、[退出码](../../artifacts/android-m5-independent-2026-11-06/final-tests.exit.txt) | **21/21**，0 失败/取消/跳过，exit 0。F6：分类、无输入泄露、重采边界、远端 JAR 摘要、退出及删除核验有离线覆盖 | 驱动、设备验收工具及 reader 生命周期测试；不替代全部 Android 测试或跨 ROM 准入 |

E1–E6 支持的上述有限结论置信度高。F5 的具体上下文变化原因仍未确定。v3 第 20 轮的 `TASK_COMPLETION_UNPROVEN` 同样保留：轨迹不含每次完成谓词，不能区分条目晚到与页面持续变化。

## 最终实现及边界

[验收驱动](../../scripts/verify-android-m5-legado.cjs)保存退出码、信号、允许列表内的进程错误、耗时、字节数、XML 包络、失败阶段及树重采次数。原始 XML、stdout/stderr、查询值、自由错误文本不落盘。独立采集前先写任务结果，避免核验失败掩盖任务状态。

默认 CLI 路径保留 v3 的最多 2 次读取、共享 30 秒准入截止、单次最多 20 秒、间隔 200ms；仅退出 0、无信号/进程错误、无 XML 且明确 idle 错误时再读。显式 `--snapshot-jar` 选择 v5 验证工具：唯一临时路径、上传后 SHA-256 校验、单次进程最多 15 秒、设备 watchdog 10 秒、等非空根最多 2 秒、内部树读取最多 3 次/3 秒。每次进程前后检查唯一进程名，退出未证明就停止；清理需同时证明进程不存在和文件删除。每次前后复核亮屏/解锁/Legado 前台。

30 秒是独立结果的准入截止；外围安全 gate 和退出核验各自有界，不能描述成所有命令硬终止的墙钟上限。未知传输、进程超时、树超限、错误结果均不重放任务或输入动作。JAR 仅用于验证，不进入生产控制器后端。

**完整遍历不等于原子快照，也不证明页面静止。** 当前只在遇到缺失子节点、导致 XML 不完整时丢弃该次结果；并非任意文案变化就丢弃。目标相关的局部取证是合理后续方向，但仍须覆盖输入值、唯一容器及条目归属，不能仅看到一个匹配节点就宣布完成。任务端目前还使用整页摘要稳定等待；这是与 XML 采集完整性不同的限制，本次未修改它或放宽上下文校验。

此前“压缩 XML 写临时文件再 cat 能解决 idle”没有充分证据，且未验证实现有读取旧文件风险，已撤回。快照仅保存在产物目录 `rejected-file-capture-runner.cjs` / 对应 tests，不参与任何批次。所有开发失败、设备离线和锁屏停止均保留。短暂设置的充电常亮已恢复为 0；最终设备检查未发现本实验采样进程或 JAR 残留。

## 复现和下一步

从仓库根目录执行，构建与实验输出目录必须尚不存在；手机须在线、亮屏且解锁。以下命令中的地址是本次用户提供的新端口，变化后需使用实际地址。

```powershell
node --test tests/android-independent-snapshot.test.js tests/android-m5-legado-runner.test.js tests/android-m5-device-runner.test.js
node scripts/android-independent-snapshot/build.cjs F:/AndroidSdk artifacts/android-m5-independent-2026-11-06/snapshot-rebuild
node scripts/verify-android-m5-legado.cjs --serial 192.168.137.193:41117 --query 魔女之旅 --runs 20 --snapshot-jar artifacts/android-m5-independent-2026-11-06/snapshot-rebuild/independent-snapshot.jar --output artifacts/android-m5-independent-2026-11-06/acceptance-reproduction
```

下一步先补齐 `UI_CONTEXT_CHANGED` 的脱敏字段差异证据，再判断是安全边界真正变化还是探测缺口；同时评估任务完成等待是否应只围绕声明的目标结构。任何策略变化均另立版本和完整验收批次，保持旧分母。Legado 完整通过后才扩展第二 App。

本次未调用真实模型、未提交或推送。此前 1952/1952 限定 Android+宿主回归及靶场 8/8 保留为历史证据，未重复运行。
