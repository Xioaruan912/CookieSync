import {
  applyPageStorageToTabs,
  automaticIntervalMs,
  domainContentHash,
  getSyncBaseline,
  matchesSitePage,
  matchesSiteScope,
  matchesSyncDomain,
  pullAndSetCookies,
  pullCookies,
  RuntimeMessageType,
  sessionStorageEnabled,
  setSyncBaseline,
  syncDestinationKey,
} from '@sync-your-cookie/shared';
import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { isAutomaticCookieAllowed, isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { readSiteRules, sitePolicyStorage } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { deviceIdentityStorage, syncRuntimeStorage } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { initActivityMonitor } from './activeDevice/activityMonitor';
import {
  enterStandby,
  ensureDeviceMetadata,
  handleUserActivity,
  isDeviceStandby,
  type ActivityTrigger,
} from './activeDevice/leaseManager';
import { registerContentHandler, registerExtensionHandler } from './router';
import { pullAllFromCloud, pushAllToCloud, type PullAllSummary } from './sync/batch';
import { captureAutomaticSync, clearDestinationJobs, getJobs, waitCapture } from './sync/capture';
import { discoverVisitedSite } from './sync/discovery';
import { indexedDbFor, readObserved, readPageStorage, sessionStorageFor } from './sync/pageBridge';
import { flushAutomaticSync, restoreAtStartup, syncErrorMessage, waitReconcile } from './sync/reconciler';
import { recheckStorageLimits } from './sync/storageLimits';

export {
  captureAutomaticSync,
  flushAutomaticSync,
  indexedDbFor,
  pullAllFromCloud,
  pushAllToCloud,
  readPageStorage,
  restoreAtStartup,
  sessionStorageFor,
  type PullAllSummary,
};

const alarmName = 'cookiesync-retry';
let backgroundReady: Promise<unknown> = Promise.resolve();
let sessionStartup: Promise<void> | undefined;
let connectionTimer: ReturnType<typeof setTimeout> | undefined;
let initialized = false;

export function setAutomaticSyncReady(ready: Promise<unknown>) {
  backgroundReady = ready;
}

export function triggerActiveHandover(trigger: ActivityTrigger) {
  return handleUserActivity(trigger, {
    onTakeover: async () => {
      await pullAllFromCloud({ reason: 'takeover', reloadMode: 'smart' });
    },
    onPullNewer: async () => {
      await restoreAtStartup(false, true);
    },
  });
}

export function startAutomaticSession(): Promise<void> {
  if (sessionStartup) return sessionStartup;
  sessionStartup = (async () => {
    await backgroundReady;
    await ensureDeviceMetadata();
    if (await syncRuntimeStorage.isSessionStarted()) return;
    await syncRuntimeStorage.markSessionStarted();
    const handover = await triggerActiveHandover('startup').catch(() => ({ role: 'active' as const, tookOver: false }));
    if (!handover.tookOver) {
      await restoreAtStartup();
    }
  })();
  return sessionStartup;
}

function scheduleReconcile() {
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = setTimeout(() => {
    connectionTimer = undefined;
    void backgroundReady.then(() => restoreAtStartup(true));
  }, 1000);
}

export function initAutomaticSync() {
  if (initialized) return;
  initialized = true;

  void ensureDeviceMetadata();
  const reconcileConnection = scheduleReconcile;
  sitePolicyStorage.subscribe(reconcileConnection);
  accountStorage.subscribe(reconcileConnection);
  webdavStorage.subscribe(() => {
    if (accountStorage.getSnapshot()?.selectedProvider === 'webdav') reconcileConnection();
  });

  const configureAlarm = async () => {
    const interval = automaticIntervalMs((await settingsStorage.get()).syncIntervalMinutes) / 60000;
    const existing = await chrome.alarms.get(alarmName);
    if (!existing || existing.periodInMinutes !== interval) {
      await chrome.alarms.create(alarmName, { periodInMinutes: interval });
    }
  };
  void domainConfigStorage.ensureDefaults();
  void configureAlarm();

  let wasEnabled = settingsStorage.getSnapshot()?.backgroundSync !== false;
  let wasDiscovering = settingsStorage.getSnapshot()?.autoDiscoverSites !== false;
  settingsStorage.subscribe(() => {
    void configureAlarm();
    const enabled = settingsStorage.getSnapshot()?.backgroundSync !== false;
    if (enabled && wasEnabled === false) reconcileConnection();
    const discovering = settingsStorage.getSnapshot()?.autoDiscoverSites !== false;
    if (enabled && discovering && !wasDiscovering) reconcileConnection();
    wasEnabled = enabled;
    wasDiscovering = discovering;
  });

  initActivityMonitor({
    onActive: trigger => {
      void backgroundReady.then(() => triggerActiveHandover(trigger)).catch(() => {});
    },
    onInactive: reason => {
      void backgroundReady
        .then(() =>
          enterStandby(reason, {
            flushBeforeStandby: () => flushAutomaticSync(true),
            clearStaleQueue: () => clearDestinationJobs(),
          }),
        )
        .catch(() => {});
    },
  });

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) void restoreAtStartup(true);
  });
  chrome.runtime.onStartup.addListener(() => {
    void startAutomaticSession();
  });
  chrome.cookies.onChanged.addListener(async ({ cookie, removed, cause }) => {
    // Chrome follows an overwrite removal with the replacement. Capture the settled cookie.
    if (removed && cause === 'overwrite') return;
    const config = await domainConfigStorage.get();
    let matched = false;
    for (const [host, item] of Object.entries(config.domainMap)) {
      if (!matchesSyncDomain(host, cookie.domain)) continue;
      matched = true;
      const passiveRemoval = removed && (cause === 'expired' || cause === 'evicted');
      if (item.autoPush !== false) void captureAutomaticSync(host, undefined, passiveRemoval, !removed).catch(() => {});
    }
    if (matched || removed) return;
    const settings = await settingsStorage.get();
    if (settings.backgroundSync === false || settings.autoDiscoverSites === false) return;
    for (const tab of await chrome.tabs.query({})) {
      if (tab.incognito || !tab.url?.startsWith('http')) continue;
      const url = new URL(tab.url);
      if (!matchesSyncDomain(url.hostname, cookie.domain)) continue;
      const host = await discoverVisitedSite(tab.url);
      if (host) await captureAutomaticSync(host, undefined, false, true);
    }
  });

  registerExtensionHandler(RuntimeMessageType.RunAutomaticSync, async () => {
    await backgroundReady;
    await restoreAtStartup(true, true);
    return { isOk: true, msg: '同步检查完成' };
  });

  registerExtensionHandler(RuntimeMessageType.RecheckStorageLimits, async () => {
    await backgroundReady;
    return { isOk: true, msg: '已复查存储上限', result: await recheckStorageLimits() };
  });

  registerExtensionHandler(RuntimeMessageType.PullAll, async () => {
    await backgroundReady;
    const result = await pullAllFromCloud();
    return { isOk: true, msg: '拉取全部完成', result };
  });

  registerExtensionHandler(RuntimeMessageType.PushAll, async () => {
    await backgroundReady;
    const result = await pushAllToCloud();
    return { isOk: true, msg: '全部上传完成', result };
  });

  registerExtensionHandler(RuntimeMessageType.TakeoverNow, async () => {
    await backgroundReady;
    const outcome = await triggerActiveHandover('manual');
    return { isOk: true, msg: outcome.tookOver ? '已接班同步完成' : '当前已是活跃主控电脑', result: outcome };
  });

  registerExtensionHandler(RuntimeMessageType.RenameDevice, async message => {
    const name = typeof message.name === 'string' ? message.name : '';
    const updated = await deviceIdentityStorage.rename(name);
    await ensureDeviceMetadata();
    return { isOk: true, msg: '设备名称已更新', result: updated };
  });

  const handleContentEvent = async (message: Record<string, unknown>, sender: chrome.runtime.MessageSender) => {
    const tabUrl = sender.tab!.url!;
    const hostname = new URL(tabUrl).host;
    await domainConfigStorage.ensureDefaults();
    const observed = readObserved(message, tabUrl);
    await discoverVisitedSite(tabUrl, observed, scheduleReconcile);
    const config = await domainConfigStorage.get();
    const rules = await readSiteRules();

    for (const [host, item] of Object.entries(config.domainMap)) {
      if (!isSiteAllowed(host, rules)) continue;
      if (!matchesSitePage(host, hostname) && !matchesSiteScope(host, hostname)) continue;

      if (message.type === RuntimeMessageType.PageReady) {
        if (item.autoPush !== false && (await settingsStorage.get()).backgroundSync !== false) {
          if (!(await getSyncBaseline(host))) {
            scheduleReconcile();
            continue;
          }
          await captureAutomaticSync(host, (await indexedDbFor(host)) ? undefined : observed, true);
        }
        if (item.autoPull !== false) {
          await waitReconcile();
          await waitCapture(host);
          if ((await getJobs(await syncDestinationKey()))[host]) continue;
          const pulledAt = await syncRuntimeStorage.getPulledAt(host);
          try {
            if (Date.now() - pulledAt < 5 * 60000) {
              const cached = (await cookieStorage.get()).domainCookieMap?.[host];
              const sessionOn = sessionStorageEnabled(
                (await settingsStorage.get()).includeSessionStorage,
                item.includeSessionStorage,
              );
              const idbOn = await indexedDbFor(host);
              if (
                cached?.localStorageItems?.length ||
                (sessionOn && cached?.sessionStorageItems?.length) ||
                (idbOn && cached?.indexedDBRecords?.length)
              ) {
                await applyPageStorageToTabs(host, cached.localStorageItems || [], cached.sessionStorageItems || [], {
                  targetTabId: sender.tab!.id,
                  includeSessionStorage: sessionOn,
                  includeIndexedDB: idbOn,
                  indexedDBRecords: (cached.indexedDBRecords || []).map(record => ({
                    database: record.database || '',
                    store: record.store || '',
                    key: record.key || '',
                    value: record.value || '',
                    origin: record.origin || '',
                  })),
                });
              }
            } else {
              await syncRuntimeStorage.markPulled(host);
              const remote = await pullCookies();
              await waitCapture(host);
              if ((await getJobs(await syncDestinationKey()))[host]) continue;
              if (remote.domainCookieMap?.[host]) {
                await pullAndSetCookies(tabUrl, host, false, remote, sender.tab!.id, cookie =>
                  isAutomaticCookieAllowed(cookie, host, rules),
                );
              } else {
                await setSyncBaseline(host, await domainContentHash());
                await captureAutomaticSync(host);
              }
            }
          } catch {
            /* Quiet page load. */
          }
        }
      } else if (item.autoPush !== false) {
        const finalCapture = message.finalCapture === true;
        await captureAutomaticSync(host, observed, finalCapture, finalCapture);
      }
    }
    return { isOk: true, msg: 'ok' };
  };

  registerContentHandler(RuntimeMessageType.PageReady, handleContentEvent);
  registerContentHandler(RuntimeMessageType.LocalStorageChanged, handleContentEvent);

  // Discover already-open sites after reload without triggering duplicate startups.
  reconcileConnection();
}

export { syncErrorMessage };
