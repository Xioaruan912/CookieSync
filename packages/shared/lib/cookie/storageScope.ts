import type { ILocalStorageItem } from '@sync-your-cookie/protobuf';
import type { StorageLimitIssue } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import type { IndexedDbRecordLike } from './indexedDbCodec';

/**
 * Session storage and origin-tagged localStorage.
 *
 * A page's localStorage belongs to one exact origin, so `www.example.com` and
 * `app.example.com` must never overwrite each other. Entries written before
 * 1.16 have no origin and stay applicable to any matching tab of the site.
 */
export const storageLimits = {
  /** Keep one hostile page from filling the shared WebDAV file. */
  maxItemsPerOrigin: 400,
  maxItemBytes: 128 * 1024,
  maxBytesPerOrigin: 1024 * 1024,
  maxBytesPerDomain: 2 * 1024 * 1024,
} as const;

/** UTF-16 storage cost; close enough for a bound and cheap to compute. */
export const textBytes = (value: string) => value.length * 2;

export interface StorageSnapshot {
  origin: string;
  localStorageItems: ILocalStorageItem[];
  /** Absent when the reporter does not include session storage at all. */
  sessionStorageItems?: ILocalStorageItem[];
  /** Absent when the reporter does not include IndexedDB at all. */
  indexedDBRecords?: IndexedDbRecordLike[];
  /** Stores dropped because they did not fit the caps, for diagnostics. */
  skippedIndexedDB?: string[];
  /** Items dropped by the caps above; surfaced as diagnostics, never silently. */
  truncated?: number;
}

export function pageOrigin(rawUrl?: string | null): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

const byKey = (a: ILocalStorageItem, b: ILocalStorageItem) =>
  String(a?.key ?? '').localeCompare(String(b?.key ?? '')) ||
  String(a?.value ?? '').localeCompare(String(b?.value ?? ''));

/**
 * Attach the origin and keep the snapshot inside its caps. Items are sorted
 * first so the same page always produces the same snapshot, and a truncated
 * snapshot never removes what already fits.
 */
export function scopeStorageItems(
  items: ILocalStorageItem[] | undefined,
  origin: string,
  limitBytes: number,
  maxItems: number = storageLimits.maxItemsPerOrigin,
) {
  let bytes = 0;
  let truncated = 0;
  const details: StorageLimitIssue[] = [];
  const kept: ILocalStorageItem[] = [];
  for (const item of [...(items || [])].sort(byKey)) {
    let issue: StorageLimitIssue | undefined;
    if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') {
      issue = { reason: 'invalid' };
    } else {
      const size = textBytes(item.key) + textBytes(item.value);
      if (size > storageLimits.maxItemBytes) {
        issue = { reason: 'item-bytes', bytes: size, limit: storageLimits.maxItemBytes };
      } else if (kept.length >= maxItems) {
        issue = { reason: 'item-count', bytes: size, limit: maxItems };
      } else if (bytes + size > Math.min(limitBytes, storageLimits.maxBytesPerOrigin)) {
        const siteLimited = limitBytes < storageLimits.maxBytesPerOrigin;
        issue = {
          reason: siteLimited ? 'site-bytes' : 'origin-bytes',
          bytes: size,
          limit: siteLimited ? storageLimits.maxBytesPerDomain : storageLimits.maxBytesPerOrigin,
          remaining: Math.max(0, Math.min(limitBytes, storageLimits.maxBytesPerOrigin) - bytes),
        };
      } else {
        bytes += size;
        kept.push({ key: item.key, value: item.value, origin });
      }
    }
    if (!issue) continue;
    truncated++;
    if (details.length < 16) details.push(issue);
  }
  return { items: kept, truncated, details };
}

/** Total storage size of one domain entry, used for the per-domain cap. */
export const storageBytes = (items: ILocalStorageItem[] | undefined) =>
  (items || []).reduce((total, item) => total + textBytes(item.key || '') + textBytes(item.value || ''), 0);

/**
 * Apply a snapshot from one origin on top of the stored copy. Entries owned by
 * that origin are replaced; entries of other origins survive. Untagged entries
 * are superseded by the first tagged snapshot because that page just told us
 * the current state of its own origin.
 */
export function mergeScopedItems(
  stored: ILocalStorageItem[] | undefined,
  observed: ILocalStorageItem[] | undefined,
  origin: string,
): ILocalStorageItem[] {
  const kept = (stored || []).filter(item => {
    const owner = item.origin || '';
    return !!owner && owner !== origin;
  });
  return [...kept, ...(observed || []).map(item => ({ ...item, origin }))];
}

/** Entries a tab may receive: its own origin plus legacy untagged entries. */
export function selectScopedItems(items: ILocalStorageItem[] | undefined, origin: string) {
  return (items || []).filter(item => {
    const owner = item.origin || '';
    return !owner || owner === origin;
  });
}

/** Site switch overrides the global default; both default to off for session storage. */
export function sessionStorageEnabled(globalDefault?: boolean, siteValue?: boolean) {
  return siteValue ?? globalDefault ?? false;
}

/** IndexedDB uses the same opt-in precedence as session storage. */
export const indexedDbEnabled = sessionStorageEnabled;
