import { BaseStorage, createStorage, StorageType } from './base';

export interface AccountInfo {
  /**
   * Cookies only travel through WebDAV now. Legacy installations may still carry
   * 'cloudflare' | 'github' | 'google-drive' from Chrome Sync; treat those as
   * unconfigured and guide the user to the WebDAV settings.
   */
  selectedProvider?: 'webdav';
}
const key = 'cloudflare-account-storage-key';
const cacheStorageMap = new Map();

const initStorage = (): BaseStorage<AccountInfo> => {
  if (cacheStorageMap.has(key)) {
    return cacheStorageMap.get(key);
  }
  const storage = createStorage<AccountInfo>(
    key,
    {
      selectedProvider: 'webdav',
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

type AccountInfoStorage = BaseStorage<AccountInfo> & {
  update: (updateInfo: AccountInfo) => Promise<void>;
};

export const accountStorage: AccountInfoStorage = {
  ...storage,
  update: async (updateInfo: AccountInfo) => {
    await storage.set(currentInfo => {
      return { ...currentInfo, ...updateInfo };
    });
  },
};

/** True when Chrome Sync still carries a removed backend; the UI offers a one-time switch. */
export function isLegacyProvider(account: AccountInfo | undefined): boolean {
  return !!account?.selectedProvider && account.selectedProvider !== 'webdav';
}
