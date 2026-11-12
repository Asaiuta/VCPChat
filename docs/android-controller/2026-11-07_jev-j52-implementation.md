# J5.2 同任务主 Agent 与人工交还

本批接通 VCPChat 和 VCPToolBox 的实际生产调用链，验收档位与测试数字统一见 [当前状态](README.md)。冻结约束见 [J5.2 契约](2026-11-07_jev-j52-contract.md)，完整命令、退出码与代码身份见 [选择集](../../artifacts/android-jev-j52-2026-11-07/final-selection.json) 和 [结果](../../artifacts/android-jev-j52-2026-11-07/final-result.json)。

## 行为

`RunTask decision=jev` 新增可选 `assistance=main_agent|human`，默认为 `none`。合法低置信或显式 escalate 可消耗一次升级额度，正常路径零升级调用。主模型最长10秒、人工最长60秒，沿用同一任务、租约、总截止、观察与动作预算及八轮循环。没有服务、无效建议、拒绝、超时或再次升级均停止；unknown、策略失败和上下文失败不能借升级恢复。

主 Agent 只返回绑定 taskId/observationId 的候选选择、重新观察或停止。当前所有者继续执行；保留已验证步骤、已用目标、连续 stale 与循环历史。每次候选仍经过新观察比较、原写策略和写前 fence，完成仍由固定完成谓词与独立观察证明。允许的人机交还使用 M4.0 原生交互及同一失效逻辑，仅放行内部失效预期产生的 epoch 增量；包、窗口、旋转等漂移仍失败。交还后的原输入必须匹配，已经出现的结果仍受原“预存完成”防护约束，不能仅凭交还宣布人工完成业务。

viewer takeover 仍取消并排干原 Agent；跨调用恢复、viewer 交还后自动续跑、任意 App 规划和扩大敏感写权限均不在本批能力内。

## 上游归属与取消

VCPToolBox 的 chat completion 请求记录每次实际 fetch 使用的模型，包括语义路由 fallback 后的模型。stream/nonStream handler 通过请求作用域 options 将回调传入 ToolExecutor、分布式 bridge 和 WebSocketServer；共享执行器不保存“当前聊天”。回调只使用该请求的上游地址、凭据和模型，发起一次非流式请求，零重试、零 fallback，响应上限64 KiB。白名单证据包含候选、固定完成条件、预算和已验证回执，不发送查询值、页面原文或完整聊天，也不把回答交给工具解析器。

`execute_tool.androidTaskReplan=1` 广告可信回调。`android_task_replan`、`android_task_replan_result`、`cancel_android_task_replan` 均绑定父 requestId、随机 replanId、原 socket。错误节点、旧 socket、错误身份与重复回调不能改变当前任务。节点中的回调等待项可独立于提前返回的取消 tool_result 存活，直到上游实际依赖结算；这期间设备租约不释放。断连终止本地传输并取消任务，上游断连清理取消模型。晚结果不授权任何新写。

`counts.mainModelCalls` 记录已调用的升级回调次数；`counts.mainModelRequests` 记录上游报告的 HTTP 尝试次数，尚无回执或断连时为 `null`。HTTP 尝试不等于 HTTP 成功。有限的请求/返回模型标识、usage 和耗时写入 assistance settled 事件；无合法元数据时保持未知。人工次数独立记为 `humanHandoffs`，两类升级合计最多一次。

## 验证与证据边界

跨仓测试执行真实 stream/nonStream handler、ToolExecutor、执行 bridge、两端 WS 处理器和 AndroidControllerService；只替换模型 fetch、设备、套接字载体、原生交互及工具记录存储。两个 handler 均完成入口→输入→提交，计一次实际模拟 HTTP 请求，无重复派发。上游 fallback 采用生产 fetchWithRetry 函数的离线执行验证模型归属；并发回调保持各自模型和端点。

负例覆盖非法/过期建议、低置信、缺服务、重复回调、错误/替换连接、10秒升级截止、总截止、取消、依赖排干、Handoff 拒绝/交还/输入丢失/窗口漂移、viewer 取消、unknown 不恢复、轨迹失败零回调，以及超大/工具块/截断模型响应。保留原完成谓词、等待、stale、预算、策略、租约和宿主注入限定回归。

首轮链路测试暴露测试宿主缺少 broadcast/结果格式化辅助件，补齐后通过；首轮整组回归捕获了公共 Handoff 缺服务判定顺序退化，以及旧版轨迹夹具误加新 assistance 字段，均已修复。原失败日志保存于 `artifacts/android-jev-j52-2026-11-07/chain-r1.log`、`chain-handlers-r1.log`、`chain-r2.log`、`r1-final-VCPChat.log`，最终日志另存，无覆盖删除。

[改前备份清单](../../artifacts/android-jev-j52-2026-11-07/before.json)、[本批差异](../../artifacts/android-jev-j52-2026-11-07/changes.diff) 相对本轮开始时的工作区，保留此前安卓工作与其它脏文件；不是相对 Git HEAD 的全部仓库变更。[静态检查](../../artifacts/android-jev-j52-2026-11-07/static-checks.json) 对原为 CRLF 的上游文件使用 `core.whitespace=cr-at-eol` 识别行尾，未修改仓库 Git 配置。

本批没有使用真实上游模型流量或真机操作。`search-v4` 仍为 experimental、`calibrated:false`；完成策略为 `search-completion-v2`。下一代码批按路线进入 J2 最小语义与近期验证反馈；J0.2 的真实任务校准及独立联合验收仍是单独门槛。
