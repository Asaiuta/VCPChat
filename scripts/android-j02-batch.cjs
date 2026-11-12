'use strict';
const path=require('node:path');
const {fail}=require('./android-j02/contract.cjs');
async function main(args=process.argv.slice(2)){
    const [command,...rest]=args;
    if(command==='benchmark-prepare'&&[4,5].includes(rest.length))return require('./android-j02/benchmark.cjs').prepare(...rest);
    if(command==='benchmark-runtime'&&rest.length===3)return require('./android-j02/benchmark-adapter.cjs').runtime(...rest);
    if(command==='benchmark-materialize'&&rest.length===5)return require('./android-j02/benchmark-adapter.cjs').materialize(...rest);
    if(command==='benchmark-bind'&&rest.length===2)return require('./android-j02/benchmark-adapter.cjs').bind(...rest);
    if(command==='benchmark-coverage'&&rest.length===2){
        const result=require('./android-j02/benchmark-adapter.cjs').coverage(rest[0]);
        require('./android-j02/storage.cjs').write(path.resolve(rest[1]),result);return{output:path.resolve(rest[1]),selected:result.selected};
    }
    if(command==='freeze'&&rest.length===2)return require('./android-j02/batch.cjs').freeze(...rest);
    if(command==='run'&&rest.length===2&&rest[1]==='--real')return require('./android-j02/batch.cjs').run(rest[0]);
    if(command==='audit'&&rest.length===2)return require('./android-j02/batch.cjs').review(...rest);
    if(command==='init-legado'&&rest.length===4)return require('./android-j02/legado.cjs').init(...rest);
    if(command==='report'&&rest.length===1){const r=await require('./android-j02/report.cjs').report(rest[0]);return{batchId:r.batchId,complete:r.complete,calibrated:r.calibrated,groups:r.groups.map(g=>({family:g.family,blockers:g.blockers}))};}
    if(command==='inspect'&&[4,5].includes(rest.length)){
        const [adb,serial,packages,out,stateFileList]=rest;
        const files=stateFileList?require('./android-j02/storage.cjs').read(path.resolve(stateFileList)):[];
        if(!Array.isArray(files)||files.some(f=>typeof f!=='string'))throw fail('J02_OPTIONS_INVALID');
        const evidence=require('./android-j02/device.cjs').device(path.resolve(adb),serial).inspect(packages.split(','),files);
        require('./android-j02/storage.cjs').write(path.resolve(out),evidence);return{output:path.resolve(out)};
    }
    if(command==='help'||!command)return{usage:['freeze <manifest.json> <new-batch-dir>','run <batch-dir> --real','audit <batch-dir> <review.json>',
        'report <batch-dir>','inspect <adb-path> <serial> <packages-comma-separated> <new-environment.json> [state-file-list.json]',
        'init-legado <environment.json> <adb-path> <snapshot.jar> <new-manifest.json>',
        'benchmark-prepare <androidworld|androidlab> <checkout> <selection.json> <new-output-dir> [python-path]',
        'benchmark-runtime <androidworld|androidlab> <isolated-python-path> <new-runtime.json>',
        'benchmark-materialize <prepared-dir> <task-id> <seed> <python-path> <new-case.json>',
        'benchmark-bind <manifest-with-benchmark.json> <new-output-dir>',
        'benchmark-coverage <prepared-dir> <new-coverage.json>'],
        note:'freeze/report are offline; run executes one planned trial and waits for independent audit; interrupted writes never retry'};
    throw fail('J02_OPTIONS_INVALID');
}
if(require.main===module)main().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code||'')?e.code:'J02_FAILED');process.exitCode=1;});
module.exports={main};
