'use strict';
const cp=require('node:child_process');
const {parseSafety}=require('../verify-android-m15.cjs');
const {fail}=require('./contract.cjs');
function device(adbPath,serial,{spawnSync=cp.spawnSync}={}){
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serial))throw fail('J02_SERIAL_INVALID');
    const executeAdb=(args,useSerial=true,timeout=20000)=>spawnSync(adbPath,[...(useSerial?['-s',serial]:[]),...args],
        {encoding:'utf8',timeout,maxBuffer:8*1024*1024,windowsHide:true});
    const read=args=>{const r=executeAdb(args);if(r.error||r.signal||r.status!==0)throw fail('J02_ADB_FAILED');return String(r.stdout);};
    const layout=windows=>{
        const displays=windows.replaceAll('\r','').split(/(?=Display: mDisplayId=)/).filter(s=>/^Display: mDisplayId=0\b/.test(s));
        if(displays.length!==1)throw fail('J02_DISPLAY_UNKNOWN');const display=displays[0];
        const sizes=[...display.matchAll(/^[ \t]*(?:init=[^\n]*?[ \t]+)?cur=(\d+)x(\d+)[ \t]+app=/gm)];
        const rotations=[...display.matchAll(/^[ \t]*mRotation=([0-3])(?:[ \t]|$)/gm)];
        if(sizes.length!==1||rotations.length!==1)throw fail('J02_VIEWPORT_UNKNOWN');
        return{display,viewport:{width:+sizes[0][1],height:+sizes[0][2]},rotation:+rotations[0][1]};
    };
    const gate=(pkg,expected)=>{
        const windows=read(['shell','dumpsys','window','displays']);
        const safety=parseSafety(windows,read(['shell','dumpsys','power']),read(['shell','dumpsys','window','policy']));
        if(!safety.awake||!safety.unlocked)throw fail('J02_DEVICE_LOCKED');
        const {display,viewport,rotation}=layout(windows);
        if(expected&&(rotation!==expected.rotation||viewport.width!==expected.viewport.width||viewport.height!==expected.viewport.height))throw fail('J02_ENVIRONMENT_CHANGED');
        const focus=display?.split(/\r?\n/).filter(s=>/mCurrentFocus=/.test(s))||[];
        if(pkg&&(focus.length!==1||!focus[0].includes(` u0 ${pkg}/`)))throw fail('J02_WRONG_FOREGROUND');
    };
    const fileSha=file=>{
        if(!/^\/(?:data|sdcard|storage)\/[A-Za-z0-9_./=+~-]+$/.test(file)||file.split('/').includes('..'))throw fail('J02_DEVICE_PATH');
        const hash=read(['shell','sha256sum',file]).trim().split(/\s+/)[0];if(!/^[a-f0-9]{64}$/.test(hash))throw fail('J02_DEVICE_HASH');return hash;
    };
    const inspect=(packages,stateFiles=[])=>{
        const apps=packages.map(pkg=>{
            if(!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg))throw fail('J02_PACKAGE_INVALID');
            const info=read(['shell','dumpsys','package',pkg]);
            const apks=read(['shell','pm','path',pkg]).trim().split(/\r?\n/).map(s=>s.replace(/^package:/,''));
            if(!apks.length||apks.some(f=>!f.endsWith('.apk')))throw fail('J02_APK_MISSING');
            return {package:pkg,versionName:/versionName=([^\s]+)/.exec(info)?.[1]||null,versionCode:/versionCode=(\d+)/.exec(info)?.[1]||null,
                apks:apks.sort().map(file=>({file,sha256:fileSha(file)}))};
        });
        const {viewport,rotation}=layout(read(['shell','dumpsys','window','displays']));
        return{serial,model:read(['shell','getprop','ro.product.model']).trim(),android:read(['shell','getprop','ro.build.version.release']).trim(),
            romFingerprint:read(['shell','getprop','ro.build.fingerprint']).trim(),displayId:0,
            viewport,rotation,apps,stateFiles:stateFiles.map(file=>({file,sha256:fileSha(file)}))};
    };
    return{executeAdb,read,gate,inspect};
}
module.exports={device};
