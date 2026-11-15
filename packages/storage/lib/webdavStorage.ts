import { createStorage, StorageType } from './base';

export interface WebdavSettings {
  url: string;
  username: string;
  password: string;
  path: string;
  allowUnsafeWrites?: boolean;
}

// Never put WebDAV credentials in Chrome Sync.
const storage = createStorage<WebdavSettings>(
  'webdav-local-settings',
  { url: '', username: '', password: '', path: 'sync-your-cookie.txt' },
  { storageType: StorageType.Local, liveUpdate: true },
);

export const webdavStorage = {
  ...storage,
  update: (settings: WebdavSettings) => storage.set(settings),
};
