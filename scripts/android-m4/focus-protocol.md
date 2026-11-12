# M4-focus-F1：禁止虚拟屏抢占全局焦点

冻结于2026-11-06，首个F1真机实验之前。候选身份为scrcpy-5.0.1-focus1，基于固定上游commit a60891aea193d92e7e5c3942700eca63f9d19a5f，仅在Android14+建屏分支加VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED（1<<16），保留TRUSTED/OWN_FOCUS。候选单独构建和哈希识别，随包原server不变。

来源：AOSP的DisplayManager / Display / DisplayWindowSettings / TaskDisplayArea / WindowManagerService。OWN_FOCUS维持虚拟屏内部焦点；STEAL_TOP_FOCUS_DISABLED通过mDontMoveToTop阻止Activity启动和定向触摸把该显示置顶。框架文档指出非top显示的IME存在限制，本候选继续display_ime_policy=hide，禁止剪贴板、PASTE和IME输入。源码支持假设，真机决定是否成立。

首次资格验证一轮：原物理屏作为对照，独立M4靶场只在新屏冷启动；建屏、启动、解码、一次明确displayId的按钮点击、结束后分别采样。目标显示必须真实报告TRUSTED/OWN_FOCUS/STEAL_TOP_FOCUS_DISABLED，默认屏窗口token/焦点/尺寸/Awake保持，独立靶场同session/task/display的taps精确加一，事件计数增长，且无串屏证据。任一失败停止，不通过事后抢回焦点或重复输入修复当轮。

首轮通过后按同一候选与冻结代码执行20次完整建屏→冷启动→解码→定向点击→停止循环。每次使用新scid、generation、独立输出目录，数字displayId允许变化；记录全部通过/失败/未执行分母。任一失败停止后续派发，保留未执行项。每轮必须独立核验服务/转发/jar/显示消失及物理屏上下文恢复。此矩阵仅验焦点修复与定向点击生命周期，不冒充同App任务迁移、IME、权限、跨ROM或完整M4.5准入。

安装准备独立进行，不计入焦点实验；只复用与本地APK精确哈希一致的靶场。设备保持已解锁且无其它自动化占用，不自动唤醒物理屏。代码运行方式是probe.cjs --mode focus1，候选构建清单与远端jar哈希均须匹配。

P0-r1原有两条失败路线和结果保持：overlay无法启动App；原版scrcpy会让默认屏焦点变null。F1是明确的新候选，原失败不会被覆盖为通过。
