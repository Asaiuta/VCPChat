# J5.3 统一夹具回放：实现前冻结契约

2026-11-07。范围：把 search-v8 / toggle-v1 / route-v1 三个已集成任务族的离线控制场景收敛为一份声明式回放目录与一个统一入口。只新增测试夹具与解释器，**不修改生产代码**，不发真实模型请求，不操作真机。三个策略版本保持 `calibrated:false`。

## 不做什么

- 不从生产脱敏轨迹重建 UI：轨迹只有摘要/计数/引用，回放世界是独立维护的手写合成世界。
- 不以“同输入两次同输出”作为判据；固定回答不证明真实模型质量。
- 不替代各任务族专项测试（边界反例矩阵仍在专项中），不删除 `cases.json` 旧目录。
- 不新增设备 RPC，不引入任意脚本：目录里不允许函数或自由文本动作。

## 目录格式（`tests/fixtures/android-jev/replay.json`，schemaVersion 1）

顶层：`schemaVersion`、`provenance`、`transforms`（封闭词表及含义）、`cases`。

每个用例键为封闭集合，出现未知键即失败：

| 键 | 含义 |
| --- | --- |
| `name` | 全目录唯一 |
| `family` | `search` / `toggle` / `route` |
| `source` | `{kind:"handwritten-synthetic", derivedFrom:<仓内测试文件>}`，文件必须存在 |
| `transforms` | 本用例应用的去标识化变换，须为顶层词表子集 |
| `world` | 任务族封闭初态：search `{back?,ime?}`；toggle `{checked?}`；route `{prefilled?:[ref]}` |
| `task` | 任务覆盖，仅 `budget` / `assistance` |
| `answers` | 第 n 次 Jev 调用的注入回答：`c0`、`escalate`、`role:<ref>`、`invalid`、`uncertain`；用尽后为 `c0` |
| `transitions` | 环境转移：`{on:"model", call:n或[n…], effect, afterCaptures?}`、`{on:"write", index:n, effect}` |
| `assistance` | `{advice:"select"/"reobserve"/"stop", effect?}`、`{human:"accept"/"reject", effect?}` 或 `{service:false}` |
| `expect` | 独立判据，见下 |

效果词表：`bump-version`（无关装饰变化，触发 stale）、`satisfy`（仅 toggle：外部把开关拨到目标值）、`no-effect`（写派发成功但世界无变化）、`lost-transport`（世界已变化但传输抛错）。

## 判据（逐条，独立于任务回执）

1. `writes`：设备侧实际写序列逐条相等，归一为 `{op:"back"|"fill"|"tap"|"key", target, value?}`；`value` 是输入引用名，解释器校验实际写入文本与该引用的原值逐字节一致。
2. `effect`：世界终态，search `{page, query}`、toggle `{checked}`、route `{submitted:null|[refs]}`；读自替身世界状态，不读回执。
3. `status`/`code`、`receipts`（原子回执 outcome 序列）、`modelCalls`、`staleEvents`、`replanCalls`。
4. 轨迹头 `policyVersion` 与回执 `decisionPolicy.calibrated===false`。
5. 隐私：回执、持久轨迹、发送给 Jev 的模型输入中不得出现输入原文、私有标签、XML 类名。

**判别力对照**：每个 `completed` 且有写入的用例，另以“全部回答 `escalate`、无升级”重跑，实际写序列和世界终态必须与期望不同；否则说明判据不依赖决策，用例无效。

**目录自检**：每族至少含正常完成、stale 恢复、硬停止、unknown 写、升级通道各一例；任一缺失或词表越界即失败。

## 验收

`node --test tests/android-jev-replay.test.js` 全过；再跑既有 Jev/Service 限定集合确认无回归。记录退出码、日志与运行前后生产文件 SHA-256（必须一致）。期望值以首次运行与专项测试交叉核对，若与专项结论矛盾，先判定是期望错误还是实现错误，不改注入答案追绿。
