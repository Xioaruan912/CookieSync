import { createStorage, StorageType } from './base';

interface SyncFeedback {
  lastPush?: { ok: boolean; host: string; message: string; at: number };
}

const storage = createStorage<SyncFeedback>(
  'cookiesync-feedback',
  {},
  {
    storageType: StorageType.Local,
    liveUpdate: true,
  },
);

export const syncFeedbackStorage = {
  ...storage,
  update: (value: SyncFeedback) => storage.set(current => ({ ...current, ...value })),
};
