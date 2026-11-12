# M4.5 P0 独立探针

本工具只做研究验证，不接入 AndroidController 的生产 Manage/Observe/RunTask。P0 未通过前不放开单显示器保护，也不把设备租约改成按 display 加锁。

## 冻结范围（2026-11-06，P0-r1）

先采集 A1 原始 `display` / `window displays` / SurfaceFlinger 信息，再验证 A2 overlay 路线。独立包 `com.vcpchat.m4fixture` 提供按钮计数和输入事件 displayId，作为动作落点证据。scrcpy 5.0.1 使用真正的 video/control 两 socket 握手，video 复用仓库 StreamParser；帧必须由本地 FFmpeg 解码为 PNG，再检查非黑像素。仅收到 socket 数据不算可见画面。

每次运行使用新输出目录、随机 scid、独立设备端 jar 文件和动态转发端口。显示身份保存 logical ID、设备 uniqueId、SF ID（只接受确切映射；没有映射则 null）及本轮 generation。SF 的 64 位 ID 保存为字符串，禁止用逻辑 displayId 猜测 screencap 参数。运行产物保存命令、输入文件哈希与探针源码副本。

首次只做一轮：创建副屏 → 启动独立靶场 → 首帧 → 复核物理屏焦点/尺寸/电源 → 在全部前置成立时仅一次 `input -d` 按钮点击 → 独立靶场读回 → 清理。物理屏焦点、尺寸、电源或显示身份发生变化，立即停止新输入；不通过反复启动或重试点击寻找成功结果。设备未解锁/不亮屏、现有自动化进程、已有 overlay、原包已安装或出现额外显示时，默认拒绝本轮变更。

安装准备与实验判据分开记录：ColorOS 可能弹出系统安装引导，宿主 adb 超时不代表系统安装取消；未知安装结果会保留 `INSTALL_RESULT_UNKNOWN`，不会因瞬时包缺失而声称清理完成。预先完成系统安装后，可显式传 `--use-installed-fixture`；仅允许设备 base.apk SHA-256 与本地 APK 完全相同，且本轮结束不卸载这个预装包。默认模式仅清理自己首次安装的包。前置安装或 APK 路径解析失败保留 A2/A4 为 NOT_RUN，不能冒充虚拟屏失败。

overlay 判据失败后，不继续后台写入路线。允许单独运行 `new-display` 的只读建屏/采集/清理诊断来定位技术差异；该模式绝不发送触摸、按键、剪贴板或文本，不能据此绕过 A2 准入。开启 control socket 仅为完成协议握手，所有场景显式关闭 power_on、clipboard_autosync、stay_awake、keep_active。

A3 的承运多显示语义树、A4 的控制输入、A5 的冷/热/singleTask/IME/权限及 20 次完整生命周期矩阵均单列状态。首次失败不回填后续通过，不以空屏建删 20 次代替 A5。P0 通过才进入 P1–P5。

## 使用

从仓库根目录执行，`--output` 必须尚不存在；serial 由当前 `adb devices -l` 明确指定：

```powershell
node scripts/android-m4/probe.cjs --serial 192.168.137.193:41117 --output artifacts/android-m4-p0-baseline
node scripts/android-m4-fixture/build.cjs --sdk F:/AndroidSdk
```

变更模式另需 `--mode overlay` 或 `--mode new-display`，并明确传入 `--apk` 和 `--ffmpeg` 的本地文件路径。工具在入口检查所有文件后才执行设备变更。默认 baseline 不安装、不建屏、不输入。

本轮 PJZ110 已触发停止条件：overlay 启动 App 被系统拒绝；scrcpy 自建屏能显示靶场，但默认屏焦点变为 null。细节见[真机报告](../../docs/android-controller/2026-11-06_android-m4-p0-report.md)。后续输入、IME和循环测试不因工具已准备而自动获得准入。

## F2：A3 语义树 + A4 control 触摸（2026-11-06 冻结，真机未跑）

协议见 [f2-protocol.md](f2-protocol.md)。复用 F1 候选与靶场，靶场须先安装好。单轮或"资格 1 轮 + 20 轮矩阵"：

```powershell
node scripts/android-m4/f2.cjs --serial <serial> --use-installed-fixture --apk scripts/android-m4-fixture/.build/m4-fixture.apk --ffmpeg <ffmpeg.exe> --output artifacts/android-m4-f2-<run> [--campaign]
```

A4 只发一次 DOWN/UP，不重发；A3 只读，分类单独统计，不阻断 A4。离线测试：`tests/android-m4-f2.test.js`。

附加开关：`--a3-windows`（A3 改用 `dump --windows`）、`--a3-carrier`（同时测试常驻生产 u2 server 的多屏 dump 及其耗时）、`--criterion causal`（F3 因果判据，见 [f3-protocol.md](f3-protocol.md)；测试期间可以正常使用物理屏）。离线测试：`tests/android-m4-f3.test.js`。

原始命令、退出码、标准输出/错误、输入文件 SHA-256、原始 H.264、PNG、显示清单与清理结果保存在输出目录。工具没有跨宿主设备互斥能力；执行期间不得并行运行 M5 真机任务。退出码 0 表示本模式的检查全部通过，不表示整个 P0 或生产准入完成；失败/清理不确定为非零，未执行项保留 `NOT_RUN`。
