import { createStorage, StorageType } from './base';

interface SyncFeedback {
  lastPush?: { ok: boolean; host: string; message: string; at: number };
  /**
   * Set when the remote copy of a site lost origin/session storage markers that
   * this browser had written, i.e. another computer running an older version
   * rewrote the entry. Cleared by the next successful write from this browser.
   */
  schemaWarning?: { at: number; message: string };
  /** Set when a daily rolling backup could not be written; never blocks sync. */
  backupWarning?: { at: number; message: string };
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
