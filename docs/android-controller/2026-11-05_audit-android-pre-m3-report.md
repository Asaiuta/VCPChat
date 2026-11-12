# AndroidController M3 前收口报告

日期：2026-11-05，工作区 `D:\AI\VCPChat`。接续 DSH 会话 `c7e86bd9-4362-4960-9fe9-2391819a1a9b`（梳理安卓控制器M3前待办）。范围限定为现有 M0–M2、M2.5/M2.6 身份、上下文、策略与证据收口。

## 当前结论

完整离线回归 **1885/1885 通过**，0 失败/取消/跳过，44.959 秒，exit 0。PJZ110 的 M2 固定靶场本轮 **14/14 通过**，无 case 重试，正常 cleanup，exit 0。远端 owner 的绑定、隔离阻断、公开恢复与精确清理验证通过。M1.5 最终新矩阵 **13/14，exit 1**：像素拖拽验收脚本已适配坐标按需返回，唯一保留失败是主机滚动的可见性标准不一致（本报告为上午批次快照：该保留失败已于同日晚间由 `scroll-axis-interior` 收口并通过 14/14；后续 12:42 轮红灯为 `DoubleTap`，见[晚间验收](2026-11-05-device-acceptance.md)）。85个相关JS/CJS/MJS语法检查与限定git diff --check通过；不宣布全部M3前置验收完成。

本机为 Android 17 / API 37，默认 display 0、1440×3168、rotation 0，通过已授权无线 ADB 连接。只使用零权限固定靶场 `com.vcpchat.m15fixture`。本轮未修改 APK、运动轨迹、等待预算、判定阈值或系统设置；没有向上游模型账户发送探针。

## Evidence → Finding → Path

| Evidence | Finding | Path |
| --- | --- | --- |
| 跨包生产 harness 先复现 5 个失败，补丁后 7 项专项通过；含隐藏节点、父节点折叠子标签 | 仅扫描公开 controls 会丢失原始 package 来源，导致 deny/readOnly 漏检 | `interaction-guard.readGraph` 扫描完整 raw tree；读返回拒绝任何禁读包；未限定目标的写检查所有原始包，精确目标检查当前实际包 |
| owner 启动隔离与跨 Service 实例 tombstone 测试；owner/真实 loopback 定向 58/58 | `{ok:false, owner:quarantined}` 不能被解释为可回退 CLI；关闭 UI_SERVER 也不能绕过已有隔离 | Service 在 guardRead/start/cleanup/recoverOwner 共用 owner 状态屏障；原始未知 RPC 错误仍保留派发结局 |
| PJZ110 第一次完整 M2 为 0/14 `CONTEXT_UNPROVEN`；实收格式回归先红后绿，相关 80/80 | ROM 同时返回 `mWakefulness=Awake` 与 `mWakefulness=1`，仅有 KeyguardServiceDelegate；旧解析把有效证据当 unknown | 只接受唯一命名状态和可选一致数字状态；缺 Monitor 时才接受明确 Delegate 两字段；冲突、重复及不完整仍 unknown |
| 缺失 owner JAR 的 identity 测试、默认 Observe 与 stable=true 性能身份对照 | 代码完整性不能漏 owner 依赖；默认 Observe 不应误标稳定采样 | 必需文件加入 owner/context/guard/JAR；性能 workload 使用实际 stable 请求 |
| stale/index/frame/launch 相关 57/57 | 原输入失败后只允许独立新观察；不能把新屏恢复成旧凭据授权 | 测试经公共入口验证原错误、零输入、单次只读附屏及图像失败边界 |
| 完整回归一次 1884/1885：20ms sequence deadline 用例得到 STEP_DEADLINE 而非 DEVICE_BUSY | 测试没有证明截止时模拟输入已进入挂起阶段，在全套调度负载下竞争 | 等待 input-ready 屏障，再用模拟 Date/setTimeout 触发 deadline；保留 unknown、租约与排干断言；定向 46/46、最终 1885/1885 |
| M1.5第一轮像素拖拽派发前失败；改成与生产一致的坐标省略mock后复现红灯，适配后46/46与真机局部通过 | 验收脚本仍假定Observe默认带坐标，新呈现契约按需提供坐标 | runner的UI观察显式includeCoordinates=true；生产默认及独立坐标/拖放效果断言不变 |

主要源码：[Service](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)、[策略门](../../VCPDistributedServer/Plugin/AndroidController/lib/interaction-guard.js)、[ADB 解析](../../VCPDistributedServer/Plugin/AndroidController/lib/adb.js)、[owner](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-owner.js)、[代码身份](../../VCPDistributedServer/Plugin/AndroidController/lib/code-identity.js)。未重写已工作的传输/会话分层；只补真实入口遗漏和可复现兼容格式。

## M2 真机证据

| 本次轮次 | 结果 | 分类 |
| --- | --- | --- |
| device-run-1 | 0/14，exit 1 | 目标准备阶段上下文解析拒绝，未派发 GUI 输入；修复有实收格式与离线回归 |
| device-run-2 | 14/14，exit 0 | 定位/序列 6 项、元素截图 4 项、idle 4 项全部同轮通过，无重试或拼接历史结果 |

运动用例保持原 4.5 秒预算、native 1500ms 上限、30 秒周期运动 fixture。结果 `unknown / IDLE_TIMEOUT`，请求 4574.238ms；独立 Provider 的 motionBefore/motionAfter 均 true，ticks 51→165。四份完整采样的色块左边界依次为 144、80、48、104，完整布局摘要均不同；第五份在截止处以 sample-error 收尾，没有再签发稳定证据。截图 padding=8 为 1080×523，中心 RGB=[32,160,96]，ROI 通过独立 Provider 几何核对。

这证明本轮正确处理变化布局；历史 2026-11-03 第七轮的周期重合或陈旧 dump 归因仍缺当时证据。`layout_stable` 仍只保证两次完整布局相同，不保证连续静止、纯像素静止或业务完成。诊断仍明确 `dumpFreshness=unproven`、`independentSampleTimeGeometry=not-collected`，不因本轮通过抹掉历史失败。

## owner 真机证据

同一 JVM wrapper 经 nonce 认证、PID/startTime/uid/cmdline 与 socket inode 绑定后才准入 RPC。第一代 PID 3003、startTime 61327319、RPC/control 端口 22199/37147。显式注入 quarantined 测试状态后，新 Service 即使 `UI_SERVER=false`，Observe 仍返回 `DEVICE_STATE_UNCERTAIN`。

公共 `Manage operation=recoverOwner` 返回 released 后，验收脚本另用 ADB 读取 `/proc` 与监听表，确认原进程及两端口均消失。第二代 PID 3223、startTime 61327832、端口 32101/43367，正常 stop 后也经独立消失检查。无 GUI 输入、无宽泛 kill/pkill。该实验验证真实 owner 生命周期与隔离恢复，**没有伪称注入了真实网络超时或远端在途未知 RPC**；后者由离线真实 loopback 故障测试覆盖。

## M1.5滚动差异：保留失败

第一轮完整14项为12通过/2失败：DragPixels因未请求坐标在动作前拒绝；ScrollUntilHost派发3次滑动后未通过独立可见性断言。像素适配后，两项局部诊断的DragPixels通过，ScrollUntilHost仍失败；没有将局部绿灯合并成完整通过。

随后修正runner下的第二轮完整14项全部执行：13通过、1失败、0未执行、无case重试、正常cleanup后exit1。唯一ScrollUntilHost仍为`INDEPENDENT_READBACK_MISMATCH_STOP`，3次滑动、8509.158ms；RPC滚动独立通过（9145.263ms）。像素拖拽、长按/双击、语义拖拽、双向缩放、IME键事件、组合键、删字与纯历史读全部同轮通过。

诊断中目标scrollY从0到8202、点击数始终0；生产返回actionVerified=true、swipes=3。后续独立观察显示容器bounds=[32,490,1408,3072]，目标bounds=[32,3040,1408,3072]，只露32物理像素；Provider仍targetVisible=false。靶场`publish()`要求`getGlobalVisibleRect().height() >= dp(32)`，而生产仅要求目标与容器有正面积相交。该日志排除了“20秒总截止”解释，定位到**可见性标准不一致**。

现有文档将可见比例、居中与无进展停止列为独立滚动质量工作。当前carrier返回的目标bounds本身已裁剪，不能拿它作完整目标面积分母。此次不引入任意32dp生产阈值，也不降低靶场断言或篡改历史14/14；保留新回归失败，后续需先定义可见性契约与独立完整几何来源，再实现与验收。

## 复现与原始产物

所有本轮日志位于 [artifacts/android-pre-m3-2026-11-05](../../artifacts/android-pre-m3-2026-11-05/)。关键日志：`regression-complete.log`、`device-run-1.jsonl`、`device-run-2.jsonl`、`device-run-2-identity.json`、`owner-device.jsonl`、`m15-device-run-1.jsonl`、`m15-device-run-2.jsonl`、`m15-diagnostic-2.jsonl`。`verification-summary.json`汇总实际退出码，`evidence-manifest.json`记录证据和源码SHA-256。失败回归与实测均保留，未覆盖为成功日志。部分既有docs/scripts路径被仓库ignore；本轮不强制加入索引，交付以当前工作区文件为准。

在仓库根目录执行离线回归（loopback 测试需允许本机 TCP 监听）：

```powershell
node --test tests/android-*.test.js tests/android-*.test.mjs tests/adb-*.test.js tests/frame-hub-contract.test.js tests/scrcpy-*.test.js tests/stream-recovery.test.js tests/subscriber-init.test.js tests/ui-graph.test.js tests/vision*.test.js tests/launch-app.test.js tests/focus-parse.test.js tests/auto-connect*.test.js tests/device-reconnect.test.js tests/*jev*.test.js tests/distributed-*.test.js scripts/android-m15-fixture/verify-cli.test.cjs scripts/android-m15-fixture/verify-m2-cli.test.cjs
node scripts/android-owner/build.cjs --sdk F:/AndroidSdk
```

以下命令使用本次已授权端点；仅在同一专用靶场已打开、亮屏未锁、设备显式在线时执行。无线调试端口变化时须用设备当前地址替换。

```powershell
node scripts/verify-android-m2.cjs --probe --serial 192.168.137.128:44771 --adb D:/AI/tools/platform-tools/adb.exe
node scripts/verify-android-m2.cjs --suite --serial 192.168.137.128:44771 --adb D:/AI/tools/platform-tools/adb.exe
node artifacts/android-pre-m3-2026-11-05/verify-owner-device.cjs 192.168.137.128:44771 D:/AI/tools/platform-tools/adb.exe
node scripts/verify-android-m15.cjs --suite --serial 192.168.137.128:44771 --adb D:/AI/tools/platform-tools/adb.exe
```

M1.5 入口要求靶场处于 gestures/keyboard/scroll 模式；M2 页需先通过靶场导航切回。验收命令不自行解锁或改变系统设置；状态不明时在派发前停止。

## 身份与范围限制

- M2 第二轮生产代码摘要：`94c26727ed8b8f3c2a37016f5b19f36223890189c7fd066d4b545cd5580c33e7`，complete=true；包括实际生产 JS、vendor 与 manifest，非 Git HEAD。
- owner JAR 本地重建 byte-identical：`73fb9acc258f0a8a1a7a8f34e8255e890659dbc1e16e66df864e9da534282837`。
- 随包 u2 APK 与设备启动文件读回 SHA-256：`6d16845d28fea01d5ae069221d9df307c74e70b780eb99ac0b28cf8f6135a50f`。文件身份和运行 owner 证据分开保留。
- 保留严格 text/desc/any 分源、新鲜上下文/epoch、完整布局稳定性、预算呈现、安全 stale 附屏和只读多 root 诊断；未知写不重放，敏感写无可信批准即拒绝。
- 多 ROM、旋转/多 display、真实网络断连注入、长稳 soak、旧性能基线迁移、跨物理别名互斥和完整 VCPChat/ToolBox 在线链路未验收。词表不是完整敏感操作证明，nonce 不防恶意 shell UID，检查与输入不具原子性。
- M3 OCR/模板、安装 App 后端、全窗口输入、通用事件、Intent/Collect、可信逐次批准协议均未实现或扩大范围。工作树保留原有无关改动，本轮未提交。
