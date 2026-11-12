# M4-F3：因果隔离判据（替代“物理屏冻结”）

冻结于 2026-11-06，F3 首次真机运行之前。F1/F2 的结论和分母保持不变。F3 只替换隔离判据，候选 jar、靶场、A3/A4 步骤与 F2/F2W 相同。启用方式：`f2.cjs --criterion causal`，协议身份为 `M4-F3`；加 `--a3-windows` 时为 `M4-F3W`。

## 为什么改

F1/F2 要求物理屏的焦点窗口在测试期间完全不变。R1 第 6 轮和 R2 第 16 轮都因为用户在物理屏上回桌面、打开 B 站而中止。这两次都发生在定向输入之前，logcat 也证明是人工操作。旧判据测的是“用户有没有动手机”，不是“虚拟屏有没有动物理屏”。

## 违规（任一出现即失败）

每次采样都检查以下状态：

| 代码 | 条件 |
| --- | --- |
| `PHYSICAL_IDENTITY_CHANGED` / `PHYSICAL_DISPLAY_LOST` | 默认屏 uniqueId 或尺寸变化，或默认屏消失 |
| `TARGET_TOOK_TOP_FOCUS` | `mTopFocusedDisplayId` 等于目标虚拟屏 |
| `FIXTURE_ON_PHYSICAL` | 物理屏焦点窗口属于靶场包 |
| `PHYSICAL_FOCUS_NULL` | 物理屏焦点为 null。用户切换 App 时可能出现瞬时 null，所以间隔 500ms 重采最多 4 次，仍为 null 才失败；P0 的抢焦点表现就是持续 null |

另外，从本轮建屏前记录的设备时间起，读取 events 缓冲区中的 WM 事件：

| 代码 | 事件 |
| --- | --- |
| `FIXTURE_TASK_LEFT_TARGET` | `wm_task_moved` 把靶场任务挪到目标屏以外 |
| `FOREIGN_TASK_ON_TARGET` | 非靶场任务被挪进目标屏（同 App 跨屏迁移的信号） |
| `TARGET_TOOK_TOP_FOCUS` | `wm_focused_root_task` 的 display 为目标屏 |
| `FIXTURE_TOOK_PHYSICAL_FOCUS` | `wm_focused_root_task` 在其他屏上聚焦了靶场任务 |
| `FIXTURE_BECAME_TOP_RESUMED` | `wm_set_resumed_activity`（全局 top-resumed）是靶场组件 |

覆盖性：`ready` 采样时，日志窗口中必须至少有一条“靶场任务移入目标屏”的 `wm_task_moved`，否则 `CAUSAL_LOGCAT_WINDOW_UNPROVEN`。这能防止日志格式或时间窗口不对时，“没有违规”被误当成通过（fail closed）。

## 允许（只记录）

- 物理屏焦点变成其他非靶场窗口，记入 `external[]`。
- 其他屏的 `wm_focused_root_task` 与非靶场的 `wm_set_resumed_activity`，记入 `externalEvents[]`。
- 物理屏锁屏或熄屏：只在开始时记录 `physicalAtStart`，不再要求 Awake/解锁。虚拟屏带 `FLAG_ALWAYS_UNLOCKED`。
- 每轮开始时只锁定物理屏的 uniqueId 和尺寸，不锁定焦点窗口。

## 不变

目标屏身份与三个 flag、会话无错误、靶场的 session/task/display/计数证据、A3 不得改变靶场状态、A4 只发一次 DOWN/UP 且不重发、每轮清理（服务、forward、jar、目标屏消失）、20 轮首败即停、冻结文件哈希每轮复核。

## 补充（2026-11-06 19:12，F3W 20 轮之前冻结）

F3W-q2 证明 UiAutomation 只能被一个进程占用：常驻 u2 server 运行期间，shell `uiautomator dump` 会以 exit 0 返回空输出。因此 `--a3-carrier` 模式下**不再执行 CLI dump**，`A3` 记为 `NOT_RUN_CARRIER_EXCLUSIVE`。A3 改由 carrier 判定：点击前、4 次热采样、点击后都必须是 ATTRIBUTED（`A3_CARRIER = PASSED`），否则该轮失败（`A3_CARRIER_<分类>`）。carrier 每轮在建屏之后启动，并在清理时先于虚拟屏释放；释放后不得残留 u2/owner 进程。

## 补充 2（2026-11-06 19:24，F3W-m20 资格失败后、R2 之前冻结）

F3W-m20 资格验证失败：carrier 启动后第一次 dump（13ms）返回空的 `<hierarchy rotation="0" />`，被分类为 DUMP_FAILED。随后的 4 次热采样和点击后的 dump 都是 ATTRIBUTED/185。原因是 u2 server 刚启动时窗口树还没就绪，这与 display 归属无关。修订如下：carrier 启动后，在 5 秒内反复 dump，直到树中至少出现一个 `<node>`，才进入正式 A3 采样；超时记为 `A3_CARRIER_NEVER_READY`。就绪等待期间不派发任何输入。没有节点的树单独分类为 `EMPTY`。归属判定规则不变。原 m20 的 0/0/20 分母保留，R2 使用新的输出目录。

## 已知限制

- 事件字段顺序是在 PJZ110/Android 17 的 events 缓冲区上观察到的，其他 ROM 需要重新确认。覆盖性检查会在格式不符时失败，而不是误判通过。
- events 缓冲区容量有限，单轮约 15 秒内被冲掉的概率很低；一旦被冲掉，会由覆盖性检查发现。
- 用户在物理屏上的操作与本轮动作几乎同时发生时，可能触发重采；持续 null 仍判失败，宁可误报。
