import { domainContentHash, cookieContentHash, localStorageContentHash } from './fingerprint';
import { setSyncBaseline, getPendingRevision, settleManualSync } from './syncIdentity';
import { cookieSetDetails, syncCookieDomain } from './restore';
import { ICookie, ICookiesMap, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import { Cookie, cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';

import { AccountInfo, accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';

import { MessageType } from '@lib/message';
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

const pullCookiesImpl = async (isInit = false): Promise<Cookie> => {
  const accountInfo = await accountStorage.get();
  if (isInit && accountInfo.selectedProvider !== 'webdav') {
    return {};
  }
  try {
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pulling) {
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

export const applyLocalStorageToTabs = async (host: string, value: ILocalStorageItem[], targetTabId?: number) => {
  const tabs = await chrome.tabs.query({});
  const matching = tabs.filter(tab => {
    if (
      !tab.id ||
      tab.incognito ||
      (targetTabId !== undefined && tab.id !== targetTabId) ||
      !tab.url?.startsWith('http')
    )
      return false;
    const hostname = new URL(tab.url).host;
    return hostname === host || hostname.replace(/^www\./, '') === host;
  });
  const results = await Promise.allSettled(
    matching.map(async tab => {
      try {
        const current = await chrome.tabs.sendMessage(tab.id!, {
          type: MessageType.GetLocalStorage,
          payload: { domain: host },
        });
        const keys = new Set(value.map(item => item.key));
        const relevant = (current?.result || []).filter((item: ILocalStorageItem) => keys.has(item.key));
        if (current?.isOk && (await localStorageContentHash(relevant)) === (await localStorageContentHash(value)))
          return false;
      } catch {
        /* No current snapshot: apply normally. */
      }
      return chrome.tabs
        .sendMessage(tab.id!, {
          type: MessageType.SetLocalStorage,
          payload: { domain: host, value },
        })
        .then(result => {
          if (!result?.isOk) throw new Error('LocalStorage 写入失败');
          return true;
        });
    }),
  );
  if (results.some(result => result.status === 'rejected'))
    throw new Error('部分页面的 LocalStorage 未恢复，请刷新该网站后重试');
  return results.some(result => result.status === 'fulfilled' && result.value);
};

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
  const localStorageItems = cookieMap?.domainCookieMap?.[host]?.localStorageItems || [];
  if (cookieFilter && !cookieDetails.length && !localStorageItems.length) return cookieMap;
  if (cookieDetails.length === 0 && localStorageItems.length === 0) {
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
    const storageChanged =
      (await settingsStorage.get()).includeLocalStorage !== false && localStorageItems.length > 0
        ? await applyLocalStorageToTabs(host, localStorageItems, targetTabId)
        : false;

    if (!eligible.length && !localStorageItems.length) {
      throw new Error('没有匹配且未过期的 Cookie，请在已登录电脑重新推送');
    }
    if (isReload && (cookiesChanged || storageChanged)) {
      chrome.tabs.query({}, function (tabs) {
        tabs.forEach(function (tab) {
          if (tab.url && tab.url.includes(host) && tab.id) {
            chrome.tabs.reload(tab.id);
          }
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
    );

    await checkSuccessAndUpdate(res, cookieMap);
    if (res.success) {
      const digest = await domainContentHash(cookieMap.domainCookieMap?.[domain]);
      await setSyncBaseline(domain, digest);
      await settleManualSync(domain, pendingRevision, digest);
    }
    await domainStatusStorage.update({
      pushing: false,
    });
    return res;
  } catch (e) {
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
