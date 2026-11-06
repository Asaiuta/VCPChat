# AndroidController A/B/C 路线复核

**2026-11-05实施补记：** 继续现有ADB路线，已加入可本地构建的同JVM owner wrapper，未修改u2 APK或改用安装App后端。宿主新增windows=true只读root诊断，默认仍active root，尚无完整window envelope/通用事件订阅或全窗口输入。当前身份与设备验证见[收口报告](2026-11-05_audit-android-pre-m3-report.md)；以下2026-11-04路线研究按历史快照保留。

日期：2026-11-04。结论：**当前继续 A，按缺口评估 C；B 是产品部署路线，不是天然更强的控制引擎。** 本轮仅离线反汇编、代码核对和官方资料研究，未连接设备、未启动/安装 App、未改变默认采样模式。

## 1. 三条路线不是三个 transport 类

| 路线 | 执行身份与后端 | 价值 | 不会自动解决 |
| --- | --- | --- | --- |
| A：现有 ADB + app_process + 随包 u2 | shell/UiAutomation；USB 或无线 ADB | 沿用现有树、RPC、scrcpy 与宿主回执；无需安装控制 App | owner 身份/精确终止、结构化窗口证据、策略门、跨 ROM 兼容 |
| B：安装 helper App + 认证直连 | 普通 App UID + 用户启用 AccessibilityService；若依赖 Shizuku/ADB 则是另一种混合部署 | 可脱离开发者调试连接；App 内配对/状态/停止入口；面向不愿开启调试的用户 | 不能直接继承 shell UiAutomation 权限；需树/动作/截图后端、认证/撤销/重连、升级签名、后台生命周期 |
| C：保留 ADB，自维护小型 shell 服务端或受控 u2 fork | shell/UiAutomation，自己拥有协议与构建 | 可补窗口 envelope、事件序列、nonce/owner 握手；不要求安装无障碍 App | 仍依赖 ADB；也要维护 Android API/反射、构建/许可、测试与兼容，不能宣称低成本必成 |

抽出 Transport 只证明宿主有替换接缝。普通 App 即使打包相同 dex，也不会因包进壳里就获得 shell 权限。只有新后端满足等价动作/错误/能力契约时，宿主上层才可复用；更换节点来源、display/window 寻址或动作原语仍需适配与准入。

B 也不等于“只能电脑常开且不想插线的小市场”：引擎可以在电脑、网关或服务器，具体部署是产品选择。用户可以手动下载安装包，首次安装并不必然依赖 ADB。反过来，单有 B helper 不等于引擎已迁到手机。

## 2. 当前随包 APK：本次独立二进制核对

对象：[u2-server-0.5.0.apk](../../VCPDistributedServer/Plugin/AndroidController/vendor/u2-server-0.5.0.apk)。SHA-256：

```
6d16845d28fea01d5ae069221d9df307c74e70b780eb99ac0b28cf8f6135a50f
```

以 Python zipfile 提取七份 DEX，Android SDK build-tools 36.1.0 `dexdump -d classes6.dex > classes6.dex.txt` 离线检查实际调用和分支，不以字符串存在替代接线证明。下列为 **C：静态二进制路径**，不是 ROM 真机结果；偏移为 classes6.dex code item 的十六进制文件偏移。

| 方法 | 偏移 | 实际分支/调用 |
| --- | --- | --- |
| `com.wetest.uia2.stub.AutomatorServiceImpl.dumpWindowHierarchy(ZIZ)` | `0x0072bc` | compressed/maxDepth/rootInActive 透传给自家 Dumper |
| `AccessibilityNodeInfoDumper.dumpWindowHierarchy(UiDevice,OutputStream,int,boolean)` | `0x0050fc` | 对 `getWindowRoots(device,rootInActive)` 返回数组逐根序列化 |
| `AccessibilityNodeInfoDumper.getWindowRoots(UiDevice,boolean)` | `0x004930` | 先加入 activeRoot；**true 提前返回**；false 再遍历 windows，加入非 null root；null root 只写日志后跳过 |
| `AccessibilityNodeInfoDumper.getWindows(UiAutomation)` | `0x004c6c` | SDK>=30 调 `getWindowsOnAllDisplays()`，展开每 display 列表；否则 `getWindows()` |
| `AutomatorServiceImpl` 构造路径 | 指令 `0x007952` | 已调用 `UiAutomation.setOnAccessibilityEventListener(...)`；不能据此声称宿主已有通用事件订阅 |
| `AutomatorServiceImpl.waitForWindowUpdate(String,long)` | `0x006a50` | 调 `UiDevice.waitForWindowUpdate`；宿主 RPC 签名表尚未开放 |

[宿主 dump](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js) 已支持第三参，默认 `options.rootInActive !== false`；所以当前主路径只取 active root，**不是 APK 只能取单根**。无需重编 APK 即有请求多根的调用形状，但 Service 尚未建立窗口感知的公共契约，本轮不改变默认值。

补核 classes2.dex 的 `androidx.test.uiautomator.UiDevice.getUiAutomation()` code item `0x010534`：取得 serviceInfo 后，flags 需同步时指令 `0x0105c6` 执行 `flags |= 64`，`0x01061e` 调 `setServiceInfo`；serviceInfo 为 null 时只告警，不能把该静态设置路径视为设备实际生效证明。64 即 [FLAG_RETRIEVE_INTERACTIVE_WINDOWS](https://developer.android.google.cn/reference/android/accessibilityservice/AccessibilityServiceInfo?hl=en#FLAG_RETRIEVE_INTERACTIVE_WINDOWS)。该 flag 是窗口枚举的必要条件之一；返回的是可交互窗口集合，不是所有 WMS 窗口或完整遮挡图。

[UI 图层](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph.js) 没有消费 `display-id/window-id/drawing-order` 建立窗口身份与遮挡模型。[RPC 表](../../VCPDistributedServer/Plugin/AndroidController/lib/rpc-methods.js) 只开放选定方法。**底层可取 → APK 有实现 → RPC 暴露 → 宿主接线 → 设备效果准入，五件事不能互相替代。**

`display-id` 只标显示器，不是 windowId；drawing-order 是节点的绘制顺序信息，不是跨窗口 Z 序。多根扁平合并不保留窗口 type/layer/root-null 原因，也不保证不同显示器的坐标、裁剪和输入目标正确。不能简单把 true 改 false 就宣称支持多窗口/多显示器。

## 3. 纠正原 A/B 论证

### 3.1 多窗口和事件并非 AccessibilityService 独占

[UiAutomation 官方 API](https://developer.android.com/reference/android/app/UiAutomation) 有 `getWindows()`（API21）、`getWindowsOnAllDisplays()`（API30）、`setOnAccessibilityEventListener()`、`executeAndWaitForEvent()`、`waitForIdle()`。A/C 可以利用这些能力；当前 APK 的具体能力以上述 DEX 为准。

本次抓取的[上游 Dumper](https://raw.githubusercontent.com/openatx/android-uiautomator-server/master/app/src/androidTest/java/com/github/uiautomator/stub/AccessibilityNodeInfoDumper.java) 同样先加入 active root，再实际遍历 window roots；API30+ 的 all-displays 分支不是被注释掉的死代码。注释的是旧 helper 调用，不是当前直接 API 调用。此前“窗口列表算出后丢掉”的解读错误；滚动 master 也不能代替随包二进制证据。

[上游 AutomatorServiceImpl](https://raw.githubusercontent.com/openatx/android-uiautomator-server/master/app/src/androidTest/java/com/github/uiautomator/stub/AutomatorServiceImpl.java) 还有 toast listener、waitForWindowUpdate 等路径。事件通知可用来触发重新采样和使旧凭据失效，但不是完整状态流，也不证明纯像素静止。需要事件合并/有界队列、丢事件与重连后的全量 resync、epoch/缓存失效，不能直接替换现有验证判据。

### 3.2 敏感数据不等于 B 专属诊断，空壳也不是确定原因

Android14 的[UiAutomationConnection](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/core/java/android/app/UiAutomationConnection.java) 注册自动化服务时默认 `setAccessibilityTool(true)`（隐藏测试 flag 可改变它）。[节点过滤](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/core/java/android/view/AccessibilityInteractionController.java)与[事件过滤](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android14-release/services/accessibility/java/com/android/server/accessibility/AbstractAccessibilityServiceConnection.java)取决于 tool 等属性，不是只看“是否安装 App”。不能把 `accessibilityDataSensitive` 写成 A 必输、B 必能诊断的能力。

root 为 null、只有空壳、窗口列表缺项，可有生命周期、交互窗口定义、缓存、提供者、自绘/虚拟节点或数据敏感等多种原因。没有系统明确证据时只输出 `rootUnavailable/limited/unknown` 与采样来源，不能给出 `blockedBySensitivePolicy=true` 的确定归因，更不能为读取受保护数据伪装成 accessibility tool。

A 可复用[已有 fresh probe](../../VCPDistributedServer/Plugin/AndroidController/lib/adb.js) 的 Awake/keyguard/focus/display 证据改善空树上下文；窗口覆盖/输入法也需独立、可缺省、带时效的证据，不能仅由包名或 0 节点反推。没有输入法窗口不能直接等价键盘收起，焦点窗也不必等于应用 resumed activity；结构化 API 不等于跨来源原子快照。

### 3.3 “内容价值零”“61ms 已够密”都说过头

UiAutomation 与 AccessibilityService 共享无障碍基础设施，但服务 flags、窗口选择、压缩/深度/可见性过滤、缓存与 App provider 会影响结果。可返回内容可能不同，不能一概写“内容价值零”；两者也都不能保证拿到自绘像素的语义，不能绕过安全保护。

历史 61ms p50 / 122ms p95 是特定 dump 样本，不是当前 Observe、动作闭环或无线长稳数据。[性能记录](android-performance-baseline.md)已有另种口径 Observe p50=400ms/p95=466ms/n60，必须按 workload 区分。事件驱动可能显著减少无变化时的 CPU/电量/流量、检测等待和短暂变化遗漏；价值要测端到端 p95、失效检测时间、遗漏率、宿主/设备负载和长稳，不能用单次 dump 很快否定。事件也不保证每帧动画有通知。

### 3.4 B 的收益和成本必须同时算

B 的合理主张是**不要求持续 ADB/开发者调试连接、可产品化的安装/配对/状态/停止体验**，不是独占多窗口、事件或敏感数据。App UID 的权限可更窄，但无障碍与远程网络入口仍高敏；必须有认证、加密、设备绑定、撤销、最小权限与安全更新。稳定性需比较锁屏/休眠/换网/撤权/杀进程/升级，不得从“无 ADB”推导更稳。

无障碍截图与 MediaProjection 是不同 API 路径，不是每种 B 都要同时索取通知、悬浮窗、MediaProjection；按所选功能和系统版本声明权限：

- [AccessibilityService](https://developer.android.google.cn/reference/android/accessibilityservice/AccessibilityService)：`dispatchGesture` API24+ 需 canPerformGestures，返回 true 仅表示派发，还需 completed/cancelled callback；会取消正在进行的其它手势。`takeScreenshot` API30+ 需 canTakeScreenshot，`takeScreenshotOfWindow` API34+；有频率、权限、无效窗口/显示器、安全窗口错误，不是任意频率的 scrcpy 替代品。
- [MediaProjection](https://developer.android.google.cn/media/grow/media-projection#user-consent)：每次 capture session 用户同意；Android14+ 授权 token 不得重复用于 createVirtualDisplay。onStop 清理、重新授权、适用 target 的 FGS 类型/权限须落地；不能在断线后偷偷复用授权。
- [FGS 类型](https://developer.android.google.cn/develop/background-work/services/fgs/service-types#connected-device)和[后台启动限制](https://developer.android.google.cn/develop/background-work/services/fgs/restrictions-bg-start)：Android14+ 要匹配类型/权限/前置条件；connectedDevice 可覆盖特定外部网络设备交互，不是任意 socket 永久保活许可证，projection 应用 mediaProjection 类型。可见通知不保证进程不被杀。
- [官方无线 ADB](https://developer.android.google.cn/tools/adb#connect-to-a-device-over-wi-fi)：Android11+ 手机支持无线配对，无需持续 USB；仍需开发者选项、授权和可用网络。已配对不等于网络发现/长稳总成功。
- [Portal README](https://github.com/droidrun/mobilerun-portal/blob/main/README.md)与[local API](https://github.com/droidrun/mobilerun-portal/blob/main/docs/local-api.md)：App 可复制本地 token，ADB 查询只是可选路径；HTTP/WS、本地 token 与可选 reverse connection 体现的是产品部署，token 不等于 TLS，提示 Unrestricted Battery 也不是后台永活保证。no-a11y 子集不代表树/手势/截图无需 a11y。不能把 Portal 声明的低版本兼容当作系统截图 API 最低版本或本 ROM 效果。

这些都是静态官方条件，实际截图、撤权与后台恢复仍需按目标 ROM 测试。

## 4. 当前决定与触发条件

**当前：不启动 B 重写、不更换随包 APK、不默认开启 multi-root。** 先做已有 M2.5/M2.6 证据与策略闭环：owner/精确排干、分源、统一 display/stable、读返回与写派发共用策略门；无可信批准协议则拒绝并返回 needsConfirmation，不能用模型 confirmed=true。词表只是启发式，不是付款安全的完整方案。

有窗口/事件的真实任务缺口时先用固定靶场验证 A 已有调用；需要结构化 envelope、事件 resync 或可靠 owner 握手时评估 C 的小范围可构建分支。若 B 的产品目标明确为“无需开发者调试、用户可安装启停、长期直连”，或同条件长稳显示 ADB 是主要失败来源且 B 原型显著改善，再正式立 B；原型仍须通过现有回执、取消/未知禁重放、权限撤销、截图/动作能力降级及跨 ROM 准入。

即使未来选 B，策略、回执、租约与证据抽象仍可复用；但节点/window/display 寻址与动作后端是否等价，要验证而不是预先承诺一行不改。
