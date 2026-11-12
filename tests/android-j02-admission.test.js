'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const S=require('../scripts/android-j02/storage.cjs'),{build}=require('../scripts/android-j02/report.cjs');
const {fixture,task,result}=require('./helpers/android-j02-batch.cjs');
// Synthetic evidence only, passed directly to the pure report evaluator. It is
// never ingested as a live trial or a registered calibration certificate.
function stateFor(t,n){
    const f=fixture(t);fs.mkdirSync(f.output);const m=f.manifest;m.stage='acceptance';m.tasks=Array.from({length:n},(_,i)=>task('sample'+i,'acceptance'));
    m.tasks.forEach(t=>{t.rulesExclusion=null;});
    const candidate={id:'candidate',decision:'jev',intent:'ui_task',policy:{version:'candidate-v1'},model:f.model,sourceSha256:'a'.repeat(64)};
    const arms=[{id:'rules',decision:'rules',model:null},{...candidate,id:'original',policy:{version:'original-v1'}},candidate];
    const calibration={batchId:'fit',datasetId:m.datasetId,stage:'calibration',complete:true,offline:false,hasRisk:false,invalidations:[],candidateIdentity:candidate,groups:[{family:'book-search',scope:{environment:f.environment}}]};
    const cal=f.file('fit-report.json',calibration),calSha=S.sha(fs.readFileSync(cal));m.calibrationEvidence={reportFile:cal,reportSha256:calSha};
    const journal=[{event:'frozen',hash:'a'.repeat(64)}],schedule=[];
    for(let i=0;i<n;i++)for(const arm of arms){
        const trialId=`t${i}-${arm.id}`,file=trialId+'.json',auditFile=trialId+'-audit.json';
        const r=result(trialId);if(arm.id==='rules'){r.counts.jevCalls=0;r.models=[];}
        S.write(path.join(f.output,file),r);S.write(path.join(f.output,auditFile),{auditorId:'reviewer',risks:{misdispatch:'clear',duplicateWrite:'clear'},recoveryEligible:false,candidateMiss:false,features:{loading:'not_exercised',neutral_candidates:'not_exercised'}});
        schedule.push({trialId,taskId:'sample'+i,armId:arm.id,notRunReason:null});
        journal.push({event:'started',trialId,offline:false},{event:'finished',trialId,file},{event:'reviewed',trialId,file:auditFile});
    }
    return{output:f.output,m,p:{stage:'acceptance',batchId:m.batchId,datasetId:m.datasetId,arms,schedule,identity:[],environment:f.environment},journal,
        registry:[{event:'scored',batchId:'fit',reportSha256:calSha}],f};
}
function evaluate(state){S.write(path.join(state.output,'protocol.json'),state.p,false);return build(state);}
test('149 independent tasks can pass a scoped gate while 30 and 148 cannot',t=>{
    for(const n of [30,148,149]){const state=stateFor(t,n),r=evaluate(state);assert.equal(r.calibrated,n===149,JSON.stringify(r.groups[0].blockers));
        assert.equal(r.groups[0].metrics.risks.misdispatch.denominator,n);assert.equal(r.groups[0].paired.complete,n);}
});
test('three simultaneous risk claims use Bonferroni and require 203 rather than 149',t=>{
    for(const n of [149,202,203]){const state=stateFor(t,n);state.m.gates.riskCorrection='bonferroni3';assert.equal(evaluate(state).calibrated,n===203);}
});
for(const gap of ['review','model','baseline','normal-main','calibration','repeat','prior-risk','offline'])test(`apparently successful tasks cannot bypass ${gap}`,t=>{
    const state=stateFor(t,149),candidate=state.p.arms.find(a=>a.id==='candidate');
    if(gap==='review')state.journal=state.journal.filter(r=>!(r.event==='reviewed'&&r.trialId==='t0-candidate'));
    if(gap==='model'||gap==='normal-main'){
        const file=path.join(state.output,'t0-candidate.json'),r=S.read(file);
        if(gap==='model')r.models[0].returnedModel=null;else r.counts.mainModelRequests=1;S.write(file,r,false);
    }
    if(gap==='baseline')state.p.arms[1]={id:'original',unavailableReason:'NOT_FROZEN'};
    if(gap==='calibration')state.registry=[];
    if(gap==='repeat')state.m.tasks.forEach(t=>{t.clusterId='one-correlated-cluster';});
    if(gap==='prior-risk')state.registry.push({event:'risk',offline:false,family:'book-search',identity:S.sha(S.canonical(candidate))});
    if(gap==='offline')state.journal.find(r=>r.event==='started').offline=true;
    assert.equal(evaluate(state).calibrated,false);
});
test('a search qualification is not inherited by a second task family',t=>{
    const state=stateFor(t,150);state.m.tasks.at(-1).family='toggle';const r=evaluate(state);
    assert.equal(r.groups.find(g=>g.family==='book-search').calibrated,true);assert.equal(r.groups.find(g=>g.family==='toggle').calibrated,false);assert.equal(r.calibrated,false);
});
test('normal, recovery and escalation totals are mutually exclusive while eligibility is independent',t=>{
    const state=stateFor(t,149),file=path.join(state.output,'t0-candidate.json'),r=S.read(file);r.recoveryAttempted=true;r.escalationRequested=true;S.write(file,r,false);
    const auditFile=path.join(state.output,'t0-candidate-audit.json'),audit=S.read(auditFile);audit.recoveryEligible=true;S.write(auditFile,audit,false);
    const g=evaluate(state).groups[0];assert.equal(g.paths.normal.planned,148);assert.equal(g.paths.recovery_and_escalation.planned,1);
    assert.equal(g.metrics.recovery.denominator,1);assert.equal(g.metrics.escalation.denominator,149);
});

test('proven undispatched failure is excluded from write risk; unknown dispatch stays unassessable',t=>{
    const state=stateFor(t,2);
    for(const [i,outcome] of [[0,'failed'],[1,'unknown']]){
        const file=path.join(state.output,`t${i}-candidate.json`),r=S.read(file);r.status='stopped';r.claimedComplete=false;r.receipts=[{outcome}];
        r.independent={verdict:'unknown',checks:[]};S.write(file,r,false);
        const auditFile=path.join(state.output,`t${i}-candidate-audit.json`),a=S.read(auditFile);
        a.risks={misdispatch:i?'unknown':'not_applicable',duplicateWrite:i?'unknown':'not_applicable'};S.write(auditFile,a,false);
    }
    const risk=evaluate(state).groups[0].metrics.risks.misdispatch;assert.equal(risk.denominator,0);assert.equal(risk.unassessable,1);
});
