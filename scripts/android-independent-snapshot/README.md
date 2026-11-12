# Android 独立验证采样器

此工具只用于 M5 验收，生产控制器不加载它。通过系统 UiAutomationShellWrapper 获取活动根节点，完整遍历后输出 XML，不调用输入 API、不等待全局 idle、不启动持久服务。

根节点最多等待 2 秒；仅在遍历遇到缺失子节点时丢弃未完成 XML并从根重采，最多 3 次/3 秒；10 秒 watchdog 终止进程。树超限、连接失败和断开失败都拒绝输出成功。完整遍历不是原子快照，也不保证页面静止。

reader.cjs 为每批创建随机进程名和临时 JAR 路径，上传后核验 SHA-256；进程启动前后检查同名进程，删除后再次核验文件不存在。未知退出不重采、不杀其他进程。查询值和原始 XML只在内存中用于独立 DOM 判定，不写入日志。

本地构建（仓库根目录，输出目录须不存在）：

```powershell
node scripts/android-independent-snapshot/build.cjs F:/AndroidSdk artifacts/android-independent-snapshot-build
```

在 Legado 验收驱动中显式传入 --snapshot-jar 即可使用。默认路径仍为系统 CLI。最新单设备固定批次独立匹配 20/20、联合通过 19/20；任务侧一次 UI_CONTEXT_CHANGED 未通过，不能宣称整体准入。构建、失败历史、完整命令及证据见[报告](../../docs/android-controller/2026-11-06_m5-independent-verification-report.md)。

当前依赖设备系统 uiautomator.jar 内的 wrapper，只验证 PJZ110；跨 ROM 兼容性和长时间运行未验证。与生产方案共享 Android accessibility 数据源，不是像素真值。
