/**
 * Storage area type for persisting and exchanging data.
 * @see https://developer.chrome.com/docs/extensions/reference/storage/#overview
 */
export enum StorageType {
  /**
   * Persist data locally against browser restarts. Will be deleted by uninstalling the extension.
   * @default
   */
  Local = 'local',
  /**
   * Uploads data to the users account in the cloud and syncs to the users browsers on other devices. Limits apply.
   */
  Sync = 'sync',
  /**
   * Requires an [enterprise policy](https://www.chromium.org/administrators/configuring-policy-for-extensions) with a
   * json schema for company wide config.
   */
  Managed = 'managed',
  /**
   * Only persist data until the browser is closed. Recommended for service workers which can shutdown anytime and
   * therefore need to restore their state. Set {@link SessionAccessLevel} for permitting content scripts access.
   * @implements Chromes [Session Storage](https://developer.chrome.com/docs/extensions/reference/storage/#property-session)
   */
  Session = 'session',
}

/**
 * Global access level requirement for the {@link StorageType.Session} Storage Area.
 * @implements Chromes [Session Access Level](https://developer.chrome.com/docs/extensions/reference/storage/#method-StorageArea-setAccessLevel)
 */
export enum SessionAccessLevel {
  /**
   * Storage can only be accessed by Extension pages (not Content scripts).
   * @default
   */
  ExtensionPagesOnly = 'TRUSTED_CONTEXTS',
  /**
   * Storage can be accessed by both Extension pages and Content scripts.
   */
  ExtensionPagesAndContentScripts = 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
}

type ValueOrUpdate<D> = D | ((prev: D) => Promise<D> | D);

export type BaseStorage<D> = {
  get: () => Promise<D>;
  set: (value: ValueOrUpdate<D>) => Promise<void>;
  getSnapshot: () => D | null;
  subscribe: (listener: () => void) => () => void;
};

type StorageConfig<D = string> = {
  /**
   * Assign the {@link StorageType} to use.
   * @default Local
   */
  storageType?: StorageType;
  /**
   * Only for {@link StorageType.Session}: Grant Content scripts access to storage area?
   * @default false
   */
  sessionAccessForContentScripts?: boolean;
  /**
   * Keeps state live in sync between all instances of the extension. Like between popup, side panel and content scripts.
   * @default false
   */
  liveUpdate?: boolean;
  /**
   * Optional serializer/deserializer for non-native storage values.
   * @default undefined
   */
  serialization?: {
    serialize: (value: D) => string;
    deserialize: (text: string) => D;
  };
};

async function resolveUpdate<D>(valueOrUpdate: ValueOrUpdate<D>, current: D): Promise<D> {
  if (typeof valueOrUpdate === 'function') {
    return await (valueOrUpdate as (prev: D) => Promise<D> | D)(current);
  }
  return valueOrUpdate;
}

let globalSessionAccessLevelFlag: StorageConfig['sessionAccessForContentScripts'] = false;

function checkStoragePermission(storageType: StorageType): void {
  if (chrome.storage[storageType] === undefined) {
    throw new Error(`Check your storage permission in manifest.json: ${storageType} is not defined`);
  }
}

/**
 * Creates a serialized, race-free storage wrapper over chrome.storage.
 */
export function createStorage<D = string>(key: string, fallback: D, config?: StorageConfig<D>): BaseStorage<D> {
  let cache: D | null = null;
  let initedCache = false;
  let inFlightWrites = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  let listeners: Array<() => void> = [];
  const storageType = config?.storageType ?? StorageType.Local;
  const liveUpdate = config?.liveUpdate ?? false;
  const serialize = config?.serialization?.serialize ?? ((v: D) => v);
  const deserialize = config?.serialization?.deserialize ?? (v => v as D);

  if (
    globalSessionAccessLevelFlag === false &&
    storageType === StorageType.Session &&
    config?.sessionAccessForContentScripts === true
  ) {
    checkStoragePermission(storageType);
    chrome.storage[storageType]
      .setAccessLevel({
        accessLevel: SessionAccessLevel.ExtensionPagesAndContentScripts,
      })
      .catch(error => {
        console.warn(error);
      });
    globalSessionAccessLevelFlag = true;
  }

  const _getDataFromStorage = async (): Promise<D> => {
    checkStoragePermission(storageType);
    const value = await chrome.storage[storageType].get([key]);
    const raw = value[key];
    return raw === undefined ? fallback : (deserialize(raw) ?? fallback);
  };

  const _emitChange = () => {
    listeners.forEach(listener => listener());
  };

  const set = (valueOrUpdate: ValueOrUpdate<D>): Promise<void> => {
    const task = async () => {
      inFlightWrites++;
      try {
        if (!initedCache) {
          cache = await _getDataFromStorage();
          initedCache = true;
        }
        const current = cache !== null && cache !== undefined ? cache : fallback;
        const next = await resolveUpdate(valueOrUpdate, current);
        cache = next;
        _emitChange();
        if (next !== null && next !== undefined) {
          checkStoragePermission(storageType);
          await chrome.storage[storageType].set({ [key]: serialize(next) });
        }
      } finally {
        inFlightWrites--;
      }
    };
    const result = writeQueue.then(task, task);
    writeQueue = result.catch(() => {});
    return result;
  };

  const subscribe = (listener: () => void) => {
    listeners = [...listeners, listener];
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  };

  const getSnapshot = () => cache;

  _getDataFromStorage()
    .then(data => {
      if (!initedCache && inFlightWrites === 0) {
        cache = data;
        initedCache = true;
        _emitChange();
      }
    })
    .catch(() => {});

  function _updateFromStorageOnChanged(changes: { [key: string]: chrome.storage.StorageChange }) {
    if (changes[key] === undefined) return;
    // Ignore echoed change events while our own serialized writes are still committing.
    if (inFlightWrites > 0) return;

    const raw = changes[key].newValue;
    const nextValue = raw === undefined ? fallback : (deserialize(raw) ?? fallback);
    if (Object.is(cache, nextValue)) return;

    cache = nextValue;
    initedCache = true;
    _emitChange();
  }

  if (liveUpdate) {
    chrome.storage[storageType].onChanged.addListener(_updateFromStorageOnChanged);
  }

  return {
    get: _getDataFromStorage,
    set,
    getSnapshot,
    subscribe,
  };
}
