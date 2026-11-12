'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const S=require('../scripts/android-j02/storage.cjs'),B=require('../scripts/android-j02/batch.cjs');
const P=require('../scripts/android-j02/benchmark.cjs'),A=require('../scripts/android-j02/benchmark-adapter.cjs');
const {execute}=require('../scripts/android-j02/worker.cjs');
const {fixture,review}=require('./helpers/android-j02-batch.cjs');
function adapterFixture(t){
    const f=fixture(t),suite='androidlab',source=require('../scripts/android-j02/benchmark-sources.json')[suite];
    f.manifest.stage='exploration';
    f.environment.serial='emulator-5554';f.environment.android='13';f.environment.apps[0].package='com.android.settings';
    S.write(f.manifest.environmentFile,f.environment,false);
    const checkout=path.join(f.dir,'upstream');fs.mkdirSync(checkout);fs.writeFileSync(path.join(checkout,'task.py'),'# isolated offline fixture\n');
    const inventory=()=>[{file:'task.py',sha256:S.sha(fs.readFileSync(path.join(checkout,'task.py')))}];
    t.mock.method(P,'verifyCheckout',()=>source);t.mock.method(P,'inventory',inventory);
    const preparedDir=path.join(f.dir,'prepared');fs.mkdirSync(preparedDir);
    const catalog={suite,source:{...source,checkout,availableFiles:inventory()},tasks:[
        {id:'setting_3',packages:['com.android.settings'],goalTemplate:'Turn off my bluetooth'},
        {id:'contacts_2',packages:['com.google.android.contacts'],goalTemplate:'upstream conflict'},
        {id:'map_1',packages:['com.mapswithme.maps.pro'],goalTemplate:'query'}]};
    S.write(path.join(preparedDir,'catalog.json'),catalog);
    S.write(path.join(preparedDir,'selection.json'),{schemaVersion:1,suite,sourceRevision:source.revision,purpose:'Offline integration fixture',taskIds:catalog.tasks.map(x=>x.id)});
    S.write(path.join(preparedDir,'preflight.json'),{executionReady:false});
    S.write(path.join(preparedDir,'identity.json'),S.snapshot(['catalog.json','selection.json','preflight.json'].map(n=>path.join(preparedDir,n))));
    const python=f.file('not-python.json',{offline:true}),runtimeIdentityFile=f.file('runtime.json',{
        format:'j02-python-runtime-v1',suite,pythonPath:python,isolated:true,missing:[],files:S.snapshot([python])});
    const taskCase={format:'j02-public-case-v1',suite,sourceRevision:source.revision,taskId:'setting_3',goal:catalog.tasks[0].goalTemplate,params:{},seed:1};
    const caseFile=f.file('case.json',taskCase),asset=f.file('image.json',{offline:'immutable fixture only'});
    f.manifest.benchmark={version:'public-adapter-v1',suite,preparedDir,checkout,pythonPath:python,runtimeIdentityFile,assets:[asset],
        consolePort:5554,grpcPort:8554,snapshotName:'frozen',timeouts:{initializeMs:1000,scoreMs:1000,cleanupMs:1000}};
    f.manifest.tasks[0]=JSON.parse(JSON.stringify(f.manifest.tasks[0]).replaceAll('com.example','com.android.settings'));
    const task=f.manifest.tasks[0];task.family=task.clusterId='androidlab.setting_3';task.source.kind='existing_workload';
    task.start.package=task.finish.package=task.requests.candidate.package='com.android.settings';task.requests.candidate.goal=taskCase.goal;
    task.benchmark={taskId:'setting_3',caseFile};f.save();
    return{...f,taskCase,catalog,caseFile,asset};
}
test('compiler preserves selection, freezes native assets and parameters, and refuses promotion',async t=>{
    const f=adapterFixture(t),bound=path.join(f.dir,'bound');
    const compiled=A.bind(f.manifestFile,bound);
    assert.equal(compiled.calibrated,false);assert.equal(compiled.selected.length,3);
    assert.equal(compiled.selected[1].reason,'UPSTREAM_GOAL_ORACLE_CONFLICT');
    assert.equal(compiled.selected[2].reason,'ANSWER_AND_JUDGE_CHANNEL_REQUIRED');
    await B.freeze(path.join(bound,'manifest.json'),f.output);
    const state=B.load(f.output);
    for(const file of [f.caseFile,f.asset,path.join(f.manifest.benchmark.checkout,'task.py'),path.resolve('scripts/android-j02/benchmark_native.py')]){
        assert.ok(state.p.identity.some(row=>row.file===file));
    }
    const report=await require('../scripts/android-j02/report.cjs').report(f.output);
    assert.deepEqual(report.publicBenchmark.scores.candidate,{pass:0,fail:0,unknown:0,not_run:3});
    assert.equal(report.groups[0].metrics.primaryIndependent,0);assert.equal(report.calibrated,false);
    f.manifest.stage='acceptance';assert.throws(()=>B.normalize(f.manifest,f.dir),{code:'J02_BENCHMARK_EXPLORATION_ONLY'});
});
for(const mode of ['goal','cluster','unsupported','runtime','source','case','physical'])test(`binding rejects ${mode} before any execution`,t=>{
    const f=adapterFixture(t),m=f.manifest;
    if(mode==='goal')m.tasks[0].requests.candidate.goal='Different goal';
    if(mode==='cluster')m.tasks[0].clusterId='pretend-independent';
    if(mode==='unsupported')m.tasks[0].benchmark.taskId='contacts_2';
    if(mode==='runtime')fs.appendFileSync(m.benchmark.pythonPath,'drift');
    if(mode==='source')fs.appendFileSync(path.join(m.benchmark.checkout,'task.py'),'# drift');
    if(mode==='case'){const c=S.read(f.caseFile);c.goal='Different goal';S.write(f.caseFile,c,false);}
    if(mode==='physical'){f.environment.serial='PJZ110';S.write(m.environmentFile,f.environment,false);}
    assert.throws(()=>B.normalize(m,f.dir));
});
test('identity drift halts the batch before a worker can run',async t=>{
    const f=adapterFixture(t);await B.freeze(f.manifestFile,f.output);
    fs.appendFileSync(f.asset,'drift');let calls=0;
    const r=await B.run(f.output,{offline:true,execute:()=>{calls++;}});
    assert.equal(r.reason,'FROZEN_IDENTITY_CHANGED');assert.equal(calls,0);
});

function workerDependencies(f,dir,mode,events){
    let done=false;
    const xml=()=>`<?xml version="1.0"?><hierarchy><node package="com.android.settings" resource-id="com.android.settings:id/${done?'result':'ready'}" text="${done?(mode==='independent-fail'?'wrong':'private-one'):''}" visible-to-user="true" enabled="true" bounds="[0,0][90,90]"/></hierarchy>`;
    return{
        device:()=>({executeAdb(){throw Error('no real adb');},read(args){events.push('launch');assert.ok(args.includes('monkey'));return'';},gate(){},inspect:()=>f.environment}),
        reader:()=>({prepare(){events.push('reader');},execute(){events.push(done?'capture-final':'capture-start');return{status:0,stdout:xml()};},cleanup(){events.push('reader-cleanup');return{removed:true,processAbsent:true};}}),
        bridge:()=>({async initialize(payload){events.push('initialize');assert.deepEqual(payload.case,f.taskCase);if(mode==='init-fail')throw Object.assign(Error(),{code:'J02_NATIVE_SETUP_UNPROVEN'});return{goal:f.taskCase.goal};},
            async score(evidence){events.push('score');assert.ok(fs.existsSync(evidence.xmlFile));if(['score-error','cancelled-score-error'].includes(mode))throw Object.assign(Error(),{code:'J02_NATIVE_ADAPTER_FAILED'});
                return{verdict:mode==='native-fail'?'fail':'pass',score:mode==='native-fail'?0:1,details:{complete:mode!=='native-fail'}};},
            async cleanup(){events.push('native-cleanup');if(mode==='cleanup-fail')throw Object.assign(Error(),{code:'J02_BRIDGE_CLEANUP_UNPROVEN'});return true;}}),
        jev:()=>({getStatus:async()=>({configured:true,provider:f.model.provider,model:f.model.requestedAlias,url:'https://offline.invalid'}),decide:async()=>{throw Error('no model call allowed');}}),
        executor:()=>({}),
        service:()=>({initialize:async()=>{},cleanup:async()=>{events.push('service-cleanup');},processToolCall:async request=>{
            events.push('RunTask');assert.equal(request.command,'RunTask');assert.equal(request.task.goal,f.taskCase.goal);
            done=true;fs.mkdirSync(path.join(dir,'traces'));fs.writeFileSync(path.join(dir,'traces','task.jsonl'),JSON.stringify({type:'fixture'})+'\n');
            return{details:{task:{taskId:'task',status:mode==='cancelled-score-error'?'stopped':'completed',code:mode==='cancelled-score-error'?'TASK_CANCELLED':null,
                counts:{actions:1,observations:3,modelCalls:0,mainModelCalls:0},receipts:[{outcome:'verified'}]},execution:{outcome:'verified'}}};
        }})
    };
}
for(const mode of ['success','independent-fail','native-fail','init-fail','score-error','cleanup-fail','cancelled-score-error'])test(`offline worker lifecycle: ${mode}`,async t=>{
    const f=adapterFixture(t);await B.freeze(f.manifestFile,f.output);const events=[];
    const run=await B.run(f.output,{offline:true,execute:async(state,slot)=>{
        const dir=path.join(f.output,'trials',slot.trialId);
        return execute(state,slot,workerDependencies(f,dir,mode,events));
    }});
    const trial=S.read(path.join(f.output,'trials/t0-candidate/result.json'));
    assert.ok(events.includes('native-cleanup'));
    if(mode==='init-fail'){assert.equal(trial.started,false);assert.equal(events.includes('RunTask'),false);}
    else{assert.ok(events.indexOf('capture-final')<events.indexOf('score'),JSON.stringify({events,trial}));assert.ok(events.indexOf('service-cleanup')<events.indexOf('score'));
        assert.equal(trial.independent.verdict,mode==='independent-fail'?'fail':'pass');}
    assert.equal(trial.benchmark.verdict,['init-fail','score-error','cancelled-score-error'].includes(mode)?'unknown':mode==='native-fail'?'fail':'pass');
    assert.equal(require('../scripts/android-j02/evidence.cjs').outcome(trial),({success:'success','independent-fail':'failed','native-fail':'failed','init-fail':'not_run','score-error':'unknown','cleanup-fail':'failed','cancelled-score-error':'cancelled'})[mode]);
    if(mode==='cancelled-score-error'){assert.equal(trial.code,'TASK_CANCELLED');assert.equal(trial.benchmark.code,'J02_NATIVE_ADAPTER_FAILED');}
    assert.equal(run.status,['independent-fail','cleanup-fail'].includes(mode)?'halted':'awaiting_audit');
    if(mode==='success'){
        await B.review(f.output,review(f));
        const report=await require('../scripts/android-j02/report.cjs').report(f.output);
        assert.equal(report.offline,true);assert.equal(report.calibrated,false);
        assert.deepEqual(report.publicBenchmark.scores.candidate,{pass:1,fail:0,unknown:0,not_run:2});
        assert.equal(report.trials.at(-1).result.benchmark.cleanup,true);
    }
});

function fakeChild(responder){
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{setImmediate(()=>child.emit('close',null,'SIGTERM'));return true;};
    child.stdin=new Writable({write(chunk,_encoding,callback){const request=JSON.parse(chunk);callback();responder(request,child);}});
    return child;
}
for(const mode of ['normal','malformed','wrong-id','exit','timeout'])test(`bridge subprocess protocol: ${mode}`,async()=>{
    const runtime={pythonPath:'not-executed',timeouts:{initializeMs:100,scoreMs:100,cleanupMs:100}};
    let requests=0;
    const bridge=require('../scripts/android-j02/benchmark-process.cjs').createBridge(runtime,{spawn:()=>fakeChild((q,c)=>{
        requests++;
        if(mode==='timeout')return;
        if(mode==='exit'){c.emit('close',1,null);return;}
        c.stdout.write(mode==='malformed'?'not json\n':JSON.stringify({id:mode==='wrong-id'?99:q.id,ok:true,result:q.op==='cleanup'?{clean:true}:{goal:'frozen'}})+'\n');
        if(q.op==='cleanup')setImmediate(()=>c.emit('close',0,null));
    })});
    if(mode==='normal'){assert.deepEqual(await bridge.initialize({}),{goal:'frozen'});assert.equal(await bridge.cleanup(),true);assert.equal(requests,2);}
    else{await assert.rejects(bridge.initialize({}));await assert.rejects(bridge.initialize({}));await assert.rejects(bridge.cleanup());assert.equal(requests,1);}
});
test('real Python bridge rejects out-of-order score and exits after cleanup without device or model access',
    {skip:!process.env.J02_BENCHMARK_PYTHON},async()=>{
        const bridge=require('../scripts/android-j02/benchmark-process.cjs').createBridge({pythonPath:process.env.J02_BENCHMARK_PYTHON,
            timeouts:{initializeMs:5000,scoreMs:5000,cleanupMs:5000}});
        await assert.rejects(bridge.score({xmlFile:'never-read'}),{code:'J02_BRIDGE_PHASE_INVALID'});
        assert.equal(await bridge.cleanup(),true);
    });
