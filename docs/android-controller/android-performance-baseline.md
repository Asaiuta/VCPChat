# Android 控制器性能与内存基线

状态：**首轮真机基线已建立；长时 soak 未采集**。本文件只记录当前分支真实执行过的检查与实测数字，不预测、不外推。

## 1. 为什么需要基线

此前 AndroidController 的性能证据只有三类，都不构成可回归基线：

- `lib/scrcpy-hub.js` 注释里的单次实测（10.9 fps / 2.5KB 每帧 / 227kbps）——设计动机，不是断言。
- `android-p2-validation.md` 的 P2 耗时（API p50 374ms、GUI p50 2593ms，n=5）——样本过小，文档自身已声明不是大型模型基线。
- `.workbuddy/_probe/verify-longrun.cjs` 的 4 分钟探针（RSS 增长 < 40MB）——未入库、无 CI、不可复现。

没有基线时，"优化了 13 倍"是无法证伪的声明。本文件把观测点、口径、判定规则与实测数字钉死。

## 2. 观测面

新增两处只读计数，不参与任何调度与丢帧决策：

| 观测点 | 位置 | 内容 |
| --- | --- | --- |
| `adb.queueStats()` | `lib/adb.js` | `depth` / `pending` / `running` / `peakDepth` / `completed` / `failed` / `rejected{ADB_QUEUE_FULL,ADB_TIMEOUT,ADB_ABORTED}` / `failedByCode` |
| `streamServer.metrics()` | `lib/stream-server.js` | H.264 与 JPEG 的发送包数/字节数、两类背压丢弃、慢订阅者断开数、恢复尝试与成功数、观众数与缓冲字节 |

两者经由 `getRuntimeStatus()` 暴露为 `adbQueue` 与 `display` 字段。

计数语义刻意不重叠：`completed`/`failed` 只统计真正入队执行的任务；`rejected` 只统计在 `push()` 入口被拒、从未入队的任务。因此「队列被挤爆」表现为 `rejected.ADB_QUEUE_FULL` 上涨而 `failed` 不变，「设备或命令有问题」表现为 `failed` 与 `failedByCode` 上涨。混在一起就无法从基线判断故障来源。

## 3. 吞吐口径（关键）

**必须用累计口径，不能用滑动窗口。**

`scrcpyHub.status().effectiveFps` 取最近 60 个包的时间窗，`frameHub.effectiveFps()` 取最近 20 帧。二者都是瞬时值，会把「画面静止、编码器不出帧」读成帧率升高。

实测对照（同一段 60 秒会话）：

- 滑动窗口 `effectiveFps`：9.61 fps
- 累计口径 270 帧 ÷ 60.708 秒：**4.45 fps**

差 2.2 倍。基线一律采用后者：`wsFrames ÷ wsSeconds`。

## 4. 判定规则与产物

```
node scripts/android-perf-baseline.cjs --update    # 从 raw 采集产物生成基线
node scripts/android-perf-baseline.cjs --check     # 用现有基线判定
node scripts/android-perf-baseline.cjs --list      # 列出已有基线
```

等价的 npm 入口：`perf:android:update` / `perf:android:check` / `perf:android:list`。

- 基线目录：`artifacts/android-baseline/`，文件名是主机与设备指纹。
- 原始采集产物：`artifacts/android-perf-raw/<timestamp>/`，含 `cases.json`、`observe-latency.json`、`host-samples.jsonl`、`device-samples.jsonl`、`version.json`。
- `--update` 在设备身份无法确定或没有 raw 产物时**拒绝写入**，不生成「未知设备」基线。
- `--check` 在没有基线时输出 `no_baseline` 且退出码为 1。

**换机器、换 ROM、换 adb 版本 = 新基线文件，禁止原地改阈值把红改绿。**

判定优先级：`fail` > `incomplete` > `pass`。任何指标缺失（样本或基线缺该路径、值非有限数）都使判定最多为 `incomplete`，绝不落成 `pass`。

### 规则表

| 规则 | 判据 |
| --- | --- |
| 单订阅累计吞吐 | ≥ 基线 × 0.8 |
| 三订阅最小帧数 | ≥ 基线 × 0.8 |
| Observe p95 | ≤ 基线 × 1.2 |
| Observe 失败数 | = 0 |
| adb 队列满拒 | = 0 |
| 断流恢复最慢值 | ≤ 基线 × 1.5 |
| StopDisplay 后 RSS 增量 | ≤ 基线 + 20MB |
| StopDisplay 后设备端残留 | = 0（无 `app_process`） |
| 背压丢帧 | = 0 |
| 长时 soak RSS 斜率 | ≤ 基线；**未采集则 incomplete** |

最后一条的存在意义就是让「没跑长时稳定性」无法算作通过。

## 5. 首轮真机实测

设备 PJZ110（OnePlus，Android 17 / API 37），adb 1.0.41，无线调试 `adb-<id>._adb-tls-connect._tcp`。采集于 2026-11-02。

> **本节（第一轮）数字早于常驻 RPC 路径，不能当作当前代码的基线。**
> 采集时刻 19:02，而 `lib/ui-server.js`（u2 JSON-RPC 取树）于 19:49 落盘，其注释记录同页 dump p50 61ms / p95 122ms。
> 所以下表的 Observe 与 GUI 耗时描述的是 **CLI dump 路径**。当前基线见本节末尾的「第二 / 第三轮复采」。

### 优化后（第一轮复采，2026-11-02 19:02 采集；非当前基线，见上注）

| 项 | 实测 | 优化前 |
| --- | --- | --- |
| H.264 单订阅 60 秒 | 258 帧 / 4.24 fps 累计 | 270 帧 / 4.45 fps |
| 三订阅并发 90 秒 | 605 / 608 / 608 帧，零断连、零背压丢帧 | 273 / 276 / 276 |
| 断流恢复（`kill -9` 编码器 ×3） | **2109 / 1483 / 1726 ms** | 2955 / 2913 / 2909 ms |
| StopDisplay 归零 | 主机 RSS 34280 → 34516 KB（+236KB）；设备端残留 false | +152KB |
| Observe 延迟 | 40/40 成功，**p50 2345ms、p95 2542ms、max 7496ms** | p50 2892、p95 6028、max 9136 |
| adb 队列 | 零拒绝零超时 | 同 |
| scrcpy 进程 | `avc1.64001e`，首包 724–943ms | 握手 923–1056ms |

三项改动带来的收益：

| 改动 | 优化前 | 优化后 | 依据 |
| --- | --- | --- | --- |
| scrcpy 启动改轮询设备端 socket | 固定 `setTimeout(1800)` | 就绪轮询，start 542–724ms，首包 724–943ms | 真机 3 轮：abstract socket 482–733ms 出现，握手 923–1056ms 到达 |
| 息屏点亮改轮询 probeScreen | `pause(700)` + 2 次串行往返 ≈ 1135ms | 一次轮询 ≈ 539ms | 真机 4 轮：keyevent 后首次 probeScreen 已 Awake 且焦点可用，160–241ms（冷启 927ms） |
| idle 超时改为重试主路径 | 退回同源 file 路径，再卡 11s | 重试主路径 | 剖析日志：轮 2/4/5 两次 uiautomator 全失败，Observe 膨胀到 22.8s |

**为什么 `1800ms` 不能直接删。** 实测 `adb forward` 建立后本地 TCP 在 145–209ms 就能连上，但那是 forward 自己的监听 socket；此时连接会在 93–108ms 内被 reset，收到 0 字节（3/3 轮验证）。真正的就绪信号是设备端 `/proc/net/unix` 里的 `scrcpy_<scid>`。所以改成轮询该 socket，而不是盲目缩短睡眠。

**为什么 idle 超时不能退回 file 路径。** `shell uiautomator dump <file>` 走的是同一个 uiautomator，会再卡一次同样的 11 秒。`ERROR: could not get idle state.` 是瞬态失败（动画密集页面），正确做法是重试主路径。

### 采样环境必须一起读

`Observe p95` 从 6028ms 降到 2542ms，但两个数字都绑定了各自的前台负载：优化前采样期间 `dumpsys cpuinfo` 显示 com.tencent.mobileqq 占用 58% CPU，优化后前台是闲鱼/bilibili。基线记录的是本机本环境的值，不是「手机在任何状态下都应该这么快」。

第 3 条优化（idle 重试）只在动画密集页面生效；静态页面本来就一次成功，看不出差别。它的价值是把 22.8s 的尾部延迟压到 7.5s 以内。

### 第二 / 第三轮复采（2026-11-02，常驻 RPC 生效后）

同一台 PJZ110，node **v22.22.2**（首轮是 v24.22.2，故落成新指纹文件），adb 1.0.41，无线调试，均 Awake。

| 项 | 第三轮（动态页，**当前基线**） | 第二轮（静态页） | 首轮（CLI 路径） |
| --- | --- | --- | --- |
| raw 目录 | `2026-11-02T15-03-40-884Z` | `2026-11-02T14-54-07-235Z` | — |
| 前台 | 手机QQ `SplashActivity` | 系统设置 → 显示 | 闲鱼 / bilibili |
| Observe | 60/60，**p50 400ms、p95 466ms、max 1414ms** | 60/60，429 / 535 / 1401 | 40/40，2345 / 2542 / 7496 |
| A 单订阅 60 秒 | **821 帧 / 13.43 fps** | 38 帧 / 0.62 fps（不采信） | 258 帧 / 4.24 fps |
| B 三订阅 90 秒 | **2256 / 2259 / 2254 帧** | 33 / 36 / 36（不采信） | 605 / 608 / 608 |
| D 断流恢复 ×3 | 1990 / 1718 / 1817 ms | 1974 / 2012 / 1788 ms | 2109 / 1483 / 1726 ms |
| C StopDisplay | +52KB，设备端残留 false | +136KB，false | +236KB，false |

两条结论：

1. **回归基线取第三轮。** `--update` 已把同名指纹文件覆写，`source.rawDir = 2026-11-02T15-03-40-884Z`。吞吐只在画面变化时有意义，第二轮那两行是静态页的产物，不构成基线。
2. **Observe 对页面活跃度不敏感**：400ms（动画页）对 429ms（静态页），差在噪声内。
   旧 CLI 路径恰好相反 —— 动画页会卡到 11s 后吐 `ERROR: could not get idle state.`，首轮 p95 6028ms 那次采样前台正是 QQ。`dumpWindowHierarchy` 不做 idle 等待，这段尾部由此消失。

关于 A/B 两行的跨轮差异（13.43 对 4.24）：两轮前台都是活动界面但不是同一个应用，**不按「提速 3.2 倍」对外表述**。能确定的只是吞吐不再被「每次冷启 VM + 等 idle」的进程税压住。

判定：除 soak 外全部 pass，soak 未采集 ⇒ `incomplete`（这是刻意的红）。

### 本轮暴露并修掉的一个静默失效

`lib/ui-server.js:_ensureApk` 原本用 `[ -f <remote> ] && echo PRESENT` 探测 apk 是否存在。文件不存在时该命令**退出码是 1**，而 `_exec` 把非零退出码一律当失败抛出 —— 于是首次接入（apk 还没推上去）时 `_ensureApk` 必然抛错，`start()` 恒返回 `ok:false`，上层静默回退 CLI。

后果：常驻 RPC 只在「apk 恰好已被手工推过」的设备上生效。首轮 61ms 的数字是真实的，但它描述的是**热设备**；冷设备上从来跑不起来，而失败表现为「慢 5 倍」，不报错。

修法与证据：命令补 `|| echo ABSENT` 让退出码恒为 0；`tests/android-ui-server.test.js` 的假 adb 现在复刻真实退出码语义，回滚该行即报
`推送 apk 失败：adb shell 失败`（与真机现场一致）。

同时修掉采集脚本的同类问题：三个脚本都把默认序列号写死为某次热点会话的 `192.168.137.178:37109`，失效时只打印一行 adb 报错却照常判 pass。现已改为运行时解析第一台已授权设备（`scripts/lib/resolve-serial.cjs`），一台都没有则退出码 2 并说明原因。

## 6. 测试

```
npm run test:android-perf
```

包含四类检查：

| 文件 | 作用 |
| --- | --- |
| `tests/android-perf-metrics.test.js` | 仪表契约：计数器是否说真话、读快照有无副作用、两类背压是否分开计数 |
| `tests/android-device-metrics.test.js` | 设备端解析器：真实 fixture 驱动的 `proc/stat`、`meminfo`、`battery`、`ps`、`thermal` 解析 |
| `tests/android-perf-baseline-logic.test.js` | 判定与存储：反假绿（无基线不得 pass）、缺失不得 pass、指纹确定性与序列号隔离 |
| `tests/android-perf-baseline-runner.test.js` | CLI 集成：篡改样本必 fail、soak 缺失必 incomplete、退出码正确 |
| `tests/android-perf-golden.test.js` | 真机 golden 数据：锁住解析口径与实测量级 |
| `tests/scrcpy-readiness.test.js` | 启动就绪：按设备端 socket 轮询、取消不留残骸、禁止 >600ms 匿名固定睡眠 |
| `tests/android-wake-latency.test.js` | 息屏点亮：复用 probeScreen、不产生独立两次往返、轮询有上限 |
| `tests/android-dump-fallback.test.js` | 控件树采集：idle 超时重试主路径而非退回同源 file 路径 |
| `tests/perf-baseline-fingerprint.test.js` | 指纹保全：mDNS 序列号不得挤掉 adb 版本段 |

设备端 fixture 在 `tests/fixtures/android-device/`，含静态格式面与**真跑 scrcpy 时的**运行态样本。

## 7. 未覆盖

- **长时 soak（30–60 分钟）未采集**。判定当前为 `incomplete`，`--check` 退出码 1。这不是缺陷，是如实状态。
- 跨 ROM / 跨主机 / 跨 Android 版本矩阵未做。基线按指纹分文件，新增环境需各自 `--update`。
- 设备端 CPU% 与电量消耗未做**差分**量化。已采集 `dumpsys cpuinfo`、`Charge counter`、温度的时间序列，但采集时手机插着电（`AC powered: true`、`level: 100`），`Charge counter` 连续 222 秒恒为 4422000 不变 —— 插电状态下这个判据测不出任何东西，必须拔线跑。采集脚本已补 `acPowered` / `usbPowered` 字段，避免把「差值为 0」误读成「零耗电」。
- `capability` 未扩展到写操作或无人确认场景。
- **`uiautomator dump` 的 2.1 秒本体已被常驻 RPC 路径绕开**（`lib/ui-server.js`，2026-11-02 19:49）。
  它不再需要「独立立项」，但**基线没有随这次改重复采**，所以 §5 的 Observe 数字仍描述旧路径。
  剩余瓶颈从设备端进程税转为主机侧 `probeScreen` 往返与 XML 解析，量级待复采确认。

## 8. 复现真机采集

采集脚本：`scripts/capture-android-perf-raw.cjs` 与 `scripts/capture-android-observe-latency.cjs`。真机采集需要设备在线、允许 `kill -9` 重启编码器、预期占用约 5 分钟（A 60s + B 90s + D 3 次恢复 + C 60s），Observe 采样另需按次数计算（60 次约 3 分钟）。

采集本身会定期 `kill -9` 设备端编码器以测量恢复耗时，因此**不要在有人正在使用该手机时运行**。
