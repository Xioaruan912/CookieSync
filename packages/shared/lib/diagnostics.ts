/**
 * Redacted diagnostics for support and cross-machine comparison.
 *
 * Cookie and storage values are never included: only length and the first two
 * characters, which is enough to tell two tokens apart without leaking them.
 * WebDAV credentials and the encryption password are not part of the input.
 */
export interface DiagnosticsCookie {
  name?: string | null;
  domain?: string | null;
  path?: string | null;
  session?: boolean | null;
  httpOnly?: boolean | null;
  secure?: boolean | null;
  sameSite?: string | null;
  expirationDate?: number | null;
  value?: string | null;
}

export interface DiagnosticsStorageItem {
  key?: string | null;
  value?: string | null;
  origin?: string | null;
}

export interface DiagnosticsIndexedDbRecord {
  database?: string | null;
  store?: string | null;
  key?: string | null;
  value?: string | null;
  origin?: string | null;
}

export interface DiagnosticsSite {
  domain: string;
  listed?: boolean;
  autoPush?: boolean;
  autoPull?: boolean;
  includeSessionStorage?: boolean;
  includeIndexedDB?: boolean;
  cookies?: DiagnosticsCookie[];
  localStorageItems?: DiagnosticsStorageItem[];
  sessionStorageItems?: DiagnosticsStorageItem[];
  indexedDBRecords?: DiagnosticsIndexedDbRecord[];
  pending?: { cookies: number; localStorageItems: number; sessionStorageItems: number; indexedDBRecords: number; capturedAt?: number };
  health?: { state?: string; message?: string; checkedAt?: number; userName?: string; loginKeysMissing?: boolean };
  lastPushAt?: number;
  lastPullAt?: number;
  error?: string;
}

export interface DiagnosticsInput {
  version: string;
  now: number;
  platform: string;
  settings: {
    includeLocalStorage?: boolean;
    includeSessionStorage?: boolean;
    includeIndexedDB?: boolean;
    protobufEncoding?: boolean;
    encryptionEnabled?: boolean;
    configChannel?: string;
    rollingBackup?: boolean;
    backgroundSync?: boolean;
    autoDiscoverSites?: boolean;
  };
  destination?: { origin?: string; path?: string };
  connected: boolean;
  sites: DiagnosticsSite[];
  status?: { phase?: string; lastCheck?: number; lastSuccess?: number; pendingCount?: number; error?: string; note?: string };
  schemaWarning?: { at: number; message: string };
  truncated?: Record<string, number>;
  indexedDbSkipped?: Record<string, string[]>;
}

const short = (value?: string | null) => {
  const text = typeof value === 'string' ? value : '';
  return { length: text.length, prefix: text.slice(0, 2) };
};

export function buildDiagnostics(input: DiagnosticsInput) {
  return {
    format: 'cookiesync-diagnostics-v1',
    generatedAt: new Date(input.now).toISOString(),
    extensionVersion: input.version,
    platform: input.platform,
    connection: {
      connected: input.connected,
      destination: input.destination?.origin
        ? { origin: input.destination.origin, path: input.destination.path }
        : undefined,
    },
    settings: input.settings,
    status: input.status,
    schemaWarning: input.schemaWarning,
    truncatedItems: input.truncated || {},
    skippedIndexedDbStores: input.indexedDbSkipped || {},
    sites: input.sites.map(site => ({
      domain: site.domain,
      listed: site.listed,
      autoPush: site.autoPush,
      autoPull: site.autoPull,
      includeSessionStorage: site.includeSessionStorage,
      includeIndexedDB: site.includeIndexedDB,
      cookies: (site.cookies || []).map(cookie => ({
        name: cookie.name || '',
        domain: cookie.domain || '',
        path: cookie.path || '/',
        session: !!cookie.session,
        httpOnly: !!cookie.httpOnly,
        secure: !!cookie.secure,
        sameSite: cookie.sameSite || 'unspecified',
        expiresAt: cookie.session ? null : cookie.expirationDate || null,
        value: short(cookie.value),
      })),
      localStorage: (site.localStorageItems || []).map(item => ({
        key: item.key || '',
        origin: item.origin || '',
        value: short(item.value),
      })),
      sessionStorage: (site.sessionStorageItems || []).map(item => ({
        key: item.key || '',
        origin: item.origin || '',
        value: short(item.value),
      })),
      indexedDB: Object.values(
        (site.indexedDBRecords || []).reduce<Record<string, { database: string; store: string; origin: string; records: number; bytes: number }>>(
          (groups, record) => {
            const id = `${record.origin || ''}\0${record.database || ''}\0${record.store || ''}`;
            const group = groups[id] || {
              database: record.database || '',
              store: record.store || '',
              origin: record.origin || '',
              records: 0,
              bytes: 0,
            };
            group.records += 1;
            group.bytes += (record.key || '').length + (record.value || '').length;
            groups[id] = group;
            return groups;
          },
          {},
        ),
      ),
      pending: site.pending,
      health: site.health,
      lastPushAt: site.lastPushAt,
      lastPullAt: site.lastPullAt,
      error: site.error,
    })),
  };
}
