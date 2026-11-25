import {
  indexedDbEnabled,
  matchesSiteScope,
  pageOrigin,
  sessionStorageEnabled,
  type PendingSyncJob,
  type StorageSnapshot,
} from '@sync-your-cookie/shared';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';

type ILocalStorageItem = PendingSyncJob['localStorageItems'][number];

export async function sessionStorageFor(host: string): Promise<boolean> {
  const settings = await settingsStorage.get();
  const config = (await domainConfigStorage.get()).domainMap[host];
  return sessionStorageEnabled(settings.includeSessionStorage, config?.includeSessionStorage);
}

export async function indexedDbFor(host: string): Promise<boolean> {
  const settings = await settingsStorage.get();
  const config = (await domainConfigStorage.get()).domainMap[host];
  return indexedDbEnabled(settings.includeIndexedDB, config?.includeIndexedDB);
}

const validStorageItems = (value: unknown): ILocalStorageItem[] | undefined =>
  Array.isArray(value) &&
  value.every(item => item && typeof item.key === 'string' && typeof item.value === 'string')
    ? (value as ILocalStorageItem[])
    : undefined;

/** Validates a content script capture; a missing session list means "not reported". */
export function readObserved(
  message: { localStorageItems?: unknown; sessionStorageItems?: unknown; origin?: unknown },
  tabUrl: string,
): StorageSnapshot | undefined {
  const local = validStorageItems(message?.localStorageItems);
  if (!local) return undefined;
  const session = validStorageItems(message?.sessionStorageItems);
  return {
    origin: typeof message?.origin === 'string' && message.origin ? message.origin : pageOrigin(tabUrl) || '',
    localStorageItems: local,
    ...(session ? { sessionStorageItems: session } : {}),
    truncated: 0,
  };
}

/**
 * Gently reads one matching open tab's origin-tagged page storage.
 * Falls back to the legacy GetLocalStorage message for tabs running older scripts.
 * Never opens new tabs or forces page reloads.
 */
export async function readPageStorage(host: string): Promise<StorageSnapshot | undefined> {
  const settings = await settingsStorage.get();
  const includeLocal = settings.includeLocalStorage !== false;
  const includeSession = await sessionStorageFor(host);
  const includeIndexedDb = await indexedDbFor(host);
  if (!includeLocal && !includeSession && !includeIndexedDb) return undefined;

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url?.startsWith('http') || tab.incognito) continue;
    let hostname: string;
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      continue;
    }
    if (!matchesSiteScope(host, hostname)) continue;
    const tabOrigin = pageOrigin(tab.url) || '';
    try {
      const newer = await chrome.tabs.sendMessage(tab.id, {
        type: 'GetPageStorage',
        payload: { domain: host, includeSessionStorage: includeSession, includeIndexedDB: includeIndexedDb },
      });
      if (newer?.isOk && newer.result && !Array.isArray(newer.result)) {
        const result = newer.result as {
          origin?: string;
          localStorageItems?: ILocalStorageItem[];
          sessionStorageItems?: ILocalStorageItem[];
          indexedDBRecords?: StorageSnapshot['indexedDBRecords'];
          skippedIndexedDB?: string[];
        };
        return {
          origin: result.origin || tabOrigin,
          localStorageItems: includeLocal ? result.localStorageItems || [] : [],
          sessionStorageItems: includeSession ? result.sessionStorageItems || [] : [],
          ...(includeIndexedDb && Array.isArray(result.indexedDBRecords)
            ? { indexedDBRecords: result.indexedDBRecords, skippedIndexedDB: result.skippedIndexedDB || [] }
            : {}),
          truncated: 0,
        };
      }
    } catch {
      /* Older content script: fall through to legacy message below. */
    }

    const legacy = await chrome.tabs
      .sendMessage(tab.id, { type: 'GetLocalStorage', payload: { domain: host } })
      .catch(() => undefined);
    if (legacy?.isOk) {
      return {
        origin: tabOrigin,
        localStorageItems: includeLocal ? (legacy.result as ILocalStorageItem[]) || [] : [],
        sessionStorageItems: [],
        truncated: 0,
      };
    }
  }
  return undefined;
}
