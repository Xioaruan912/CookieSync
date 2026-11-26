import { createStorage, StorageType } from './base';

export type DeviceSyncRole = 'active' | 'standby' | 'taking-over';

export interface AutoSyncStatus {
  phase?: 'idle' | 'checking' | 'comparing' | 'uploading' | 'taking-over';
  lastCheck?: number;
  lastSuccess?: number;
  lastAttempt?: number;
  pendingCount?: number;
  error?: string;
  /** Human-readable outcome of the newest reconciliation or takeover. */
  note?: string;
  /** Current role of this computer in the active-device single-writer model. */
  deviceRole?: DeviceSyncRole;
  /** Device ID currently holding the cloud lease. */
  activeDeviceId?: string;
  /** Friendly display name of the device currently holding the cloud lease. */
  activeDeviceName?: string;
  /** Local device ID for quick UI comparison. */
  localDeviceId?: string;
  /** Friendly display name of this computer. */
  localDeviceName?: string;
  /** Last timestamp when this computer automatically took over from another computer. */
  lastTakeoverAt?: number;
  /** Sites whose incomplete/logged-out local snapshot was blocked from overwriting healthy cloud data. */
  guardedDomains?: string[];
  /** Number of idle single-session tabs (e.g. 115) currently paused to prevent cross-PC kicks. */
  discardedTabsCount?: number;
}

const storage = createStorage<AutoSyncStatus>(
  'cookiesync-auto-status',
  {},
  {
    storageType: StorageType.Local,
    liveUpdate: true,
  },
);

export const autoSyncStatusStorage = {
  ...storage,
  update: (value: Partial<AutoSyncStatus>) => storage.set(current => ({ ...current, ...value })),
};
