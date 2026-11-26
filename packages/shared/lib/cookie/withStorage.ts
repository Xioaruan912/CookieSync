import { domainContentHash, cookieContentHash, localStorageContentHash } from './fingerprint';
import { setSyncBaseline, getPendingRevision, settleManualSync } from './syncIdentity';
import { collectSiteCookies, cookieSetDetails, matchesSiteScope, syncCookieDomain } from './restore';
import { pageOrigin, selectScopedItems, sessionStorageEnabled, indexedDbEnabled } from './storageScope';
import { readRemoteCookiesBundle, type RemoteCookieBundle } from './remoteStore';
import { siteProfileFor } from '../siteProfiles';
import type { IndexedDbRecordLike } from './indexedDbCodec';
import { ICookie, ICookiesMap, IIndexedDBRecord, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import { Cookie, cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';
import { recordSiteActivity } from '@sync-your-cookie/storage/lib/siteActivityStorage';
import { AccountInfo, accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { MessageType, type PageStorageResult } from '@lib/message';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import {
  editAndWriteCookies,
  mergeAndWriteCookies,
  mergeAndWriteMultipleDomainCookies,
  readCookiesMap,
  removeAndWriteCookies,
  type PendingDomainCookie,
  type RemoteAdoption,
  type WriteResponse,
} from './withRemote';

// Single serialized operation queue per extension context prevents remote read/write races.
let cookieOperations: Promise<unknown> = Promise.resolve();
function withCookieOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = cookieOperations.then(operation, operation);
  cookieOperations = result.catch(() => {});
  return result;
}

export type PushMultipleResult = WriteResponse & { adopted: RemoteAdoption[] };
export type ReloadMode = boolean | 'smart';

export const readCookiesMapWithStatus = async (accountInfo: AccountInfo) => {
  return readCookiesMap(accountInfo);
};

async function runRemoteMutation<T extends WriteResponse>(
  mutator: (accountInfo: AccountInfo, bundle: RemoteCookieBundle) => Promise<[T, ICookiesMap]>,
): Promise<[T, ICookiesMap]> {
  const accountInfo = await accountStorage.get();
  await domainStatusStorage.update({ pushing: true }).catch(() => {});
  try {
    const bundle = await readRemoteCookiesBundle(accountInfo);
    const [res, cookieMap] = await mutator(accountInfo, bundle);
    if (res.success) {
      await cookieStorage.update(cookieMap);
    }
    return [res, cookieMap];
  } finally {
    await domainStatusStorage.update({ pushing: false }).catch(() => {});
  }
}

const pullCookiesImpl = async (isInit = false, force = false): Promise<Cookie> => {
  const accountInfo = await accountStorage.get();
  if (isInit && accountInfo.selectedProvider !== 'webdav') {
    return {};
  }
  const domainStatus = await domainStatusStorage.get();
  if (!force && domainStatus.pulling) {
    const cached = cookieStorage.getSnapshot();
    if (cached && Object.keys(cached.domainCookieMap || {}).length > 0) {
      return cached;
    }
  }
  await domainStatusStorage.update({ pulling: true }).catch(() => {});
  try {
    const bundle = await readRemoteCookiesBundle(accountInfo);
    return await cookieStorage.update(bundle.map, true);
  } finally {
    await domainStatusStorage.update({ pulling: false }).catch(() => {});
  }
};

const applyingRemoteHosts = new Map<string, number>();
export const isApplyingRemoteState = (host: string) => (applyingRemoteHosts.get(syncCookieDomain(host)) || 0) > 0;

const applyStorageToTab = async (
  tabId: number,
  host: string,
  origin: string,
  localItems: ILocalStorageItem[],
  sessionItems: ILocalStorageItem[],
  indexedDbItems: IndexedDbRecordLike[] = [],
) => {
  const readCurrent = async (): Promise<PageStorageResult | undefined> => {
    const newer = await chrome.tabs.sendMessage(tabId, {
      type: MessageType.GetPageStorage,
      payload: { domain: host, origin, includeSessionStorage: true, includeIndexedDB: true },
    });
    if (newer?.isOk && newer.result && !Array.isArray(newer.result)) return newer.result as PageStorageResult;
    const legacy = await chrome.tabs.sendMessage(tabId, {
      type: MessageType.GetLocalStorage,
      payload: { domain: host },
    });
    if (!legacy?.isOk) return undefined;
    return { origin, localStorageItems: (legacy.result as ILocalStorageItem[]) || [], sessionStorageItems: [] };
  };

  const current = await readCurrent().catch(() => undefined);
  const wanted = new Set(localItems.map(item => item.key));
  const currentLocal = (current?.localStorageItems || []).filter(item => wanted.has(item.key || ''));
  const localChanged =
    !current ||
    (await localStorageContentHash(currentLocal.map(item => ({ ...item, origin })))) !==
      (await localStorageContentHash(localItems));
  const sessionChanged =
    sessionItems.length > 0 &&
    (!current ||
      (await localStorageContentHash(current.sessionStorageItems || [])) !==
        (await localStorageContentHash(sessionItems)));
  const idbSignature = (records: IndexedDbRecordLike[] = []) =>
    JSON.stringify(
      [...records]
        .map(record => [record.database, record.store, record.key, record.value, record.origin || ''])
        .sort((a, b) => a.join('\0').localeCompare(b.join('\0'))),
    );
  const indexedDbChanged =
    indexedDbItems.length > 0 &&
    (!current || idbSignature(current.indexedDBRecords as IndexedDbRecordLike[]) !== idbSignature(indexedDbItems));
  if (!localChanged && !sessionChanged && !indexedDbChanged) return { localChanged, sessionChanged, indexedDbChanged };

  const response = await chrome.tabs
    .sendMessage(tabId, {
      type: MessageType.SetPageStorage,
      payload: {
        domain: host,
        origin,
        localStorageItems: localChanged ? localItems : undefined,
        sessionStorageItems: sessionChanged ? sessionItems : undefined,
        indexedDBRecords: indexedDbChanged ? indexedDbItems : undefined,
        replaceSession: true,
        replaceIndexedDB: true,
      },
    })
    .catch(async (error: unknown) => {
      if (localChanged) {
        return chrome.tabs.sendMessage(tabId, {
          type: MessageType.SetLocalStorage,
          payload: { domain: host, value: localItems },
        });
      }
      throw error;
    });
  if (response?.isOk === false) throw new Error('页面存储写入失败');
  return { localChanged, sessionChanged, indexedDbChanged };
};

const STORAGE_WRITE_ERROR = '页面存储写入失败';

async function ensureContentBridge(tabId: number): Promise<boolean> {
  const scripting = (chrome as unknown as {
    scripting?: {
      executeScript?: (details: { target: { tabId: number }; files: string[] }) => Promise<unknown>;
    };
  }).scripting;
  if (typeof scripting?.executeScript !== 'function') return false;
  try {
    await scripting.executeScript({
      target: { tabId },
      files: ['content/index.iife.js'],
    });
    await new Promise(resolve => setTimeout(resolve, 120));
    return true;
  } catch {
    return false;
  }
}

export const applyPageStorageToTabs = async (
  host: string,
  localItems: ILocalStorageItem[],
  sessionItems: ILocalStorageItem[] = [],
  options: {
    targetTabId?: number;
    includeSessionStorage?: boolean;
    includeIndexedDB?: boolean;
    indexedDBRecords?: IndexedDbRecordLike[];
  } = {},
) => {
  const tabs = await chrome.tabs.query({});
  const matching = tabs.filter(tab => {
    if (!tab.id || tab.incognito || tab.discarded || (options.targetTabId !== undefined && tab.id !== options.targetTabId))
      return false;
    if (!tab.url?.startsWith('http')) return false;
    try {
      return matchesSiteScope(host, new URL(tab.url).hostname);
    } catch {
      return false;
    }
  });
  let localChanged = false;
  let sessionChanged = false;
  let indexedDbChanged = false;
  let writeFailed = false;
  const changedTabIds: number[] = [];
  const restoredOrigins = new Set<string>();

  for (const tab of matching) {
    const origin = pageOrigin(tab.url);
    if (!origin) continue;
    const local = selectScopedItems(localItems, origin).map(item => ({ ...item, origin }));
    const session = options.includeSessionStorage
      ? selectScopedItems(sessionItems, origin).map(item => ({ ...item, origin }))
      : [];
    const idb = options.includeIndexedDB
      ? (options.indexedDBRecords || []).filter(record => !record.origin || record.origin === origin)
      : [];

    const runApply = () => applyStorageToTab(tab.id!, host, origin, local, session, idb);
    try {
      const result = await runApply();
      localChanged = localChanged || result.localChanged;
      sessionChanged = sessionChanged || result.sessionChanged;
      indexedDbChanged = indexedDbChanged || result.indexedDbChanged;
      restoredOrigins.add(origin);
      if (result.localChanged || result.sessionChanged || result.indexedDbChanged) changedTabIds.push(tab.id!);
    } catch (firstError) {
      if (firstError instanceof Error && firstError.message === STORAGE_WRITE_ERROR) {
        writeFailed = true;
        continue;
      }
      // Content script likely disconnected after extension reload/update: auto-inject and retry once.
      const injected = await ensureContentBridge(tab.id!);
      if (injected) {
        try {
          const retried = await runApply();
          localChanged = localChanged || retried.localChanged;
          sessionChanged = sessionChanged || retried.sessionChanged;
          indexedDbChanged = indexedDbChanged || retried.indexedDbChanged;
          restoredOrigins.add(origin);
          if (retried.localChanged || retried.sessionChanged || retried.indexedDbChanged) changedTabIds.push(tab.id!);
          continue;
        } catch (retryError) {
          if (retryError instanceof Error && retryError.message === STORAGE_WRITE_ERROR) {
            writeFailed = true;
            continue;
          }
        }
      }
      // Still unreachable (e.g. restricted/loading/crashed tab): do not throw a vague error at the user.
      // Cookies are already restored and PageReady will automatically apply LocalStorage on next load.
      if (restoredOrigins.has(origin) && !session.length && !idb.length) continue;
    }
  }
  if (writeFailed) {
    throw new Error(`${host} 的页面存储空间受限，未能写入 LocalStorage（Cookie 已恢复）`);
  }
  return { localChanged, sessionChanged, indexedDbChanged, changedTabIds };
};

export const applyLocalStorageToTabs = async (host: string, value: ILocalStorageItem[], targetTabId?: number) =>
  (await applyPageStorageToTabs(host, value, [], { targetTabId })).localChanged;

/**
 * Removes stale conflicting browser cookies (same cookie name on a different
 * domain/path, or stale profile login keys) before writing fresh remote cookies.
 */
async function removeStaleConflictingCookies(
  host: string,
  activeTabUrl: string,
  actual: chrome.cookies.Cookie[],
  eligible: ICookie[],
  cookieFilter?: (cookie: ICookie) => boolean,
): Promise<number> {
  if (typeof chrome.cookies?.remove !== 'function') return 0;
  const wanted = new Set(eligible.map(cookie => `${cookie.domain}|${cookie.path || '/'}|${cookie.name}`));
  const incomingNames = new Set(eligible.map(cookie => cookie.name || ''));
  const profileKeys = new Set(siteProfileFor(host)?.loginKeys || []);
  const page = new URL(activeTabUrl);

  const stale = actual.filter(cookie => {
    if (cookieFilter && !cookieFilter(cookie)) return false;
    const identity = `${cookie.domain}|${cookie.path || '/'}|${cookie.name}`;
    if (wanted.has(identity)) return false;
    return incomingNames.has(cookie.name) || profileKeys.has(cookie.name);
  });

  if (!stale.length) return 0;

  await Promise.allSettled(
    stale.map(cookie => {
      const protocol = cookie.secure ? 'https:' : page.protocol;
      const cleanDomain = cookie.domain.replace(/^\./, '');
      const url = `${protocol}//${cleanDomain}${cookie.path || '/'}`;
      return new Promise<void>(resolve => {
        try {
          const maybePromise = chrome.cookies.remove(
            { url, name: cookie.name, storeId: cookie.storeId },
            () => resolve(),
          ) as unknown as Promise<unknown> | undefined;
          if (maybePromise && typeof maybePromise.then === 'function') {
            maybePromise.then(() => resolve(), () => resolve());
          }
        } catch {
          resolve();
        }
      });
    }),
  );
  return stale.length;
}

function setSingleCookie(detail: chrome.cookies.SetDetails): Promise<chrome.cookies.Cookie> {
  return new Promise((resolve, reject) => {
    try {
      chrome.cookies.set(detail, res => {
        if (chrome.runtime.lastError || !res) {
          reject(new Error(chrome.runtime.lastError?.message || 'Cookie 写入失败'));
        } else {
          resolve(res);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function refreshAffectedTabs(host: string, reloadMode: ReloadMode, cookiesChanged: boolean, changedTabIds: number[]) {
  if (!reloadMode) return;
  const changed = new Set(changedTabIds);
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (!tab.url || !tab.id || tab.incognito) continue;
    let shouldAffect = changed.has(tab.id);
    if (!shouldAffect && cookiesChanged) {
      try {
        shouldAffect = matchesSiteScope(host, new URL(tab.url).hostname);
      } catch {
        shouldAffect = false;
      }
    }
    if (!shouldAffect) continue;
    if (reloadMode === 'smart' && !tab.active && typeof chrome.tabs.discard === 'function') {
      // Discarding inactive tabs reloads them lazily with fresh cookies when focused, zero jank.
      await chrome.tabs.discard(tab.id).catch(() => {
        chrome.tabs.reload(tab.id!);
      });
    } else {
      chrome.tabs.reload(tab.id);
    }
  }
}

export const pullAndSetCookies = async (
  activeTabUrl: string,
  host: string,
  isReload: ReloadMode = true,
  providedMap?: Cookie,
  targetTabId?: number,
  cookieFilter?: (cookie: ICookie) => boolean,
): Promise<Cookie> => {
  const scope = syncCookieDomain(host);
  let suppressed = false;
  const enterSuppression = () => {
    if (suppressed) return;
    suppressed = true;
    applyingRemoteHosts.set(scope, (applyingRemoteHosts.get(scope) || 0) + 1);
  };
  // When remote data is already in hand, suppress local cookie listeners immediately.
  if (providedMap) enterSuppression();
  try {
    const pendingRevision = await getPendingRevision(host);
    const cookieMap = providedMap || (await pullCookies());
    enterSuppression();
    const result = await restoreCookieMap(activeTabUrl, host, isReload, cookieMap, targetTabId, cookieFilter);
    const digest = await domainContentHash(cookieMap.domainCookieMap?.[host]);
    await setSyncBaseline(host, digest);
    await settleManualSync(host, pendingRevision, digest);
    void recordSiteActivity(host, 'pull');
    return result;
  } finally {
    if (suppressed) {
      const remaining = (applyingRemoteHosts.get(scope) || 1) - 1;
      if (remaining) applyingRemoteHosts.set(scope, remaining);
      else applyingRemoteHosts.delete(scope);
    }
  }
};

const restoreCookieMap = async (
  activeTabUrl: string,
  host: string,
  isReload: ReloadMode,
  providedMap?: Cookie,
  targetTabId?: number,
  cookieFilter?: (cookie: ICookie) => boolean,
): Promise<Cookie> => {
  const cookieMap = providedMap || (await pullCookies());
  const cookieDetails = (cookieMap?.domainCookieMap?.[host]?.cookies || []).filter(
    cookie => !cookieFilter || cookieFilter(cookie),
  );
  const settingsInfo = await settingsStorage.get();
  const storedLocal = cookieMap?.domainCookieMap?.[host]?.localStorageItems || [];
  const storedSession = cookieMap?.domainCookieMap?.[host]?.sessionStorageItems || [];
  const storedIdb = (cookieMap?.domainCookieMap?.[host]?.indexedDBRecords || []) as IndexedDbRecordLike[];
  const siteConfig = (await domainConfigStorage.get()).domainMap[host];
  const sessionEnabled = sessionStorageEnabled(settingsInfo.includeSessionStorage, siteConfig?.includeSessionStorage);
  const idbEnabled = indexedDbEnabled(settingsInfo.includeIndexedDB, siteConfig?.includeIndexedDB);
  const localStorageItems = settingsInfo.includeLocalStorage === false ? [] : storedLocal;
  const sessionItems = sessionEnabled ? storedSession : [];
  const idbItems = idbEnabled ? storedIdb : [];

  if (
    cookieFilter &&
    !cookieDetails.length &&
    !localStorageItems.length &&
    !sessionItems.length &&
    !idbItems.length
  ) {
    return cookieMap;
  }
  if (
    cookieDetails.length === 0 &&
    localStorageItems.length === 0 &&
    sessionItems.length === 0 &&
    idbItems.length === 0
  ) {
    throw new Error('远程没有该网站的登录数据，请先在已登录电脑推送');
  }

  // Collect full site-family cookies for Clean-Before-Write conflict detection.
  const actual = await collectSiteCookies(activeTabUrl).catch(() =>
    chrome.cookies.getAll({ domain: syncCookieDomain(new URL(activeTabUrl).hostname) }),
  );
  const eligible = cookieDetails.filter(cookie => !!cookieSetDetails(cookie, activeTabUrl));
  const wanted = new Set(eligible.map(cookie => `${cookie.domain}|${cookie.path || '/'}|${cookie.name}`));
  const relevant = actual.filter(cookie => wanted.has(`${cookie.domain}|${cookie.path || '/'}|${cookie.name}`));
  const removedStaleCount = await removeStaleConflictingCookies(host, activeTabUrl, actual, eligible, cookieFilter);
  const cookiesChanged =
    removedStaleCount > 0 || (await cookieContentHash(relevant)) !== (await cookieContentHash(eligible));

  if (cookiesChanged && eligible.length) {
    const profile = siteProfileFor(host);
    const requiredKeys = new Set(profile?.loginKeys || []);
    const writeEntries = eligible
      .map(cookie => ({ cookie, detail: cookieSetDetails(cookie, activeTabUrl) }))
      .filter((entry): entry is { cookie: ICookie; detail: chrome.cookies.SetDetails } => !!entry.detail);

    const settled = await Promise.allSettled(writeEntries.map(entry => setSingleCookie(entry.detail)));
    let succeeded = 0;
    let firstError: unknown;
    const failedRequired: string[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        succeeded++;
      } else {
        if (!firstError) firstError = outcome.reason;
        const name = writeEntries[index].cookie.name || '';
        if (requiredKeys.has(name)) failedRequired.push(name);
      }
    });
    if (failedRequired.length) {
      throw new Error(`核心登录 Cookie 写入失败（${failedRequired.join('、')}）`);
    }
    if (succeeded === 0 && writeEntries.length > 0) {
      throw firstError instanceof Error ? firstError : new Error('Cookie 写入失败');
    }
  }

  const pageStorage =
    localStorageItems.length || sessionItems.length || idbItems.length
      ? await applyPageStorageToTabs(host, localStorageItems, sessionItems, {
          targetTabId,
          includeSessionStorage: sessionEnabled,
          includeIndexedDB: idbEnabled,
          indexedDBRecords: idbItems,
        })
      : {
          localChanged: false,
          sessionChanged: false,
          indexedDbChanged: false,
          changedTabIds: [] as number[],
        };

  if (!eligible.length && !localStorageItems.length && !sessionItems.length && !idbItems.length) {
    throw new Error('没有匹配且未过期的 Cookie，请在已登录电脑重新推送');
  }

  if (
    isReload &&
    (cookiesChanged || pageStorage.localChanged || pageStorage.sessionChanged || pageStorage.indexedDbChanged)
  ) {
    await refreshAffectedTabs(host, isReload, cookiesChanged, pageStorage.changedTabIds);
  }

  return cookieMap;
};

export type PushCookiesResponse = WriteResponse;

const pushCookiesImpl = async (
  domain: string,
  cookies: ICookie[],
  localStorageItems: ILocalStorageItem[] = [],
  userAgent = '',
  sessionStorageItems: ILocalStorageItem[] = [],
  indexedDBRecords: IIndexedDBRecord[] = [],
): Promise<PushCookiesResponse> => {
  const pendingRevision = await getPendingRevision(domain);
  try {
    const [res, cookieMap] = await runRemoteMutation((accountInfo, bundle) =>
      mergeAndWriteCookies(
        accountInfo,
        domain,
        cookies,
        localStorageItems,
        userAgent,
        bundle.map,
        sessionStorageItems,
        indexedDBRecords,
        bundle,
      ),
    );
    void recordSiteActivity(domain, 'push', !!res.success, res.success ? undefined : '云端未确认写入');
    if (res.success) {
      const digest = await domainContentHash(cookieMap.domainCookieMap?.[domain]);
      await setSyncBaseline(domain, digest);
      await settleManualSync(domain, pendingRevision, digest);
    }
    return res;
  } catch (e: unknown) {
    void recordSiteActivity(domain, 'push', false, e instanceof Error ? e.message : '推送失败');
    return Promise.reject(e);
  }
};

const pushMultipleDomainCookiesImpl = async (
  domainCookies: PendingDomainCookie[],
  cookieFilter?: (cookie: ICookie, host: string) => boolean,
): Promise<PushMultipleResult> => {
  let adopted: RemoteAdoption[] = [];
  const [res, cookieMap] = await runRemoteMutation(async (accountInfo, bundle) => {
    const filtered = cookieFilter
      ? domainCookies.map(item => ({
          ...item,
          cookies: [
            ...item.cookies.filter(cookie => cookieFilter(cookie, item.domain)),
            ...(bundle.map.domainCookieMap?.[item.domain]?.cookies || []).filter(
              cookie => !cookieFilter(cookie, item.domain),
            ),
          ],
        }))
      : domainCookies;
    const [writeRes, nextMap, nextAdopted] = await mergeAndWriteMultipleDomainCookies(
      accountInfo,
      filtered,
      bundle.map,
      bundle,
    );
    adopted = nextAdopted;
    return [writeRes, nextMap];
  });

  const adoptedDomains = new Set(adopted.map(item => item.domain));
  if (res.success) {
    for (const item of domainCookies) {
      if (adoptedDomains.has(item.domain)) continue;
      void recordSiteActivity(item.domain, 'push');
      await setSyncBaseline(item.domain, await domainContentHash(cookieMap.domainCookieMap?.[item.domain]));
    }
  }
  return { ...res, adopted };
};

const removeCookiesImpl = async (domain: string): Promise<WriteResponse> => {
  const [res] = await runRemoteMutation((accountInfo, bundle) =>
    removeAndWriteCookies(accountInfo, domain, bundle.map, undefined, bundle),
  );
  return res;
};

const removeCookieItemImpl = async (domain: string, id: string): Promise<WriteResponse> => {
  const [res] = await runRemoteMutation((accountInfo, bundle) =>
    removeAndWriteCookies(accountInfo, domain, bundle.map, id, bundle),
  );
  return res;
};

const editCookieItemImpl = async (host: string, oldItem: ICookie, newItem: ICookie): Promise<WriteResponse> => {
  const [res] = await runRemoteMutation((accountInfo, bundle) =>
    editAndWriteCookies(accountInfo, host, bundle.map, oldItem, newItem, bundle),
  );
  return res;
};

export class CookieOperator {
  static editCookieItem(host: string, oldItem: ICookie, newItem: ICookie) {
    return editCookieItem(host, oldItem, newItem);
  }
}

export const pullCookies = (...args: Parameters<typeof pullCookiesImpl>): ReturnType<typeof pullCookiesImpl> =>
  withCookieOperation(() => pullCookiesImpl(...args));

/** Explicit user refresh: a real remote read, never a stale cache. */
export const refreshRemoteCookies = (): ReturnType<typeof pullCookiesImpl> =>
  withCookieOperation(() => pullCookiesImpl(false, true));

export const pushCookies = (...args: Parameters<typeof pushCookiesImpl>): ReturnType<typeof pushCookiesImpl> =>
  withCookieOperation(() => pushCookiesImpl(...args));

export const pushMultipleDomainCookies = (
  ...args: Parameters<typeof pushMultipleDomainCookiesImpl>
): ReturnType<typeof pushMultipleDomainCookiesImpl> =>
  withCookieOperation(() => pushMultipleDomainCookiesImpl(...args));

export const removeCookies = (...args: Parameters<typeof removeCookiesImpl>): ReturnType<typeof removeCookiesImpl> =>
  withCookieOperation(() => removeCookiesImpl(...args));

export const removeCookieItem = (
  ...args: Parameters<typeof removeCookieItemImpl>
): ReturnType<typeof removeCookieItemImpl> => withCookieOperation(() => removeCookieItemImpl(...args));

export const editCookieItem = (
  ...args: Parameters<typeof editCookieItemImpl>
): ReturnType<typeof editCookieItemImpl> => withCookieOperation(() => editCookieItemImpl(...args));
