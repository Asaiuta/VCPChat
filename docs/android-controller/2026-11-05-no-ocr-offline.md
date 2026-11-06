# 无OCR能力增量：离线交付与真机边界

当前阶段档位、回归数字、生产代码摘要统一见[状态表](README.md)。本批尚未发布；不以历史M1.5/M2真机结果验收新增代码。

## 实现

- ScrollUntil统一scroll-axis-interior：目标可见区域需离开滚动轴两端，不把贴边碎片判为找到，不推算已被Android裁剪掉的完整元素尺寸。
- 逐次批准经VCPChat主进程Electron原生对话框；服务由既有initializeServices链注入。绑定设备、当前任务、动作、完整原始树、上下文epoch和策略摘要。批准后重采样，变化拒绝。取消/过期/迟到答复不执行，无可复用公开token；旧index/frame不能借等待续期。deny/readOnly和System能力授权不被批准覆盖。
- Handoff在原调用/序列内等待人交还，保持step-runtime设备租约、共享总预算，前后撤销旧凭据。含Handoff默认及最大预算10分钟；停止或超时unknown，不重排已完成步骤，不提供持久化任务恢复。继续只证明人选择继续，中间步仍需expect。
- selector增加childOf、siblingOf和hasDescendant；复用原始树provenance、解析和有界查询。前两者锚点唯一，hasDescendant为存在判定，禁止关系嵌套。
- Collect复用prepareTarget、Scroll与现有总预算；每页仅一次原始可见性扫描，最多30页，每页100项、预览120字符。保留page/ordinal与重复；截断、无进展、页数上限不证明列表完整。采集数据同时进入模型content，异常只返回计数，不附带已采文本。

## 复用与边界

VCPToolBox已提供工具调用审批和分布式cancel_tool。前者发生于分布式执行前，无法绑定Android即时目标，因此没有拿它当最终动作批准；后者直接复用。VCPChat补上可信AbortSignal、请求归属及旧连接结果隔离，未修改ToolBox代码。未引入新审批服务器、renderer批准入口、兼容别名或第二套任务队列。

宿主取消是协作式signal，不能声称其它忽略signal的stdio插件已物理终止。Android运行时负责自己的租约、输入结果和RPC排干。没有真实设备时，原生窗口行为与ROM输入效果仍不能由mock验证替代。

真正IME editor action、完整windowId/type/layer、窗口事件订阅、多display输入、持久化断点、后台虚拟屏未在此批交付。ImeAction仍明确是66/84按键，windows=true仍为只读多root诊断。

## 证据

[离线日志](../../artifacts/android-no-ocr-2026-11-05/offline.log)、[退出码](../../artifacts/android-no-ocr-2026-11-05/offline.exit.txt)、[生产摘要](../../artifacts/android-no-ocr-2026-11-05/code-identity.json)、[宿主摘要](../../artifacts/android-no-ocr-2026-11-05/host-identity.json)、[语法检查](../../artifacts/android-no-ocr-2026-11-05/syntax.json)。本轮首个失败全量保留于offline-first.log：发现重复解析和新双击测试依赖真实调度；前者修生产，后者沿用既有虚拟时钟，不放宽生产120ms限时。

新增行为测试：android-human-interaction、android-no-ocr-workflows、distributed-cancellation，以及实际PluginManager注入用例。覆盖批准变更、取消、迟到批准、租约、Handoff同序列恢复/停止/截止、双击策略撤销、原始树关系、合法重复、截断、无进展、未知输入禁重放及模型可见采集数据。

离线完成后执行ADB设备清单与现有M1.5只读probe。当前授权在线设备0台，probe exit2、serviceInitialized=false，因此deviceAcceptance=NOT_RUN。未安装、启动、唤醒或操作手机。下步需连接设备并手工打开com.vcpchat.m15fixture，再运行隔离靶场验收；人工对话框需真实VCPChat宿主参与。

本目录按现有.git/info/exclude仅本机保留；生产代码与测试按仓库现有策略处理。未提交或推送。
