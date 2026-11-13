# P3：AndroidWorld 公开基准首次真实执行（AndroidWorld MarkorCreateNote）

2026-11-13。范围：J0.2 正式批次工具在**真实 API 33 模拟器 + 真实 Jev 网关**上的首次执行。档位与数字以 [README 状态表](README.md) 为准；本文只记录本批实际跑过的路径。

**结论先写：已取得第一个经独立检查评分的 trial（r7，`score=0`、`verdict=fail`）。** 前六轮（r3–r6）分别暴露了快照、前台与启动三类前置缺陷；r7 走完正确路径但停在最后一步，原因见 §8。

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
| r7 | `TASK_JEV_UNCERTAIN`，**`score=0` fail** | 路径正确，停在「保存」；工具栏按钮无标签 | 见下「保存控件不可见」 |

### 8.1 冷启动会回收快照目录

`SNAPSHOT_DATA = /data/data/android_world/snapshots` **不是任何已安装包的数据目录**（`androidworld.apk` 的包名是 `com.example.androidworld`，转发器是 `com.google.androidenv.accessibilityforwarder`）。系统把 `/data/data` 下的孤儿目录当作残留清理，因此**每次模拟器冷启动，快照都会消失**，而 Markor 自身的用户数据（已安装包）保留。实测两次冷启动均复现。→ 每个新批次在冷启动后必须先 `setup_app` 重拍快照。

### 8.2 无障碍转发器崩溃（r5）

`logcat -b crash` 给出 `NullPointerException` in `ContextWrapper.getSystemServiceName` ← `AccessibilityInteractionClient.getInstance` ← `AccessibilityService.getWindows`，发生在转发器初始化线程。设备时钟被 AndroidWorld 冻结在 2023-10-15（`auto_time=0`），这是 `freeze_datetime` 的正常结果，不是本仓改动。重启模拟器后未再复现，但**未做稳定性验证**，属已知残留风险。

### 8.3 保存控件在语义树里不可见（r7 的真正发现）

r7 的意图轨迹完全正确，两次写入均 `verified`：

```
Tap n15 (FAB)            dispatched
Fill n3  fileName        verified
Tap n16 (OK)             dispatched
Fill n6  noteText        verified   ← 已在编辑器正文，p=0.96
```

然后第 5 轮 `p=0.81`、`margin=0.70`，低于 0.9 阈值 → `TASK_JEV_UNCERTAIN` 安全停止。原因在编辑器工具栏：

```
resource-id=".../action_save" class="android.widget.TextView" text="" bounds="[765,138][870,264]"
```

`action_undo` / `action_redo` / `action_preview` / `action_save` / `action_search` 五个按钮**都没有 text、没有 content-desc、也没有 clickable 属性**。它们是 ActionMenuView 里渲染成 TextView 的图标按钮，语义树里完全无法区分。模型面对五个同构无标签目标，给不出 ≥0.9 的选择——**这个停止是正确的，不是能力不足**。

文件未落盘（`/storage/emulated/0/Documents/Markor` 为空），因为 Markor 需要显式保存；AndroidWorld 判据 `CreateFile.is_successful` 检查文件存在与内容，所以 `score=0`。

→ 这不是模型问题，也不是候选生成 bug，而是**目标 App 的语义可辨识度不足**。可行的下一步：为 icon-only 工具栏引入受控标签来源（APK 资源里的 `contentDescription` 若为空则无解），或把「保存」降级为显式的类型化动作而非自由候选。两者都需独立契约，不在本批擅自扩大。

