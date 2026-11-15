import { BaseStorage, createStorage, StorageType } from './base';

type DomainItemConfig = {
  autoPull?: boolean;
  autoPush?: boolean;
  favIconUrl?: string;
  sourceUrl?: string;
};

interface DomainConfig {
  domainMap: {
    [host: string]: DomainItemConfig;
  };
}
const key = 'domainConfig-storage-key';

const cacheStorageMap = new Map();
const initStorage = (): BaseStorage<DomainConfig> => {
  if (cacheStorageMap.has(key)) {
    return cacheStorageMap.get(key);
  }
  const storage: BaseStorage<DomainConfig> = createStorage<DomainConfig>(
    key,
    {
      domainMap: {},
    },
    {
      storageType: StorageType.Local,
      liveUpdate: true,
      // onLoad: onLoad,
    },
  );
  cacheStorageMap.set(key, storage);
  return storage;
};

const storage = initStorage();

export const domainConfigStorage = {
  ...storage,
  ensureDefaults: async () => {
    const config = await storage.get();
    const domainMap = { ...config.domainMap };
    let changed = false;
    for (const host of new Set(['xiaohongshu.com', 'douyin.com', '115.com', ...Object.keys(domainMap)])) {
      const old = domainMap[host];
      if (old?.autoPush !== undefined && old?.autoPull !== undefined) continue;
      domainMap[host] = { ...old, autoPush: old?.autoPush ?? true, autoPull: old?.autoPull ?? true };
      changed = true;
    }
    if (changed) await storage.set({ ...config, domainMap });
  },
  updateItem: async (host: string, updateConf: DomainItemConfig) => {
    return await storage.set(currentInfo => {
      const domainMap = currentInfo?.domainMap || {};
      domainMap[host] = {
        autoPush: true,
        autoPull: true,
        ...domainMap[host],
        ...updateConf,
      };
      return { ...(currentInfo || {}), domainMap };
    });
  },
  update: async (updateInfo: Partial<DomainConfig>) => {
    return await storage.set(currentInfo => {
      return { ...currentInfo, ...updateInfo };
    });
  },
  removeItem: async (domain: string) => {
    await storage.set(currentInfo => {
      const domainCookieMap = currentInfo.domainMap || {};
      delete domainCookieMap[domain];
      return { ...currentInfo, domainCookieMap };
    });
  },

  toggleAutoPullState: async (domain: string, checked?: boolean) => {
    return await storage.set(currentInfo => {
      const domainMap = currentInfo?.domainMap || {};
      domainMap[domain] = {
        ...domainMap[domain],
        autoPull: checked ?? !(domainMap[domain]?.autoPull ?? true),
        autoPush: domainMap[domain]?.autoPush ?? true,
      };
      return { ...(currentInfo || {}), domainMap };
    });
  },

  toggleAutoPushState: async (domain: string, checked?: boolean) => {
    return await storage.set(currentInfo => {
      const domainMap = currentInfo?.domainMap || {};
      domainMap[domain] = {
        ...domainMap[domain],
        autoPush: checked ?? !(domainMap[domain]?.autoPush ?? true),
        autoPull: domainMap[domain]?.autoPull ?? true,
      };
      return { ...(currentInfo || {}), domainMap };
    });
  },
};
