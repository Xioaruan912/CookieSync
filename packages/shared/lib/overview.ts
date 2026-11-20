/**
 * The overview panel rows are built from the storages the background already
 * owns. Keeping this pure makes the "what needs attention" rules testable
 * without a browser.
 */
export type OverviewAttention = 'pending' | 'unlisted' | 'paused' | 'health' | 'error' | 'truncated';

export interface OverviewSiteConfig {
  autoPush?: boolean;
  autoPull?: boolean;
  sourceUrl?: string;
  includeSessionStorage?: boolean;
}

export interface OverviewStorageEntry {
  cookies?: unknown[] | null;
  localStorageItems?: unknown[] | null;
  sessionStorageItems?: unknown[] | null;
}

export interface OverviewPendingEntry extends OverviewStorageEntry {
  capturedAt?: number;
}

export interface OverviewCachedEntry extends OverviewStorageEntry {
  updateTime?: number;
}

export interface OverviewHealthEntry {
  state?: 'ok' | 'invalid' | 'unknown';
  message?: string;
  checkedAt?: number;
  userName?: string;
  loginKeysMissing?: boolean;
}

export interface OverviewActivityEntry {
  lastPushAt?: number;
  lastPullAt?: number;
  lastPushOk?: boolean;
  lastPullOk?: boolean;
  message?: string;
}

export interface OverviewRow {
  domain: string;
  sourceUrl?: string;
  listed: boolean;
  autoPush: boolean;
  autoPull: boolean;
  paused: boolean;
  pending?: { capturedAt?: number; cookies: number; localStorageItems: number; sessionStorageItems: number };
  cached?: { updateTime?: number; cookies: number; localStorageItems: number; sessionStorageItems: number };
  health?: OverviewHealthEntry;
  lastPushAt?: number;
  lastPullAt?: number;
  error?: string;
  truncated?: number;
  attention: OverviewAttention[];
}

export interface OverviewInput {
  domainMap: Record<string, OverviewSiteConfig>;
  pending: Record<string, OverviewPendingEntry>;
  cached: Record<string, OverviewCachedEntry>;
  health: Record<string, OverviewHealthEntry>;
  activity: Record<string, OverviewActivityEntry>;
  truncated: Record<string, number>;
  isListed: (domain: string) => boolean;
}

const count = (value: unknown[] | null | undefined) => (Array.isArray(value) ? value.length : 0);

export function buildOverviewRows({
  domainMap,
  pending,
  cached,
  health,
  activity,
  truncated,
  isListed,
}: OverviewInput): OverviewRow[] {
  const domains = new Set([...Object.keys(domainMap), ...Object.keys(pending)]);
  const rows: OverviewRow[] = [];
  for (const domain of domains) {
    const config = domainMap[domain];
    const listed = isListed(domain);
    const pendingEntry = pending[domain];
    const cachedEntry = cached[domain];
    const activityEntry = activity[domain] || {};
    // A registered site that fell off the allow list keeps its row (and data)
    // so the pause is visible instead of looking like a deletion.
    if (!listed && !config && !pendingEntry) continue;
    const autoPush = config?.autoPush !== false;
    const autoPull = config?.autoPull !== false;
    const paused = !listed || (!autoPush && !autoPull);
    const healthEntry = health[domain];
    const attention: OverviewAttention[] = [];
    if (pendingEntry) attention.push('pending');
    if (!listed) attention.push('unlisted');
    else if (paused) attention.push('paused');
    if (healthEntry?.state === 'invalid') attention.push('health');
    if (activityEntry.lastPushOk === false) attention.push('error');
    if ((truncated[domain] || 0) > 0) attention.push('truncated');
    rows.push({
      domain,
      sourceUrl: config?.sourceUrl,
      listed,
      autoPush,
      autoPull,
      paused,
      pending: pendingEntry
        ? {
            capturedAt: pendingEntry.capturedAt,
            cookies: count(pendingEntry.cookies),
            localStorageItems: count(pendingEntry.localStorageItems),
            sessionStorageItems: count(pendingEntry.sessionStorageItems),
          }
        : undefined,
      cached: cachedEntry
        ? {
            updateTime: cachedEntry.updateTime,
            cookies: count(cachedEntry.cookies),
            localStorageItems: count(cachedEntry.localStorageItems),
            sessionStorageItems: count(cachedEntry.sessionStorageItems),
          }
        : undefined,
      health: healthEntry,
      lastPushAt: activityEntry.lastPushAt,
      lastPullAt: activityEntry.lastPullAt,
      error: activityEntry.lastPushOk === false ? activityEntry.message : undefined,
      truncated: truncated[domain],
      attention,
    });
  }
  const score = (row: OverviewRow) =>
    (row.attention.includes('health') ? 3 : 0) +
    (row.attention.includes('error') ? 2 : 0) +
    (row.pending ? 2 : 0) +
    (row.paused ? 1 : 0);
  return rows.sort(
    (a, b) =>
      score(b) - score(a) ||
      Math.max(b.lastPullAt || 0, b.lastPushAt || 0) - Math.max(a.lastPullAt || 0, a.lastPushAt || 0) ||
      a.domain.localeCompare(b.domain),
  );
}
