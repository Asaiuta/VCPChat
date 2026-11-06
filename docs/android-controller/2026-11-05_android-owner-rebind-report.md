# 无线断线后的 owner 重绑修复

当前实现已修复失效转发复用和 owner 无限存活两个生命周期缺口。阶段状态与回归分母见 [状态表](README.md)，原始结果见 [真机记录](../../artifacts/android-owner-rebind-2026-11-05/device-result.json)。本轮设备为 PJZ110 / Android 17；没有执行手机输入动作。

## 证据、结论与调用路径

| 证据 | 结论 | 修复路径 |
| --- | --- | --- |
| [历史旋转诊断](2026-11-05-rotation-acceptance.md)：孤儿进程占用 UiAutomation，CLI exit 137；修复前 Owner.java 认证成功后无退出期限 | 宿主失联后远端可能无限存活。历史故障并未留下足以重建全部断线时序的数据 | `Owner` 在同一 JVM 中启动独立 watchdog；认证 INFO 且 RPC socket inode 归属成立才续约；30 秒无续约自退出 |
| [本地专项](../../artifacts/android-owner-rebind-2026-11-05/focused-tests.log)：转发删除、转发表保留但连接失效、端口被重新分配、续约与 stop 并发 | 缓存本地端口不能代表当前可用且归属正确的控制通道 | `_forward` 核验 serial/local/remote；失效时用 `--no-rebind tcp:0` 重建；INFO 网络失败只重建重试一次；身份不符不发 STOP |
| [真机 JSON](../../artifacts/android-owner-rebind-2026-11-05/device-result.json)：`wireless_adb_reconnect`，旧 PID 3589 消失，新 PID 3991 认证且能采树 | 实际无线 ADB 断开并显式恢复后可重绑 | 原 owner 认证 STOP → 独立 `/proc` 与 socket 表证明 → 新 owner 启动、socket inode 绑定 → RPC 采树 |
| 同上 `lease_expiry_with_live_adb`：ADB 保持存活；停止认证续约后 30.861 秒、exit 71；8 次错误 nonce 均 DENIED | 验证了设备 watchdog，且错误凭据不能延长租约 | 主机每 5 秒认证续约；设备以包含休眠时间的 `SystemClock.elapsedRealtime()` 计算期限；watchdog 每秒检查 |
| 同上 `host_death_owner_disappeared`、`cli_after_host_death`、`fresh_host_rebind_after_host_death`：远端 1.656 秒内消失，CLI exit 0，重新绑定可采树 | 本机主机终止路径也可恢复 UiAutomation；该快速退出不能单独当作租约证据 | 父进程仅终止测试启动的 Node 子进程；独立证明远端消失后测试 CLI 与新 owner |

本地心跳故障或 adb 子进程退出会撤销 ready 并停止续约。stop/recover 会等待在途续约完成，再执行认证停止和独立消失检查；迟到的回调不能复活旧代。控制转发和 RPC 转发删除前均核验当前归属。

未知写入仍进入原隔离路径；续约失效、自退出、ping 或重连都不会直接清除 Service 的未知写入状态。`Manage operation=recoverOwner` 仍需要当前可信记录与独立消失证明，撤销旧 snapshot/frame/context，不重放动作。没有新增远端数字 PID kill、全局进程清理或 force 解锁。

## 复现

在项目根目录执行。设备需已授权、在线且没有其它 owner；脚本会拒绝已存在 owner 的环境。无线验收应使用 `adb mdns services` 当前发布的 IP:port。

```powershell
node scripts/android-owner/build.cjs --sdk F:/AndroidSdk
node --test tests/android-owner-bootstrap.test.js tests/android-ui-server-restart.test.js tests/android-ui-server.test.js tests/android-carrier-identity.test.js tests/android-rpc-drain-evidence.test.js tests/android-transport-seam.test.js
$testFiles = @(rg --files tests -g 'android-*.test.js' -g 'android-*.test.mjs')
node --test --test-concurrency=4 @testFiles
node scripts/verify-android-owner-rebind.cjs --serial 192.168.137.193:38247 --adb D:/AI/tools/platform-tools/adb.exe --out artifacts/android-owner-rebind-recheck --wireless-reconnect
```

随包 JAR SHA-256：`b91b95fe1cde24c202422cbe68d6cb7354f7dca35f41b1ed98d375226c87768c`。文件、退出码和证据摘要见 [清单](../../artifacts/android-owner-rebind-2026-11-05/evidence.json)。改动前源码和文档保存在该目录的 `before/`，包括本地排除版本控制的文档。

## 范围与限制

- 第一轮 mDNS serial 执行 `adb reconnect` 后没有自动恢复，记录保留于 [attempt1-mdns](../../artifacts/android-owner-rebind-2026-11-05/attempt1-mdns/device-result.json)。显式连接发布地址后继续测试；这是 ADB 连接发现/别名问题，本修复没有建立 mDNS/IP/USB 统一物理身份。
- 第二轮仅有主机终止证据，随后补充“ADB 存活但续约停止”的租约测试；[attempt2-host-death](../../artifacts/android-owner-rebind-2026-11-05/attempt2-host-death/device-result.json) 保留先前通过记录。最终 JSON 为完整专项结果。
- 只覆盖一台设备、短时 ADB 链路断开与确定性失联注入；没有关闭手机 Wi-Fi、制造长时间无线射频丢包、验收休眠场景或跨 ROM 长稳表现。
- 新租约适用于本次构建的新 owner；更新不能给既有旧版孤儿进程补装 watchdog，也不会猜测身份清理旧进程。本轮开始前确认设备没有此类残留。
- 失联后的退出有租约等待窗口，受 Android 调度影响；它不是“断线瞬间退出”。恢复仍以独立消失证明为准。ADB 转发检查和删除不是原子操作，无法对抗外部客户端在两次命令间刻意抢占同一端点。
- 横屏 M1.5 的历史剩余项、M5 真实 App 资格验证、跨 ROM、在途未知写入真机注入和 soak 仍需各自验收。
