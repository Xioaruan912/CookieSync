import {
  decodeIndexedDbKey,
  decodeIndexedDbValue,
  encodeIndexedDbKey,
  encodeIndexedDbValue,
  indexedDbLimits,
  type IndexedDbRecordLike,
} from '@sync-your-cookie/shared/lib/cookie/indexedDbCodec';

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string) =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), ms)),
  ]);

const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || new Error('IndexedDB 请求失败'));
  });

const transactionDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });

const openDatabase = (name: string) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const value = indexedDB.open(name);
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || new Error('无法打开 IndexedDB'));
    value.onblocked = () => reject(new Error('IndexedDB 被其他连接阻塞'));
  });

interface StoredRecord {
  key: IDBValidKey;
  value: unknown;
}

const readStore = async (db: IDBDatabase, storeName: string): Promise<StoredRecord[]> => {
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const count = await request(store.count());
  if (count > indexedDbLimits.maxRecordsPerStore)
    throw new Error(`对象仓库记录过多（${count}）`);
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  if (keys.length !== values.length) throw new Error('IndexedDB 键值数量不一致');
  return values.map((value, index) => ({ key: keys[index], value }));
};

/**
 * Captures whole object stores of small databases. A store that does not fit or
 * contains a value type we cannot encode losslessly is skipped entirely, never
 * half-captured, because restore clears the store before writing.
 */
export async function captureIndexedDb(): Promise<{
  records: IndexedDbRecordLike[];
  skipped: string[];
}> {
  const result: { records: IndexedDbRecordLike[]; skipped: string[] } = { records: [], skipped: [] };
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return result;
  let names: string[] = [];
  try {
    names = (await withTimeout(indexedDB.databases(), 2000, '枚举 IndexedDB'))
      .map(database => database.name)
      .filter((name): name is string => !!name)
      .sort()
      .slice(0, indexedDbLimits.maxDatabases);
  } catch {
    return result;
  }
  let total = 0;
  for (const name of names) {
    let db: IDBDatabase;
    try {
      db = await withTimeout(openDatabase(name), 2000, `打开 ${name}`);
    } catch {
      result.skipped.push(`${name}/*`);
      continue;
    }
    try {
      for (const storeName of Array.from(db.objectStoreNames).sort().slice(0, indexedDbLimits.maxStoresPerDatabase)) {
        const label = `${name}/${storeName}`;
        try {
          const stored = await withTimeout(readStore(db, storeName), 3000, `读取 ${label}`);
          const records: IndexedDbRecordLike[] = [];
          let bytes = 0;
          for (const item of stored) {
            const key = JSON.stringify(await encodeIndexedDbValue(item.key));
            const value = JSON.stringify(await encodeIndexedDbValue(item.value));
            bytes += key.length + value.length;
            if (bytes > indexedDbLimits.maxBytesPerStore) throw new Error('对象仓库超过体积上限');
            records.push({ database: name, store: storeName, key, value, origin: location.origin });
          }
          if (total + bytes > indexedDbLimits.maxBytesPerOrigin) throw new Error('站点 IndexedDB 超过体积上限');
          total += bytes;
          result.records.push(...records);
        } catch {
          result.skipped.push(label);
        }
      }
    } finally {
      db.close();
    }
  }
  return result;
}

/**
 * Restores only the stores present in the snapshot. The database and store must
 * already exist; we never create an empty database just to fill it.
 */
export async function restoreIndexedDb(records: IndexedDbRecordLike[], origin: string) {
  const groups = new Map<string, { database: string; store: string; records: IndexedDbRecordLike[] }>();
  for (const record of records || []) {
    if (record.origin && record.origin !== origin) continue;
    const id = `${record.database}\0${record.store}`;
    const group = groups.get(id) || { database: record.database, store: record.store, records: [] };
    group.records.push(record);
    groups.set(id, group);
  }
  if (!groups.size) return { restored: 0, failed: [] as string[] };
  let existing: Set<string>;
  try {
    existing = new Set((await withTimeout(indexedDB.databases(), 2000, '枚举 IndexedDB')).map(db => db.name || ''));
  } catch {
    return { restored: 0, failed: [...groups.values()].map(group => `${group.database}/${group.store}`) };
  }
  let restored = 0;
  const failed: string[] = [];
  for (const group of groups.values()) {
    const label = `${group.database}/${group.store}`;
    if (!existing.has(group.database)) {
      failed.push(label);
      continue;
    }
    let db: IDBDatabase;
    try {
      db = await withTimeout(openDatabase(group.database), 2000, `打开 ${label}`);
    } catch {
      failed.push(label);
      continue;
    }
    try {
      if (!db.objectStoreNames.contains(group.store)) {
        failed.push(label);
        continue;
      }
      const tx = db.transaction(group.store, 'readwrite');
      const store = tx.objectStore(group.store);
      store.clear();
      for (const record of group.records) {
        const value = decodeIndexedDbValue(JSON.parse(record.value));
        if (store.keyPath !== null) store.put(value);
        else store.put(value, decodeIndexedDbKey(record.key));
      }
      await withTimeout(transactionDone(tx), 5000, `写入 ${label}`);
      restored += group.records.length;
    } catch {
      failed.push(label);
    } finally {
      db.close();
    }
  }
  return { restored, failed };
}
