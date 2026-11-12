'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const B=require('../scripts/android-j02/batch.cjs'),S=require('../scripts/android-j02/storage.cjs');
const {execute}=require('../scripts/android-j02/worker.cjs');const {fixture}=require('./helpers/android-j02-batch.cjs');
test('device identity uses display-zero logical size and rotation, preserving APK and data hashes',()=>{
    const calls=[];let rotation=1;
    const d=require('../scripts/android-j02/device.cjs').device('offline-adb','offline',{spawnSync(_exe,args){
        calls.push(args);const key=args.slice(2).join(' ');let stdout='';
        if(key==='shell dumpsys window displays')stdout=`Display: mDisplayId=0\n  init=100x200 cur=200x100 app=200x100\n  DisplayRotation\n    mRotation=${rotation}\n  mCurrentFocus=Window{a u0 com.example/.Main}\nDisplay: mDisplayId=8\n  cur=99x99 app=99x99\n  mRotation=0\n`;
        else if(key==='shell dumpsys power')stdout='mWakefulness=Awake';
        else if(key==='shell dumpsys window policy')stdout='mKeyguardShowing=false';
        else if(key==='shell dumpsys package com.example')stdout='versionName=1 versionCode=1';
        else if(key==='shell pm path com.example')stdout='package:/data/app/base.apk';
        else if(key.startsWith('shell sha256sum '))stdout='a'.repeat(64)+'  file';
        else if(key.startsWith('shell getprop '))stdout='offline-value';
        else throw Error('unexpected command '+key);
        return{status:0,stdout};
    }});
    const env=d.inspect(['com.example'],['/sdcard/sources.json']);assert.deepEqual(env.viewport,{width:200,height:100});assert.equal(env.rotation,1);
    assert.equal(env.stateFiles.length,1);assert.equal(env.apps[0].apks.length,1);d.gate('com.example',env);
    rotation=0;assert.throws(()=>d.gate('com.example',env),{code:'J02_ENVIRONMENT_CHANGED'});
    assert.equal(calls.some(a=>a.includes('monkey')||a.includes('force-stop')),false);
});
for(const mode of ['success','false-completion','model-drift','environment-drift','cleanup-failed','transport-unknown'])test(`worker ${mode} uses frozen inputs, fresh independent captures and actual returned identity`,async t=>{
    const f=fixture(t);await B.freeze(f.manifestFile,f.output);const state=B.load(f.output),slot=state.p.schedule.at(-1),dir=path.join(f.output,'trials',slot.trialId);fs.mkdirSync(dir);
    let done=false,executor,modelCalls=0,actions=0,cleanups=0,captures=0;
    const xml=()=>`<?xml version="1.0"?><hierarchy><node package="com.example" resource-id="com.example:id/${done?'result':'ready'}" text="${done?(mode==='false-completion'?'wrong':'private-one'):''}" visible-to-user="true" enabled="true" bounds="[0,0][90,90]"/></hierarchy>`;
    const r=await execute(state,slot,{
        device:()=>({executeAdb(){throw Error('unexpected adb');},read(args){assert.ok(['force-stop','monkey'].some(s=>args.includes(s)));return'';},gate(){},
            inspect(){return mode==='environment-drift'?{...f.environment,romFingerprint:'other'}:f.environment;}}),
        reader:()=>({prepare(){},execute(){captures++;return{status:0,stdout:xml()};},cleanup(){cleanups++;return{removed:mode!=='cleanup-failed',processAbsent:true};}}),
        jev:()=>({getStatus:async()=>({configured:true,provider:f.model.provider,model:f.model.requestedAlias,url:'https://offline.invalid'}),
            decide:async()=>{modelCalls++;return{model:mode==='model-drift'?'different-version':'offline-version',usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}};}}),
        executor:({jev})=>({run:async()=>{await jev.decide({},{});}}),
        service:()=>({initialize:async opts=>{executor=opts.services.androidTaskExecutor;},cleanup:async()=>{},processToolCall:async request=>{
            assert.equal(request.task.inputs.query,'private-one');assert.equal(request.task.budget.maxActions,3);
            await executor.run();actions++;done=true;
            fs.mkdirSync(path.join(dir,'traces'));fs.writeFileSync(path.join(dir,'traces','task.jsonl'),JSON.stringify({type:'model',modelEvidence:{provider:f.model.provider,requestedModel:f.model.requestedAlias,returnedModel:'offline-version',usage:{inputTokens:7,outputTokens:3,totalTokens:10}}})+'\n');
            return{details:{task:{taskId:'task',status:'completed',counts:{actions:1,observations:4,modelCalls:1,mainModelCalls:0},receipts:[{outcome:mode==='transport-unknown'?'unknown':'verified'}]},execution:{outcome:'verified'}}};
        }})
    });
    if(mode==='environment-drift'){assert.equal(actions,0);assert.equal(modelCalls,0);assert.ok(r.invalidations.includes('J02_ENVIRONMENT_CHANGED'));}
    else if(mode==='model-drift'){assert.equal(actions,0);assert.equal(modelCalls,1);assert.equal(r.models[0].returnedModel,'different-version');assert.ok(r.invalidations.includes('RETURNED_MODEL_CHANGED'));}
    else{assert.equal(actions,1);assert.equal(modelCalls,1);assert.equal(r.models[0].usage.totalTokens,10);
        assert.equal(r.independent.verdict,mode==='transport-unknown'?'unknown':mode==='false-completion'?'fail':'pass');
        assert.equal(captures,mode==='transport-unknown'?1:2);assert.equal(r.cleanupProven,mode!=='cleanup-failed');}
    assert.doesNotMatch(JSON.stringify(r),/private-one|offline-only/);
    for(const artifact of r.artifacts)assert.equal(S.sha(fs.readFileSync(path.join(dir,artifact.file))),artifact.sha256);
    assert.equal(cleanups,mode==='environment-drift'?0:1);
});
