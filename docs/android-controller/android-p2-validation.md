# AndroidController P2 验证记录

日期：2026-11-02（Asia/Shanghai）。范围：单设备、显式单次文本仲裁、一个正式只读 API；无自主规划、写 API、图像/Box 或自动 GUI 回退。

## 交付边界

- 生产继续复用主进程 GlobalJevService，经 DistributedServer 注入 direct 插件，不新增 Jev 客户端/凭据配置层。
- Arbitrate 仅返回 advisory、合法候选 ID 与代码映射的 snapshot-bound index；执行仍由 P0/P1 重新采样、租约、截止和后置验证约束。
- target/page/recovery 独立请求；规则可确定时零模型请求。编辑框标签、值、坐标和图像不外发。屏幕其他标签可能包含个人信息，必须显式调用仲裁。
- 默认请求预算 2 秒，显式上限 5 秒，零重试，快照最大年龄 15 秒。预算同时有定时器和单调时钟完成时复核，防止同步工作阻塞定时器后误收迟到结果。
- GitHub 公开 issue/PR 查询只读、匿名、固定 HTTPS 主机与路径，拒绝任意 URL/凭据/未知参数，禁止重定向，响应最多 256KiB。正文在正式响应中被接收但不返回，不额外查询评论。
- PR closed 不证明 merged；API 回执保留 merged=null。权限、限流、超时和未知结果不暗中转 GUI。

## 契约先行与修复证据

最初两个新模块尚不存在时，新模块测试 0 通过/2 文件失败，原文为 MODULE_NOT_FOUND；接线测试 0/6，通过前暴露 Unsupported command: Arbitrate 及缺失全局注入。

随后每个扩充边界均先复现失败：

- 编辑框 label 外发、设备租约/整步取消未覆盖仲裁。
- 显式 B 设备错误依赖默认 A 设备，导致合法快照误判失效。
- 计数将禁用全局服务视作模型请求。
- 畸形 pull_request 被 truthiness 接受；body.cancel 失败覆盖已知 denied。
- 同步工作阻塞事件循环时，单靠 timer 会接受超预算成功。

一条测试 fixture 的 PR 链接最初写为 /issues/，与其 PR 身份及官方 /pull/ 契约矛盾；只修正 fixture 链接，没有降低回执验证条件。

最后回归命令和最终通过数见本报告末节。独立子代理仅做只读场景审阅和代码 review，没有并行修改生产文件。

## 真机与正式 API

设备：PJZ110，ADB 已授权；目标：用户指定上游 lioensky/VCPChat，选取最近公开条目 PR #295。

API 回执：

- endpoint：https://api.github.com/repos/lioensky/VCPChat/issues/295
- htmlUrl：https://github.com/lioensky/VCPChat/pull/295
- kind=pr，state=closed，merged=null
- updatedAt=2026-11-02T03:43:00Z
- 标题：docs(srpg): add upstream attribution README and original documentatio…
- HTTP 200，身份与 schema 校验通过；一次真实请求约 812ms。

GUI 独立读到仓库、#295、同一标题和“已合并”；后者映射到 API closed 进行状态对照。API 没有因此凭空增加 merged=true。未点击仲裁候选，未发送/评论/改状态，没有业务写入。

### 已就绪页面：5 次重复查询

起点是手机已打开正确 PR 页面，P2_CURRENT_PAGE=1。API 每次重新 GET，无缓存；GUI 每次重新 Observe。费用列仅指这些任务的模型费用，不代表全部诊断请求免费。

- API：5/5 verified，p50=374ms，p95=646ms，模型调用总数=0，模型费用=0，业务写入=0。
- GUI：5/5 verified，p50=2593ms，p95=2875ms，模型调用总数=0，模型费用=0，业务写入=0。
- 规则＋Jev 入口：5/5 识别 target，p50=2680ms，p95=2945ms，全部规则直达，模型调用总数=0，业务写入=0。

统计使用 nearest-rank；n=5 时 p95 即该组最大值。规则入口共享对应 GUI 采样而非独立导航运行，输出 independentNavigationRun=false。它验证同任务的读取路径与规则短路，但不是大型模型基线，也不能外推跨应用成功率或泛化提速倍数。

### 冷导航：保留失败，不混入成功样本

测试脚本用固定 GitHub VIEW intent 导航同一公开 URL，生产 LaunchApp 没有增加通用 deep-link/shell 能力。一次在 15 秒预算内最多 5 次 UI 采样，约 12.4 秒仍未读到业务证据，GUI=unknown；之后再观察时页面已可读。曾发生锁屏，规则返回 human/KEYGUARD，没有自动解锁或误称空页面成功。

冷导航失败是应用/网络准备时间的不稳定证据，未据此调整采集架构，更未把热页样本冒充冷启动性能。

## 真实 Jev

用户在全局设置启用服务后，脚本复用 GlobalJevService 实现读取配置，不读取会话中的凭据、不改配置、不输出 Key。脚本不是正在运行的 Electron 单例集成验收；生产单例注入由接线契约回归覆盖。

- 真实提供商诊断返回合法 choice probabilities，曾约 2136ms / 3349ms；因此生产 2 秒预算可能失败。这类超时都返回升级、candidateId=null，不重试、不执行。
- 基于实测，保留 2 秒默认，只开放显式 5 秒上限。选用 4 秒预算后，真实 target 仲裁约 2332ms，c1 概率 1，代码映射为当前 snapshot 的 index=1（返回按钮），未执行。
- 该请求 usage：input_tokens=462、output_tokens=41；没有费用字段，因此金额未知，不按 token 数猜价格。超时请求可能仍计费，不能按缺失 usage 算免费。
- 同一 PR 页面规则可确定时，完全绕过 Jev；另一次提供商诊断约 896ms 不计入三路线任务耗时。

当前概率门槛仍为保守暂定值 0.85 / 领先 0.20，policy.calibrated=false。一条正例不足以估计精确率、误选率或置信度校准，保持显式 opt-in，不能据此开启无人确认写操作。

## 重现

仓库根目录：

```bash
node scripts/check-android-p2.cjs lioensky VCPChat 295 DEVICE_SERIAL
P2_CURRENT_PAGE=1 node scripts/compare-android-p2.cjs DEVICE_SERIAL 295
P2_CURRENT_PAGE=1 P2_DIAGNOSE_JEV=1 node scripts/compare-android-p2.cjs DEVICE_SERIAL 295
```

后一命令额外调用真实 Jev，可能产生费用。提供商诊断有 10 秒超时但无执行权限；生产仲裁仍遵守声明的短预算和快照有效期。

## 最终回归

最终执行：442 项通过、0 失败、0 取消、0 跳过，总耗时约 11.46 秒。另对 main、DistributedServer、AndroidController 和 P2 模块运行 node --check。已有 jevToolUse.js 的 MODULE_TYPELESS_PACKAGE_JSON 警告仍在，与本次 P2 逻辑无关，未为消警改全仓模块制式。不引用 P0/P1 的历史通过数作为本轮结果。

```bash
node --test tests/android-*.test.js tests/adb-*.test.js tests/frame-hub-contract.test.js tests/scrcpy-*.test.js tests/stream-recovery.test.js tests/subscriber-init.test.js tests/ui-graph.test.js tests/vision*.test.js tests/launch-app.test.js tests/focus-parse.test.js tests/auto-connect*.test.js tests/device-reconnect.test.js tests/*jev*.test.js tests/distributed-*.test.js
```

## 未覆盖

大样本阈值校准、独立冷启动三路线随机对照、真实费用对账、跨应用/跨 ROM 基线、正在运行的 Electron 单例重启验收。未扩展 P3 多步骤任务，也未增加图片、Box、RawShell、root 或支付/删除/发送能力。
