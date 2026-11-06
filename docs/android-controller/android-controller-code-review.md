# AndroidController 代码质量审查与有界重构

日期：2026-11-03。以工作区现有未提交实现为基线；未回退历史改动、未增加旧入口转译、未调用真实设备。审查重点为四入口生产调用链、UI 证据、RPC 生命周期和确定的重复开销，而不是按文件数量拆架构。

## 判断

已有设备租约、总预算、未知写不重放、受限选择器、脱敏回执应保留。主要问题不是缺少抽象层，而是同一事实由不同模块重复解释：可见性规则冲突、已有节点来源被字段反查替代、动作验证宽泛归一化、采样与当前前台混拼，以及资源启动/清理的所有权不明确。

[主服务](../../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js)仍承担过多连接/显示/观察/执行职责；本轮只把条件轮询剥离成一个可独立验证的模块，不引入依赖注入容器、兼容注册器或第二套动作协议。

## 已修复的生产问题

### P1：布局稳定证据漏掉隐藏父节点下的可见子节点

[布局证据](../../VCPDistributedServer/Plugin/AndroidController/lib/layout-evidence.js)原本递归继承 hidden，与现有 UI 图的逐节点可见性契约冲突。两个采样中可见子节点的 bounds 改变，原 digest 却相同，真实 idle 等待器会返回 layout_stable。

修复为只剔除节点自身显式隐藏，继续遍历后代，保留滚动祖先的几何裁剪。新增持续交替几何采样证明不能被签为稳定；隐藏节点自身仍不成为可见元素证据。[生产元素图/布局回归](../../tests/android-element-provenance.test.js)。这不证明真机历史动态几何余项已经关闭，也不消除周期动画在离散采样点恰好重合的局限。

### P1：Fill 把不等值或非法类型洗成验证成功

原读回将任意值转字符串并 trim：null 等同空串、数字17等同字符串17、首尾空白丢失也能 verified。现在仅接受字符串逐字一致，非法类型立即停止读回验证。唯一额外例外是清空操作的单个换行，来自既有随包载体证据；不再扩大到任意空白、CRLF或非清空文本。

保留旧值短暂读回时的有界只读轮询，不重发 setText/clearTextField，不让额外 expect 覆盖失败。新增六个反例及三个精确空白正例；原清空换行测试仍通过。[验证回归](../../tests/android-execution-evidence.test.js)、[既有 Fill 契约](../../tests/android-fill-contract.test.js)。

### P1：本地 forward 被争抢后可能接管其它设备路由

探测本地端口与创建 adb forward 之间不是原子操作。原 forward 允许 rebind，创建失败时还会无条件删除候选端口。

[UI 服务](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-server.js)改用 forward --no-rebind，并且只清理本代成功取得的 forward。不添加盲目重试。离线调度测试模拟探测后被另一 owner 抢占，分别证明不接管、不删除对方资源。[重启/所有权测试](../../tests/android-ui-server-restart.test.js)。此项是对 adb 参数语义的隔离测试，不是真实设备争抢实验；外部进程主动更改现有转发不在隔离保证内。

### P2：UI 服务异常退出重启遗留旧 forward

原 exit/error 仅清 ready，新 start 覆盖旧 port，最终 stop 只清新端口。现在先摘除旧 transport/port、清旧 forward，再检查 generation 后创建新资源。覆盖 exit、error、清理期间 stop 三条生命周期路径；只清本地 transport，不声称已经确认远端 owner 终止。[重启/所有权测试](../../tests/android-ui-server-restart.test.js)。

### P2：取消后的普通 Observe 仍继续采集或 CLI 回退

start 等待期间调用可以已经取消，但 start 返回后原链路仍派发 dump，或在未就绪时继续 CLI。现在 start/dump 返回及异常路径均检查 step 状态，普通 dump 接入可信取消信号。[取消测试](../../tests/android-observe-cancellation.test.js)覆盖取消/总截止 × 启动成功/失败，均检查本地排干后没有追加请求。

启动期 push/exec 自身仍不支持 Step 取消，租约继续保留到依赖排干；不能把此局部修复描述成整个启动流程已可取消。

### P2：旧 UI 树被贴上新的前台信息

原 afterObserve 复用验证树时重新读取 currentFocus 并覆盖 sample.focus，使不同时间点的事实混拼。现在复用整份采样和原时间；普通 UI 条件样本只声明树的来源包、不伪造 component/window；idle 样本保留其实际采集上下文。同时省去复用路径的一次前台查询，不多做一次 dump。

[验证回归](../../tests/android-execution-evidence.test.js)另外保护 idle+foreground 额外条件的采样复用，防止抽离验证器导致第三次 dump。

### P2：元素图丢失已有原始节点来源

合法 wrapper 折叠可以把外层 id/text 补给内层 Button；原元素证据再按公开 id/bounds/class 反查 XML，与属性继承不一致，可能零命中或重复命中。现在使用控件已有的 rawNode 严格引用，并在当前原始树中确认归属；仍检查原始可见性、bounds/package/class/enabled，并在身份中保留原始 id 与公开继承 id。RPC 写动作的原始唯一身份限制没有放宽。[元素来源测试](../../tests/android-element-provenance.test.js)。

## 结构与性能收敛

- [条件等待器](../../VCPDistributedServer/Plugin/AndroidController/lib/expectation-wait.js)只负责一次条件验证，选择器在轮询前编译一次，复用已有 step 的租约/取消/截止时间。动作编排继续决定何时验证、是否附观察，不再内联整段轮询实现。
- 手势与滚动工厂只在模块装配时构造一次，移除每次动作的重复闭包和转发包装；不缓存每次动作的可变 attempts 或目标。
- afterObserve 复用路径减少一次前台查询；不把离线请求数下降写成设备时延提升百分比。
- [标签适配器](../../VCPDistributedServer/Plugin/AndroidController/lib/argent-uiautomator.js)将已算出的完整聚合文本以非枚举 Symbol 元数据传至[图层](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph.js)，删除图层第二次后代扫描及无用 raw→copy 索引。40层/limit=1样本的额外扫描从40次调用、860个节点访问变为0/0；不改变聚合顺序/脱敏/独立点击后代规则，公开标签仍为120字呈现。同时修复 wrapper 继承长尾和字面省略号标签时匹配文本丢失。[标签管线回归](../../tests/android-label-pipeline.test.js)。

## 第二轮：设备调度与可消费的选择器契约

### ADB：有界按设备FIFO，不再跨设备队首阻塞

[传输封装](../../VCPDistributedServer/Plugin/AndroidController/lib/adb.js)保留参数数组执行、上下文/预算与统计API，将调度移至[独立队列](../../VCPDistributedServer/Plugin/AndroidController/lib/adb-queue.js)，两者共享[错误类型](../../VCPDistributedServer/Plugin/AndroidController/lib/adb-error.js)以避免循环依赖。既有SerialQueue导出为同一实现的引用，默认push保持全局串行，没有包装层。

- 明确serial的命令按trim后实际传输serial串行，不同serial可并行；没有serial的设备命令保守视为全局屏障。
- 一个全局pending数组与activeKeys集合，默认总容量仍64，包含运行中/排队中任务。完成就删除key，没有永久保存闲置设备队列的Map。
- noSelector管理/未知命令是FIFO独占屏障：等此前所有工作排干，阻挡后到设备命令与host read，不能被后到请求饿死。
- 精确白名单devices/devices -l/version/mdns services/mdns check共用host-read key，与设备并行但不越全局屏障；否则B的Service准备阶段仍会因发现请求卡在A后面。
- 排队取消/过期立即删除占位并调度；在途取消等实际transport settle才释放key。统计形状和双维度取消/超时计数不变，修正原注释与实际计数不一致。
- 提交即复制argv，分类和执行共用副本。先红复现了外部把已排队devices数组改为kill-server绕过屏障的TOCTOU，修复后纳入永久回归。

新增[18条调度回归](../../tests/adb-device-scheduling.test.js)，含Service Observe+真实AdbClient/队列+伪transport集成：A采集被gate阻塞时B能完成发现、准备、采集；同设备后续仍串行。独立只读审查另验证屏障公平性和sync/async falsy失败。既有预算测试VM改用被测文件位置解析新增依赖，execFile桩/全部原断言不变；属测试设施适配，不是改期望追绿。

保证限同一AdbClient的入队调用；独立client、外部adb进程及直接runRaw不在隔离范围。子进程settle仍不证明远端操作结束，RPC未知隔离仍是P1。

### UI图：每个非空生成selector必须原样定位回自己

[图层](../../VCPDistributedServer/Plugin/AndroidController/lib/ui-graph.js)生成后复用真实parseSelector，确认解析id/text与原条件严格相同；超预算/不可原样表达的身份输出selector:null，行内提示“仅限本次快照 index+snapshotId”。不增加4096预算，不偷偷把超长ID换成text/class/nth。

预算沿现契约：移除ordinal、%25/%23单次解码后的UTF-16条件长度。文本ordinal按全部同文本匹配控件计数，含首选id selector的控件；修复带ID/无ID混排把text#N指向另一行的问题。展示limit不改全图ordinal/index，禁用证据节点不混入动作匹配全集。

新增[16条生成契约回归](../../tests/android-generated-selector.test.js)，覆盖4096/4097、emoji、转义、重复/空文本、超长ID、截断/禁用与Service零写边界。null selector/缺snapshot index均拒绝，新鲜index+snapshot成功且回执仍selector:null；解析器与RPC写目标唯一性约束未放宽。

## 尚未闭环，按风险排序

1. **P1：统一 RPC 传输未知后的设备隔离与远端生命周期。** 现有 M2 bounded read 有隔离；普通 dump 的泛 catch/CLI fallback 与既有 write RPC 的后续请求策略仍不统一。杀宿主 socket/adb 不证明远端请求结束，reconnect 不能作为恢复证明。应围绕精确远端 owner、载体哈希/协议握手与 generation 重构，而不是加重试。[既有对标证据](android-pre-m3-gap-review.md)。
2. **P1：frame 的显示/前台上下文与稳定证据。** 旧 frame 主要证明 token/年龄/尺寸，不证明同一前台/旋转；旧 Observe stable 对公开控件和签名采样，不能等同完整 raw layout idle。应建立共享证据采样边界，不再增加第三套局部稳定判断。[既有对标证据](android-pre-m3-gap-review.md)。
3. **P2：嵌套聚合标签的算法最坏情况。** 图层的第二遍扫描已消除；适配器内部仍会按嵌套可点节点聚合子树，未在本轮降阶。彻底优化需要保持文档序去重、密码脱敏和独立点击后代规则的可组合后序算法，不能只给每个raw节点包一层memo就宣称线性。
4. **诊断脚本限制：** 旧[live脚本](../../scripts/live-android-verify.cjs#L166-L171)按selector相等查找重绑，不能用null===null证明身份相同。第二轮未改/未运行它，不把其结果作为selector契约验收；本轮使用Service隔离测试及生成selector原样消费性质验证。

## 验证边界

首轮新增37条隔离回归，缺陷测试先复现失败，再修生产实现；没有修改既有测试期望追绿。验证器抽离曾暴露idle+foreground丢失样本的回归，新增针对性测试后修复，不接受额外dump掩盖。

首轮完整离线回归：**1462/1462通过，14.564s**，见[首轮日志](../../android-refactor-regression.log)。

第二轮新增34条（调度18+生成选择器16），最终完整离线回归：**1496 tests / 1496 pass / 0 fail / 0 cancelled / 0 skipped，14.947s**。包含既定Android/ADB/显示流/视觉/连接/分布式链和两套CLI安全测试，见[第二轮日志](../../android-architecture-regression.log)。本轮生产/测试文件语法及限定差分空白检查通过。静态依赖审查有动态绑定不可判定余项，不冒充完整调用链证明。

执行完整离线回归命令：

```powershell
node --test tests/android-*.test.js tests/android-*.test.mjs tests/adb-*.test.js tests/frame-hub-contract.test.js tests/scrcpy-*.test.js tests/stream-recovery.test.js tests/subscriber-init.test.js tests/ui-graph.test.js tests/vision*.test.js tests/launch-app.test.js tests/focus-parse.test.js tests/auto-connect*.test.js tests/device-reconnect.test.js tests/*jev*.test.js tests/distributed-*.test.js scripts/android-m15-fixture/verify-cli.test.cjs scripts/android-m15-fixture/verify-m2-cli.test.cjs
```

另对本轮生产/测试文件执行 node --check 与限定 git diff --check。离线回归不替代本轮未执行的真机矩阵、多 ROM、无线长稳和性能基线。
