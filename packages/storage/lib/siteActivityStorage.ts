import { createStorage, StorageType } from './base';

export interface SiteActivityEntry {
  lastPushAt?: number;
  lastPullAt?: number;
  lastPushOk?: boolean;
  lastPullOk?: boolean;
  /** Why the last push failed; never contains cookie values. */
  message?: string;
}

export type SiteActivityMap = Record<string, SiteActivityEntry>;

const key = 'cookiesync-site-activity';
const maxEntries = 500;

const storage = createStorage<SiteActivityMap>(
  key,
  {},
  {
    storageType: StorageType.Local,
    liveUpdate: true,
  },
);

/** Last push/pull per site, for the overview. Best effort: never throws. */
export async function recordSiteActivity(domain: string, kind: 'push' | 'pull', ok = true, message?: string) {
  if (!domain) return;
  try {
    await storage.set(current => {
      const next: SiteActivityMap = {
        ...current,
        [domain]: {
          ...current[domain],
          ...(kind === 'push'
            ? { lastPushAt: Date.now(), lastPushOk: ok, message: ok ? undefined : message }
            : { lastPullAt: Date.now(), lastPullOk: ok }),
        },
      };
      const keys = Object.keys(next);
      if (keys.length <= maxEntries) return next;
      // Keep the newest entries only; this is a UI convenience, not history.
      const keep = keys
        .sort(
          (a, b) =>
            Math.max(next[b].lastPushAt || 0, next[b].lastPullAt || 0) -
            Math.max(next[a].lastPushAt || 0, next[a].lastPullAt || 0),
        )
        .slice(0, maxEntries);
      return Object.fromEntries(keep.map(entry => [entry, next[entry]]));
    });
  } catch {
    /* Diagnostics must never break a sync. */
  }
}

export const siteActivityStorage = storage;
