'use strict';
const obj=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const str={type:'string',minLength:1,maxLength:4000},name={type:'string',pattern:'^[A-Za-z][A-Za-z0-9_]*$'};
const port={type:'integer',minimum:1024,maximum:65535},ms={type:'integer',minimum:100,maximum:120000};
const runtimeSchema=obj({version:{const:'public-adapter-v1'},suite:{enum:['androidworld','androidlab']},
    preparedDir:str,checkout:str,pythonPath:str,runtimeIdentityFile:str,assets:{type:'array',items:str,minItems:1,maxItems:256},
    consolePort:port,grpcPort:port,snapshotName:{anyOf:[{type:'string',pattern:'^[A-Za-z0-9_-]{1,80}$'},{type:'null'}]},
    timeouts:obj({initializeMs:ms,scoreMs:ms,cleanupMs:ms})});
const taskSchema=obj({taskId:name,caseFile:str});
const scoreSchema=obj({suite:{enum:['androidworld','androidlab']},taskId:name,
    method:{enum:['native_task','isolated_native_judge_final_state']},setup:{type:'boolean'},cleanup:{type:'boolean'},
    verdict:{enum:['pass','fail','unknown']},score:{anyOf:[{type:'number',minimum:0,maximum:1},{type:'null'}]},
    code:{anyOf:[{type:'string',pattern:'^[A-Z][A-Z0-9_]{0,79}$'},{type:'null'}]}});
module.exports={runtimeSchema,taskSchema,scoreSchema};
