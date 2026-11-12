# J3.3a 单个应用内布尔开关：冻结离线契约

2026-11-07。实现前冻结；`toggle-v1` / `toggle-completion-v1` / `toggle-feedback-v1`，`calibrated:false`。本批是第二意图的有限首批，不表示 J3.3 或整个 J 系列完成。

## 输入与作用域

- `intent:"set_toggle"`，必须显式 `decision:"jev"`；`targets:{toggle:"包名:id/资源名"}`，`inputs:{checked:boolean}`。
- 完成谓词由宿主生成 `{type:"checked",id:targets.toggle,checked:inputs.checked}`，调用方不得另传 completion、loading、searchActions。不得传 query、多目标、任意动作、文本或坐标。
- 同包、前台、display 0、同窗口/Activity、同一租约。只准目标本身的一次 Tap；无导航、提交、补偿、系统命令或持久恢复。系统设置继续使用已有 System 能力与授权契约。
- maxActions 固定为 1；默认 60000ms、64 次观察、4 次 Jev，沿用全局时间/观察上限；最多 4 轮，连续第三次可信 stale 停止。允许 maxModelCalls=0，只有零模型路径能完成。

## 原始证据与执行

- 全原始树资源 ID 唯一，包括隐藏/被折叠节点。目标完整可见、enabled/clickable/checkable 均明确 true，checked 必须原样为 true 或 false；缺失/非法值不是 false。
- 拒绝 password、editable、文本框，隐藏/禁用祖先，以及会截获点击的 clickable/checkable 祖先；归一化动作图须含同一个唯一可点击目标。标签内容不用于目标推断。
- 初始状态必须连续两次整树与上下文稳定。已满足目标值时零写、零 Jev/主 Agent 调用完成；最终记录实际观察完成，不捏造原子动作回执。
- 未满足时只有绑定目标的 c0/Tap 或 escalate。模型只能选择；概率门槛 0.9、margin 0.2，未校准。回答绑定当前 observation；不支持 wait。
- 决策后复采及派发前 fence 都必须保持原样摘要/上下文；仅已证明未派发的 stale 可以在原预算内重决策。unknown 不重试。
- Tap 后必须用原始 checked 证据连续稳定读回两次；并保留最终宿主完成核验。派发前启动同一个最长 5000ms 后置窗口；所有验证共享它与任务总截止。状态回退、目标消失/歧义/不安全、上下文变化均不得继续写。

## 升级、轨迹与版本隔离

- 复用单次 main_agent 或 human assistance、原预算/租约、取消/超时排干。升级只能 select 当前 c0 / reobserve / stop，不能改目标布尔值、包、动作、预算或完成条件。交还后一律复采。
- 新意图使用独立循环与原始证据模块；宿主执行器复用计数、原子动作、模型调用、升级与轨迹生命周期。旧 search-v8 行为及闭词表不扩大。
- 对模型只投影包、声明 ID、布尔当前值/目标值、候选、受限反馈/预算；不外发 XML、标签、描述、输入值、异常原文或截图。轨迹记录受限布尔完成证据、版本及真实原子回执。
- 512KiB 与 4096 字节终止预留不变。旧搜索版本不得接受 toggle 字段，toggle 也不得接受搜索动作或伪造候选。

## 冻结验收范围

1. 开/关正常路径与已满足的开/关零写路径；严格 schema、布尔 false、预算/一次性 prepared 对象。
2. 缺失/非法 checked、非 checkable、重复/隐藏重复、裁剪/隐藏/禁用/敏感/交互祖先、图中缺失目标。
3. 独立环境读回；错误目标/无效果/状态回退/不稳定/上下文切换，不重试已经派发的点击。
4. 观察 stale、派发 stale、第三次停止、动作预算归还、模型错误/低置信/陈旧绑定、硬预算。
5. 主 Agent 选择/复采/停止/无效回答/缺服务；人工交还/拒绝；在途取消与 unknown 排干。
6. 轨迹/上游闭词表和隐私、策略隔离、最大预算容量；真实 Service 路径使用离线 XML/RPC/模型替身。
7. 对改前实际 search-v8 文件做固定回答准入/行为对照，并运行上一批两仓限定全集加本批专项；保存所有失败日志、退出码及前后 SHA-256。

不运行真实模型请求或设备动作，不提交/推送；真实模型校准和真机验收另列。
