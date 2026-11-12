'use strict';
const cp=require('node:child_process');
// A timed-out worker may own a Python bridge and adb subprocess. Killing only
// Node on Windows would leave those mutations running after the journal halts.
function terminate(child){
    if(process.platform==='win32'&&Number.isInteger(child.pid)){
        const killer=cp.spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
        killer.on('error',()=>child.kill());
        killer.on('exit',code=>{if(code!==0)child.kill();});
    }else child.kill();
}
module.exports={terminate};
