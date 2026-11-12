'use strict';
const Ajv=require('ajv');
const {fail}=require('./contract.cjs');
const obj=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const num={type:'number',minimum:0},count={type:'integer',minimum:0},nullable=s=>({anyOf:[s,{type:'null'}]});
const code=nullable({type:'string',pattern:'^[A-Z][A-Z0-9_]{0,79}$'});
const counts=['actions','observations','jevCalls','mainAgentCalls','mainModelRequests','humanHandoffs'];
const resultSchema=obj({schemaVersion:{const:1},trialId:{type:'string'},started:{type:'boolean'},
    status:{enum:['completed','stopped','unverified','not_run']},code,claimedComplete:{type:'boolean'},
    independent:obj({verdict:{enum:['pass','fail','unknown']},checks:{type:'array',items:{type:'boolean'}}}),
    counts:obj(Object.fromEntries(counts.map(k=>[k,nullable(count)]))),
    receipts:{type:'array',items:obj({outcome:{enum:['verified','dispatched','unknown','failed']}})},
    models:{type:'array',items:obj({provider:nullable({type:'string'}),requestedModel:nullable({type:'string'}),returnedModel:nullable({type:'string'}),
        usage:obj(Object.fromEntries(['inputTokens','outputTokens','totalTokens'].map(k=>[k,nullable(count)])))})},
    recoveryAttempted:{type:'boolean'},escalationRequested:{type:'boolean'},
    timings:obj(Object.fromEntries(['taskMs','resetMs','independentCheckMs','endToEndMs'].map(k=>[k,nullable(num)]))),
    invalidations:{type:'array',items:{type:'string',pattern:'^[A-Z][A-Z0-9_]{0,79}$'}},cleanupProven:{type:'boolean'},
    artifacts:{type:'array',items:obj({file:{type:'string',pattern:'^[a-zA-Z0-9_.-]+$'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}})}});
resultSchema.properties.benchmark=require('./benchmark-schema.cjs').scoreSchema;
const valid=new Ajv({allErrors:true}).compile(resultSchema);
function validateResult(value,id){
    if(!valid(value)||value.trialId!==id)throw fail('J02_TRIAL_INVALID');
    if(value.claimedComplete!==(value.status==='completed')||!value.started&&(value.status!=='not_run'||value.receipts.length||value.models.length))throw fail('J02_TRIAL_INVALID');
    if(value.counts.jevCalls!==null&&value.models.length>value.counts.jevCalls)throw fail('J02_TRIAL_INVALID');
    if(value.counts.actions!==null&&value.receipts.filter(r=>r.outcome!=='failed').length>value.counts.actions)throw fail('J02_TRIAL_INVALID');
    if(value.benchmark){const b=value.benchmark;if(b.verdict==='unknown'&&b.score!==null||b.verdict==='pass'&&b.score!==1
        ||b.verdict==='fail'&&(b.score===null||b.score>=1)||b.verdict!=='unknown'&&!b.setup)throw fail('J02_TRIAL_INVALID');}
    return value;
}
function outcome(r){
    if(!r)return'not_run';if(!r.started)return'not_run';
    if(/ABORT|CANCEL/.test(r.code||''))return'cancelled';
    if(r.receipts.some(x=>x.outcome==='unknown'))return'unknown';
    if(r.claimedComplete&&r.independent.verdict==='pass'&&!r.invalidations.length&&r.cleanupProven&&(!r.benchmark||r.benchmark.verdict==='pass'&&r.benchmark.cleanup))return'success';
    if(r.escalationRequested)return'escalated';
    if(/UNCERTAIN|UNSAFE|POLICY|TARGET|PREEXIST|INVALID/.test(r.code||''))return'refused';
    if(r.independent.verdict==='unknown'||r.benchmark?.verdict==='unknown')return'unknown';return'failed';
}
module.exports={resultSchema,validateResult,outcome};
