# J5.3 统一夹具回放：实现记录

2026-11-07。契约见 [冻结契约](2026-11-07_jev-j53-replay-contract.md)，证据见 [evidence.json](../../artifacts/android-jev-j53-replay-2026-11-07/evidence.json)。本批只新增测试夹具、解释器与文档，**未修改生产代码**；search-v8 / toggle-v1 / route-v1 均保持 `calibrated:false`。

## 交付

- [replay.json](../../tests/fixtures/android-jev/replay.json)：24 个声明式用例（search 7、toggle 9、route 8），每例带来源文件、去标识化变换、环境转移、注入回答、升级通道与独立预期。目录只含数据，未知键、越界词表、来源文件不存在均拒绝。
- [android-jev-replay.cjs](../../tests/helpers/android-jev-replay.cjs)：把封闭词表映射到既有三类合成世界（`actionWorld` / `toggleWorld` / `routeWorld`），走生产 Service → executor → port → 轨迹链路；把设备侧写归一为 `{op,target,value}`，`value` 只在实际写入字节与输入原值一致时才记为引用名，否则记 `mismatch`。
- [android-jev-replay.test.js](../../tests/android-jev-replay.test.js)：目录自检 + 逐例回放 + 11 个反事实对照。

## 判据

逐条比较实际写序列、世界终态（读替身状态，不读回执）、停止码、原子回执、模型/stale/升级调用数、轨迹 `policyVersion`、`calibrated:false` 和隐私（回执、持久轨迹、发给 Jev 的输入均不含输入原文、私有标签与 XML 类名）。

每个带写入的 completed 用例另以“全部 escalate、无升级”重跑：任务必须正常终止，且写序列与终态都须不同于期望，证明判据依赖注入决策。另做 4 项变异检查（[日志](../../artifacts/android-jev-j53-replay-2026-11-07/mutation.log)）：调换填入顺序、改写输入字节、no-effect 时终态取自世界、去掉 stale 转移，判据均能识别。

## 失败分类与修正

首轮 [replay-r1](../../artifacts/android-jev-j53-replay-2026-11-07/replay-r1.log) exit 1，均为解释器侧问题，未改生产或注入答案：

1. 环境错误：`actionWorld` 无 Back/IME 时仍声明空 `searchActions`，search-v8 按契约拒绝为 `TASK_INVALID`；解释器对纯表单任务省略该字段。
2. 期望错误：反事实对照把被拒绝的任务当作“不同结果”放行；现要求先到达 completed/stopped。
3. 期望错误：目录自检的删减用例同时去掉两种覆盖；改为只删 unknown 写用例，断言唯一缺口 `route:unknownWrite`。

## 回归

| 范围 | 结果 |
| --- | --- |
| 回放专项 | 36/36，exit 0 |
| VCPChat 限定集（J4a 选择集 + 回放，35 文件） | 944/944，exit 0，131s |
| VCPToolBox（7 文件） | 161/161，exit 0 |

选择集见 [final-selection.json](../../artifacts/android-jev-j53-replay-2026-11-07/final-selection.json)。

**并行变更说明。** 本批期间另一会话完成了 [维护性整改](../../artifacts/android-maintainability-cleanup-2026-11-07/result.md)（生产写入 18:34–18:40，含策略表合并与旧轨迹版本删除），并曾改动本批测试一次（账本 #2154，已被 #2155 取代）。因此 `production-before.json` 不是本批前态；最终回归 19:12:53 开始，晚于最后一次生产写入（18:40:23），回归后复核生产哈希零差异。结果对应整改后的当前代码。

## 边界

手写合成世界，不从生产脱敏轨迹重建 UI，不覆盖未走过的分支；固定回答不证明真实模型质量。无真实上游请求、无真机。各任务族边界反例矩阵仍在专项测试中，回放目录不替代它们。下一步可选：J3.2 其余导航、J3.3 多部分目标、J4 其它字段类型（各自独立契约），或进入 J0.2 真实校准协议冻结。
