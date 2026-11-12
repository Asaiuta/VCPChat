# M4.1 实时人工接管：协议变更与验证边界

2026-11-12。范围：`AndroidController` 默认屏人工接管的输入通道。**本文只记录本批实际执行过的验证**，档位与数字以 [README 状态表](README.md) 为准。

## 1. 改了什么

快照式协议整体删除，不是新增分支：

| 旧（2026-11-06 首批） | 现（本批） |
| --- | --- |
| `takeover-refresh` 拉取一次截图快照 | 删除。视频帧持续下发，输入绑定当前显示帧 |
| `takeover-input` 派发一次点击/滑动/按键，每次输入后重新采图 | 删除。改为 `takeover-touch` / `takeover-key` 两条单向流 |
| 快照十四秒有效，过期/旋转/上下文变化须刷新 | 无快照有效期。画面方向或比例变化时抬起当前手势并要求重新按下 |
| scrcpy 仅出流，输入走既有 RPC | scrcpy 以 `control=true clipboard_autosync=false` 启动，输入走 control socket |

`takeover-touch` 与 `takeover-key` 的高频特性决定它们不排队：成功不回执，失败按消息回报一次 `takeover-input-error`；需要回执的只有 `takeover-start` / `takeover-end`，仍受 `busy` 保护。这个取舍写在 [takeover-channel.js](../../VCPDistributedServer/Plugin/AndroidController/lib/takeover-channel.js) 的注释里，不是遗漏。

## 2. 坐标与安全边界

- pointer 坐标按**客户端显示帧像素**上报，服务端按编码帧宽高缩放；宽高比偏差超过 2% 视为旋转，抬起手势并拒绝本次输入（`VIDEO_SIZE_CHANGED`）。
- pointer capture：按下后拖出画面夹到边缘；失焦、页面隐藏、断线、会话结束都补发抬起，避免设备端卡在按下态。
- 只有 `down/move/up` 三动作，`move`/`up` 必须先有被接受的 `down`，否则直接丢弃，不落到设备。
- 按键仅开放返回/主页/最近任务（4/3/187），其它键码一律 `INVALID_ARGUMENT`。
- 会话期间约每秒采样一次前台包；新的 `down` 与按键要求 3 秒内的允许样本，命中禁止访问/只读列表即抬起并提示。**这是采样窗口，不是逐写权威**，窗口期内的越界写不在本批防护范围内。
- 文本、剪贴板、多指、副屏均未开放。人工接管由会话批准覆盖逐次确认与敏感词确认——因为执行人就是用户本人，不是模型。

## 3. 本轮跑过的验证

### 3.1 接管限定回归

`tests/android-takeover-{lease,service,channel,viewer}.test.js` 与 `tests/android-viewer-presentation.test.js`，**92/92 pass，0 fail/skip**，exit 0，5.145s。全部为替身设备与替身 DOM。

### 3.2 隔离浏览器探针

`scripts/test-android-takeover-browser.cjs` 起真实 `StreamServer` + 真实 HTTP/WS + 真实 Service 状态机，设备传输、scrcpy control 与原生批准为替身；`artifacts/android-takeover-live-2026-11-12/probe.cjs` 以真实 WebSocket 驱动整条协议。

结果 `DONE`，exit 0：

- 取页面 → 拿会话 cookie → 建 WS（同源 + cookie 双重校验，无 cookie 时 403，已实测）。
- `takeover-start` 批准通过，`mode=live`、`policy=allowed`、`video=100×200`。
- `down(10,10)` / `move(50,100)` / `up(99,199)` 三次注入坐标与输入一致，顺序正确。
- `back` 产生成对键码 `[0,4]`、`[1,4]`（按下/抬起）；`teleport` 被拒，未触达设备。
- 宽高比不符的 `down(500,10,400×200)` 被拒为 `VIDEO_SIZE_CHANGED`，且未注入。
- `takeover-end` 后状态回 `idle`、`serial=null`、`epoch` 由 1 进到 2。

注意：该夹具帧走 JPEG 回退，**H.264 + control socket 的真实联动没有在这一轮跑过**。夹具本身也需要本批修复才能驱动实时路径（补 `controlReady`/`injectTouch`/`injectKeycode` 与 `hub.serial`），这点说明旧的隔离浏览器证据不能直接继承到新协议。

## 4. 没有验证的（不要读成已通过）

- 真机 H.264 出流 + control socket 同时就绪；scrcpy server 版本与 `clipboard_autosync=false` 在目标 ROM 的实际行为。
- 真实 Electron 原生批准对话框；本批的 `authorize` 是替身，永远返回 true。
- 真实帧缩放偏差：夹具是 1:1 坐标，真机上编码帧与显示帧可能不同分辨率。
- 前台包每秒采样的真实命中率与漏检窗口；跨 ROM 的前台包读取差异。
- 连续 pointer 长按、快速连点、双指、指针在旋转瞬间的边界。
- 十分钟会话上限的长稳表现，以及断线/重连时的抬起补偿在真实网络下的表现。

## 5. 下一步的真实设备路径

按成本从低到高，任一步失败都保留为失败，不用离线用例追绿：

1. 同一台已授权设备上跑一次 `Observe mode=image`，确认 H.264 出流正常，再确认 `control=true` 时 scrcpy 能起 control socket（`scrcpy-hub` 的 `controlReady()`）。
2. 打开真实 Electron 宿主，走一次原生批准对话框；记录批准超时与拒绝两条路径，而不是只测通过。
3. 在实时画面上做一次点击、一次拖动、一次返回；用独立 `Observe` 采树核对目标控件是否真的被点中，而不是只看录屏。
4. 触发禁止访问列表命中的应用，验证 3 秒窗口内确实抬起并提示。
5. 旋转设备后立刻触摸，验证 `VIDEO_SIZE_CHANGED` 与抬起补偿。
6. 让会话跑到十分钟上限，确认超时撤销且不自动恢复原 AI 任务。
