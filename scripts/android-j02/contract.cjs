'use strict';
const Ajv = require('ajv');
const obj = (properties, required = Object.keys(properties)) => ({ type:'object', additionalProperties:false, properties, required });
const str = { type:'string', minLength:1, maxLength:4000 };
const name = { type:'string', pattern:'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$' };
const sha = { type:'string', pattern:'^[a-f0-9]{64}$' };
const count = { type:'integer', minimum:0 };
const nullable = schema => ({ anyOf:[schema,{type:'null'}] });
const list = (items, minItems=0, maxItems=10000) => ({type:'array',items,minItems,maxItems});
const choice = values => ({enum:values});
const target = obj({id:str,text:str,desc:str,class:str},[]);
target.minProperties=1;
const textCheck = obj({target,equals:{type:'string',maxLength:2000},normalize:choice(['NFC_trim']),stripPrefix:str},['target','equals']);
const condition = {oneOf:[
    obj({type:choice(['visible','absent']),target}), obj({type:{const:'checked'},target,checked:{type:'boolean'}}),
    obj({type:{const:'text'},...textCheck.properties},['type','target','equals']),
    obj({type:{const:'row'},target,fields:list(textCheck,1,8)})]};
const checker = obj({version:{const:'raw-ui-v1'},package:str,all:list(condition,1,16)});
const budget = obj({timeoutMs:{type:'integer',minimum:1,maximum:300000},maxActions:{type:'integer',minimum:1,maximum:32},
    maxObservations:{type:'integer',minimum:1,maximum:512},maxModelCalls:{type:'integer',minimum:0,maximum:64}});
const model = obj({provider:choice(['typesafe','openrouter']),requestedAlias:str,expectedReturnedVersion:nullable(str),endpointSha256:sha});
const arm = {oneOf:[obj({id:choice(['rules','original','candidate']),unavailableReason:str}),
    obj({id:choice(['rules','original','candidate']),root:str,intent:choice(['search','set_toggle','route_search','ui_task']),
        decision:choice(['rules','jev']),settingsFile:nullable(str),model:nullable(model)})]};
const request = {type:'object'}; // The frozen arm's production prepareTask is the second validation layer.
const task = obj({id:name,family:name,clusterId:name,split:choice(['calibration','acceptance']),
    source:obj({kind:choice(['user_request','existing_workload']),reference:str}),stratum:name,
    start:checker,finish:checker,reset:obj({method:{const:'force_stop_launch'},waitMs:{type:'integer',minimum:0,maximum:10000}}),
    budget,requests:obj({rules:request,original:request,candidate:request},['candidate']),rulesExclusion:nullable(str)});
task.properties.benchmark=require('./benchmark-schema.cjs').taskSchema;
const gates = obj({alpha:{type:'number',exclusiveMinimum:0,maximum:0.05},riskCorrection:choice(['per_metric','bonferroni3']),
    riskUnit:{const:'task'},independence:str,minIndependent:{type:'integer',minimum:1},
    maxRisk:{type:'number',exclusiveMinimum:0,maximum:0.02},minSuccess:{type:'number',minimum:0.9,maximum:1},
    minSuccessLower:{type:'number',minimum:0.8,maximum:1},maxUnknown:{type:'number',minimum:0,maximum:0.05},
    maxEscalation:{type:'number',minimum:0,maximum:0.2},minRecoveryLower:{type:'number',minimum:0.8,maximum:1},
    maxP95Ms:{type:'integer',minimum:1,maximum:300000},requiredStrata:list(name,1,64),requiredFeatures:list(choice(['loading','neutral_candidates','recovery']),0,3)});
const environmentSchema=obj({serial:str,model:str,android:str,romFingerprint:str,displayId:{const:0},rotation:choice([0,1,2,3]),
    viewport:obj({width:{type:'integer',minimum:1},height:{type:'integer',minimum:1}}),
    apps:list(obj({package:str,versionName:str,versionCode:str,apks:list(obj({file:str,sha256:sha}),1,64)}),1,16),
    stateFiles:list(obj({file:str,sha256:sha}),0,128)});
const manifestSchema = {$schema:'http://json-schema.org/draft-07/schema#',...obj({schemaVersion:{const:1},batchId:name,datasetId:name,
    stage:choice(['exploration','calibration','acceptance']),registry:str,environmentFile:str,
    tools:obj({adbPath:str,snapshotJar:str}),arms:list(arm,3,3),tasks:list(task,1,10000),gates,
    auditor:obj({id:name,method:str}),calibrationEvidence:nullable(obj({reportFile:str,reportSha256:sha}))})};
manifestSchema.properties.benchmark=require('./benchmark-schema.cjs').runtimeSchema;
const reviewSchema = obj({schemaVersion:{const:1},trialId:name,trialSha256:sha,auditorId:name,
    risks:obj({misdispatch:choice(['clear','incident','unknown','not_applicable']),duplicateWrite:choice(['clear','incident','unknown','not_applicable'])}),
    recoveryEligible:{type:'boolean'},candidateMiss:nullable({type:'boolean'}),features:obj({loading:choice(['pass','fail','not_exercised']),neutral_candidates:choice(['pass','fail','not_exercised'])}),
    writeReviews:list(obj({index:count,dispatch:choice(['correct','wrong','unknown']),duplicate:nullable({type:'boolean'}),evidence:list(sha,1,100)}),0,96),
    evidence:list(obj({file:str,sha256:sha}),1,100),note:str});
const ajv = new Ajv({allErrors:true});
const validators = {manifest:ajv.compile(manifestSchema),review:ajv.compile(reviewSchema),environment:ajv.compile(environmentSchema)};
function fail(code){return Object.assign(new Error(code),{code});}
function validate(kind,value){if(!validators[kind](value))throw fail('J02_'+kind.toUpperCase()+'_INVALID');return value;}
module.exports={manifestSchema,reviewSchema,environmentSchema,validate,fail};
