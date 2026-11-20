import {
  buildDiagnostics,
  buildWebdavUrl,
  editSyncJobs,
  pullAndSetCookies,
  pushMultipleDomainCookies,
  refreshRemoteCookies,
  restoreBackup,
  backupStatus,
  syncDestinationKey,
  type DiagnosticsSite,
} from '@sync-your-cookie/shared';
import { isAutomaticCookieAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { cookieStorage, type Cookie } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteActivityStorage } from '@sync-your-cookie/storage/lib/siteActivityStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { snapshotStorage, type Snapshot } from '@sync-your-cookie/storage/lib/snapshotStorage';
import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';

const truncatedKey = 'cookiesync-storage-truncated';
const skippedIndexedDbKey = 'cookiesync-indexeddb-skipped';

const fromExtensionPage = (sender: chrome.runtime.MessageSender) =>
  sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));

/** Local rollback points come from the last applied copy; they are cheap and bounded. */
export async function snapshotLocal(reason: Snapshot['reason'], domains?: string[]) {
  const cached = (await cookieStorage.get()).domainCookieMap || {};
  const config = await domainConfigStorage.get();
  const rules = await readSiteRules();
  const sites: Snapshot['sites'] = {};
  for (const domain of domains || Object.keys(config.domainMap)) {
    const entry = cached[domain];
    if (!entry || !isSiteAllowed(domain, rules)) continue;
    sites[domain] = {
      domain,
      cookies: entry.cookies || [],
      localStorageItems: entry.localStorageItems || [],
      sessionStorageItems: entry.sessionStorageItems || [],
      indexedDBRecords: entry.indexedDBRecords || [],
      userAgent: entry.userAgent || '',
      updateTime: Number(entry.updateTime) || Date.now(),
    };
  }
  if (!Object.keys(sites).length) return;
  await snapshotStorage
    .add({ id: crypto.randomUUID(), at: Date.now(), kind: 'local', reason, sites })
    .catch(() => {});
}

/** Remote rollback points keep the cloud copy that a push is about to replace. */
export async function snapshotRemote(map: Cookie, reason: Snapshot['reason']) {
  const rules = await readSiteRules();
  const sites: Snapshot['sites'] = {};
  for (const [domain, entry] of Object.entries(map.domainCookieMap || {})) {
    if (!isSiteAllowed(domain, rules)) continue;
    sites[domain] = {
      domain,
      cookies: (entry.cookies as Snapshot['sites'][string]['cookies']) || [],
      localStorageItems: (entry.localStorageItems as Snapshot['sites'][string]['localStorageItems']) || [],
      sessionStorageItems: (entry.sessionStorageItems as Snapshot['sites'][string]['sessionStorageItems']) || [],
      indexedDBRecords: (entry.indexedDBRecords as Snapshot['sites'][string]['indexedDBRecords']) || [],
      userAgent: entry.userAgent || '',
      updateTime: Number(entry.updateTime) || Date.now(),
    };
  }
  if (!Object.keys(sites).length) return;
  await snapshotStorage
    .add({ id: crypto.randomUUID(), at: Date.now(), kind: 'remote', reason, sites })
    .catch(() => {});
}

async function rollback(id: string) {
  const snapshot = (await snapshotStorage.get()).find(entry => entry.id === id);
  if (!snapshot) throw new Error('回滚点不存在或已被清理');
  const rules = await readSiteRules();
  const config = await domainConfigStorage.get();
  const key = await syncDestinationKey();
  let sites = 0;
  if (snapshot.kind === 'local') {
    for (const [domain, site] of Object.entries(snapshot.sites)) {
      if (!isSiteAllowed(domain, rules)) continue;
      const url = config.domainMap[domain]?.sourceUrl || `https://${domain}`;
      await pullAndSetCookies(
        url,
        domain,
        true,
        { domainCookieMap: { [domain]: { ...site, updateTime: site.updateTime || Date.now() } } },
        undefined,
        cookie => isAutomaticCookieAllowed(cookie, domain, rules),
      );
      sites++;
    }
  } else {
    const entries = Object.entries(snapshot.sites)
      .filter(([domain]) => isSiteAllowed(domain, rules))
      .map(([, site]) => site);
    const result = await pushMultipleDomainCookies(entries, (cookie, host) =>
      isAutomaticCookieAllowed(cookie, host, rules),
    );
    if (!result.success) throw new Error('回滚到云端失败，请检查连接和加密设置');
    sites = entries.length;
  }
  await editSyncJobs(key, jobs => {
    const next = { ...jobs };
    for (const domain of Object.keys(snapshot.sites)) delete next[domain];
    return next;
  });
  return { kind: snapshot.kind, sites };
}

async function diagnostics() {
  const settings = await settingsStorage.get();
  const config = await domainConfigStorage.get();
  const rules = await readSiteRules();
  const cached = (await cookieStorage.get()).domainCookieMap || {};
  const key = await syncDestinationKey();
  const pending = ((await chrome.storage.local.get(key))[key] || {}) as Record<string, Record<string, unknown[]>>;
  const health = await siteHealthStorage.get();
  const activity = await siteActivityStorage.get();
  const truncated = ((await chrome.storage.local.get(truncatedKey))[truncatedKey] || {}) as Record<string, number>;
  const indexedDbSkipped = ((await chrome.storage.local.get(skippedIndexedDbKey))[skippedIndexedDbKey] || {}) as Record<
    string,
    string[]
  >;
  const dav = await webdavStorage.get();
  let destination: { origin?: string; path?: string };
  try {
    destination = { origin: dav.url?.trim() ? new URL(buildWebdavUrl(dav)).origin : undefined, path: dav.path };
  } catch {
    destination = { path: dav.path };
  }
  const sites: DiagnosticsSite[] = Object.keys({ ...config.domainMap, ...cached }).map(domain => {
    const entry = cached[domain];
    const pendingEntry = pending[domain] as Record<string, unknown[]> | undefined;
    return {
      domain,
      listed: isSiteAllowed(domain, rules),
      autoPush: config.domainMap[domain]?.autoPush !== false,
      autoPull: config.domainMap[domain]?.autoPull !== false,
      includeSessionStorage: config.domainMap[domain]?.includeSessionStorage ?? settings.includeSessionStorage === true,
      includeIndexedDB: config.domainMap[domain]?.includeIndexedDB ?? settings.includeIndexedDB === true,
      cookies: entry?.cookies || [],
      localStorageItems: entry?.localStorageItems || [],
      sessionStorageItems: entry?.sessionStorageItems || [],
      indexedDBRecords: entry?.indexedDBRecords || [],
      pending: pendingEntry
        ? {
            cookies: pendingEntry.cookies?.length || 0,
            localStorageItems: pendingEntry.localStorageItems?.length || 0,
            sessionStorageItems: pendingEntry.sessionStorageItems?.length || 0,
            indexedDBRecords: pendingEntry.indexedDBRecords?.length || 0,
            capturedAt: Number(pendingEntry.capturedAt) || undefined,
          }
        : undefined,
      health: health[domain],
      lastPushAt: activity[domain]?.lastPushAt,
      lastPullAt: activity[domain]?.lastPullAt,
      error: activity[domain]?.lastPushOk === false ? activity[domain]?.message : undefined,
    };
  });
  const feedback = await syncFeedbackStorage.get();
  return buildDiagnostics({
    version: chrome.runtime.getManifest().version,
    now: Date.now(),
    platform: navigator.userAgent,
    settings: {
      includeLocalStorage: settings.includeLocalStorage !== false,
      includeSessionStorage: settings.includeSessionStorage === true,
      includeIndexedDB: settings.includeIndexedDB === true,
      protobufEncoding: settings.protobufEncoding === true,
      encryptionEnabled: settings.encryptionEnabled === true,
      configChannel: settings.configChannel,
      rollingBackup: settings.rollingBackup !== false,
      backgroundSync: settings.backgroundSync !== false,
      autoDiscoverSites: settings.autoDiscoverSites !== false,
    },
    destination,
    connected: !!dav.url?.trim() && !!dav.username?.trim() && !!dav.password,
    sites,
    status: await autoSyncStatusStorage.get(),
    schemaWarning: feedback.schemaWarning,
    truncated,
    indexedDbSkipped,
  });
}

export function initSafety() {
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!fromExtensionPage(sender)) return;
    if (message?.type === 'CookieSyncRollback' && typeof message.id === 'string') {
      void rollback(message.id)
        .then(result => reply({ isOk: true, result }))
        .catch(error => reply({ isOk: false, msg: error?.message || '回滚失败' }));
      return true;
    }
    if (message?.type === 'CookieSyncDiagnostics') {
      void diagnostics()
        .then(result => reply({ isOk: true, result }))
        .catch(error => reply({ isOk: false, msg: error?.message || '导出诊断失败' }));
      return true;
    }
    if (message?.type === 'CookieSyncBackupInfo') {
      void webdavStorage
        .get()
        .then(config => backupStatus(config))
        .then(result => reply({ isOk: true, result }))
        .catch(error => reply({ isOk: false, msg: error?.message || '读取备份信息失败' }));
      return true;
    }
    if (message?.type === 'CookieSyncRestoreBackup' && Number.isInteger(message.slot)) {
      void (async () => {
        const config = await webdavStorage.get();
        const result = await restoreBackup(config, message.slot);
        await refreshRemoteCookies();
        return result;
      })()
        .then(result => reply({ isOk: true, result }))
        .catch(error => reply({ isOk: false, msg: error?.message || '恢复备份失败' }));
      return true;
    }
    return;
  });
}
