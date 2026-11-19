import { createStorage, StorageType } from './base';

interface AutoSyncStatus {
  phase?: 'idle' | 'checking' | 'uploading';
  lastCheck?: number;
  lastSuccess?: number;
  lastAttempt?: number;
  pendingCount?: number;
  error?: string;
  /** Human-readable outcome of the newest reconciliation, e.g. newer-wins adoption. */
  note?: string;
}
const storage = createStorage<AutoSyncStatus>(
  'cookiesync-auto-status',
  {},
  {
    storageType: StorageType.Local,
    liveUpdate: true,
  },
);
export const autoSyncStatusStorage = {
  ...storage,
  update: (value: Partial<AutoSyncStatus>) => storage.set(current => ({ ...current, ...value })),
};
