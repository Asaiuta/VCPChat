'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, spec, response } = require('./helpers/android-ui-task-world.cjs');

function choose(s, q, command, label, inputRef) {
    const target = s.elements.find(n => n.label === label);
    const candidate = s.candidates.find(c => c.action.command === command
        && (!label || c.action.nodeRef === target?.nodeRef) && (!inputRef || c.action.inputRef === inputRef));
    assert.ok(candidate, `missing ${command}/${label || ''} on ${s.package}`);
    return response(q, ['Done', 'Back'].includes(command) ? command : candidate.candidateId);
}

// A revisited form uses the same fields, not a freshly reset fixture. Values and
// writes are independently recorded by the injected device across navigation.
for (const loseFirst of [false, true]) test(`multi-page form returns without rewriting verified inputs, loss=${loseFirst}`, async t => {
    let w; const actions = [];
    w = await world({ nodes: s => s.page === 'home' ? [
        { name:'first', noId:true, kind:'EditText', desc:'First' },
        { name:'next', text:'Next' }, { name:'review', text:'Review' }]
        : s.page === 'second' ? [{ name:'second', noId:true, kind:'EditText', desc:'Second' }]
        : [{ name:'first', noId:true, kind:'TextView', desc:'First', clickable:false },
            { name:'second', noId:true, kind:'TextView', desc:'Second', clickable:false }],
        decide(s,q,state) {
            if (state.page === 'review') return choose(s,q,'Done');
            if (state.page === 'second') return w.values.has('second') ? choose(s,q,'Back') : choose(s,q,'Fill','Second','second');
            const field = s.elements.find(n=>n.label==='First');
            if (!field.inputMatches.includes('first')) return choose(s,q,'Fill','First','first');
            return choose(s,q,'Tap',w.values.has('second')?'Review':'Next');
        },
        invoke(method,params,state,values) {
            if (method === 'setText') { const name=state.page==='home'?'first':'second'; actions.push(`fill:${name}`); values.set(name,params[1]); return true; }
            if (method === 'click') { actions.push(params[1]<80?'next':'review'); state.page=params[1]<80?'second':'review'; return true; }
        },
        shell(args,state) { if(args.includes('keyevent')) { actions.push('back'); state.page='home'; if(loseFirst)w.values.set('first','changed by app'); return ''; } }
    }); t.after(w.close);
    const task=spec({ inputs:{first:'north',second:'south'}, operations:['Tap','Fill','Back'],
        completion:{all:['first','second'].map(ref=>({type:'text',text:{selector:{desc:ref==='first'?'First':'Second'},inputRef:ref}}))} });
    const r=(await w.run(task)).details.task;
    assert.equal(r.status,loseFirst?'stopped':'completed',JSON.stringify(r));
    if(loseFirst) { assert.equal(r.code,'TASK_PROGRESS_LOST'); assert.deepEqual(actions,['fill:first','next','fill:second','back']); }
    else { assert.deepEqual(actions,['fill:first','next','fill:second','back','review']); assert.equal(r.counts.actions,5); }
    assert.equal(actions.filter(x=>x==='fill:first').length,1);
    assert.doesNotMatch(JSON.stringify([r,w.events]), /north|south|changed by app/);
});

test('launch another allowed app and return before verified completion', async t => {
    const actions=[]; let w;
    w=await world({ nodes:s=>s.package==='com.example'?[{name:'form',text:s.page==='done'?'Saved':'Start',clickable:s.page!=='done'}]
        :[{name:'remote',noId:true,kind:'EditText',desc:'Reference'}],
        decide(s,q,state) {
            if(s.package==='com.example'&&state.page==='done')return choose(s,q,'Done');
            if(s.package==='other.app'&&!w.values.has('remote'))return choose(s,q,'Fill','Reference','query');
            return choose(s,q,'LaunchApp');
        },
        shell(args,state) { if(args.includes('start')&&args.includes('-n')) { const pkg=args[args.indexOf('-n')+1].split('/')[0]; actions.push('launch:'+pkg); state.package=pkg; if(pkg==='com.example')state.page='done'; return 'OK'; } },
        invoke(method,params,state,values) { if(method==='setText'){actions.push('fill:remote');values.set('remote',params[1]);return true;} }
    });t.after(w.close);
    const r=(await w.run(spec({ allowedPackages:['com.example','other.app'],operations:['LaunchApp','Fill'],
        completion:{all:[{type:'visible',selector:{text:'Saved'}}]} }))).details.task;
    assert.equal(r.status,'completed',JSON.stringify(r));
    assert.deepEqual(actions,['launch:other.app','fill:remote','launch:com.example']);
    assert.equal(r.counts.actions,3);assert.equal(r.counts.mainModelCalls,0);assert.equal(r.counts.humanHandoffs,0);
});

test('returning to the identical page never repeats an accepted action', async t => {
    let w;
    w=await world({nodes:s=>s.page==='home'?[{name:'entry',text:'Open'}]:[{name:'back',text:'Go back'}],
        decide(s,q,state){
            if(state.page!=='home')return choose(s,q,'Back');
            if(w.models.length===1)return choose(s,q,'Tap','Open');
            assert.equal(s.candidates.some(c=>c.action.command==='Tap'),false);
            return response(q,'escalate');
        },invoke(method,params,state){if(method==='click'){state.page='panel';return true;}},
        shell(args,state){if(args.includes('keyevent')){state.page='home';return '';}}
    });t.after(w.close);
    const r=(await w.run(spec({operations:['Tap','Back']}))).details.task;
    assert.equal(r.code,'TASK_ESCALATION_REQUIRED');assert.equal(r.counts.actions,2);assert.equal(w.writes.length,1);
});

for (const lost of [false, true]) test(`ID-less declared input survives assistance page drift, lost=${lost}`, async t => {
    let assisted = false, w;
    w = await world({ nodes: s => s.page === 'home' ? [
        { name:'reference',noId:true,kind:'EditText',desc:'Reference' },
        { name:'next',text:'Next' }, { name:'info',text:`Revision ${s.revision}`,clickable:false }]
        : [{ name:'reference',noId:true,kind:'TextView',desc:'Reference',clickable:false }, {name:'saved',text:'Saved',clickable:false}],
        decide(s,q,state) {
            if (!assisted) return response(q,'escalate');
            return state.page === 'home' ? choose(s,q,'Tap','Next') : choose(s,q,'Done');
        },
        invoke(method,params,state) { if(method==='click'){state.page='review';return true;} },
        services:{humanInteraction:{request:async()=>{
            assisted=true;w.state.revision++;if(lost)w.values.set('reference','changed');return true;
        }}}
    });t.after(w.close);w.values.set('reference','private query 731');
    const r=(await w.run(spec({assistance:'human',operations:['Tap','Fill'],completion:{all:[
        {type:'text',text:{selector:{desc:'Reference'},inputRef:'query'}}, {type:'visible',selector:{text:'Saved'}}]}}))).details.task;
    assert.equal(r.status,lost?'stopped':'completed',JSON.stringify(r));
    if(lost)assert.equal(r.code,'TASK_PROGRESS_LOST');
    assert.equal(w.writes.length,lost?0:1);assert.equal(w.writes.some(x=>x.method==='setText'),false);
    assert.equal(r.counts.humanHandoffs,1);assert.equal(r.counts.mainModelCalls,0);
});

for(const limit of ['success','actions','models','observations'])test(`long navigation obeys the frozen ${limit} boundary`,async t=>{
    let w; const target=12, pages=[];
    w=await world({nodes:s=>[{name:'page'+s.revision,text:s.revision===target?'Finished':`Next ${s.revision}`,clickable:s.revision!==target}],
        decide(s,q,state){
            if(limit==='actions'&&state.revision===11){assert.deepEqual(s.candidates,[]);return response(q,'escalate');}
            return choose(s,q,state.revision===target?'Done':'Tap',state.revision===target?undefined:`Next ${state.revision}`);
        },
        invoke(method,params,state){if(method==='click'){pages.push(state.revision);state.revision++;return true;}}
    });t.after(w.close);
    const budget={timeoutMs:120000,maxActions:limit==='actions'?11:12,maxModelCalls:limit==='models'?12:13,maxObservations:limit==='observations'?20:96};
    const r=(await w.run(spec({operations:['Tap'],inputs:{},budget,completion:{all:[{type:'visible',selector:{text:'Finished'}}]} }))).details.task;
    assert.equal(r.status,limit==='success'?'completed':'stopped',JSON.stringify(r));
    assert.ok(w.writes.length<=budget.maxActions);assert.ok(r.counts.modelCalls<=budget.maxModelCalls);assert.ok(r.counts.observations<=budget.maxObservations);
    assert.deepEqual(pages,Array.from({length:w.writes.length},(_,i)=>i));
    if(limit==='success'){assert.equal(w.state.revision,target);assert.equal(r.counts.actions,target);assert.equal(r.counts.modelCalls,target+1);}
    else if(limit==='models')assert.equal(r.code,'TASK_LOOP_LIMIT');
    else if(limit==='observations')assert.equal(r.code,'TASK_BUDGET_EXHAUSTED');
    else assert.equal(r.code,'TASK_ESCALATION_REQUIRED');
});

for(const fault of ['stale','unknown','cancel'])test(`late ${fault} preserves the accepted long-workflow prefix`,async t=>{
    const controller=new AbortController(),pages=[];let injected=false;
    const w=await world({nodes:s=>[
        {name:`step_${s.revision}`,text:s.revision===12?'Finished':`Next ${s.revision}`,clickable:s.revision!==12},
        {name:'revision',text:injected?'Changed':'Original',clickable:false}],
        decide(s,q,state){
            if(state.revision===8&&!injected){injected=true;if(fault==='cancel')controller.abort();}
            return choose(s,q,state.revision===12?'Done':'Tap',state.revision===12?undefined:`Next ${state.revision}`);
        },
        invoke(method,params,state){if(method==='click'){
            pages.push(state.revision++);
            if(fault==='unknown'&&pages.length===9)throw Object.assign(new Error('lost acknowledgement'),{code:'UI_SERVER_RPC_TIMEOUT'});
            return true;
        }}
    });t.after(w.close);
    let r;
    try{r=(await w.run(spec({operations:['Tap'],inputs:{},budget:{timeoutMs:120000,maxActions:12,maxObservations:128,maxModelCalls:16},
        completion:{all:[{type:'visible',selector:{text:'Finished'}}]}}),{signal:controller.signal})).details.task;}
    catch(e){assert.equal(fault,'cancel');assert.equal(e.code,'STEP_ABORTED');await Promise.all(w.executions);r=w.results.at(-1);}
    const expected=fault==='stale'?12:fault==='unknown'?9:8;
    assert.deepEqual(pages,Array.from({length:expected},(_,i)=>i));
    assert.equal(r.status,fault==='stale'?'completed':'stopped',JSON.stringify(r));
    assert.equal(r.counts.actions,expected);assert.equal(r.counts.mainModelCalls,0);assert.equal(r.counts.humanHandoffs,0);
    if(fault==='stale')assert.equal(r.counts.staleEvents,1);
    if(fault==='unknown'){assert.equal(r.receipts.at(-1).outcome,'unknown');assert.equal(w.models.at(-1).state.recentActions.length,8);}
    if(fault==='cancel')assert.equal(r.code,'STEP_ABORTED');
    assert.ok(['completed','stopped'].includes(w.events.at(-1).type));
});
