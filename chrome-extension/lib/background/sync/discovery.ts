import {
  canonicalSiteHost,
  collectSiteCookies,
  matchesSiteScope,
  type StorageSnapshot,
} from '@sync-your-cookie/shared';
import { isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { indexedDbFor, readPageStorage, sessionStorageFor } from './pageBridge';

export async function discoverVisitedSite(
  rawUrl: string,
  observed?: StorageSnapshot,
  onDiscovered?: () => void,
): Promise<string | undefined> {
  let page: URL;
  try {
    page = new URL(rawUrl);
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password) return;
  const settings = await settingsStorage.get();
  if (!isSiteAllowed(page.hostname, await readSiteRules())) return;

  const config = await domainConfigStorage.get();
  const host =
    Object.keys(config.domainMap).find(site => matchesSiteScope(site, page.host)) || canonicalSiteHost(page.host);
  const sourceUrl = page.origin + page.pathname;
  if (config.domainMap[host]) {
    if (config.domainMap[host].sourceUrl !== sourceUrl) {
      await domainConfigStorage.updateItem(host, { sourceUrl });
    }
    return host;
  }
  if (settings.backgroundSync === false || settings.autoDiscoverSites === false) return;

  const cookies = await collectSiteCookies(sourceUrl);
  const storageNeeded =
    settings.includeLocalStorage !== false || (await sessionStorageFor(host)) || (await indexedDbFor(host));
  const storage = storageNeeded ? (observed ?? (await readPageStorage(host))) : undefined;
  const cached = (await cookieStorage.get()).domainCookieMap?.[host];
  const storageCount =
    (storage?.localStorageItems.length || 0) +
    (storage?.sessionStorageItems?.length || 0) +
    (storage?.indexedDBRecords?.length || 0);
  if (
    !cookies.length &&
    !storageCount &&
    !cached?.cookies?.length &&
    !cached?.localStorageItems?.length &&
    !cached?.sessionStorageItems?.length &&
    !cached?.indexedDBRecords?.length
  ) {
    return;
  }
  await domainConfigStorage.updateItem(host, { sourceUrl });
  onDiscovered?.();
  return host;
}

export async function discoverOpenSites(): Promise<void> {
  const settings = await settingsStorage.get();
  if (settings.backgroundSync === false || settings.autoDiscoverSites === false) return;
  const tabs = await chrome.tabs.query({});
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (!tab.url || tab.incognito) continue;
    let page: URL;
    try {
      page = new URL(tab.url);
    } catch {
      continue;
    }
    const hostKey = canonicalSiteHost(page.host);
    if (seen.has(hostKey)) continue;
    seen.add(hostKey);
    await discoverVisitedSite(tab.url);
  }
}
