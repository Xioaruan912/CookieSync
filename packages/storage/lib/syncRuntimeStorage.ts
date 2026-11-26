import { createStorage, StorageType } from './base';
import type { DeviceSyncRole } from './autoSyncStatusStorage';

/**
 * Typed runtime state and device identity storage.
 * Consolidates all auxiliary local/session keys while preserving existing key names
 * for seamless upgrades from v1.20.x.
 */

export const RUNTIME_STORAGE_KEYS = {
  storageTruncated: 'cookiesync-storage-truncated',
  skippedIndexedDb: 'cookiesync-indexeddb-skipped',
  sessionStarted: 'cookiesync-session-started',
  lastBackupAt: 'cookiesync-last-backup-at',
  deviceIdentity: 'cookiesync-device-identity-v1',
  localLeaseState: 'cookiesync-local-lease-v1',
  standbySwitchedTab: 'cookiesync-standby-switched-v1',
} as const;

export const pulledHostKey = (host: string) => `cookiesync-pulled-${host}`;
export const sessionThrottleKey = (host: string) => `cookiesync-session-capture-${host}`;

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  createdAt: number;
}

export interface LocalLeaseState {
  role: DeviceSyncRole;
  activeDeviceId?: string;
  activeDeviceName?: string;
  userAgentFamily?: string;
  dataRevision?: string;
  leaseAt?: number;
  lastCheckedAt?: number;
  lastTakeoverAt?: number;
}

export interface StandbySwitchedTab {
  windowId: number;
  originalTabId: number;
  fallbackTabId: number;
  domain: string;
  at: number;
}

function defaultDeviceLabel(deviceId: string): string {
  const ua = globalThis.navigator?.userAgent || '';
  const platform = ua.includes('Windows')
    ? 'Windows'
    : ua.includes('Mac OS')
      ? 'macOS'
      : ua.includes('Linux')
        ? 'Linux'
        : '桌面电脑';
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('Chrome/')
      ? 'Chrome'
      : ua.includes('Firefox/')
        ? 'Firefox'
        : '浏览器';
  const suffix =
    deviceId
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 4)
      .toUpperCase() || 'PC01';
  return `${platform} ${browser} · ${suffix}`;
}

export function currentUserAgentFamily(ua = globalThis.navigator?.userAgent || ''): string {
  const platform = ua.includes('Windows')
    ? 'Windows'
    : ua.includes('Mac OS')
      ? 'macOS'
      : ua.includes('Android')
        ? 'Android'
        : ua.includes('Linux')
          ? 'Linux'
          : 'UnknownOS';
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('OPR/')
      ? 'Opera'
      : ua.includes('Firefox/')
        ? 'Firefox'
        : ua.includes('Chrome/')
          ? 'Chrome'
          : ua.includes('Safari/')
            ? 'Safari'
            : 'UnknownBrowser';
  return `${browser}/${platform}`;
}

const rawDeviceIdentity = createStorage<DeviceIdentity | null>(RUNTIME_STORAGE_KEYS.deviceIdentity, null, {
  storageType: StorageType.Local,
  liveUpdate: true,
});

let ensureIdentityPromise: Promise<DeviceIdentity> | undefined;

export const deviceIdentityStorage = {
  ...rawDeviceIdentity,
  ensure: async (): Promise<DeviceIdentity> => {
    const existing = await rawDeviceIdentity.get();
    if (existing?.deviceId && existing?.deviceName) return existing;
    if (ensureIdentityPromise) return ensureIdentityPromise;
    ensureIdentityPromise = (async () => {
      const again = await rawDeviceIdentity.get();
      if (again?.deviceId && again?.deviceName) return again;
      const deviceId = crypto.randomUUID();
      const created: DeviceIdentity = {
        deviceId,
        deviceName: defaultDeviceLabel(deviceId),
        createdAt: Date.now(),
      };
      await rawDeviceIdentity.set(created);
      return created;
    })().finally(() => {
      ensureIdentityPromise = undefined;
    });
    return ensureIdentityPromise;
  },
  rename: async (deviceName: string): Promise<DeviceIdentity> => {
    const current = await deviceIdentityStorage.ensure();
    const cleaned = deviceName.trim().slice(0, 40) || defaultDeviceLabel(current.deviceId);
    const updated: DeviceIdentity = { ...current, deviceName: cleaned };
    await rawDeviceIdentity.set(updated);
    return updated;
  },
};

const rawLeaseState = createStorage<LocalLeaseState>(
  RUNTIME_STORAGE_KEYS.localLeaseState,
  { role: 'active' },
  {
    storageType: StorageType.Local,
    liveUpdate: true,
  },
);

export const localLeaseStateStorage = {
  ...rawLeaseState,
  update: (patch: Partial<LocalLeaseState>) => rawLeaseState.set(current => ({ ...current, ...patch })),
};

export type StorageLimitIssue =
  | { reason: 'invalid' }
  | {
      reason: 'item-bytes' | 'origin-bytes' | 'site-bytes' | 'item-count';
      bytes: number;
      limit: number;
      remaining?: number;
    };

export interface StorageTruncationCounts {
  local?: number;
  session?: number;
  source?: number;
  details?: {
    local?: StorageLimitIssue[];
    session?: StorageLimitIssue[];
  };
}

type StorageTruncationBySite = Record<
  string,
  | number
  | {
      legacy?: number;
      origins: Record<string, StorageTruncationCounts>;
    }
>;

export const storageTruncationStorage = createStorage<StorageTruncationBySite>(
  RUNTIME_STORAGE_KEYS.storageTruncated,
  {},
  { storageType: StorageType.Local, liveUpdate: true },
);

const truncationTotal = ({ local, session, source }: StorageTruncationCounts) =>
  (local || 0) + (session || 0) + (source || 0);

export function summarizeStorageTruncation(stored: StorageTruncationBySite): Record<string, number> {
  return Object.fromEntries(
    Object.entries(stored).flatMap(([site, item]) => {
      const count =
        typeof item === 'number'
          ? item
          : Math.max(
              item.legacy || 0,
              Object.values(item.origins).reduce((sum, next) => sum + truncationTotal(next), 0),
            );
      return count > 0 ? [[site, count]] : [];
    }),
  );
}

let truncationWrites = Promise.resolve();

export const syncRuntimeStorage = {
  async getTruncatedMap(): Promise<Record<string, number>> {
    return summarizeStorageTruncation(await storageTruncationStorage.get());
  },
  recordTruncated(host: string, origin: string, checked: StorageTruncationCounts): Promise<void> {
    if (!origin) return Promise.resolve();
    const update = async () => {
      const stored = await storageTruncationStorage.get();
      const previous = stored[host];
      const known = typeof previous === 'object' ? previous.origins : {};
      const before = known[origin] || {};
      const counts = {
        local: checked.local ?? before.local,
        session: checked.session ?? before.session,
        source: checked.source ?? before.source,
        details: {
          local: checked.local === undefined ? before.details?.local : checked.details?.local,
          session: checked.session === undefined ? before.details?.session : checked.details?.session,
        },
      };
      const previousLegacy = typeof previous === 'number' ? previous : previous?.legacy;
      const legacy = checked.local !== undefined && checked.session !== undefined ? undefined : previousLegacy;
      const next = { ...stored };
      const origins = { ...known };
      if (truncationTotal(counts)) origins[origin] = counts;
      else delete origins[origin];
      if (legacy || Object.keys(origins).length) next[host] = { ...(legacy ? { legacy } : {}), origins };
      else delete next[host];
      if (JSON.stringify(previous) !== JSON.stringify(next[host])) await storageTruncationStorage.set(next);
    };
    const result = truncationWrites.then(update, update);
    truncationWrites = result.catch(() => {});
    return result;
  },
  async getSkippedIndexedDbMap(): Promise<Record<string, string[]>> {
    const data = await chrome.storage.local.get(RUNTIME_STORAGE_KEYS.skippedIndexedDb);
    return (data[RUNTIME_STORAGE_KEYS.skippedIndexedDb] as Record<string, string[]>) || {};
  },
  async recordSkippedIndexedDb(host: string, stores: string[]): Promise<void> {
    const stored = await this.getSkippedIndexedDbMap();
    if (JSON.stringify(stored[host] || []) === JSON.stringify(stores)) return;
    await chrome.storage.local.set({ [RUNTIME_STORAGE_KEYS.skippedIndexedDb]: { ...stored, [host]: stores } });
  },
  async getPulledAt(host: string): Promise<number> {
    const key = pulledHostKey(host);
    const data = await chrome.storage.session.get(key);
    return Number(data[key]) || 0;
  },
  async markPulled(host: string, at = Date.now()): Promise<void> {
    await chrome.storage.session.set({ [pulledHostKey(host)]: at });
  },
  async isSessionStarted(): Promise<boolean> {
    const data = await chrome.storage.session.get(RUNTIME_STORAGE_KEYS.sessionStarted);
    return !!data[RUNTIME_STORAGE_KEYS.sessionStarted];
  },
  async markSessionStarted(): Promise<void> {
    await chrome.storage.session.set({ [RUNTIME_STORAGE_KEYS.sessionStarted]: true });
  },
  async getSessionCaptureAt(host: string): Promise<number> {
    const key = sessionThrottleKey(host);
    const data = await chrome.storage.local.get(key);
    return Number(data[key]) || 0;
  },
  async markSessionCaptured(host: string, at = Date.now()): Promise<void> {
    await chrome.storage.local.set({ [sessionThrottleKey(host)]: at });
  },
  async getStandbySwitchedTabs(): Promise<StandbySwitchedTab[]> {
    const data = await chrome.storage.session.get(RUNTIME_STORAGE_KEYS.standbySwitchedTab);
    return Array.isArray(data[RUNTIME_STORAGE_KEYS.standbySwitchedTab])
      ? (data[RUNTIME_STORAGE_KEYS.standbySwitchedTab] as StandbySwitchedTab[])
      : [];
  },
  async setStandbySwitchedTabs(entries: StandbySwitchedTab[]): Promise<void> {
    await chrome.storage.session.set({ [RUNTIME_STORAGE_KEYS.standbySwitchedTab]: entries });
  },
};
