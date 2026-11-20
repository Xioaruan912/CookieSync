import { domainContentHash, cookieContentHash, localStorageContentHash } from './fingerprint';
import { setSyncBaseline, getPendingRevision, settleManualSync } from './syncIdentity';
import { cookieSetDetails, matchesSiteScope, syncCookieDomain } from './restore';
import { pageOrigin, selectScopedItems, sessionStorageEnabled } from './storageScope';
import { ICookie, ICookiesMap, ILocalStorageItem } from '@sync-your-cookie/protobuf';
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

// One queue per extension context keeps background reads and writes from racing.
let cookieOperations: Promise<unknown> = Promise.resolve();
function withCookieOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = cookieOperations.then(operation, operation);
  cookieOperations = result.catch(() => {});
  return result;
}

export type PushMultipleResult = WriteResponse & { adopted: RemoteAdoption[] };

export const readCookiesMapWithStatus = async (accountInfo: AccountInfo) => {
  // WebDAV mutations must read the current remote state, not a stale UI cache.
  return readCookiesMap(accountInfo);
};

const pullCookiesImpl = async (isInit = false, force = false): Promise<Cookie> => {
  const accountInfo = await accountStorage.get();
  if (isInit && accountInfo.selectedProvider !== 'webdav') {
    return {};
  }
  try {
    const domainStatus = await domainStatusStorage.get();
    // The in-flight short circuit serves the cache to background cycles. An
    // explicit refresh (force) must read the remote file so read errors are
    // reported instead of being hidden behind a stale success.
    if (!force && domainStatus.pulling) {
      const cookieMap = await cookieStorage.getSnapshot();
      if (cookieMap && Object.keys(cookieMap.domainCookieMap || {}).length > 0) {
        return cookieMap;
      }
    }
    await domainStatusStorage.update({
      pulling: true,
    });
    const cookieMap = await readCookiesMapWithStatus(accountInfo);
    const res = await cookieStorage.update(cookieMap, true);
    await domainStatusStorage.update({
      pulling: false,
    });
    return res;
  } catch (e) {
    await domainStatusStorage.update({
      pulling: false,
    });
    return Promise.reject(e);
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
) => {
  const readCurrent = async (): Promise<PageStorageResult | undefined> => {
    const newer = await chrome.tabs.sendMessage(tabId, {
      type: MessageType.GetPageStorage,
      payload: { domain: host, origin, includeSessionStorage: true },
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
  // LocalStorage only adds keys, so compare just the keys we would write.
  const wanted = new Set(localItems.map(item => item.key));
  const currentLocal = (current?.localStorageItems || []).filter(item => wanted.has(item.key || ''));
  const localChanged =
    !current ||
    (await localStorageContentHash(currentLocal.map(item => ({ ...item, origin })))) !==
      (await localStorageContentHash(localItems));
  // SessionStorage is replaced as a whole: it belongs to this tab alone.
  const sessionChanged =
    sessionItems.length > 0 &&
    (!current || (await localStorageContentHash(current.sessionStorageItems || [])) !== (await localStorageContentHash(sessionItems)));
  if (!localChanged && !sessionChanged) return { localChanged, sessionChanged };

  const response = await chrome.tabs
    .sendMessage(tabId, {
      type: MessageType.SetPageStorage,
      payload: {
        domain: host,
        origin,
        localStorageItems: localChanged ? localItems : undefined,
        sessionStorageItems: sessionChanged ? sessionItems : undefined,
        replaceSession: true,
      },
    })
    .catch(async (error: unknown) => {
      // Older content script: it can still take origin-less localStorage.
      if (localChanged)
        return chrome.tabs.sendMessage(tabId, {
          type: MessageType.SetLocalStorage,
          payload: { domain: host, value: localItems },
        });
      throw error;
    });
  if (response?.isOk === false) throw new Error('页面存储写入失败');
  return { localChanged, sessionChanged };
};

/**
 * Applies one site's stored page state to its open tabs. Each tab only receives
 * the entries of its own origin, legacy untagged entries included. Session
 * storage is written before the caller reloads the tab, because scripts that
 * already ran only pick it up on the next document.
 */
export const applyPageStorageToTabs = async (
  host: string,
  localItems: ILocalStorageItem[],
  sessionItems: ILocalStorageItem[] = [],
  options: { targetTabId?: number; includeSessionStorage?: boolean } = {},
) => {
  const tabs = await chrome.tabs.query({});
  const matching = tabs.filter(tab => {
    if (!tab.id || tab.incognito || (options.targetTabId !== undefined && tab.id !== options.targetTabId))
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
  let failed = false;
  const changedTabIds: number[] = [];
  for (const tab of matching) {
    const origin = pageOrigin(tab.url);
    if (!origin) continue;
    const local = selectScopedItems(localItems, origin).map(item => ({ ...item, origin }));
    const session = options.includeSessionStorage
      ? selectScopedItems(sessionItems, origin).map(item => ({ ...item, origin }))
      : [];
    try {
      const result = await applyStorageToTab(tab.id!, host, origin, local, session);
      localChanged = localChanged || result.localChanged;
      sessionChanged = sessionChanged || result.sessionChanged;
      if (result.localChanged || result.sessionChanged) changedTabIds.push(tab.id!);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('部分页面的 LocalStorage 未恢复，请刷新该网站后重试');
  return { localChanged, sessionChanged, changedTabIds };
};

/** LocalStorage-only helper kept for callers that do not carry origins. */
export const applyLocalStorageToTabs = async (host: string, value: ILocalStorageItem[], targetTabId?: number) =>
  (await applyPageStorageToTabs(host, value, [], { targetTabId })).localChanged;

export const pullAndSetCookies = async (
  activeTabUrl: string,
  host: string,
  isReload = true,
  providedMap?: Cookie,
  targetTabId?: number,
  cookieFilter?: (cookie: ICookie) => boolean,
): Promise<Cookie> => {
  const pendingRevision = await getPendingRevision(host);
  // Network reads do not suppress local changes. Only writes to this site's scope do.
  const cookieMap = providedMap || (await pullCookies());
  const scope = syncCookieDomain(host);
  applyingRemoteHosts.set(scope, (applyingRemoteHosts.get(scope) || 0) + 1);
  try {
    const result = await restoreCookieMap(activeTabUrl, host, isReload, cookieMap, targetTabId, cookieFilter);
    const digest = await domainContentHash(cookieMap.domainCookieMap?.[host]);
    await setSyncBaseline(host, digest);
    await settleManualSync(host, pendingRevision, digest);
    void recordSiteActivity(host, 'pull');
    return result;
  } finally {
    const remaining = (applyingRemoteHosts.get(scope) || 1) - 1;
    if (remaining) applyingRemoteHosts.set(scope, remaining);
    else applyingRemoteHosts.delete(scope);
  }
};

const restoreCookieMap = async (
  activeTabUrl: string,
  host: string,
  isReload: boolean,
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
  const siteConfig = (await domainConfigStorage.get()).domainMap[host];
  const sessionEnabled = sessionStorageEnabled(settingsInfo.includeSessionStorage, siteConfig?.includeSessionStorage);
  const localStorageItems = settingsInfo.includeLocalStorage === false ? [] : storedLocal;
  const sessionItems = sessionEnabled ? storedSession : [];
  if (cookieFilter && !cookieDetails.length && !localStorageItems.length && !sessionItems.length) return cookieMap;
  if (cookieDetails.length === 0 && localStorageItems.length === 0 && sessionItems.length === 0) {
    throw new Error('远程没有该网站的登录数据，请先在已登录电脑推送');
  } else {
    const cookiesPromiseList: Promise<unknown>[] = [];
    const actual = await chrome.cookies.getAll({ domain: syncCookieDomain(new URL(activeTabUrl).hostname) });
    const eligible = cookieDetails.filter(cookie => !!cookieSetDetails(cookie, activeTabUrl));
    const wanted = new Set(eligible.map(cookie => `${cookie.domain}|${cookie.path || '/'}|${cookie.name}`));
    const relevant = actual.filter(cookie => wanted.has(`${cookie.domain}|${cookie.path || '/'}|${cookie.name}`));
    const cookiesChanged = (await cookieContentHash(relevant)) !== (await cookieContentHash(eligible));
    for (const cookie of cookiesChanged ? eligible : []) {
      const cookieDetail = cookieSetDetails(cookie, activeTabUrl);
      if (cookieDetail) {
        const promise = new Promise((resolve, reject) => {
          try {
            chrome.cookies.set(cookieDetail, res => {
              if (chrome.runtime.lastError || !res)
                reject(new Error(chrome.runtime.lastError?.message || 'Cookie 写入失败'));
              else resolve(res);
            });
          } catch (error) {
            reject(error);
          }
        });
        cookiesPromiseList.push(promise);
      }
    }

    // Cookie writes complete before page-local state is applied or a tab is refreshed.
    await Promise.all(cookiesPromiseList);
    const pageStorage =
      localStorageItems.length || sessionItems.length
        ? await applyPageStorageToTabs(host, localStorageItems, sessionItems, {
            targetTabId,
            includeSessionStorage: sessionEnabled,
          })
        : { localChanged: false, sessionChanged: false, changedTabIds: [] as number[] };

    if (!eligible.length && !localStorageItems.length && !sessionItems.length) {
      throw new Error('没有匹配且未过期的 Cookie，请在已登录电脑重新推送');
    }
    if (isReload && (cookiesChanged || pageStorage.localChanged || pageStorage.sessionChanged)) {
      const changed = new Set(pageStorage.changedTabIds);
      chrome.tabs.query({}, function (tabs) {
        tabs.forEach(function (tab) {
          if (!tab.url || !tab.id) return;
          if (cookiesChanged && matchesSiteScope(host, new URL(tab.url).hostname)) chrome.tabs.reload(tab.id);
          else if (changed.has(tab.id)) chrome.tabs.reload(tab.id);
        });
      });
    }
  }
  return cookieMap;
};

export type PushCookiesResponse = WriteResponse;

const checkSuccessAndUpdate = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: WriteResponse | any,
  cookieMap: ICookiesMap,
) => {
  if ((res as WriteResponse).success) {
    await cookieStorage.update(cookieMap);
  }
};

const pushCookiesImpl = async (
  domain: string,
  cookies: ICookie[],
  localStorageItems: ILocalStorageItem[] = [],
  userAgent = '',
  sessionStorageItems: ILocalStorageItem[] = [],
): Promise<PushCookiesResponse> => {
  const accountInfo = await accountStorage.get();
  const pendingRevision = await getPendingRevision(domain);
  try {
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pushing) return Promise.reject('the cookie is pushing');
    await domainStatusStorage.update({
      pushing: true,
    });
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const [res, cookieMap] = await mergeAndWriteCookies(
      accountInfo,
      domain,
      cookies,
      localStorageItems,
      userAgent,
      oldCookie,
      sessionStorageItems,
    );

    await checkSuccessAndUpdate(res, cookieMap);
    void recordSiteActivity(domain, 'push', !!res.success, res.success ? undefined : '云端未确认写入');
    if (res.success) {
      const digest = await domainContentHash(cookieMap.domainCookieMap?.[domain]);
      await setSyncBaseline(domain, digest);
      await settleManualSync(domain, pendingRevision, digest);
    }
    await domainStatusStorage.update({
      pushing: false,
    });
    return res;
  } catch (e: unknown) {
    void recordSiteActivity(domain, 'push', false, e instanceof Error ? e.message : '推送失败');
    await domainStatusStorage.update({
      pushing: false,
    });
    return Promise.reject(e);
  }
};

const pushMultipleDomainCookiesImpl = async (
  domainCookies: PendingDomainCookie[],
  cookieFilter?: (cookie: ICookie, host: string) => boolean,
): Promise<PushMultipleResult> => {
  const accountInfo = await accountStorage.get();
  try {
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pushing) return Promise.reject('cookie is pushing');
    await domainStatusStorage.update({
      pushing: true,
    });
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const filtered = cookieFilter
      ? domainCookies.map(item => ({
          ...item,
          cookies: [
            ...item.cookies.filter(cookie => cookieFilter(cookie, item.domain)),
            ...(oldCookie.domainCookieMap?.[item.domain]?.cookies || []).filter(
              cookie => !cookieFilter(cookie, item.domain),
            ),
          ],
        }))
      : domainCookies;
    const [res, cookieMap, adopted] = await mergeAndWriteMultipleDomainCookies(accountInfo, filtered, oldCookie);
    await domainStatusStorage.update({
      pushing: false,
    });
    await checkSuccessAndUpdate(res, cookieMap);
    const adoptedDomains = new Set(adopted.map(item => item.domain));
    if (res.success) {
      for (const item of domainCookies) {
        if (adoptedDomains.has(item.domain)) {
          // Newer-wins: keep the old baseline and the pending job so the next
          // reconciliation applies the remote copy to this browser.
          continue;
        }
        void recordSiteActivity(item.domain, 'push');
        await setSyncBaseline(item.domain, await domainContentHash(cookieMap.domainCookieMap?.[item.domain]));
      }
    }
    return { ...res, adopted };
  } catch (e) {
    await domainStatusStorage.update({
      pushing: false,
    });
    return Promise.reject(e);
  }
};

const removeCookiesImpl = async (domain: string): Promise<WriteResponse> => {
  const accountInfo = await accountStorage.get();
  try {
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pushing) return Promise.reject('the cookie is pushing');
    await domainStatusStorage.update({
      pushing: true,
    });
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const [res, cookieMap] = await removeAndWriteCookies(accountInfo, domain, oldCookie);
    await domainStatusStorage.update({
      pushing: false,
    });
    await checkSuccessAndUpdate(res, cookieMap);
    return res;
  } catch (e) {
    await domainStatusStorage.update({
      pushing: false,
    });
    return Promise.reject(e);
  }
};

const removeCookieItemImpl = async (domain: string, id: string): Promise<WriteResponse> => {
  const accountInfo = await accountStorage.get();
  try {
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pushing) return Promise.reject('the cookie is pushing');
    await domainStatusStorage.update({
      pushing: true,
    });
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const [res, cookieMap] = await removeAndWriteCookies(accountInfo, domain, oldCookie, id);
    await domainStatusStorage.update({
      pushing: false,
    });
    await checkSuccessAndUpdate(res, cookieMap);
    return res;
  } catch (e) {
    await domainStatusStorage.update({
      pushing: false,
    });
    return Promise.reject(e);
  }
};

const editCookieItemImpl = async (domain: string, name: string): Promise<WriteResponse> => {
  const accountInfo = await accountStorage.get();
  try {
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pushing) return Promise.reject('the cookie is pushing');
    await domainStatusStorage.update({
      pushing: true,
    });
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const [res, cookieMap] = await removeAndWriteCookies(accountInfo, domain, oldCookie, name);
    await domainStatusStorage.update({
      pushing: false,
    });
    await checkSuccessAndUpdate(res, cookieMap);
    return res;
  } catch (e) {
    await domainStatusStorage.update({
      pushing: false,
    });
    return Promise.reject(e);
  }
};

export class CookieOperator {
  static async prepare() {
    const accountInfo = await accountStorage.get();
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pushing) return Promise.reject('the cookie is pushing');
    return { accountInfo };
  }

  static async setPushing(open: boolean) {
    await domainStatusStorage.update({
      pushing: open,
    });
  }

  static editCookieItem(host: string, oldItem: ICookie, newItem: ICookie) {
    return withCookieOperation(() => this.editCookieItemImpl(host, oldItem, newItem));
  }

  private static async editCookieItemImpl(host: string, oldItem: ICookie, newItem: ICookie) {
    try {
      const { accountInfo } = await this.prepare();
      await this.setPushing(true);
      const oldCookie = await readCookiesMapWithStatus(accountInfo);
      const [res, cookieMap] = await editAndWriteCookies(accountInfo, host, oldCookie, oldItem, newItem);
      await this.setPushing(false);

      await checkSuccessAndUpdate(res, cookieMap);

      return res;
    } catch (e) {
      await this.setPushing(false);
      return Promise.reject(e);
    }
  }
}

export const pullCookies = (...args: Parameters<typeof pullCookiesImpl>): ReturnType<typeof pullCookiesImpl> =>
  withCookieOperation(() => pullCookiesImpl(...args));

/** Explicit user refresh: a real remote read, never the in-flight cache. */
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

export const removeCookieItem = (...args: Parameters<typeof removeCookieItemImpl>): ReturnType<typeof removeCookieItemImpl> =>
  withCookieOperation(() => removeCookieItemImpl(...args));

export const editCookieItem = (...args: Parameters<typeof editCookieItemImpl>): ReturnType<typeof editCookieItemImpl> =>
  withCookieOperation(() => editCookieItemImpl(...args));
