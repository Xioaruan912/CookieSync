import {
  acknowledgeJobs,
  domainContentHash,
  getSyncBaseline,
  setSyncBaseline,
  syncDestinationKey,
  editSyncJobs,
  waitSyncJobEdits,
  canRestoreAtStartup,
  matchesSyncDomain,
  syncCookieDomain,
  isApplyingRemoteState,
  automaticIntervalMs,
  pickAutomaticLocalItems,
  applyLocalStorageToTabs,
  pullCookies,
  pullAndSetCookies,
  pushMultipleDomainCookies,
  type PendingSyncJob,
} from '@sync-your-cookie/shared';
import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { driveAccountStorage } from '@sync-your-cookie/storage/lib/driveStorage';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';

type ILocalStorageItem = PendingSyncJob['localStorageItems'][number];

type Jobs = Record<string, PendingSyncJob>;
const alarmName = 'cookiesync-retry';
let upload: Promise<void> | undefined;
let startup: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const captures = new Map<string, Promise<void>>();
let backgroundReady: Promise<unknown> = Promise.resolve();
let sessionStartup: Promise<void> | undefined;
let connectionTimer: ReturnType<typeof setTimeout> | undefined;
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
      ? String(error.message)
      : '自动同步失败，请检查连接和加密设置';

export function setAutomaticSyncReady(ready: Promise<unknown>) {
  backgroundReady = ready;
}

export function startAutomaticSession(): Promise<void> {
  if (sessionStartup) return sessionStartup;
  sessionStartup = (async () => {
    await backgroundReady;
    const key = 'cookiesync-session-started';
    if ((await chrome.storage.session.get(key))[key]) return;
    await chrome.storage.session.set({ [key]: true });
    await restoreAtStartup();
  })();
  return sessionStartup;
}

const queueKey = syncDestinationKey;

async function getJobs(key: string): Promise<Jobs> {
  return (await chrome.storage.local.get(key))[key] || {};
}

const editJobs = editSyncJobs;

async function localItems(host: string) {
  const settings = await settingsStorage.get();
  if (settings.includeLocalStorage === false) return [];
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url?.startsWith('http')) continue;
    const hostname = new URL(tab.url).host;
    if (hostname !== host && hostname.replace(/^www\./, '') !== host) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GetLocalStorage', payload: { domain: host } });
      if (response?.isOk) return response.result || [];
    } catch {
      /* Closed tab or content script unavailable: use last captured data. */
    }
  }
  return undefined;
}

export function captureAutomaticSync(host: string, observed?: ILocalStorageItem[], skipEmpty = false): Promise<void> {
  const next = (captures.get(host) || Promise.resolve())
    .catch(() => {})
    .then(() => captureNow(host, observed, skipEmpty));
  captures.set(host, next);
  return next.finally(() => {
    if (captures.get(host) === next) captures.delete(host);
  });
}

async function captureNow(host: string, observed?: ILocalStorageItem[], skipEmpty = false) {
  const settings = await settingsStorage.get();
  if (isApplyingRemoteState(host) || settings.backgroundSync === false) return;
  const config = (await domainConfigStorage.get()).domainMap[host];
  if (!config || config.autoPush === false) return;
  const baseline = await getSyncBaseline(host);
  if (!baseline) return;
  const key = await queueKey();
  const url = config.sourceUrl || `https://${host}`;
  const cookies = await chrome.cookies.getAll({ domain: syncCookieDomain(new URL(url).hostname) });
  const pending = (await getJobs(key))[host];
  const previous = (await cookieStorage.get()).domainCookieMap?.[host];
  const cached = previous?.localStorageItems || [];
  const items =
    settings.includeLocalStorage === false
      ? cached
      : pickAutomaticLocalItems(observed ?? (await localItems(host)), pending, cached);
  if (skipEmpty && !cookies.length && !items.length) return;
  if (skipEmpty) {
    // Passive discovery cannot distinguish browser session-cookie cleanup from logout.
    // Actual onChanged/pagehide captures use skipEmpty=false and keep explicit deletions.
    const identity = (cookie: { domain?: string | null; name?: string | null; path?: string | null }) =>
      `${cookie.domain || ''}\0${cookie.path || '/'}\0${cookie.name || ''}`;
    const localIds = new Set(cookies.map(identity));
    if (previous?.cookies?.some(cookie => cookie.session && !localIds.has(identity(cookie)))) return;
  }
  const job: PendingSyncJob = {
    domain: host,
    cookies,
    localStorageItems: items,
    userAgent: navigator.userAgent,
    revision: crypto.randomUUID(),
    baseHash: pending?.baseHash || baseline,
  };
  const digest = await domainContentHash(job);
  if (digest === baseline && !upload) {
    if (pending)
      await editJobs(key, jobs => {
        const next = { ...jobs };
        delete next[host];
        return next;
      });
    return;
  }
  if (pending && digest === (await domainContentHash(pending))) return;
  await editJobs(key, async jobs => ({
    ...jobs,
    [host]: { ...job, baseHash: jobs[host]?.baseHash || (await getSyncBaseline(host)) || job.baseHash },
  }));
  await autoSyncStatusStorage.update({ pendingCount: Object.keys(await getJobs(key)).length });
  if (!timer)
    timer = setTimeout(
      () => {
        timer = undefined;
        void flushAutomaticSync();
      },
      automaticIntervalMs((await settingsStorage.get()).syncIntervalMinutes),
    );
}

export async function flushAutomaticSync(force = false): Promise<void> {
  if (upload) return upload;
  upload = (async () => {
    const settings = await settingsStorage.get();
    if (settings.backgroundSync === false && !force) return;
    const key = await queueKey();
    await waitSyncJobEdits();
    const sent = await getJobs(key);
    if (!Object.keys(sent).length) return;
    const rateKey = `${key}-last-attempt`;
    const lastAttempt = (await chrome.storage.local.get(rateKey))[rateKey] || 0;
    if (!force && Date.now() - lastAttempt < automaticIntervalMs(settings.syncIntervalMinutes)) return;
    await chrome.storage.local.set({ [rateKey]: Date.now() });
    try {
      if (key !== (await queueKey())) return;
      await autoSyncStatusStorage.update({ phase: 'uploading', lastAttempt: Date.now() });
      const result = await pushMultipleDomainCookies(Object.values(sent));
      if (!('success' in result ? result.success : (result as unknown as { status?: number }).status === 200)) {
        throw new Error('自动同步上传失败');
      }
      const writtenHashes = Object.fromEntries(
        await Promise.all(Object.entries(sent).map(async ([host, job]) => [host, await domainContentHash(job)])),
      );
      await editJobs(key, jobs => acknowledgeJobs(jobs, sent, writtenHashes));
      await autoSyncStatusStorage.update({
        phase: 'idle',
        lastSuccess: Date.now(),
        error: '',
        pendingCount: Object.keys(await getJobs(key)).length,
      });
    } catch (error) {
      await autoSyncStatusStorage.update({
        phase: 'idle',
        lastAttempt: Date.now(),
        error: errorMessage(error),
        pendingCount: Object.keys(await getJobs(key)).length,
      });
      // Durable jobs remain for the next alarm, cookie change or browser startup.
    }
  })().finally(() => {
    upload = undefined;
  });
  return upload;
}

export async function restoreAtStartup(periodic = false, force = false): Promise<void> {
  if (startup) {
    await startup;
    // An explicit check must run after an in-flight cycle, not just acknowledge it.
    if (force) return restoreAtStartup(periodic, true);
    return;
  }
  startup = (async () => {
    const settings = await settingsStorage.get();
    if (periodic ? settings.backgroundSync === false : settings.startupPull === false) return;
    await domainConfigStorage.ensureDefaults();
    await autoSyncStatusStorage.update({ phase: 'checking', lastCheck: Date.now(), error: '' });
    try {
      // Capture against the last applied local cache before pullCookies replaces it.
      // A periodic scan also catches cookies that changed while the MV3 worker was asleep.
      const beforeRead = await domainConfigStorage.get();
      for (const [domain, item] of Object.entries(beforeRead.domainMap)) {
        if (item.autoPush !== false && (await getSyncBaseline(domain)))
          await captureAutomaticSync(domain, undefined, true);
      }
      const remote = await pullCookies();
      const config = await domainConfigStorage.get();
      for (const domain of new Set([...Object.keys(remote.domainCookieMap || {}), ...Object.keys(config.domainMap)])) {
        const item = config.domainMap[domain];
        await captures.get(domain)?.catch(() => {});
        const pending = await getJobs(await queueKey());
        if (pending[domain]) continue;
        await domainConfigStorage.updateItem(domain, {
          autoPull: item?.autoPull ?? true,
          autoPush: item?.autoPush ?? true,
        });
        try {
          if (!remote.domainCookieMap?.[domain]) {
            await setSyncBaseline(domain, await domainContentHash());
            await captureAutomaticSync(domain, undefined, true);
            continue;
          }
          if (!canRestoreAtStartup(domain, item?.autoPull, pending)) {
            // Send-only devices still need a remote baseline before their first push.
            if (item?.autoPush !== false && !(await getSyncBaseline(domain))) {
              await setSyncBaseline(domain, await domainContentHash(remote.domainCookieMap[domain]));
              await captureAutomaticSync(domain, undefined, true);
            }
            continue;
          }
          await pullAndSetCookies(item?.sourceUrl || `https://${domain}`, domain, false, remote);
          await chrome.storage.session.set({ [`cookiesync-pulled-${domain}`]: Date.now() });
        } catch (error) {
          await autoSyncStatusStorage.update({ error: errorMessage(error) });
        }
      }
      // Upload newly discovered data in this cycle, rather than waiting for a second alarm.
      if (settings.backgroundSync !== false) await flushAutomaticSync(force || !periodic);
      await autoSyncStatusStorage.update({
        phase: 'idle',
        pendingCount: Object.keys(await getJobs(await queueKey())).length,
      });
    } catch (error) {
      await autoSyncStatusStorage.update({ phase: 'idle', error: errorMessage(error) });
    }
  })().finally(() => {
    startup = undefined;
  });
  return startup;
}

export function initAutomaticSync() {
  const reconcileConnection = () => {
    if (connectionTimer) clearTimeout(connectionTimer);
    connectionTimer = setTimeout(() => {
      connectionTimer = undefined;
      void backgroundReady.then(() => restoreAtStartup(true));
    }, 1000);
  };
  accountStorage.subscribe(reconcileConnection);
  webdavStorage.subscribe(() => {
    if (accountStorage.getSnapshot()?.selectedProvider === 'webdav') reconcileConnection();
  });
  driveAccountStorage.subscribe(() => {
    if (
      accountStorage.getSnapshot()?.selectedProvider === 'google-drive' &&
      driveAccountStorage.getSnapshot()?.connected
    )
      reconcileConnection();
  });
  const configureAlarm = async () => {
    const interval = automaticIntervalMs((await settingsStorage.get()).syncIntervalMinutes) / 60000;
    const existing = await chrome.alarms.get(alarmName);
    if (!existing || existing.periodInMinutes !== interval)
      await chrome.alarms.create(alarmName, { periodInMinutes: interval });
  };
  void domainConfigStorage.ensureDefaults();
  void configureAlarm();
  let wasEnabled = settingsStorage.getSnapshot()?.backgroundSync !== false;
  settingsStorage.subscribe(() => {
    void configureAlarm();
    const enabled = settingsStorage.getSnapshot()?.backgroundSync !== false;
    if (enabled && wasEnabled === false) reconcileConnection();
    wasEnabled = enabled;
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) void restoreAtStartup(true);
  });
  chrome.runtime.onStartup.addListener(() => {
    void startAutomaticSession();
  });
  chrome.cookies.onChanged.addListener(async ({ cookie }) => {
    const config = await domainConfigStorage.get();
    for (const [host, item] of Object.entries(config.domainMap)) {
      if (item.autoPush !== false && matchesSyncDomain(host, cookie.domain))
        void captureAutomaticSync(host).catch(() => {});
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      message?.type === 'CookieSyncRunAutomaticSync' &&
      sender.id === chrome.runtime.id &&
      sender.url?.startsWith(chrome.runtime.getURL(''))
    ) {
      void backgroundReady
        .then(() => restoreAtStartup(true, true))
        .then(() => reply({ isOk: true }))
        .catch(() => reply({ isOk: false }));
      return true;
    }
    if (
      !['CookieSyncLocalStorageChanged', 'CookieSyncPageReady'].includes(message?.type) ||
      !sender.tab?.url?.startsWith('http')
    )
      return;
    const hostname = new URL(sender.tab.url).host;
    void domainConfigStorage
      .ensureDefaults()
      .then(() => domainConfigStorage.get())
      .then(async config => {
        for (const [host, item] of Object.entries(config.domainMap)) {
          if (hostname !== host && hostname.replace(/^www\./, '') !== host) continue;
          if (message.type === 'CookieSyncPageReady') {
            if (item.autoPull !== false) {
              if (startup) await startup;
              await captures.get(host)?.catch(() => {});
              if ((await getJobs(await queueKey()))[host]) continue;
              const pulledAt =
                (await chrome.storage.session.get(`cookiesync-pulled-${host}`))[`cookiesync-pulled-${host}`] || 0;
              try {
                if (Date.now() - pulledAt < 5 * 60000) {
                  const cached = (await cookieStorage.get()).domainCookieMap?.[host]?.localStorageItems || [];
                  if (cached.length) await applyLocalStorageToTabs(host, cached, sender.tab!.id);
                } else {
                  await chrome.storage.session.set({ [`cookiesync-pulled-${host}`]: Date.now() });
                  const remote = await pullCookies();
                  await captures.get(host)?.catch(() => {});
                  if ((await getJobs(await queueKey()))[host]) continue;
                  if (remote.domainCookieMap?.[host])
                    await pullAndSetCookies(sender.tab!.url!, host, false, remote, sender.tab!.id);
                  else {
                    await setSyncBaseline(host, await domainContentHash());
                    await captureAutomaticSync(host);
                  }
                }
              } catch {
                /* Quiet page load. */
              }
            }
          } else if (item.autoPush !== false) {
            const value = message.localStorageItems;
            const valid =
              Array.isArray(value) &&
              value.every(item => item && typeof item.key === 'string' && typeof item.value === 'string');
            await captureAutomaticSync(host, valid ? value : undefined);
          }
        }
        reply({ isOk: true });
      })
      .catch(() => reply({ isOk: false }));
    return true;
  });
}
