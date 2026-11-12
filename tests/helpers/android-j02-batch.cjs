'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const S=require('../../scripts/android-j02/storage.cjs');
const root=path.resolve(__dirname,'../..');
function task(id='one',split='calibration',clusterId=id){
    const input='private-'+id,condition={type:'visible',target:{id:'com.example:id/ready'}};
    return{id,family:'book-search',clusterId,split,source:{kind:'user_request',reference:'offline test fixture'},stratum:'search',
        start:{version:'raw-ui-v1',package:'com.example',all:[condition]},
        finish:{version:'raw-ui-v1',package:'com.example',all:[{type:'text',target:{id:'com.example:id/result'},equals:input}]},
        reset:{method:'force_stop_launch',waitMs:0},budget:{timeoutMs:120000,maxActions:3,maxObservations:96,maxModelCalls:8},
        requests:{candidate:{package:'com.example',goal:'Find the supplied result',inputs:{query:input},operations:['Tap','Fill'],
            completion:{all:[{type:'visible',id:'com.example:id/result'}]}}},rulesExclusion:'No fair fixed rules binding in this offline fixture'};
}
function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'j02-batch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const file=(name,value)=>{const f=path.join(dir,name);S.write(f,value);return f;};
    const environment={serial:'offline',model:'offline-phone',android:'17',romFingerprint:'offline-rom',displayId:0,rotation:0,viewport:{width:100,height:200},
        apps:[{package:'com.example',versionCode:'1',versionName:'1',apks:[{file:'/data/app/offline.apk',sha256:'a'.repeat(64)}]}],
        stateFiles:[{file:'/sdcard/sources.json',sha256:'b'.repeat(64)}]};
    const environmentFile=file('environment.json',environment),settingsFile=file('settings.json',{jevEnabled:true,jevModel:'offline-alias',jevApiKey:'offline-only'});
    const adb=path.join(dir,'offline-adb'),jar=path.join(dir,'offline.jar');fs.writeFileSync(adb,'not executable');fs.writeFileSync(jar,'not a jar');
    const model={provider:'typesafe',requestedAlias:'offline-alias',expectedReturnedVersion:'offline-version',endpointSha256:S.sha('https://offline.invalid')};
    const manifest={schemaVersion:1,batchId:'batch-one',datasetId:'dataset-one',stage:'calibration',registry:path.join(dir,'registry.jsonl'),environmentFile,
        tools:{adbPath:adb,snapshotJar:jar},arms:[{id:'rules',unavailableReason:'RULES_NOT_BOUND'},{id:'original',unavailableReason:'BASELINE_NOT_FROZEN'},
            {id:'candidate',root,intent:'ui_task',decision:'jev',settingsFile,model}],tasks:[task()],
        gates:{alpha:0.05,riskCorrection:'per_metric',riskUnit:'task',independence:'predeclared independent user sessions; offline fixture only',minIndependent:149,
            maxRisk:0.02,minSuccess:0.9,minSuccessLower:0.8,maxUnknown:0.05,maxEscalation:0.2,minRecoveryLower:0.8,maxP95Ms:120000,
            requiredStrata:['search'],requiredFeatures:[]},auditor:{id:'independent-reviewer',method:'review all dispatched writes against raw evidence'},calibrationEvidence:null};
    const manifestFile=file('manifest.json',manifest),output=path.join(dir,'batch');
    return{dir,file,manifest,manifestFile,output,environment,model,save(){S.write(manifestFile,manifest,false);}};
}
function result(id='t0-candidate',patch={}){return{schemaVersion:1,trialId:id,started:true,status:'completed',code:null,claimedComplete:true,
    independent:{verdict:'pass',checks:[true]},counts:{actions:1,observations:5,jevCalls:1,mainAgentCalls:0,mainModelRequests:0,humanHandoffs:0},
    receipts:[{outcome:'verified'}],models:[{provider:'typesafe',requestedModel:'offline-alias',returnedModel:'offline-version',usage:{inputTokens:null,outputTokens:null,totalTokens:null}}],
    recoveryAttempted:false,escalationRequested:false,timings:{taskMs:123,resetMs:1,independentCheckMs:2,endToEndMs:126},invalidations:[],cleanupProven:true,artifacts:[],...patch};}
function review(f,trialId='t0-candidate',patch={}){
    const resultFile=path.join(f.output,'trials',trialId,'result.json'),evidence=f.file(trialId+'-evidence.json',{source:'independent offline oracle',writes:['correct-target-once']});
    const risk=patch.risks||{misdispatch:'clear',duplicateWrite:'clear'};
    return f.file(trialId+'-review.json',{schemaVersion:1,trialId,trialSha256:S.sha(fs.readFileSync(resultFile)),auditorId:f.manifest.auditor.id,
        risks:{misdispatch:'clear',duplicateWrite:'clear'},recoveryEligible:false,candidateMiss:null,features:{loading:'not_exercised',neutral_candidates:'not_exercised'},
        writeReviews:[{index:0,dispatch:risk.misdispatch==='incident'?'wrong':risk.misdispatch==='unknown'?'unknown':'correct',
            duplicate:risk.duplicateWrite==='incident'?true:risk.duplicateWrite==='unknown'?null:false,evidence:[S.sha(fs.readFileSync(evidence))]}],
        evidence:[{file:evidence,sha256:S.sha(fs.readFileSync(evidence))}],note:'Offline test fixture audit',...patch});
}
module.exports={fixture,task,result,review};
