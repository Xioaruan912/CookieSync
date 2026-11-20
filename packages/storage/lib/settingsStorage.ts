import { BaseStorage, createStorage, StorageType } from './base';

export interface ISettings {
  protobufEncoding?: boolean;
  includeLocalStorage?: boolean;
  /** Default for session storage; a site switch overrides it. Off by default. */
  includeSessionStorage?: boolean;
  /** Experimental: capture small IndexedDB object stores. Off by default. */
  includeIndexedDB?: boolean;
  /** Keep a daily rolling copy of the remote file next to it. On by default. */
  rollingBackup?: boolean;
  localStorageGetting?: boolean;
  contextMenu?: boolean;
  encryptionEnabled?: boolean;
  encryptionPassword?: string;
  startupPull?: boolean;
  backgroundSync?: boolean;
  autoDiscoverSites?: boolean;
  syncIntervalMinutes?: number;
  /** How non-secret settings travel between computers. */
  configChannel?: 'chrome-sync' | 'webdav' | 'off';
  /** Download a verified installation ZIP automatically once a newer version is found. */
  autoUpdateDownload?: boolean;
}
const key = 'settings-storage-key';
const cacheStorageMap = new Map();

const initStorage = (): BaseStorage<ISettings> => {
  if (cacheStorageMap.has(key)) {
    return cacheStorageMap.get(key);
  }
  const storage = createStorage<ISettings>(
    key,
    {
      protobufEncoding: false,
      includeLocalStorage: true,
      includeSessionStorage: false,
      includeIndexedDB: false,
      rollingBackup: true,
      contextMenu: false,
      startupPull: true,
      backgroundSync: true,
      autoDiscoverSites: true,
      syncIntervalMinutes: 2,
      configChannel: 'chrome-sync',
      autoUpdateDownload: true,
    },
    {
      storageType: StorageType.Sync,
      liveUpdate: true,
    },
  );
  cacheStorageMap.set(key, storage);
  return storage;
};

const storage = initStorage();

type TSettingsStorage = BaseStorage<ISettings> & {
  update: (updateInfo: Partial<ISettings>) => Promise<void>;
};
export const settingsStorage: TSettingsStorage = {
  ...storage,
  update: async (updateInfo: Partial<ISettings>) => {
    await storage.set(currentInfo => {
      return { ...currentInfo, ...updateInfo };
    });
  },
};
