import type { ICookie, ILocalStorageItem } from '@sync-your-cookie/protobuf';

export interface PendingSyncJob {
  domain: string;
  cookies: ICookie[];
  localStorageItems: ILocalStorageItem[];
  userAgent: string;
  revision: string;
}

export function acknowledgeJobs(current: Record<string, PendingSyncJob>, sent: Record<string, PendingSyncJob>) {
  return Object.fromEntries(Object.entries(current).filter(([domain, job]) => job.revision !== sent[domain]?.revision));
}

export function canRestoreAtStartup(
  domain: string,
  autoPull: boolean | undefined,
  pending: Record<string, PendingSyncJob>,
) {
  return autoPull !== false && !pending[domain];
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
