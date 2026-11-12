# M4-F2：虚拟屏语义树（A3）与 scrcpy control 触摸（A4）

冻结于 2026-11-06，F2 首次真机运行之前。服务端沿用 F1 候选 `scrcpy-5.0.1-focus1`（SHA-256 `96549eae…df6b`），靶场沿用 `com.vcpchat.m4fixture`（APK SHA-256 `83e160f1…1c40`）。F1 的结论、首批中止记录和 P0 失败都不改写。

## 前置

与 F1 相同：SDK ≥ 34；只有默认屏、Awake、已解锁；没有其他 scrcpy/uiautomator2 自动化进程；overlay 设置为 null；靶场已经预先安装，且远端 `base.apk` 哈希与本地 APK 完全一致（`--use-installed-fixture` 必填，安装准备单独记录）。建屏后目标显示必须真实报告 TRUSTED / OWN_FOCUS / STEAL_TOP_FOCUS_DISABLED。默认屏窗口 token、焦点、尺寸、Awake 在每次采样时都必须不变；本研究仍需手机静止，以便把因果归到虚拟屏。

## A3：shell `uiautomator dump` 能否读到虚拟屏

只读。在定向输入前后各执行一次 `exec-out uiautomator dump --compressed /dev/tty`，原始 XML 全量保存。在 XML 中精确查找 `resource-id="com.vcpchat.m4fixture:id/tap_button"`，并逐字段比对独立 Provider 的同一时刻状态：

| 分类 | 含义 |
| --- | --- |
| `ATTRIBUTED` | 恰好 1 个节点，位于 `display id=<目标逻辑ID>` 分组内，文本 `M4 TAP <taps>` 与 bounds 都与 Provider 一致 |
| `UNATTRIBUTED` | 恰好 1 个节点且文本/bounds 一致，但 XML 没有任何 display 分组，无法从树本身证明来自哪块屏 |
| `WRONG_DISPLAY` | 节点所在的 display 分组不是目标屏 |
| `MISMATCHED` | 文本或 bounds 与 Provider 不一致（陈旧树或串屏） |
| `AMBIGUOUS` | 多于 1 个匹配节点 |
| `ABSENT` | 树中没有靶场按钮，只读到了默认屏 |
| `DUMP_FAILED` | 命令非零退出或输出不含 `<hierarchy` |

A3 判定：前后两次都是 `ATTRIBUTED` 才算 `PASSED`（后一次必须读到 `M4 TAP 1`，证明树是新鲜的）；两次都是 `UNATTRIBUTED` 记为 `PARTIAL`，生产不能直接用它做 display 归属；其他情况记为 `NOT_SUPPORTED`，按路线图降级到独立 UiAutomation(displayId) 或 vision。A3 是能力发现，不阻断 A4，也不能用 scrcpy control 去补 A3 的缺口。生产承运的 uiautomator2 RPC 的 display 参数本轮不测（`A3_CARRIER: NOT_RUN`）。

A3 dump 前后都要采样，Provider 的 taps 不得变化，物理屏不得变化；否则整轮失败。

## A4：scrcpy control socket 触摸

精确发送一次点击，由两条 `INJECT_TOUCH_EVENT`（type=2）消息组成：ACTION_DOWN 之后跟 ACTION_UP。每条 32 字节，大端：type u8、action u8、pointerId i64（-2，通用手指）、x i32、y i32、screenWidth u16、screenHeight u16、pressure u16 定点（DOWN 为 0xffff，UP 为 0）、actionButton i32 = 0、buttons i32 = 0。坐标取 Provider 报告的按钮中心；screen 尺寸必须等于 scrcpy 会话回报的视频尺寸，并等于目标显示尺寸，否则不写入（`CONTROL_GEOMETRY_MISMATCH`）。

scrcpy 对触摸没有 ACK，socket 写成功只算 dispatched。之后最多轮询 Provider 3 秒，只读不重发。通过条件与 F1 相同：同 session/进程/task/display，taps 精确 +1，触摸事件计数增长，`deliveredDisplayIds` 包含目标屏。随后采样：物理屏不变、目标屏身份与三个 flag 不变、会话无错误。禁止发送按键、文本、剪贴板、PASTE、BACK_OR_SCREEN_ON、面板展开或 display power 消息。

## 循环

资格验证 1 轮通过后，以资格验证时的物理屏基线为准，固定 20 轮。每轮先核验靶场 APK 哈希并 force-stop，证明进程已不存在（冷启动），再用新 scid/generation 跑完整的建屏 → 启动 → 出帧 → A3 → A4 → A3 → 清理。首个失败即停止，剩余轮次记为 NOT_RUN，不重试。冻结文件（本协议、f2.cjs、probe.cjs、protocol.cjs、focus-matrix.cjs、候选 jar、APK）的哈希每轮复核。A3 分类逐轮记录，汇总时单独统计，不并入 A4 分母。

## 不覆盖

IME 与文本输入、权限弹窗、同 App 跨屏迁移与 singleTask、多指与连续手势、跨 ROM、Android 13 及以下、长时 soak、生产 AndroidController 接入。
