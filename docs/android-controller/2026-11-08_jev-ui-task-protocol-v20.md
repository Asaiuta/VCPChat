# 通用 UI 任务 v20 冻结协议

2026-11-08，`ui-task-protocol-v20`，策略 `ui-task-v20 / ui-elements-v11 / ui-predicates-v2`，`calibrated:false`。

本版扩展完成目标和输入绑定，补齐长流程中的声明字段进度检查。本批只进行离线验证，不启动真机或真实模型。历史 [v19 协议](2026-11-07_jev-ui-task-protocol.md) 及 v18/r21 真机证据保留；旧版本结果不覆盖本版。当前代码与上游 VCPToolBox 的通用证据投影器须同时更新。

## 完成目标

`completion.all` 的 visible、absent、checked、text 目标、row 容器及 row.fields 字段，以及 loading 标记，接受二选一的目标形式：

```json
{ "id": "com.example:id/status" }
```

```json
{ "selector": { "text": "Saved", "role": "statictext", "within": { "desc": "Receipt" } }, "package": "com.example" }
```

selector 只支持精确 id/text/desc/class/role，以及一层 within/childOf/siblingOf/hasDescendant。主体和关系锚点均须至少声明一个精确条件；不接受 nth、近似匹配、正则、聚合标签或嵌套关系。每个字符串最多2000字符，资源ID最多320字符；拒绝控制字符、访问器和未知键。role 按已有 UI 角色归一化。package 默认 task.package，须位于 allowedPackages；selector 中的 ID 必须属于该目标包。id 简写自身绑定包，不接受另一个 package 参数。

完成检查复用 selector 引擎，但输入来自完整原始树；不使用合并后的可交互控件或截断显示文字。正向条件必须唯一匹配，再检查可见、启用、非密码及祖先安全性。隐藏、禁用和屏外重复节点仍计入歧义。关系锚点缺失、不安全或不唯一时无法证明完成，也不能证明 absent；hasDescendant 为存在关系，可有多个安全后代。当前前台是另一允许 App 时，不能证明原 App 的目标 absent。

row 的多个字段必须属于同一个直接结果行，且指向不同原始节点。text 保留 equals/inputRef、NFC_trim 和 stripPrefix 的既有规则。checked 仍要求原始 checkable/checked 明确给出。loading 的选择方式相同，标记只授权宿主等待，不证明完成。

例：不依赖 resource ID 的声明输入与结果检查：

```json
{
  "inputs": { "reference": "requested value" },
  "completion": { "all": [
    { "type": "text", "text": { "selector": { "desc": "Reference" }, "inputRef": "reference" } },
    { "type": "visible", "selector": { "text": "Saved", "role": "statictext" } }
  ] }
}
```

## 输入绑定与返回页面

顶层 text/inputRef 声明也是填写约束。宿主用当前完整原始树解析目标，只有唯一且安全的输入字段才能接收该 inputRef。声明引用不能因字段缺失或歧义而转填到任意字段；已可见可写的绑定字段优先填写。没有可写绑定字段时仍允许通用导航。Fill 继续要求底层 RPC 唯一性和精确读回，不因 selector 唯一而绕过 RPC 的限制。

任务内保留至多16项声明字段进度。唯一安全的可编辑字段已精确匹配输入后，返回页面再次看到该声明目标时，必须仍可唯一证明原值；值丢失、可见重复或不可用会停止为 TASK_PROGRESS_LOST，不自动重填。字段暂时隐藏或不在当前页面不证明丢失；账本跨 Back、LaunchApp、stale 和协助保留。静态复核页面可按声明的 text 规范化检查原值。

这是对调用者明确声明字段的可见进度检查，不证明不可见 App 状态持久化，也不为任意未声明字段推导跨页面身份。主 Agent/Handoff 交还后的无 ID 声明字段使用同一目标证据复核；未声明字段维持原保守身份检查。账本仅保存引用和布尔值，不进入持久轨迹或模型载荷。

## 循环、预算与报告

保持 Tap/Fill/Scroll/Back/ImeAction/LongPress/LaunchApp，包白名单、display 0、完整观察、设备租约、写前复采和未知写停止。相同页面同一已接受动作仍不重放。无检查器 Done 返回 unverified；有检查器仍需新鲜原始树与两次完整稳定满足，模型声明不等于完成。

默认预算为120000ms、16动作、256观察、32模型；上限300000ms、32动作、512观察、64模型。最多96可见元素、128动作候选，溢出在请求模型前停止。概率0.90、领先差0.20，加载与完成窗口仍为5秒，采样间隔200ms，完整采样准入余量1500ms；数值未放宽。显式加载和未稳定页面由宿主算法等待，仅消耗原观察预算和总截止。

assistance 默认 none；显式 main_agent/human 仅在合法低置信或 escalate 时进入一次，分别最多10秒/60秒，受原截止约束。正常路径零主模型/Handoff；未知写、无效响应和上下文不明不能借升级继续。主 Agent 仅可 select 当前候选、reobserve 或 stop。模型身份区分请求别名与实际返回版本，usage 缺失保持未知。

轨迹仍为脱敏 JSONL、512KiB，普通事件不能占用最后一个终止槽和4096字节预留。极端候选密度可能先耗尽轨迹字节预算，任务须停止为 TASK_TRACE_LIMIT；预算上限并不保证所有上限组合均可跑满。

下一轮真实探索仍使用用户指定的 Legado“魔女之旅 / 白石定规”，须新建批次冻结实际代码、ROM/App、起始状态、输入、独立检查器、模型、预算与报告路径。已有3动作/8模型/96观察/120秒预算不因本次离线工作自动改变。运行入口仍为 `scripts/android-j02-ui-task.cjs`，报告 schemaVersion=4，候选臂为 `jev-candidate-ui-task-v20`，见 [schema](j02/ui-report.schema.json)。正常、恢复和升级分别报告，逐风险和结果分母不得混用。

本批 acceptanceSamples=0。重复单一任务是相关工程 cluster，不能充作149个独立样本。正式 J0.2 仍须预注册任务族、独立性与风险分母，隔离校准集/独立验收集，使用单侧95% Clopper–Pearson；风险出现即停推广。搜索、开关、路线和通用任务分别准入，真实结论只能限于实际冻结的设备/ROM/App/模型范围。
