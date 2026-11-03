'use strict';

module.exports = {
    topics: ['overview', 'devices', 'packages', 'system', 'api'],
    limitations: { fill: 'Fill 仅 RPC 按实时节点替换；无可靠 shell 替换回退，不模拟全选删除。' },
    actions: [
        { command: 'Fill', required: 'text(0–2000字符),id|id=selector 或 index+snapshotId', note: 'text是替换内容，空字符串清空；不用text寻址，仅可见启用textfield。setText后getText一致才verified，读失败/不一致unknown；密码框不读不回显仅dispatched。RPC绑定原始class/package/resourceId及instance，不以变化文本绑定；无shell替换回退。' },
        { command: 'Wait', required: '外层或步骤expect', note: '只读条件等待，action只接受命令标识。复用visible/absent/foreground轮询，waitTimeoutMs默认5000、最多30000且不超过整段预算；不输入、不唤醒、不固定sleep。满足verified，未证实unknown并停止序列；unknown在此不表示派发过输入。可afterObserve返回成功采样。' },
        { command: 'Tap', required: 'id|text|selector 或 index+snapshotId 或 x+y+frameId', note: '语义目标实时重定位；index/像素凭据15秒过期，动作后失效。selector字面量%/#编码为%25/%23。' },
        { command: 'LongPress', required: '同Tap', optional: 'duration=800(ms，300–10000整数)' },
        { command: 'Swipe', required: 'x1,y1,x2,y2,frameId', optional: 'duration=300(ms，1–10000整数)', note: '使用设备坐标，不是缩放图片坐标。坐标/索引/时长仅接受安全整数或十进制整数字符串；不取整、不转换布尔值。' },
        { command: 'Scroll', required: 'id|text|selector 或 index+snapshotId，direction=up|down|left|right', optional: 'distance=0.6(可见容器轴长比例，0.1–0.9),duration=300(ms，1–10000)', note: '目标必须是当前可见启用的scroll容器，实时定位并按屏幕裁剪。方向表示浏览方向：down手指向上，right手指向左。只派发一次，不猜边界、不自动寻找目标；可afterObserve=true或expect确认结果。不需截图，不接受像素坐标。' },
        { command: 'InputText', required: 'text(1–2000字符)', optional: 'enter=false', note: '输入当前焦点，不自动清空、不定位字段，不等于Fill。非ASCII优先setClipboard(AndroidController,text)→pasteClipboard，在当前光标/选区插入，不移动光标、不读写整个字段、不依赖IME；clipboard=replaced是显式副作用，不读取旧剪贴板、不立即恢复以免粘贴竞态。无ack仅dispatched；未知不重放。RPC明确未执行才回退已安装且当前启用的ADBKeyboard，不自动切换。' },
        { command: 'KeyEvent', required: 'key', note: 'back/home/recents/enter/delete/tab/escape/方向键/音量键/power/wakeup/sleep，或KEYCODE_*、数字。' },
        { command: 'LaunchApp', required: 'package', optional: 'activity,stop=false；或url=http/https地址', note: 'url模式不接受activity/stop=true、账号密码、控制字符或非http/https协议；解析指定包的唯一处理组件后只派发一次，不回退其他应用。URL不回显；仅验证前台包名，pageLoaded=null，不证明网页加载/路径到达。普通启动保持原行为。' },
        { command: 'KillApp', required: 'package', note: '强制停止应用。' },
        { command: 'System', required: '外层serial,operation,capability', optional: 'value,params,targetOperation', note: 'Describe topic=system查能力；operation=read|navigate|set|probe|draft。复用全局设置的分设备授权，仅主用户0，无任意shell/intent/provider。set前读→一次绝对写→读回；draft只打开用户完成的编辑器。授权不覆盖通用GUI。' },
    ],
    observation: {
        modes: { ui: '默认：语义表和snapshotId；screenshot=true附图，stable=true二次采样。', image: '只截图，不依赖UI树；返回frameId和设备坐标映射。', arbitrate: 'arbitration对象={mode:target|page|recovery,snapshotId,goal?,candidates?,targetSelector?,requestTimeoutMs?}；复用已有快照，建议不执行。', api: 'capability,params,requestTimeoutMs；仅Describe topic=api列出的只读API，不操作设备。' },
        optional: 'limit=60,maxWidth=1080,region={left,top,width,height},target=canvas,format=jpeg|png,quality,grid',
        wake: 'never禁止唤醒；ifAllowed沿用AUTO_WAKE配置（默认）。锁屏不自动解锁。',
    },
    execution: {
        required: 'action对象或JSON对象字符串；或steps数组/JSON数组，二选一，不可递归或覆盖外层serial',
        sequence: 'steps=[{action,expect?,waitTimeoutMs?}]，1–8步GUI动作，不含System/管理。中间步必须expect且验证通过才继续；末步可仅派发。禁止外层action/expect/waitTimeoutMs，后续步骤禁止设备字段及index/像素凭据，必须实时语义定位。整段结构先校验，动作参数在各步派发前检查。单租约/总timeout，异常或unknown立即停；execution.sequence含逐步进度，不自动重试或回滚。afterObserve仅尾部或停止后采集，不累积中间截图。',
        expect: '可选：{type:visible|absent,selector} 或 {type:foreground,package}；verified只证明指定条件，不等于业务提交成功。',
        afterObserve: '默认false；true返回新语义快照，或对象{mode:ui|image,limit?,screenshot?,region?,target?,maxWidth?,format?,quality?,grid?}。验证成功样本新鲜时复用；观察失败不重放动作。',
        budget: 'timeoutMs=60000(1–300000)，覆盖整步；waitTimeoutMs=5000(1–30000)，仅收紧后置等待。',
        outcomes: 'observed=读取，dispatched=仅派发，verified=条件满足，unknown=条件未证实（有输入时可能已执行，Wait本身无输入），failed=未记录派发。unknown禁止直接重试；回执retryable=false不代表其它失败可重试。',
    },
    management: {
        connect: 'mode=auto|wireless|usb,address或serial；首次配对优先使用viewer向导。',
        reconnect: 'serial：复用设备缓存和发现进行重连。',
        disconnect: 'serial：断开设备。',
        startDisplay: 'open=true在Loom侧栏打开显示屏。',
        stopDisplay: '停止显示屏并释放采集。',
        displayStatus: '显示屏和采集诊断，不采UI树。',
    },
};
