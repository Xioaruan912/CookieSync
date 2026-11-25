import { cookiesMapContentHash } from './fingerprint';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { buildWebdavUrl, readWebdav, writeWebdav, type WebdavSnapshot } from '../webdav/api';
import { backupIfDue } from '../webdav/backup';
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
  ICookiesMap,
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

/**
 * Explicit remote read context carrying the decoded cookie map alongside its
 * WebDAV snapshot, raw payload, and semantic digest — eliminating fragile
 * hidden WeakMap coupling across callers.
 */
export interface RemoteCookieBundle {
  map: ICookiesMap;
  raw: string;
  digestPromise: Promise<string>;
  webdav: {
    url: string;
    snapshot: WebdavSnapshot;
  };
}

/** Schema 2 added origin-tagged/session storage; 3 added IndexedDB records. */
export const CURRENT_COOKIE_SCHEMA = 3;

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

export async function assertWebdavConfigured(accountInfo?: AccountInfo): Promise<AccountInfo> {
  const info = accountInfo || (await accountStorage.get());
  if (isLegacyProvider(info)) {
    return Promise.reject({
      message: '检测到旧版后端（GitHub / Cloudflare / Google Drive 已移除），请在设置中改用 WebDAV',
      code: MessageErrorCode.AccountCheck,
    });
  }
  buildWebdavUrl(await webdavStorage.get());
  return info;
}

export async function readRemoteCookiesBundle(_accountInfo?: AccountInfo): Promise<RemoteCookieBundle> {
  const config = await webdavStorage.get();
  const snapshot = await readWebdav(config);
  const webdav = { url: buildWebdavUrl(config), snapshot };
  const raw = snapshot.content;

  const pack = (map: ICookiesMap): RemoteCookieBundle => {
    void detectPeerSchemaRegression(map).catch(() => {});
    return {
      map,
      raw,
      digestPromise: cookiesMapContentHash(map),
      webdav,
    };
  };

  if (!raw) return pack({});

  try {
    const settingsInfo = await settingsStorage.get();
    const encryptionEnabled = settingsInfo?.encryptionEnabled;
    const encryptionPassword = settingsInfo?.encryptionPassword;

    let processedContent = raw;
    const protobufEncoding = !raw.trimStart().startsWith('{');

    if (protobufEncoding && isBase64Encrypted(raw)) {
      if (!encryptionEnabled || !encryptionPassword) {
        return Promise.reject({
          message: '数据解密失败，请检查两台电脑的加密密码是否一致。',
          code: MessageErrorCode.DecryptFailed,
        });
      }
      try {
        processedContent = await decryptBase64(raw, encryptionPassword);
      } catch {
        return Promise.reject({
          message: '数据解密失败，请检查两台电脑的加密密码是否一致。',
          code: MessageErrorCode.DecryptFailed,
        });
      }
    }

    if (protobufEncoding) {
      const compressedBuffer = base64ToArrayBuffer(processedContent);
      const decoded = await decodeCookiesMap(compressedBuffer);
      return pack(decoded);
    }

    const parsed = JSON.parse(processedContent);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid cookie map');
    }
    return pack(parsed);
  } catch {
    return Promise.reject({
      message: '同步数据解码或解密失败，请检查远程文件、编码设置和加密密码',
      code: MessageErrorCode.DecodeFailed,
    });
  }
}

export async function writeRemoteCookiesBundle(
  nextMap: ICookiesMap,
  previousBundle: RemoteCookieBundle,
): Promise<WriteResponse> {
  const settingsInfo = await settingsStorage.get();
  const protobufEncoding = settingsInfo?.protobufEncoding;
  const encryptionEnabled = settingsInfo?.encryptionEnabled;
  const encryptionPassword = settingsInfo?.encryptionPassword;

  if (encryptionEnabled && (!protobufEncoding || !encryptionPassword)) {
    throw new Error('已启用加密：请开启 Protobuf 编码并设置加密密码，拒绝明文上传');
  }

  const raw = previousBundle.raw;
  const remoteEncrypted = !!raw && !raw.startsWith('{') && isBase64Encrypted(raw);
  const formatMatches =
    !!raw &&
    (protobufEncoding ? !raw.startsWith('{') && remoteEncrypted === !!encryptionEnabled : raw.startsWith('{'));

  if (formatMatches && (await cookiesMapContentHash(nextMap)) === (await previousBundle.digestPromise)) {
    return { success: true, errors: [], unchanged: true };
  }

  let encoded = '';
  if (protobufEncoding) {
    const buffered = await encodeCookiesMap(nextMap);
    encoded = arrayBufferToBase64(buffered);
    if (encryptionEnabled && encryptionPassword) {
      encoded = await encryptBase64(encoded, encryptionPassword);
    }
  } else {
    encoded = JSON.stringify(nextMap);
  }

  const config = await webdavStorage.get();
  const url = buildWebdavUrl(config);
  if (!previousBundle.webdav || previousBundle.webdav.url !== url) {
    throw new Error('请先拉取 WebDAV 文件后再写入');
  }

  if (raw && settingsInfo?.rollingBackup !== false) {
    try {
      await backupIfDue(config, raw);
      const feedback = await syncFeedbackStorage.get();
      if (feedback.backupWarning) await syncFeedbackStorage.update({ backupWarning: undefined });
    } catch (error) {
      await syncFeedbackStorage
        .update({
          backupWarning: {
            at: Date.now(),
            message: `云端历史备份未写入（主文件不受影响）：${error instanceof Error ? error.message : '请求失败'}`,
          },
        })
        .catch(() => {});
    }
  }

  const result = await writeWebdav(config, encoded, previousBundle.webdav.snapshot);
  if (result.success) {
    await syncFeedbackStorage.update({ schemaWarning: undefined });
  }
  return result;
}
