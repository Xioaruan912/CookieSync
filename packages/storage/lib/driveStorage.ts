import { createStorage, StorageType } from './base';

export const driveAccountStorage = createStorage<{ connected: boolean; userId?: string; email?: string }>(
  'google-drive-account-local-v1',
  { connected: false },
  { storageType: StorageType.Local, liveUpdate: true },
);
