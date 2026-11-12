'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../scripts/android-m4/protocol.cjs');
const { Evidence, Session, runProbe } = require('../scripts/android-m4/probe.cjs');

const windowText = `  Display: mDisplayId=0 (organized)
    init=1440x3168 640dpi cur=1440x3168 app=1440x3168
  mCurrentFocus=Window{abc u0 com.demo/.Home}
`;
const secondWindow = `  Display: mDisplayId=12
    init=720x1280 260dpi cur=720x1280 app=720x1280
  mCurrentFocus=null
`;
const displayText = `  Logical Displays: size=2
  Display 0:
    mDisplayId=0
    mPrimaryDisplayDevice=Built-in(local:4630946756802996883)
  Display 12:
    mDisplayId=12
    mPrimaryDisplayDevice=scrcpy(virtual:com.android.shell,2000,scrcpy,1)
`;
const sfText = 'Display 4630946756802996883 (HWC display 0): port=147\n';

test('M4 inventory keeps SF 64-bit identity exact and never maps virtual logical id by guess', () => {
    const list = P.inventory(windowText + secondWindow, displayText, sfText);
    assert.equal(list[0].surfaceFlingerId, '4630946756802996883');
    assert.equal(list[1].logicalId, 12);
    assert.equal(list[1].surfaceFlingerId, null);
    assert.equal(list[1].uniqueId, 'virtual:com.android.shell,2000,scrcpy,1');
    assert.equal(P.newDisplay([list[0]], list), list[1]);
});
for (const [name, input, code] of [
    ['duplicate identity', windowText + windowText, 'AMBIGUOUS_DISPLAY_ID'],
    ['missing focus', windowText.replace(/.*mCurrentFocus.*\n/, ''), 'DISPLAY_GEOMETRY_OR_FOCUS_UNPROVEN'],
    ['ambiguous focus', windowText + ' mCurrentFocus=null\n', 'DISPLAY_GEOMETRY_OR_FOCUS_UNPROVEN'],
    ['timeout', windowText + 'DUMP TIMEOUT', 'DISPLAY_DUMP_FAILED'],
]) test('M4 rejects ' + name, () => assert.throws(() => P.inventory(input, displayText, sfText), { code }));

test('M4 physical context rejects focus change even in same package', () => {
    const p = P.physical(P.inventory(windowText, displayText, sfText));
    assert.equal(P.samePhysical(p, { ...p, focus: p.focus.replace('abc', 'def') }), false);
    assert.equal(P.samePhysical(p, { ...p, uniqueId: 'local:other' }), false);
    // PJZ110 P0: launching on scrcpy display leaves the default display focus null.
    assert.throws(()=>P.physical(P.inventory(windowText.replace('Window{abc u0 com.demo/.Home}','null'),displayText,sfText)),
        {code:'PHYSICAL_CONTEXT_UNPROVEN'});
});
test('M4 rejects ambiguous additions and reused display ids', () => {
    const all = P.inventory(windowText + secondWindow, displayText, sfText);
    assert.throws(() => P.newDisplay(all, all), { code: 'NEW_DISPLAY_UNPROVEN' });
    assert.throws(() => P.newDisplay([all[0]], [...all, { ...all[1], logicalId: 13 }]), { code: 'NEW_DISPLAY_UNPROVEN' });
    assert.equal(P.sameTarget(all[1],[all[0],{...all[1],uniqueId:'virtual:replacement'}]),false);
    assert.equal(P.sameTarget(all[1],[all[0]]),false);
});
test('M4 requires explicit target and rejects duplicate or injected CLI options', () => {
    assert.throws(() => P.parseArgs(['--output','x']), { code: 'EXPLICIT_SERIAL_REQUIRED' });
    assert.throws(() => P.parseArgs(['--serial','x;id','--output','x']), { code: 'EXPLICIT_SERIAL_REQUIRED' });
    assert.throws(() => P.parseArgs(['--serial','A','--serial','B','--output','x']), { code: 'INVALID_OPTION' });
    assert.throws(() => P.parseArgs(['--serial','A','--output','x','--mode','overlay']), { code: 'FIXTURE_AND_DECODER_REQUIRED' });
    assert.equal(P.parseArgs(['--serial','A','--output','x']).mode, 'baseline');
});
test('M4 installed APK path accepts Android randomized paths and rejects multiple or shell-active paths', () => {
    const good='/data/app/~~token==/com.vcpchat.m4fixture--token==/base.apk';
    assert.equal(P.installedApkPath({code:0,stdout:'package:'+good+'\n',stderr:''}),good);
    for(const stdout of ['package:'+good+'\npackage:'+good,'package:/data/app/$(id)/base.apk','package:/data/app/x;id/base.apk']) {
        assert.throws(()=>P.installedApkPath({code:0,stdout,stderr:''}),{code:'INSTALLED_FIXTURE_PATH_UNPROVEN'});
    }
});
test('F1 requires exact independently reported trusted, own and non-stealing focus flags',()=>{
    const unique='virtual:com.android.shell,2000,scrcpy,1';
    const text=`  DisplayDeviceInfo{"scrcpy": uniqueId="${unique}", FLAG_TRUSTED, FLAG_OWN_FOCUS, FLAG_STEAL_TOP_FOCUS_DISABLED}\n`;
    P.requireFocusFlags({flags:P.displayFlags(text,unique)});
    assert.deepEqual(P.displayFlags(text,'other'),[]);
    assert.throws(()=>P.requireFocusFlags({flags:P.displayFlags(text.replace(', FLAG_STEAL_TOP_FOCUS_DISABLED',''),unique)}),{code:'FOCUS_FLAGS_UNPROVEN'});
    assert.throws(()=>P.requireFocusFlags({flags:P.displayFlags(text+text,unique)}),{code:'FOCUS_FLAGS_UNPROVEN'});
    assert.throws(()=>P.requireFocusFlags(undefined),{code:'FOCUS_FLAGS_UNPROVEN'});
});
test('F1 validates candidate identity and actual jar hash independently of protocol version',()=>{
    const build={candidate:'scrcpy-5.0.1-focus1',upstreamCommit:'a60891aea193d92e7e5c3942700eca63f9d19a5f',sha256:'known'};
    P.validateFocusBuild(build,'known');
    for(const patch of [{candidate:'scrcpy-5.0.1'},{upstreamCommit:'other'},{sha256:'tampered'}])assert.throws(()=>P.validateFocusBuild({...build,...patch},'known'),{code:'FOCUS_SERVER_IDENTITY_UNPROVEN'});
});
test('M4 server never wakes, syncs clipboard, keeps awake, or preserves removed display content', () => {
    const args = P.serverOptions('1234abcd', null);
    for (const arg of ['power_on=false','clipboard_autosync=false','stay_awake=false','keep_active=false','vd_destroy_content=true','display_ime_policy=hide']) assert.ok(args.includes(arg));
    assert.ok(args.includes('control=true'));
    assert.throws(() => P.serverOptions('1234abcd', 0), { code: 'NONDEFAULT_DISPLAY_REQUIRED' });
    assert.throws(() => P.serverOptions('abcdabcd', null), { code: 'INVALID_SCID' });
});

const state = (overrides = {}) => ({ session: '12345678-1234-1234-1234-123456789abc', displayId: 12, destroyed: false,
    resumed: true, taskId:30, width:720, height:1280, touchEventCount:0, deliveredDisplayIds:[],
    taps: 0, touchDisplayIds: [], buttonBounds: {left:0,top:0,right:100,bottom:100}, ...overrides });
const row = (states, envelope = {}) => 'Row: 0 json=' + JSON.stringify({ schemaVersion:1, package:P.PACKAGE,
    processSession:'abcdefab-1234-1234-1234-123456789abc',captureStatus:'fresh',capturedAtUptimeMs:100,states,...envelope });
test('M4 independent fixture rejects stale, wrong-display and duplicated live instances', () => {
    assert.equal(P.fixtureState(row([state()]), 12).taps, 0);
    assert.throws(() => P.fixtureState(row([state({destroyed:true})]), 12), { code:'FIXTURE_AMBIGUOUS' });
    assert.throws(() => P.fixtureState(row([state(),state()]), 12), { code:'FIXTURE_AMBIGUOUS' });
    assert.throws(() => P.fixtureState(row([state({touchDisplayIds:[0]})]), 12), { code:'FIXTURE_STATE_UNPROVEN' });
    assert.throws(() => P.buttonCenter(state(), {logicalId:12,size:{width:10,height:10}}), { code:'FIXTURE_DISPLAY_MISMATCH' });
    assert.throws(() => P.buttonCenter(state({buttonBounds:{left:0,top:0,right:800,bottom:100}}),
        {logicalId:12,size:{width:720,height:1280}}), {code:'FIXTURE_BOUNDS_UNPROVEN'});
    assert.throws(() => P.fixtureState(row([state()], {captureStatus:'main-thread-timeout'}),12), {code:'FIXTURE_CAPTURE_STALE'});
});
test('M4 tap verification uses fresh independent instance counters even if hidden event display API is unavailable', () => {
    const before = P.fixtureState(row([state()]),12);
    const after = P.fixtureState(row([state({taps:1,touchEventCount:2,deliveredDisplayIds:[12],touchDisplayIdUnavailable:2})],
        {capturedAtUptimeMs:101}),12);
    assert.equal(P.verifyTap(before,after),true);
    for (const patch of [{taskId:31},{taps:2},{touchEventCount:0},{captureUptimeMs:99},{session:'other'},{deliveredDisplayIds:[]}]) {
        assert.equal(P.verifyTap(before,{...after,...patch}),false);
    }
});

async function simulation(t, changes = {}) {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm4-probe-')), 'evidence');
    t.after(() => fs.rmSync(path.dirname(output), { recursive:true, force:true }));
    const events = [];
    let tapped = false;
    const all = P.inventory(windowText + secondWindow, displayText, sfText);
    if(changes.mode==='focus1')all[1].flags=changes.missingFocusFlag ? ['FLAG_TRUSTED','FLAG_OWN_FOCUS'] : ['FLAG_TRUSTED','FLAG_OWN_FOCUS','FLAG_STEAL_TOP_FOCUS_DISABLED'];
    class FakeEvidence extends Evidence {
        async command(file, args, label) {
            events.push({label,args});
            if (label === changes.failCommand) throw P.fail('INJECTED_TRANSPORT_FAILURE');
            let stdout = '';
            if (label === 'devices') stdout = 'A device model:fixture\n';
            if (label === 'sdk') stdout = changes.oldSdk ? '33\n' : '37\n';
            if (label === 'keyguard') stdout = ' showing=false\n inputRestricted=false\n';
            if (label === 'preflight-processes') stdout = changes.otherAutomation ? '1 com.vcpchat.uiautomator.Owner' : '';
            if (label === 'overlay-before' || label === 'overlay-restored') stdout = 'null\n';
            if (label === 'overlay-before-restore') stdout = changes.externalOverlay ? '800x600/200\n' : '720x1280/260\n';
            if (label === 'fixture-state') stdout = row([state({ taps: tapped && !changes.noEffect ? 1 : 0,
                touchEventCount:tapped ? 2 : 0,deliveredDisplayIds:tapped ? [12] : [] })]);
            if (label === 'single-display-tap') tapped = true;
            if (label === 'uninstall-fixture') stdout = 'Success\n';
            if (label === 'fixture-before' && changes.useInstalledFixture) stdout='package:/data/app/~~token==/com.vcpchat.m4fixture-token/base.apk\n';
            if (label === 'installed-fixture-hash') stdout=(changes.wrongInstalledHash ? 'bad' : require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'))+'  base.apk';
            return {code:label==='fixture-removed'||(label==='fixture-before'&&!changes.useInstalledFixture) ? 1 : 0,stdout,stderr:''};
        }
        async snapshot(label) {
            const displays = JSON.parse(JSON.stringify(['before','prepared','cleaned'].includes(label) ? [all[0]] : all));
            if (label === changes.focusChangedAt) displays[0].focus = 'Window{changed u0 com.demo/.Home}';
            return {displays, wakefulness: changes.asleep ? 'Dozing' : 'Awake'};
        }
    }
    class FakeSession {
        constructor() { this.frames=0; this.generation='generation'; }
        async start() { events.push({label:'session-start'}); if (changes.startFails) throw P.fail('VIDEO_METADATA_TIMEOUT'); return {generation:this.generation}; }
        async image() { events.push({label:'image'}); return {nonblackRatio:0.8}; }
        async stop() { events.push({label:'session-stop'}); if (changes.stopFails) throw P.fail('SESSION_CLEANUP_UNPROVEN'); }
    }
    const result = await runProbe({serial:'A',mode:changes.mode || 'overlay',output,adb:process.execPath,apk:__filename,ffmpeg:process.execPath,
        useInstalledFixture:changes.useInstalledFixture},
        {EvidenceType:FakeEvidence, SessionType:FakeSession,
            resolveServer:()=>({jar:require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub').LOCAL_JAR})});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')), result);
    return {result,events,labels:events.map(e=>e.label)};
}
test('M4 baseline performs no device mutations', async t => {
    const {result,labels} = await simulation(t,{mode:'baseline'});
    assert.equal(result.status,'PASSED');
    assert.deepEqual(labels,['devices','build-fingerprint']);
});
for (const context of ['created','ready']) test('M4 physical focus change stops before input and restores owned resources: ' + context, async t => {
    const {result,labels} = await simulation(t,{focusChangedAt:context});
    assert.equal(result.status,'FAILED'); assert.equal(result.writes,0);
    assert.ok(!labels.includes('single-display-tap'));
    assert.ok(labels.includes('restore-overlay')); assert.ok(labels.includes('uninstall-fixture'));
    assert.equal(result.cleanup.status,'PASSED');
});
test('M4 no-effect dispatch is a failure and is never replayed', async t => {
    const {result,labels} = await simulation(t,{noEffect:true});
    assert.equal(result.status,'FAILED'); assert.equal(result.writes,1);
    assert.equal(labels.filter(x=>x==='single-display-tap').length,1);
    assert.ok(result.errors.includes('TARGET_TAP_UNPROVEN'));
});
test('M4 initialization failure still closes session, overlay and fixture', async t => {
    const {result,labels} = await simulation(t,{startFails:true});
    assert.equal(result.status,'FAILED');
    for (const label of ['session-stop','restore-overlay','uninstall-fixture']) assert.ok(labels.includes(label));
});
test('M4 setup failure does not claim an unexecuted display gate failed', async t => {
    const {result,labels} = await simulation(t,{failCommand:'install-fixture'});
    assert.equal(result.status,'FAILED'); assert.equal(result.gates.A2,'NOT_RUN');
    assert.ok(!labels.includes('create-overlay')); assert.ok(labels.includes('uninstall-fixture'));
    assert.ok(result.cleanup.errors.includes('INSTALL_RESULT_UNKNOWN'));
});
test('M4 explicitly reuses only an identical installed APK and preserves it on cleanup', async t => {
    const {result,labels} = await simulation(t,{useInstalledFixture:true});
    assert.equal(result.status,'PASSED');
    assert.equal(result.fixtureSource,'EXACT_INSTALLED_APK_PRESERVED');
    assert.ok(labels.includes('installed-fixture-hash'));
    assert.ok(!labels.includes('install-fixture')); assert.ok(!labels.includes('uninstall-fixture'));
});
test('M4 mismatched installed APK stops before any display mutation', async t => {
    const {result,labels} = await simulation(t,{useInstalledFixture:true,wrongInstalledHash:true});
    assert.ok(result.errors.includes('INSTALLED_FIXTURE_MISMATCH'));
    assert.ok(!labels.includes('create-overlay')); assert.ok(!labels.includes('uninstall-fixture'));
});
test('M4 cleanup failure overrides otherwise passed checks and does not suppress other cleanup', async t => {
    const {result,labels} = await simulation(t,{stopFails:true});
    assert.equal(result.status,'FAILED'); assert.equal(result.cleanup.status,'FAILED');
    assert.ok(labels.includes('restore-overlay')); assert.ok(labels.includes('uninstall-fixture'));
});
test('M4 does not overwrite an overlay changed by another actor', async t => {
    const {result,labels} = await simulation(t,{externalOverlay:true});
    assert.equal(result.cleanup.status,'FAILED'); assert.ok(!labels.includes('restore-overlay'));
});
for (const change of [{otherAutomation:true},{asleep:true}]) test('M4 unsuitable device fails before install', async t => {
    const {result,labels} = await simulation(t,change);
    assert.equal(result.status,'FAILED'); assert.ok(!labels.includes('install-fixture'));
});
test('M4 new-display diagnostic never sends input even with a successful visible fixture', async t => {
    const {result,labels} = await simulation(t,{mode:'new-display'});
    assert.equal(result.status,'PASSED'); assert.equal(result.writes,0);
    assert.ok(!labels.includes('single-display-tap')); assert.ok(!labels.includes('create-overlay'));
    assert.equal(result.gates.A2,'NOT_RUN'); assert.equal(result.gates.A5,'NOT_RUN');
});
test('F1 candidate verifies one directed input while preserving the old overlay gate identity',async t=>{
    const {result,labels}=await simulation(t,{mode:'focus1',useInstalledFixture:true});
    assert.equal(result.status,'PASSED');assert.equal(result.protocol,'M4-focus-F1');assert.equal(result.writes,1);
    assert.equal(result.gates.A2,'NOT_RUN');assert.equal(result.gates.A4,'FOCUS1_LAUNCH_ADB_TAP_PASSED_CONTROL_NOT_RUN');
    assert.equal(labels.filter(l=>l==='single-display-tap').length,1);
});
for(const change of [{missingFocusFlag:true},{oldSdk:true},{focusChangedAt:'ready'}])test('F1 incomplete isolation stops before any directed input '+JSON.stringify(change),async t=>{
    const {result,labels}=await simulation(t,{mode:'focus1',useInstalledFixture:true,...change});
    assert.equal(result.status,'FAILED');assert.equal(result.writes,0);assert.ok(!labels.includes('single-display-tap'));
});

test('M4 session completes real TCP video/control handshake in order and closes only its own resources', async t => {
    const net = require('node:net');
    const {EventEmitter} = require('node:events');
    const {PassThrough} = require('node:stream');
    const {createHash} = require('node:crypto');
    const {LOCAL_JAR} = require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub');
    const sockets = [], calls = [];
    let receivedControl = 0;
    const server = net.createServer(socket => {
        sockets.push(socket);
        socket.on('error',()=>{});
        if (sockets.length === 1) socket.write(Buffer.from([0]));
        else {
            socket.on('data',data=>{receivedControl+=data.length;});
            const meta = Buffer.alloc(64+4+12);
            meta.write('simulated-device'); meta.write('h264',64);
            meta[68]=0x80; meta.writeUInt32BE(720,72); meta.writeUInt32BE(1280,76);
            // Fragment metadata to exercise TCP boundaries, not one-buffer assumptions.
            sockets[0].write(meta.subarray(0,23)); sockets[0].write(meta.subarray(23));
        }
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{ for(const s of sockets)s.destroy(); await new Promise(resolve=>server.close(resolve)); });
    let session, forwardActive=true;
    const evidence = {
        options:{adb:'fake-adb',serial:'A'}, write(){}, check(){},
        async adb(args,label) { calls.push({args,label}); if(label==='remove-forward')forwardActive=false; return {stdout:label==='forward'?String(server.address().port):'',code:0}; },
        async command(file,args,label) { calls.push({args,label}); return {stdout:forwardActive ? `A tcp:${server.address().port} localabstract:scrcpy_${session.scid}\n` : '',code:0}; },
        async shell(command,label) {
            calls.push({command,label});
            return {stdout:label==='scrcpy-hash'?createHash('sha256').update(fs.readFileSync(LOCAL_JAR)).digest('hex')+'  jar':
                label==='socket-ready'?'@scrcpy_'+session.scid:'',code:0};
        },
    };
    const fake = new EventEmitter(); fake.stdout=new PassThrough(); fake.stderr=new PassThrough(); fake.kill=()=>{fake.emit('exit',0,null);};
    session=new Session(evidence,12,{spawn:()=>fake});
    t.after(()=>session.stop());
    const info=await session.start();
    assert.deepEqual(info.size,{width:720,height:1280});
    assert.equal(sockets.length,2); assert.equal(receivedControl,0);
    await session.stop();
    assert.ok(calls.some(c=>c.label==='remove-forward'&&c.args[2]==='tcp:'+server.address().port));
    assert.ok(calls.some(c=>c.label==='remove-owned-jar'&&c.command==='rm -f '+session.remoteJar));
    assert.ok(!calls.some(c=>c.command?.includes('pkill')));
});
test('M4 unknown forward creation is cleaned by exact serial and scid even without a returned port', async () => {
    const {createHash}=require('node:crypto');
    const {LOCAL_JAR}=require('../VCPDistributedServer/Plugin/AndroidController/lib/scrcpy-hub');
    let active=false, session;
    const removed=[];
    const e={ options:{adb:'fake',serial:'A'},write(){},
        async adb(args,label){
            if(label==='forward'){active=true;throw Error('transport output lost');}
            if(label==='remove-forward'){removed.push(args[2]);active=false;}
            return {code:0,stdout:''};
        },
        async shell(command,label){return {code:0,stdout:label==='scrcpy-hash'?createHash('sha256').update(fs.readFileSync(LOCAL_JAR)).digest('hex')+' jar':''};},
        async command(){return {code:0,stdout:`B tcp:4001 localabstract:scrcpy_${session.scid}\nA tcp:4002 localabstract:scrcpy_other\n`
            +(active?`A tcp:4003 localabstract:scrcpy_${session.scid}\n`:'')};},
    };
    session=new Session(e,12);
    await assert.rejects(session.start(),/transport output lost/);
    assert.equal(session.port,null); assert.equal(active,true);
    await session.stop();
    assert.equal(active,false); assert.deepEqual(removed,['tcp:4003']);
});
