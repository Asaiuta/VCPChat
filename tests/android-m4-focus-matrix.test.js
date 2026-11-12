'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {executeMatrix}=require('../scripts/android-m4/focus-matrix.cjs');
const passed=n=>({status:'PASSED',errors:[],cleanup:{status:'PASSED'},writes:1,target:{logicalId:n,generation:'generation-'+n},session:{scid:'scid-'+n}});
test('focus matrix completes exactly 20 unique lifecycles',async()=>{
    let calls=0,saves=0;
    const rows=await executeMatrix({check:async()=>{},execute:async n=>{calls++;return passed(n);},save:async()=>{saves++;}});
    assert.equal(calls,20);assert.equal(saves,20);assert.ok(rows.every(r=>r.status==='PASSED'));
});
test('focus matrix stops on first failed case, preserving remaining denominator without retries',async()=>{
    const calls=[];
    const rows=await executeMatrix({check:async()=>{},execute:async n=>{calls.push(n);return n===3?{...passed(n),status:'FAILED',errors:['FOCUS_CHANGED']}:passed(n);},save:async()=>{}});
    assert.deepEqual(calls,[1,2,3]);assert.equal(rows.filter(r=>r.status==='NOT_RUN').length,17);assert.equal(rows[2].status,'FAILED');
});
test('focus matrix source drift refuses the next device operation',async()=>{
    let checks=0,calls=0;
    const rows=await executeMatrix({check:async()=>{if(++checks===2)throw Error('FROZEN_SOURCE_CHANGED');},execute:async n=>{calls++;return passed(n);},save:async()=>{}});
    assert.equal(calls,1);assert.equal(rows[1].status,'FAILED');assert.equal(rows[2].status,'NOT_RUN');
});
test('focus matrix rejects duplicate session identity and cleanup failures',async()=>{
    for(const invalid of [{...passed(1)},{...passed(2),cleanup:{status:'FAILED'}}]){
        const rows=await executeMatrix({check:async()=>{},execute:async n=>n===2?invalid:passed(n),save:async()=>{}});
        assert.equal(rows[1].status,'FAILED');assert.equal(rows[2].status,'NOT_RUN');
    }
});
