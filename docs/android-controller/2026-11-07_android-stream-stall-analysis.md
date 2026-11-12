# 安卓视频流快速滑动停帧分析

2026-11-07，范围：快速滑动页面、切换应用时卡顿或停帧。已检查当前源代码、正在运行的本地显示服务、scrcpy 进程参数及设备连接，并完成隔离复现。没有修改产品代码、画质配置，也没有向手机派发点击、滑动或应用切换。

**主要发现：当前恢复策略会把短暂解码积压放大为等待关键帧的长停顿。** 高分辨率和无线传输是触发因素候选；已经复现的是恢复机制缺陷，还没有采集到用户故障时刻的真实解码队列和绘制时间线，不能将无线、GPU 或手机编码器定为唯一根因。

## 当前运行条件

20:35:55（UTC+8）的 `/status` 和主机 scrcpy 进程参数交叉确认：

| 项目 | 观测 |
| --- | --- |
| 手机与连接 | PJZ110，无线 ADB |
| 视频尺寸 | 1440×3168，原始分辨率，`max_size=0` |
| 编码配置 | H.264 `avc1.640034`，帧率上限 60，目标码率 8,000,000 bps |
| 活跃订阅 | H.264 1，JPEG 0 |
| 通道状态 | streaming，最近包 42ms 前，无 lastError；当时短窗 effectiveFps=10.29 |
| 截图通道历史状态 | 最近一次 capture=3041ms，历史有效帧率 0.39；当时未在推 JPEG |

60 fps 时理论像素处理量约 2.74 亿像素/秒；窗口缩小不改变编码与解码尺寸。720×1584、30 fps 的像素量约为其 1/8，但不能由此直接断言当前设备无法处理原始分辨率。8 Mbps 是编码目标值，不是已测得的实时吞吐或网络容量。

25 次只读状态采样中通道保持 streaming，未观察到重启。采样没有受控的持续滚动输入，因此无帧间隔、低 effectiveFps 均不能当作性能失败；静态屏幕本来可以不发帧。

本地 vendor jar 和手机 `/data/local/tmp/scrcpy-server.jar` 的 SHA-256 相同：`764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`。

## 已确认的机制

### 1. 解码积压会触发销毁，连到达的关键帧也会丢弃

`viewer.html` 的 `handleH264Packet()` 在判断关键帧之前检查 `decoder.decodeQueueSize > 8`，随即调用 `resetDecoderForResync()`：关闭解码器、清空配置和序号、发送 `request-keyframe`，然后直接返回。

所以积压为 9 时，即便当前包就是可重新开始解码的 IDR，它仍不会提交解码。独立复现将一个真实源码处理函数放入 VM，以替身解码器控制队列，证实到达关键帧的提交数为 0，解码器被销毁。

9 帧在 60 fps 下约对应 150ms 的产生量，仅用于说明阈值尺度。WebCodecs 队列长度不是实际端到端延迟；无线 ADB 批量到包、宿主调度、硬件解码慢或绘制回调阻塞都可能让它短暂升高。

### 2. request-keyframe 没有请求编码器生成关键帧

实际调用链为：

`decodeQueueSize > 8 → resetDecoderForResync → WS request-keyframe → StreamServer.replayInit → ScrcpyHub.replayInitTo → 等未来 IDR`。

服务端仅补发 session/config 和仍可用的最新关键帧。`ScrcpyHub._emitPacket()` 收到任意 delta 后将 `lastKeyFrame` 清空，这是避免缺失引用链的正确约束，但意味着活动画面大多数时刻只会补发 session/config。`replayInit()` 返回 2，调用者把它视为已补发，不会进入重启分支，也没有设备侧强制 IDR 操作。

当前启动参数是 `control=false`。仓库保存的 scrcpy 5.0.1 上游 `SurfaceEncoder.java` 设置默认 I 帧间隔为 **10 秒**，当前启动参数没有覆盖它。这是源码配置依据，尚未实测该设备在快速滑动下的 IDR 周期；不能把 10 秒写成实测停顿时长或硬上限。

服务端对等待中的订阅者过滤 delta；5 秒仍没有关键帧就启动 JPEG 预览。隔离的虚拟时钟复现中：连续输入 **598 个 delta，转发 0 个**；5000ms 开启 JPEG；10000ms 人工注入新的 IDR 后恢复 H.264。模拟时间与模拟帧数不是本机实测吞吐。

### 3. 解码错误会将临时故障变成本连接持续 JPEG

`VideoDecoder.error` 调用 `fallbackToJpeg('H.264 解码出错')`，未设置 `temporary:true`，于是发送 `request-jpeg`。服务端将 socket 加入 `jpegOnlySockets`，拆除 H.264 订阅；`canAttachScrcpy()` 拒绝该连接自动回到 H.264。

这条路径与“等待 IDR 5 秒后的临时 JPEG 预览”不同：后者保留 H.264 订阅，新的 IDR 到达即可恢复；前者需要重新连接等显式动作。界面“画面会自己恢复”的文案不能保证回到视频模式。

当前状态中的 3041ms 是此前一次截图耗时，不能推断本次故障已经进入此分支。但它证明现有兼容通道不能被当作流畅视频的替代；原始 1440×3168 RGBA 截图约 17.4 MiB，在临时双订阅期间还可能增加无线 ADB 的传输竞争，需要实测其影响。

## 次要因素和观测缺口

| 问题 | 代码证据与影响 | 判断 |
| --- | --- | --- |
| 固定 4 MiB 发送队列，超限断开 | `stream-server.js` 的 `sendScrcpyPacket` / `sendText` 以 1013 关闭慢订阅者，随后重连又需等待 IDR | 有可能触发另一轮停顿；本次没有真实 1013 记录。该缓冲属于服务端到查看器，并非 Wi-Fi 带宽计数 |
| 每个解码输出立即绘制并更新 UI | `renderFrame → drawImage → revealStreamFrame → recordFrame`；没有按显示刷新节奏合并绘制 | 突发到帧时可能扩大主线程负载；未做真实 GPU/长任务剖析 |
| 60 fps 统计窗口失配 | 最多留 30 个时刻，却要求首尾跨度至少 500ms；60 fps 下只有 29/60 秒≈483ms | 注入 600 帧、稳定 60 fps，读数仍为 `-- fps`；这会误导观察，本身不造成停帧 |
| H.264 延迟显示没有测量 | `pendingPts` 只赋值；`latencySamples` 仅在 JPEG 路径写入 | 当前延迟栏不能判断 H.264 是网络慢、解码慢还是绘制慢 |
| 缺少前端恢复计数 | `/status` 没有 decodeQueue 峰值、重同步原因、等待 IDR 耗时、解码错误、到包与绘制间隔 | 现有状态无法闭合真实故障的触发归因 |

目前不能由 `prefer-hardware` 推断一定启用了硬件解码；配置 API 的成功也不能替代实际解码性能测量。

## 建议处理顺序

1. **先修恢复状态机。** 积压时若当前帧为关键帧，应保留有效配置、重建并提交该关键帧；一般 delta 不可随意丢一帧后继续引用链。重同步要合并请求、明确处于等待 IDR 的状态，并记录恢复期限，避免短暂突发反复销毁。
2. **缩短关键帧恢复等待。** 先验证通过 `video_codec_options=i-frame-interval=1` 设置较短间隔的编码器兼容性、实际 IDR 周期和画质/码率代价。它不保证静屏即时出帧。如以后需要立即刷新，scrcpy 现有控制消息是 reset-video（重置采集），不能把它误称为无代价的 request-IDR；当前并未建立该控制通道，接入须限定视频刷新能力及多查看器影响。
3. **让解码错误可恢复。** 区分暂时故障与不支持该 codec/设备，采用有限重试和临时降级；永久 JPEG 必须是明确策略，不能由所有单次解码错误统一触发。
4. **合并绘制、补齐计数。** 保持所需编码帧引用连续，解码后只绘制最新待显示帧，用 `requestAnimationFrame` 调度；及时关闭替换的 VideoFrame，状态栏降频更新。补齐队列峰值、IDR 间隔、resync/fallback 次数、到包和出画间隔。
5. **做有边界的真机对照。** 相同连续滚动/应用切换工作负载下，对比当前 1440×3168/60/8M 与短边720/30/4M，再分别只改变帧率或分辨率定位敏感项。至少记录60秒，比较超过250/500/1000ms的绘制间隔、重同步次数、恢复p95、实际码率和解码错误；之后对比 USB 与无线。低档设置是排查与缓解候选，尚未实测验证。

这值得对 viewer 的解码、等待 IDR、临时降级做局部状态机整理，同时修正服务端的恢复契约。没有证据需要重写 ADB、设备管理或整套 AndroidController，也不宜只提高队列上限掩盖停帧。

## 证据与复现

| Evidence | Finding | Path |
| --- | --- | --- |
| [runtime.json](../../artifacts/android-stream-stall-analysis-2026-11-07/runtime.json) | 当前1440×3168、60/8M、无线连接；含源码SHA-256 | 本地 `/status` + 主机进程参数 + vendor jar |
| [passive-status-samples.json](../../artifacts/android-stream-stall-analysis-2026-11-07/passive-status-samples.json) | 25次只读状态，无重启；无受控滚动，不能作为吞吐验收 | 本地 `/status`，约500ms采样间隔 |
| [reproduce.test.cjs](../../artifacts/android-stream-stall-analysis-2026-11-07/reproduce.test.cjs)、[结果](../../artifacts/android-stream-stall-analysis-2026-11-07/reproduction-results.json)、[日志](../../artifacts/android-stream-stall-analysis-2026-11-07/reproduction.log) | 4/4复现检查通过，exit0；积压丢IDR、过滤delta等待IDR、解码错误请求JPEG、60fps统计缺陷 | 当前viewer函数 + 实际StreamServer/ScrcpyHub逻辑 + 替身解码器/虚拟时钟 |
| [existing-tests.log](../../artifacts/android-stream-stall-analysis-2026-11-07/existing-tests.log) | 149/149通过，0失败/取消/跳过，exit0 | 6文件限定离线测试；非全仓、非硬件验收 |
| [SurfaceEncoder.java](../../artifacts/android-m4-focus-2026-11-06/upstream/server/src/main/java/com/genymobile/scrcpy/video/SurfaceEncoder.java) | 默认I帧间隔配置为10秒 | 上游5.0.1源码；实际设备周期待测 |

从仓库根目录执行：

```powershell
node --test artifacts/android-stream-stall-analysis-2026-11-07/reproduce.test.cjs
node --test tests/scrcpy-buffer-and-replay.test.js tests/android-stream-lifecycle.test.js tests/scrcpy-parser.test.js tests/stream-recovery.test.js tests/android-stream-config.test.js tests/android-stream-resolution.test.js
```

本次 node v24.22.2。复现检查通过表示**现有问题机制被复现**，并不表示已经修复。产品工作区已有其他未提交变更，分析期间 viewer 也有外部更新；本报告按 runtime.json 记录的源码快照核对。运行中的 Electron 启动于20:01，未取得已加载页面的完整代码/前端日志，不能将磁盘快照的所有行等同于该窗口已经加载的代码。仅添加本报告和独立证据目录。
