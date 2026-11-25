import {
  buildOverviewRows,
  canonicalSiteHost,
  matchesSiteScope,
  RuntimeMessageType,
  syncDestinationKey,
  type OverviewPendingEntry,
} from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteActivityStorage } from '@sync-your-cookie/storage/lib/siteActivityStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import { deviceIdentityStorage, syncRuntimeStorage } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { clearTransientBadgeError, setTransientBadgeError } from './badgeController';
import { registerExtensionHandler } from './router';
import { pullSingleSite, pushSingleSite } from './sync/batch';

async function overviewPayload() {
  const [config, rules, key, truncated, indexedDbSkipped, settings, dav, feedback, identity, status] =
    await Promise.all([
      domainConfigStorage.get(),
      readSiteRules(),
      syncDestinationKey(),
      syncRuntimeStorage.getTruncatedMap(),
      syncRuntimeStorage.getSkippedIndexedDbMap(),
      settingsStorage.get(),
      webdavStorage.get(),
      syncFeedbackStorage.get(),
      deviceIdentityStorage.ensure(),
      autoSyncStatusStorage.get(),
    ]);
  const jobs = ((await chrome.storage.local.get(key))[key] || {}) as Record<string, OverviewPendingEntry>;

  return {
    rows: buildOverviewRows({
      domainMap: config.domainMap,
      pending: jobs,
      cached: (await cookieStorage.get()).domainCookieMap || {},
      health: await siteHealthStorage.get(),
      activity: await siteActivityStorage.get(),
      truncated,
      indexedDbSkipped,
      isListed: (domain: string) => isSiteAllowed(domain, rules),
    }),
    connected: !!dav.url?.trim() && !!dav.username?.trim() && !!dav.password,
    sessionDefault: settings.includeSessionStorage === true,
    status: {
      ...status,
      localDeviceId: status.localDeviceId || identity.deviceId,
      localDeviceName: status.localDeviceName || identity.deviceName,
    },
    schemaWarning: feedback.schemaWarning,
    generatedAt: Date.now(),
  };
}

export async function pushSite(domain: string) {
  return pushSingleSite(domain, { requireListed: true, createSnapshot: true });
}

export async function pullSite(domain: string, reload = true) {
  return pullSingleSite(domain, { requireListed: true, createSnapshot: true, reload });
}

export function initOverview() {
  registerExtensionHandler(RuntimeMessageType.Overview, async () => {
    const result = await overviewPayload();
    return { isOk: true, msg: 'ok', result };
  });

  registerExtensionHandler(RuntimeMessageType.PushSite, async message => {
    if (typeof message.domain !== 'string') throw new Error('缺少网站域名');
    const result = await pushSite(message.domain);
    clearTransientBadgeError();
    return { isOk: true, msg: '推送成功', result };
  });

  registerExtensionHandler(RuntimeMessageType.PullSite, async message => {
    if (typeof message.domain !== 'string') throw new Error('缺少网站域名');
    const result = await pullSite(message.domain, message.reload !== false);
    clearTransientBadgeError();
    return { isOk: true, msg: '拉取成功', result };
  });

  // Alt+Shift+U / Alt+Shift+D act on the active tab's site via the same unified pipeline.
  chrome.commands?.onCommand.addListener(command => {
    if (command !== 'push-current-site' && command !== 'pull-current-site') return;
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.url?.startsWith('http')) return;
      let hostname: string;
      try {
        hostname = new URL(tab.url).hostname;
      } catch {
        return;
      }
      const config = await domainConfigStorage.get();
      const domain =
        Object.keys(config.domainMap).find(site => matchesSiteScope(site, hostname)) || canonicalSiteHost(hostname);
      try {
        if (command === 'push-current-site') await pushSite(domain);
        else await pullSite(domain);
        clearTransientBadgeError();
      } catch (error) {
        setTransientBadgeError(error instanceof Error ? error.message : '操作失败');
      }
    })();
  });
}
