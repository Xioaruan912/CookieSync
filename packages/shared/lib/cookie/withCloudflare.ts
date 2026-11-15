import { cookiesMapContentHash, domainContentHash } from './fingerprint';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { buildWebdavUrl, readWebdav, writeWebdav, type WebdavSnapshot } from '../webdav/api';

import { accountStorage, type AccountInfo } from '@sync-your-cookie/storage/lib/accountStorage';
import { getActiveStorageItem, settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';

import { readCloudflareKV, writeCloudflareKV, WriteResponse } from '../cloudflare/api';

import { GithubApi } from '@lib/github';
import { MessageErrorCode } from '@lib/message';
import { RestEndpointMethodTypes } from '@octokit/rest';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  decodeCookiesMap,
  decryptBase64,
  encodeCookiesMap,
  encryptBase64,
  ICookie,
  ICookiesMap,
  ILocalStorageItem,
  isBase64Encrypted,
} from '@sync-your-cookie/protobuf';

const remoteDigests = new WeakMap<ICookiesMap, Promise<string>>();
const remotePayloads = new WeakMap<ICookiesMap, string>();
const webdavSnapshots = new WeakMap<ICookiesMap, { url: string; snapshot: WebdavSnapshot }>();

export const check = async (accountInfo?: AccountInfo) => {
  const cloudflareAccountInfo = accountInfo || (await accountStorage.get());
  if (cloudflareAccountInfo?.selectedProvider === 'webdav') {
    buildWebdavUrl(await webdavStorage.get());
  } else if (cloudflareAccountInfo?.selectedProvider === 'github') {
    if (!cloudflareAccountInfo.githubAccessToken) {
      return Promise.reject({
        message: '请配置 GitHub 访问令牌',
        code: MessageErrorCode.AccountCheck,
      });
    }
  } else {
    if (!cloudflareAccountInfo?.accountId || !cloudflareAccountInfo.namespaceId || !cloudflareAccountInfo.token) {
      let message = '请配置 Cloudflare 账号 ID';
      if (!cloudflareAccountInfo?.namespaceId) {
        message = '请配置命名空间 ID';
      } else if (!cloudflareAccountInfo.token) {
        message = '请配置访问令牌';
      }

      return Promise.reject({
        message,
        code: MessageErrorCode.AccountCheck,
      });
    }
  }
  return cloudflareAccountInfo;
};

export const readCookiesMap = async (accountInfo: AccountInfo): Promise<ICookiesMap> => {
  let content = '';
  let webdavRead: { url: string; snapshot: WebdavSnapshot } | undefined;
  if (accountInfo.selectedProvider === 'webdav') {
    const config = await webdavStorage.get();
    const snapshot = await readWebdav(config);
    webdavRead = { url: buildWebdavUrl(config), snapshot };
    content = snapshot.content;
  } else if (accountInfo.selectedProvider === 'github') {
    const activeStorageItem = getActiveStorageItem();
    if (activeStorageItem?.rawUrl) {
      content = await GithubApi.instance.fetchRawContent(activeStorageItem.rawUrl);
    }
  } else {
    await check(accountInfo);
    content = await readCloudflareKV(accountInfo.accountId!, accountInfo.namespaceId!, accountInfo.token!);
  }

  const remember = (map: ICookiesMap) => {
    remotePayloads.set(map, content);
    remoteDigests.set(map, cookiesMapContentHash(map));
    if (webdavRead) webdavSnapshots.set(map, webdavRead);
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
        } catch (decryptError) {
          // throw new Error('数据解密失败，请检查两台电脑的加密密码是否一致。');
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
      // return {};
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
    if (accountInfo.selectedProvider === 'github')
      return { status: 200, headers: {}, url: '', data: {} } as RestEndpointMethodTypes['gists']['update']['response'];
    return { success: true, errors: [], unchanged: true };
  }
  let encodingStr = '';
  if (protobufEncoding) {
    const buffered = await encodeCookiesMap(cookiesMap);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    encodingStr = arrayBufferToBase64(buffered as any);

    // Encrypt the data if encryption is enabled
    if (encryptionEnabled && encryptionPassword) {
      encodingStr = await encryptBase64(encodingStr, encryptionPassword);
    }
  } else {
    encodingStr = JSON.stringify(cookiesMap);
  }
  if (accountInfo.selectedProvider === 'webdav') {
    const config = await webdavStorage.get();
    const url = buildWebdavUrl(config);
    const previous = webdavSnapshots.get(previousMap);
    if (!previous || previous.url !== url) throw new Error('请先拉取 WebDAV 文件后再写入');
    const result = await writeWebdav(config, encodingStr, previous.snapshot);
    webdavSnapshots.delete(previousMap);
    return result;
  } else if (accountInfo.selectedProvider === 'github') {
    const storageKeyGistId = settingsInfo?.storageKeyGistId;
    const storageKey = settingsInfo?.storageKey;
    return await GithubApi.instance.updateGist(storageKeyGistId!, storageKey!, encodingStr);
  } else {
    const res = await writeCloudflareKV(
      encodingStr,
      accountInfo.accountId!,
      accountInfo.namespaceId!,
      accountInfo.token!,
    );
    return res;
  }
};

export const mergeAndWriteCookies = async (
  accountInfo: AccountInfo,
  domain: string,
  cookies: ICookie[],
  localStorageItems: ILocalStorageItem[] = [],
  userAgent = '',
  oldCookieMap: ICookiesMap = {},
): Promise<[WriteResponse | RestEndpointMethodTypes['gists']['update']['response'], ICookiesMap]> => {
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
        userAgent: userAgent || oldCookieMap.domainCookieMap?.[domain]?.userAgent || '',
      },
    },
  };

  const res = await writeCookiesMap(accountInfo, cookiesMap, oldCookieMap);
  return [res, cookiesMap];
};

export const mergeAndWriteMultipleDomainCookies = async (
  cloudflareAccountInfo: AccountInfo,
  domainCookies: {
    domain: string;
    cookies: ICookie[];
    localStorageItems: ILocalStorageItem[];
    userAgent?: string;
    baseHash?: string;
  }[],
  oldCookieMap: ICookiesMap = {},
): Promise<[WriteResponse, ICookiesMap]> => {
  await check(cloudflareAccountInfo);

  for (const item of domainCookies) {
    if (!item.baseHash) continue;
    const remoteHash = await domainContentHash(oldCookieMap.domainCookieMap?.[item.domain]);
    const localHash = await domainContentHash(item);
    if (remoteHash !== item.baseHash && remoteHash !== localHash) {
      throw new Error(`两端数据均已变化（${item.domain}），已保留本机队列并停止覆盖，请确认后手动推送或拉取`);
    }
  }
  const newDomainCookieMap = {
    ...(oldCookieMap.domainCookieMap || {}),
  };
  for (const { domain, cookies, localStorageItems, userAgent } of domainCookies) {
    newDomainCookieMap[domain] = {
      updateTime: Date.now(),
      createTime: oldCookieMap.domainCookieMap?.[domain]?.createTime || Date.now(),
      cookies: cookies,
      localStorageItems: localStorageItems || [],
      userAgent: userAgent || oldCookieMap.domainCookieMap?.[domain]?.userAgent || '',
    };
  }
  const cookiesMap: ICookiesMap = {
    updateTime: Date.now(),
    createTime: oldCookieMap?.createTime || Date.now(),
    domainCookieMap: newDomainCookieMap,
  };

  const res = await writeCookiesMap(cloudflareAccountInfo, cookiesMap, oldCookieMap);
  return [res, cookiesMap];
};

export const removeAndWriteCookies = async (
  cloudflareAccountInfo: AccountInfo,
  domain: string,
  oldCookieMap: ICookiesMap = {},
  id?: string,
): Promise<[WriteResponse, ICookiesMap]> => {
  await check(cloudflareAccountInfo);
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (cookie: any) => `${cookie.domain}_${cookie.name}` !== id,
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

  const res = await writeCookiesMap(cloudflareAccountInfo, cookiesMap, oldCookieMap);
  return [res, cookiesMap];
};

export const editAndWriteCookies = async (
  cloudflareAccountInfo: AccountInfo,
  host: string,
  oldCookieMap: ICookiesMap = {},
  oldItem: ICookie,
  newItem: ICookie,
): Promise<[WriteResponse, ICookiesMap]> => {
  await check(cloudflareAccountInfo);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (cookiesMap.domainCookieMap[host].cookies as any)[i] = {
          ...cookieItem,
          ...newItem,
        };
        break;
      }
    }
  }

  const res = await writeCookiesMap(cloudflareAccountInfo, cookiesMap, oldCookieMap);
  return [res, cookiesMap];
};
