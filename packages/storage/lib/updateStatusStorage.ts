import { createStorage, StorageType } from './base';

export interface IUpdateStatus {
  /** 'idle' nothing to do · 'available' a newer release exists · 'downloading' · 'ready' saved in Downloads · 'error' last action failed. */
  state?: 'idle' | 'available' | 'downloading' | 'ready' | 'error';
  latestVersion?: string;
  latestBuild?: number;
  checkedAt?: number;
  zipUrl?: string;
  shaUrl?: string;
  /** Expected SHA-256 of the installation ZIP, from SHA256SUMS.txt. */
  sha256?: string;
  downloadedAt?: number;
  downloadName?: string;
  downloadId?: number;
  error?: string;
}

const storage = createStorage<IUpdateStatus>(
  'cookiesync-update-status',
  {},
  {
    storageType: StorageType.Local,
    liveUpdate: true,
  },
);

export const updateStatusStorage = {
  ...storage,
  update: (value: Partial<IUpdateStatus>) => storage.set(current => ({ ...current, ...value })),
};
