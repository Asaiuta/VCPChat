# AndroidWorld / AndroidLab 首轮接入预检

本轮已下载并固定两套官方源码，完成全量任务登记、首批选题和本机环境预检。**本文记录的历史产物是离线准备包，不是 J0.2 可执行 manifest。** 后续执行适配见[适配报告](2026-11-08_public-benchmark-adapter-report.md)；当前设备和模型执行次数、目录规模及回归结果统一见[文档索引](README.md)。生产策略仍为 `calibrated:false`。

## 查看现有产物

| 套件 | 固定源码 | 完整清单 | 首批任务及阻塞 |
| --- | --- | --- | --- |
| AndroidWorld | [55ddaf5](https://github.com/google-research/android_world/tree/55ddaf5edc6f6c25673aed343907d5b9dca66f84)，Apache-2.0 | [catalog.json](../../artifacts/android-public-benchmarks-2026-11-08/androidworld/catalog.json) | [preflight.json](../../artifacts/android-public-benchmarks-2026-11-08/androidworld/preflight.json) |
| AndroidLab | [4bfe108](https://github.com/THUDM/Android-Lab/tree/4bfe108cf3883b710e8e5c6fba288161c830e504)，MIT | [catalog.json](../../artifacts/android-public-benchmarks-2026-11-08/androidlab/catalog.json) | [preflight.json](../../artifacts/android-public-benchmarks-2026-11-08/androidlab/preflight.json) |

两个目录均包含 `catalog.json`、`selection.json`、`preflight.json` 和逐文件摘要 `identity.json`。清单保留原始任务 ID、目标模板、App/包名、检查器位置及源码身份；AndroidLab 的配置原文作为数据保留，包括 `adb_query`，不会执行其中的命令。原始许可证随 catalog 保存。

AndroidWorld 从 `TaskRegistry._TASKS` 及信息检索 `tasks.textproto` 读取，排除上游已注释停用的电话任务和另一个 MiniWoB 套件；不把所有 Python 类都计作任务。AndroidLab 从全部 `evaluation/config/*.yaml` 读取，并逐项解析 `function_map` 指向的评分器。任务总数和固定版本不符即拒绝产出，不能静默漏题。

首批清单在查看任何模型成绩前固定，属于可行性选择，不代表两套基准的完整覆盖：

| 套件 | 任务 ID | 覆盖目标 |
| --- | --- | --- |
| AndroidWorld | `SystemWifiTurnOn`、`SystemBluetoothTurnOff` | 系统开关 |
| AndroidWorld | `ContactsNewContactDraft`、`ContactsAddContact` | 多字段输入；草稿与保存结果的区别 |
| AndroidWorld | `MarkorCreateNote`、`SimpleCalendarAddOneEvent` | 文本保存、日期/时间/时长填写 |
| AndroidWorld | `OsmAndMarker` | 地点搜索及标记；不等同起终点路线任务 |
| AndroidLab | `setting_7`、`setting_3` | 深色模式、蓝牙 |
| AndroidLab | `contacts_2`、`clock_1` | 姓名/电话/邮箱及带标签闹钟 |
| AndroidLab | `map_1`、`map_12` | 指定两点步行时间/距离查询、从当前位置导航 |

未选题仍保存 ID 和排除原因。选中题全部为 `not_run`；成功率、风险率为 `null`，独立验收样本为零。每个上游任务模板固定一个 `clusterId`，参数变体和重复执行不能直接累加为独立样本；不同模板之间也没有自动获得独立性证明。

## 重新生成准备包

入口是 [android-j02-batch.cjs](../../scripts/android-j02-batch.cjs) 新增的 `benchmark-prepare`。依赖 Node、Git、Python 3.10+，AndroidLab 静态 YAML 解析另需 PyYAML；这些只用于离线准备，不成为 AndroidController 生产依赖。本轮使用已有 Python/PyYAML，未安装上游模型 SDK 或 AndroidEnv。

在 VCPChat 根目录执行；下列 checkout 已在本轮建立，输出目录必须尚不存在：

```powershell
node scripts/android-j02-batch.cjs benchmark-prepare androidworld D:/AI/_research/android_world docs/android-controller/j02/androidworld-exploration-selection.json artifacts/androidworld-next
node scripts/android-j02-batch.cjs benchmark-prepare androidlab D:/AI/_research/Android-Lab docs/android-controller/j02/androidlab-exploration-selection.json artifacts/androidlab-next
```

最后可选参数为 Python 可执行文件路径。原始代码源和首批选择分别固定于 [source lock](../../scripts/android-j02/benchmark-sources.json)、[AndroidWorld 选择](j02/androidworld-exploration-selection.json)、[AndroidLab 选择](j02/androidlab-exploration-selection.json)。新版本必须重新审查并更新 source lock，不能从 `main` 自动继承旧目录的身份。

准备过程检查 origin、提交和 Git 工作区，记录当前检出的文件 SHA-256，提取前后再比对；来源被修改、缺注册任务、选择重复或未知任务、输出已存在均拒绝。摘要覆盖**实际检出的源码**，不表示下载或冻结了官方模拟器镜像、App APK 或数据快照。

Python 仅做 AST 和安全 YAML 解析，不 import 上游模块、不调用任务的参数生成器、不执行任务 setup 或 scorer。动态 `goal`、运行时包名等无法静态确定的字段保留 `null` 或空列表，原始实现位置和源码仍保留。本轮 AndroidWorld 有部分动态字段待原生环境实例化；不能把目录完整度误认为任务已可执行。

## 实际执行还缺哪些条件

当前 Windows 主机发现的镜像为 API 36.1 / Google Play，未发现 API 33；Python 环境没有 AndroidEnv，Docker 不在 PATH。该环境探测只读取本机文件及模块安装信息，没有连接设备或启动模拟器。

AndroidWorld 官方推荐 Pixel 6 / API 33，并依赖 AndroidEnv、辅助组件及特定 App 数据；其 `initialize_task`、`is_successful`、`tear_down` 不能由 J0.2 现有的 force-stop/launch 和 raw-UI 检查等价替代。SQLite、文件系统和系统设置检查也不能降级为模型 Done 或“页面出现目标文本”。

AndroidLab 官方支持 Linux x86_64 Docker/KVM 或 macOS arm64 的预制镜像；本轮环境不符合这两种宿主配置。其镜像包含固定账号无关的应用与初始数据，不能只安装同名 App 就宣称复现。官方 macOS 准备文档目前还提示镜像导入方法存在兼容性问题。

AndroidLab 评分需额外处理：

- 部分题目的 `judge` 调用 `self.check_answer`，继而通过 `detect_answer` 调用裁判模型。本轮检测数量见索引；其余题目仅表示未在该静态调用点发现，不保证绝无模型调用。
- `generate_result.py` 主入口会执行 `detect_answer_test(args)`，发送 `hello! who are you`。本轮没有调用它；未来接入必须绕过这个探针并按真实评分工作负载独立记账。
- 回答查询题需要 Agent 的答案输出通道，当前通用循环的有限动作和 Done 并不提供这个通道。
- 保留原版分数与我们独立检查器的结果两列；原版评分器尚未按 J0.2 的未知值、误报完成和逐写风险要求完成审查。

后续顺序：准备匹配的独立基准环境；接通原版任务生命周期与现有 `RunTask`；保留官方 oracle 并增加独立证据；实例化任务参数，冻结起始数据、预算、模型版本和对照臂后，再创建新的探索执行批次。公开基准结果限定为该基准环境，不继承为 PJZ110 / Android 17 / 单 ROM 的真机准入。

## 验证证据

| Evidence | Finding | Path |
| --- | --- | --- |
| 两套官方 checkout 的完整导出及各目录 `identity.json` | 注册任务与配置条目全量保留，首批选择可复查 | [导入器](../../scripts/android-j02/benchmark.cjs)、[静态解析](../../scripts/android-j02/benchmark-extract.py) |
| [Python 测试](../../tests/android-benchmark-extract.test.py) | 不执行顶层 Python；继承次序、带引号 proto、非法 YAML/越界路径被验证 | `Source` / `proto_tasks` / `lab` |
| [Node 测试](../../tests/android-j02-benchmark.test.js) | 来源漂移、漏题、重复选题不能静默通过；无环境和 adapter 时保持 not_run；准备包不能进入正式 freeze | CLI / `verifyCheckout` / `plan` |
| [本轮测试与摘要](../../artifacts/android-public-benchmarks-2026-11-08/verification.json) | 新增准备功能及原有 J0.2 冻结、审计、统计和 worker 回归结果 | [索引](README.md)统一维护数量 |

离线复现，不触发 upstream 模型或设备调用：

```powershell
python -B tests/android-benchmark-extract.test.py
node --test --test-concurrency=4 tests/android-j02-benchmark.test.js tests/android-j02-batch.test.js tests/android-j02-admission.test.js tests/android-j02-statistics.test.js tests/android-j02-worker.test.js
```
