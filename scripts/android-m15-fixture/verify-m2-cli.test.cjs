'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {CASES,parseArgs,parseState,independentImage,checkPixels,runMatrix,main}=require('../verify-android-m2.cjs');
const PACKAGE='com.vcpchat.m15fixture';
const state={ready:true,resumed:true,package:PACKAGE,protocol:1,session:'11111111-1111-4111-8111-111111111111',mode:'m2',m2ClicksA:0,m2ClicksB:0,m2DynamicCounter:0,m2Ticks:0,m2Motion:false,m2Label:'M2 DYNAMIC 0',m2Rect:{left:20,top:30,right:100,bottom:70},m2Color:-14639008};
const row=s=>'Row: 0 state='+JSON.stringify(s);
test('M2 CLI requires explicit canonical serial, defaults probe and rejects mixed or unknown options',()=>{
 assert.equal(parseArgs(['--serial','A']).mode,'probe'); assert.equal(parseArgs(['--suite','--serial','A']).mode,'suite');
 for(const args of [[],['--serial','A\nB'],['--suite','--probe','--serial','A'],['--serial','A','--serial','B'],['--run','--serial','A'],['--serial','--suite']])assert.throws(()=>parseArgs(args));
});
test('M2 provider parser does not accept absent or noncanonical independent state',()=>{
 assert.equal(parseState(row(state)).mode,'m2');
 for(const patch of [{ready:false},{resumed:false},{session:null},{mode:'else'},{m2Ticks:-1},{m2Motion:1},{m2Label:undefined},{m2DynamicCounter:NaN}])assert.throws(()=>parseState(row({...state,...patch})));
 assert.throws(()=>parseState('noise\n'+row(state)));
});
function probeDeps(unsafe=false){const calls=[],logs=[];return{calls,logs,emit:v=>logs.push(v),loadService(){throw new Error('must not load');},spawnSync(file,args){calls.push(args);let stdout='';if(args[0]==='devices')stdout='List of devices attached\nA device\n';else if(args.includes('displays'))stdout=`mCurrentFocus=Window{a u0 ${unsafe?'other':PACKAGE}/.MainActivity}`;else if(args.includes('power'))stdout='mWakefulness=Awake';else if(args.includes('policy'))stdout='KeyguardServiceDelegate\n  showing=false\n  inputRestricted=false';else if(args.includes('content'))stdout=row(state);else throw new Error('unexpected operation');return{status:0,stdout};}};}
test('M2 default probe never loads Service and performs only fixed read operations',async()=>{const d=probeDeps();const r=await main(['--serial','A','--adb',process.execPath],d);assert.equal(r.exitCode,0);assert.equal(d.calls.length,5);assert.ok(d.logs.every(v=>v.serviceInitialized!==true));});
test('unsafe M2 suite stops before Provider and Service without any input',async()=>{const d=probeDeps(true);await assert.rejects(main(['--suite','--serial','A','--adb',process.execPath],d),{code:'UNSAFE_OR_UNPROVEN_TARGET_STOP'});assert.equal(d.calls.length,4);});
function details(padding=8){const region={left:20-padding,top:30-padding,width:80+2*padding,height:40+2*padding};return{screen:{width:200,height:300},region,element:{visibleBounds:state.m2Rect,occlusion:'unknown',warnings:['OCCLUSION_NOT_PROVEN']},mapping:{offsetX:region.left,offsetY:region.top,imageWidth:region.width,imageHeight:region.height,stepX:1,stepY:1}};}
test('image reference derives exact ROI from Provider geometry rather than production mapping',()=>{const d=details();assert.equal(independentImage(d,state,8).width,96);assert.throws(()=>independentImage({...d,region:{...d.region,left:21}},state,8));assert.throws(()=>independentImage({...d,element:{...d.element,occlusion:'none'}},state,8));});
test('decoded image pixels must independently match actual fixture color, not just metadata',async()=>{const sharp=require('sharp'),d=details();const png=await sharp({create:{width:96,height:56,channels:3,background:{r:32,g:160,b:96}}}).png().toBuffer();d.image={dataUrl:'data:image/png;base64,'+png.toString('base64'),width:96,height:56};d.frameId='frame';await checkPixels(d,state,8);const bad=await sharp({create:{width:96,height:56,channels:3,background:'#ffffff'}}).png().toBuffer();await assert.rejects(checkPixels({...d,image:{...d.image,dataUrl:'data:image/png;base64,'+bad.toString('base64')}},state,8));});
function matrixMock(options={}){
 let s={...structuredClone(state)},current='',enabled=true,failedOnce=false;const logs=[],actions=[];
 const receipt=(outcome='dispatched',extra={})=>({details:{execution:{outcome},attempts:[{method:'click',channel:'rpc',status:'dispatched'}],...extra}});
 const ctx={emit:v=>logs.push(v),evidence(){},get current(){return current;},set current(v){current=v;},gate:()=>structuredClone(s),drain:async()=>{if(options.drainFailure&&failedOnce)throw Object.assign(new Error('busy'),{code:'RUNTIME_NOT_DRAINED_STOP'});},reset:async()=>{s=structuredClone(state);},observe:async()=>receipt('observed',{controls:[{id:PACKAGE+':id/m2_color',index:0}],snapshotId:'snap'}),
 tap:async(selector,predicate)=>{const a=structuredClone(s);if(selector.id?.endsWith('m2_start_motion')){s.m2Motion=true;s.m2Ticks++;}else if(selector.id?.endsWith('m2_start_text'))s.m2Ticks++;else if(selector.within||selector.nth===1)s.m2ClicksB++;else s.m2DynamicCounter++;assert.ok(predicate(a,s));actions.push(current);return receipt();},
 execute:async args=>{if(options.failure===current&&!failedOnce){failedOnce=true;throw Object.assign(new Error('case'),{code:options.code||'KNOWN_FAILURE'});}if(args.steps){s.m2DynamicCounter+=2;return receipt('dispatched',{sequence:{status:'completed'}});}if(args.action?.selector?.text==='M2 SAME')throw Object.assign(new Error('duplicate'),{code:'TARGET_NOT_UNIQUE'});s.m2DynamicCounter++;const d=details(4);d.mapping.screen=d.screen;return receipt('dispatched',{observation:{...d,status:'observed',screen:d.screen}});},
 image:async args=>{if(s.m2Motion)throw Object.assign(new Error('changed'),{code:'ELEMENT_TARGET_CHANGED'});const d=details(args.padding||0);d.mapping.screen=d.screen;const png=await require('sharp')({create:{width:d.region.width,height:d.region.height,channels:3,background:'#20a060'}}).png().toBuffer();return{details:{...d,image:{width:d.region.width,height:d.region.height,dataUrl:'data:image/png;base64,'+png.toString('base64')},frameId:'frame'}};},
 idle:async()=>{s.m2Ticks++;return receipt(s.m2Motion?'unknown':'verified',{idleMode:s.m2Motion?null:'layout_stable'});},stop:async()=>{s.m2Motion=false;},reconfigure:async v=>{enabled=v;},};
 return{ctx,logs,actions};
}
test('full fixed M2 matrix reports acceptance only when all independent cases pass',async()=>{const h=matrixMock();const r=await runMatrix(h.ctx);assert.equal(r.exitCode,0,JSON.stringify(r.results));assert.equal(r.summary.passed,CASES.length);assert.equal(r.summary.deviceAcceptance,'PASSED');assert.deepEqual(r.results.map(v=>v.name),CASES);});
test('known nontransport assertion failure does not replay or hide remaining independent cases',async()=>{const h=matrixMock({failure:'DuplicateRejected'});const r=await runMatrix(h.ctx);assert.equal(r.summary.deviceAcceptance,'NOT_PASSED');assert.equal(r.summary.failed,1);assert.equal(r.summary.executed,CASES.length);});
test('unknown remote transport prevents all later cases and never resets over an uncertain device',async()=>{const h=matrixMock({failure:'DuplicateRejected',code:'UI_SERVER_TIMEOUT'});const r=await runMatrix(h.ctx);assert.equal(r.summary.executed,5);assert.equal(r.summary.notExecuted,CASES.length-5);assert.equal(r.summary.deviceAcceptance,'NOT_PASSED');});
test('retained lease or queue blocks cleanup and next case',async()=>{const h=matrixMock({failure:'DuplicateRejected',drainFailure:true});const r=await runMatrix(h.ctx);assert.equal(r.summary.executed,5);assert.equal(r.results.at(-1).code,'RUNTIME_NOT_DRAINED_STOP');});

test('foreground loss after an operation stops matrix but still drains and cleans transport',async()=>{
 const d=probeDeps(),originalSpawn=d.spawnSync;let switched=false,cleaned=0,operations=0;
 d.spawnSync=(file,args)=>{if(args.some(a=>a.includes('echo PRESENT')))return{status:0,stdout:'PRESENT'};if(switched&&args.includes('displays'))return{status:0,stdout:'mCurrentFocus=Window{b u0 other/.MainActivity}'};return originalSpawn(file,args);};
 d.loadRuntime=()=>({assertManagementIdle(){}});
 d.loadService=()=>({async initialize(){},getRuntimeStatus:()=>({adbQueue:{depth:0,pending:0,running:false}}),async processToolCall(){operations++;switched=true;return{details:{execution:{serial:'A',outcome:'dispatched'}}};},async cleanup(){cleaned++;}});
 const r=await main(['--suite','--serial','A','--adb',process.execPath],d);
 assert.equal(r.summary.deviceAcceptance,'NOT_PASSED');assert.equal(r.summary.executed,1);assert.equal(operations,1);assert.equal(cleaned,1);
});

