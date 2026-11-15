import {
  acknowledgeJobs,
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

type ILocalStorageItem = PendingSyncJob['localStorageItems'][number];

type Jobs = Record<string, PendingSyncJob>;
const alarmName = 'cookiesync-retry';
let edits: Promise<unknown> = Promise.resolve();
let upload: Promise<void> | undefined;
let startup: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const captures = new Map<string, Promise<void>>();
let backgroundReady: Promise<unknown> = Promise.resolve();
let sessionStartup: Promise<void> | undefined;

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

async function queueKey() {
  const account = await accountStorage.get();
  const settings = await settingsStorage.get();
  const dav = account.selectedProvider === 'webdav' ? await webdavStorage.get() : undefined;
  // Bind pending data to its destination so switching backends never uploads it elsewhere.
  const destination = JSON.stringify(
    account.selectedProvider === 'webdav'
      ? ['webdav', dav?.url, dav?.username, dav?.path]
      : [
          account.selectedProvider,
          account.accountId,
          account.namespaceId,
          settings.storageKeyGistId,
          settings.storageKey,
        ],
  );
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(destination));
  return 'cookiesync-pending-' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function getJobs(key: string): Promise<Jobs> {
  return (await chrome.storage.local.get(key))[key] || {};
}

function editJobs(key: string, update: (jobs: Jobs) => Jobs) {
  const run = async () => chrome.storage.local.set({ [key]: update(await getJobs(key)) });
  edits = edits.then(run, run);
  return edits;
}

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

export function captureAutomaticSync(host: string, observed?: ILocalStorageItem[]): Promise<void> {
  const next = (captures.get(host) || Promise.resolve()).catch(() => {}).then(() => captureNow(host, observed));
  captures.set(host, next);
  return next.finally(() => {
    if (captures.get(host) === next) captures.delete(host);
  });
}

async function captureNow(host: string, observed?: ILocalStorageItem[]) {
  const settings = await settingsStorage.get();
  if (isApplyingRemoteState(host) || settings.backgroundSync === false) return;
  const config = (await domainConfigStorage.get()).domainMap[host];
  if (!config?.autoPush) return;
  const key = await queueKey();
  const url = config.sourceUrl || `https://${host}`;
  const cookies = await chrome.cookies.getAll({ domain: syncCookieDomain(new URL(url).hostname) });
  const pending = (await getJobs(key))[host];
  const cached = (await cookieStorage.get()).domainCookieMap?.[host]?.localStorageItems || [];
  const items =
    settings.includeLocalStorage === false
      ? []
      : pickAutomaticLocalItems(observed ?? (await localItems(host)), pending, cached);
  const job: PendingSyncJob = {
    domain: host,
    cookies,
    localStorageItems: items,
    userAgent: navigator.userAgent,
    revision: crypto.randomUUID(),
  };
  await editJobs(key, jobs => ({ ...jobs, [host]: job }));
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
    await edits;
    const sent = await getJobs(key);
    if (!Object.keys(sent).length) return;
    const rateKey = `${key}-last-attempt`;
    const lastAttempt = (await chrome.storage.local.get(rateKey))[rateKey] || 0;
    if (!force && Date.now() - lastAttempt < automaticIntervalMs(settings.syncIntervalMinutes)) return;
    await chrome.storage.local.set({ [rateKey]: Date.now() });
    try {
      if (key !== (await queueKey())) return;
      const result = await pushMultipleDomainCookies(Object.values(sent));
      if (!('success' in result ? result.success : (result as unknown as { status?: number }).status === 200)) {
        throw new Error('自动同步上传失败');
      }
      await editJobs(key, jobs => acknowledgeJobs(jobs, sent));
      await chrome.storage.local.set({ 'cookiesync-auto-status': { lastSuccess: Date.now(), error: '' } });
    } catch (error) {
      await chrome.storage.local.set({
        'cookiesync-auto-status': {
          lastAttempt: Date.now(),
          error: error instanceof Error ? error.message : '自动同步失败，请检查连接和加密设置',
        },
      });
      // Durable jobs remain for the next alarm, cookie change or browser startup.
    }
  })().finally(() => {
    upload = undefined;
  });
  return upload;
}

export async function restoreAtStartup(): Promise<void> {
  if (startup) return startup;
  startup = (async () => {
    if ((await settingsStorage.get()).startupPull === false) return;
    await flushAutomaticSync(true);
    try {
      const remote = await pullCookies();
      const config = await domainConfigStorage.get();
      for (const domain of Object.keys(remote.domainCookieMap || {})) {
        const item = config.domainMap[domain];
        await captures.get(domain)?.catch(() => {});
        const pending = await getJobs(await queueKey());
        if (!canRestoreAtStartup(domain, item?.autoPull, pending)) continue;
        await domainConfigStorage.updateItem(domain, {
          autoPull: item?.autoPull ?? true,
          autoPush: item?.autoPush ?? true,
        });
        try {
          await pullAndSetCookies(item?.sourceUrl || `https://${domain}`, domain, false, remote);
          await chrome.storage.session.set({ [`cookiesync-pulled-${domain}`]: Date.now() });
        } catch {
          /* Continue restoring other domains. */
        }
      }
    } catch {
      // Opening the browser stays quiet even when offline or not configured yet.
    }
  })().finally(() => {
    startup = undefined;
  });
  return startup;
}

export function initAutomaticSync() {
  const configureAlarm = async () => {
    const interval = automaticIntervalMs((await settingsStorage.get()).syncIntervalMinutes) / 60000;
    const existing = await chrome.alarms.get(alarmName);
    if (!existing || existing.periodInMinutes !== interval)
      await chrome.alarms.create(alarmName, { periodInMinutes: interval });
  };
  void configureAlarm();
  settingsStorage.subscribe(() => {
    void configureAlarm();
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) void flushAutomaticSync();
  });
  chrome.runtime.onStartup.addListener(() => {
    void startAutomaticSession();
  });
  chrome.cookies.onChanged.addListener(async ({ cookie }) => {
    const config = await domainConfigStorage.get();
    for (const [host, item] of Object.entries(config.domainMap)) {
      if (item.autoPush && matchesSyncDomain(host, cookie.domain)) void captureAutomaticSync(host).catch(() => {});
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      !['CookieSyncLocalStorageChanged', 'CookieSyncPageReady'].includes(message?.type) ||
      !sender.tab?.url?.startsWith('http')
    )
      return;
    const hostname = new URL(sender.tab.url).host;
    void domainConfigStorage
      .get()
      .then(async config => {
        for (const [host, item] of Object.entries(config.domainMap)) {
          if (hostname !== host && hostname.replace(/^www\./, '') !== host) continue;
          if (message.type === 'CookieSyncPageReady') {
            if (item.autoPull) {
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
                  await pullAndSetCookies(sender.tab!.url!, host, false, undefined, sender.tab!.id);
                }
              } catch {
                /* Quiet page load. */
              }
            }
          } else if (item.autoPush) {
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
