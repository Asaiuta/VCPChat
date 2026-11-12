'use strict';
// Builds the isolated primary fixture and its permissionless launch peer with the existing local SDK.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=__dirname, args=process.argv.slice(2);
function value(flag,fallback){const i=args.indexOf(flag);return i<0?fallback:args[i+1];}
const sdk=path.resolve(value('--sdk',process.env.ANDROID_SDK_ROOT||process.env.ANDROID_HOME||'F:/AndroidSdk'));
const tools=path.join(sdk,'build-tools',value('--build-tools','36.0.0')), platform=value('--platform','android-35');
const jdkRoot=path.resolve(value('--jdk',path.join(sdk,'jbr'))), java=n=>path.join(jdkRoot,'bin',n+'.exe'), tool=n=>path.join(tools,n+'.exe');
const jar=path.join(sdk,'platforms',platform,'android.jar'), out=path.join(root,'.build');
function run(file,argv){const r=cp.spawnSync(file,argv,{cwd:root,stdio:'inherit',windowsHide:true,timeout:120000});if(r.error||r.status!==0)throw Error(`${path.basename(file)} failed`);}
for(const f of [jar,tool('aapt2'),tool('zipalign'),path.join(tools,'lib','d8.jar'),path.join(tools,'lib','apksigner.jar'),java('java'),java('jar')])if(!fs.statSync(f,{throwIfNoEntry:false})?.isFile())throw Error('Missing local build dependency: '+f);
run(process.execPath,[path.join(root,'build.cjs'),'--sdk',sdk,'--build-tools',value('--build-tools','36.0.0'),'--platform',platform,'--jdk',jdkRoot]);
const peerRes=path.join(out,'peer-resources.apk'),peerAligned=path.join(out,'peer-aligned.apk'),peerApk=path.join(out,'m15-journey-peer.apk');
run(tool('aapt2'),['link','-I',jar,'--manifest',path.join(root,'PeerManifest.xml'),'-o',peerRes]);
run(java('jar'),['uf',peerRes,'-C',path.join(out,'dex'),'classes.dex']);run(tool('zipalign'),['-f','4',peerRes,peerAligned]);
const key=path.join(out,'fixture-only.p12');
run(java('java'),['-jar',path.join(tools,'lib','apksigner.jar'),'sign','--ks',key,'--ks-key-alias','fixture','--ks-pass','pass:fixture-only','--key-pass','pass:fixture-only','--out',peerApk,peerAligned]);
run(java('java'),['-jar',path.join(tools,'lib','apksigner.jar'),'verify',peerApk]);
console.log(JSON.stringify({primary:path.join(out,'m15-fixture.apk'),peer:peerApk,packages:['com.vcpchat.m15fixture','com.vcpchat.fixturepeer']}));
