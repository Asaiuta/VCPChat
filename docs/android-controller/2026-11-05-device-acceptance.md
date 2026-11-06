# M3 前真机验收：四组矩阵与离线回归

日期：2026-11-05（晚间轮）。工作区 `D:\AI\VCPChat`。状态档位与数字只在 [README 状态表](README.md) 维护，本文只放本轮证据与边界。

## 结论

同一台 PJZ110 上跑完四组矩阵，全部 exit 0：

| 矩阵 | 结果 | 日志 |
| --- | --- | --- |
| M1.5 动作语汇 | **14/14 PASS** | `m15-suite-run1.log` |
| M2 寻址与验证 | **14/14 PASS** | `m2-suite-run1.log` |
| 结构关系 + Collect | **5/5 PASS** | `structural-collect-run1.log` |
| 原生人工批准/交还 | **4/4 PASS** | `native-human-run1.log` |

完整离线回归 1925/1925，0 失败/取消/跳过，exit 0（`offline-final.log`）。原始产物、退出码与清单见 [artifacts/android-accept-2026-11-05](../../artifacts/android-accept-2026-11-05/)。

## 环境

- 设备 PJZ110 / Android 17（API 37）/ 1440×3168 / 无线 ADB `192.168.137.193:45947`（transport 1）。
- 只使用零权限固定靶场 `com.vcpchat.m15fixture`。靶场由 agent 用 `am start` 切到前台——门禁要求的是「已安装的隔离靶场在前台」，不是「人手动点开」；没有解锁、没有改系统设置、没有装包。
- 生产代码摘要仍为 `b6f1689e…45c`（同 [离线批次](2026-11-05-no-ocr-offline.md)）。本轮只改验收脚本与测试，未动生产 JS/vendor/manifest。

## M1.5：历史两条红灯的去向

上一轮（12:42）的红灯是 `DoubleTap`（`INDEPENDENT_READBACK_MISMATCH_STOP`），不是 `ScrollUntilHost`。本轮：

- `ScrollUntilHost` 4 次 shell swipe 后 PASS，`ScrollUntilRpc` 单次 scrollTo PASS。此前「主机正面积相交 vs 靶场 ≥32dp」的分歧已由 `scroll-axis-interior` 契约收口，本机不再复现。
- `DoubleTap` 本轮 PASS，且单独复跑 3 次连续 PASS（共 4 次）。双击窗口仍是宿主派发窗 120ms、目标间隔 100ms、20ms 短按，没有放宽。

**但这不等于双击稳定。** 12:42 那次失败与窗口错过无关（两击都已 dispatched），当时没有落盘计数器，无法判断是设备一次都没认、还是认成两次单击。本轮给 `verify-android-m15.cjs` 加了读回诊断：读回不匹配时附带白名单内的 fixture 计数前后值与变化列表，且不含文本、坐标、selector；并由 `verify-cli.test.cjs` 锁定「零移动 → changed 为空」与「重复计数 → doubleTap 偏移 2」两种签名。如果它再次变红，日志会直接说明属于哪一类。该改动只影响验收脚本，评分标准与阈值未动。

## M2：稳定复现

14/14 与 08:xx 那轮同结果：定位/序列 6 项、元素截图 4 项、idle 4 项同轮通过，无 case 重试。

- 运动用例仍 `unknown / IDLE_TIMEOUT`，5 份完整采样的布局摘要与色块左边界各不相同，独立 Provider 的 motionBefore/After 都 true（ticks 49→160）。这是正确行为，不是绿灯替代。
- `layout_stable` 仍只保证两次完整布局相同；诊断仍记 `dumpFreshness=unproven`、`independentSampleTimeGeometry=not-collected`。

## 结构关系与 Collect

`ChildOf` / `SiblingOf` / `HasDescendant` / `CollectOnePage` / `CollectUntil` 全通过。`CollectUntil` 采 7 页 78 项、6 次输入、`stopReason=UNTIL_MATCH`。`CollectOnePage` 的 `outcome=unknown` 是设计内的：`maxPages=1` 只采当前页，不证明列表结束，外层断言仍通过。

## 原生人工批准/交还

四项都由真实 Electron `dialog.showMessageBox` 驱动，按钮由**用户本人**在键盘前点击，agent 没有合成任何批准答复：

| 用例 | 人工动作 | 结果 |
| --- | --- | --- |
| ApprovalReject | 点「拒绝」 | 拒绝生效，靶场计数保持 0 |
| ApprovalAllow | 点「允许这一次」 | 本次放行，计数 +1 |
| HandoffContinue | 点「继续」 | 三步序列 `completed`，计数 +2 |
| HandoffStop | 点「停止」 | 序列 `stopped`、`unknown`；旧 `index+snapshotId` 随后被 `STALE_SNAPSHOT` 拒绝，计数不变 |

每个用例都断言「恰好多了一次人工提示」（`promptCount` 差 1），所以不是空跑通过。

宿主侧日志里有 `CloseMessageBox called with nonexistent ID` 的 Chromium 提示。它出现在每次答复之后，四项判定均符合预期、无残留窗口，判定为 Electron 关闭消息框时的无害告警；没有据此修改产品代码。

## 本轮发现的两条工程问题

1. **靶场模式是内存态，跨矩阵不隔离。** 原生人工组把靶场留在 `m2` 模式；随后直接跑 M1.5 会以 `FIXTURE_STATE_INVALID` 停在 gate 读取（`parseState` 只接受 `gestures`/`keyboard`/`scroll`），在它自己的 `nav_gestures` 复位之前。这不会误判为通过，但会让下一次验收无谓失败。临场用 `am force-stop` + `am start` 复位；该次停止保留在 `m15-doubletap-precondition-stop.log`。要么让 M1.5 复位先于解析，要么在矩阵序列里显式复位靶场，二者都该由验收脚本承担。
2. **`ELECTRON_RUN_AS_NODE=1` 会让原生组直接崩。** 本机环境带着这个变量时，`require('electron')` 返回路径字符串，`app.setPath` 抛 `TypeError`，第一行就以 exit 1 结束而不产生判据。启动原生组前必须清除该变量；这不是产品缺陷，但会伪装成「原生组不通过」。

## 仍然是欠账

跨 ROM 矩阵、旋转与多 display、真实在途未知 RPC 注入、30–60 分钟 soak、历史性能基线迁移——一条都没动。本轮把单 ROM 固定靶场的四组矩阵补齐了，仅此而已。

M3 OCR/模板依旧零实现；M4.5 的 P0 探针 A1–A5 仍未跑。
