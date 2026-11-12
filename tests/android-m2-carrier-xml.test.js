'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./helpers/android-service-harness.cjs');
const body='<hierarchy rotation="0"><node class="android.widget.Button" package="com.example" resource-id="com.example:id/go" text="Go" clickable="true" enabled="true" bounds="[0,20][80,50]"/></hierarchy>';
const xml="<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\r\n"+body;
const probe=()=>({focus:{package:'com.example',component:'com.example/.Main',window:'Main'},size:{width:100,height:200},wakefulness:'Awake',displayId:0,rotation:0,keyguard:{showing:false,inputRestricted:false}});
test('bounded expectation accepts carrier XML declaration just like ordinary Observe',async()=>{const h=await harness({uiServer:{ok:true,xml}});try{const r=await h.service.processToolCall({command:'ExecuteStep',serial:'A',action:{command:'Wait'},expect:{type:'visible',selector:'text=Go'},waitTimeoutMs:1000});assert.equal(r.details.execution.outcome,'verified');}finally{await h.service.cleanup();}});
test('idle raw full-layout sampler accepts the actual carrier XML declaration',async()=>{const h=await harness({client:{async probeScreen(){return probe();},async screenSize(){return probe().size;}},uiServer:{ok:true,xml,invoke:()=>null}});try{const r=await h.service.processToolCall({command:'ExecuteStep',serial:'A',action:{command:'Wait',mode:'idle'},waitTimeoutMs:1500});assert.equal(r.details.idleMode,'layout_stable');}finally{await h.service.cleanup();}});
test('bounded parser still refuses malformed hierarchy after a valid declaration',async()=>{const h=await harness({uiServer:{ok:true,xml:xml.replace('</hierarchy>','')}});try{const r=await h.service.processToolCall({command:'ExecuteStep',serial:'A',action:{command:'Wait'},expect:{type:'absent',selector:'text=missing'},waitTimeoutMs:100});assert.equal(r.details.execution.outcome,'unknown');}finally{await h.service.cleanup();}});

for (const prefix of ['\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n', '<?xml version="1.0"?>']) test('bounded sampler accepts legal declaration '+JSON.stringify(prefix),async()=>{const h=await harness({uiServer:{ok:true,xml:prefix+body}});try{const r=await h.service.processToolCall({command:'ExecuteStep',serial:'A',action:{command:'Wait'},expect:{type:'visible',selector:'text=Go'},waitTimeoutMs:1000});assert.equal(r.details.execution.outcome,'verified');}finally{await h.service.cleanup();}});
for (const malformed of ['<?xml invalid="yes"?>'+body, '<!DOCTYPE hierarchy>'+body, xml+'<node/>', body+body, '<?xml version="1.0"?>noise'+body]) test('declaration normalization does not hide malformed document '+JSON.stringify(malformed.slice(0,32)),async()=>{const h=await harness({uiServer:{ok:true,xml:malformed}});try{const r=await h.service.processToolCall({command:'ExecuteStep',serial:'A',action:{command:'Wait'},expect:{type:'visible',selector:'text=Go'},waitTimeoutMs:1000});assert.equal(r.details.execution.outcome,'unknown');}finally{await h.service.cleanup();}});


const boundedWait = h => h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
    action: { command: 'Wait' }, expect: { type: 'visible', selector: 'text=Go' }, waitTimeoutMs: 1000 });
const cliHarness = output => harness({ config: { UI_SERVER_ENABLED: false }, dump: () => output,
    client: { async probeScreen() { return probe(); }, async screenSize() { return probe().size; } } });

for (const separator of ['', '\n', '\r\n']) test('bounded CLI accepts only the fixed tty success wrapper '+JSON.stringify(separator), async () => {
    const h = await cliHarness(xml + separator + 'UI hierchary dumped to: /dev/tty\r\n');
    try {
        const result = await boundedWait(h);
        assert.equal(result.details.execution.outcome, 'verified');
        assert.equal(h.dumpCount, 1);
        assert.equal(h.calls.some(call => call[0] === 'rpc'), false);
    } finally { await h.service.cleanup(); }
});

test('idle bounded CLI validates wrapped carrier XML and compares raw full layouts', async () => {
    const h = await cliHarness(xml + '\nUI hierchary dumped to: /dev/tty\n');
    try {
        const result = await h.service.processToolCall({ command: 'ExecuteStep', serial: 'A',
            action: { command: 'Wait', mode: 'idle' }, waitTimeoutMs: 1500 });
        assert.equal(result.details.execution.outcome, 'verified');
        assert.equal(result.details.idleMode, 'layout_stable');
        assert.equal(h.dumpCount, 2);
        assert.equal(h.calls.some(call => call[0] === 'rpc'), false);
    } finally { await h.service.cleanup(); }
});

const tail = '\nUI hierchary dumped to: /dev/tty\n';
for (const [name, malformed] of [
    ['prefix garbage', 'noise' + xml + tail],
    ['suffix garbage before wrapper', xml + '\nnoise' + tail],
    ['suffix garbage after wrapper', xml + tail + 'noise'],
    ['wrong carrier path', xml + '\nUI hierchary dumped to: /sdcard/window.xml\n'],
    ['wrong carrier spelling', xml + '\nUI hierarchy dumped to: /dev/tty\n'],
    ['repeated wrapper', xml + tail + tail],
    ['DTD before root', '<!DOCTYPE hierarchy>' + xml + tail],
    ['broken root', xml.replace('</hierarchy>', '') + tail],
    ['duplicate attribute', xml.replace('rotation="0"', 'rotation="0" rotation="1"') + tail],
    ['broken entity', xml.replace('text="Go"', 'text="&bogus;"') + tail],
    ['second root', xml + body + tail],
]) test('CLI wrapper normalization preserves strict rejection: '+name, async () => {
    const h = await cliHarness(malformed);
    try {
        const result = await boundedWait(h);
        assert.equal(result.details.execution.outcome, 'unknown');
        assert.equal(h.dumpCount, 1);
    } finally { await h.service.cleanup(); }
});

