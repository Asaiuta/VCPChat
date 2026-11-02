'use strict';
/**
 * 把 Loom 应用清单的 startUrl 对齐到显示屏的真实地址。
 *
 * 必要性：DISPLAY_PORT 被占用时服务会退让到随机端口，而 AppData/LoomApps/android-mirror
 * 里的 startUrl 是写死的。不同步的话，用户点开应用只会看到连接被拒绝。
 * 只在确有差异时写盘，避免每次启动都无谓改动用户文件。
 */
async function syncLoomAppUrl({ manager, appId = 'android-mirror', url, logger = console }) {
    if (!manager?.manifests || typeof manager.saveApp !== 'function') return null;

    const existing = manager.manifests.get(appId);
    if (!existing) return null;

    const current = String(existing.startUrl || '');
    const normalizedCurrent = current.replace(/\/+$/, '');
    const normalizedNext = String(url || '').replace(/\/+$/, '');
    if (!normalizedNext || normalizedCurrent === normalizedNext) return null;

    try {
        const sources = await manager.readSources(appId);
        await manager.saveApp({
            originalId: appId,
            manifest: { ...sources.manifest, startUrl: url },
            css: sources.css,
            js: sources.js,
        });
        logger.log?.(`[AndroidController] Loom 应用 ${appId} 的地址已同步为 ${url}`);
        return { appId, from: current, to: url };
    } catch (error) {
        logger.warn?.(`[AndroidController] 同步 Loom 应用地址失败：${error.message}`);
        return null;
    }
}

module.exports = { syncLoomAppUrl };
