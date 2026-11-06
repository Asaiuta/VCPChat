# M4.1 首批：默认屏人工接管（2026-11-06）

## 判断

首批已接入生产 Service、宿主可信人类服务与 viewer。范围是显式设备、默认屏、有限快照点击/滑动与返回/主页/最近任务，不是实时 scrcpy control，也不是后台虚拟屏。阶段状态和最终测试数字只维护在 [状态表](README.md)。

## 使用

在安卓显示屏标题栏打开手形菜单，选择「开始接管」。宿主原生对话框默认拒绝；仅用户批准后，本 WebSocket 获得最长十分钟的临时写会话。接管后显示独立快照，不能直接操作直播帧；快照过期后先刷新。每次输入后重新采集快照，结束、关窗、断线或超时撤销会话，不自动恢复旧 AI 任务。

人工接管沿用现有包拒绝/只读策略和敏感动作门。会话批准不是逐动作批准；要求确认的像素动作仍拒绝，必须在手机上处理或结束接管改用可验证的语义动作。首批不开放任意文本、粘贴、剪贴板、长按、连续 pointer 和副屏。

## 实现与安全边界

- [step-runtime](../../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime.js)：同步保留全局接管门，取消普通 Agent、Handoff 与 M5 父执行器，等待真正 operation/ownedDrain 排干。调用取消回执或超时不作为排干证明；opaque handle 绑定设备及生命周期。
- [viewer-takeover](../../VCPDistributedServer/Plugin/AndroidController/lib/viewer-takeover.js)：会话绑定发起 socket、随机令牌、递增 epoch、显式 serial。开始与结束均撤销旧 snapshot/frame。申请失败仍等真实 drain 再最终撤销，未知设备先隔离后释放门禁。
- [takeover-channel](../../VCPDistributedServer/Plugin/AndroidController/lib/takeover-channel.js)：复用精确同源、HttpOnly 会话 cookie 的 WebSocket；读 cookie 不授写权限。请求 ID 去重、并发拒绝、消息/请求数量有界、回执队列溢出直接断开撤销。令牌不放 URL、配置、日志或持久存储。
- [Service](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)：取图复用 captureVisionShot；像素与按键复核 frameId/新鲜上下文；输入复用 executeStep、interactionGuard 和现有回执，不新增 shell 任意执行面，不打开 scrcpy control。
- [宿主批准](../../modules/services/humanInteraction.js)：独立 takeover kind，原生按钮为「拒绝/允许本次接管」，模型参数不能产生答案。未注入可信宿主时关闭功能。
- [viewer](../../VCPDistributedServer/Plugin/AndroidController/lib/viewer.html)：加载成功且尺寸核对后才接受离散手势，排除 letterbox，按实际图片坐标映射到设备。开始批准、输入、刷新均单飞；超时断开不重发；设置与连接写入在接管期间锁定。

首版采用**单个进程内全局门禁**：接管期间其它设备的 Agent 操作与连接管理也拒绝，避免 USB/Wi-Fi/mDNS 别名绕过互斥。不声称完成物理设备 canonical identity 或跨主机/外部 ADB 客户端互斥。Handoff 等待前已有 unknown 语义，取消后不能被洗成安全接管，继续保持隔离。

回执 `dispatched` 只证明输入派发，不证明 UI 或业务完成。输入已派发但自动截图失败时保留回执与 warning，返回 frame=null，不能重放；只有显式刷新取得新凭据后才能发下一操作。

## 验证与保留失败

测试覆盖入口在 [takeover lease](../../tests/android-takeover-lease.test.js)、[Service 集成](../../tests/android-takeover-service.test.js)、[真实 HTTP/WS](../../tests/android-takeover-channel.test.js) 与 [viewer DOM](../../tests/android-takeover-viewer.test.js)。限定回归含 Android、ADB、scrcpy、UI graph、GlobalJev/jev-client 与分布式取消；不是全仓测试。

真实浏览器通过隔离 [fixture](../../scripts/test-android-takeover-browser.cjs) 访问生产 StreamServer，执行批准替身→加载真实 Sharp 编码截图→点击→返回→刷新→结束→刷新页面。观察到 fixture clicks/keys/approvals 各仅一次，结束与刷新后仍 idle，没有重放；[截图](../../artifacts/android-takeover-2026-11-06/browser-takeover.png)。设备传输与原生批准为替身，浏览器通过不等于真机或真实 Electron dialog 通过。

保留的执行问题：浏览器首次截图因窗口最小化失败；恢复窗口后截图成功，没有重放已执行输入。结束后脚本等待折叠菜单内的可见按钮超时，后续直接核验 reload 仍只读/idle 并关闭任务。初期服务测试因 VM 数组跨 realm 原型不等失败，改为比较标量数组内容；提取式 viewer VM 缺显式 timer 依赖，补 sandbox 依赖；限定回归中 preload 的单个 setImmediate 不保证 JSDOM DOMContentLoaded，改为等待真实 DOM 就绪而不改生产和期望。

有界复审另外发现并独立复现：申请在15秒排干预算内超时/断线，会跳过正常申请分支的unknown检查；旧派发随后才结束时可能清全局门却未隔离设备。修正为所有close路径在实际drain之后、释放门禁之前同步回调隔离全部unknown设备，覆盖初始被抢占任务与取消中的人类输入；超时、abort、release各有不变量测试。HTTP连接操作亦纳入现有管理租约，避免同一设备选择尚在途时批准接管。没有扩大到无关架构。

本轮未连接真实手机，未自动点击真实原生批准，未重启用户正在运行的 VCPChat。加载新后台代码需要重载插件宿主/重启 VCPChat；仅刷新旧 viewer 不能替换已 require 的 Service。

## 待真实验收

用户原生批准/拒绝，默认屏点击/滑动/按键效果与独立读回；AI/M5 执行中请求接管；在途未知、无线断开和关窗排干；旋转导致旧帧拒绝；输入已派发但截图失败；跨 ROM 与长稳。保持 experimental，不借历史真机矩阵给本版本背书。
