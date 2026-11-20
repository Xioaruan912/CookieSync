import {
  buildOverviewRows,
  canonicalSiteHost,
  check,
  collectSiteCookies,
  editSyncJobs,
  matchesSiteScope,
  pickAutomaticStorage,
  pullAndSetCookies,
  pushCookies,
  sessionStorageEnabled,
  syncDestinationKey,
  type OverviewPendingEntry,
} from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteActivityStorage } from '@sync-your-cookie/storage/lib/siteActivityStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { isAutomaticCookieAllowed, isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { readPageStorage } from './automaticSync';

const truncatedKey = 'cookiesync-storage-truncated';

/** Only the extension's own pages may read or drive the overview. */
const fromExtensionPage = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));

async function overviewPayload() {
  const config = await domainConfigStorage.get();
  const rules = await readSiteRules();
  const key = await syncDestinationKey();
  const jobs = ((await chrome.storage.local.get(key))[key] || {}) as Record<string, OverviewPendingEntry>;
  const truncated = ((await chrome.storage.local.get(truncatedKey))[truncatedKey] || {}) as Record<string, number>;
  const settings = await settingsStorage.get();
  const dav = await webdavStorage.get();
  const feedback = await syncFeedbackStorage.get();
  return {
    rows: buildOverviewRows({
      domainMap: config.domainMap,
      pending: jobs,
      cached: (await cookieStorage.get()).domainCookieMap || {},
      health: await siteHealthStorage.get(),
      activity: await siteActivityStorage.get(),
      truncated,
      isListed: (domain: string) => isSiteAllowed(domain, rules),
    }),
    connected: !!dav.url?.trim() && !!dav.username?.trim() && !!dav.password,
    sessionDefault: settings.includeSessionStorage === true,
    status: await autoSyncStatusStorage.get(),
    schemaWarning: feedback.schemaWarning,
    generatedAt: Date.now(),
  };
}

async function requireSite(domain: string) {
  await check();
  const rules = await readSiteRules();
  if (!isSiteAllowed(domain, rules)) throw new Error('该网站不在同步名单内');
  const config = (await domainConfigStorage.get()).domainMap[domain];
  if (!config) throw new Error('该网站尚未登记，请先打开网站页面');
  return { config, rules };
}

export async function pushSite(domain: string) {
  const { config, rules } = await requireSite(domain);
  const settings = await settingsStorage.get();
  const sessionEnabled = sessionStorageEnabled(settings.includeSessionStorage, config.includeSessionStorage);
  const url = config.sourceUrl || `https://${domain}`;
  const cookies = (await collectSiteCookies(url)).filter(cookie =>
    isAutomaticCookieAllowed(cookie, domain, rules),
  );
  const previous = (await cookieStorage.get()).domainCookieMap?.[domain];
  const picked = pickAutomaticStorage(
    await readPageStorage(domain),
    undefined,
    previous || {},
    sessionEnabled,
    settings.includeLocalStorage !== false,
  );
  if (!cookies.length && !picked.localStorageItems.length && !picked.sessionStorageItems.length)
    throw new Error('未找到可上传的 Cookie 或页面存储');
  const result = await pushCookies(
    domain,
    cookies,
    picked.localStorageItems,
    navigator.userAgent,
    picked.sessionStorageItems,
  );
  if (!result?.success) throw new Error('推送失败，请检查连接和加密设置');
  const key = await syncDestinationKey();
  await editSyncJobs(key, jobs => {
    if (!jobs[domain]) return jobs;
    const next = { ...jobs };
    delete next[domain];
    return next;
  });
  return {
    domain,
    cookies: cookies.length,
    localStorageItems: picked.localStorageItems.length,
    sessionStorageItems: picked.sessionStorageItems.length,
  };
}

export async function pullSite(domain: string, reload = true) {
  const { config, rules } = await requireSite(domain);
  const url = config.sourceUrl || `https://${domain}`;
  await pullAndSetCookies(url, domain, reload, undefined, undefined, cookie =>
    isAutomaticCookieAllowed(cookie, domain, rules),
  );
  // The reloaded page must not immediately re-pull this site.
  await chrome.storage.session.set({ [`cookiesync-pulled-${domain}`]: Date.now() });
  const key = await syncDestinationKey();
  await editSyncJobs(key, jobs => {
    if (!jobs[domain]) return jobs;
    const next = { ...jobs };
    delete next[domain];
    return next;
  });
  return { domain };
}

export function initOverview() {
  chrome.runtime.onMessage.addListener((message, sender, reply) => {    if (!fromExtensionPage(sender)) return;
    if (message?.type === 'CookieSyncOverview') {
      void overviewPayload()
        .then(result => reply({ isOk: true, result }))
        .catch(error => reply({ isOk: false, msg: error?.message || '读取总览失败' }));
      return true;
    }
    if (message?.type === 'CookieSyncPushSite' && typeof message.domain === 'string') {
      void pushSite(message.domain)
        .then(result => reply({ isOk: true, result }))
        .catch(error => reply({ isOk: false, msg: error?.message || '推送失败' }));
      return true;
    }
    if (message?.type === 'CookieSyncPullSite' && typeof message.domain === 'string') {
      void pullSite(message.domain, message.reload !== false)
        .then(result => reply({ isOk: true, result }))
        .catch(error => reply({ isOk: false, msg: error?.message || '拉取失败' }));
      return true;
    }
    return;
  });

  void syncBadge();
  chrome.storage.local.onChanged.addListener(changes => {
    if (changes['cookiesync-auto-status']) void syncBadge();
  });

  // Alt+Shift+U / Alt+Shift+D act on the active tab's site. Same rules as the
  // overview buttons: unknown sites are refused instead of guessed.
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
        await chrome.action.setBadgeText({ text: '' });
        await chrome.action.setTitle({ title: 'CookieSync' });
      } catch (error) {
        // Never log cookie values; the message is a short, user-facing reason.
        await chrome.action.setBadgeBackgroundColor({ color: '#B4453C' });
        await chrome.action.setBadgeText({ text: '!' });
        await chrome.action.setTitle({
          title: `CookieSync：${error instanceof Error ? error.message : '操作失败'}`,
        });
      }
    })();
  });
}

/** Pending count on the toolbar icon; no extra permission needed. */
async function syncBadge() {
  try {
    const status = await autoSyncStatusStorage.get();
    const count = status.pendingCount || 0;
    await chrome.action.setBadgeBackgroundColor({ color: '#C8A24A' });
    await chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '' });
  } catch {
    /* Badges are cosmetic. */
  }
}
