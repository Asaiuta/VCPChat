'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {fail}=require('./contract.cjs');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sha=v=>createHash('sha256').update(v).digest('hex');
function read(file){const bytes=fs.readFileSync(file);if(bytes.length>32*1024*1024)throw fail('J02_FILE_LIMIT');return JSON.parse(bytes);}
function write(file,value,exclusive=true){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:exclusive?'wx':'w',mode:0o600});}
function records(file){
    if(!fs.existsSync(file))return[];
    const bytes=fs.readFileSync(file,'utf8');if(bytes&&!bytes.endsWith('\n'))throw fail('J02_JOURNAL_TRUNCATED');
    let previous='0'.repeat(64);
    return bytes.split('\n').filter(Boolean).map((line,seq)=>{
        let row;try{row=JSON.parse(line);}catch{throw fail('J02_JOURNAL_INVALID');}
        const {hash,...data}=row;if(data.seq!==seq||data.previous!==previous||hash!==sha(canonical(data)))throw fail('J02_JOURNAL_INVALID');
        previous=hash;return row;
    });
}
function append(file,event){
    const old=records(file),data={...event,seq:old.length,previous:old.at(-1)?.hash||'0'.repeat(64)};
    const row={...data,hash:sha(canonical(data))};const fd=fs.openSync(file,'a',0o600);
    try{fs.writeSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return row;
}
async function locked(file,operation){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if(fs.existsSync(file)){
        const owner=read(file);if(!Number.isInteger(owner.pid)||owner.pid<1)throw fail('J02_LOCKED');
        try{process.kill(owner.pid,0);throw fail('J02_LOCKED');}catch(e){if(e.code!=='ESRCH')throw fail('J02_LOCKED');}
        fs.unlinkSync(file); // Only a proven exited owner. In-flight trials are never replayed.
    }
    write(file,{pid:process.pid});try{return await operation();}finally{fs.unlinkSync(file);}
}
function inventory(root){
    const files=new Set(['package.json','package-lock.json','VCPDistributedServer/Plugin/AndroidController/AndroidControllerService.js']);
    const walk=dir=>{for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
        const file=dir+'/'+e.name;if(e.isDirectory())walk(file);else if(/\.(?:js|cjs|json|jar|apk)$/.test(e.name))files.add(file);
    }};
    walk('VCPDistributedServer/Plugin/AndroidController');
    for(const f of fs.readdirSync(path.join(root,'modules/services')))if(/^(android|globalJev|jev|humanInteraction).*\.js$/.test(f))files.add('modules/services/'+f);
    for(const file of files){
        if(!/\.(?:js|cjs)$/.test(file))continue;
        for(const m of fs.readFileSync(path.join(root,file),'utf8').matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)){
            const resolved=require.resolve(path.resolve(root,path.dirname(file),m[2]));const rel=path.relative(root,resolved).replaceAll('\\','/');
            if(rel.startsWith('../')||path.isAbsolute(rel))throw fail('J02_SOURCE_OUTSIDE_ROOT');if(!rel.startsWith('node_modules/'))files.add(rel);
        }
    }
    return [...files].sort().map(f=>path.join(root,f));
}
function snapshot(files){return [...new Set(files.map(f=>path.resolve(f)))].sort().map(file=>({file,sha256:sha(fs.readFileSync(file))}));}
function unchanged(identity){return identity.every(x=>{try{return sha(fs.readFileSync(x.file))===x.sha256;}catch{return false;}});}
module.exports={canonical,sha,read,write,records,append,locked,inventory,snapshot,unchanged};
