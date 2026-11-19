import {
  acknowledgeJobs,
  domainContentHash,
  getSyncBaseline,
  setSyncBaseline,
  syncDestinationKey,
  editSyncJobs,
  waitSyncJobEdits,
  matchesSyncDomain,
  canonicalSiteHost,
  matchesSitePage,
  collectSiteCookies,
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
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { isSiteAllowed, isAutomaticCookieAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { readSiteRules, sitePolicyStorage } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { syncWebdavConfig } from '@sync-your-cookie/shared/lib/webdav/configSync';
import { missingLoginKeys, siteProfileFor, uaMismatchHint } from '@sync-your-cookie/shared/lib/siteProfiles';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { checkSiteHealth } from './healthCheck';

type ILocalStorageItem = PendingSyncJob['localStorageItems'][number];

type Jobs = Record<string, PendingSyncJob>;
const cookieAllowed = isAutomaticCookieAllowed;
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

async function getActiveJobs(key: string): Promise<Jobs> {
  const rules = await readSiteRules();
  const config = await domainConfigStorage.get();
  return Object.fromEntries(
    Object.entries(await getJobs(key)).filter(
      ([host]) => isSiteAllowed(host, rules) && config.domainMap[host]?.autoPush !== false,
    ),
  );
}

const editJobs = editSyncJobs;

async function localItems(host: string) {
  const settings = await settingsStorage.get();
  if (settings.includeLocalStorage === false) return [];
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url?.startsWith('http') || tab.incognito) continue;
    const hostname = new URL(tab.url).host;
    if (!matchesSitePage(host, hostname)) continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GetLocalStorage', payload: { domain: host } });
      if (response?.isOk) return response.result || [];
    } catch {
      /* Closed tab or content script unavailable: use last captured data. */
    }
  }
  return undefined;
}

function scheduleReconcile() {
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = setTimeout(() => {
    connectionTimer = undefined;
    void backgroundReady.then(() => restoreAtStartup(true));
  }, 1000);
}

async function discoverVisitedSite(rawUrl: string, observed?: ILocalStorageItem[], schedule = true) {
  let page: URL;
  try {
    page = new URL(rawUrl);
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password) return;
  const settings = await settingsStorage.get();
  if (!isSiteAllowed(page.hostname, await readSiteRules())) return;
  const config = await domainConfigStorage.get();
  const host =
    Object.keys(config.domainMap).find(site => matchesSitePage(site, page.host)) || canonicalSiteHost(page.host);
  const sourceUrl = page.origin + page.pathname;
  if (config.domainMap[host]) {
    if (config.domainMap[host].sourceUrl !== sourceUrl) await domainConfigStorage.updateItem(host, { sourceUrl });
    return host;
  }
  if (settings.backgroundSync === false || settings.autoDiscoverSites === false) return;
  const cookies = await collectSiteCookies(sourceUrl);
  const items = settings.includeLocalStorage === false ? [] : observed ?? (await localItems(host));
  const cached = (await cookieStorage.get()).domainCookieMap?.[host];
  if (!cookies.length && !items?.length && !cached?.cookies?.length && !cached?.localStorageItems?.length) return;
  // updateItem preserves explicit switches even if they changed while discovery was reading.
  await domainConfigStorage.updateItem(host, { sourceUrl });
  if (schedule) scheduleReconcile();
  return host;
}

async function discoverOpenSites() {
  const settings = await settingsStorage.get();
  if (settings.backgroundSync === false || settings.autoDiscoverSites === false) return;
  const tabs = await chrome.tabs.query({});
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (!tab.url || tab.incognito) continue;
    let page: URL;
    try {
      page = new URL(tab.url);
    } catch {
      continue;
    }
    if (seen.has(canonicalSiteHost(page.host))) continue;
    seen.add(canonicalSiteHost(page.host));
    await discoverVisitedSite(tab.url, undefined, false);
  }
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
  const rules = await readSiteRules();
  if (!isSiteAllowed(host, rules)) return;
  if (isApplyingRemoteState(host) || settings.backgroundSync === false) return;
  const config = (await domainConfigStorage.get()).domainMap[host];
  if (!config || config.autoPush === false) return;
  const baseline = await getSyncBaseline(host);
  if (!baseline) return;
  const key = await queueKey();
  const url = config.sourceUrl || `https://${host}`;
  const collected = (await collectSiteCookies(url)).filter(cookie => cookieAllowed(cookie, host, rules));
  const pending = (await getJobs(key))[host];
  const previous = (await cookieStorage.get()).domainCookieMap?.[host];
  // Preserve paused child-domain backups without collecting their current browser values.
  const cookies = [...collected, ...(previous?.cookies || []).filter(cookie => !cookieAllowed(cookie, host, rules))];
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
    capturedAt: Date.now(),
    baseHash: pending?.baseHash || baseline,
  };
  // A profile site without its full login cookie set cannot log any machine
  // in; record that honestly instead of shipping a dead session silently.
  const profile = siteProfileFor(host);
  if (profile)
    await siteHealthStorage.updateDomain(profile.domain, {
      loginKeysMissing: missingLoginKeys(profile, cookies).length > 0,
    });
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
  await autoSyncStatusStorage.update({ pendingCount: Object.keys(await getActiveJobs(key)).length });
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
    try {
      // The optional WebDAV config channel runs beside cookie uploads; its failure
      // is reported without blocking this cycle's cookie reconciliation.
      try {
        await syncWebdavConfig();
      } catch (configError) {
        await autoSyncStatusStorage.update({ error: errorMessage(configError) });
      }
      await waitSyncJobEdits();
      const sent = await getActiveJobs(key);
      if (!Object.keys(sent).length) return;
      const rateKey = `${key}-last-attempt`;
      const lastAttempt = (await chrome.storage.local.get(rateKey))[rateKey] || 0;
      if (!force && Date.now() - lastAttempt < automaticIntervalMs(settings.syncIntervalMinutes)) return;
      await chrome.storage.local.set({ [rateKey]: Date.now() });
      if (key !== (await queueKey())) return;
      await autoSyncStatusStorage.update({ phase: 'uploading', lastAttempt: Date.now() });
      const rules = await readSiteRules();
      const result = await pushMultipleDomainCookies(Object.values(sent), (cookie, host) =>
        cookieAllowed(cookie, host, rules),
      );
      if (!result.success) {
        throw new Error('自动同步上传失败');
      }
      // Newer-wins: domains whose remote copy is newer keep their pending job and
      // baseline; the next reconciliation applies the remote state locally.
      const adoptedDomains = new Set(result.adopted.map(item => item.domain));
      const acknowledged = Object.fromEntries(
        Object.entries(sent).filter(([host]) => !adoptedDomains.has(host)),
      );
      const writtenHashes = Object.fromEntries(
        await Promise.all(
          Object.entries(acknowledged).map(async ([host, job]) => [
            host,
            (await getSyncBaseline(host)) || (await domainContentHash(job)),
          ]),
        ),
      );
      await editJobs(key, jobs => acknowledgeJobs(jobs, acknowledged, writtenHashes));
      await autoSyncStatusStorage.update({
        phase: 'idle',
        lastSuccess: Date.now(),
        error: '',
        note: adoptedDomains.size
          ? `云端较新，已保留 ${[...adoptedDomains].join('、')} 的云端数据，稍后自动应用`
          : undefined,
        pendingCount: Object.keys(await getActiveJobs(key)).length,
      });
    } catch (error) {
      await autoSyncStatusStorage.update({
        phase: 'idle',
        lastAttempt: Date.now(),
        error: errorMessage(error),
        pendingCount: Object.keys(await getActiveJobs(key)).length,
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
    if (periodic ? settings.backgroundSync === false : settings.startupPull === false) {
      try {
        await syncWebdavConfig();
      } catch (error) {
        await autoSyncStatusStorage.update({ error: errorMessage(error) });
      }
      return;
    }
    await domainConfigStorage.ensureDefaults();
    await autoSyncStatusStorage.update({ phase: 'checking', lastCheck: Date.now(), error: '' });
    const adoptedRemote: string[] = [];
    try {
      try {
        await syncWebdavConfig();
      } catch (configError) {
        await autoSyncStatusStorage.update({ error: errorMessage(configError) });
      }
      const rules = await readSiteRules();
      await discoverOpenSites();
      // Capture against the last applied local cache before pullCookies replaces it.
      // A periodic scan also catches cookies that changed while the MV3 worker was asleep.
      const beforeRead = await domainConfigStorage.get();
      for (const [domain, item] of Object.entries(beforeRead.domainMap)) {
        if (isSiteAllowed(domain, rules) && item.autoPush !== false && (await getSyncBaseline(domain)))
          await captureAutomaticSync(domain, undefined, true);
      }
      const remote = await pullCookies();
      const config = await domainConfigStorage.get();
      for (const domain of new Set([...Object.keys(remote.domainCookieMap || {}), ...Object.keys(config.domainMap)])) {
        if (!isSiteAllowed(domain, rules)) continue;
        const item = config.domainMap[domain];
        await captures.get(domain)?.catch(() => {});
        const pending = await getJobs(await queueKey());
        await domainConfigStorage.updateItem(domain, {
          autoPull: item?.autoPull ?? true,
          autoPush: item?.autoPush ?? true,
        });
        try {
          const remoteEntry = remote.domainCookieMap?.[domain];
          if (!remoteEntry) {
            if (pending[domain]) continue;
            await setSyncBaseline(domain, await domainContentHash());
            await captureAutomaticSync(domain, undefined, true);
            continue;
          }
          const pendingJob = pending[domain];
          // Newer wins: when both sides changed and the remote write is newer than
          // the local capture, drop the pending job and take the remote copy.
          const adoptRemote =
            !!pendingJob &&
            item?.autoPull !== false &&
            typeof pendingJob.capturedAt === 'number' &&
            Number.isFinite(pendingJob.capturedAt) &&
            (Number(remoteEntry.updateTime) || 0) > pendingJob.capturedAt;
          if (adoptRemote) {
            await editJobs(await queueKey(), jobs => {
              const next = { ...jobs };
              delete next[domain];
              return next;
            });
            adoptedRemote.push(domain);
          } else if (pendingJob || item?.autoPull === false) {
            // Local pending changes win here; send-only devices still need a remote
            // baseline before their first push.
            if (item?.autoPush !== false && !(await getSyncBaseline(domain))) {
              await setSyncBaseline(domain, await domainContentHash(remoteEntry));
              await captureAutomaticSync(domain, undefined, true);
            }
            continue;
          }
          await pullAndSetCookies(item?.sourceUrl || `https://${domain}`, domain, false, remote, undefined, cookie =>
            cookieAllowed(cookie, domain, rules),
          );
          await chrome.storage.session.set({ [`cookiesync-pulled-${domain}`]: Date.now() });
          // Profile sites: explain the restored session instead of letting the
          // user discover a dead login on the page.
          const profile = siteProfileFor(domain);
          if (profile?.healthCheck) {
            const missing = missingLoginKeys(profile, remoteEntry.cookies);
            if (missing.length) {
              // A local diagnosis, not a server probe: no checkedAt here, so a
              // later complete restore verifies immediately instead of waiting
              // out the health-check cooldown.
              await siteHealthStorage.updateDomain(profile.domain, {
                state: 'invalid',
                userName: undefined,
                loginKeysMissing: false,
                message: `云端快照缺少登录要素（${missing.join('、')}），请在已登录电脑重新推送`,
              });
            } else {
              const uaHint = profile.uaSensitive ? uaMismatchHint(remoteEntry.userAgent, navigator.userAgent) : undefined;
              await siteHealthStorage.updateDomain(profile.domain, { loginKeysMissing: false, message: uaHint });
              void checkSiteHealth(domain);
            }
          }
        } catch (error) {
          await autoSyncStatusStorage.update({ error: errorMessage(error) });
        }
      }
      // Upload newly discovered data in this cycle, rather than waiting for a second alarm.
      if (settings.backgroundSync !== false) await flushAutomaticSync(force || !periodic);
      const finalStatus: { phase: 'idle'; pendingCount: number; note?: string } = {
        phase: 'idle',
        pendingCount: Object.keys(await getActiveJobs(await queueKey())).length,
      };
      if (adoptedRemote.length)
        finalStatus.note = `本机修改较早，已采用 ${adoptedRemote.join('、')} 的云端数据`;
      await autoSyncStatusStorage.update(finalStatus);
    } catch (error) {
      await autoSyncStatusStorage.update({ phase: 'idle', error: errorMessage(error) });
    }
  })().finally(() => {
    startup = undefined;
  });
  return startup;
}

export function initAutomaticSync() {
  const reconcileConnection = scheduleReconcile;
  sitePolicyStorage.subscribe(reconcileConnection);
  accountStorage.subscribe(reconcileConnection);
  webdavStorage.subscribe(() => {
    if (accountStorage.getSnapshot()?.selectedProvider === 'webdav') reconcileConnection();
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
      !sender.tab?.url?.startsWith('http') ||
      sender.tab.incognito
    )
      return;
    const hostname = new URL(sender.tab.url).host;
    void domainConfigStorage
      .ensureDefaults()
      .then(async () => {
        const value = message.localStorageItems;
        const observed =
          Array.isArray(value) &&
          value.every(item => item && typeof item.key === 'string' && typeof item.value === 'string')
            ? value
            : undefined;
        await discoverVisitedSite(sender.tab!.url!, observed);
        return domainConfigStorage.get();
      })
      .then(async config => {
        for (const [host, item] of Object.entries(config.domainMap)) {
          const rules = await readSiteRules();
          if (!isSiteAllowed(host, rules)) continue;
          if (!matchesSitePage(host, hostname)) continue;
          if (message.type === 'CookieSyncPageReady') {
            if (item.autoPush !== false && (await settingsStorage.get()).backgroundSync !== false) {
              if (!(await getSyncBaseline(host))) {
                scheduleReconcile();
                continue;
              }
              const value = message.localStorageItems;
              const observed =
                Array.isArray(value) &&
                value.every(item => item && typeof item.key === 'string' && typeof item.value === 'string')
                  ? value
                  : undefined;
              await captureAutomaticSync(host, observed, true);
            }
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
                    await pullAndSetCookies(sender.tab!.url!, host, false, remote, sender.tab!.id, cookie =>
                      cookieAllowed(cookie, host, rules),
                    );
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
  // Also discover already-open sites after an extension reload, when old pages cannot send new messages.
  reconcileConnection();
}
