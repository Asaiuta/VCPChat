'use strict';
const cp=require('node:child_process'),path=require('node:path');
const {fail}=require('./contract.cjs');
const script=path.join(__dirname,'benchmark_bridge.py');
function invoke(python,command,value){
    const r=cp.spawnSync(python,['-I','-B',script,command],{input:JSON.stringify(value)+'\n',encoding:'utf8',
        windowsHide:true,timeout:120000,maxBuffer:32*1024*1024});
    if(r.error||r.status!==0)throw fail('J02_BENCHMARK_'+command.toUpperCase()+'_FAILED');
    try{return JSON.parse(r.stdout);}catch{throw fail('J02_BRIDGE_PROTOCOL');}
}
function createBridge(runtime,{spawn=cp.spawn}={}){
    const child=spawn(runtime.pythonPath,['-I','-B',script,'serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let pending=null,buffer='',dead=false,seq=0,stderrBytes=0,exitResult=null;
    const exited=new Promise(resolve=>{
        child.once('close',(code,signal)=>{exitResult={code,signal};dead=true;rejectPending('J02_BRIDGE_EXIT_UNKNOWN');resolve(exitResult);});
    });
    function rejectPending(code){if(pending){clearTimeout(pending.timer);pending.reject(fail(code));pending=null;}}
    function poison(code){dead=true;rejectPending(code);require('./process-tree.cjs').terminate(child);}
    child.on('error',()=>poison('J02_BRIDGE_START_FAILED'));
    child.stdin.on('error',()=>poison('J02_BRIDGE_PIPE_FAILED'));
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>2*1024*1024)poison('J02_BRIDGE_OUTPUT_LIMIT');});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
        buffer+=chunk;
        if(Buffer.byteLength(buffer)>8*1024*1024)return poison('J02_BRIDGE_OUTPUT_LIMIT');
        let nl;
        while((nl=buffer.indexOf('\n'))>=0){
            const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);
            let reply;try{reply=JSON.parse(line);}catch{return poison('J02_BRIDGE_PROTOCOL');}
            if(!pending||reply.id!==pending.id||typeof reply.ok!=='boolean')return poison('J02_BRIDGE_PROTOCOL');
            const p=pending;pending=null;clearTimeout(p.timer);
            if(reply.ok)p.resolve(reply.result);
            else p.reject(fail(/^[A-Z][A-Z0-9_]{0,70}$/.test(reply.code||'')?'J02_'+reply.code:'J02_BRIDGE_FAILED'));
        }
    });
    const request=(op,payload,timeout)=>new Promise((resolve,reject)=>{
        if(dead||pending)return reject(fail('J02_BRIDGE_UNAVAILABLE'));
        const id=++seq,timer=setTimeout(()=>poison('J02_BRIDGE_DEADLINE_UNKNOWN'),timeout);
        pending={id,timer,resolve,reject};child.stdin.write(JSON.stringify({id,op,...payload})+'\n');
    });
    return {
        abort:()=>poison('J02_BRIDGE_ABORTED'),
        initialize:payload=>request('initialize',payload,runtime.timeouts.initializeMs),
        score:evidence=>request('score',{evidence},runtime.timeouts.scoreMs),
        async cleanup(){
            if(dead)throw fail('J02_BRIDGE_CLEANUP_UNPROVEN');
            try{
                const result=await request('cleanup',{},runtime.timeouts.cleanupMs);
                if(result?.clean!==true)throw fail('J02_BRIDGE_CLEANUP_UNPROVEN');
                child.stdin.end();
                let timer;
                const exit=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>{poison('J02_BRIDGE_EXIT_UNKNOWN');reject(fail('J02_BRIDGE_EXIT_UNKNOWN'));},2000);})]).finally(()=>clearTimeout(timer));
                if(exit.code!==0||exit.signal||buffer)throw fail('J02_BRIDGE_CLEANUP_UNPROVEN');
                return true;
            }catch(e){if(!exitResult)require('./process-tree.cjs').terminate(child);throw e;}
        }
    };
}
module.exports={invoke,createBridge};
