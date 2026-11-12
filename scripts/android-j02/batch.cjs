'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {validate,fail}=require('./contract.cjs');
const S=require('./storage.cjs');
const TOOL_ROOT=path.resolve(__dirname,'../..');
const fileHash=file=>S.sha(fs.readFileSync(file));
const workload=t=>S.sha(S.canonical({inputs:t.requests.candidate.inputs,start:t.start,finish:t.finish,reset:t.reset,
    ...(t.benchmark?{benchmark:S.read(t.benchmark.caseFile)}:{})}));
function taskSpec(m,t,arm){return {...t.requests[arm.id],serial:S.read(m.environmentFile).serial,intent:arm.intent,decision:arm.decision,
    budget:{...t.budget,...(arm.decision==='rules'?{maxModelCalls:0}:{})}};}
function normalize(input,base){
    const m=validate('manifest',structuredClone(input));
    if(new Set(m.gates.requiredStrata).size!==m.gates.requiredStrata.length||new Set(m.gates.requiredFeatures).size!==m.gates.requiredFeatures.length)throw fail('J02_GATES_INVALID');
    for(const k of ['registry','environmentFile'])m[k]=path.resolve(base,m[k]);
    for(const k of ['adbPath','snapshotJar'])m.tools[k]=path.resolve(base,m.tools[k]);
    if(new Set(m.arms.map(a=>a.id)).size!==3)throw fail('J02_ARMS_INVALID');
    for(const a of m.arms){if(a.unavailableReason)continue;a.root=path.resolve(base,a.root);if(a.settingsFile)a.settingsFile=path.resolve(base,a.settingsFile);
        if((a.id==='rules')!==(a.decision==='rules')||(a.decision==='jev'&&(!a.model||!a.settingsFile))||(a.decision==='rules'&&(a.model||a.settingsFile)))throw fail('J02_ARM_MODE');
        if(m.stage!=='exploration'&&a.model&&!a.model.expectedReturnedVersion)throw fail('J02_MODEL_NOT_PINNED');
    }
    require('./benchmark-adapter.cjs').normalize(m,base);
    const ids=new Set(),clusters=new Map(),workloads=new Map();
    for(const t of m.tasks){
        if(ids.has(t.id))throw fail('J02_TASK_DUPLICATE');ids.add(t.id);
        if(t.start.package!==t.finish.package)throw fail('J02_CHECKER_SCOPE');
        if(clusters.has(t.clusterId)&&clusters.get(t.clusterId)!==t.split)throw fail('J02_SPLIT_LEAK');clusters.set(t.clusterId,t.split);
        const hash=workload(t);if(workloads.has(hash)&&workloads.get(hash)!==t.clusterId)throw fail('J02_CORRELATED_RENAMING');workloads.set(hash,t.clusterId);
        for(const a of m.arms){
            if(a.unavailableReason||a.id==='rules'&&t.rulesExclusion)continue;
            const request=t.requests[a.id];if(!request)throw fail('J02_ARM_TASK_MISSING');
            if(['serial','intent','decision','budget','taskId'].some(k=>Object.hasOwn(request,k))||request.assistance&&request.assistance!=='none')throw fail('J02_REQUEST_OVERRIDE');
            if(request.package!==t.start.package||S.canonical(request.inputs)!==S.canonical(t.requests.candidate.inputs))throw fail('J02_UNPAIRED_INPUTS');
            if(request.allowedPackages?.some(pkg=>pkg!==request.package))throw fail('J02_BATCH_SINGLE_APP_SCOPE');
            require(path.join(a.root,'modules/services/androidTaskExecutor.js')).prepareTask(taskSpec(m,t,a));
        }
    }
    if(m.arms.find(a=>a.id==='candidate').unavailableReason)throw fail('J02_CANDIDATE_REQUIRED');
    if(m.calibrationEvidence)m.calibrationEvidence.reportFile=path.resolve(base,m.calibrationEvidence.reportFile);
    return m;
}
function armIdentity(a){
    if(a.unavailableReason)return{id:a.id,unavailableReason:a.unavailableReason};
    const table=require(path.join(a.root,'modules/services/androidTaskPolicy.js'));
    const policy=({search:table.SEARCH_POLICY,set_toggle:table.TOGGLE_POLICY,route_search:table.ROUTE_POLICY,ui_task:table.UI_TASK_POLICY})[a.intent];
    if(!policy)throw fail('J02_POLICY_UNAVAILABLE');
    const source=S.inventory(a.root).map(file=>[path.relative(a.root,file).replaceAll('\\','/'),fileHash(file)]);
    return{id:a.id,decision:a.decision,intent:a.intent,policy,model:a.model,sourceSha256:S.sha(S.canonical(source))};
}
async function freeze(manifestFile,output){
    manifestFile=path.resolve(manifestFile);output=path.resolve(output);
    const m=normalize(S.read(manifestFile),path.dirname(manifestFile));
    return S.locked(m.registry+'.lock',async()=>{
        const history=S.records(m.registry);if(history.some(r=>r.batchId===m.batchId))throw fail('J02_BATCH_ID_REUSED');
        const partitions=m.tasks.map(t=>({id:t.id,clusterId:t.clusterId,split:t.split,workload:workload(t)}));
        for(const old of history.filter(r=>r.event==='frozen')){
            if(old.datasetId===m.datasetId&&S.canonical(old.partitions)!==S.canonical(partitions))throw fail('J02_PARTITION_CHANGED');
            for(const t of partitions)for(const p of old.partitions){
                if((t.clusterId===p.clusterId||t.workload===p.workload)&&t.split!==p.split)throw fail('J02_SPLIT_LEAK');
                if(t.workload===p.workload&&t.clusterId!==p.clusterId)throw fail('J02_CORRELATED_RENAMING');
            }
        }
        if(m.stage==='acceptance'&&history.some(r=>r.event==='exposed'&&m.tasks.some(t=>t.split==='acceptance'&&(t.clusterId===r.clusterId||workload(t)===r.workload))))throw fail('J02_ACCEPTANCE_ALREADY_EXPOSED');
        const toolFiles=fs.readdirSync(__dirname).filter(n=>/\.(cjs|py|json)$/.test(n)).map(n=>path.join(__dirname,n));
        const files=[manifestFile,m.environmentFile,m.tools.adbPath,m.tools.snapshotJar,process.execPath,
            path.join(TOOL_ROOT,'scripts/android-j02-batch.cjs'),path.join(TOOL_ROOT,'scripts/android-independent-snapshot/reader.cjs'),
            path.join(TOOL_ROOT,'scripts/verify-android-m15.cjs'),...toolFiles,...S.inventory(TOOL_ROOT),...require('./benchmark-adapter.cjs').files(m)];
        const arms=m.arms.map(armIdentity);
        const original=arms.find(a=>a.id==='original'),candidate=arms.find(a=>a.id==='candidate');
        if(original.sourceSha256===candidate.sourceSha256&&original.intent===candidate.intent)throw fail('J02_BASELINE_EQUALS_CANDIDATE');
        for(const a of m.arms)if(!a.unavailableReason){files.push(...S.inventory(a.root));if(a.settingsFile)files.push(a.settingsFile);}
        if(m.calibrationEvidence){if(fileHash(m.calibrationEvidence.reportFile)!==m.calibrationEvidence.reportSha256)throw fail('J02_CALIBRATION_CHANGED');files.push(m.calibrationEvidence.reportFile);}
        const identity=S.snapshot(files),environment=validate('environment',S.read(m.environmentFile));
        if(environment.displayId!==0||!environment.serial||!environment.romFingerprint||!environment.apps?.length||!environment.viewport
            ||![0,1,2,3].includes(environment.rotation)||!Array.isArray(environment.stateFiles)
            ||!Number.isInteger(environment.viewport.width)||environment.viewport.width<1||!Number.isInteger(environment.viewport.height)||environment.viewport.height<1)throw fail('J02_ENVIRONMENT_INVALID');
        if(m.tasks.some(t=>!environment.apps.some(a=>a.package===t.start.package)))throw fail('J02_ENVIRONMENT_SCOPE');
        fs.mkdirSync(output);fs.mkdirSync(path.join(output,'private'),{mode:0o700});fs.mkdirSync(path.join(output,'trials'));
        S.write(path.join(output,'private/manifest.json'),m);
        const protocol={schemaVersion:1,batchId:m.batchId,datasetId:m.datasetId,stage:m.stage,nodeVersion:process.version,
            ...(m.benchmark?{benchmarkCoverage:require('./benchmark-adapter.cjs').coverage(m.benchmark.preparedDir,m.tasks.map(t=>t.benchmark.taskId))}:{}),
            manifestSha256:fileHash(path.join(output,'private/manifest.json')),identity,environment,arms,gates:m.gates,auditor:m.auditor,
            partitions,taskHashes:m.tasks.map(t=>({id:t.id,sha256:S.sha(S.canonical(t))})),calibrationEvidence:m.calibrationEvidence,
            execution:{order:'task_major_declared_arm_order',workerReserveMs:180000,
                nativeReserveMs:m.benchmark?Object.values(m.benchmark.timeouts).reduce((a,b)=>a+b,0)+5000:0,
                independentReadMs:15000,adbReadMs:20000,taskRetries:0,modelRetries:0},
            outputs:['journal.jsonl','trials/','report.json','normal.json','recovery.json','escalation.json','recovery_and_escalation.json'],
            schedule:m.tasks.filter(t=>m.stage==='exploration'||t.split===m.stage).flatMap(t=>m.arms.map(a=>({trialId:`t${m.tasks.indexOf(t)}-${a.id}`,taskId:t.id,armId:a.id,
                notRunReason:a.unavailableReason||(a.id==='rules'?t.rulesExclusion:null)})))};
        S.write(path.join(output,'protocol.json'),protocol);
        S.append(m.registry,{event:'frozen',batchId:m.batchId,datasetId:m.datasetId,stage:m.stage,protocolSha256:fileHash(path.join(output,'protocol.json')),partitions});
        S.append(path.join(output,'journal.jsonl'),{event:'frozen',protocolSha256:fileHash(path.join(output,'protocol.json'))});
        return {batchId:m.batchId,planned:protocol.schedule.length,output};
    });
}
function load(output){
    output=path.resolve(output);const p=S.read(path.join(output,'protocol.json')),m=S.read(path.join(output,'private/manifest.json'));
    if(fileHash(path.join(output,'private/manifest.json'))!==p.manifestSha256)throw fail('J02_MANIFEST_CHANGED');
    const registry=S.records(m.registry),anchor=registry.find(r=>r.event==='frozen'&&r.batchId===p.batchId);
    if(!anchor||anchor.protocolSha256!==fileHash(path.join(output,'protocol.json')))throw fail('J02_PROTOCOL_CHANGED');
    const journal=S.records(path.join(output,'journal.jsonl'));
    if(journal[0]?.protocolSha256!==anchor.protocolSha256)throw fail('J02_JOURNAL_INVALID');
    for(const row of journal.filter(r=>['finished','reviewed'].includes(r.event))){
        if(fileHash(path.join(output,row.file))!==row.sha256)throw fail('J02_EVIDENCE_CHANGED');
        if(row.event==='reviewed')for(const e of S.read(path.join(output,row.file)).evidence)if(fileHash(e.file)!==e.sha256)throw fail('J02_EVIDENCE_CHANGED');
        if(row.event==='finished')for(const e of S.read(path.join(output,row.file)).artifacts)if(fileHash(path.join(output,'trials',row.trialId,e.file))!==e.sha256)throw fail('J02_EVIDENCE_CHANGED');
    }
    return{output,p,m,journal,registry};
}
function spawnTrial(state,slot){return new Promise((resolve,reject)=>{
    const child=cp.spawn(process.execPath,[path.join(__dirname,'worker.cjs'),state.output,slot.trialId],{stdio:'ignore',windowsHide:true});
    const task=state.m.tasks.find(t=>t.id===slot.taskId);
    const nativeReserve=state.m.benchmark?Object.values(state.m.benchmark.timeouts).reduce((a,b)=>a+b,0)+5000:0;
    const deadline=setTimeout(()=>{require('./process-tree.cjs').terminate(child);reject(fail('J02_WORKER_DEADLINE_UNKNOWN'));},task.budget.timeoutMs+task.reset.waitMs+180000+nativeReserve);
    child.on('error',()=>{clearTimeout(deadline);reject(fail('J02_WORKER_START_FAILED'));});child.on('close',code=>{
        clearTimeout(deadline);
        const file=path.join(state.output,'trials',slot.trialId,'result.json');
        if(!fs.existsSync(file))reject(fail('J02_WORKER_INTERRUPTED'));else resolve(S.read(file));
    });
});}
async function run(output,{execute=spawnTrial,offline=false}={}){
    output=path.resolve(output);
    return S.locked(path.join(output,'batch.lock'),async()=>{
        const state=load(output),{p,m,journal}=state,file=path.join(output,'journal.jsonl');
        const stop=reason=>{S.append(file,{event:'halted',reason});return{status:'halted',reason};};
        if(journal.some(r=>r.event==='halted'))return{status:'halted',reason:journal.find(r=>r.event==='halted').reason};
        if(!S.unchanged(p.identity)||process.version!==p.nodeVersion)return stop('FROZEN_IDENTITY_CHANGED');
        const inflight=journal.find(r=>r.event==='started'&&!journal.some(e=>e.event==='finished'&&e.trialId===r.trialId));
        if(inflight)return stop('IN_FLIGHT_TRIAL_UNKNOWN');
        const awaiting=journal.find(r=>r.event==='finished'&&!journal.some(e=>e.event==='reviewed'&&e.trialId===r.trialId));
        if(awaiting)return{status:'awaiting_audit',trialId:awaiting.trialId};
        const slot=p.schedule.find(s=>!s.notRunReason&&!journal.some(r=>r.event==='finished'&&r.trialId===s.trialId));
        if(!slot)return{status:'complete'};
        if(p.stage==='acceptance'){
            const blockers=[...new Set(require('./report.cjs').build(state).groups.flatMap(g=>g.blockers)
                .filter(code=>/^(?:CALIBRATION_|BASELINE_UNAVAILABLE|APP_DATA_NOT_FROZEN|PRIOR_VERSION_RISK)/.test(code)))];
            if(blockers.length)return{status:'blocked',blockers};
        }
        const task=m.tasks.find(t=>t.id===slot.taskId);
        try{await S.locked(m.registry+'.lock',async()=>{
            const registry=S.records(m.registry);
            if(p.stage==='acceptance'&&registry.some(r=>r.event==='exposed'&&r.batchId!==p.batchId&&(r.clusterId===task.clusterId||r.workload===workload(task))))throw fail('J02_ACCEPTANCE_ALREADY_EXPOSED');
            // Exposure is durable before any request; a crash cannot make an acceptance sample fresh again.
            S.append(m.registry,{event:'exposed',batchId:p.batchId,stage:p.stage,trialId:slot.trialId,clusterId:task.clusterId,workload:workload(task)});
        });}catch(e){return stop(e.code||'REGISTRY_FAILED');}
        S.append(file,{event:'started',trialId:slot.trialId,offline});
        fs.mkdirSync(path.join(output,'trials',slot.trialId));
        let result;
        try{result=await execute(state,slot);}catch(e){return stop(e.code||'WORKER_FAILED');}
        require('./evidence.cjs').validateResult(result,slot.trialId);
        if(m.benchmark&&(result.benchmark?.suite!==m.benchmark.suite||result.benchmark?.taskId!==task.benchmark.taskId))return stop('BENCHMARK_RESULT_MISSING');
        const rel=`trials/${slot.trialId}/result.json`,destination=path.join(output,rel);
        if(offline){
            if(!fs.existsSync(destination))S.write(destination,result);
            else if(S.canonical(S.read(destination))!==S.canonical(result))return stop('WORKER_RESULT_MISMATCH');
        }
        S.append(file,{event:'finished',trialId:slot.trialId,file:rel,sha256:fileHash(destination),offline});
        if(!S.unchanged(p.identity))return stop('FROZEN_IDENTITY_CHANGED');
        if(result.claimedComplete&&result.independent.verdict==='fail'){
            await S.locked(m.registry+'.lock',async()=>S.append(m.registry,{event:'risk',batchId:p.batchId,family:task.family,offline,
                identity:S.sha(S.canonical(p.arms.find(a=>a.id===slot.armId))),reason:'FALSE_COMPLETION'}));
            return stop('FALSE_COMPLETION');
        }
        if(result.invalidations.length)return stop(result.invalidations[0]);
        if(result.receipts.some(r=>r.outcome==='unknown')||!result.cleanupProven)return stop('TRANSPORT_UNPROVEN');
        const returned=[...new Set([...journal.filter(r=>r.event==='finished'&&p.schedule.find(s=>s.trialId===r.trialId)?.armId===slot.armId)
            .flatMap(r=>S.read(path.join(output,r.file)).models),...result.models].map(m=>m.returnedModel).filter(Boolean))];
        if(returned.length>1)return stop('RETURNED_MODEL_CHANGED');
        return{status:'awaiting_audit',trialId:slot.trialId};
    });
}
async function review(output,reviewFile){return S.locked(path.join(path.resolve(output),'batch.lock'),async()=>{
    const state=load(output),{m,journal}=state,review=validate('review',S.read(reviewFile));
    const trial=journal.find(r=>r.event==='finished'&&r.trialId===review.trialId);
    if(!trial||trial.sha256!==review.trialSha256||review.auditorId!==m.auditor.id||journal.some(r=>r.event==='reviewed'&&r.trialId===review.trialId))throw fail('J02_REVIEW_IDENTITY');
    review.evidence=review.evidence.map(e=>({...e,file:path.resolve(path.dirname(path.resolve(reviewFile)),e.file)}));
    if(review.evidence.some(e=>fileHash(e.file)!==e.sha256))throw fail('J02_REVIEW_EVIDENCE');
    const result=S.read(path.join(state.output,trial.file));
    const writes=result.receipts.filter(r=>r.outcome!=='failed').length;
    if((writes>0||result.counts.actions===null||result.counts.actions>result.receipts.length)&&Object.values(review.risks).includes('not_applicable'))throw fail('J02_REVIEW_DENOMINATOR');
    if(review.writeReviews.length!==writes||review.writeReviews.some((r,i)=>r.index!==i||r.evidence.some(hash=>!review.evidence.some(e=>e.sha256===hash))))throw fail('J02_REVIEW_COVERAGE');
    const dispatch=review.writeReviews.map(r=>r.dispatch),duplicates=review.writeReviews.map(r=>r.duplicate);
    const misdispatch=!writes?'not_applicable':dispatch.includes('wrong')?'incident':dispatch.includes('unknown')?'unknown':'clear';
    const duplicateWrite=!writes?'not_applicable':duplicates.includes(true)?'incident':duplicates.includes(null)?'unknown':'clear';
    if(review.risks.misdispatch!==misdispatch||review.risks.duplicateWrite!==duplicateWrite)throw fail('J02_REVIEW_INCONSISTENT');
    const rel=`trials/${review.trialId}/audit.json`;S.write(path.join(state.output,rel),review);
    S.append(path.join(state.output,'journal.jsonl'),{event:'reviewed',trialId:review.trialId,file:rel,sha256:fileHash(path.join(state.output,rel))});
    if(Object.values(review.risks).includes('incident')){
        const slot=state.p.schedule.find(s=>s.trialId===review.trialId),task=m.tasks.find(t=>t.id===slot.taskId);
        await S.locked(m.registry+'.lock',async()=>S.append(m.registry,{event:'risk',batchId:state.p.batchId,family:task.family,
            offline:!!journal.find(r=>r.event==='started'&&r.trialId===slot.trialId)?.offline,
            identity:S.sha(S.canonical(state.p.arms.find(a=>a.id===slot.armId))),reason:'RISK_INCIDENT'}));
        S.append(path.join(state.output,'journal.jsonl'),{event:'halted',reason:'RISK_INCIDENT'});
    }
    return{trialId:review.trialId,status:'recorded'};
});}
module.exports={freeze,load,run,review,taskSpec,normalize,workload};
