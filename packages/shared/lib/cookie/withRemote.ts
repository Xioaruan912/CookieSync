import { cookiesMapContentHash, domainContentHash } from './fingerprint';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { buildWebdavUrl, readWebdav, writeWebdav, type WebdavSnapshot } from '../webdav/api';

import { accountStorage, isLegacyProvider, type AccountInfo } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';

import { MessageErrorCode } from '@lib/message';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  decodeCookiesMap,
  decryptBase64,
  encodeCookiesMap,
  encryptBase64,
  ICookie,
  ICookiesMap,
  IIndexedDBRecord,
  ILocalStorageItem,
  isBase64Encrypted,
} from '@sync-your-cookie/protobuf';

export interface WriteResponse {
  success: boolean;
  errors: {
    code: number;
    message: string;
  }[];
  unchanged?: boolean;
}

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
}

const remoteDigests = new WeakMap<ICookiesMap, Promise<string>>();
const remotePayloads = new WeakMap<ICookiesMap, string>();
const webdavSnapshots = new WeakMap<ICookiesMap, { url: string; snapshot: WebdavSnapshot }>();

/** Schema 2 added origin-tagged/session storage; 3 added IndexedDB records. */
const CURRENT_SCHEMA = 3;

/**
 * Older peers ignore the fields they cannot represent, so their next write
 * silently drops origins, session storage and IndexedDB. Detect that regression
 * by comparing the last applied copy with what the remote holds now.
 */
async function detectPeerSchemaRegression(map: ICookiesMap) {
  const cached = cookieStorage.getSnapshot();
  if (!cached?.domainCookieMap) return;
  const degraded = Object.keys(map.domainCookieMap || {}).filter(domain => {
    const before = Number(cached.domainCookieMap?.[domain]?.schema) || 0;
    const now = Number(map.domainCookieMap?.[domain]?.schema) || 0;
    return before >= 2 && now < before;
  });
  if (!degraded.length) return;
  const message = `云端有 ${degraded.length} 个网站的 origin、会话存储或 IndexedDB 字段被旧版本电脑覆盖（${degraded
    .slice(0, 3)
    .join('、')}${degraded.length > 3 ? ' 等' : ''}）。请把其他电脑也更新到 1.19 或更高版本，然后重新推送。`;
  const feedback = await syncFeedbackStorage.get();
  if (feedback.schemaWarning?.message === message) return;
  await syncFeedbackStorage.update({ schemaWarning: { at: Date.now(), message } });
}

export const check = async (accountInfo?: AccountInfo) => {
  const info = accountInfo || (await accountStorage.get());
  if (isLegacyProvider(info))
    return Promise.reject({
      message: '检测到旧版后端（GitHub / Cloudflare / Google Drive 已移除），请在设置中改用 WebDAV',
      code: MessageErrorCode.AccountCheck,
    });
  // The only cookie transport is WebDAV; validate the destination early.
  buildWebdavUrl(await webdavStorage.get());
  return info;
};

export const readCookiesMap = async (accountInfo: AccountInfo): Promise<ICookiesMap> => {
  const config = await webdavStorage.get();
  const snapshot = await readWebdav(config);
  const webdavRead = { url: buildWebdavUrl(config), snapshot };
  const content = snapshot.content;

  const remember = (map: ICookiesMap) => {
    remotePayloads.set(map, content);
    remoteDigests.set(map, cookiesMapContentHash(map));
    webdavSnapshots.set(map, webdavRead);
    void detectPeerSchemaRegression(map).catch(() => {});
    return map;
  };
  if (content) {
    try {
      const settingsInfo = await settingsStorage.get();
      const encryptionEnabled = settingsInfo?.encryptionEnabled;
      const encryptionPassword = settingsInfo?.encryptionPassword;

      // Check if content is encrypted and decrypt if needed
      let processedContent = content;
      const protobufEncoding = !content.trimStart().startsWith('{');

      if (protobufEncoding && isBase64Encrypted(content)) {
        if (!encryptionEnabled || !encryptionPassword) {
          return Promise.reject({
            message: '数据解密失败，请检查两台电脑的加密密码是否一致。',
            code: MessageErrorCode.DecryptFailed,
          });
        }
        try {
          processedContent = await decryptBase64(content, encryptionPassword);
        } catch {
          return Promise.reject({
            message: '数据解密失败，请检查两台电脑的加密密码是否一致。',
            code: MessageErrorCode.DecryptFailed,
          });
        }
      }

      if (protobufEncoding) {
        const compressedBuffer = base64ToArrayBuffer(processedContent);
        const deMsg = await decodeCookiesMap(compressedBuffer);

        return remember(deMsg);
      } else {
        const parsed = JSON.parse(processedContent);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid cookie map');
        return remember(parsed);
      }
    } catch (error) {
      // Do not log remote cookie payloads.
      return Promise.reject({
        message: '同步数据解码或解密失败，请检查远程文件、编码设置和加密密码',
        code: MessageErrorCode.DecodeFailed,
      });
    }
  } else {
    return remember({});
  }
};

export const writeCookiesMap = async (
  accountInfo: AccountInfo,
  cookiesMap: ICookiesMap = {},
  previousMap: ICookiesMap = cookiesMap,
) => {
  const settingsInfo = await settingsStorage.get();
  const protobufEncoding = settingsInfo?.protobufEncoding;
  const encryptionEnabled = settingsInfo?.encryptionEnabled;
  const encryptionPassword = settingsInfo?.encryptionPassword;

  if (encryptionEnabled && (!protobufEncoding || !encryptionPassword)) {
    throw new Error('已启用加密：请开启 Protobuf 编码并设置加密密码，拒绝明文上传');
  }
  const raw = remotePayloads.get(previousMap);
  const remoteEncrypted = !!raw && !raw.startsWith('{') && isBase64Encrypted(raw);
  const formatMatches =
    !!raw && (protobufEncoding ? !raw.startsWith('{') && remoteEncrypted === !!encryptionEnabled : raw.startsWith('{'));
  if (formatMatches && (await cookiesMapContentHash(cookiesMap)) === (await remoteDigests.get(previousMap))) {
    return { success: true, errors: [], unchanged: true };
  }
  let encodingStr = '';
  if (protobufEncoding) {
    const buffered = await encodeCookiesMap(cookiesMap);
    encodingStr = arrayBufferToBase64(buffered);

    // Encrypt the data if encryption is enabled
    if (encryptionEnabled && encryptionPassword) {
      encodingStr = await encryptBase64(encodingStr, encryptionPassword);
    }
  } else {
    encodingStr = JSON.stringify(cookiesMap);
  }
  const config = await webdavStorage.get();
  const url = buildWebdavUrl(config);
  const previous = webdavSnapshots.get(previousMap);
  if (!previous || previous.url !== url) throw new Error('请先拉取 WebDAV 文件后再写入');
  const result = await writeWebdav(config, encodingStr, previous.snapshot);
  webdavSnapshots.delete(previousMap);
  if (result.success) await syncFeedbackStorage.update({ schemaWarning: undefined });
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
        cookies: cookies,
        localStorageItems: localStorageItems,
        sessionStorageItems,
        indexedDBRecords,
        schema: CURRENT_SCHEMA,
        userAgent: userAgent || oldCookieMap.domainCookieMap?.[domain]?.userAgent || '',
      },
    },
  };

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap);
  return [res, cookiesMap];
};

export const mergeAndWriteMultipleDomainCookies = async (
  accountInfo: AccountInfo,
  domainCookies: PendingDomainCookie[],
  oldCookieMap: ICookiesMap = {},
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
      // The remote copy is unchanged since the job's baseline: the local edit wins.
      writes.push(item);
      continue;
    }
    const localHash = await domainContentHash(item);
    if (remoteHash === localHash) continue; // Already identical; keep the remote timestamp.
    // Both sides changed since the pending job was captured.
    if (typeof item.capturedAt !== 'number' || !Number.isFinite(item.capturedAt))
      throw new Error(`两端数据均已变化（${item.domain}），请手动推送或拉取以确认本机修改`);
    const remoteUpdated = Number(remoteEntry?.updateTime) || 0;
    if (remoteUpdated > item.capturedAt) {
      // Newer wins: keep the cloud copy; the local job stays queued and the next
      // reconciliation applies the remote state to this browser.
      adopted.push({ domain: item.domain, remoteHash, remoteUpdateTime: remoteUpdated });
      continue;
    }
    writes.push(item);
  }

  const newDomainCookieMap = {
    ...(oldCookieMap.domainCookieMap || {}),
  };
  for (const { domain, cookies, localStorageItems, sessionStorageItems, indexedDBRecords, userAgent } of writes) {
    newDomainCookieMap[domain] = {
      updateTime: Date.now(),
      createTime: oldCookieMap.domainCookieMap?.[domain]?.createTime || Date.now(),
      cookies: cookies,
      localStorageItems: localStorageItems || [],
      sessionStorageItems: sessionStorageItems || [],
      indexedDBRecords: indexedDBRecords || [],
      schema: CURRENT_SCHEMA,
      userAgent: userAgent || oldCookieMap.domainCookieMap?.[domain]?.userAgent || '',
    };
  }
  const cookiesMap: ICookiesMap = {
    updateTime: Date.now(),
    createTime: oldCookieMap?.createTime || Date.now(),
    domainCookieMap: newDomainCookieMap,
  };

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap);
  return [res, cookiesMap, adopted];
};

export const removeAndWriteCookies = async (
  accountInfo: AccountInfo,
  domain: string,
  oldCookieMap: ICookiesMap = {},
  id?: string,
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
        cookiesMap.domainCookieMap[domain].cookies =
          cookiesMap.domainCookieMap[domain].cookies?.filter(
            (cookie: ICookie) => `${cookie.domain}_${cookie.name}` !== id,
          ) || [];
        const newLength = cookiesMap.domainCookieMap[domain]?.cookies?.length || 0;
        if (oldLength === newLength) {
          throw new Error(`${id}: cookie not found`);
        }
      }
    } else {
      delete cookiesMap.domainCookieMap[domain];
    }
  }

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap);
  return [res, cookiesMap];
};

export const editAndWriteCookies = async (
  accountInfo: AccountInfo,
  host: string,
  oldCookieMap: ICookiesMap = {},
  oldItem: ICookie,
  newItem: ICookie,
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
    const cookieLength = cookiesMap.domainCookieMap[host]?.cookies?.length || 0;
    for (let i = 0; i < cookieLength; i++) {
      const cookieItem = cookiesMap.domainCookieMap[host]?.cookies?.[i];
      if (cookieItem?.name === oldItem.name && cookieItem?.domain === oldItem.domain) {
        (cookiesMap.domainCookieMap[host].cookies as ICookie[])[i] = {
          ...cookieItem,
          ...newItem,
        };
        break;
      }
    }
  }

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap);
  return [res, cookiesMap];
};
