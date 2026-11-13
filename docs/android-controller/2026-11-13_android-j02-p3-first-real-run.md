# P3：AndroidWorld 公开基准首次真实执行（AndroidWorld MarkorCreateNote）

2026-11-13。范围：J0.2 正式批次工具在**真实 API 33 模拟器 + 真实 Jev 网关**上的首次执行。档位与数字以 [README 状态表](README.md) 为准；本文只记录本批实际跑过的路径。

**结论先写：trial 真实执行了，但没有被评分。** 批处理器在写 `result.json` 之前被杀，所以该 trial 永远停在「在途未知」，按 J02 契约禁止重放，batch r3 永久 halted。可用的证据是 trace、`initial.xml`、`final.xml` 和 registry；**不可用的是 score**——AndroidWorld 原生检查器从未运行。

## 1. 环境（本批实际建立）

| 项 | 值 |
| --- | --- |
| 模拟器 | `emulator-5558`，`aw_api33`，Android 13，1080×2400，rotation 0 |
| 镜像 | `system-images;android-33;google_apis;x86_64`（本批新装） |
| GPU 后端 | `-gpu angle_indirect`；`swiftshader_indirect` 挂死，`-gpu off` 触发 SystemUI ANR |
| AndroidWorld 检出 | `D:\AI\_research\android_world` @ `55ddaf5e`，tracked 文件零改动 |
| Python 运行时 | `D:\AI\_venvs\androidworld-3.12`（Python 3.12.14），`isolated:true`、`missing:[]` |
| 被测 App | `net.gsantner.markor`（`net.gsantner.markor_146.apk`，11,067,299 字节），装在 `/data/app` |

`android_world` 自身的 `pip install .` 是必需的：检出不带生成的 `_pb2.py`，直接 import 会 `ImportError: cannot import name 'state_pb2'`。

## 2. 三处工具缺陷（本批修复，都在 `scripts/android-j02/`）

这三处不是环境没配好，是工具边界与实际平台冲突，全部先复现再改：

1. **`device.cjs` 的 `fileSha` 只接受 `/data|/sdcard|/storage`**。`pm path com.android.settings` 返回 `/system_ext/priv-app/...`，`com.google.android.contacts` 返回 `/product/app/...`，于是四个首批任务全部 `J02_DEVICE_PATH`，无法冻结。改为覆盖全部 Android 分区根（`system`/`system_ext`/`product`/`vendor`/`apex` 等），保留绝对路径与 `..` 检查。先确认 `sha256sum` 在这些分区上可读。
2. **`verifyCheckout` 与 `benchmark_bridge.py` 互相死锁**。桥接把 checkout 插到 `sys.path` 首位，所以 `android_world` 必须从 checkout 导入；而生成 `_pb2.py` 又让 checkout 变脏，`J02_BENCHMARK_DIRTY` 直接拒绝。改为只容忍那四个生成文件（`GENERATED_PROTO` 白名单），tracked 改动与其它未跟踪文件仍 fail closed，并把白名单文件一并哈希进批次身份。
3. **`runtime_identity` 依赖 `sys.path`**。它用 `importlib.metadata.distributions()` 枚举分发，而 `dispatch()` 在验证前已插入 checkout；checkout 里的 `android_world.egg-info` 让分发数多一个，身份比对恒假 —— 报错是 `J02_PYTHON_RUNTIME_CHANGED`，但 17069 个文件的哈希逐个比对**零差异**。改为只统计位于运行时根内的元数据。

第 3 条值得单列：如果只看 `files` 数组会得出「身份没变、代码有 bug」的错误结论，真正的差异在 `distributions`。

## 3. App snapshot 前置

AndroidWorld 的 `_initialize_apps` 会 `restore_snapshot`，缺快照只打 warning 并继续，但 `benchmark_native.WorldSession` 把这种情况升级成 `NATIVE_SETUP_UNPROVEN`。快照由 `setup.setup_app()` 写（不是 `AppSetup.setup()`——后者只管应用内引导）。本批执行了 `setup.setup_app(apps.MarkorApp, env)`，生成 `/data/data/android_world/snapshots/net.gsantner.markor`。

**未处理的警告：** `Failed to automatically setup app markor: Target text "Allow access to manage all files" not found.` 快照是在这个中间状态拍的。它不影响本轮（Name 字段写入成功），但**该快照是否等价于官方 setup 结果未验证**，后续批次要么手工对齐引导步骤，要么接受这个偏差并记录。

## 4. 实际执行

batch `androidworld-markor-note-p3-r3`，trial `t0-candidate`，任务 `MarkorCreateNote` seed 0：

```
goal: Create a new note in Markor named 2023_05_03_ready_elephant.md
      with the following text: Don't cry over spilled milk.
```

真实 Jev 调用 3 次，返回模型全部 `jev-1.14.0`（请求别名 `jev-latest`）：

| 轮 | 选择 | 概率 | margin | 输入/输出 token | 耗时 |
| --- | --- | --- | --- | --- | --- |
| 1 | `c14`（Tap n13） | 0.97 | 0.95 | 6465 / 364 | 4097ms |
| 2 | `c1`（Fill n3, `fileName`） | 0.97 | 0.95 | 7258 / 490 | 3935ms |
| 3 | `invalid` | 0.81 | 0.70 | 7286 / 493 | 3807ms |

写入两次：

- `Tap n13` → `dispatched`（**不是 verified**）
- `Fill n3 inputRef=fileName` → `verified`

结束：`escalation TASK_JEV_UNCERTAIN` → `stopped / unknown`。剩余预算 `6 动作 / 148 观察 / 9 模型调用`，说明是**按置信度停止，不是预算耗尽**。

## 5. 独立旁证

`final.xml` 显示创建对话框内 `Name = 2023_05_03_ready_elephant.md`，与 `Fill` 的 `verified` 一致 —— 两个独立来源吻合。但对话框里文本内容字段仍是空的，也正因为如此模型才在下一轮给不出 ≥0.9 的选择。

`initial.xml` 是 Markor 主视图（`/storage/emulated/0/Documents`），`final.xml` 是新建对话框，两者页面摘要不同，动作确实改变了页面。

## 6. 没有做到的

- **没有分数。** 原生检查器未运行，任务成功与否未判定。不能把「文件名填对了」写成任务通过——任务还要求写入正文。
- 批处理器被中断，`result.json` 缺失，journal 只有 `started`。按契约该 trial 在途未知、不可重放，batch r3 保持在 halted。
- `Tap` 只有 `dispatched` 没有 `verified`，这是当前验证覆盖的真实缺口，不是本批引入。
- 单条 trial、单任务、单 ROM/模拟器镜像，`calibrated:false`，`acceptanceSamples:0`。不是准入结论。
- 三个离线测试仍全绿（`android-j02-*` 61/61，benchmark 相关 33 通过 1 跳过），但那证明的是控制逻辑，不是本批的真机行为。

## 7. 后续

1. 机器重启后模拟器已消失（`adb devices` 为空）。重建要按 §1 的参数，`-gpu angle_indirect` 与 `-port 5558`（**偶数** console 端口；`benchmark-adapter` 的 `consolePort%2!==0` 会拒绝奇数）都是必需的。
2. `final.xml` 已经说明失败点在「正文未填」，值得直接看第 3 轮候选集为什么没有可区分的正文输入候选——这是语义/候选问题，不是模型问题。
3. 重跑必须用新 batchId 与新 datasetId，不能复用 r3。
