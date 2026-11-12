# J5.2 在途升级冻结契约

冻结于实现前；范围包括 VCPChat 与 VCPToolBox。离线替身验证，不向真实模型账户发送测试流量。

- `decision: jev` 可显式选择 `assistance: main_agent | human`，默认 `none`。正常路径零升级调用；每任务最多一次所选服务调用，主模型最长 10 秒，人工最长 60 秒，均受原总截止限制。服务缺失直接停止。`mainModelCalls` 统计已调用的主模型回调次数（包括失败）；不能由这个计数单独推断 HTTP 成功次数。
- 只在合法 Jev 分布低置信或显式 escalate 时升级。未知写、取消、上下文/策略违规、预算耗尽和循环硬停止都不升级。保持原租约、任务 ID、输入引用、完成谓词及全部进度/预算/已执行集合。
- 主模型建议只可为 `{schemaVersion:1,taskId,observationId,action:select|reobserve|stop,candidateId?}`。select 只能引用本次候选；重新观察、上下文验证、写前 fence 与后置条件仍由当前任务执行。reobserve 消耗下一轮，不授权写。不能递归 RunTask 或解析工具调用。
- 人工复用 M4.0 Handoff 并排干交互依赖。拒绝、超时、取消停止；接受后只认可内部交还引发的 epoch 失效，包/窗口/旋转等变化仍停止。重新观察及验证已填输入，再继续原循环；交还按钮不证明完成、不批准敏感动作。viewer takeover 继续取消原 Agent。
- WS 协议 `android_task_replan` / `android_task_replan_result` / `cancel_android_task_replan` 绑定父 requestId、随机 replanId、原连接。execute_tool 仅在原请求存在可信回调时广告 `androidTaskReplan:1`。同任务最多一次；重复和错误连接不生效。
- 上游主模型来自产生工具调用的同一请求、最近成功 fetch 的实际请求模型（包括 fallback 后的模型）。新调用零重试、零 fallback、非流式严格 JSON，响应最多 64 KiB；只发送白名单任务证据，不发送查询值、页面文字或完整聊天。模型返回无工具执行权。
- 取消信号转发给上游和人工服务；原连接存活时，主模型回调等待依赖真正结算后回执，保持设备租约排干。断连使本地传输结束并停止任务，上游断连处理取消对应模型；晚响应不恢复任务。
- 新策略 `search-v4`，完成策略维持 `search-completion-v2`，仍为 experimental / uncalibrated。新增 started/settled assistance 事件最多两个；字节上限 512 KiB、终止预留 4096 bytes 不变。

验收：正常零调用；一次升级恢复；缺服务；非法/陈旧/重复规划；超时取消与排干；错误/旧连接；并发请求模型隔离；Handoff 拒绝/交还/输入丢失/上下文变化；unknown 无重放；viewer 取消；原回归与容量门。
