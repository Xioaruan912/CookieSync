import { domainContentHash } from './fingerprint';
import { storageBytes, storageLimits } from './storageScope';
import {
  assertWebdavConfigured,
  CURRENT_COOKIE_SCHEMA,
  readRemoteCookiesBundle,
  writeRemoteCookiesBundle,
  type RemoteCookieBundle,
  type WriteResponse,
} from './remoteStore';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import type { AccountInfo } from '@sync-your-cookie/storage/lib/accountStorage';
import type { ICookie, ICookiesMap, IIndexedDBRecord, ILocalStorageItem } from '@sync-your-cookie/protobuf';

export type { WriteResponse, RemoteCookieBundle };

/** A pending domain kept locally because the remote copy is newer (newer-wins). */
export interface RemoteAdoption {
  domain: string;
  remoteHash: string;
  remoteUpdateTime: number;
}

export interface PendingDomainCookie {
  domain: string;
  cookies: ICookie[];
  localStorageItems: ILocalStorageItem[];
  sessionStorageItems?: ILocalStorageItem[];
  indexedDBRecords?: IIndexedDBRecord[];
  userAgent?: string;
  /** Content hash the job was captured against. */
  baseHash?: string;
  /** Wall clock (ms) when the local change was captured; drives newer-wins. */
  capturedAt?: number;
  initialCapture?: boolean;
}

function preserveOtherOrigins<T extends { origin?: string | null }>(prior: T[], captured: T[]): T[] {
  const capturedOrigins = new Set(captured.map(item => item.origin || ''));
  return [...prior.filter(item => !capturedOrigins.has(item.origin || '')), ...captured];
}

const cookieIdentity = (cookie: ICookie) => JSON.stringify([cookie.domain, cookie.path || '/', cookie.name]);

// Backwards-compatibility bridge for callers passing a raw ICookiesMap instead of RemoteCookieBundle.
const legacyBundles = new WeakMap<ICookiesMap, RemoteCookieBundle>();

export const check = assertWebdavConfigured;

export const readCookiesMap = async (accountInfo: AccountInfo): Promise<ICookiesMap> => {
  const bundle = await readRemoteCookiesBundle(accountInfo);
  legacyBundles.set(bundle.map, bundle);
  return bundle.map;
};

export const writeCookiesMap = async (
  _accountInfo: AccountInfo,
  cookiesMap: ICookiesMap = {},
  previousMap: ICookiesMap = cookiesMap,
  explicitBundle?: RemoteCookieBundle,
): Promise<WriteResponse> => {
  const settingsInfo = await settingsStorage.get();
  if (settingsInfo?.encryptionEnabled && (!settingsInfo?.protobufEncoding || !settingsInfo?.encryptionPassword)) {
    throw new Error('已启用加密：请开启 Protobuf 编码并设置加密密码，拒绝明文上传');
  }
  const bundle = explicitBundle || legacyBundles.get(previousMap);
  if (!bundle) {
    throw new Error('请先拉取 WebDAV 文件后再写入');
  }
  const result = await writeRemoteCookiesBundle(cookiesMap, bundle);
  if (!explicitBundle) {
    legacyBundles.delete(previousMap);
  }
  return result;
};

export const mergeAndWriteCookies = async (
  accountInfo: AccountInfo,
  domain: string,
  cookies: ICookie[],
  localStorageItems: ILocalStorageItem[] = [],
  userAgent = '',
  oldCookieMap: ICookiesMap = {},
  sessionStorageItems: ILocalStorageItem[] = [],
  indexedDBRecords: IIndexedDBRecord[] = [],
  explicitBundle?: RemoteCookieBundle,
): Promise<[WriteResponse, ICookiesMap]> => {
  await check(accountInfo);
  const cookiesMap: ICookiesMap = {
    updateTime: Date.now(),
    createTime: oldCookieMap?.createTime || Date.now(),
    domainCookieMap: {
      ...(oldCookieMap.domainCookieMap || {}),
      [domain]: {
        updateTime: Date.now(),
        createTime: oldCookieMap.domainCookieMap?.[domain]?.createTime || Date.now(),
        cookies,
        localStorageItems,
        sessionStorageItems,
        indexedDBRecords,
        schema: CURRENT_COOKIE_SCHEMA,
        userAgent: userAgent || oldCookieMap.domainCookieMap?.[domain]?.userAgent || '',
      },
    },
  };

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap, explicitBundle);
  return [res, cookiesMap];
};

export const mergeAndWriteMultipleDomainCookies = async (
  accountInfo: AccountInfo,
  domainCookies: PendingDomainCookie[],
  oldCookieMap: ICookiesMap = {},
  explicitBundle?: RemoteCookieBundle,
): Promise<[WriteResponse, ICookiesMap, RemoteAdoption[]]> => {
  await check(accountInfo);

  const adopted: RemoteAdoption[] = [];
  const writes: PendingDomainCookie[] = [];
  for (const item of domainCookies) {
    if (!item.baseHash) {
      writes.push(item);
      continue;
    }
    const remoteEntry = oldCookieMap.domainCookieMap?.[item.domain];
    const remoteHash = await domainContentHash(remoteEntry);
    if (remoteHash === item.baseHash) {
      writes.push(item);
      continue;
    }
    const localHash = await domainContentHash(item);
    if (remoteHash === localHash) continue;
    if (typeof item.capturedAt !== 'number' || !Number.isFinite(item.capturedAt)) {
      throw new Error(`两端数据均已变化（${item.domain}），请手动推送或拉取以确认本机修改`);
    }
    const remoteUpdated = Number(remoteEntry?.updateTime) || 0;
    if (remoteUpdated > item.capturedAt) {
      adopted.push({ domain: item.domain, remoteHash, remoteUpdateTime: remoteUpdated });
      continue;
    }
    writes.push(item);
  }

  if (writes.length === 0) {
    return [{ success: true, errors: [], unchanged: true }, oldCookieMap, adopted];
  }

  const newDomainCookieMap = {
    ...(oldCookieMap.domainCookieMap || {}),
  };
  for (const item of writes) {
    const { domain, cookies, userAgent } = item;
    const prior = oldCookieMap.domainCookieMap?.[domain];
    const capturedCookies = new Set(cookies.map(cookieIdentity));
    const local = item.initialCapture
      ? preserveOtherOrigins(prior?.localStorageItems || [], item.localStorageItems)
      : item.localStorageItems;
    const session = item.initialCapture
      ? preserveOtherOrigins(prior?.sessionStorageItems || [], item.sessionStorageItems || [])
      : item.sessionStorageItems || [];
    if (item.initialCapture && storageBytes(local) + storageBytes(session) > storageLimits.maxBytesPerDomain) {
      throw new Error(`${domain} 合并首次采集和云端网页存储后超出站点上限，已保留本机队列`);
    }
    newDomainCookieMap[domain] = {
      updateTime: Date.now(),
      createTime: oldCookieMap.domainCookieMap?.[domain]?.createTime || Date.now(),
      cookies: item.initialCapture
        ? [...(prior?.cookies || []).filter(cookie => !capturedCookies.has(cookieIdentity(cookie))), ...cookies]
        : cookies,
      localStorageItems: local,
      sessionStorageItems: session,
      indexedDBRecords: item.initialCapture
        ? preserveOtherOrigins(prior?.indexedDBRecords || [], item.indexedDBRecords || [])
        : item.indexedDBRecords || [],
      schema: CURRENT_COOKIE_SCHEMA,
      userAgent: userAgent || oldCookieMap.domainCookieMap?.[domain]?.userAgent || '',
    };
  }
  const cookiesMap: ICookiesMap = {
    updateTime: Date.now(),
    createTime: oldCookieMap?.createTime || Date.now(),
    domainCookieMap: newDomainCookieMap,
  };

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap, explicitBundle);
  return [res, cookiesMap, adopted];
};

export const removeAndWriteCookies = async (
  accountInfo: AccountInfo,
  domain: string,
  oldCookieMap: ICookiesMap = {},
  id?: string,
  explicitBundle?: RemoteCookieBundle,
): Promise<[WriteResponse, ICookiesMap]> => {
  await check(accountInfo);
  const cookiesMap: ICookiesMap = {
    updateTime: Date.now(),
    createTime: oldCookieMap?.createTime || Date.now(),
    domainCookieMap: {
      ...(oldCookieMap.domainCookieMap || {}),
    },
  };
  if (cookiesMap.domainCookieMap) {
    if (id !== undefined) {
      if (cookiesMap.domainCookieMap[domain]?.cookies) {
        const oldLength = cookiesMap.domainCookieMap[domain]?.cookies?.length || 0;
        cookiesMap.domainCookieMap[domain] = {
          ...cookiesMap.domainCookieMap[domain],
          cookies:
            cookiesMap.domainCookieMap[domain].cookies?.filter(
              (cookie: ICookie) => `${cookie.domain}_${cookie.name}` !== id,
            ) || [],
        };
        const newLength = cookiesMap.domainCookieMap[domain]?.cookies?.length || 0;
        if (oldLength === newLength) {
          throw new Error(`${id}: cookie not found`);
        }
      }
    } else {
      delete cookiesMap.domainCookieMap[domain];
    }
  }

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap, explicitBundle);
  return [res, cookiesMap];
};

export const editAndWriteCookies = async (
  accountInfo: AccountInfo,
  host: string,
  oldCookieMap: ICookiesMap = {},
  oldItem: ICookie,
  newItem: ICookie,
  explicitBundle?: RemoteCookieBundle,
): Promise<[WriteResponse, ICookiesMap]> => {
  await check(accountInfo);
  const cookiesMap: ICookiesMap = {
    updateTime: Date.now(),
    createTime: oldCookieMap?.createTime || Date.now(),
    domainCookieMap: {
      ...(oldCookieMap.domainCookieMap || {}),
    },
  };
  if (cookiesMap.domainCookieMap?.[host]?.cookies) {
    const nextCookies = [...(cookiesMap.domainCookieMap[host].cookies as ICookie[])];
    for (let i = 0; i < nextCookies.length; i++) {
      const cookieItem = nextCookies[i];
      if (cookieItem?.name === oldItem.name && cookieItem?.domain === oldItem.domain) {
        nextCookies[i] = { ...cookieItem, ...newItem };
        break;
      }
    }
    cookiesMap.domainCookieMap[host] = {
      ...cookiesMap.domainCookieMap[host],
      cookies: nextCookies,
    };
  }

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap, explicitBundle);
  return [res, cookiesMap];
};
