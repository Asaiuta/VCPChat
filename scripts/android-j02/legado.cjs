'use strict';
const path=require('node:path');
const S=require('./storage.cjs'),{fail}=require('./contract.cjs');
async function init(environmentFile,adbPath,snapshotJar,output){
    const root=path.resolve(__dirname,'../..'),settingsFile=path.join(root,'AppData/settings.json');
    const settings=S.read(settingsFile),{GlobalJevService}=require(path.join(root,'modules/services/globalJevService.js'));
    const config=await new GlobalJevService({settingsManager:{readSettings:async()=>settings},logger:{log(){},warn(){},error(){}}}).getStatus();
    if(!config.configured)throw fail('J02_MODEL_NOT_CONFIGURED');
    const pkg='io.legado.app.release',id=name=>pkg+':id/'+name;
    const query='魔女之旅',author='白石定规',budget={timeoutMs:120000,maxActions:3,maxObservations:96,maxModelCalls:8};
    const manifest={schemaVersion:1,batchId:path.basename(output,path.extname(output)),datasetId:'legado-user-task-20261107',stage:'exploration',
        registry:path.join(path.dirname(path.resolve(output)),'j02-study-registry.jsonl'),environmentFile:path.resolve(environmentFile),
        tools:{adbPath:path.resolve(adbPath),snapshotJar:path.resolve(snapshotJar)},arms:[
            {id:'rules',unavailableReason:'FAIR_RULES_BINDING_NOT_ESTABLISHED'},
            {id:'original',unavailableReason:'ORIGINAL_JEV_CHECKOUT_NOT_FROZEN'},
            {id:'candidate',root,intent:'ui_task',decision:'jev',settingsFile,model:{provider:config.provider,requestedAlias:config.model,
                expectedReturnedVersion:null,endpointSha256:S.sha(config.url)}}],
        tasks:[{id:'wandering-witch-author',family:'legado-book-search',clusterId:'user-task-20261107-001',split:'calibration',
            source:{kind:'user_request',reference:'搜索魔女之旅，找到作者为白石定规的那本'},stratum:'search',budget,
            reset:{method:'force_stop_launch',waitMs:4000},start:{version:'raw-ui-v1',package:pkg,all:[{type:'visible',target:{id:id('menu_search')}}]},
            finish:{version:'raw-ui-v1',package:pkg,all:[{type:'text',target:{id:id('search_src_text')},equals:query},
                {type:'row',target:{id:id('recycler_view')},fields:[{target:{id:id('tv_name')},equals:query,normalize:'NFC_trim'},
                    {target:{id:id('tv_author')},equals:author,normalize:'NFC_trim',stripPrefix:'作者：'}]}]},
            requests:{candidate:{package:pkg,goal:'搜索魔女之旅，找到作者为白石定规的同一结果条目；不打开、下载或收藏。',
                inputs:{query},operations:['Tap','Fill','Scroll','Back','ImeAction'],loading:{id:id('fb_stop')},completion:{all:[
                    {type:'text',text:{id:id('search_src_text'),inputRef:'query'}},{type:'row',id:id('recycler_view'),fields:[
                        {id:id('tv_name'),equals:query,normalize:'NFC_trim'},{id:id('tv_author'),equals:author,normalize:'NFC_trim',stripPrefix:'作者：'}]}]}}},
            rulesExclusion:'此真实任务尚无经验证的公平 rules 目标绑定'}],
        gates:{alpha:0.05,riskCorrection:'per_metric',riskUnit:'task',independence:'当前只有同一用户任务的相关工程 cluster；不满足独立验收。',
            minIndependent:149,maxRisk:0.02,minSuccess:0.9,minSuccessLower:0.8,maxUnknown:0.05,maxEscalation:0.2,minRecoveryLower:0.8,maxP95Ms:120000,
            requiredStrata:['search'],requiredFeatures:[]},auditor:{id:'independent-reviewer',method:'使用任务外证据逐写审核目标、输入和重复派发；完成由独立快照检查。'},
        calibrationEvidence:null};
    require('./contract.cjs').validate('manifest',manifest);S.write(path.resolve(output),manifest);
    return{output:path.resolve(output),stage:'exploration',calibrated:false,note:'local configuration only; no model or device request'};
}
module.exports={init};
