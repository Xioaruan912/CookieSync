import { cookieSetDetails, syncCookieDomain } from './restore';
import { ICookie, ICookiesMap, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import { Cookie, cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';

import { AccountInfo, accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';

import { MessageType } from '@lib/message';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { RestEndpointMethodTypes } from '@octokit/rest';
import { OctokitResponse } from '@octokit/types';
import { WriteResponse } from '../cloudflare';
import {
  editAndWriteCookies,
  mergeAndWriteCookies,
  mergeAndWriteMultipleDomainCookies,
  readCookiesMap,
  removeAndWriteCookies,
} from './withCloudflare';

// One queue per extension context keeps background reads and writes from racing.
let cookieOperations: Promise<unknown> = Promise.resolve();
function withCookieOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = cookieOperations.then(operation, operation);
  cookieOperations = result.catch(() => {});
  return result;
}

export const readCookiesMapWithStatus = async (cloudflareInfo: AccountInfo) => {
  // WebDAV mutations must read the current remote state, not a stale UI cache.
  if (cloudflareInfo.selectedProvider === 'webdav') return readCookiesMap(cloudflareInfo);
  let cookieMap: Cookie | null = null;
  const domainStatus = await domainStatusStorage.get();
  if (domainStatus.pushing) {
    cookieMap = await cookieStorage.getSnapshot();
  }
  if (cookieMap && Object.keys(cookieMap.domainCookieMap || {}).length > 0) {
    return cookieMap;
  }
  return await readCookiesMap(cloudflareInfo);
};

const pullCookiesImpl = async (isInit = false): Promise<Cookie> => {
  const cloudflareInfo = await accountStorage.get();
  if (
    isInit &&
    cloudflareInfo.selectedProvider !== 'github' &&
    cloudflareInfo.selectedProvider !== 'webdav' &&
    (!cloudflareInfo.accountId || !cloudflareInfo.namespaceId || !cloudflareInfo.token)
  ) {
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
    const cookieMap = await readCookiesMapWithStatus(cloudflareInfo);
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
    if (!tab.id || (targetTabId !== undefined && tab.id !== targetTabId) || !tab.url?.startsWith('http')) return false;
    const hostname = new URL(tab.url).host;
    return hostname === host || hostname.replace(/^www\./, '') === host;
  });
  const results = await Promise.allSettled(
    matching.map(tab =>
      chrome.tabs
        .sendMessage(tab.id!, {
          type: MessageType.SetLocalStorage,
          payload: { domain: host, value },
        })
        .then(result => {
          if (!result?.isOk) throw new Error('LocalStorage 写入失败');
        }),
    ),
  );
  if (results.some(result => result.status === 'rejected'))
    throw new Error('部分页面的 LocalStorage 未恢复，请刷新该网站后重试');
};

export const pullAndSetCookies = async (
  activeTabUrl: string,
  host: string,
  isReload = true,
  providedMap?: Cookie,
  targetTabId?: number,
): Promise<Cookie> => {
  // Network reads do not suppress local changes. Only writes to this site's scope do.
  const cookieMap = providedMap || (await pullCookies());
  const scope = syncCookieDomain(host);
  applyingRemoteHosts.set(scope, (applyingRemoteHosts.get(scope) || 0) + 1);
  try {
    return await restoreCookieMap(activeTabUrl, host, isReload, cookieMap, targetTabId);
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
): Promise<Cookie> => {
  const cookieMap = providedMap || (await pullCookies());
  const cookieDetails = cookieMap?.domainCookieMap?.[host]?.cookies || [];
  const localStorageItems = cookieMap?.domainCookieMap?.[host]?.localStorageItems || [];
  if (cookieDetails.length === 0 && localStorageItems.length === 0) {
    throw new Error('远程没有该网站的登录数据，请先在已登录电脑推送');
  } else {
    const cookiesPromiseList: Promise<unknown>[] = [];
    for (const cookie of cookieDetails) {
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
    if ((await settingsStorage.get()).includeLocalStorage !== false && localStorageItems.length) {
      await applyLocalStorageToTabs(host, localStorageItems, targetTabId);
    }

    if (cookiesPromiseList.length === 0 && localStorageItems.length === 0) {
      throw new Error('没有匹配且未过期的 Cookie，请在已登录电脑重新推送');
    }
    if (isReload) {
      chrome.tabs.query({}, function (tabs) {
        tabs.forEach(function (tab) {
          // 使用字符串匹配
          if (tab.url && tab.url.includes(host) && tab.id) {
            chrome.tabs.reload(tab.id);
          }
        });
      });
    }
  }
  return cookieMap;
};

export type GistUpdateResponse = RestEndpointMethodTypes['gists']['update']['response'];

export type PushCookiesResponse = WriteResponse | GistUpdateResponse;

const checkSuccessAndUpdate = async (
  accountInfo: AccountInfo,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res: WriteResponse | OctokitResponse<any>,
  cookieMap: ICookiesMap,
) => {
  if (accountInfo.selectedProvider === 'github') {
    if ((res as unknown as GistUpdateResponse)?.status?.toString()?.startsWith('2')) {
      await cookieStorage.update(cookieMap);
    }
  } else {
    if ((res as WriteResponse).success) {
      await cookieStorage.update(cookieMap);
    }
  }
};

const pushCookiesImpl = async (
  domain: string,
  cookies: ICookie[],
  localStorageItems: ILocalStorageItem[] = [],
  userAgent = '',
): Promise<PushCookiesResponse> => {
  const accountInfo = await accountStorage.get();
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

    await checkSuccessAndUpdate(accountInfo, res, cookieMap);
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
  domainCookies: { domain: string; cookies: ICookie[]; localStorageItems: ILocalStorageItem[]; userAgent?: string }[],
): Promise<WriteResponse> => {
  const accountInfo = await accountStorage.get();
  try {
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pushing) return Promise.reject('cookie is pushing');
    await domainStatusStorage.update({
      pushing: true,
    });
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const [res, cookieMap] = await mergeAndWriteMultipleDomainCookies(accountInfo, domainCookies, oldCookie);
    await domainStatusStorage.update({
      pushing: false,
    });
    await checkSuccessAndUpdate(accountInfo, res, cookieMap);
    return res;
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
    // const oldCookie = await cookieStorage.get();
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const [res, cookieMap] = await removeAndWriteCookies(accountInfo, domain, oldCookie);
    await domainStatusStorage.update({
      pushing: false,
    });
    await checkSuccessAndUpdate(accountInfo, res, cookieMap);
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
    // const oldCookie = await cookieStorage.get();
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const [res, cookieMap] = await removeAndWriteCookies(accountInfo, domain, oldCookie, id);
    await domainStatusStorage.update({
      pushing: false,
    });
    await checkSuccessAndUpdate(accountInfo, res, cookieMap);
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
    // const oldCookie = await cookieStorage.get();
    const oldCookie = await readCookiesMapWithStatus(accountInfo);
    const [res, cookieMap] = await removeAndWriteCookies(accountInfo, domain, oldCookie, name);
    await domainStatusStorage.update({
      pushing: false,
    });
    await checkSuccessAndUpdate(accountInfo, res, cookieMap);
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
    const cloudflareInfo = await accountStorage.get();
    const domainStatus = await domainStatusStorage.get();
    if (domainStatus.pushing) return Promise.reject('the cookie is pushing');
    return { cloudflareInfo };
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
      const { cloudflareInfo } = await this.prepare();
      await this.setPushing(true);
      const oldCookie = await readCookiesMapWithStatus(cloudflareInfo);
      const [res, cookieMap] = await editAndWriteCookies(cloudflareInfo, host, oldCookie, oldItem, newItem);
      await this.setPushing(false);

      await checkSuccessAndUpdate(cloudflareInfo, res, cookieMap);

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

export const removeCookieItem = (
  ...args: Parameters<typeof removeCookieItemImpl>
): ReturnType<typeof removeCookieItemImpl> => withCookieOperation(() => removeCookieItemImpl(...args));

export const editCookieItem = (...args: Parameters<typeof editCookieItemImpl>): ReturnType<typeof editCookieItemImpl> =>
  withCookieOperation(() => editCookieItemImpl(...args));
