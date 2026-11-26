import {
  automaticIntervalMs,
  collectSitePayload,
  domainContentHash,
  editSyncJobs,
  getSyncBaseline,
  isApplyingRemoteState,
  isFastSyncSite,
  missingLoginKeys,
  siteProfileFor,
  syncDestinationKey,
  type PendingSyncJob,
  type StorageSnapshot,
} from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { syncRuntimeStorage } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { isDeviceStandby, isDeviceTakingOver } from '../activeDevice/leaseManager';
import { readPageStorage } from './pageBridge';

export type Jobs = Record<string, PendingSyncJob>;

const SESSION_THROTTLE_MS = 10 * 60000;
const FAST_UPLOAD_MS = 1000;
const NORMAL_UPLOAD_MS = 4000;

const captures = new Map<string, Promise<void>>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushDueAt = 0;
let flushExpedited = false;
let flushCallback: ((expedited: boolean) => Promise<void>) | undefined;
let isUploadingFn: () => boolean = () => false;

export function bindCaptureFlush(callback: (expedited: boolean) => Promise<void>, isUploading: () => boolean) {
  flushCallback = callback;
  isUploadingFn = isUploading;
}

export async function getJobs(key: string): Promise<Jobs> {
  return (await chrome.storage.local.get(key))[key] || {};
}

export async function getActiveJobs(key: string): Promise<Jobs> {
  const rules = await readSiteRules();
  const config = await domainConfigStorage.get();
  return Object.fromEntries(
    Object.entries(await getJobs(key)).filter(
      ([host]) => isSiteAllowed(host, rules) && config.domainMap[host]?.autoPush !== false,
    ),
  );
}

export async function clearDestinationJobs(key?: string): Promise<void> {
  const targetKey = key || (await syncDestinationKey());
  await editSyncJobs(targetKey, () => ({}));
  await autoSyncStatusStorage.update({ pendingCount: 0 }).catch(() => {});
}

export async function waitCapture(host: string): Promise<void> {
  await captures.get(host)?.catch(() => {});
}

function normalizeObserved(
  observed: StorageSnapshot | PendingSyncJob['localStorageItems'] | undefined,
): StorageSnapshot | undefined {
  if (!observed) return undefined;
  if (Array.isArray(observed)) {
    return { origin: '', localStorageItems: observed, sessionStorageItems: [], truncated: 0 };
  }
  return observed;
}

async function recordGuardedDomain(host: string, guarded: boolean) {
  const current = (await autoSyncStatusStorage.get()).guardedDomains || [];
  const next = guarded ? [...new Set([...current, host])] : current.filter(item => item !== host);
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    await autoSyncStatusStorage.update({ guardedDomains: next }).catch(() => {});
  }
}

export function captureAutomaticSync(
  host: string,
  observed?: StorageSnapshot | PendingSyncJob['localStorageItems'],
  skipEmpty = false,
  urgent = false,
): Promise<void> {
  const next = (captures.get(host) || Promise.resolve())
    .catch(() => {})
    .then(() => captureNow(host, normalizeObserved(observed), skipEmpty, urgent));
  captures.set(host, next);
  return next.finally(() => {
    if (captures.get(host) === next) captures.delete(host);
  });
}

async function captureNow(host: string, observed: StorageSnapshot | undefined, skipEmpty: boolean, urgent: boolean) {
  // Never capture or queue changes while standby or actively taking over from another PC.
  const settings = await settingsStorage.get();
  if (settings.activeDeviceSync !== false && (isDeviceStandby() || isDeviceTakingOver())) return;
  const rules = await readSiteRules();
  if (!isSiteAllowed(host, rules)) return;
  if (isApplyingRemoteState(host) || settings.backgroundSync === false) return;

  const config = (await domainConfigStorage.get()).domainMap[host];
  if (!config || config.autoPush === false) return;

  const baseline = await getSyncBaseline(host);
  if (!baseline) {
    if (!urgent && !observed) return;
    const dav = await webdavStorage.get();
    if (!dav.url?.trim() || !dav.username?.trim() || !dav.password || isLegacyProvider(await accountStorage.get()))
      return;
  }

  const key = await syncDestinationKey();
  const pending = (await getJobs(key))[host];
  const previous = (await cookieStorage.get()).domainCookieMap?.[host];

  const collected = await collectSitePayload(host, {
    sourceUrl: config.sourceUrl || `https://${host}`,
    observed: observed ?? (await readPageStorage(host, { includeIndexedDb: !urgent })),
    pending,
    rules,
    applyRules: true,
    enforceLoginGuard: true,
  });

  if ((!baseline || (skipEmpty && !urgent)) && collected.isEmpty) return;
  if (skipEmpty) {
    // Passive page and expiry notifications cannot prove a logout. Protect a
    // newer queued session as well as the last synced copy during shutdown,
    // and never trigger a re-upload when cookies only passively expired.
    const identity = (cookie: { domain?: string | null; name?: string | null; path?: string | null }) =>
      `${cookie.domain || ''}\0${cookie.path || '/'}\0${cookie.name || ''}`;
    const localIds = new Set(collected.cookies.map(identity));
    const knownCookies = pending?.cookies || previous?.cookies;
    if (knownCookies?.some(cookie => cookie.session && !localIds.has(identity(cookie)))) return;
    if (knownCookies?.length && collected.cookies.length < knownCookies.length) {
      const knownByKey = new Map(knownCookies.map(cookie => [identity(cookie), cookie.value || '']));
      const onlyPassiveRemovals = collected.cookies.every(
        cookie => knownByKey.get(identity(cookie)) === (cookie.value || ''),
      );
      if (onlyPassiveRemovals) {
        const ref = pending || previous;
        const storageHash = (entry?: Parameters<typeof domainContentHash>[0]) =>
          domainContentHash({
            cookies: [],
            localStorageItems: entry?.localStorageItems || [],
            sessionStorageItems: entry?.sessionStorageItems || [],
            indexedDBRecords: entry?.indexedDBRecords || [],
          });
        if ((await storageHash(collected)) === (await storageHash(ref))) return;
      }
    }
  }

  // Profile health tracking + Anti-Downgrade Login Guard (protects 115 from broken overwrites).
  const profile = siteProfileFor(host);
  if (profile) {
    const missing = missingLoginKeys(profile, collected.cookies);
    await siteHealthStorage.updateDomain(profile.domain, {
      loginKeysMissing: missing.length > 0,
      ...(collected.guard.blocked ? { message: collected.guard.reason } : {}),
    });
  }

  if (collected.guard.blocked) {
    await recordGuardedDomain(host, true);
    // Drop any incomplete pending job for this host so it never ships to cloud.
    if (pending) {
      await editSyncJobs(key, jobs => {
        const next = { ...jobs };
        delete next[host];
        return next;
      });
      await autoSyncStatusStorage.update({ pendingCount: Object.keys(await getActiveJobs(key)).length });
    }
    return;
  }
  await recordGuardedDomain(host, false);

  const job: PendingSyncJob = {
    domain: host,
    cookies: collected.cookies,
    localStorageItems: collected.localStorageItems,
    sessionStorageItems: collected.sessionStorageItems,
    indexedDBRecords: collected.indexedDBRecords.map(record => ({
      database: record.database || '',
      store: record.store || '',
      key: record.key || '',
      value: record.value || '',
      origin: record.origin || '',
    })),
    userAgent: navigator.userAgent,
    revision: crypto.randomUUID(),
    capturedAt: Date.now(),
    baseHash: pending?.baseHash || baseline || (await domainContentHash()),
    initialCapture: pending?.initialCapture || !baseline || undefined,
  };

  // Throttle sessionStorage-only churn to once per 10 minutes per site.
  const sessionItems = collected.sessionStorageItems;
  if (sessionItems.length) {
    const baseOf = (value?: {
      cookies?: PendingSyncJob['cookies'] | null;
      localStorageItems?: PendingSyncJob['localStorageItems'] | null;
    }) =>
      domainContentHash({
        cookies: value?.cookies || [],
        localStorageItems: value?.localStorageItems || [],
        sessionStorageItems: [],
      });
    const withoutSession = await baseOf(job);
    const sessionOnly =
      (pending && (await baseOf(pending)) === withoutSession) ||
      (previous && (await baseOf(previous)) === withoutSession);
    if (sessionOnly) {
      const last = await syncRuntimeStorage.getSessionCaptureAt(host);
      if (Date.now() - last < SESSION_THROTTLE_MS) return;
      await syncRuntimeStorage.markSessionCaptured(host);
    }
  }

  const digest = await domainContentHash(job);
  if (digest === baseline && !isUploadingFn()) {
    if (pending) {
      await editSyncJobs(key, jobs => {
        const next = { ...jobs };
        delete next[host];
        return next;
      });
      await autoSyncStatusStorage.update({ pendingCount: Object.keys(await getActiveJobs(key)).length });
    }
    return;
  }
  if (pending && digest === (await domainContentHash(pending))) return;

  await editSyncJobs(key, async jobs => ({
    ...jobs,
    [host]: { ...job, baseHash: jobs[host]?.baseHash || (await getSyncBaseline(host)) || job.baseHash },
  }));
  await autoSyncStatusStorage.update({ pendingCount: Object.keys(await getActiveJobs(key)).length });

  const activeMode = settings.activeDeviceSync !== false;
  const freshLogin =
    urgent ||
    isFastSyncSite(host) ||
    !previous?.cookies?.length ||
    (!!profile &&
      missingLoginKeys(profile, collected.cookies).length === 0 &&
      missingLoginKeys(profile, previous?.cookies).length > 0);
  const delay = freshLogin
    ? FAST_UPLOAD_MS
    : activeMode
      ? NORMAL_UPLOAD_MS
      : automaticIntervalMs(settings.syncIntervalMinutes);
  const due = Date.now() + delay;
  flushExpedited ||= freshLogin || activeMode;
  // New work can bring a batch forward without moving its deadline back.
  if (flushTimer && due >= flushDueAt) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushDueAt = due;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const expedited = flushExpedited;
    flushExpedited = false;
    void flushCallback?.(expedited).catch(() => {});
  }, delay);
}
