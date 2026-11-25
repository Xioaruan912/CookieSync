import { BaseStorage, createStorage, StorageType } from './base';

export type DomainStatusItem = {
  pulling?: boolean;
  pushing?: boolean;
};

export interface DomainStatusState {
  pulling: boolean;
  pushing: boolean;
  domainMap: {
    [host: string]: DomainStatusItem;
  };
}

const key = 'domainStatus-storage-key';

const storage: BaseStorage<DomainStatusState> = createStorage<DomainStatusState>(
  key,
  {
    pulling: false,
    pushing: false,
    domainMap: {},
  },
  {
    storageType: StorageType.Session,
    liveUpdate: true,
  },
);

export const domainStatusStorage = {
  ...storage,
  resetState: async () => {
    return await storage.set(currentInfo => {
      const domainMap: DomainStatusState['domainMap'] = {};
      for (const [domain, item] of Object.entries(currentInfo?.domainMap || {})) {
        if (!domain) continue;
        domainMap[domain] = {
          ...item,
          pulling: false,
          pushing: false,
        };
      }
      return {
        pulling: false,
        pushing: false,
        domainMap,
      };
    });
  },
  updateItem: async (host: string, updateConf: DomainStatusItem) => {
    return await storage.set(currentInfo => {
      const domainMap = { ...(currentInfo?.domainMap || {}) };
      domainMap[host] = {
        ...domainMap[host],
        ...updateConf,
      };
      return { ...(currentInfo || { pulling: false, pushing: false }), domainMap };
    });
  },
  update: async (updateInfo: Partial<DomainStatusState>) => {
    return await storage.set(currentInfo => ({ ...currentInfo, ...updateInfo }));
  },
  removeItem: async (domain: string) => {
    await storage.set(currentInfo => {
      const domainMap = { ...(currentInfo?.domainMap || {}) };
      delete domainMap[domain];
      return { ...currentInfo, domainMap };
    });
  },
  togglePullingState: async (domain: string, checked?: boolean) => {
    return await storage.set(currentInfo => {
      const domainMap = { ...(currentInfo?.domainMap || {}) };
      domainMap[domain] = {
        ...domainMap[domain],
        pulling: checked ?? !domainMap[domain]?.pulling,
      };
      return { ...(currentInfo || { pulling: false, pushing: false }), domainMap };
    });
  },
  togglePushingState: async (domain: string, checked?: boolean) => {
    return await storage.set(currentInfo => {
      const domainMap = { ...(currentInfo?.domainMap || {}) };
      domainMap[domain] = {
        ...domainMap[domain],
        pushing: checked ?? !domainMap[domain]?.pushing,
      };
      return { ...(currentInfo || { pulling: false, pushing: false }), domainMap };
    });
  },
};
