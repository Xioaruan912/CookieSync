import type { ICookie, ILocalStorageItem } from '@sync-your-cookie/protobuf';

export interface PendingSyncJob {
  domain: string;
  cookies: ICookie[];
  localStorageItems: ILocalStorageItem[];
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
  return Math.min(60, Math.max(1, Number.isFinite(minutes) ? minutes! : 2)) * 60000;
}

export function pickAutomaticLocalItems(
  observed: ILocalStorageItem[] | undefined,
  pending: PendingSyncJob | undefined,
  cached: ILocalStorageItem[],
) {
  return observed ?? pending?.localStorageItems ?? cached;
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
