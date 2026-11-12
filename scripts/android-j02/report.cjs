'use strict';
const path=require('node:path'),fs=require('node:fs');
const S=require('./storage.cjs'),{load}=require('./batch.cjs'),{outcome,validateResult}=require('./evidence.cjs');
const {rate,percentile}=require('./statistics.cjs');
const OUTCOMES=['success','failed','unknown','refused','escalated','cancelled','not_run'];
const RISK=['misdispatch','falseCompletion','duplicateWrite'];
function summarize(rows,gates){
    const primary=rows.filter(r=>r.primary),started=primary.filter(r=>r.result?.started);
    const counts=Object.fromEntries(OUTCOMES.map(k=>[k,primary.filter(r=>r.outcome===k).length]));
    const risks={};
    for(const risk of RISK){
        const eligible=primary.filter(r=>risk==='falseCompletion'?r.result?.claimedComplete:r.result?.started
            &&(r.result.counts.actions===null||r.result.receipts.some(receipt=>receipt.outcome!=='failed')||r.result.counts.actions>r.result.receipts.length));
        const value=r=>risk==='falseCompletion'?r.result.independent.verdict==='unknown'?'unknown':r.result.independent.verdict==='fail'?'incident':'clear':r.audit?.risks[risk]||'unknown';
        const unknown=eligible.filter(r=>!['clear','incident'].includes(value(r))).length;
        const k=eligible.filter(r=>value(r)==='incident').length,n=eligible.length-unknown;
        risks[risk]={...rate(k,n,gates.alpha/(gates.riskCorrection==='bonferroni3'?3:1)),unassessable:unknown,
            denominatorDefinition:risk==='falseCompletion'?'primary independent tasks claiming completion with independent verdict':'primary independent tasks with dispatched write opportunity and complete independent audit'};
    }
    const recovery=primary.filter(r=>r.audit?.recoveryEligible===true),escalation=started.filter(r=>r.result.escalationRequested);
    const costs={};for(const k of ['jevCalls','mainAgentCalls','mainModelRequests','humanHandoffs']){
        const values=rows.filter(r=>r.result?.started).map(r=>r.result.counts[k]);
        costs[k]={knownSum:values.filter(Number.isFinite).reduce((a,b)=>a+b,0),unknownTasks:values.filter(v=>v===null).length,total:values.every(Number.isFinite)?values.reduce((a,b)=>a+b,0):null};
    }
    const models=rows.flatMap(r=>r.result?.models||[]),usage={};
    const missingModelAccounting=rows.some(r=>r.result?.started&&(r.result.counts.jevCalls===null||r.result.counts.jevCalls!==r.result.models.length||r.result.counts.mainModelRequests!==0));
    for(const k of ['inputTokens','outputTokens','totalTokens']){
        const values=models.map(m=>m.usage[k]);usage[k]={knownCalls:values.filter(Number.isFinite).length,totalCalls:values.length,
            knownSum:values.filter(Number.isFinite).reduce((a,b)=>a+b,0),total:!missingModelAccounting&&values.every(Number.isFinite)?values.reduce((a,b)=>a+b,0):null};
    }
    const timings={};for(const k of ['taskMs','resetMs','independentCheckMs','endToEndMs']){
        const values=rows.filter(r=>r.result?.started).map(r=>r.result.timings[k]);timings[k]={observed:values.filter(Number.isFinite).length,unknown:values.filter(v=>v===null).length,
            p50:percentile(values,0.5),p95:percentile(values,0.95)};
    }
    return{planned:rows.length,primaryIndependent:primary.length,started:started.length,counts,
        allAttempts: Object.fromEntries(OUTCOMES.map(k=>[k,rows.filter(r=>r.outcome===k).length])),risks,
        success:rate(counts.success,primary.length,gates.alpha),unknown:rate(started.filter(r=>r.result.independent.verdict==='unknown'||r.result.receipts.some(x=>x.outcome==='unknown')).length,primary.length,gates.alpha),
        escalation:rate(escalation.length,started.length,gates.alpha),refusal:{numerator:counts.refused,denominator:started.length,optimizationTarget:false},
        recovery:rate(recovery.filter(r=>r.outcome==='success').length,recovery.length,gates.alpha),
        candidateMiss:{numerator:started.filter(r=>r.audit?.candidateMiss===true).length,denominator:started.filter(r=>typeof r.audit?.candidateMiss==='boolean').length,
            unassessable:started.filter(r=>typeof r.audit?.candidateMiss!=='boolean').length},
        recoveryEligibilityUnknown:started.filter(r=>!r.audit).length,costs,usage,timings,
        models:{requested:[...new Set(models.map(m=>m.requestedModel))],returned:[...new Set(models.map(m=>m.returnedModel))]}};
}
function build(state){
    const {p,m,journal,output}=state,seen=new Set();
    const rows=p.schedule.map(slot=>{
        const task=m.tasks.find(t=>t.id===slot.taskId),end=journal.find(r=>r.event==='finished'&&r.trialId===slot.trialId),review=journal.find(r=>r.event==='reviewed'&&r.trialId===slot.trialId);
        let result=end?validateResult(S.read(path.join(output,end.file)),slot.trialId):null;
        if(!result&&journal.some(r=>r.event==='started'&&r.trialId===slot.trialId))result={schemaVersion:1,trialId:slot.trialId,started:true,status:'stopped',code:'J02_INTERRUPTED',claimedComplete:false,
            independent:{verdict:'unknown',checks:[]},counts:{actions:null,observations:null,jevCalls:null,mainAgentCalls:null,mainModelRequests:null,humanHandoffs:null},
            receipts:[{outcome:'unknown'}],models:[],recoveryAttempted:false,escalationRequested:false,timings:{taskMs:null,resetMs:null,independentCheckMs:null,endToEndMs:null},
            invalidations:['IN_FLIGHT_TRIAL_UNKNOWN'],cleanupProven:false,artifacts:[]};
        const audit=review?S.read(path.join(output,review.file)):null;
        const key=task.family+'/'+task.clusterId+'/'+slot.armId,primary=!m.benchmark&&!seen.has(key);seen.add(key);
        const recovered=audit?.recoveryEligible===true||result?.recoveryAttempted===true,escalated=result?.escalationRequested===true;
        return{...slot,family:task.family,clusterId:task.clusterId,stratum:task.stratum,primary,rulesExclusion:task.rulesExclusion,
            outcome:outcome(result),path:recovered&&escalated?'recovery_and_escalation':recovered?'recovery':escalated?'escalation':'normal',result,audit,
            offline:!!journal.find(r=>r.event==='started'&&r.trialId===slot.trialId)?.offline,
            notRunReason:slot.notRunReason||(!result?journal.find(r=>r.event==='halted')?.reason||'PENDING':null)};
    });
    const hasRisk=rows.some(r=>Object.values(r.audit?.risks||{}).includes('incident')||r.result?.claimedComplete&&r.result.independent.verdict==='fail');
    const invalidations=[...new Set([...journal.filter(r=>r.event==='halted').map(r=>r.reason),...rows.flatMap(r=>r.result?.invalidations||[])])];
    if(!S.unchanged(p.identity))invalidations.push('FROZEN_IDENTITY_CHANGED');
    const offline=rows.some(r=>r.offline),complete=p.schedule.every(s=>s.notRunReason||rows.find(r=>r.trialId===s.trialId)?.audit);
    const calibration=m.calibrationEvidence?S.read(m.calibrationEvidence.reportFile):null;
    const calibrationAnchor=calibration&&state.registry.find(r=>r.event==='scored'&&r.batchId===calibration.batchId&&r.reportSha256===m.calibrationEvidence.reportSha256);
    const groups=[];
    for(const family of [...new Set(rows.map(r=>r.family))]){
        const familyRows=rows.filter(r=>r.family===family),candidate=familyRows.filter(r=>r.armId==='candidate');
        const metrics=summarize(candidate,m.gates),blockers=[];
        const add=(condition,reason)=>{if(condition)blockers.push(reason);};
        add(p.stage!=='acceptance','NOT_ACCEPTANCE');add(!!m.benchmark,'PUBLIC_BENCHMARK_EXPLORATION_ONLY');add(offline,'OFFLINE_EVIDENCE');add(!complete,'BATCH_INCOMPLETE');
        add(invalidations.length>0,'BATCH_HALTED_OR_INVALID');add(hasRisk,'RISK_INCIDENT');
        add(!calibrationAnchor||calibration?.stage!=='calibration'||!calibration?.complete||calibration?.offline||calibration?.hasRisk||calibration?.invalidations?.length,'CALIBRATION_NOT_ESTABLISHED');
        add(calibration?.datasetId!==p.datasetId||S.canonical(calibration?.groups?.find(g=>g.family===family)?.scope?.environment)!==S.canonical(p.environment),'CALIBRATION_SCOPE_MISMATCH');
        const identity=p.arms.find(a=>a.id==='candidate');
        add(state.registry.some(r=>r.event==='risk'&&!r.offline&&r.family===family&&r.identity===S.sha(S.canonical(identity))),'PRIOR_VERSION_RISK');
        add(S.canonical(calibration?.candidateIdentity)!==S.canonical(identity),'CALIBRATION_POLICY_MISMATCH');
        add(!calibration?.groups?.some(g=>g.family===family),'CALIBRATION_FAMILY_MISSING');
        add(metrics.primaryIndependent<m.gates.minIndependent,'INSUFFICIENT_INDEPENDENT_TASKS');
        for(const risk of RISK){const v=metrics.risks[risk];add(v.numerator>0||v.unassessable>0||v.upper===null||v.upper>=m.gates.maxRisk,'RISK_GATE_'+risk.toUpperCase());}
        add(metrics.success.estimate===null||metrics.success.estimate<m.gates.minSuccess||metrics.success.lower<m.gates.minSuccessLower,'SUCCESS_GATE');
        add(metrics.unknown.upper===null||metrics.unknown.upper>m.gates.maxUnknown,'UNKNOWN_GATE');
        add(metrics.escalation.upper===null||metrics.escalation.upper>m.gates.maxEscalation,'ESCALATION_GATE');
        add(candidate.some(r=>r.outcome==='not_run'||r.outcome==='cancelled'),'INCOMPLETE_TASKS');
        add(candidate.some(r=>r.path==='normal'&&r.result?.started&&(r.result.counts.mainAgentCalls!==0||r.result.counts.mainModelRequests!==0||r.result.counts.humanHandoffs!==0)),'NORMAL_PATH_ASSISTANCE');
        add(metrics.timings.taskMs.p95===null||metrics.timings.taskMs.p95>m.gates.maxP95Ms||metrics.timings.taskMs.unknown>0,'LATENCY_GATE');
        add(p.arms.some(a=>a.unavailableReason&&(a.id!=='rules'||candidate.some(r=>!r.rulesExclusion))),'BASELINE_UNAVAILABLE');
        add(familyRows.some(r=>r.armId!=='candidate'&&!r.rulesExclusion&&r.outcome==='not_run'),'BASELINE_INCOMPLETE');
        add(!p.environment.stateFiles?.length,'APP_DATA_NOT_FROZEN');
        add(familyRows.some(r=>{
            const arm=p.arms.find(a=>a.id===r.armId);if(arm.decision!=='jev'||!r.result?.started)return false;
            return !arm.model?.expectedReturnedVersion||r.result.counts.jevCalls===null||r.result.counts.jevCalls!==r.result.models.length
                ||r.result.models.some(model=>model.provider!==arm.model.provider||model.requestedModel!==arm.model.requestedAlias||model.returnedModel!==arm.model.expectedReturnedVersion);
        }),'MODEL_IDENTITY_UNPROVEN');
        for(const stratum of m.gates.requiredStrata)add(!candidate.some(r=>r.primary&&r.stratum===stratum&&r.result?.started),'STRATUM_MISSING_'+stratum);
        const features={};for(const feature of m.gates.requiredFeatures){
            if(feature==='recovery'){features[feature]=metrics.recovery;add(metrics.recovery.lower===null||metrics.recovery.lower<m.gates.minRecoveryLower,'RECOVERY_GATE');}
            else {const samples=candidate.filter(r=>r.primary&&r.audit?.features[feature]!=='not_exercised'&&r.audit?.features[feature]);
                features[feature]=rate(samples.filter(r=>r.audit.features[feature]==='pass').length,samples.length,m.gates.alpha);
                add(features[feature].lower===null||features[feature].lower<m.gates.minSuccessLower,'FEATURE_GATE_'+feature.toUpperCase());}
        }
        const pairs=[];for(const r of candidate.filter(r=>r.primary&&!r.rulesExclusion)){
            const pair=['rules','original','candidate'].map(armId=>familyRows.find(x=>x.taskId===r.taskId&&x.armId===armId));
            pairs.push({taskId:r.taskId,complete:pair.every(x=>x?.result?.started),outcomes:Object.fromEntries(pair.filter(Boolean).map(x=>[x.armId,x.outcome]))});
        }
        groups.push({family,metrics,features,arms:Object.fromEntries(['rules','original','candidate'].map(a=>[a,summarize(familyRows.filter(r=>r.armId===a),m.gates)])),
            paths:Object.fromEntries(['normal','recovery','escalation','recovery_and_escalation'].map(p=>[p,summarize(candidate.filter(r=>r.path===p),m.gates)])),
            paired:{planned:pairs.length,complete:pairs.filter(p=>p.complete).length,rows:pairs,excluded:candidate.filter(r=>r.rulesExclusion).map(r=>({taskId:r.taskId,reason:r.rulesExclusion}))},
            blockers,calibrated:blockers.length===0,scope:{environment:p.environment,candidate:identity,strata:m.gates.requiredStrata,features:m.gates.requiredFeatures}});
    }
    const publicBenchmark=m.benchmark?{
        suite:m.benchmark.suite,comparison:'adapted_exploration_not_official_leaderboard',independentSamples:0,
        coverage:p.benchmarkCoverage,
        scores:Object.fromEntries(['rules','original','candidate'].map(armId=>{
            const counts={pass:0,fail:0,unknown:0,not_run:0};
            for(const entry of p.benchmarkCoverage.selected){
                const trials=rows.filter(r=>r.armId===armId&&m.tasks.find(t=>t.id===r.taskId).benchmark.taskId===entry.taskId);
                if(!trials.length)counts.not_run++;
                for(const trial of trials)counts[trial.result?.started?trial.result.benchmark?.verdict||'unknown':'not_run']++;
            }
            return[armId,counts];
        }))
    }:null;
    return{schemaVersion:1,batchId:p.batchId,datasetId:p.datasetId,stage:p.stage,complete,offline,hasRisk,invalidations,
        ...(publicBenchmark?{publicBenchmark}:{}),
        journalHash:journal.at(-1).hash,candidateIdentity:p.arms.find(a=>a.id==='candidate'),
        protocolSha256:S.sha(fs.readFileSync(path.join(output,'protocol.json'))),
        method:{confidence:'one-sided Clopper-Pearson',alpha:m.gates.alpha,riskCorrection:m.gates.riskCorrection,unit:m.benchmark?'public templates are descriptive only; independence not established':'predeclared first task per independent cluster per arm',
            repeatedTasks:'descriptive only; any incident still halts promotion',percentiles:'nearest-rank',sequentialPromotion:false},
        planned:rows.length,calibrated:groups.length>0&&groups.every(g=>g.calibrated),groups,
        trials:rows.map(({audit,...r})=>({...r,audit:audit?{auditorId:audit.auditorId,risks:audit.risks,recoveryEligible:audit.recoveryEligible,candidateMiss:audit.candidateMiss,features:audit.features}:null}))};
}
async function report(output){return S.locked(path.join(path.resolve(output),'batch.lock'),async()=>{
    const state=load(output),result=build(state);
    const valid=new(require('ajv'))({allErrors:true}).compile(require('./report-schema.cjs').reportSchema);
    if(!valid(result))throw require('./contract.cjs').fail('J02_REPORT_INVALID');
    S.write(path.join(state.output,'report.json'),result,false);
    for(const bucket of ['normal','recovery','escalation','recovery_and_escalation'])S.write(path.join(state.output,bucket+'.json'),
        {batchId:result.batchId,path:bucket,trials:result.trials.filter(t=>t.path===bucket)},false);
    await S.locked(state.m.registry+'.lock',async()=>{S.append(state.m.registry,{event:'scored',batchId:result.batchId,stage:result.stage,
        reportSha256:S.sha(fs.readFileSync(path.join(state.output,'report.json'))),journalHash:result.journalHash});});
    return result;
});}
module.exports={build,summarize,report};
