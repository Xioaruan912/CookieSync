import { driveSitesFileName, readDrive, writeDrive } from './api';
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
    const previous = await readDrive(driveSitesFileName);
    const currentAccount = await driveAccountStorage.get();
    if (!currentAccount.connected || currentAccount.userId !== previous.userId)
      throw new Error('Google 账号已变化，未应用云端网站名单');
    const remote = decodeSitePolicy(previous.content);
    // Re-read after the network roundtrip so edits made while fetching are not lost.
    const local = await readSiteRules();
    const merged = mergeSiteRules(remote, local);
    const content = JSON.stringify({ version: 1, rules: merged });
    // Store remote rules before any cookie discovery; remote opt-outs apply on a new device's first cycle.
    if (JSON.stringify(merged) !== JSON.stringify(local)) await storeSiteRules(merged);
    if (content !== JSON.stringify({ version: 1, rules: remote }) || !previous.content)
      await writeDrive(content, previous);
  })().finally(() => {
    syncing = undefined;
  });
  return syncing;
}
