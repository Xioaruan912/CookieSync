import { createStorage, StorageType } from './base';

export const automaticStatusStorage = createStorage<{ lastSuccess?: number; lastAttempt?: number; error?: string }>(
  'cookiesync-auto-status',
  {},
  { storageType: StorageType.Local, liveUpdate: true },
);
