# M1.5 隔离靶场与验收

当前状态和测试数字统一见 [AndroidController 主表](../../docs/android-controller/README.md)。历史设备记录见[真机记录](../../docs/android-controller/android-m15-device-validation.md)。无模型通用循环、长按时长、触摸取消和跨 App 启动使用[正式设备套件](../android-device-suite/README.md)，复用本靶场及无权限的伴随包。

## 安全边界

- 固定包 `com.vcpchat.m15fixture`，无任何 Android 权限、无网络能力、无外部 Intent 跳转、无文件/数据库/SharedPreferences 写入，不备份、不保存 Activity/输入框状态。
- 全部计数、编辑框内容、焦点/选区、模式与会话 UUID 仅在进程内存中。编辑框最多 128 字符，禁建议及个性化学习；只输入合成测试字符串，不输入个人内容。进程重启或页面模式切换会重置状态。
- 独立读回：只读 `content://com.vcpchat.m15fixture.state/state`，仅允许无过滤的固定路径 query；insert/update/delete 均拒绝。Provider 导出给 adb shell 读合成靶场状态，不提供重置或控制接口。
- GestureDetector 分别计 LongPress/DoubleTap 回调；拖拽只在触摸抬起落入靶框时计数；ScaleGestureDetector 独立记录缩放开始、更新及比例。键盘页记录 IME enter/search、CTRL+A、DEL 事件和真实文本/焦点/选区。滚动页用真实 ScrollView 与远端靶标，读回可见性/scrollY/目标点击计数。
- 旧 M1.5 runner 不安装或启动 App。新的正式设备套件支持显式 `--install` 安装靶场，并在已解锁设备上重置自己的靶场；两者都不唤醒、解锁、扫描或自动重试。

## 本地离线构建

依赖已安装 SDK build-tools 36.0.0、platforms/android-35/android.jar、SDK 自带 jbr 或本地 JDK。无需 Gradle、Maven、下载或全局环境修改。

```powershell
node scripts/android-m15-fixture/build.cjs --sdk F:/AndroidSdk
# 或统一入口；只构建，不访问设备
node scripts/verify-android-m15.cjs --build --sdk F:/AndroidSdk
# SDK 不带 jbr 时显式指定本地 JDK
node scripts/android-m15-fixture/build.cjs --sdk F:/AndroidSdk --jdk C:/path/to/jdk17
```

产物为 `.build/m15-fixture.apk`，同目录保存编译中间产物及公开、一次性测试签名密钥，全部由本目录 `.gitignore` 排除。构建调用本地 aapt2/javac/d8/zipalign/apksigner，并验证 APK 签名。它不安装或运行 APK。

## 默认只读探测

```powershell
node scripts/verify-android-m15.cjs --probe --sdk F:/AndroidSdk
node scripts/verify-android-m15.cjs --probe --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
```

不传 serial 时只执行一次 `adb devices -l`，不自动选设备、不加载 AndroidControllerService。没有明确在线目标时输出 `NOT_RUN`，退出码 2。传 serial 后仅读 dumpsys 与固定 Provider；必须能明确证明主用户 0 的当前焦点包精确等于靶场、显式命名态Awake（容许ROM伴随的数值1，但拒绝数字单独/矛盾/未知值）、keyguard 未显示且输入未受限、Provider resumed/协议有效，否则立即停。未知 dump 格式也拒绝，不猜测未锁状态。

## 显式真机验收

只有操作员手动打开本靶场且满足隔离条件后，才可显式运行：

```powershell
# 完整14项矩阵；host和RPC ScrollUntil分别验，不共享效果证据
node scripts/verify-android-m15.cjs --suite --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
# 修复后显式局部复验；局部通过不冒充完整deviceAcceptance
node scripts/verify-android-m15.cjs --suite --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk --only DoubleTap,DragSemantic
# 可选单长序列模式，仍保持首个失败即结束
node scripts/verify-android-m15.cjs --run --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk --scroll-strategy host
```

`--run` / `--suite` 必须显式 serial，所有动作串行；每个动作前后重新检查 exact 前台包/Awake/未锁及同一 Provider 会话，且使用插件之外的 Provider 快照作读回判据。不要在运行时切换应用、编辑靶场或操作设备。

运行前要求远端已有 `/data/local/tmp/u2-server-0.5.0.apk`，否则拒绝加载 Service，以避免正常启动路径自动 push APK。显式运行会使用 Service 既有 app_process RPC 传输及本机随机端口显示服务，最终 cleanup 只负责传输清理；不授权安装应用或跳转其它应用。

计划依次验 LongPress、DoubleTap、语义 Drag、Pinch in/out、IME enter/search、CTRL+A、移动光标到末尾、EraseText 两次 DEL、所选 host/RPC ScrollUntil，最后验证本进程 actionHistory 包含各 requestId、无合成输入参数、重复查询一致。导航和 Fill 只是靶场内显式准备动作，也有独立读回检查。

`--run` 首个失败结束整段。`--suite` 为14个独立case：LongPress800、DoubleTap、DragSemantic、DragPixels、PinchIn、PinchOut、ImeActionEnter、ImeActionSearch、KeyComboCtrlA、KeyComboMOVE_END、EraseText2、ScrollUntilHost、ScrollUntilRpc、ActionHistoryPure。每项先导航重建固定靶场模式，验证计数/文本基线重置，再验真实效果。单case失败/unknown/fallback不在该case内重放；只有真实runtime租约与ADB队列排干、cleanup完成且同会话安全gate仍满足后，才可重置并验下个case。无法证明排干、设备/安全/会话变化、serial不符立即全局停止，不覆盖忙租约。日志只输出白名单元数据，不输出原始错误message、dumpsys、Provider文本、图像或动作参数。全部14项同轮通过才输出最终deviceAcceptance=PASSED；`--only`只记显式选择的局部证据。

## 离线 CLI 安全测试

```powershell
node --test scripts/android-m15-fixture/verify-cli.test.cjs
```

22/22通过。测试使用假adb/假Service或隔离真实Service harness，不接触设备。覆盖默认probe不加载Service、参数与安全闸拒绝、厂商Awake+1及矛盾证据、真实EraseText六条RPC回执、旧run首个unknown停止、suite单项失败继续下项、无法证明lease/queue/cleanup安全则全停、完整14项覆盖以及--only局部通过不冒充完整验收。

## 未覆盖与未验

靶场与脚本的存在本身不证明效果，本轮完整14项的实际运行与独立读回才是本机有限证据。其它ROM/分辨率、Drag其它凭据组合、Pinch百分比/步数极值、其它KeyCombo/IME键、选区删除/空字段/Unicode删除变体、横向滚动、其它DoubleTap窗口边界和后端错误状态仍未真机覆盖；不能据此移除experimental。脚本不覆盖完整序列、取消/截止时间等异常真机矩阵，这些按实际推广需求另行定义，不是本轮14项中的漏跑。

## M2固定页面与完整验收

M2页复用同一零权限APK/只读Provider：动态文案按钮、两个同名按钮及独立raw祖先id、固定色块、显式文字timer与几何运动timer、STOP按钮。Provider另报点击计数、ticks、motion及真实屏幕可见矩形/颜色。页面切换/onPause移除timer；文字自动停止20s、运动当前源码30s（第1–6轮旧APK为12s；第六轮ticks67→149且运动先于独立读回停止，证明旧窗口不足），均为有界靶场行为，不是生产idle时限。新源码已离线构建，操作员显式授权后已覆盖更新既有靶场；生产idle4.5s与全部断言/gate不变。后续更新设备仍须操作员授权。

```powershell
node scripts/verify-android-m2.cjs --probe --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
node scripts/verify-android-m2.cjs --suite --serial EXPLICIT_SERIAL --sdk F:/AndroidSdk
node --test scripts/android-m15-fixture/verify-m2-cli.test.cjs
```

M2要求显式serial，默认probe不加载Service；完整14项包括动态contains/regex-class-role、within/nth/重复拒绝、sequence、元素图id/index/afterObserve/变化拒签、静态/文字变化/运动超时/无RPC CLI idle。图片由Provider几何独立对照并解码像素；native void只是hint，布局确认不可省。单case不自动重放，未知传输/安全/会话/未排干全停，前台切离仍只在真实drain后清传输。11条CLI离线测试通过；当前真机轮次与修复分类见[M2验收记录](../../docs/android-controller/android-m2-device-validation.md)，不可从脚本存在或回执dispatched推导通过。

