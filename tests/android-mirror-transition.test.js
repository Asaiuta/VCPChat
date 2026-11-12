'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isShellPrivateMirror } = require('../VCPDistributedServer/Plugin/AndroidController/lib/display-target');
const mirror = { type:'VIRTUAL', ownerPackage:'com.android.shell', ownerUid:2000,
    uniqueId:'virtual:com.android.shell,2000,scrcpy,217', flags:['FLAG_PRIVATE'] };
const base = '  Display: mDisplayId=221\n  mCurrentFocus=null\n  mFocusedApp=null\n';
const shared = '    TransitionController:\n        mPlayingTransitions:1\n   ChangeInfo{container=ActivityRecord{main-display} flags=0x0}\n        ActivityRecord{main-display}\n      mWaitingTransitions:0\n    BLASTSyncEngine:\n       mActiveSyncs.size():0\n';
test('shared transition references on an otherwise proven shell mirror do not imply hosted activity', () => {
    assert.equal(isShellPrivateMirror(mirror,base+shared),true);
    assert.equal(isShellPrivateMirror(mirror,(base+shared).replaceAll('\n','\r\n')),true);
});
test('hosted activities, focus and non-mirror identity still fail closed', () => {
    for (const text of [base+' ActivityRecord{local}\n'+shared,base+shared+' ActivityRecord{local}\n',
        (base+shared).replace('mCurrentFocus=null','mCurrentFocus=Window{active}'),
        (base+shared).replace('mFocusedApp=null','mFocusedApp=ActivityRecord{local}')]) assert.equal(isShellPrivateMirror(mirror,text),false);
    for(const extra of [{ownerUid:1000},{ownerPackage:'other.app'},{type:'INTERNAL'},
        {flags:['FLAG_PRIVATE','FLAG_OWN_CONTENT_ONLY']},{flags:['FLAG_PRIVATE','FLAG_TRUSTED']}])
        assert.equal(isShellPrivateMirror({...mirror,...extra},base+shared),false);
});
test('missing, reversed, duplicated or misindented section boundaries do not erase activity evidence', () => {
    for(const text of [base+shared.replace('    BLASTSyncEngine:','    OtherSection:'),
        base+shared.replace('    BLASTSyncEngine:','  BLASTSyncEngine:'),base+shared+shared,
        base+'    BLASTSyncEngine:\n'+shared.replace('    BLASTSyncEngine:','    OtherSection:')])
        assert.equal(isShellPrivateMirror(mirror,text),false);
});
