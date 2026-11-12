'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const B=require('../scripts/android-j02/batch.cjs'),S=require('../scripts/android-j02/storage.cjs'),R=require('../scripts/android-j02/report.cjs');
const {fixture,task,result,review}=require('./helpers/android-j02-batch.cjs');

test('offline freeze, one-shot execution, independent audit and report preserve missing baselines and unknown usage',async t=>{
    const f=fixture(t);assert.equal((await B.freeze(f.manifestFile,f.output)).planned,3);
    assert.equal((await B.run(f.output,{offline:true,execute:async()=>result()})).status,'awaiting_audit');
    let calls=0;assert.equal((await B.run(f.output,{offline:true,execute:async()=>{calls++;return result();}})).status,'awaiting_audit');assert.equal(calls,0);
    await B.review(f.output,review(f));assert.equal((await B.run(f.output,{offline:true})).status,'complete');
    const report=await R.report(f.output),g=report.groups[0];
    assert.equal(report.calibrated,false);assert.equal(report.offline,true);assert.equal(report.planned,3);
    assert.equal(g.metrics.counts.success,1);assert.equal(g.arms.original.counts.not_run,1);
    assert.ok(g.blockers.includes('BASELINE_UNAVAILABLE'));assert.ok(g.blockers.includes('OFFLINE_EVIDENCE'));
    assert.equal(g.metrics.usage.totalTokens.total,null);assert.equal(g.metrics.usage.totalTokens.knownCalls,0);
    assert.deepEqual(g.metrics.candidateMiss,{numerator:0,denominator:0,unassessable:1});
    assert.doesNotMatch(JSON.stringify(report),/private-one|offline-only|offline test fixture audit/i);
    await assert.rejects(B.freeze(f.manifestFile,path.join(f.dir,'second')),{code:'J02_BATCH_ID_REUSED'});
});

for(const changed of ['source','manifest','protocol','result','audit-evidence'])test(`tampering with ${changed} cannot lead to another execution`,async t=>{
    const f=fixture(t);await B.freeze(f.manifestFile,f.output);
    if(changed==='source'){fs.appendFileSync(f.manifest.tools.adbPath,' changed');const r=await B.run(f.output,{offline:true,execute:async()=>{throw Error('must not run');}});assert.equal(r.reason,'FROZEN_IDENTITY_CHANGED');return;}
    if(changed==='manifest')fs.appendFileSync(path.join(f.output,'private/manifest.json'),' ');
    if(changed==='protocol')fs.appendFileSync(path.join(f.output,'protocol.json'),' ');
    if(['result','audit-evidence'].includes(changed)){
        await B.run(f.output,{offline:true,execute:async()=>result()});
        if(changed==='result')fs.appendFileSync(path.join(f.output,'trials/t0-candidate/result.json'),' ');
        else{await B.review(f.output,review(f));fs.appendFileSync(path.join(f.dir,'t0-candidate-evidence.json'),' ');}
    }
    await assert.rejects(B.run(f.output,{offline:true,execute:async()=>{throw Error('must not run');}}),{code:({manifest:'J02_MANIFEST_CHANGED',protocol:'J02_PROTOCOL_CHANGED',result:'J02_EVIDENCE_CHANGED','audit-evidence':'J02_EVIDENCE_CHANGED'})[changed]});
});

test('interrupted task remains unknown and is never replayed',async t=>{
    const f=fixture(t);await B.freeze(f.manifestFile,f.output);S.append(path.join(f.output,'journal.jsonl'),{event:'started',trialId:'t0-candidate',offline:true});
    const r=await B.run(f.output,{offline:true,execute:async()=>{throw Error('replayed');}});assert.equal(r.reason,'IN_FLIGHT_TRIAL_UNKNOWN');
    const report=await R.report(f.output);assert.equal(report.calibrated,false);assert.ok(report.invalidations.includes('IN_FLIGHT_TRIAL_UNKNOWN'));
});

for(const fault of ['false_completion','misdispatch','unknown_write','model_drift'])test(`${fault} stops the batch and preserves all planned tasks`,async t=>{
    const f=fixture(t);f.manifest.tasks.push(task('two'));f.save();await B.freeze(f.manifestFile,f.output);
    const row=result();if(fault==='false_completion')row.independent.verdict='fail';
    if(fault==='unknown_write')row.receipts=[{outcome:'unknown'}];if(fault==='model_drift')row.invalidations=['RETURNED_MODEL_CHANGED'];
    await B.run(f.output,{offline:true,execute:async()=>row});
    if(fault==='misdispatch')await B.review(f.output,review(f,'t0-candidate',{risks:{misdispatch:'incident',duplicateWrite:'clear'}}));
    const stopped=await B.run(f.output,{offline:true,execute:async()=>{throw Error('should stop');}});assert.equal(stopped.status,'halted');
    const report=await R.report(f.output);assert.equal(report.planned,6);assert.equal(report.groups[0].metrics.counts.not_run,1);assert.equal(report.calibrated,false);
});

test('acceptance exposure survives a crash and renamed batches cannot reuse it',async t=>{
    const f=fixture(t);f.manifest.stage='exploration';f.manifest.tasks=[task('one','acceptance')];f.save();await B.freeze(f.manifestFile,f.output);
    await B.run(f.output,{offline:true,execute:async()=>{throw Object.assign(Error(),{code:'LOST_WORKER'});}});
    f.manifest.batchId='batch-two';f.manifest.stage='acceptance';f.save();await assert.rejects(B.freeze(f.manifestFile,path.join(f.dir,'next')),{code:'J02_ACCEPTANCE_ALREADY_EXPOSED'});
});

test('formal acceptance stays blocked before any exposure when calibration or baseline is missing',async t=>{
    const f=fixture(t);f.manifest.stage='acceptance';f.manifest.tasks=[task('one','acceptance')];f.save();await B.freeze(f.manifestFile,f.output);
    const r=await B.run(f.output,{offline:true,execute:async()=>{throw Error('must not expose acceptance');}});
    assert.equal(r.status,'blocked');assert.ok(r.blockers.includes('CALIBRATION_NOT_ESTABLISHED'));
    assert.equal(S.records(f.manifest.registry).filter(r=>r.event==='exposed').length,0);
});

test('auditor must cover every write and cannot mark an unreviewed dispatch clear',async t=>{
    const f=fixture(t);await B.freeze(f.manifestFile,f.output);await B.run(f.output,{offline:true,execute:async()=>result()});
    const file=review(f,'t0-candidate',{writeReviews:[]});await assert.rejects(B.review(f.output,file),{code:'J02_REVIEW_COVERAGE'});
});

test('split leakage and relabelled identical tasks are rejected before freezing',async t=>{
    const f=fixture(t);f.manifest.tasks.push(task('two','acceptance','one'));f.save();
    await assert.rejects(B.freeze(f.manifestFile,f.output),{code:'J02_SPLIT_LEAK'});
    f.manifest.tasks=[task(),{...task(),id:'renamed',clusterId:'new-cluster'}];f.save();
    await assert.rejects(B.freeze(f.manifestFile,f.output),{code:'J02_CORRELATED_RENAMING'});
});

test('repeated tasks remain descriptive and cannot inflate the independent denominator',async t=>{
    const f=fixture(t);f.manifest.tasks.push({...task(),id:'repeat'});f.save();await B.freeze(f.manifestFile,f.output);
    for(const id of ['t0-candidate','t1-candidate']){await B.run(f.output,{offline:true,execute:async()=>result(id)});await B.review(f.output,review(f,id));}
    const report=await R.report(f.output),m=report.groups[0].metrics;assert.equal(m.planned,2);assert.equal(m.primaryIndependent,1);assert.equal(m.risks.misdispatch.denominator,1);assert.equal(m.allAttempts.success,2);
});

test('recovery denominator includes independently eligible tasks with no attempted recovery',async t=>{
    const f=fixture(t);await B.freeze(f.manifestFile,f.output);
    await B.run(f.output,{offline:true,execute:async()=>result('t0-candidate',{status:'stopped',claimedComplete:false,code:'TASK_STALE_LIMIT',independent:{verdict:'fail',checks:[false]}})});
    await B.review(f.output,review(f,'t0-candidate',{recoveryEligible:true}));const r=await R.report(f.output);
    assert.equal(r.groups[0].metrics.recovery.denominator,1);assert.equal(r.groups[0].metrics.recovery.numerator,0);assert.equal(r.trials.at(-1).path,'recovery');
});

test('persisted journal is hash chained and a partial line is not silently ignored',t=>{
    const f=fixture(t),file=path.join(f.dir,'log.jsonl');S.append(file,{event:'one'});S.append(file,{event:'two'});
    assert.equal(S.records(file).length,2);fs.appendFileSync(file,'{"event":');assert.throws(()=>S.records(file),{code:'J02_JOURNAL_TRUNCATED'});
});

test('CLI refuses live execution without the explicit run mode flag',async()=>{
    await assert.rejects(require('../scripts/android-j02-batch.cjs').main(['run','unused']),{code:'J02_OPTIONS_INVALID'});
});

test('published JSON schemas exactly match runtime contracts',()=>{
    const c=require('../scripts/android-j02/contract.cjs');
    for(const [name,schema] of [['manifest',c.manifestSchema],['review',c.reviewSchema],['environment',c.environmentSchema],
        ['trial',require('../scripts/android-j02/evidence.cjs').resultSchema],['report',require('../scripts/android-j02/report-schema.cjs').reportSchema]])
        assert.deepEqual(require('../docs/android-controller/j02/batch-'+name+'.schema.json'),schema,name);
});
