'use strict';

const params = new URLSearchParams(location.search);
if (params.get('state') === 'error') {
    document.getElementById('state-label').textContent = '服务暂不可用';
    document.getElementById('title').textContent = '还不能打开显示屏';
    document.getElementById('message').textContent = params.get('message') || '请检查安卓控制器是否启用，然后重试。';
    document.getElementById('retry').hidden = false;
}
