'use strict';
const {resultSchema}=require('./evidence.cjs');
const obj=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const n={type:'integer',minimum:0},str={type:'string'},bool={type:'boolean'},nullable=s=>({anyOf:[s,{type:'null'}]}),array=items=>({type:'array',items});
const probability=nullable({type:'number',minimum:0,maximum:1});
const rate=obj({numerator:n,denominator:n,estimate:probability,lower:probability,upper:probability});
const outcomes=obj(Object.fromEntries(['success','failed','unknown','refused','escalated','cancelled','not_run'].map(k=>[k,n])));
const risk=obj({...rate.properties,unassessable:n,denominatorDefinition:str});
const models=obj({requested:array(nullable(str)),returned:array(nullable(str))});
const costs=obj(Object.fromEntries(['jevCalls','mainAgentCalls','mainModelRequests','humanHandoffs'].map(k=>[k,obj({knownSum:n,unknownTasks:n,total:nullable(n)})])));
const usage=obj(Object.fromEntries(['inputTokens','outputTokens','totalTokens'].map(k=>[k,obj({knownCalls:n,totalCalls:n,knownSum:n,total:nullable(n)})])));
const timings=obj(Object.fromEntries(['taskMs','resetMs','independentCheckMs','endToEndMs'].map(k=>[k,obj({observed:n,unknown:n,p50:nullable({type:'number',minimum:0}),p95:nullable({type:'number',minimum:0})})])));
const metrics=obj({planned:n,primaryIndependent:n,started:n,counts:outcomes,allAttempts:outcomes,
    risks:obj(Object.fromEntries(['misdispatch','falseCompletion','duplicateWrite'].map(k=>[k,risk]))),success:rate,unknown:rate,escalation:rate,
    refusal:obj({numerator:n,denominator:n,optimizationTarget:{const:false}}),recovery:rate,candidateMiss:obj({numerator:n,denominator:n,unassessable:n}),recoveryEligibilityUnknown:n,costs,usage,timings,models});
const paths=['normal','recovery','escalation','recovery_and_escalation'];
const group=obj({family:str,metrics,features:{type:'object',additionalProperties:rate},arms:obj(Object.fromEntries(['rules','original','candidate'].map(k=>[k,metrics]))),
    paths:obj(Object.fromEntries(paths.map(k=>[k,metrics]))),paired:obj({planned:n,complete:n,
        rows:array(obj({taskId:str,complete:bool,outcomes:{type:'object',additionalProperties:{enum:Object.keys(outcomes.properties)}}})),excluded:array(obj({taskId:str,reason:str}))}),
    blockers:array(str),calibrated:bool,scope:obj({environment:{type:'object'},candidate:{type:'object'},strata:array(str),features:array(str)})});
const trial=obj({trialId:str,taskId:str,armId:{enum:['rules','original','candidate']},notRunReason:nullable(str),family:str,clusterId:str,stratum:str,primary:bool,
    rulesExclusion:nullable(str),outcome:{enum:Object.keys(outcomes.properties)},path:{enum:paths},result:nullable(resultSchema),offline:bool,
    audit:nullable(obj({auditorId:str,risks:obj({misdispatch:{enum:['clear','incident','unknown','not_applicable']},duplicateWrite:{enum:['clear','incident','unknown','not_applicable']}}),
        recoveryEligible:bool,candidateMiss:nullable(bool),features:obj({loading:{enum:['pass','fail','not_exercised']},neutral_candidates:{enum:['pass','fail','not_exercised']}})}))});
const reportSchema={$schema:'http://json-schema.org/draft-07/schema#',...obj({schemaVersion:{const:1},batchId:str,datasetId:str,stage:{enum:['exploration','calibration','acceptance']},
    complete:bool,offline:bool,hasRisk:bool,invalidations:array(str),journalHash:str,candidateIdentity:{type:'object'},protocolSha256:str,
    method:obj({confidence:{const:'one-sided Clopper-Pearson'},alpha:{type:'number'},riskCorrection:{enum:['per_metric','bonferroni3']},unit:str,repeatedTasks:str,percentiles:{const:'nearest-rank'},sequentialPromotion:{const:false}}),
    planned:n,calibrated:bool,groups:array(group),trials:array(trial)})};
reportSchema.properties.publicBenchmark=obj({suite:{enum:['androidworld','androidlab']},
    comparison:{const:'adapted_exploration_not_official_leaderboard'},independentSamples:{const:0},
    coverage:obj({format:{const:'j02-public-adapter-coverage-v1'},suite:{enum:['androidworld','androidlab']},sourceRevision:str,
        calibrated:{const:false},independentAcceptanceSamples:{const:0},
        selected:array(obj({taskId:str,adapterSupported:bool,status:{enum:['bound_not_run','not_run']},reason:nullable(str)})),
        notSelected:array(obj({taskId:str,reason:str}))}),
    scores:obj(Object.fromEntries(['rules','original','candidate'].map(k=>[k,obj({pass:n,fail:n,unknown:n,not_run:n})])))});
module.exports={reportSchema};
