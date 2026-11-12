# 无模型 Android 设备套件

用确定性本地提供器驱动生产 AndroidController，独立读取隔离 App 的事件计数和终态。当前覆盖与结果见 [主状态表](../../docs/android-controller/README.md)，本轮设计与限制见[报告](../../docs/android-controller/2026-11-08_android-no-model-suite-report.md)。该工具不会调用 Jev 或主模型，不产生校准样本。

## 准备靶场

设备须已经连接 ADB、点亮并解锁。本机已有 SDK/JDK 时可直接离线构建：

```powershell
node scripts/android-m15-fixture/build-journey.cjs --sdk F:/AndroidSdk --jdk F:/AndroidSdk/jbr
```

产物为 `scripts/android-m15-fixture/.build/m15-fixture.apk` 和 `m15-journey-peer.apk`。构建仅使用本地工具，不下载依赖。历史证据需要保留时，先复制 fixture 源目录到新的构建目录，再运行复制后的 builder。主靶场已有安装时，沿用该靶场的测试签名密钥；签名不匹配会停止，工具不会自动卸载包。

## 运行新批次

以下 PowerShell 示例使用已连接的 MuMu。输出目录必须不存在；已有目录会在设备操作前拒绝，不能覆盖旧结果。`--install` 显式安装或更新两个固定靶场包，并在缺失时推送仓库随附 RPC APK；现存 RPC 摘要不一致则停止。已准备好的设备可省略 `--install`。

```powershell
node scripts/verify-android-device-suite.cjs `
  --serial 127.0.0.1:16384 --adb D:/AI/tools/platform-tools/adb.exe `
  --apk scripts/android-m15-fixture/.build/m15-fixture.apk `
  --peer-apk scripts/android-m15-fixture/.build/m15-journey-peer.apk `
  --content-runtime 32 --matrix journeys --install `
  --output artifacts/android-device-journeys-new
```

`--content-runtime 32` 是显式选择系统 32 位 `content.jar` 运行器，用于已复现 64 位 CLI 退出崩溃的 MuMu。默认 `native` 调用系统 content 命令；两种方式都要求退出 0，不接受“有 JSON 但命令失败”，也不自动切换重试。

`--matrix m5` 或 `--matrix m15` 复用既有搜索与动作 runner。主 APK 必须提供，伴随 APK 仅 journeys 必需。`--only Hold800,TouchCancel` 可运行声明子集；结果会明确标记子集，不能当作完整矩阵验收。m5 不支持子集选择。

## 冻结与报告

每轮先排他创建输出目录，再保存 `freeze.json`：脚本/生产代码/APK 摘要、设备序列号、任务、检查器版本、预算、策略身份与选定用例。`device.json` 记录系统身份；`events.jsonl` 保存靶场初始化、独立读取、确定性决策、回执与清理；`traces/` 是生产任务轨迹。合成字段仅来自无用户数据的靶场。

开始和结束验证安装 APK 与给定文件一致。每个用例开始及批次结束核验冻结文件。通用矩阵失败即停，剩余项单独记未执行；旧 M1.5 矩阵沿用其排干后继续独立用例的规则。所有用例禁止重放未知写；清理前必须排干运行时。终态、失败与清理错误写入 `result.json`，非全通过、源码漂移或清理异常均返回非零退出。

通用循环场景包括跨页双字段及 Back、返回后字段丢失即停、选中状态、开关、滚动后打开、受控加载、短暂完成标记、持续加载截止、LaunchApp、搜索、无效果改选、stale 和等待决策时取消。直接动作场景测量不同长按时长，并通过真实 ADB DOWN/CANCEL 检查靶场取消计数。

## 判据边界

- 长按以 MotionEvent 和设备 uptime 两种时间核对，容差固定为请求值减 100 ms 至加 500 ms；要求一次 DOWN/UP，无 CANCEL、无短按。
- 触摸取消用例由外部 ADB 注入 DOWN/CANCEL，验证实际事件与独立检查器，不证明控制器能中断一个已派发长按。
- `SelectedState` 核对生产元素投影和 provider 的 selected；当前完成契约没有 selected 谓词，因此任务回执必须保持 `unverified`，测试通过不把它升级成业务完成。
- 短暂完成页保留 80 ms，随后消失，最终完成在加载后出现。验证本次没有提前报完成；它不保证每一帧都被采到，不能据此声称任何瞬态都可识别。
- 加载成功场景只需要 Start 和 Done 两次本地决策；持续加载在固定截止内停止，无二次 Start，无额外决策。
- 跨 App 只在两个固定隔离包之间，返回后核对主包会话与伴随包 paused 状态。不是任意 App 跳转或账户业务验收。
- 原生 LONG_CLICK、RPC 被杀、真实模型判断、长时间稳定性和公开评测环境属于其它批次，当前结果不覆盖它们。

RPC 在途取消、延迟/丢失回执、终止本批 owner 和固定时长持续运行使用独立入口 `scripts/verify-android-resilience.cjs`。故障模式必须显式传 `--restart-device` 并使用专用设备；生产未知触摸在旧 owner 退出后仍保持持久隔离，工具检查独立宿主也无法绕过，再重启设备核验同设备新启动证明。默认重启使用 ADB；MuMu 可在开跑前指定 `--mumu-manager <MuMuManager.exe路径> --mumu-instance 0`，核对实例与 serial 对应后仅重启该实例，不自动切换方式、不放宽两分钟截止。生产不会自动重启或发送 CANCEL。完整命令与边界见[输入恢复报告](../../docs/android-controller/2026-11-08_android-input-recovery-report.md)；此前外部靶场 CANCEL 与持续运行证据保留于[历史报告](../../docs/android-controller/2026-11-08_android-resilience-report.md)，当前结果只在[主状态表](../../docs/android-controller/README.md)维护。
