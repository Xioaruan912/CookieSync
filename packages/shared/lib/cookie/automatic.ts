import type { ICookie, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import {
  mergeScopedItems,
  scopeStorageItems,
  storageBytes,
  storageLimits,
  type StorageSnapshot,
} from './storageScope';
import { fitIndexedDbRecords, indexedDbLimits, type IndexedDbRecordLike } from './indexedDbCodec';

export interface PendingSyncJob {
  domain: string;
  cookies: ICookie[];
  localStorageItems: ILocalStorageItem[];
  sessionStorageItems?: ILocalStorageItem[];
  indexedDBRecords?: IndexedDbRecordLike[];
  userAgent: string;
  revision: string;
  /** Wall clock (ms) when the local change was captured; drives newer-wins resolution. */
  capturedAt?: number;
  baseHash?: string;
}

export function acknowledgeJobs(
  current: Record<string, PendingSyncJob>,
  sent: Record<string, PendingSyncJob>,
  writtenHashes: Record<string, string> = {},
) {
  return Object.fromEntries(
    Object.entries(current)
      .filter(([domain, job]) => job.revision !== sent[domain]?.revision)
      .map(([domain, job]) => [domain, writtenHashes[domain] ? { ...job, baseHash: writtenHashes[domain] } : job]),
  );
}

export function automaticIntervalMs(minutes?: number): number {
  return Math.min(60, Math.max(1, Number.isFinite(minutes) ? Number(minutes) : 2)) * 60000;
}

export function pickAutomaticLocalItems(
  observed: ILocalStorageItem[] | undefined,
  pending: PendingSyncJob | undefined,
  cached: ILocalStorageItem[],
) {
  return observed ?? pending?.localStorageItems ?? cached;
}

export interface PickedStorage {
  localStorageItems: ILocalStorageItem[];
  sessionStorageItems: ILocalStorageItem[];
  indexedDBRecords: IndexedDbRecordLike[];
  skippedIndexedDB: string[];
  truncated: number;
}

/**
 * Merge one page's snapshot into the stored copy for this site. Only the
 * reporting origin is replaced; other origins and paused-site data survive.
 * Without a fresh snapshot the pending job (or the last applied copy) is kept,
 * so a closed tab never erases session storage or IndexedDB.
 */
export function pickAutomaticStorage(
  observed: StorageSnapshot | undefined,
  pending: PendingSyncJob | undefined,
  cached: {
    localStorageItems?: ILocalStorageItem[] | null;
    sessionStorageItems?: ILocalStorageItem[] | null;
    indexedDBRecords?: {
      origin?: string | null;
      database?: string | null;
      store?: string | null;
      key?: string | null;
      value?: string | null;
    }[] | null;
  },
  sessionEnabled: boolean,
  includeLocalStorage = true,
  indexedDbEnabled = false,
): PickedStorage {
  const cachedLocal = cached.localStorageItems || [];
  const cachedSession = cached.sessionStorageItems || [];
  const cachedIdb: IndexedDbRecordLike[] = (cached.indexedDBRecords || []).map(record => ({
    database: record.database || '',
    store: record.store || '',
    key: record.key || '',
    value: record.value || '',
    origin: record.origin || '',
  }));
  const pendingLocal = pending?.localStorageItems || cachedLocal;
  const pendingSession = pending?.sessionStorageItems || cachedSession;
  const pendingIdb = pending?.indexedDBRecords || cachedIdb;
  if (!observed) {
    return {
      localStorageItems: includeLocalStorage ? pendingLocal : cachedLocal,
      sessionStorageItems: sessionEnabled ? pendingSession : cachedSession,
      indexedDBRecords: indexedDbEnabled ? pendingIdb : cachedIdb,
      skippedIndexedDB: [],
      truncated: 0,
    };
  }

  const others = cachedLocal.filter(item => (item.origin || '') !== observed.origin);
  const budget = Math.max(0, storageLimits.maxBytesPerDomain - storageBytes(others));
  const scoped = includeLocalStorage
    ? scopeStorageItems(observed.localStorageItems, observed.origin, budget / 2)
    : { items: [], truncated: 0 };
  // An absent session list means the reporter said nothing about it; keep the
  // stored copy instead of treating that silence as an empty session.
  const session = sessionEnabled && observed.sessionStorageItems
    ? scopeStorageItems(observed.sessionStorageItems, observed.origin, budget - storageBytes(scoped.items))
    : { items: [], truncated: 0 };
  const sessionReported = sessionEnabled && !!observed.sessionStorageItems;
  // IndexedDB is whole-store replacement, capped per origin and per store.
  const idbBudget = Math.max(
    0,
    Math.min(
      indexedDbLimits.maxBytesPerOrigin,
      storageLimits.maxBytesPerDomain - storageBytes(scoped.items) - storageBytes(session.items),
    ),
  );
  const fitted = indexedDbEnabled && observed.indexedDBRecords
    ? fitIndexedDbRecords(observed.indexedDBRecords, idbBudget)
    : { records: [], skipped: [] as string[], bytes: 0 };
  const idbReported = indexedDbEnabled && !!observed.indexedDBRecords;
  const idbRecords = idbReported
    ? [...cachedIdb.filter(record => (record.origin || '') !== observed.origin), ...fitted.records]
    : cachedIdb;

  return {
    localStorageItems: includeLocalStorage
      ? mergeScopedItems(cachedLocal, scoped.items, observed.origin)
      : cachedLocal,
    sessionStorageItems: sessionReported
      ? mergeScopedItems(cachedSession, session.items, observed.origin)
      : cachedSession,
    indexedDBRecords: idbRecords,
    skippedIndexedDB: fitted.skipped,
    truncated: scoped.truncated + session.truncated + (observed.truncated || 0),
  };
}

/**
 * True when this domain may be restored from the remote copy in a reconciliation
 * cycle. Pending local changes always win on this path; newer-wins adoption for
 * remote changes is decided by the caller with the pending job's capturedAt.
 */
export function canRestoreAtStartup(
  domain: string,
  autoPull: boolean | undefined,
  pending: Record<string, PendingSyncJob>,
) {
  return autoPull !== false && !pending[domain];
}
