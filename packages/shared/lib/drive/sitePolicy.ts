import { openDriveConfiguration } from './api';
import {
  adoptPreferences,
  mergePreferences,
  type DrivePreferences,
} from '@sync-your-cookie/storage/lib/drivePreferences';
import { driveAccountStorage } from '@sync-your-cookie/storage/lib/driveStorage';
import { mergeSiteRules, type SiteRules } from '@sync-your-cookie/storage/lib/commonSites';
import { readSiteRules, storeSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';

export function decodeSitePolicy(content: string): SiteRules {
  if (!content) return {};
  if (content.length > 100000) throw new Error('云端网站名单配置过大');
  const value = JSON.parse(content);
  if (value?.version !== 1 || !value.rules || typeof value.rules !== 'object' || Array.isArray(value.rules))
    throw new Error('云端网站名单配置格式错误，未覆盖本机设置');
  if (Object.keys(value.rules).length > 400) throw new Error('云端网站名单超过 400 条自定义及关闭规则');
  return mergeSiteRules(value.rules);
}

let syncing: Promise<void> | undefined;
export async function syncSitePolicy(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const account = await driveAccountStorage.get();
    if (!account.connected) return;
    const cloud = await openDriveConfiguration();
    let remote: SiteRules = {};
    let preferences: DrivePreferences = {};
    const cacheKey = 'cookiesync-drive-config-cache-v2';
    const cache = (await chrome.storage.session.get(cacheKey))[cacheKey];
    const versions = Object.fromEntries(cloud.files.map(file => [file.id, file.version || '']));
    const reusable =
      cache?.userId === cloud.userId &&
      Object.keys(cache.versions).every(id => !!versions[id] && versions[id] === cache.versions[id]);
    if (reusable) {
      remote = mergeSiteRules(cache.rules);
      preferences = mergePreferences(cache.preferences);
    }
    for (const file of cloud.files) {
      if (reusable && file.version && cache.versions[file.id] === file.version) continue;
      const content = await cloud.read(file.id);
      if (!content || content.length > 100000) throw new Error('配置快照为空或过大');
      const data = JSON.parse(content);
      if (data?.version === 1) remote = mergeSiteRules(remote, decodeSitePolicy(content));
      else if (data?.version === 2) {
        remote = mergeSiteRules(remote, decodeSitePolicy(JSON.stringify({ version: 1, rules: data.rules })));
        preferences = mergePreferences(preferences, data.preferences);
      } else throw new Error('云端配置格式错误');
    }
    const currentAccount = await driveAccountStorage.get();
    if (!currentAccount.connected || currentAccount.userId !== cloud.userId)
      throw new Error('Google 账号已变化，未应用云端配置');
    if (!reusable || Object.keys(versions).length !== Object.keys(cache.versions).length)
      await chrome.storage.session.set({ [cacheKey]: { userId: cloud.userId, versions, rules: remote, preferences } });
    const local = await readSiteRules();
    const rules = mergeSiteRules(remote, local);
    if (JSON.stringify(rules) !== JSON.stringify(local)) await storeSiteRules(rules);
    const merged = await adoptPreferences(preferences);
    if (JSON.stringify(rules) !== JSON.stringify(remote) || JSON.stringify(merged) !== JSON.stringify(preferences)) {
      const snapshot = JSON.stringify({ version: 2, rules, preferences: merged });
      if (snapshot.length > 100000) throw new Error('配置快照过大，已保留本机修改');
      await cloud.append(snapshot);
    }
  })()
    .catch(error => {
      throw new Error('Google Drive · 网站名单与扩展设置：' + (error instanceof Error ? error.message : '请求失败'));
    })
    .finally(() => {
      syncing = undefined;
    });
  return syncing;
}
