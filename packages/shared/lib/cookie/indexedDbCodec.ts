/**
 * IndexedDB values are structured-cloned, not JSON. A signed JSON encoding is
 * needed so a small object store can travel through the same file as cookies
 * without silently turning a Date into a string or a Blob into `{}`.
 *
 * Every value is a tagged array (`['s', 'text']`, `['t', 1700]`, ...). Anything
 * outside the supported set fails loudly instead of being captured lossily.
 */
export interface IndexedDbRecordLike {
  database: string;
  store: string;
  key: string;
  value: string;
  origin: string;
}

export const indexedDbLimits = {
  maxDatabases: 4,
  maxStoresPerDatabase: 8,
  maxRecordsPerStore: 200,
  maxBytesPerStore: 256 * 1024,
  maxBytesPerOrigin: 512 * 1024,
} as const;

type Tagged =
  | ['n']
  | ['u']
  | ['b', boolean]
  | ['d', number | 'NaN' | 'Infinity' | '-Infinity']
  | ['s', string]
  | ['t', number]
  | ['i', string]
  | ['a', string]
  | ['y', string, string]
  | ['l', string, string]
  | ['r', Tagged[]]
  | ['o', [string, Tagged][]]
  | ['m', [Tagged, Tagged][]]
  | ['e', Tagged[]];

export class UnsupportedIndexedDbValue extends Error {
  constructor(readonly kind: string) {
    super(`IndexedDB 值类型不受支持：${kind}`);
  }
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
};

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

const typeName = (value: unknown) => (value === null ? 'null' : typeof value);

export async function encodeIndexedDbValue(value: unknown): Promise<Tagged> {
  if (value === null) return ['n'];
  if (value === undefined) return ['u'];
  if (typeof value === 'boolean') return ['b', value];
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['d', 'NaN'];
    if (value === Infinity) return ['d', 'Infinity'];
    if (value === -Infinity) return ['d', '-Infinity'];
    return ['d', value];
  }
  if (typeof value === 'string') return ['s', value];
  if (typeof value === 'bigint') return ['i', value.toString()];
  if (value instanceof Date) return ['t', value.getTime()];
  if (value instanceof ArrayBuffer) return ['a', bytesToBase64(new Uint8Array(value))];
  if (ArrayBuffer.isView(value) && !(value instanceof DataView))
    return [
      'y',
      (value as { constructor: { name: string } }).constructor.name,
      bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    ];
  if (typeof Blob !== 'undefined' && value instanceof Blob)
    return ['l', value.type, bytesToBase64(new Uint8Array(await value.arrayBuffer()))];
  if (Array.isArray(value)) return ['r', await Promise.all(value.map(encodeIndexedDbValue))];
  if (value instanceof Map)
    return ['m', await Promise.all([...value.entries()].map(async ([key, item]) => [await encodeIndexedDbValue(key), await encodeIndexedDbValue(item)] as [Tagged, Tagged]))];
  if (value instanceof Set) return ['e', await Promise.all([...value.values()].map(encodeIndexedDbValue))];
  if (typeof value === 'object') {
    const entries: [string, Tagged][] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      entries.push([key, await encodeIndexedDbValue(item)]);
    return ['o', entries];
  }
  throw new UnsupportedIndexedDbValue(typeName(value));
}

const typedArray = (name: string, bytes: Uint8Array): unknown => {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  switch (name) {
    case 'Int8Array':
      return new Int8Array(buffer);
    case 'Uint8Array':
      return new Uint8Array(buffer);
    case 'Uint8ClampedArray':
      return new Uint8ClampedArray(buffer);
    case 'Int16Array':
      return new Int16Array(buffer);
    case 'Uint16Array':
      return new Uint16Array(buffer);
    case 'Int32Array':
      return new Int32Array(buffer);
    case 'Uint32Array':
      return new Uint32Array(buffer);
    case 'Float32Array':
      return new Float32Array(buffer);
    case 'Float64Array':
      return new Float64Array(buffer);
    case 'BigInt64Array':
      return new BigInt64Array(buffer);
    case 'BigUint64Array':
      return new BigUint64Array(buffer);
    default:
      throw new UnsupportedIndexedDbValue(name);
  }
};

export function decodeIndexedDbValue(tagged: unknown): unknown {
  if (!Array.isArray(tagged) || typeof tagged[0] !== 'string') throw new Error('IndexedDB 值编码损坏');
  const [tag, first, second] = tagged as [string, unknown, unknown];
  switch (tag) {
    case 'n':
      return null;
    case 'u':
      return undefined;
    case 'b':
    case 's':
      return first;
    case 'd':
      if (first === 'NaN') return NaN;
      if (first === 'Infinity') return Infinity;
      if (first === '-Infinity') return -Infinity;
      return first;
    case 't':
      return new Date(Number(first));
    case 'i':
      return BigInt(String(first));
    case 'a':
      return base64ToBytes(String(first)).buffer;
    case 'y':
      return typedArray(String(first), base64ToBytes(String(second)));
    case 'l':
      if (typeof Blob === 'undefined') throw new UnsupportedIndexedDbValue('Blob');
      return new Blob([base64ToBytes(String(second))], { type: String(first) });
    case 'r':
      return (first as unknown[]).map(decodeIndexedDbValue);
    case 'o': {
      const result: Record<string, unknown> = {};
      for (const entry of first as [string, unknown][]) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw new Error('IndexedDB 对象编码损坏');
        // defineProperty keeps a stored "__proto__" key a plain property.
        Object.defineProperty(result, entry[0], {
          value: decodeIndexedDbValue(entry[1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    case 'm':
      return new Map((first as [unknown, unknown][]).map(([key, value]) => [decodeIndexedDbValue(key), decodeIndexedDbValue(value)]));
    case 'e':
      return new Set((first as unknown[]).map(decodeIndexedDbValue));
    default:
      throw new Error(`IndexedDB 值标签未知：${tag}`);
  }
}

/** JSON of the encoded key, sorted so fingerprints are deterministic. */
export const encodeIndexedDbKey = async (key: IDBValidKey) => JSON.stringify(await encodeIndexedDbValue(key));

export const decodeIndexedDbKey = (encoded: string) => decodeIndexedDbValue(JSON.parse(encoded)) as IDBValidKey;

const recordBytes = (record: IndexedDbRecordLike) => (record.key || '').length + (record.value || '').length;

/**
 * Whole stores are kept or dropped together: restoring a partially captured
 * store would clear records the snapshot never saw. Ordering is stable so the
 * same page always produces the same file bytes.
 */
export function fitIndexedDbRecords(records: IndexedDbRecordLike[], budgetBytes = indexedDbLimits.maxBytesPerOrigin) {
  const groups = new Map<string, IndexedDbRecordLike[]>();
  for (const record of records || []) {
    if (!record?.database || !record?.store || typeof record.key !== 'string' || typeof record.value !== 'string')
      continue;
    const id = `${record.origin || ''}\0${record.database}\0${record.store}`;
    const group = groups.get(id) || [];
    group.push(record);
    groups.set(id, group);
  }
  const kept: IndexedDbRecordLike[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  for (const id of [...groups.keys()].sort()) {
    const group = groups.get(id)!;
    const size = group.reduce((total, record) => total + recordBytes(record), 0);
    if (
      group.length > indexedDbLimits.maxRecordsPerStore ||
      size > indexedDbLimits.maxBytesPerStore ||
      bytes + size > budgetBytes
    ) {
      skipped.push(id.split('\0').slice(1).join('/'));
      continue;
    }
    bytes += size;
    kept.push(...group);
  }
  kept.sort((a, b) => `${a.origin}\0${a.database}\0${a.store}\0${a.key}`.localeCompare(`${b.origin}\0${b.database}\0${b.store}\0${b.key}`));
  return { records: kept, skipped, bytes };
}
