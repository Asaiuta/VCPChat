# Android 系统能力适配（首批实现与验收）

## 范围

新增 SystemCapabilities 与 System。能力声明共53项：18项固定读取、27个公开页面入口、4项固定设置、4种用户完成草稿。声明不等于设备已支持；System operation=probe 为只读探测，targetOperation=read/navigate/set。设置可读仅报告 writable support=unknown，不通过写入探测权限。

System 必须显式 serial，经主进程 AndroidSystemAuthorization 读取当前主配置的分设备授权，严格匹配风险版本1、acknowledged=true、指定组true。配置不可读立即拒绝，不从备份或缓存恢复权限。撤销采用全组false墓碑，避免全局设置深合并保留旧授权。每个变更派发前重新检查授权。

应用设置页“Android 系统授权”沿用现有设置导航与原语：设备身份与风险确认成一张卡，六个能力组成第二张卡，撤销是第二张卡的行尾动作；行由 field-renderer 直出 canonical 行，布尔控件是宿主 Toggle 原语，界面只承载标签、当前值与状态。授权草稿在全局设置保存成功后生效。此页仅约束 System 新入口，不能视为旧通用 GUI 工具的全局沙箱。ADB UID 已有权限不代表用户已授权。

## 命令

```text
command=SystemCapabilities
command=System serial=设备ID operation=read capability=batteryLevel
command=System serial=设备ID operation=probe capability=wifi targetOperation=navigate
command=System serial=设备ID operation=set capability=screenTimeout value=300000
command=System serial=设备ID operation=draft capability=calendarEvent params={title,begin,end}
```

适配器内部 value 是数值、params 是对象；服务边缘兼容文本工具协议：value仅接受严格十进制整数字符串，params接受最长8192字符JSON对象文本。固定字段校验拒绝 approved、任意URI/action/extras/provider/shell。系统接口不传输模型凭据。

- read：电量、充电状态、制造商、型号、Android版本、API级别、安全补丁、亮度原始值、Wi-Fi/蓝牙/飞行模式设置值、自动亮度、息屏时间、自动旋转和用户旋转；补充时区、自动时间与自动时区。Wi-Fi/蓝牙值仅为系统设置存储值，不保证已连接。
- navigate：设置总页、Wi-Fi、蓝牙、显示、声音、存储、电池、位置、日期时间、语言、输入法、无障碍、隐私、安全、应用、通知、无线、NFC、投屏、VPN、闹钟列表、设备信息、飞行模式、流量使用、默认桌面、打印、字幕。使用公开Intent的当前处理程序，不承诺处理程序必为OEM系统包。只返回dispatched，不冒称页面到达。
- set：brightnessMode=0/1、screenTimeout=15000–1800000ms、autoRotate=0/1、userRotation=0–3。前读、绝对赋值一次、读回核验；不重试。没有恢复令牌，旧值包含在回执中；不能宣称自动回滚。亮度/音量具体范围尚未适配，不硬编码255。
- draft：dial打开拨号页，不CALL；sms通过SENDTO打开单接收方草稿；contact打开INSERT编辑器；calendarEvent打开INSERT日历编辑器。由用户拨号、发送或保存，不读私有数据库、不自动提交、不支持skip-ui。成功与异常回执均不回显接收人和正文；包括解析/启动阶段ADB超时。启动绑定已解析组件。第三方处理应用会收到这些草稿字段，应先核对手机显示。插件没有直接发送/保存，但不能保证第三方程序行为，businessWrites=null、downstreamBehaviorGuaranteed=false，不宣称手机端零写入。

仅支持Android主用户0。每个授权边界检查当前用户；可变设置固定--user 0。工作资料及多用户自动化暂不支持。

## 回执

- observed：只读结果，不代表业务变更。
- dispatched：已派发页面或草稿，verified=false，需用户完成。
- verified：设置读回等于requested；no-op不写。
- unknown：派发后读回失败、不匹配或连接异常；writeAttempts=1，changed只能为实测布尔或null。不得因此重试副作用。

设备租约、整步截止及本地取消复用P0/P1。取消不保证手机端已派发动作被回滚。分布式传输取消协议尚未补齐，不宣称端到端远程取消。

## 实证（2026-11-02）

PJZ110，OnePlus，Android17/API37：18项读取成功；27个公开页面入口均解析到处理组件；4项设置可读，写入支持保持unknown。通过只读专用烟测，没有持久化授权，没有写设置、导航、发消息或创建日程。

浏览器：使用已安装Edge Chromium无头执行实际ES模块，默认拒绝→明确设备→风险确认→勾选→撤销全流程通过。另已启动隔离配置的真实Electron实例，验证真实导航分类、默认拒绝、授权、IPC保存、完整renderer reload回填、撤销保存与reload拒绝。测试不读取或修改用户真实配置；没有向手机派发动作。第4轮进一步验证了完整Electron进程终止并重启：授权持久化回填与撤销后拒绝均通过，最终连续两次完整运行通过。DOM/真实SettingsManager测试另覆盖保存持久化及坏主配置+旧备份不得授权。

运行：

```bash
node scripts/check-android-system.cjs DEVICE_SERIAL
node scripts/check-android-system-ui.cjs
```

第二条需可用Puppeteer浏览器；也可通过SYSTEM_UI_BROWSER指定已安装Chromium族浏览器。浏览器fixture不启动替代应用服务器，不更改用户真实设置。

## 已知边界与未做实机副作用验证

真实Electron页面加载、IPC保存、renderer reload及进程重启回填已验证。PluginManager→AndroidController→真实授权类的身份透传、即时撤销、伪造context拒绝、standalone无授权拒绝有隔离集成测试；main→DistributedServer接线经过独立源码审阅，未运行真实主服务器socket端到端用例。没有为了验收修改用户手机设置或创建私人业务数据，写入/失败/读回契约通过mock验证，不宣称所有OEM写入实测成功。图片生成成功，但当前模型无法读取图片，未做视觉审图验收。

独立review发现的撤销落盘、备份复权、stderr丢失、部分回填、写入回执、草稿异常泄露均已补测试修复。第三方handler信任边界通过固定动作、绑定已解析组件、明确风险告知处理，不保证第三方应用行为。按设备/能力组共享授权，连接主服务器的Agent均可使用，无调用者级隔离；模块级服务不宣称同进程多租户安全。旧值语义金测有两项continueWritingPrompt默认值差异，未为本轮改动调整此业务默认值。不得声称全仓测试全绿或系统应用全覆盖。

## 第3轮补充验证

真实Electron验收暴露隐藏Jev重试间隔 min=1/step=100/default=500 的浏览器stepMismatch，导致全局保存被HTML验证拦截。先添加有效性测试，再把step改为1，与原有1–30000整数保存契约一致；默认与边界有效性测试通过。

扩展回归381项：378通过，3失败。两项为上述历史continueWritingPrompt金测默认值差异；另1项ADB时间预算断言相差1ms，立即独立复跑16/16通过，仍记录为压力下时间敏感失败，不删测试不放宽断言。此前选择性Android/ADB/schema/save回归293/293通过。

## 第4轮最终证据

新增真实PluginManager服务注入集成测试3/3通过：使用真实授权类的严格配置读取，授权成功→同实例撤销立即拒绝，伪造toolArgs/context不能取代可信服务，未注入authority默认拒绝。配置和ADB全部隔离。

真实Electron重复验收发现瞬时设备选择器会触发全局自动保存并导致清空/重挂载，先写事件不冒泡契约，再只隔离非持久选择器input/change。权限map变化继续发正常保存事件。修复后授权→IPC落盘→进程重启回填→撤销→IPC落盘→再次进程重启拒绝连续两次通过。没有修改真实用户配置。

最终选择性回归：306项通过、0失败（Android、ADB、系统设置、Jev有效性、schema渲染、全局保存、分布式插件）；settings ownership检查通过。更广回归失败仍如第3轮记录，不以选择性回归替代全仓通过声明。
