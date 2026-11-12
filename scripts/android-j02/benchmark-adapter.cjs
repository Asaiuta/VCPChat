'use strict';
const fs=require('node:fs'),path=require('node:path');
const S=require('./storage.cjs'),P=require('./benchmark.cjs'),{fail}=require('./contract.cjs');
const {invoke}=require('./benchmark-process.cjs');
const supported={androidworld:['SystemWifiTurnOn','SystemBluetoothTurnOff','ContactsNewContactDraft','ContactsAddContact',
    'MarkorCreateNote','SimpleCalendarAddOneEvent','OsmAndMarker'],androidlab:['setting_7','setting_3','clock_1','map_12']};
const blocked={contacts_2:'UPSTREAM_GOAL_ORACLE_CONFLICT',map_1:'ANSWER_AND_JUDGE_CHANNEL_REQUIRED'};
function preparation(directory){
    const catalog=S.read(path.join(directory,'catalog.json')),selection=S.read(path.join(directory,'selection.json'));
    const identity=S.read(path.join(directory,'identity.json'));
    for(const name of ['catalog.json','selection.json','preflight.json']){
        const entry=identity.find(x=>x.file===path.resolve(directory,name));
        if(!entry||entry.sha256!==S.sha(fs.readFileSync(entry.file)))throw fail('J02_BENCHMARK_PREPARATION_CHANGED');
    }
    P.verifyCheckout(catalog.suite,catalog.source.checkout);
    if(S.canonical(P.inventory(catalog.source.checkout))!==S.canonical(catalog.source.availableFiles))throw fail('J02_BENCHMARK_SOURCE_CHANGED');
    P.validateSelection(selection,catalog.suite,catalog.tasks);
    return{catalog,selection};
}
function coverage(directory,bound=[]){
    const {catalog,selection}=preparation(path.resolve(directory));
    return{format:'j02-public-adapter-coverage-v1',suite:catalog.suite,sourceRevision:catalog.source.revision,
        calibrated:false,independentAcceptanceSamples:0,
        selected:selection.taskIds.map(id=>({taskId:id,adapterSupported:supported[catalog.suite].includes(id),
            status:bound.includes(id)?'bound_not_run':'not_run',reason:bound.includes(id)?null:blocked[id]||
                (supported[catalog.suite].includes(id)?'ENVIRONMENT_AND_TASK_BINDING_REQUIRED':'TASK_OUTSIDE_ADAPTER_SCOPE')})),
        notSelected:catalog.tasks.filter(t=>!selection.taskIds.includes(t.id)).map(t=>({taskId:t.id,reason:'outside_initial_feasibility_selection'}))};
}
function runtime(suite,python,output){
    if(!supported[suite])throw fail('J02_BENCHMARK_SUITE');
    const identity=invoke(path.resolve(python),'runtime',{suite});
    S.write(path.resolve(output),identity);
    return{output:path.resolve(output),isolated:identity.isolated,missing:identity.missing,executionReady:false};
}
function materialize(directory,taskId,seed,python,output){
    const {catalog,selection}=preparation(path.resolve(directory));
    if(!selection.taskIds.includes(taskId)||!supported[catalog.suite].includes(taskId))throw fail('J02_'+(blocked[taskId]||'TASK_OUTSIDE_ADAPTER_SCOPE'));
    seed=Number(seed);if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw fail('J02_BENCHMARK_SEED');
    const task=catalog.tasks.find(t=>t.id===taskId);
    const value=invoke(path.resolve(python),'materialize',{suite:catalog.suite,checkout:catalog.source.checkout,taskId,seed,goal:task.goalTemplate});
    const result={format:'j02-public-case-v1',suite:catalog.suite,sourceRevision:catalog.source.revision,
        taskId,...value};
    validateCase(result,catalog,taskId);
    S.write(path.resolve(output),result);return{output:path.resolve(output),taskId,status:'materialized_not_run'};
}
function validateCase(value,catalog,taskId){
    const keys=['format','suite','sourceRevision','taskId','goal','params','seed'];
    if(!value||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k))
        ||value.format!=='j02-public-case-v1'||value.suite!==catalog.suite||value.sourceRevision!==catalog.source.revision||value.taskId!==taskId
        ||typeof value.goal!=='string'||!value.goal.trim()||value.goal.length>4000||!value.params||Array.isArray(value.params)||typeof value.params!=='object'
        ||!Number.isInteger(value.seed)||value.seed<0||value.seed>0xffffffff)throw fail('J02_BENCHMARK_CASE_INVALID');
    if(catalog.suite==='androidlab'&&(value.goal!==catalog.tasks.find(t=>t.id===taskId)?.goalTemplate||Object.keys(value.params).length))throw fail('J02_BENCHMARK_GOAL_CHANGED');
    if(catalog.suite==='androidworld'){
        if(value.params.seed!==value.seed)throw fail('J02_BENCHMARK_SEED');
        const schema=catalog.tasks.find(t=>t.id===taskId)?.parameterSchema;
        if(schema&&!new(require('ajv'))().compile(schema)(value.params))throw fail('J02_BENCHMARK_PARAMETERS');
    }
}
function normalize(m,base){
    if(!m.benchmark){if(m.tasks.some(t=>t.benchmark))throw fail('J02_BENCHMARK_RUNTIME_REQUIRED');return;}
    if(m.stage!=='exploration')throw fail('J02_BENCHMARK_EXPLORATION_ONLY');
    const b=m.benchmark;
    for(const k of ['preparedDir','checkout','pythonPath','runtimeIdentityFile'])b[k]=path.resolve(base,b[k]);
    b.assets=b.assets.map(file=>path.resolve(base,file));
    const {catalog,selection}=preparation(b.preparedDir);
    if(catalog.suite!==b.suite||path.resolve(catalog.source.checkout)!==b.checkout)throw fail('J02_BENCHMARK_SOURCE_CHANGED');
    const environment=S.read(m.environmentFile);
    if(environment.serial!==`emulator-${b.consolePort}`||b.consolePort%2!==0)throw fail('J02_BENCHMARK_EMULATOR_REQUIRED');
    if(b.suite==='androidworld'&&(environment.android!=='13'||b.snapshotName!==null))throw fail('J02_BENCHMARK_ENVIRONMENT');
    if(b.suite==='androidlab'&&!b.snapshotName)throw fail('J02_BENCHMARK_SNAPSHOT_REQUIRED');
    const lock=S.read(b.runtimeIdentityFile);
    if(lock.format!=='j02-python-runtime-v1'||lock.suite!==b.suite||!lock.isolated||lock.missing?.length!==0
        ||path.resolve(lock.pythonPath)!==b.pythonPath||!Array.isArray(lock.files)||!lock.files.length||!S.unchanged(lock.files))throw fail('J02_BENCHMARK_RUNTIME_UNPROVEN');
    const keys=new Set();
    for(const t of m.tasks){
        if(!t.benchmark)throw fail('J02_BENCHMARK_TASK_REQUIRED');
        const id=t.benchmark.taskId;
        if(!selection.taskIds.includes(id)||!supported[b.suite].includes(id))throw fail('J02_'+(blocked[id]||'TASK_OUTSIDE_ADAPTER_SCOPE'));
        t.benchmark.caseFile=path.resolve(base,t.benchmark.caseFile);
        const value=S.read(t.benchmark.caseFile);validateCase(value,catalog,id);
        const task=catalog.tasks.find(t=>t.id===id);
        if(t.clusterId!==`${b.suite}.${id}`||t.family!==`${b.suite}.${id}`||t.source.kind!=='existing_workload'
            ||task.packages.length!==1||task.packages[0]!==t.start.package)throw fail('J02_BENCHMARK_TASK_BINDING');
        for(const a of m.arms){
            if(a.unavailableReason||a.id==='rules'&&t.rulesExclusion)continue;
            if(a.intent!=='ui_task'||t.requests[a.id]?.goal!==value.goal)throw fail('J02_BENCHMARK_GOAL_CHANGED');
        }
        const key=id+'/'+S.sha(S.canonical(value.params));
        if(keys.has(key))throw fail('J02_BENCHMARK_CASE_DUPLICATE');keys.add(key);
    }
}
function files(m){
    if(!m.benchmark)return[];
    const b=m.benchmark,{catalog}=preparation(b.preparedDir);
    return[b.runtimeIdentityFile,b.pythonPath,...b.assets,...S.read(b.runtimeIdentityFile).files.map(f=>f.file),
        ...['catalog.json','selection.json','preflight.json','identity.json'].map(f=>path.join(b.preparedDir,f)),
        ...catalog.source.availableFiles.map(f=>path.join(b.checkout,f.file)),...m.tasks.map(t=>t.benchmark.caseFile)];
}
function bind(manifestFile,output){
    manifestFile=path.resolve(manifestFile);output=path.resolve(output);
    const m=require('./batch.cjs').normalize(S.read(manifestFile),path.dirname(manifestFile));
    if(!m.benchmark)throw fail('J02_BENCHMARK_RUNTIME_REQUIRED');
    // Validate asset paths/bytes now, as well as when the concrete batch is frozen.
    S.snapshot(files(m));
    const c=coverage(m.benchmark.preparedDir,m.tasks.map(t=>t.benchmark.taskId));
    fs.mkdirSync(output);S.write(path.join(output,'manifest.json'),m);S.write(path.join(output,'coverage.json'),c);
    return{output,status:'bound_not_frozen',calibrated:false,selected:c.selected};
}
module.exports={normalize,files,coverage,runtime,materialize,bind,preparation,validateCase,supported,blocked};
