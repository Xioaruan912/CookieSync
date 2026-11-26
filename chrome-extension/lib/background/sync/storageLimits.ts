import {
  matchesSiteScope,
  pageOrigin,
  pickAutomaticStorage,
  sessionStorageEnabled,
  syncDestinationKey,
} from '@sync-your-cookie/shared';
import { isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { syncRuntimeStorage } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { getJobs } from './capture';
import { readPageStorage } from './pageBridge';

/** Recompute warnings from open, in-scope pages. Only local diagnostics are updated. */
export async function recheckStorageLimits() {
  const [warnings, tabs, settings, config, cache, rules, jobs] = await Promise.all([
    syncRuntimeStorage.getTruncatedMap(),
    chrome.tabs.query({}),
    settingsStorage.get(),
    domainConfigStorage.get(),
    cookieStorage.get(),
    readSiteRules(),
    syncDestinationKey().then(getJobs),
  ]);
  const openOrigins = [
    ...new Set(
      tabs
        .filter(tab => !tab.incognito)
        .map(tab => pageOrigin(tab.url))
        .filter((origin): origin is string => !!origin),
    ),
  ];
  let checkedSites = 0;
  for (const site of Object.keys(warnings)) {
    if (!isSiteAllowed(site, rules)) continue;
    let checked = false;
    for (const origin of openOrigins) {
      if (!matchesSiteScope(site, new URL(origin).hostname)) continue;
      const observed = await readPageStorage(site, { tabs, origin, includeIndexedDb: false });
      if (!observed) continue;
      const picked = pickAutomaticStorage(
        observed,
        jobs[site],
        cache.domainCookieMap?.[site] || {},
        sessionStorageEnabled(settings.includeSessionStorage, config.domainMap[site]?.includeSessionStorage),
        settings.includeLocalStorage !== false,
      );
      if (!picked.truncation) continue;
      await syncRuntimeStorage.recordTruncated(site, origin, picked.truncation);
      checked = true;
    }
    if (checked) checkedSites++;
  }
  return { checkedSites, remaining: Object.keys(await syncRuntimeStorage.getTruncatedMap()).length };
}
