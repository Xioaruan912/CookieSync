import { createStorage, StorageType } from './base';

export interface WebdavSettings {
  url: string;
  username: string;
  password: string;
  path: string;
  allowUnsafeWrites?: boolean;
}

const storage = createStorage<WebdavSettings>(
  'webdav-local-settings',
  { url: '', username: '', password: '', path: 'sync-your-cookie.txt' },
  { storageType: StorageType.Local, liveUpdate: true },
);

// Credentials enter Chrome Sync only after an explicit opt-in in settings.
export const webdavCloudStorage = createStorage<{ enabled: boolean; settings?: WebdavSettings }>(
  'webdav-cloud-settings-v1',
  { enabled: false },
  { storageType: StorageType.Sync, liveUpdate: true },
);
webdavCloudStorage.subscribe(() => {
  const cloud = webdavCloudStorage.getSnapshot();
  if (cloud?.enabled && cloud.settings) void storage.set(cloud.settings).catch(() => {});
});

export const webdavStorage = {
  ...storage,
  get: async () => {
    const cloud = await webdavCloudStorage.get();
    return cloud.enabled && cloud.settings ? cloud.settings : storage.get();
  },
  getSnapshot: () => {
    const cloud = webdavCloudStorage.getSnapshot();
    return cloud?.enabled && cloud.settings ? cloud.settings : storage.getSnapshot();
  },
  subscribe: (listener: () => void) => {
    const local = storage.subscribe(listener);
    const cloud = webdavCloudStorage.subscribe(listener);
    return () => {
      local();
      cloud();
    };
  },
  update: async (settings: WebdavSettings, sync?: boolean) => {
    await storage.set(settings);
    const enabled = sync ?? (await webdavCloudStorage.get()).enabled;
    await webdavCloudStorage.set(enabled ? { enabled, settings } : { enabled: false });
  },
};
