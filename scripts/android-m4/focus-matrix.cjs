'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./protocol.cjs');
const { Evidence, runProbe, resolveServerArtifact } = require('./probe.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function executeMatrix({ check, execute, save }) {
    const rows = Array.from({ length:20 }, (_, index) => ({ case:index+1, status:'NOT_RUN' }));
    const generations = new Set(), scids = new Set();
    for (const row of rows) {
        try {
            await check();
            const result = await execute(row.case);
            Object.assign(row, { status:result.status, errors:result.errors, cleanup:result.cleanup.status, writes:result.writes,
                displayId:result.target?.logicalId, generation:result.target?.generation, scid:result.session?.scid });
            if (result.status === 'PASSED') {
                if (result.cleanup.status !== 'PASSED' || result.writes !== 1 || !row.generation || !row.scid
                    || generations.has(row.generation) || scids.has(row.scid)) throw P.fail('MATRIX_LIFECYCLE_UNPROVEN');
                generations.add(row.generation); scids.add(row.scid);
            }
        } catch (error) { row.status='FAILED'; row.errors=[...(row.errors || []),error.code || error.message]; }
        await save(rows);
        if (row.status !== 'PASSED') break;
    }
    return rows;
}
async function main(argv) {
    const index = argv.indexOf('--qualification');
    if (index < 0 || !argv[index+1] || argv.lastIndexOf('--qualification') !== index) throw P.fail('QUALIFICATION_REQUIRED');
    const qualificationDir = path.resolve(argv[index+1]);
    const args = [...argv.slice(0,index),...argv.slice(index+2)];
    const options = P.parseArgs(args);
    if (options.mode !== 'focus1' || !options.useInstalledFixture) throw P.fail('FOCUS_MATRIX_MODE_REQUIRED');
    const qualification = JSON.parse(fs.readFileSync(path.join(qualificationDir,'result.json'),'utf8'));
    if (qualification.status !== 'PASSED' || qualification.protocol !== 'M4-focus-F1'
        || qualification.cleanup.status !== 'PASSED' || qualification.writes !== 1 || qualification.serial !== options.serial) throw P.fail('QUALIFICATION_INVALID');
    const artifact = resolveServerArtifact(options);
    const qualifiedHashes = JSON.parse(fs.readFileSync(path.join(qualificationDir,'input-hashes.json'),'utf8'));
    for (const [file,sha256] of Object.entries(qualifiedHashes)) if(hash(file)!==sha256)throw P.fail('QUALIFICATION_SOURCE_CHANGED');
    if (qualifiedHashes[artifact.jar] !== hash(artifact.jar)) throw P.fail('QUALIFICATION_CANDIDATE_CHANGED');
    const frozen = {...qualifiedHashes,[__filename]:hash(__filename)};
    const output = path.resolve(options.output); fs.mkdirSync(output,{recursive:false});
    fs.writeFileSync(path.join(output,'freeze.json'),JSON.stringify({protocol:'M4-focus-F1',qualificationDir,hashes:frozen,planned:20,candidate:artifact.build.candidate},null,2));
    fs.copyFileSync(__filename,path.join(output,'source-focus-matrix.cjs'));
    const expected = P.physical(qualification.baseline.displays);
    class MatrixEvidence extends Evidence {
        async snapshot(label) {
            const value = await super.snapshot(label);
            if(label==='before' && (value.displays.length!==1 || value.wakefulness!=='Awake'
                || !P.samePhysical(expected,P.physical(value.displays))))throw P.fail('MATRIX_PHYSICAL_BASELINE_CHANGED');
            return value;
        }
    }
    const startedAt = new Date().toISOString();
    const rows = await executeMatrix({
        check:async()=>{for(const [file,sha256]of Object.entries(frozen))if(hash(file)!==sha256)throw P.fail('FROZEN_SOURCE_CHANGED');},
        execute:async number=>{
            const label=String(number).padStart(2,'0');
            // Cold process start, independently verified; only the exact research APK is reset.
            const setup = new MatrixEvidence({...options,output:path.join(output,'setup-'+label)});
            await setup.snapshot('before');
            const apk=P.installedApkPath(await setup.shell('pm path '+P.PACKAGE,'fixture-path'));
            if((await setup.shell('sha256sum '+apk,'fixture-sha')).stdout.trim().split(/\s/)[0]!==hash(options.apk))throw P.fail('FIXTURE_IDENTITY_CHANGED');
            await setup.shell('am force-stop '+P.PACKAGE,'cold-fixture');
            const absent=await setup.shell('pidof '+P.PACKAGE,'fixture-process-absent',true);
            if(absent.code!==1||absent.stdout.trim()||absent.stderr.trim())throw P.fail('FIXTURE_COLD_START_UNPROVEN');
            const result=await runProbe({...options,output:path.join(output,'case-'+label)},{EvidenceType:MatrixEvidence});
            console.log(JSON.stringify({case:number,status:result.status,displayId:result.target?.logicalId,errors:result.errors,cleanup:result.cleanup.status}));
            return result;
        },
        save:async rows=>fs.writeFileSync(path.join(output,'progress.json'),JSON.stringify(rows,null,2)),
    });
    const summary={protocol:'M4-focus-F1',candidate:artifact.build.candidate,startedAt,finishedAt:new Date().toISOString(),planned:20,
        pass:rows.filter(r=>r.status==='PASSED').length,fail:rows.filter(r=>r.status==='FAILED').length,notRun:rows.filter(r=>r.status==='NOT_RUN').length,
        sourceChanged:Object.entries(frozen).filter(([file,sha256])=>hash(file)!==sha256).map(([file])=>file),rows};
    summary.status=summary.pass===20&&!summary.sourceChanged.length?'PASSED':'FAILED';
    fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
    console.log(JSON.stringify({...summary,rows:undefined},null,2));
    return summary;
}
if(require.main===module)main(process.argv.slice(2)).then(r=>{process.exitCode=r.status==='PASSED'?0:1;}).catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
module.exports={executeMatrix,main};
