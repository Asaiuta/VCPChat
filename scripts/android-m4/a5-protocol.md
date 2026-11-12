# M4-A5：任务迁移、IME 与权限弹窗的落点特征化

冻结于 2026-11-06，A5 首次真机运行之前。服务端沿用 F1 候选 `scrcpy-5.0.1-focus1`。靶场使用 **a5 变体**（`.build-a5/m4-fixture.apk`，比 v1 多一个 `PermissionActivity`，并声明 `POST_NOTIFICATIONS`）；v1 APK 与 F1–F3 的记录保持不变。设备上的 v1 需用同一签名覆盖升级为 a5（`adb install -r`）；结束时卸载。

A5 测的是**行为是什么**，而不是“能不能通过”。每个场景都单独建一块新虚拟屏，跑完单独清理。判定分两层：
- **安全不变量**：违反即失败。
- **落点分类**：只记录事实，作为 P3/P5 生产策略的输入。

## 场景

| # | 场景 | 是否动物理屏 | 安全不变量 | 记录的分类 |
| --- | --- | --- | --- | --- |
| S1 | 热启动：靶场已在虚拟屏上，再次 `am start --display V` MainActivity | 否 | F3 因果判据零违规；靶场不出现在物理屏 | `instancesOnTarget`、`newIntentCount`、是否新建了 task |
| S2 | singleTask 物理→虚拟：先把 SingleTaskActivity 启动到 display 0，再 `am start --display V` 同一组件 | **是**（靶场会短暂出现在物理屏） | 物理屏 uniqueId/尺寸不变；清理后靶场不在物理屏、虚拟屏已消失 | `MOVED_TO_TARGET` / `STAYED_ON_PHYSICAL` / `NEW_INSTANCE_ON_TARGET` / `UNPROVEN` |
| S3 | singleTask 虚拟→物理：先启动到 V，再 `am start --display 0`（模拟用户从桌面打开同一 App） | **是** | 同 S2 | `PULLED_TO_PHYSICAL` / `STAYED_ON_TARGET` / `NEW_INSTANCE_ON_PHYSICAL` / `UNPROVEN` |
| S4 | IME：用 control 触摸点击虚拟屏上 EditText 的中心（只发一次 DOWN/UP，不输入文本） | 否 | F3 因果判据零违规；靶场仍在 V 上 | `inputFocused`；IME 位置 `IME_NOT_SHOWN` / `IME_ON_TARGET` / `IME_ON_PHYSICAL` / `IME_UNPROVEN` |
| S5 | 权限弹窗：在 V 上冷启动 PermissionActivity，等待 3 秒（不点弹窗） | 可能 | 物理屏身份不变；清理后物理屏上不能留下 GrantPermissions 窗口 | `PERMISSION_ON_TARGET` / `PERMISSION_ON_PHYSICAL` / `PERMISSION_NOT_SHOWN` / `UNPROVEN` |

## 证据与分类规则

- 任务落点：靶场 Provider 返回每个实例的 displayId/taskId/session/activity，同时用 `dumpsys window displays` 的分屏段交叉核对。
- IME：保存 `dumpsys input_method` 与 `dumpsys window` 的原文。显示状态取 `mInputShown` / `isInputShown` / `mImeShowing` 中可解析的 true/false。位置取 `mImeLayeringTarget in display# N`，或包含 `InputMethod` 的 display 段。两者缺一，或彼此矛盾时，记为 `IME_UNPROVEN`。
- 权限弹窗：找出包含 `GrantPermissionsActivity` 的 display 段（分段沿用 P1 的 `windowDisplaySections`）。恰好命中一段时按其 displayId 分类；一段都没有记为 NOT_SHOWN；多段记为 UNPROVEN。

## 清理（每个场景都执行）

`am force-stop com.vcpchat.m4fixture` → 停止 scrcpy 会话（服务、forward、jar）→ 确认目标虚拟屏消失 → 确认物理屏焦点不是靶场。S5 额外处理：如果 force-stop 之后物理屏焦点**恰好**是 `GrantPermissionsActivity`，在 display 0 上发**一次** BACK，这是唯一允许发往物理屏的按键；然后执行 `pm revoke` 并清除 `POST_NOTIFICATIONS` 的 user-set/user-fixed 标志。

## 执行规则

- 只跑一轮，S1→S5 依次执行；某个场景失败时，记录后继续下一个场景，因为它们相互独立。
- 不重试。任何一个场景的清理失败，即停止后续场景。
- S2、S3、S5 会改变物理屏，**必须在用户明确同意并且不使用手机时才执行**。传 `--allow-physical` 才会运行这三个场景，否则它们记为 NOT_RUN。

## 不覆盖

文本输入与 PASTE、授予权限后的行为、多个 App 共存、跨 ROM。
