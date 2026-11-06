# 旋转真机验收：靶场改造、8/8 矩阵与横屏半程

日期：2026-11-05（夜间轮）。状态档位与数字只在 [README 状态表](README.md) 维护，本文只放本轮证据与边界。

## 结论

**旋转能力本身验过了：8/8 PASS，exit 0。** 横屏下的完整 M1.5 只跑到 9/14，随后因无线链路瞬断触发安全停止；剩余 5 项**没有被验收**，原因是设备端残留进程让 RPC 无法重新绑定、CLI 回退又用不了。这两条要分开看：前者是准入结论，后者是环境与健壮性欠账。

后续更新：owner 生命周期缺口已单独修复并完成本机无线重绑专项，见[修复记录](2026-11-05_android-owner-rebind-report.md)。以下保留当时诊断；本次修复没有补验剩余横屏用例。

| 矩阵 | 结果 | 日志 |
| --- | --- | --- |
| 旋转用例（8 项） | **8/8 PASS** | `rotation-run5.log` |
| 竖屏 M1.5 基线（改造后） | **14/14 PASS** | `portrait-m15.log` |
| 竖屏 M2 基线（改造后，最终靶场） | **14/14 PASS** | `portrait-m2-final.log` |
| 横屏 M1.5 | **9/14**，5 项未验收 | `landscape-m15.log`、`landscape-m15-rest2.log` |

## 靶场改造

之前整套矩阵物理上转不了：`AndroidManifest.xml` 把活动钉死在 `screenOrientation="portrait"`。本轮改动：

1. **解除 portrait 锁定**，并在活动上声明 `configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboardHidden"`。这一条是必须的：三个验收脚本都断言 fixture `session` 不变，而默认旋转会重建 Activity、换掉 session，整轮会以 `FIXTURE_SESSION_CHANGED_STOP` 停止。
2. **靶场内部旋转入口**：导航栏新增 `nav_rotate` 按钮，调用 `setRequestedOrientation(...)` 在竖/横之间切换。这样旋转验收**不需要** `settings put system user_rotation`，也就不触碰任何系统设置，用完不用恢复。
3. **状态里暴露独立证词**：`publish()` 新增 `rotation`（`Display.getRotation()`）、`rotateRequests`、`width`/`height`（`getRealMetrics`）。验收脚本据此判断方向与尺寸，不依赖插件的自述。
4. **动画窗口改为到 STOP 为止**（`ANIMATION_CAP_MS = 600_000`）。原来 START TEXT 20 秒、START MOTION 30 秒就自停；链路慢下来时窗口在用例中途耗尽，本轮就把 `IdleMotionTimeout` 伪装成 `FIXTURE_MOTION_EXPIRED` 红了一次——那是环境信号冒充产品信号，不是产品问题。注意：这条改动改的是**靶场**，不是产品阈值。

改完重建（`node scripts/android-m15-fixture/build.cjs --sdk F:/AndroidSdk`）并装机，竖屏 M1.5 与 M2 都复验为 14/14，说明改造没有破坏原基线。

## 旋转 8 项：验的是什么

| 用例 | 断言 | 实测 |
| --- | --- | --- |
| PortraitContext | 插件 `context` 与靶场 `rotation`/尺寸一致，portrait 宽<高 | PASS，epoch=1，1440×3168 |
| RotateToLandscape | 旋转后宽>高、session 不变（实例没重建） | PASS，rotation=1，3168×1440 |
| LandscapeContext | 横屏 context 一致、epoch 前进、裁剪区域轴不互换 | PASS，epoch=2，region 120,80,640×360 → 图 1080×608 |
| StaleIndexAfterRotation | 旋转前的 `index+snapshotId` 必须被拒 | PASS，`STALE_SNAPSHOT` |
| StaleFrameAfterRotation | 旋转前的 `frameId` 像素动作必须被拒 | PASS，`STALE_FRAME` |
| LandscapeScroll | 横屏 `Scroll` 仍按容器轴滚动并真的滚了 | PASS，scrollY 0→520，通道 rpc |
| LandscapeIdleStable | 横屏 `Wait mode=idle` 仍判 `layout_stable` | PASS |
| RotateBackRejectsOldCredential | **转回同一竖屏后旧凭据仍死** | PASS，`STALE_SNAPSHOT`，epoch 1→3 |

最后一条是这轮最有价值的一条：转回原来的方向、几何完全一样，旧 `snapshotId` 依然被拒。这证明撤销依据是 **epoch**，不是"看起来一样就复用"。

## 横屏 M1.5：跑到哪里、怎么停的

- 第 1–9 项通过（长按、双击、语义/像素拖拽、双指缩放、IME enter/search、Ctrl+A）。
- 第 10 项 `KeyComboMOVE_END` 在 reset 阶段后 gate 返回不安全，整轮停止（`UNSAFE_OR_UNPROVEN_TARGET_STOP`）。安全门禁**按设计**拒绝，不是误判通过。
- 随后定向补跑剩余 5 项，5/5 全部 `ADB_FAILED`。

## 为什么补跑会全线 ADB_FAILED（环境欠账，不是旋转缺陷）

诊断链：[`diag-adb-failure.cjs`](../../artifacts/android-rotation-2026-11-05/diag-adb-failure.cjs) → [`diag-transport.cjs`](../../artifacts/android-rotation-2026-11-05/diag-transport.cjs)。

1. 失败点不是旋转，而是 `uiautomator dump` 这条 **CLI 回退路径**：`adb shell uiautomator dump` 稳定返回 **exit 137（SIGKILL）**，连跑两次都一样。
2. 之所以走回退：`UiServer.start()` 返回 `UI_SERVER_OWNER_UNBOUND`（"owner INFO 认证或响应失败"），`owner.status = released`、`binding = null`；carrier 哈希是对的（`6d16845d…`）。
3. 设备上还挂着一个 `app_process`（pid 27115，`com.vcpchat.uiautomator.Owner`），`/data/local/tmp/vcp-ui-owner.jar` 已不存在，`adb forward --list` 里留着两条指向已死端口的转发（`tcp:9680`、`tcp:9691`）。
4. 清掉那两条残留转发后重试，`start()` 仍是 `UI_SERVER_OWNER_UNBOUND`；`recoverOwner` 也没法用（它要求"本会话 owner 独立消失证明"，而这次是**重新绑定**失败，不是隔离待解除）。

**这是一条真实的健壮性缺口，与旋转无关，但在旋转这一轮暴露了**：无线链路瞬断后，插件的老 owner 进程可能变成孤儿；孤儿占着 UiAutomation 时 CLI 回退被系统 SIGKILL；于是 RPC 起不来、回退又不通，只能人工清理。它该单独修，不该算在旋转头上。

> 我没有对那个进程做定向 kill。项目约定是 stop 走 owner 自退出 + 独立消失证明，宽泛 kill 是明确禁止的；这条边界我保持不动，把结论交给你决定下一步。

## 复现命令

```powershell
$s = 'adb-beca2585-utuYDs._adb-tls-connect._tcp'   # 无线端口会变，用 `adb mdns services` 取当前值
node scripts/verify-android-rotation.cjs --probe --serial $s --adb D:/AI/tools/platform-tools/adb.exe
node scripts/verify-android-rotation.cjs --suite --serial $s --adb D:/AI/tools/platform-tools/adb.exe
```

靶场旋转不需要系统设置；横屏跑其它矩阵前，先在靶场点一次 `nav_rotate`（或用 `input tap` 命中它的 bounds）。

## 边界

- 只在一台 PJZ110 / Android 17 上验过。**跨 ROM 仍未做**——那需要第二台设备，先采 `dumpsys window displays` / `policy` / `power` 与 `uiautomator dump` 的原始格式，再按正向证据扩白名单。
- 多 display 仍是拒绝策略（`displays.length !== 1` 直接 unknown），本轮没有放宽。
- 横屏只覆盖了上述 9 项；`EraseText2`、两个 `ScrollUntil`、`ActionHistoryPure` 与结构/Collect 组在横屏下**尚未验收**。
- 旋转中途派发（动作执行到一半转向）本轮没有专门构造；覆盖的是"旋转后旧凭据失效"。
