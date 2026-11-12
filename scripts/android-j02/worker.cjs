'use strict';
const fs=require('node:fs'),path=require('node:path');
const S=require('./storage.cjs');
const {fail}=require('./contract.cjs');
const {check}=require('./checker.cjs');
const {createSnapshotReader}=require('../android-independent-snapshot/reader.cjs');
const {device}=require('./device.cjs');
async function execute(state,slot,deps={}){
    const {m,p,output}=state,t=m.tasks.find(t=>t.id===slot.taskId),a=m.arms.find(a=>a.id===slot.armId),dir=path.join(output,'trials',slot.trialId);
    const d=(deps.device||device)(m.tools.adbPath,p.environment.serial),reader=(deps.reader||createSnapshotReader)({jar:m.tools.snapshotJar,executeAdb:d.executeAdb});
    const responses=[];
    const start=Date.now(),r={schemaVersion:1,trialId:slot.trialId,started:false,status:'not_run',code:null,claimedComplete:false,
        independent:{verdict:'unknown',checks:[]},counts:{actions:0,observations:0,jevCalls:0,mainAgentCalls:0,mainModelRequests:0,humanHandoffs:0},
        receipts:[],models:[],recoveryAttempted:false,escalationRequested:false,timings:{taskMs:null,resetMs:null,independentCheckMs:null,endToEndMs:null},
        invalidations:[],cleanupProven:false,artifacts:[]};
    const save=(name,bytes)=>{fs.writeFileSync(path.join(dir,name),bytes,{flag:'wx',mode:0o600});r.artifacts.push({file:name,sha256:S.sha(bytes)});};
    const environment=()=>{
        if(S.canonical(d.inspect(p.environment.apps.map(a=>a.package),p.environment.stateFiles.map(f=>f.file)))!==S.canonical(p.environment))throw fail('J02_ENVIRONMENT_CHANGED');
        if(!S.unchanged(p.identity))throw fail('J02_FROZEN_IDENTITY_CHANGED');
        if(m.benchmark)require('./benchmark-adapter.cjs').preparation(m.benchmark.preparedDir);
    };
    const capture=name=>{
        d.gate(t.start.package,p.environment);const capture=reader.execute(15000);d.gate(t.start.package,p.environment);
        if(capture.error||capture.signal||capture.status!==0)throw fail('J02_CAPTURE_FAILED');
        const xml=String(capture.stdout);save(name,xml);return xml;
    };
    let service,initialized=false,prepared=false,taskResult,execution,taskAt,bridge;
    const nativeEvents=[];
    if(m.benchmark)r.benchmark={suite:m.benchmark.suite,taskId:t.benchmark.taskId,
        method:m.benchmark.suite==='androidworld'?'native_task':'isolated_native_judge_final_state',
        setup:false,cleanup:false,verdict:'unknown',score:null,code:null};
    try{
        let jev=null;
        if(a.decision==='jev'){
            const settings=S.read(a.settingsFile),{GlobalJevService}=require(path.join(a.root,'modules/services/globalJevService.js'));
            const production=deps.jev?deps.jev(settings):new GlobalJevService({settingsManager:{readSettings:async()=>settings},logger:{log(){},warn(){},error(){}}});
            const status=await production.getStatus();
            if(!status.configured||status.provider!==a.model.provider||status.model!==a.model.requestedAlias||S.sha(status.url)!==a.model.endpointSha256)throw fail('J02_MODEL_CONFIG_CHANGED');
            jev={getStatus:()=>production.getStatus(),decide:async(...args)=>{
                if(!S.unchanged(p.identity))throw fail('J02_FROZEN_IDENTITY_CHANGED');
                const reply=await production.decide(...args);
                const {modelEvidence}=require(path.join(a.root,'modules/services/androidJevEvidence.js'));
                const metadata=modelEvidence({provider:a.model.provider,requestedModel:a.model.requestedAlias},reply,0);
                responses.push({provider:metadata.provider,requestedModel:metadata.requestedModel,returnedModel:metadata.returnedModel,usage:metadata.usage});
                if(a.model.expectedReturnedVersion&&reply.model!==a.model.expectedReturnedVersion){r.invalidations.push('RETURNED_MODEL_CHANGED');throw fail('J02_MODEL_CHANGED');}
                return reply;
            }};
        }
        environment();d.gate(undefined,p.environment);
        const resetAt=Date.now();
        if(m.benchmark){
            bridge=(deps.bridge||require('./benchmark-process.cjs').createBridge)(m.benchmark);
            const entry={op:'initialize',completed:false};nativeEvents.push(entry);
            const taskCase=S.read(t.benchmark.caseFile);
            const reply=await bridge.initialize({runtime:m.benchmark,case:taskCase,adb:m.tools.adbPath,serial:p.environment.serial});
            if(reply?.goal!==taskCase.goal)throw fail('J02_NATIVE_GOAL_CHANGED');
            entry.completed=true;r.benchmark.setup=true;
            environment();d.gate(undefined,p.environment);
        }else d.read(['shell','am','force-stop',t.start.package]);
        d.read(['shell','monkey','-p',t.start.package,'-c','android.intent.category.LAUNCHER','1']);
        await new Promise(resolve=>setTimeout(resolve,t.reset.waitMs));r.timings.resetMs=Date.now()-resetAt;
        prepared=true;reader.prepare();
        if(check(capture('initial.xml'),t.start,p.environment.viewport).verdict!=='pass')throw fail('J02_START_STATE_UNPROVEN');
        if(check(fs.readFileSync(path.join(dir,'initial.xml'),'utf8'),t.finish,p.environment.viewport).verdict==='pass')throw fail('J02_RESULT_PREEXISTS');
        const {createAndroidTaskExecutor}=require(path.join(a.root,'modules/services/androidTaskExecutor.js'));
        const {createTaskTraceStore}=require(path.join(a.root,'modules/services/androidTaskTrace.js'));
        service=deps.service?deps.service():require(path.join(a.root,'VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js'));
        const traceDirectory=path.join(dir,'traces');initialized=true;
        await service.initialize({config:{ADB_PATH:m.tools.adbPath,DEVICE_SERIAL:p.environment.serial,AUTO_WAKE:'false',UI_SERVER:'true',DISPLAY_PORT:0},
            services:{androidTaskExecutor:(deps.executor||createAndroidTaskExecutor)({jev,traceStore:createTaskTraceStore({directory:traceDirectory})})},logger:{log(){},warn(){},error(){}}});
        environment();d.gate(t.start.package,p.environment);r.started=true;taskAt=Date.now();
        const answer=await service.processToolCall({command:'RunTask',task:require('./batch.cjs').taskSpec(m,t,a)});
        r.timings.taskMs=Date.now()-taskAt;taskResult=answer.details?.task;execution=answer.details?.execution;
        if(!taskResult)throw fail('J02_TASK_RESULT_MISSING');
        r.status=taskResult.status;r.code=taskResult.code||null;r.claimedComplete=taskResult.status==='completed';
        const c=taskResult.counts||{};r.counts={actions:c.actions??null,observations:c.observations??null,jevCalls:c.modelCalls??null,
            mainAgentCalls:c.mainModelCalls??null,mainModelRequests:c.mainModelRequests??(c.mainModelCalls===0?0:null),humanHandoffs:c.humanHandoffs??0};
        r.receipts=(taskResult.receipts||[]).map(x=>({outcome:x.outcome}));
        const tracePath=path.join(traceDirectory,taskResult.taskId+'.jsonl'),bytes=fs.readFileSync(tracePath);
        const events=String(bytes).trim().split('\n').map(JSON.parse);save('trace.jsonl',bytes);
        r.models=events.filter(e=>e.type==='model').map(e=>({provider:e.modelEvidence?.provider??null,requestedModel:e.modelEvidence?.requestedModel??null,
            returnedModel:e.modelEvidence?.returnedModel??null,usage:e.modelEvidence?.usage||{inputTokens:null,outputTokens:null,totalTokens:null}}));
        r.recoveryAttempted=events.some(e=>e.type==='recovery');
        r.escalationRequested=r.code==='TASK_ESCALATION_REQUIRED'||c.mainModelCalls>0||c.humanHandoffs>0||events.some(e=>e.type==='escalation'&&e.escalation?.disposition==='assistance_required');
        require(path.join(a.root,'VCPDistributedServer/Plugin/AndroidController/lib/step-runtime.js')).assertManagementIdle();
        await service.cleanup();initialized=false;
        if(r.receipts.some(x=>x.outcome==='unknown')||/^(?:UI_SERVER_|DEVICE_|ADB_|STEP_)/.test(r.code||''))throw fail('J02_TRANSPORT_UNPROVEN');
        const checkAt=Date.now();r.independent=check(capture('final.xml'),t.finish,p.environment.viewport);r.timings.independentCheckMs=Date.now()-checkAt;
        if(bridge){
            const entry={op:'score',completed:false};nativeEvents.push(entry);
            const score=await bridge.score({xmlFile:path.join(dir,'final.xml')});
            if(!score||!['pass','fail','unknown'].includes(score.verdict)||
                (score.verdict==='unknown'?score.score!==null:!Number.isFinite(score.score)||score.score<0||score.score>1||((score.score===1)!==(score.verdict==='pass'))))throw fail('J02_NATIVE_SCORE_INVALID');
            save('native-score.json',JSON.stringify(score,null,2)+'\n');
            r.benchmark.verdict=score.verdict;r.benchmark.score=score.score;r.benchmark.code=score.code||null;entry.completed=true;
        }
        if(r.claimedComplete&&execution?.outcome!=='verified')r.invalidations.push('HOST_EXECUTION_UNPROVEN');
    }catch(e){
        const failureCode=/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code||'')?e.code:'J02_WORKER_FAILED';
        // Native evaluation has its own error field. Preserve a controller's
        // cancellation/refusal reason when the subsequent oracle fails.
        if(!r.benchmark||!taskResult||!r.code)r.code=failureCode;
        if(r.started&&!taskResult){r.status='stopped';r.counts={actions:null,observations:null,jevCalls:null,mainAgentCalls:null,mainModelRequests:null,humanHandoffs:null};r.receipts=[{outcome:'unknown'}];}
        if(/CHANGED/.test(failureCode))r.invalidations.push(failureCode);
        if(r.benchmark)r.benchmark.code=failureCode;
    }finally{
        if(taskAt&&r.timings.taskMs===null)r.timings.taskMs=Date.now()-taskAt;
        let clean=true;
        if(initialized)try{await service.cleanup();}catch{clean=false;}
        if(prepared)try{const c=reader.cleanup();clean=clean&&c.removed&&c.processAbsent;}catch{clean=false;}
        if(bridge){
            const entry={op:'cleanup',completed:false};nativeEvents.push(entry);
            try{
                if(!clean){bridge.abort?.();throw fail('J02_NATIVE_CLEANUP_UNPROVEN');}
                if(await bridge.cleanup()!==true)throw fail('J02_NATIVE_CLEANUP_UNPROVEN');
                r.benchmark.cleanup=true;entry.completed=true;
            }catch(e){clean=false;r.benchmark.code=e.code||'J02_NATIVE_CLEANUP_UNPROVEN';}
        }
        if(r.benchmark)save('native-lifecycle.json',JSON.stringify(nativeEvents,null,2)+'\n');
        try{environment();}catch(e){r.invalidations.push(e.code||'ENVIRONMENT_RECHECK_FAILED');}
        r.cleanupProven=clean;r.timings.endToEndMs=Date.now()-start;
        for(let i=0;i<responses.length;i++)r.models[i]=responses[i];
    }
    require('./evidence.cjs').validateResult(r,slot.trialId);S.write(path.join(dir,'result.json'),r);return r;
}
if(require.main===module){const state=require('./batch.cjs').load(process.argv[2]),slot=state.p.schedule.find(s=>s.trialId===process.argv[3]);
    if(!slot)throw fail('J02_TRIAL_ID');execute(state,slot).then(()=>{process.exitCode=0;}).catch(()=>{process.exitCode=1;});}
module.exports={execute};
