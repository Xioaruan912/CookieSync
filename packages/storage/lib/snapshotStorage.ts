import type { ICookie, IIndexedDBRecord, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import { createStorage, StorageType } from './base';

export interface SnapshotSite {
  domain: string;
  cookies: ICookie[];
  localStorageItems: ILocalStorageItem[];
  sessionStorageItems?: ILocalStorageItem[];
  indexedDBRecords?: IIndexedDBRecord[];
  userAgent?: string;
  updateTime?: number;
}

export interface Snapshot {
  id: string;
  at: number;
  /** Where the snapshot came from and where it can be restored to. */
  kind: 'local' | 'remote';
  reason: 'pull-all' | 'push-all' | 'pull-site' | 'push-site';
  sites: Record<string, SnapshotSite>;
}

const key = 'cookiesync-snapshots-v1';
const maxSnapshots = 4;
const maxTotalBytes = 6 * 1024 * 1024;
const maxSnapshotBytes = 3 * 1024 * 1024;

/** Newest first; oversized snapshots are skipped instead of evicting everything. */
export function trimSnapshots(snapshots: Snapshot[], maxCount = maxSnapshots): Snapshot[] {
  const kept: Snapshot[] = [];
  let bytes = 0;
  for (const snapshot of [...snapshots].sort((a, b) => b.at - a.at)) {
    if (kept.length >= maxCount) break;
    const size = JSON.stringify(snapshot).length;
    if (size > maxSnapshotBytes || bytes + size > maxTotalBytes) continue;
    kept.push(snapshot);
    bytes += size;
  }
  return kept;
}

const storage = createStorage<Snapshot[]>(key, [], {
  storageType: StorageType.Local,
  liveUpdate: true,
});

export const snapshotStorage = {
  ...storage,
  /** Best effort: a failed snapshot must never block the sync it protects. */
  add: async (snapshot: Snapshot) => {
    const snapshotWithId = { ...snapshot, id: snapshot.id || crypto.randomUUID() };
    await storage.set(current => trimSnapshots([snapshotWithId, ...(Array.isArray(current) ? current : [])]));
    return snapshotWithId.id;
  },
};

export const snapshotLimitBytes = maxSnapshotBytes;
