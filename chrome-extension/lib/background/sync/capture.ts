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
import { isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { syncRuntimeStorage } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { isDeviceStandby, isDeviceTakingOver } from '../activeDevice/leaseManager';
import { readPageStorage } from './pageBridge';

export type Jobs = Record<string, PendingSyncJob>;

const SESSION_THROTTLE_MS = 10 * 60000;
const FAST_SYNC_DEBOUNCE_MS = 5000;
const NORMAL_SYNC_DEBOUNCE_MS = 15000;

const captures = new Map<string, Promise<void>>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushCallback: ((force?: boolean) => Promise<void>) | undefined;
let isUploadingFn: () => boolean = () => false;

export function bindCaptureFlush(callback: (force?: boolean) => Promise<void>, isUploading: () => boolean) {
  flushCallback = callback;
  isUploadingFn = isUploading;
}

export function clearScheduledFlush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
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
  const next = guarded
    ? [...new Set([...current, host])]
    : current.filter(item => item !== host);
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    await autoSyncStatusStorage.update({ guardedDomains: next }).catch(() => {});
  }
}

export function captureAutomaticSync(
  host: string,
  observed?: StorageSnapshot | PendingSyncJob['localStorageItems'],
  skipEmpty = false,
): Promise<void> {
  const next = (captures.get(host) || Promise.resolve())
    .catch(() => {})
    .then(() => captureNow(host, normalizeObserved(observed), skipEmpty));
  captures.set(host, next);
  return next.finally(() => {
    if (captures.get(host) === next) captures.delete(host);
  });
}

async function captureNow(host: string, observed?: StorageSnapshot, skipEmpty = false): Promise<void> {
  // Never capture or queue changes while standby or actively taking over from another PC.
  if (isDeviceStandby() || isDeviceTakingOver()) return;

  const settings = await settingsStorage.get();
  const rules = await readSiteRules();
  if (!isSiteAllowed(host, rules)) return;
  if (isApplyingRemoteState(host) || settings.backgroundSync === false) return;

  const config = (await domainConfigStorage.get()).domainMap[host];
  if (!config || config.autoPush === false) return;

  const baseline = await getSyncBaseline(host);
  if (!baseline) return;

  const key = await syncDestinationKey();
  const pending = (await getJobs(key))[host];
  const previous = (await cookieStorage.get()).domainCookieMap?.[host];

  const collected = await collectSitePayload(host, {
    sourceUrl: config.sourceUrl || `https://${host}`,
    observed: observed ?? (await readPageStorage(host)),
    pending,
    rules,
    applyRules: true,
    enforceLoginGuard: true,
  });

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

  if (skipEmpty && collected.isEmpty) return;
  if (skipEmpty) {
    // Passive discovery cannot distinguish browser session-cookie cleanup from explicit logout.
    const identity = (cookie: { domain?: string | null; name?: string | null; path?: string | null }) =>
      `${cookie.domain || ''}\0${cookie.path || '/'}\0${cookie.name || ''}`;
    const localIds = new Set(collected.cookies.map(identity));
    if (previous?.cookies?.some(cookie => cookie.session && !localIds.has(identity(cookie)))) return;
  }

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
    baseHash: pending?.baseHash || baseline,
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
    }
    return;
  }
  if (pending && digest === (await domainContentHash(pending))) return;

  await editSyncJobs(key, async jobs => ({
    ...jobs,
    [host]: { ...job, baseHash: jobs[host]?.baseHash || (await getSyncBaseline(host)) || job.baseHash },
  }));
  await autoSyncStatusStorage.update({ pendingCount: Object.keys(await getActiveJobs(key)).length });

  // Fast-sync key login sites (~5s) so users can close Chrome right after logging in;
  // normal sites coalesce over ~15s in active-device mode (or configured interval otherwise).
  const activeMode = settings.activeDeviceSync !== false;
  const freshLogin =
    isFastSyncSite(host) ||
    !previous?.cookies?.length ||
    (!!profile && missingLoginKeys(profile, collected.cookies).length === 0 && missingLoginKeys(profile, previous?.cookies).length > 0);
  const delayMs = activeMode
    ? freshLogin
      ? FAST_SYNC_DEBOUNCE_MS
      : NORMAL_SYNC_DEBOUNCE_MS
    : automaticIntervalMs(settings.syncIntervalMinutes);

  if (flushTimer) {
    // If a fast-login change arrives while a slower debounce is waiting, shorten the timer.
    if (freshLogin && activeMode) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }
  if (!flushTimer && flushCallback) {
    const forceOnTimer = activeMode;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushCallback?.(forceOnTimer);
    }, delayMs);
  }
}
