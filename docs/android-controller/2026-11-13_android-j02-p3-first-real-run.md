# P3：AndroidWorld 公开基准首次真实执行（AndroidWorld MarkorCreateNote）

2026-11-13。范围：J0.2 正式批次工具在**真实 API 33 模拟器 + 真实 Jev 网关**上的首次执行。档位与数字以 [README 状态表](README.md) 为准；本文只记录本批实际跑过的路径。

**结论先写：已取得第一个经独立检查评分的 trial（r7，`score=0`、`verdict=fail`）。** 前六轮（r3–r6）分别暴露了快照、前台与启动三类前置缺陷；r7 走完正确路径但正文从未落盘。原稿把原因写成「保存按钮无标签」，那是错的（§8.3 已修正）；真因是本批完成谓词在保存前就成立，并顺带暴露出一处**独立检查判 pass、基准判 fail** 的矛盾（§8.4）。

本轮不改任何生产策略：`calibrated:false`、`acceptanceSamples:0`。这次是**一个任务的一次执行**，不是准入结论。

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

## 8. r3–r7 迭代：每轮的停止点与修复

一轮一缺陷，全部先复现再改；每轮都用新 batchId 与新 datasetId 重新冻结。

| 批次 | 停止点 | 真实原因 | 处理 |
| --- | --- | --- | --- |
| r3 | 进程被中断 | 批处理器在写 `result.json` 前被杀（跨夜） | 在途未知，禁止重放，永久 halted |
| r4 | `J02_START_STATE_UNPROVEN` | 快照拍在 Markor 欢迎引导页，恢复后是引导页不是文件浏览器 | 走完 Intro（滑动 6 次 → `DONE`），重拍快照 |
| r5 | `J02_WRONG_FOREGROUND` | 评分前前台变成 `Application Error: com.google.androidenv.accessibilityforwarder` | 见下「无障碍转发器崩溃」 |
| r6 | `J02_WRONG_FOREGROUND`（0 动作） | `env.reset(go_home=True)` 后前台是 Launcher，而 start 谓词要求 Markor 前台 | `benchmark_native` 在 setup 后启动任务自身 App |
| r7 | `TASK_JEV_UNCERTAIN`，**`score=0` fail** | 完成谓词只查编辑器正文，`Fill` 后即成立，于是「已做完/没做完」两解并存，`operation` 头只给到 0.81；正文从未落盘 | 见 §8.3、§8.4 |

### 8.1 冷启动会回收快照目录

`SNAPSHOT_DATA = /data/data/android_world/snapshots` **不是任何已安装包的数据目录**（`androidworld.apk` 的包名是 `com.example.androidworld`，转发器是 `com.google.androidenv.accessibilityforwarder`）。系统把 `/data/data` 下的孤儿目录当作残留清理，因此**每次模拟器冷启动，快照都会消失**，而 Markor 自身的用户数据（已安装包）保留。实测两次冷启动均复现。→ 每个新批次在冷启动后必须先 `setup_app` 重拍快照。

### 8.2 无障碍转发器崩溃（r5）

`logcat -b crash` 给出 `NullPointerException` in `ContextWrapper.getSystemServiceName` ← `AccessibilityInteractionClient.getInstance` ← `AccessibilityService.getWindows`，发生在转发器初始化线程。设备时钟被 AndroidWorld 冻结在 2023-10-15（`auto_time=0`），这是 `freeze_datetime` 的正常结果，不是本仓改动。重启模拟器后未再复现，但**未做稳定性验证**，属已知残留风险。

### 8.3 保存控件可辨识；真正的缺陷是完成谓词在保存前就成立（修正版）

> **修正**：本节此前写作「五个按钮都没有 text、没有 content-desc、也没有 clickable 属性」。该结论是错的 —— 依据只是判据 XML（`final.xml`），而 `independent-snapshot.jar` **不输出 `content-desc`/`clickable`/`enabled`**。用 `uiautomator dump` 取真实语义树实测：
>
> ```
> resource-id=".../action_save" class="android.widget.TextView" text=""
> content-desc="Save" clickable="true" enabled="true" bounds="[765,138][870,264]"
> ```
>
> 五个按钮的 `content-desc` 分别是 Undo / Redo / View mode / Save / Search。**控件是可辨识的**，模型看到的是 "Save"。

r7 的意图轨迹完全正确，两次写入均 `verified`：

```
Tap n15 (FAB)            dispatched
Fill n3  fileName        verified
Tap n16 (OK)             dispatched
Fill n6  noteText        verified   ← 已在编辑器正文，p=0.96
```

然后第 5 轮 `p=0.81`、`margin=0.64`，低于 0.9 阈值 → `TASK_JEV_UNCERTAIN` 安全停止。`heads` 里只有一条 `operation:Tap` 就抛出了，说明歧义在**操作选择**这一层，不是挑哪个按钮。

真正的原因是**我自己写的完成谓词**。本批 manifest 的 `completion` 与 `finish` 用的是同一条：

```json
{"type":"text","target":{"id":"net.gsantner.markor:id/document__fragment__edit__highlighting_editor"},
 "equals":"Don't cry over spilled milk."}
```

它只要求「编辑器里有这段正文」，因此 **`Fill noteText` 一 verified，完成条件立刻成立**。trace 里直接可见：

```
seq=34  completionMatched=False   ← Fill 前
seq=37  completionMatched=True    ← Fill 后，尚未保存
seq=38  completionMatched=True
seq=39  completionMatched=True
```

于是第 5 轮同时存在「已完成（Done）」与「还没做完（Tap）」两种解释，`operation` 头只能给到 0.81。**歧义是谓词制造的，不是模型能力问题，也不是控件标签问题。**

文件未落盘（`/storage/emulated/0/Documents/Markor` 为空），因为 Markor 需要显式保存；AndroidWorld 判据 `CreateFile.is_successful` 检查文件存在与内容，所以 `score=0`。

### 8.4 独立检查与基准判定矛盾（比 8.3 更严重）

r7 的 `result.json` 同时写着：

```json
"independent": { "verdict": "pass", "checks": [true] },
"benchmark":   { "suite": "androidworld", "taskId": "MarkorCreateNote", "verdict": "fail", "score": 0 }
```

同一个 trial，**本仓的独立快照检查判 pass，AndroidWorld 判 fail**。因为 `finish` 的编辑器正文谓词不看落盘，而 AndroidWorld 判据是「文件存在且内容匹配」。实测三条：

- 新建对话框点 OK 立刻创建 **0 字节**文件（`unsaved_probe.md`，size=0）；
- 在编辑器输入正文后文件仍是 **0 字节**，Markor 不自动落盘；
- 点 `action_save` 后才写入 18 字节，`action_save` 由 `enabled="true"` 变 `false`。

所以「编辑器里有正文」是**保存前的中间态**，不能当终态。后果：即使模型选对 Done，本仓也会给 pass 而基准给 fail。

→ 要修的是**终态谓词**，不是控件标签。可用的终态证据只剩「回到文件列表看到该文件名」，但新建即落 0 字节文件、行存在也不证明内容已保存 —— **UI 层无法证明持久化**。因此 `benchmark.score` 必须是唯一权威，`independent.verdict` 只能当必要条件读。

