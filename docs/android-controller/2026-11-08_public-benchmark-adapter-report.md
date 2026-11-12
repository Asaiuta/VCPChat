# 公开基准执行适配

正式 J0.2 工具现在可以绑定公开任务，在现有 RunTask 前后调用初始化、原版评分与清理，并把官方判断、独立检查和完成声明分别记录。本批完成范围和验证数量统一见[索引](README.md)。这是适配探索工具；匹配模拟器、初始数据、真实检查器绑定和原 Jev 对照仍未就绪，未进行设备或模型执行。

## 已接通的边界

[冻结契约](2026-11-08_public-benchmark-adapter-contract.md)限定了当前支持范围。

| 套件 | 执行方式 | 证据限制 |
| --- | --- | --- |
| AndroidWorld | 调用原版生成器物化参数；持久 Python 实例执行 TaskEval 初始化、评分和清理；日历行使用白名单 dataclass 编解码 | 生命周期调度与参数编解码已有离线替身验证；本机尚缺 AndroidEnv 等原生依赖及匹配镜像，未完成真实原生环境联调 |
| AndroidLab 确定性任务 | 使用原版 XML 压缩器和所选 judge 的精确 AST；专用模拟器按冻结命名快照恢复 | 原版确定性评分已在无网络、无子进程的夹具中验证；只评分最终状态，未复现原版逐轨迹聚合及官方镜像启动器 |
| AndroidLab contacts_2 | 显式阻塞 | 提示要求 gmail 地址，judge 检查 qq 地址；不改任务或检查器追分 |
| AndroidLab map_1 | 显式阻塞 | 尚缺任务答案通道、裁判模型独立身份与调用记账；不调用带探针的上游评分入口 |

为保持当前批次的单 App 范围，初始化后会启动目标 App，再校验独立起始状态。AndroidWorld 原版从主屏开始的导航步骤因此不在当前范围；AndroidLab 快照恢复也不等于官方 Docker 启动器。报告固定标记 `adapted_exploration_not_official_leaderboard`，不能直接与官方榜单比较，更不能继承到 PJZ110 真机准入。

蓝牙 judge 会把非 `"1"` 值都判为成功；桥保留其原输出，但非 `"0"` / `"1"` 的读数记为 unknown。地图 map_12 的 judge 仅检查 Stanford / My location / Start 文本，不能证明已开始导航。独立结束检查器必须按真实目标绑定，不能把这个弱谓词抄成完成证明。

## 离线准备与绑定

[命令入口](../../scripts/android-j02-batch.cjs)新增 runtime、materialize、coverage、bind。前几项只读取本机环境或调用任务参数生成器，不启动设备或模型。下面使用本批已安装的隔离 Python，创建一个新的 AndroidLab 准备目录；若目录已存在，换新的输出目录，保留历史产物。

```powershell
$taskOutput = 'artifacts/android-public-adapter-reproduce'
$taskPython = 'artifacts/android-public-adapter-2026-11-08/python-env/Scripts/python.exe'
New-Item -ItemType Directory -Path $taskOutput
node scripts/android-j02-batch.cjs benchmark-prepare androidlab D:/AI/_research/Android-Lab docs/android-controller/j02/androidlab-exploration-selection.json "$taskOutput/androidlab" $taskPython
node scripts/android-j02-batch.cjs benchmark-runtime androidlab $taskPython "$taskOutput/runtime.json"
node scripts/android-j02-batch.cjs benchmark-materialize "$taskOutput/androidlab" setting_3 1 $taskPython "$taskOutput/setting_3.json"
node scripts/android-j02-batch.cjs benchmark-coverage "$taskOutput/androidlab" "$taskOutput/coverage.json"
```

`benchmark-runtime`记录隔离解释器、标准库、依赖文件及摘要。缺依赖会记录 missing，不宣称 executionReady。桥使用隔离导入模式，启动及评分前重新核对运行时，源码、Python 和资产同时纳入正式批次冻结。

可执行绑定使用[manifest schema](j02/batch-manifest.schema.json)：

- 顶层 `benchmark` 指定准备包、checkout、Python、runtimeIdentityFile、不可变镜像/数据资产路径、模拟器端口、命名快照及初始化/评分/清理截止。AndroidWorld 使用原版 app snapshot，snapshotName 为 null；AndroidLab 指定已建立的专用快照。资产必须指向实际环境来源，不能用下载说明代替镜像或数据字节。
- 每个 task 的 `benchmark` 指定上游 taskId 和物化 caseFile。family 与 clusterId 均为 `suite.taskId`；参数变体仍属于同一模板，不能更名增加独立样本。
- 所有可运行臂的目标必须与物化目标一致，输入、起始状态及检查器遵守现有配对规则。当前执行臂使用 ui_task；rules 无公平绑定时显式排除，原 Jev checkout 未准备时显式 unavailable。
- `stage`只能是 exploration。未绑定的所选项目和未选择的目录项目都在 coverage 中保留；批次报告给出各臂官方 pass / fail / unknown / not_run，独立准入样本始终为空。

`benchmark-bind`校验已编写的 manifest 并输出规范化 manifest 与覆盖清单；它不补造初始状态或检查器。随后使用现有 freeze → run → audit → report。run 仍需显式 `--real`，每次只执行一个 trial，等待逐写独立审计；中断不会自动重放。当前尚未产生真实环境绑定，所以本批没有可运行的真实 manifest。

## 生命周期与失败处理

独立最终 XML 在原版评分前保存，避免评分器改变界面后覆盖现场。成功必须同时满足原有宿主执行证据、独立检查、官方评分和清理；官方分数不能抵销独立失败。参数、源码或环境漂移停止批次。初始化部分失败会尝试清理；连接所有权不明、桥超时或清理失败均不声称排干。

JSONL 桥限定初始化、评分、清理次序，并对输出大小、错误码和请求编号进行检查。Windows 超时终止包含子进程树；即使发出终止请求，也不把它当成清理成功。实际设备排干仍需后续环境联调验证。模型调用仍只经生产 Jev 通道，桥无 Agent、裁判模型或探针请求。

## 复核证据

| Evidence | Finding | Path |
| --- | --- | --- |
| [绑定和 worker 集成测试](../../tests/android-j02-benchmark-adapter.test.js) | 初始化/RunTask/独立捕获/原版评分/清理衔接；失败保留，漂移停批；报告保留未运行项目 | [绑定器](../../scripts/android-j02/benchmark-adapter.cjs)、[worker](../../scripts/android-j02/worker.cjs) |
| [Python 测试](../../tests/android-benchmark-native.test.py) | 原版 AndroidLab 确定性真假判断、压缩器、异常读数；World 生命周期对象与类型化参数替身验证 | [原生适配](../../scripts/android-j02/benchmark_native.py)、[持久桥](../../scripts/android-j02/benchmark_bridge.py) |
| [完整验证记录](../../artifacts/android-public-adapter-2026-11-08/verification.json) | 正式批次回归与本批新增验证；执行源前后摘要核对 | [索引中的验证数字](README.md) |
| [环境就绪记录](../../artifacts/android-public-adapter-2026-11-08/readiness.json) | 确定性 Python 依赖已安装；缺匹配模拟器、初始资产、真实绑定及原 Jev 基线 | 下一步先准备专用环境，再建立新的探索批次 |

复现测试不连接设备或模型：

```powershell
$env:J02_BENCHMARK_PYTHON = (Resolve-Path 'artifacts/android-public-adapter-2026-11-08/python-env/Scripts/python.exe').Path
$env:J02_ANDROIDLAB_CHECKOUT = 'D:/AI/_research/Android-Lab'
$testFiles = @(rg --files tests | Where-Object { $_ -match 'android-j02-.*\.test\.js$' })
node --test --test-concurrency=4 @testFiles
& $env:J02_BENCHMARK_PYTHON -B tests/android-benchmark-native.test.py -v
& $env:J02_BENCHMARK_PYTHON -B tests/android-benchmark-extract.test.py -v
```

上游评分测试要求显式指定固定 checkout；未指定时会跳过，不能把该次运行称为原版评分验证。本批实际执行设置了 checkout 和隔离 Python。首次 unittest discovery 没有识别带点文件名，记录保留；随后按文件直接执行，没有修改断言。
