# 安卓显示屏画质与窗口贴合

安卓显示屏已接入帧率上限、目标码率、画面最长边设置，并修复隐藏设置面板导致的网格错位。窗口按真实画面比例收紧，保留完整画面。验收数量与阶段状态以[状态表](README.md)为准；本轮使用替身设备和编码器，未操作真机，也没有请求上游模型。

## 使用方式

重启 VCPChat，从「安卓」入口打开窗口。点击「画质」，读取当前设置，修改后点击「应用」。普通浏览器打开同一查看器也可以设置画质；「贴合窗口」仅在独立 Electron 窗口提供。

| 控件 | 作用 | 边界 |
| --- | --- | --- |
| 帧率上限 | 设置 H.264 编码帧率上限 | 实际帧率受设备与画面变化影响 |
| 目标码率 | 设置 H.264 目标比特率 | 不是实际带宽测量 |
| 画面最长边 | 限制编码画面尺寸 | 不修改手机系统分辨率 |
| 贴合窗口 | 按画面宽高比调整原生窗口 | 首帧及比例变化自动执行；最大化/全屏不调整 |
| 适合宽度 | 填满可用宽度，超高内容可滚动 | 默认完整等比显示 |

设置仅保留到本次服务结束。有 H.264 订阅时通过既有切换屏障停止旧流、应用参数、等握手和首帧后恢复订阅；多个设置请求串行。无订阅时只保存，显式 JPEG 订阅保持不变。设备切换或停止会取消旧配置事务，不能把排队写入重放到新设备。

反馈区区分 `active-stream`（新流就绪并恢复订阅）、`next-start`（已保存，等待下次 H.264 启动）和 `fallback`（保存成功但重启失败，使用兼容画面）。失败保留原始错误，前端不重发配置；既有视频恢复机制可继续尝试启动。所有参数先整体校验，HTTP 沿用同源 Origin 和 HttpOnly Cookie。

## 实现与证据

沿用现有 StreamServer 生命周期和独立窗口所有者，没有新增设备控制器。窄窗口的工具栏文字保持单行，设置面板隐藏时保留其明确网格行；比例计算包含原生边框与工具栏换行。有限次数重新测量后结束，不持续覆盖用户手动缩放。

| Evidence | Finding | Path |
| --- | --- | --- |
| [专项测试日志](../../artifacts/android-display-quality/tests.log) | 参数原子校验、FIFO、设备切换/停止取消、错误反馈与权限边界通过 | viewer → `/api/scrcpy/config` → `configureScrcpy` → `changeDevice` → hub |
| [Electron 结果](../../artifacts/android-display-quality/electron-result.json) | 真实 Cookie/HTTP/WS、配置写入和失败回退、横竖屏比例、手动缩放及关窗保活通过 | 独立 profile → StreamServer → PNG 解码；preload → 受限 IPC → BrowserWindow |
| [竖屏截图](../../artifacts/android-display-quality/viewer-stream.png)、[横屏截图](../../artifacts/android-display-quality/viewer-landscape.png) | 默认画面与可用区域比例一致，底栏不挤占画面行 | viewer 明确网格行 → 按内容尺寸贴合 |
| [深色设置](../../artifacts/android-display-quality/viewer-quality-dark.png)、[浅色失败提示](../../artifacts/android-display-quality/viewer-quality-light.png) | 设置、保存结果和失败原因可见，窄窗按钮不拆字 | 同源配置读取 → 显式应用 → 结果展示 |

修改前的窗口测试设施未提供新 IPC/screen 依赖，已补齐并验证拒绝外部 frame、无效几何、状态页以及最大化/全屏请求。Electron 验收发现布局尚未稳定就继续操作会使测量不可靠；测试现等待贴合完成，实现也会在设置面板可见性变化时终止后续尺寸修正。

## 复现

在仓库根目录、已安装项目依赖的环境运行。Electron 脚本使用临时 profile 和独立回环服务，输出到 `artifacts/android-display-quality`；不初始化 AndroidController 或 ADB。

```powershell
node --test tests/android-display-window.test.js tests/android-viewer-presentation.test.js tests/android-stream-config.test.js tests/android-display-launch.test.js tests/android-display-catalog.test.js tests/android-display-security.test.js tests/android-display-start-review.test.js tests/android-stream-lifecycle.test.js tests/android-stream-lifecycle-review.test.js tests/scrcpy-lifecycle.test.js tests/scrcpy-readiness.test.js tests/scrcpy-parser.test.js
node -e "const {spawnSync}=require('node:child_process'); const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; const result=spawnSync(require('electron'), ['scripts/test-android-display-electron.cjs'], {env,stdio:'inherit',timeout:60000}); if(result.error) console.error(result.error); process.exit(result.status ?? 1);"
```

实际 H.264 编码帧率、码率、清晰度、真实设备旋转和完整安装包仍需对应环境验收。本轮不变更 M5、设备租约或人工触控能力的阶段结论。
