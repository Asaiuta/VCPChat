# 快速滑动视频停帧修复

已修复[分析报告](2026-11-07_android-stream-stall-analysis.md)中定位的解码积压恢复问题。需要重启 VCPChat，使主进程加载新的推流服务和编码参数，再打开安卓显示屏。原始分辨率、60 fps、8 Mbps 等用户保存设置保持不变。

本次做局部状态整理：viewer 的等待关键帧、解码重试和待绘制帧由同一组状态管理，移除了重复解码配置函数和独立的停滞重试计时状态。没有重写设备管理或控制通道。

| 修复 | 当前行为 |
| --- | --- |
| 短暂积压 | 队列超过8时允许短暂排空；持续250ms或达到60个待处理请求才重同步，引用链缺帧仍立即重同步 |
| 已到达关键帧 | 积压时直接重建解码器并提交当前关键帧，不再丢掉它等待下一轮 |
| 等待恢复 | 保留有效codec配置；前端合并未完成的恢复请求，服务端不让重复请求延后原有等待期限 |
| 手机关键帧间隔 | 启动参数增加 `video_codec_options=i-frame-interval=1`；这是活动画面的目标间隔，静屏仍可能不发帧 |
| 解码错误 | 暂时错误最多重试2次，第3次连续失败或明确不支持才持久降级JPEG；成功解码30帧后恢复重试预算，旧解码器错误回调无效 |
| 绘制与释放 | 保留最新解码输出，下一次刷新绘制，最长调度等待32ms；替换、关闭、重连均释放VideoFrame并取消待执行绘制 |
| 统计 | 状态栏最多每250ms更新；帧率改为时间窗口，支持60/120fps；切回H.264清除此前JPEG延迟读数 |

32ms调度期限来自此次真实Electron复测：仅用requestAnimationFrame时，隐藏窗口即使配置 `backgroundThrottling:false`，仍观察到约1Hz回调。修复后以刷新回调和限时回调竞争同一次绘制，不会重复使用或释放VideoFrame。计时器也受主线程调度影响，这不是硬实时的32ms端到端延迟保证。

## 验证

| Evidence | Finding | Path |
| --- | --- | --- |
| [限定回归](../../artifacts/android-stream-stall-fix-2026-11-07/regression.log) | **347/347通过，0失败/取消/跳过，exit0**；包含积压时间/数量边界、到达IDR恢复、连续错误、失效回调、限时绘制、帧释放、重复重同步期限和60/120fps统计 | viewer + StreamServer + scrcpy + 显示窗口/权限/接管相关测试 |
| [Electron突发投递](../../artifacts/android-stream-stall-fix-2026-11-07/electron-result.json) | 1440×3168，600帧全部编码并投递；588个解码输出、52次合并绘制；注入一次错误后恢复335.4ms，无自然codec错误、无永久JPEG，最终队列0、无待绘制帧，exit0 | 真实WebCodecs编码/解码 + 当前viewer函数；12帧一批的模拟网络突发 |
| [Electron逐帧投递](../../artifacts/android-stream-stall-fix-2026-11-07/electron-continuous-result.json) | 600帧全部编码并投递；591个解码输出、299次绘制；注入错误后恢复257.4ms，最终仍为H.264，队列0、无待绘制帧，exit0 | 同一原生Electron运行时，逐帧投递 |
| [手机编码器验证](../../artifacts/android-stream-stall-fix-2026-11-07/device-encoder-result.json) | PJZ110无线ADB，1440×3168/60/8M新参数可开流；431帧、8个IDR。四个相邻活动周期为1004.8/996.2/1004.9/996.4ms；自己的forward已删除，exit0 | 独立ScrcpyHub镜像，无手机点击/滑动输入，无保存设置变更 |
| [源码摘要](../../artifacts/android-stream-stall-fix-2026-11-07/source-hashes.json) | 记录最终产品源码和测试SHA-256；JS语法及改动空白检查通过 | 当前工作区；已有无关改动保留 |

Electron版本44.9.3，Chromium152.0.7977.167；测试在隐藏窗口、`backgroundThrottling:false`下执行。600帧是模拟数据，12帧批量投递刻意合并绘制；逐帧轮600帧耗时约19.4秒，包含编码/绘制与故障恢复，**不声称实测达到60fps**。恢复期间不解码依赖缺失的delta，所以解码输出数小于输入数。纯rAF失败证据保存在 `electron-raf-only-result.json` 和 `electron-raf-only.log`，没有将其算入成功结果。

手机采样不是受控的持续快滑基准；其他IDR间隔包含约2.05秒、1.20秒和11.48秒。静屏、实际输入及调度都会影响间隔，1秒配置不能保证所有场景下1秒内恢复。没有在当前用户应用上自动滑动，也没有完成相同快滑轨迹的修复前后端到端对比。

## 复现

仓库根目录执行限定回归：

```powershell
node --test tests/android-stream-*.test.js tests/scrcpy-*.test.js tests/stream-recovery.test.js tests/subscriber-init.test.js tests/android-viewer-presentation.test.js tests/android-display-*.test.js tests/android-takeover-viewer.test.js
```

独立验证脚本及原始记录位于 [修复产物目录](../../artifacts/android-stream-stall-fix-2026-11-07/)。`browser-server.cjs` 启动本地合成画面测试页，`electron-check.cjs` 使用项目Electron执行突发模式，加 `--continuous` 执行逐帧模式。`device-encoder.cjs` 会创建20秒独立手机镜像并清理，需在线已授权设备；它不会驱动前台应用，不是持续滚动验收脚本。

更短关键帧间隔可能改变实际码率分配与画质；本次未对画质作量化比较。真实设备快速滚动时的剩余卡顿仍应通过到包、解码队列及绘制间隔联合定位，不能仅凭帧率设置归因。
