import type { ICookie, IIndexedDBRecord, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import { isAutomaticCookieAllowed, type SiteRules } from '@sync-your-cookie/storage/lib/commonSites';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { syncRuntimeStorage } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { evaluateLoginGuard, type LoginGuardVerdict } from '../siteProfiles';
import { pickAutomaticStorage, type PendingSyncJob } from './automatic';
import { collectSiteCookies } from './restore';
import { indexedDbEnabled, sessionStorageEnabled, type StorageSnapshot } from './storageScope';

export interface CollectedSitePayload {
  domain: string;
  cookies: ICookie[];
  localStorageItems: ILocalStorageItem[];
  sessionStorageItems: ILocalStorageItem[];
  indexedDBRecords: IIndexedDBRecord[];
  skippedIndexedDB: string[];
  truncated: number;
  guard: LoginGuardVerdict;
  isEmpty: boolean;
}

export interface CollectSiteOptions {
  sourceUrl?: string;
  observed?: StorageSnapshot;
  pending?: PendingSyncJob;
  rules?: SiteRules;
  /** Respect site rule child-domain filtering and preserve paused child cookies. Default true. */
  applyRules?: boolean;
  /** When true (automatic sync), evaluates anti-downgrade Login Guard against cached cloud cookies. */
  enforceLoginGuard?: boolean;
}

/**
 * Single source of truth for collecting one site's cookies and page storage
 * across manual popup push, overview push, shortcuts, batch push, and automatic sync.
 */
export async function collectSitePayload(
  host: string,
  options: CollectSiteOptions = {},
): Promise<CollectedSitePayload> {
  const settings = await settingsStorage.get();
  const siteConfig = (await domainConfigStorage.get()).domainMap[host];
  const previous = (await cookieStorage.get()).domainCookieMap?.[host];
  const url = options.sourceUrl || siteConfig?.sourceUrl || `https://${host}`;
  const applyRules = options.applyRules !== false && !!options.rules;

  const rawCookies = await collectSiteCookies(url);
  const cookies: ICookie[] = applyRules
    ? [
        ...rawCookies.filter(cookie => isAutomaticCookieAllowed(cookie, host, options.rules!)),
        ...(previous?.cookies || []).filter(cookie => !isAutomaticCookieAllowed(cookie, host, options.rules!)),
      ]
    : rawCookies;

  const includeLocal = settings.includeLocalStorage !== false;
  const sessionOn = sessionStorageEnabled(settings.includeSessionStorage, siteConfig?.includeSessionStorage);
  const idbOn = indexedDbEnabled(settings.includeIndexedDB, siteConfig?.includeIndexedDB);

  const picked = pickAutomaticStorage(
    options.observed,
    options.pending,
    previous || {},
    sessionOn,
    includeLocal,
    idbOn,
  );

  if (picked.truncated) {
    await syncRuntimeStorage.recordTruncated(host, picked.truncated).catch(() => {});
  }
  if (picked.skippedIndexedDB.length) {
    await syncRuntimeStorage.recordSkippedIndexedDb(host, picked.skippedIndexedDB).catch(() => {});
  }

  const guard = options.enforceLoginGuard
    ? evaluateLoginGuard(host, cookies, previous?.cookies)
    : { blocked: false, missingKeys: [] };

  const isEmpty =
    !cookies.length &&
    !picked.localStorageItems.length &&
    !picked.sessionStorageItems.length &&
    !picked.indexedDBRecords.length;

  return {
    domain: host,
    cookies,
    localStorageItems: picked.localStorageItems,
    sessionStorageItems: picked.sessionStorageItems,
    indexedDBRecords: picked.indexedDBRecords as IIndexedDBRecord[],
    skippedIndexedDB: picked.skippedIndexedDB,
    truncated: picked.truncated,
    guard,
    isEmpty,
  };
}
