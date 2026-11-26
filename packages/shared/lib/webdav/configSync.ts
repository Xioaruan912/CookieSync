import { isNeedsCompatibilityError, readWebdav, writeWebdav, type WebdavConfig, type WebdavSnapshot } from './api';
import {
  adoptPreferences,
  mergePreferences,
  type RemotePreferences,
} from '@sync-your-cookie/storage/lib/remotePreferences';
import { mergeSiteRules, type SiteRules } from '@sync-your-cookie/storage/lib/commonSites';
import { readSiteRules, storeSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';

/**
 * Optional config channel for users who do not use Chrome Sync: site rules and
 * extension preferences merge through a JSON file next to the cookie file on
 * the same WebDAV destination. WebDAV credentials and the encryption password
 * never enter this file.
 */
export const webdavConfigFileName = 'CookieSync-config-v1.json';
const maxConfigSize = 100000;

/** The config file lives beside the cookie file so one directory holds everything. */
export function webdavConfigPath(cookiePath: string): string {
  const segments = cookiePath.trim().split('/');
  segments[segments.length - 1] = webdavConfigFileName;
  return segments.join('/');
}

export function webdavConfigDestination(base: WebdavConfig): WebdavConfig {
  return { ...base, path: webdavConfigPath(base.path) };
}

interface RemoteConfigPayload {
  version: 1;
  rules: SiteRules;
  preferences: RemotePreferences;
}

function decodeConfig(content: string): RemoteConfigPayload {
  if (content.length > maxConfigSize) throw new Error('云端配置文件过大，未应用');
  const value = JSON.parse(content);
  if (value?.version !== 1 || !value.rules || typeof value.rules !== 'object' || Array.isArray(value.rules))
    throw new Error('云端配置文件格式错误，未覆盖本机设置');
  if (Object.keys(value.rules).length > 400) throw new Error('云端网站名单超过 400 条自定义及关闭规则');
  if (value.preferences !== undefined && (typeof value.preferences !== 'object' || value.preferences === null))
    throw new Error('云端扩展设置格式错误');
  // mergePreferences validates every preference entry.
  mergePreferences(value.preferences ?? {});
  return { version: 1, rules: mergeSiteRules(value.rules), preferences: value.preferences ?? {} };
}

let syncing: Promise<void> | undefined;

/**
 * No-op unless the config channel is 'webdav' and a WebDAV destination exists.
 * Reads the remote file, merges it with local rules and preferences, and writes
 * the merged snapshot back with the same conditional write as cookie data.
 */
export async function syncWebdavConfig(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const settings = await settingsStorage.get();
    if (settings.configChannel !== 'webdav') return;
    const base = await webdavStorage.get();
    if (!base.url.trim() || !base.username.trim() || !base.password) return;
    const config = webdavConfigDestination(base);
    const snapshot: WebdavSnapshot = await readWebdav(config);
    const remote = snapshot.content ? decodeConfig(snapshot.content) : { version: 1, rules: {}, preferences: {} };

    const local = await readSiteRules();
    const rules = mergeSiteRules(remote.rules, local);
    if (JSON.stringify(rules) !== JSON.stringify(local)) await storeSiteRules(rules);
    const preferences = await adoptPreferences(remote.preferences);
    const rulesNow = await readSiteRules();
    const payload: RemoteConfigPayload = { version: 1, rules: rulesNow, preferences };
    const encoded = JSON.stringify(payload);
    if (encoded === snapshot.content || encoded.length > maxConfigSize) {
      if (encoded.length > maxConfigSize) throw new Error('配置快照过大，已保留本机修改');
      return; // Local and remote already agree.
    }
    try {
      await writeWebdav(config, encoded, snapshot);
    } catch (error) {
      if (!config.allowUnsafeWrites && isNeedsCompatibilityError(error)) {
        await webdavStorage.update({ ...base, allowUnsafeWrites: true });
        await writeWebdav({ ...config, allowUnsafeWrites: true }, encoded, snapshot);
      } else {
        throw error;
      }
    }
  })()
    .catch(error => {
      throw new Error('WebDAV · 配置同步：' + (error instanceof Error ? error.message : '请求失败'));
    })
    .finally(() => {
      syncing = undefined;
    });
  return syncing;
}
