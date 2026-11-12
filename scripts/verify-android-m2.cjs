'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const legacy = require('./verify-android-m15.cjs');
const PACKAGE = legacy.PACKAGE;
const id = name => `${PACKAGE}:id/${name}`;
const fail = code => Object.assign(new Error(code), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const CASES = Object.freeze(['ContainsRebind', 'RegexClassRole', 'WithinRawAncestor', 'ExplicitNth', 'DuplicateRejected',
    'SequenceRebind', 'ElementPixels', 'ElementIndex', 'ElementAfterObserve', 'ElementChangingRejected',
    'IdleStaticNative', 'IdleTextChanges', 'IdleMotionTimeout', 'IdleHostFallback']);
async function expectFailure(task, codes) {
    let caught;
    try { await task(); } catch (error) { caught=error; }
    if (!caught) throw fail('EXPECTED_REJECTION_MISSING');
    if (!codes.includes(caught.code)) throw caught;
}
function parseArgs(argv) {
    const o = { mode: 'probe', sdk: 'F:/AndroidSdk' }, seen = new Set();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]; if (seen.has(a)) throw fail('DUPLICATE_OPTION'); seen.add(a);
        if (a === '--probe' || a === '--suite') { if (seen.has(a === '--probe' ? '--suite' : '--probe')) throw fail('CONFLICTING_MODES'); o.mode = a.slice(2); }
        else if (['--serial', '--sdk', '--adb'].includes(a)) { const v = argv[++i]; if (!v || v.startsWith('--')) throw fail('MISSING_OPTION_VALUE'); o[a.slice(2)] = v; }
        else throw fail('UNKNOWN_OPTION');
    }
    if (!o.serial || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(o.serial)) throw fail('EXPLICIT_SERIAL_REQUIRED');
    return o;
}
function parseState(text) {
    const m = /^Row: 0 state=(\{[^\r\n]*\})$/.exec(text.trim());
    let s; try { s = JSON.parse(m?.[1]); } catch { throw fail('FIXTURE_STATE_UNREADABLE'); }
    if (s.ready !== true || s.resumed !== true || s.package !== PACKAGE || s.protocol !== 1 || !/^[a-f0-9-]{36}$/i.test(s.session)
        || !['gestures', 'keyboard', 'scroll', 'm2'].includes(s.mode)) throw fail('FIXTURE_STATE_INVALID');
    for (const k of ['m2ClicksA', 'm2ClicksB', 'm2DynamicCounter', 'm2Ticks']) if (!Number.isSafeInteger(s[k]) || s[k] < 0) throw fail('FIXTURE_M2_STATE_INVALID');
    if (typeof s.m2Motion !== 'boolean' || typeof s.m2Label !== 'string' || s.m2Label.length > 80) throw fail('FIXTURE_M2_STATE_INVALID');
    return s;
}
function independentImage(details, state, padding) {
    const r = state.m2Rect;
    assert.ok(r && ['left', 'top', 'right', 'bottom'].every(k => Number.isSafeInteger(r[k])));
    assert.equal(state.m2Color, -14639008);
    const screen = details.screen;
    const expected = { left: Math.max(0, r.left - padding), top: Math.max(0, r.top - padding) };
    expected.width = Math.min(screen.width, r.right + padding) - expected.left;
    expected.height = Math.min(screen.height, r.bottom + padding) - expected.top;
    assert.deepEqual(details.region, expected);
    assert.deepEqual(details.element.visibleBounds, r);
    assert.equal(details.element.occlusion, 'unknown');
    assert.ok(details.element.warnings.includes('OCCLUSION_NOT_PROVEN'));
    const m = details.mapping;
    assert.equal(m.offsetX, expected.left); assert.equal(m.offsetY, expected.top);
    assert.equal(m.stepX * m.imageWidth, expected.width); assert.equal(m.stepY * m.imageHeight, expected.height);
    return expected;
}
async function checkPixels(details, state, padding) {
    independentImage(details, state, padding);
    const data = Buffer.from(details.image.dataUrl.split(',')[1], 'base64');
    const { data: rgb, info } = await require('sharp')(data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, details.image.width); assert.equal(info.height, details.image.height);
    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    assert.deepEqual([...rgb.subarray(center, center + 3)], [32, 160, 96]);
    assert.ok(typeof details.frameId === 'string' && details.frameId.length > 0);
    return { width: info.width, height: info.height, centerRgb: [...rgb.subarray(center, center + 3)], padding };
}
async function runMatrix(ctx) {
    const results = [];
    const dynamic = { contains: 'M2 DYNAMIC', class: 'Button' };
    const same = { text: 'M2 SAME', class: 'Button' };
    const cases = [
        ['ContainsRebind', async () => { await ctx.tap(dynamic, (a,b) => b.m2DynamicCounter === a.m2DynamicCounter + 1); await ctx.tap(dynamic, (a,b) => b.m2DynamicCounter === a.m2DynamicCounter + 1); }],
        ['RegexClassRole', async () => { await ctx.tap({ regex: '^M2 DYNAMIC [0-9]+$', class: 'android.widget.Button', role: 'button' }, (a,b) => b.m2DynamicCounter === a.m2DynamicCounter + 1); }],
        ['WithinRawAncestor', async () => { await ctx.tap({ ...same, within: { id: id('m2_scope_b') } }, (a,b) => b.m2ClicksA === a.m2ClicksA && b.m2ClicksB === a.m2ClicksB + 1); }],
        ['ExplicitNth', async () => { await ctx.tap({ ...same, nth: 1 }, (a,b) => b.m2ClicksA === a.m2ClicksA && b.m2ClicksB === a.m2ClicksB + 1); }],
        ['DuplicateRejected', async () => { const a = ctx.gate(); await expectFailure(()=>ctx.execute({ action: { command: 'Tap', selector: same } }), ['TARGET_NOT_UNIQUE']); const b = ctx.gate(); assert.equal(a.m2ClicksA, b.m2ClicksA); assert.equal(a.m2ClicksB, b.m2ClicksB); }],
        ['SequenceRebind', async () => { const a=ctx.gate(); const r=await ctx.execute({ steps: [
            { action: { command:'Tap', selector:dynamic }, expect:{ type:'visible', selector:{ regex:'^M2 DYNAMIC [0-9]+$' } } },
            { action: { command:'Tap', selector:dynamic } }] }); assert.equal(r.details.sequence.status,'completed'); assert.equal(ctx.gate().m2DynamicCounter,a.m2DynamicCounter+2); }],
        ['ElementPixels', async () => { const s=ctx.gate(); const r=await ctx.image({ id:id('m2_color'), padding:8 }); const meta=await checkPixels(r.details,s,8); ctx.evidence(meta); }],
        ['ElementIndex', async () => { const ui=await ctx.observe(); const node=ui.details.controls.find(n=>n.id===id('m2_color')); assert.ok(node); const r=await ctx.image({ index:node.index, snapshotId:ui.details.snapshotId, padding:0 }); await checkPixels(r.details,ctx.gate(),0); }],
        ['ElementAfterObserve', async () => { const a=ctx.gate(); const r=await ctx.execute({ action:{ command:'Tap', selector:dynamic }, afterObserve:{ mode:'image',target:'element',id:id('m2_color'),padding:4,grid:false,format:'png' } });
            assert.equal(r.details.execution.outcome,'dispatched'); assert.equal(ctx.gate().m2DynamicCounter,a.m2DynamicCounter+1); assert.equal(r.details.observation.status,'observed');
            const d=r.details.observation; independentImage({ ...d, screen:r.details.screen || d.mapping.screen },ctx.gate(),4); }],
        ['ElementChangingRejected', async () => { await ctx.tap({id:id('m2_start_motion')},(_,b)=>b.m2Motion); await expectFailure(()=>ctx.image({id:id('m2_color')}), ['ELEMENT_TARGET_CHANGED','ELEMENT_CONTEXT_CHANGED']); await ctx.stop(); }],
        ['IdleStaticNative', async () => { const r=await ctx.idle(6500); assert.equal(r.details.execution.outcome,'verified'); assert.equal(r.details.idleMode,'layout_stable'); ctx.evidence({idleMode:r.details.idleMode}); }],
        ['IdleTextChanges', async () => { await ctx.tap({id:id('m2_start_text')},(_,b)=>b.m2Ticks>0); const a=ctx.gate(); const r=await ctx.idle(6500); const b=ctx.gate(); assert.ok(b.m2Ticks>a.m2Ticks); assert.equal(r.details.idleMode,'layout_stable'); assert.equal(r.details.execution.outcome,'verified'); await ctx.stop(); }],
        ['IdleMotionTimeout', async () => { await ctx.tap({id:id('m2_start_motion')},(_,b)=>b.m2Motion); const a=ctx.gate(); const start=Date.now(); const r=await ctx.idle(4500); const b=ctx.gate(); ctx.evidence({elapsedMs:Date.now()-start,outcome:r.details.execution.outcome,idleMode:r.details.idleMode,motionBefore:a.m2Motion,motionAfter:b.m2Motion,ticksBefore:a.m2Ticks,ticksAfter:b.m2Ticks}); if(r.details.execution.outcome!=='unknown'||r.details.idleMode!==null)throw fail('MOTION_IDLE_FALSE_SUCCESS'); if(!b.m2Motion||b.m2Ticks<=a.m2Ticks)throw fail('FIXTURE_MOTION_EXPIRED'); await ctx.stop(); }],
        ['IdleHostFallback', async () => { await ctx.reconfigure(false); const r=await ctx.idle(12000); assert.equal(r.details.execution.outcome,'verified'); assert.equal(r.details.idleMode,'layout_stable'); await ctx.reconfigure(true); }],
    ];
    assert.deepEqual(cases.map(c=>c[0]), CASES);
    for (const [name, run] of cases) {
        let error; ctx.current=name;
        ctx.emit({phase:'case-start',name});
        try { await ctx.drain(); ctx.gate(); await ctx.reset(); await ctx.observe(); await run(); }
        catch(e) { error=e; }
        try { await ctx.drain(); ctx.gate(); } catch(e) { error=e; error.terminal=true; }
        const result={phase:'case',name,status:error?'NOT_PASSED':'PASS',code:error?(error.code==='ERR_ASSERTION'?'INDEPENDENT_ASSERTION_FAILED':(/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code||'')?error.code:'CASE_FAILED')):'OK',retried:false};
        results.push(result); ctx.emit(result);
        if(error && (error.terminal || /^UI_SERVER_|DEVICE_STATE_UNCERTAIN|STEP_DEADLINE|STEP_ABORTED|UNSAFE_|FIXTURE_|RUNTIME_|ACTION_NOT_CONFIRMED|ACTION_SERIAL_MISMATCH|UNEXPECTED_CHANNEL/.test(error.code||''))) break;
    }
    const passed=results.filter(r=>r.status==='PASS').length;
    const ok=passed===CASES.length && results.length===CASES.length;
    const summary={phase:'summary',deviceAcceptance:ok?'PASSED':'NOT_PASSED',matrixTotal:CASES.length,executed:results.length,passed,failed:results.length-passed,notExecuted:CASES.length-results.length,retried:false};
    ctx.emit(summary); return {exitCode:ok?0:1,summary,results};
}
async function main(argv=process.argv.slice(2), deps={}) {
    const o=parseArgs(argv), emit=deps.emit||(v=>console.log(JSON.stringify(v)));
    const spawnSync=deps.spawnSync||cp.spawnSync;
    const adb=o.adb||path.join(o.sdk,'platform-tools',process.platform==='win32'?'adb.exe':'adb');
    if(!fs.statSync(adb,{throwIfNoEntry:false})?.isFile())throw fail('LOCAL_ADB_MISSING');
    const exec=(args,device=true)=> { const q=spawnSync(adb,[...(device?['-s',o.serial]:[]),...args],{encoding:'utf8',timeout:7000,maxBuffer:4*1024*1024,windowsHide:true}); if(q.error||q.status!==0)throw fail('ADB_READ_FAILED_STOP'); return q.stdout; };
    const devices=legacy.parseDevices(exec(['devices','-l'],false));
    if(!devices.some(d=>d.serial===o.serial&&d.state==='device'))throw fail('EXPLICIT_DEVICE_NOT_ONLINE');
    let session;
    const gate=()=> { const safe=legacy.parseSafety(exec(['shell','dumpsys','window','displays']),exec(['shell','dumpsys','power']),exec(['shell','dumpsys','window','policy'])); if(!safe.safe)throw fail('UNSAFE_OR_UNPROVEN_TARGET_STOP');
        const s=parseState(exec(['shell','content','query','--uri',`content://${PACKAGE}.state/state`])); if(session&&s.session!==session)throw fail('FIXTURE_SESSION_CHANGED_STOP'); session=s.session; return s; };
    const first=gate(); emit({phase:'probe',status:'READY_NOT_RUN',mode:first.mode,serviceInitialized:false});
    if(o.mode==='probe')return {exitCode:0};
    if(exec(['shell','[ -f /data/local/tmp/u2-server-0.5.0.apk ] && echo PRESENT || echo ABSENT']).trim()!=='PRESENT')throw fail('PREPROVISIONED_RPC_APK_REQUIRED');
    const service=(deps.loadService||(()=>require('../VCPDistributedServer/Plugin/AndroidController/AndroidControllerService')))();
        const runtime=(deps.loadRuntime||(()=>require('../VCPDistributedServer/Plugin/AndroidController/lib/step-runtime')))();
    const UiServer=require('../VCPDistributedServer/Plugin/AndroidController/lib/ui-server').UiServer;
    const originalInvoke=UiServer.prototype.invoke;
    const calls=[];
        UiServer.prototype.invoke=function(method, params, options) { calls.push({method,timeoutMs:options?.timeoutMs,nativeMs:method==='waitForIdle'?params?.[0]:undefined}); return originalInvoke.call(this,method,params,options); }; 
    let initialized=false;
    const drain=async()=> { const until=Date.now()+7000; for(;;){ const q=service.getRuntimeStatus()?.adbQueue; try { runtime.assertManagementIdle(); if(!q||q.depth!==0||q.pending!==0||q.running!==false)throw fail('RUNTIME_NOT_DRAINED_STOP'); return; }catch(e){ if(Date.now()>=until)throw fail('RUNTIME_NOT_DRAINED_STOP'); await pause(100); } } };
    const initialize=async enabled=> { initialized=true; await service.initialize({config:{ADB_PATH:adb,DEVICE_SERIAL:o.serial,AUTO_WAKE:'false',UI_SERVER:String(enabled),DISPLAY_PORT:0},logger:{log(){},warn(){},error(){}}}); };
    const call=async (args,executionContext)=> { gate(); const r=await service.processToolCall({serial:o.serial,timeoutMs:20000,...args},executionContext); if(r.details?.execution?.serial!==o.serial)throw fail('ACTION_SERIAL_MISMATCH_STOP'); emit({phase:'operation',name:ctx.current,command:args.command,outcome:r.details.execution.outcome,totalMs:r.details.execution.timings?.totalMs,sequenceStatus:r.details.sequence?.status,verificationError:r.details.execution.verification?.error}); gate(); return r; };
    const ctx={gate,drain,emit,current:'',evidence(v){emit({phase:'evidence',name:this.current,...v});},execute:a=>call({command:'ExecuteStep',...a}),
        observe:()=>call({command:'Observe',mode:'ui',wake:'never',limit:500}),
        image:a=>call({command:'Observe',mode:'image',target:'element',grid:false,format:'png',...a}),
        async idle(ms){
            const before=calls.length, samples=[];
            let r;
            try {
                r=await call({command:'ExecuteStep',action:{command:'Wait',mode:'idle'},waitTimeoutMs:ms},
                    {onM2IdleSample(sample){if(samples.length<160)samples.push(sample);}});
            } finally {
                // No page/XML/text output, no device reads, and no logging on the production sampling path.
                for(const sample of samples)this.evidence({idleSample:sample});
                this.evidence({idleDiagnostic:{samples:samples.length,sampleLimit:160,sampleLimitReached:samples.length===160,geometryLimit:128,
                    stabilityContract:'two-complete-layout-samples-equal',dumpFreshness:'unproven',
                    independentSampleTimeGeometry:'not-collected'}});
            }
            const reads=calls.slice(before);assert.ok(reads.every(q=>q.method==='waitForIdle'));assert.equal(reads.length,this.current==='IdleHostFallback'?0:1);assert.ok(reads.every(q=>q.nativeMs<=1500));this.evidence({nativeCalls:reads.length,nativeMs:reads[0]?.nativeMs||0});return r;
        },
        async tap(selector,predicate){const a=gate();const r=await this.execute({action:{command:'Tap',selector}});legacy.checkReceipt(r,['click']);await pause(150);const b=gate();assert.ok(predicate(a,b));return r;},
        async reset(){await this.tap({id:id('nav_m2')},(_,b)=>b.mode==='m2'&&!b.m2Motion&&b.m2Ticks===0&&b.m2DynamicCounter===0&&b.m2ClicksA===0&&b.m2ClicksB===0);},
        async stop(){await this.tap({id:id('m2_stop')},(_,b)=>!b.m2Motion);},
        async reconfigure(enabled){await drain();gate();await service.cleanup();gate();await initialize(enabled);await this.observe();},
    };
    try{await initialize(true);return await runMatrix(ctx);}finally{UiServer.prototype.invoke=originalInvoke;if(initialized){await drain();await service.cleanup();}}
}
module.exports={CASES,parseArgs,parseState,independentImage,checkPixels,runMatrix,main,expectFailure};
if(require.main===module)main().then(r=>{process.exitCode=r.exitCode;}).catch(e=>{console.error(JSON.stringify({phase:'stopped',status:'NOT_PASSED',code:/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code||'')?e.code:'M2_ACCEPTANCE_STOPPED',retried:false}));process.exitCode=1;});
