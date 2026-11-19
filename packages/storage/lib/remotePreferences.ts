import { settingsStorage } from './settingsStorage';
import { themeStorage } from './themeStorage';

const defaults = { theme: 'light', contextMenu: false, syncIntervalMinutes: 2 } as const;
type Key = keyof typeof defaults;
type Value = string | number | boolean;
type Entry = { value: Value; updatedAt: number; revision: string };
export type RemotePreferences = Partial<Record<Key, Entry>>;
// Renamed from the Drive journal; older local installs keep their entries.
const journal = 'cookiesync-remote-preferences-v1';
const legacyJournal = 'cookiesync-drive-preferences-v1';
const keys = Object.keys(defaults) as Key[];

function valid(key: Key, value: unknown) {
  if (key === 'theme') return ['light', 'dark', 'system'].includes(value as string);
  if (key === 'contextMenu') return typeof value === 'boolean';
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 60;
}

export function mergePreferences(...sources: RemotePreferences[]): RemotePreferences {
  const result: RemotePreferences = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('扩展设置格式错误');
    for (const key of Object.keys(source) as Key[]) {
      const entry = source[key];
      if (
        !keys.includes(key) ||
        !entry ||
        !valid(key, entry.value) ||
        !Number.isSafeInteger(entry.updatedAt) ||
        entry.updatedAt < 1 ||
        typeof entry.revision !== 'string' ||
        !entry.revision ||
        entry.revision.length > 80
      )
        throw new Error('扩展设置格式错误');
      const old = result[key];
      if (
        !old ||
        entry.updatedAt > old.updatedAt ||
        (entry.updatedAt === old.updatedAt &&
          (entry.revision > old.revision ||
            (entry.revision === old.revision && String(entry.value) > String(old.value))))
      )
        result[key] = { value: entry.value, updatedAt: entry.updatedAt, revision: entry.revision };
    }
  }
  return Object.fromEntries(keys.filter(key => result[key]).map(key => [key, result[key]]));
}

let queue = Promise.resolve();
function locked<T>(action: () => Promise<T>): Promise<T> {
  const run = () => (globalThis.navigator?.locks ? navigator.locks.request(journal, action) : action());
  const result = queue.then(run);
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function readJournal(): Promise<RemotePreferences> {
  const data = await chrome.storage.local.get([journal, legacyJournal]);
  return mergePreferences(data[journal] ?? data[legacyJournal] ?? {});
}

async function writeJournal(preferences: RemotePreferences): Promise<void> {
  await chrome.storage.local.set({ [journal]: preferences });
}

async function apply(key: Key, value: Value) {
  if (key === 'theme') await themeStorage.set(value as 'light' | 'dark' | 'system');
  else if (key === 'contextMenu') await settingsStorage.update({ contextMenu: value as boolean });
  else await settingsStorage.update({ syncIntervalMinutes: value as number });
}

export function editRemotePreference(key: Key, value: Value) {
  return locked(async () => {
    if (!valid(key, value)) throw new Error('扩展设置值无效');
    const local = await readJournal();
    local[key] = {
      value,
      updatedAt: Math.max(Date.now(), (local[key]?.updatedAt ?? 0) + 1),
      revision: crypto.randomUUID(),
    };
    await writeJournal(local);
    await apply(key, value);
  });
}

export function adoptPreferences(remote: RemotePreferences) {
  return locked(async () => {
    const local = await readJournal();
    const settings = await settingsStorage.get();
    const actual = {
      theme: await themeStorage.get(),
      contextMenu: settings.contextMenu ?? false,
      syncIntervalMinutes: settings.syncIntervalMinutes ?? 2,
    };
    for (const key of keys) {
      if (!local[key] && !remote[key] && actual[key] !== defaults[key] && valid(key, actual[key]))
        local[key] = { value: actual[key], updatedAt: 1, revision: 'migration' };
    }
    const merged = mergePreferences(remote, local);
    const stored = await chrome.storage.local.get([journal, legacyJournal]);
    if (JSON.stringify(merged) !== JSON.stringify(stored[journal] ?? stored[legacyJournal] ?? {}))
      await writeJournal(merged);
    for (const key of keys) {
      const entry = merged[key];
      if (entry && actual[key] !== entry.value) await apply(key, entry.value);
    }
    return merged;
  });
}
