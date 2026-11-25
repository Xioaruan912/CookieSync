import { isSingleSessionSite } from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { syncRuntimeStorage, type StandbySwitchedTab } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';

function tabHostname(url?: string): string | undefined {
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Discards idle single-session tabs (e.g. 115) on a standby or lost-lease PC so
 * background page JS heartbeats never kick the active computer offline.
 *
 * Non-intrusive guarantee:
 * - Never closes any tab.
 * - Never opens new tabs in front of the user.
 * - Only switches an active single-session tab to an existing sibling non-single-session tab
 *   when the OS is locked or another PC has explicitly taken over the cloud lease.
 */
export async function pauseIdleSingleSessionTabs(options: { includeActiveIfLockedOrLostLease: boolean }): Promise<number> {
  const settings = await settingsStorage.get();
  if (settings.discardIdleSingleSessionTabs === false) return 0;
  if (typeof chrome.tabs?.query !== 'function' || typeof chrome.tabs?.discard !== 'function') return 0;

  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  const switchedRecords: StandbySwitchedTab[] = [];
  let discarded = 0;

  for (const tab of tabs) {
    if (!tab.id || tab.incognito || tab.discarded) continue;
    const host = tabHostname(tab.url);
    if (!host || !isSingleSessionSite(host)) continue;

    if (tab.active) {
      if (!options.includeActiveIfLockedOrLostLease || tab.windowId === undefined) continue;
      // Only shift focus if another non-single-session tab already exists in the same window.
      const sibling = tabs.find(
        candidate =>
          candidate.id &&
          candidate.id !== tab.id &&
          candidate.windowId === tab.windowId &&
          !candidate.incognito &&
          !isSingleSessionSite(tabHostname(candidate.url) || ''),
      );
      if (!sibling?.id) continue;
      try {
        await chrome.tabs.update(sibling.id, { active: true });
        await chrome.tabs.discard(tab.id);
        discarded++;
        switchedRecords.push({
          windowId: tab.windowId,
          originalTabId: tab.id,
          fallbackTabId: sibling.id,
          domain: host,
          at: Date.now(),
        });
      } catch {
        /* Best effort; never interrupt browser stability. */
      }
      continue;
    }

    try {
      await chrome.tabs.discard(tab.id);
      discarded++;
    } catch {
      /* Tab may not be discardable (e.g. playing audio or devtools attached). */
    }
  }

  if (switchedRecords.length) {
    await syncRuntimeStorage.setStandbySwitchedTabs(switchedRecords).catch(() => {});
  }
  await autoSyncStatusStorage.update({ discardedTabsCount: discarded }).catch(() => {});
  return discarded;
}

/**
 * After this computer takes back control and restores fresh cookies, gently
 * restores any tab that was shifted aside during lock/lost-lease so clicking or
 * returning brings the user right back to their freshly logged-in 115 page.
 */
export async function restoreStandbySwitchedTabs(): Promise<void> {
  if (typeof chrome.tabs?.get !== 'function' || typeof chrome.tabs?.update !== 'function') return;
  const records = await syncRuntimeStorage.getStandbySwitchedTabs().catch(() => [] as StandbySwitchedTab[]);
  if (!records.length) return;
  await syncRuntimeStorage.setStandbySwitchedTabs([]).catch(() => {});

  for (const record of records) {
    try {
      const [original, fallback] = await Promise.all([
        chrome.tabs.get(record.originalTabId).catch(() => undefined),
        chrome.tabs.get(record.fallbackTabId).catch(() => undefined),
      ]);
      // Only restore if the user hasn't already navigated to another tab in that window.
      if (original?.id && fallback?.active && original.windowId === record.windowId) {
        await chrome.tabs.update(original.id, { active: true });
      }
    } catch {
      /* Ignore closed tabs. */
    }
  }
  await autoSyncStatusStorage.update({ discardedTabsCount: 0 }).catch(() => {});
}
