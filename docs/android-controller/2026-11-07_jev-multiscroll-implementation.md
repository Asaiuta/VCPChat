# J3.1 多屏连续查找实现

本批在原搜索循环中接入显式声明的多屏查找，每次滚动分别经过观察、Jev 选择、写前校验和独立后置验证。档位、回归数字、容量和固定对照统一见 [当前状态](README.md)。实现前冻结范围见 [契约](2026-11-07_jev-multiscroll-contract.md)，命令与源码摘要见 [选择集](../../artifacts/android-jev-j31-multiscroll-2026-11-07/final-selection.json)，实际退出码见 [结果](../../artifacts/android-jev-j31-multiscroll-2026-11-07/final-result.json)，汇总见 [证据](../../artifacts/android-jev-j31-multiscroll-2026-11-07/evidence.json)。

## 行为与实现边界

`decision=jev` 的 `searchActions.scroll` 新增可选整数 `maxSwipes`，默认1、上限4；大于1仅允许 `command=Scroll`。每次底层仍是一个原子 swipe，固定距离和时间，不把声明次数交给设备内部循环。`ScrollUntil` 仍固定 host/maxSwipes=1，目标未找到时保持 unknown。所有路径共用原动作、观察、模型、八轮和总截止预算，达到任务预算时可早于声明次数停止。

进入多屏查找后绑定原声明容器、目标及方向。目标未见时，`task-scroll-progress.js` 从原始树提取安全、启用、完整可见、同包唯一资源 ID 的直接子节点锚点；包含密码、输入或嵌套滚动子树的节点排除。容器身份、类与原始/可见边界必须一致，至少两个共同锚点沿声明方向等量移动，必须同时有旧锚点离开、新锚点进入。两次连续后置观察稳定后才认定方向性内容移动。它不证明更接近业务目标，也不证明列表边界。

指定合法搜索目标出现时，可以直接证明查找完成，不要求继续满足锚点重叠。找到入口后仍按原入口验证进入新表单；已验证入口或 Fill 后结束查找阶段，避免把旧入口必须仍可见的要求错误套到新表单。新出现的其它搜索控件不能使查找偏离原声明目标。

每任务 HMAC 分别记录位置和锚点身份集合。下一次决策前位置变化以 `TASK_SCROLL_DRIFT` 停止；A→B→A 回访以 `TASK_SCROLL_REVISITED` 停止，已派发回执保持 unknown；已验证次数达到上限且目标未见以 `TASK_SCROLL_LIMIT` 停止。stale、主 Agent 重观察和人工交还保留次数、已见页面及位置约束。可信未派发 stale 不消耗 swipe，未知效果不重试，取消仍持有设备租约直到实际执行排干。

策略更新为 `search-v7`、反馈为 `search-feedback-v3`；语义仍 `search-semantics-v1`，完成仍 `search-completion-v2`，`calibrated:false`。反馈增加 `scrollProgress:{swipes,maxSwipes,lastResult}`。已验证回执的 `scrollProof` 记录前后观察身份、HMAC 摘要、结果类别、共同锚点数和距离。轨迹按版本及任务声明验证这些字段；VCPToolBox 主 Agent 投影仅输出结果类别、锚点数和距离，不输出锚点 ID、坐标、类名、HMAC 或原始文字。原实际主 Agent 请求绑定、取消和零重试链继续使用。

## 验证与失败记录

专项通过真实 Service、XML、task-port、原子执行器、trace 和上游投影，配合固定设备/模型替身验证。覆盖四方向多次滚动后成功、声明次数和原动作预算、A→B→A、无移动/反向/全替换/不等量移动、文字装饰、重复锚点、容器变化、模型等待期间位置漂移、stale、主 Agent 重观察、人工交还、目标入口转表单、第二次写 unknown、取消排干及非法证明/计数。此前单次查找、IME、目标安全、完成、跨仓升级与供应商请求隐私测试保留在限定回归内。

首次专项的两个失败来自夹具预期：[multiscroll-r1.log](../../artifacts/android-jev-j31-multiscroll-2026-11-07/multiscroll-r1.log) 中持续改变文字被原写前 fence 拦截，实际没有写；另一次以新增时钟节点模拟文字变化，实际改变了锚点身份集合，因而触发位置漂移。夹具分别改成写后变化再保持稳定、只修改既有行文字，未放宽生产 fence 或锚点规则。修正及新增边界的专项日志保存在 [multiscroll-r2.log](../../artifacts/android-jev-j31-multiscroll-2026-11-07/multiscroll-r2.log)；最终源码以最终限定集及摘要为准。

[固定对照](../../artifacts/android-jev-j31-multiscroll-2026-11-07/comparison.json) 从改前快照加载实际 search-v6 循环、执行器和语义模块，与当前 search-v7 使用相同替身状态转移和固定回答。普通搜索的候选、动作、独立结果、调用次数及请求字节保持一致；另外比较 enter、已有焦点 search、单次 Scroll、单次 ScrollUntil、ScrollUntil 加 search，结果、动作、预算计数和回执一致。故意错误高置信场景仍会误派发后停止；一致性不能解释为真实模型质量改善。请求大小只计 UTF-8 JSON `{state,questions}`，不含供应商封装、token 或计费。对照退出码单独保存于 [comparison-result.json](../../artifacts/android-jev-j31-multiscroll-2026-11-07/comparison-result.json)。

[本批差异](../../artifacts/android-jev-j31-multiscroll-2026-11-07/changes.diff) 相对 [改前工作区快照](../../artifacts/android-jev-j31-multiscroll-2026-11-07/before.json)，保留两仓已有修改；[静态检查](../../artifacts/android-jev-j31-multiscroll-2026-11-07/static-checks.json) 包含源码语法、manifest JSON、限定文件空白检查及备份摘要核验。

本批仅离线替身，无真实上游请求或真机动作。重复行 ID、缺少稳定唯一直接子节点、一次滑动整屏替换且无重叠的列表会停止，不宣称适配任意 App。外包键盘树、窗口/尺寸变化仍受原上下文限制。真实任务校准和设备/App 联合准入仍未完成，J3.2 导航与新意图不在本批范围。
