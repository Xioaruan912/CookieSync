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
  Array.isArray(value) && value.every(item => item && typeof item.key === 'string' && typeof item.value === 'string')
    ? (value as ILocalStorageItem[])
    : undefined;

/** Validates a content script capture; a missing session list means "not reported". */
export function readObserved(
  message: { localStorageItems?: unknown; sessionStorageItems?: unknown; origin?: unknown },
  tabUrl: string,
): StorageSnapshot | undefined {
  const local = validStorageItems(message?.localStorageItems);
  if (!local) return undefined;
  const origin = pageOrigin(tabUrl);
  if (message.origin && message.origin !== origin) return undefined;
  const session = validStorageItems(message?.sessionStorageItems);
  return {
    origin: origin || '',
    localStorageItems: local,
    ...(session ? { sessionStorageItems: session } : {}),
    truncated: 0,
  };
}

async function ensureTabBridge(tabId: number): Promise<boolean> {
  const scripting = (chrome as unknown as {
    scripting?: {
      executeScript?: (details: { target: { tabId: number }; files: string[] }) => Promise<unknown>;
    };
  }).scripting;
  if (typeof scripting?.executeScript !== 'function') return false;
  try {
    await scripting.executeScript({ target: { tabId }, files: ['content/index.iife.js'] });
    await new Promise(resolve => setTimeout(resolve, 120));
    return true;
  } catch {
    return false;
  }
}

/**
 * Gently reads one matching open tab's origin-tagged page storage.
 * Skips discarded tabs, auto-injects the content bridge if disconnected,
 * and never opens new tabs or forces page reloads.
 */
export async function readPageStorage(
  host: string,
  options: { tabs?: chrome.tabs.Tab[]; origin?: string; includeIndexedDb?: boolean } = {},
): Promise<StorageSnapshot | undefined> {
  const settings = await settingsStorage.get();
  const includeLocal = settings.includeLocalStorage !== false;
  const includeSession = await sessionStorageFor(host);
  const includeIndexedDb = options.includeIndexedDb !== false && (await indexedDbFor(host));
  if (!includeLocal && !includeSession && !includeIndexedDb) return undefined;

  const tabs = options.tabs || (await chrome.tabs.query({}));
  for (const tab of tabs) {
    if (!tab.id || !tab.url?.startsWith('http') || tab.incognito || tab.discarded) continue;
    let hostname: string;
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      continue;
    }
    if (!matchesSiteScope(host, hostname)) continue;
    const tabOrigin = pageOrigin(tab.url) || '';
    if (options.origin && options.origin !== tabOrigin) continue;

    const queryTab = async (): Promise<StorageSnapshot | undefined> => {
      const newer = await chrome.tabs.sendMessage(tab.id!, {
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
        if (result.origin && result.origin !== tabOrigin) return undefined;
        const local = validStorageItems(result.localStorageItems);
        const session = validStorageItems(result.sessionStorageItems);
        if (!includeLocal || local) {
          return {
            origin: tabOrigin,
            localStorageItems: includeLocal ? local || [] : [],
            ...(includeSession && session ? { sessionStorageItems: session } : {}),
            ...(includeIndexedDb && Array.isArray(result.indexedDBRecords)
              ? { indexedDBRecords: result.indexedDBRecords, skippedIndexedDB: result.skippedIndexedDB || [] }
              : {}),
            truncated: 0,
          };
        }
      }
      return undefined;
    };

    try {
      const snapshot = await queryTab();
      if (snapshot) return snapshot;
    } catch {
      if (await ensureTabBridge(tab.id)) {
        try {
          const snapshot = await queryTab();
          if (snapshot) return snapshot;
        } catch {
          /* Fall through to legacy message below. */
        }
      }
    }

    const legacy = await chrome.tabs
      .sendMessage(tab.id, { type: 'GetLocalStorage', payload: { domain: host } })
      .catch(() => undefined);
    const local = validStorageItems(legacy?.result);
    if (includeLocal && legacy?.isOk && local) {
      return {
        origin: tabOrigin,
        localStorageItems: local,
        truncated: 0,
      };
    }
  }
  return undefined;
}
