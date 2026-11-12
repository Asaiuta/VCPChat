'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { world, spec, response } = require('./helpers/android-ui-task-world.cjs');
const { createTaskTraceStore } = require('../modules/services/androidTaskTrace');
const { traceEventLimit } = require('../modules/services/androidTaskBudget');
const { POLICY, LIMITS } = require('../modules/services/androidUiTaskContract');

for (const count of [96, 97]) test(`raw visible element capacity ${count} stops before any write`, async t => {
    const w = await world({ nodes: () => Array.from({ length:count }, (_,i) => ({name:`item_${i}`,text:`Item ${i}`,top:i})),
        decide: (_,q) => response(q,'escalate') });t.after(w.close);
    const r = (await w.run(spec({operations:['Tap']}))).details.task;
    assert.equal(r.code,count===96?'TASK_ESCALATION_REQUIRED':'TASK_CANDIDATE_OVERFLOW',JSON.stringify(r));
    assert.equal(w.models.length,count===96?1:0);assert.equal(w.writes.length,0);
    if(count===96)assert.equal(w.models[0].state.elements.length,96);
});

for (const count of [32, 33]) test(`four-direction candidate capacity ${count*4}`, async t => {
    const w = await world({ nodes: () => Array.from({ length:count }, (_,i) => ({name:`list_${i}`,text:`List ${i}`,top:i*3,scrollable:true})),
        decide: (_,q) => response(q,'escalate') });t.after(w.close);
    const r = (await w.run(spec({operations:['Scroll']}))).details.task;
    assert.equal(r.code,count===32?'TASK_ESCALATION_REQUIRED':'TASK_CANDIDATE_OVERFLOW',JSON.stringify(r));
    assert.equal(w.models.length,count===32?1:0);assert.equal(w.writes.length,0);
    if(count===32)assert.equal(w.models[0].state.candidates.length,128);
});

test('32 dispatched steps retain a complete private JSONL trace and independent terminal state', async t => {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ui-long-trace-'));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));const pages=[];let captures=0;
    const w=await world({traceStore:createTaskTraceStore({directory}),
        onCapture(){captures++;},
        nodes:s=>[{name:`step_${s.revision}`,text:s.revision===32?'Finished':`Next ${s.revision}`,clickable:s.revision!==32}],
        decide(s,q,state){return response(q,state.revision===32?'Done':s.candidates.find(c=>c.action.command==='Tap').candidateId);},
        invoke(method,params,state){if(method==='click'){pages.push(state.revision++);return true;}}
    });t.after(w.close);
    const r=(await w.run(spec({operations:['Tap'],inputs:{},budget:LIMITS,
        completion:{all:[{type:'visible',selector:{text:'Finished'}}]}}))).details.task;
    assert.equal(r.status,'completed',JSON.stringify(r));assert.equal(r.counts.actions,32);assert.equal(r.counts.modelCalls,33);
    assert.deepEqual(pages,Array.from({length:32},(_,i)=>i));
    const data=await fs.readFile(path.join(directory,`${r.taskId}.jsonl`),'utf8'),rows=data.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r=>r.seq),rows.map((_,i)=>i));assert.equal(rows.at(-1).type,'completed');
    assert.equal(rows.filter(r=>r.type==='model').length,33);
    assert.equal(rows.filter(r=>r.type==='action'&&r.phase==='settled').length,32);
    // Budgeted captures include the action executor's own pre-dispatch reads.
    assert.equal(r.counts.observations,captures);
    assert.ok(rows.filter(r=>r.type==='observation').length<captures);
    assert.ok(Buffer.byteLength(data)<=512*1024);assert.doesNotMatch(data,/Next \d|Finished|fieldStates|rawNode/);
});

for(const dense of [false,true])test(`real JSONL store retains terminal at ${dense?'byte':'event'} ceiling`,async t=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ui-cap-trace-'));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const taskId=randomUUID(),observationId=randomUUID();
    const trace=await createTaskTraceStore({directory}).open({schemaVersion:1,taskId,serial:'A',package:'com.example',
        intent:'ui_task',decision:'jev',policyVersion:POLICY.version,completionPolicyVersion:POLICY.completionVersion,
        inputRefs:[],budget:LIMITS,allowedPackages:['com.example'],operations:['Tap','Scroll'],goalSha256:'a'.repeat(64),contractSha256:'b'.repeat(64)});
    t.after(()=>trace.close());
    const maxEvents=traceEventLimit(LIMITS)+LIMITS.maxObservations+3;
    let appended=0,limit;
    try {
        // Exercise every allowed observation and its host wait before decisions.
        for(let i=0;i<512;i++){
            await trace.append({type:'observation',observation:{id:observationId,digest:'c'.repeat(64),contextDigest:'d'.repeat(64),controls:32},
                package:'com.example',pageDigest:'e'.repeat(64),completionMatched:false});appended++;
            await trace.append({type:'wait',source:'host',reason:'loading',observationId,changed:false});appended++;
        }
        for(let round=1;round<=64;round++){
            const candidates=Array.from({length:dense?128:1},(_,i)=>({candidateId:`c${i}`,action:dense
                ?{command:'Scroll',nodeRef:`n${Math.floor(i/4)}`,direction:['up','down','left','right'][i%4]}:{command:'Tap',nodeRef:'n0'}}));
            await trace.append({type:'candidates',observationId,round,candidates,excludedCount:0});appended++;
            await trace.append({type:'model',observationId,modelCalls:round,modelEvidence:{provider:null,requestedModel:null,returnedModel:null,elapsedMs:1,
                usage:{inputTokens:null,outputTokens:null,totalTokens:null}}});appended++;
            await trace.append({type:'decision',observationId,choice:'c0',probability:1,margin:1});appended++;
            if(round<=32){
                const requestId=randomUUID(),action={command:'Tap',nodeRef:'n0'};
                await trace.append({type:'action',phase:'prepared',action});appended++;
                await trace.append({type:'action',phase:'settled',action,requestId,outcome:'dispatched'});appended++;
                await trace.append({type:'effect',requestId,changed:true,pageDigest:'f'.repeat(64)});appended++;
            }
        }
        assert.equal(dense,false,'dense candidates must hit the byte ceiling');
        // Fill remaining ordinary slots with bounded recoveries, then verify the reserve.
        for(;;){await trace.append({type:'recovery',observationId,reason:'observation_stale',consecutive:1});appended++;}
    }catch(e){limit=e;}
    assert.equal(limit?.code,'TRACE_LIMIT',limit?.stack);
    if(dense)assert.ok(appended<maxEvents-1);else assert.equal(appended,maxEvents-1);
    await trace.append({type:'stopped',code:'TASK_TRACE_LIMIT',outcome:'unknown'});await trace.close();
    const data=await fs.readFile(path.join(directory,`${taskId}.jsonl`),'utf8'),rows=data.trim().split('\n').map(JSON.parse);
    assert.ok(Buffer.byteLength(data)<=512*1024);assert.equal(rows.length,appended+2);
    assert.equal(rows.at(-1).type,'stopped');assert.equal(rows.at(-1).code,'TASK_TRACE_LIMIT');
    assert.deepEqual(rows.map(r=>r.seq),rows.map((_,i)=>i));
});
