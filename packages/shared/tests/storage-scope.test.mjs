import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function storageArea() {
  const data = {};
  const listeners = [];
  return {
    data,
    get: async keys =>
      Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, data[key]])),
    set: async values => {
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]),
      );
      Object.assign(data, values);
      for (const listener of listeners) await listener(changes);
    },
    remove: async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    onChanged: { addListener: listener => listeners.push(listener) },
    setAccessLevel: async () => {},
  };
}
globalThis.chrome = { storage: { sync: storageArea(), local: storageArea(), session: storageArea() } };

const {
  pageOrigin,
  scopeStorageItems,
  mergeScopedItems,
  selectScopedItems,
  sessionStorageEnabled,
  storageLimits,
  pickAutomaticStorage,
  matchesSiteScope,
  domainContentHash,
  localStorageContentHash,
  storageBytes,
  encodeIndexedDbValue,
  decodeIndexedDbValue,
  fitIndexedDbRecords,
  indexedDbLimits,
} = require('../dist/index.js');
const { encodeCookiesMap, decodeCookiesMap } = require('@sync-your-cookie/protobuf');
const { syncRuntimeStorage } = require('@sync-your-cookie/storage/lib/syncRuntimeStorage');

const WWW = 'https://www.example.com';
const APP = 'https://app.example.com';

test('local storage may use all remaining site capacity when session storage is off', () => {
  const items = (prefix, count, origin) =>
    Array.from({ length: count }, (_, index) => ({
      key: prefix + index,
      value: 'x'.repeat(50 * 1024),
      origin,
    }));
  const retainedLocal = [...items('ap', 8, APP), ...items('pa', 4, 'https://panel.example.com')];
  const incoming = items('ww', 7, WWW);
  const picked = pickAutomaticStorage(
    { origin: WWW, localStorageItems: incoming },
    undefined,
    { localStorageItems: retainedLocal },
    false,
  );
  assert.equal(picked.truncated, 0);
  assert.equal(picked.localStorageItems.length, retainedLocal.length + incoming.length);
  assert.ok(storageBytes(picked.localStorageItems) <= storageLimits.maxBytesPerDomain);
});

test('storage budget includes retained session data from earlier captures', () => {
  const retained = Array.from({ length: 20 }, (_, index) => ({
    key: String(index),
    value: 'x'.repeat(50 * 1024),
    origin: index < 10 ? APP : WWW,
  }));
  const picked = pickAutomaticStorage(
    { origin: WWW, localStorageItems: [{ key: 'item', value: 'x'.repeat(40 * 1024) }] },
    undefined,
    { sessionStorageItems: retained },
    true,
  );
  assert.deepEqual(picked.sessionStorageItems, retained);
  assert.equal(picked.localStorageItems.length, 0);
  assert.equal(picked.truncated, 1);
});

test('clean rechecks retire legacy and per-origin limits without deleting another origin or unreported area', async () => {
  const host = 'fixture.example.com';
  await chrome.storage.local.set({ 'cookiesync-storage-truncated': { [host]: 3 } });
  assert.equal((await syncRuntimeStorage.getTruncatedMap())[host], 3);
  await syncRuntimeStorage.recordTruncated(host, WWW, { local: 0, session: 0 });
  assert.equal((await syncRuntimeStorage.getTruncatedMap())[host], undefined);
  await Promise.all([
    syncRuntimeStorage.recordTruncated(host, WWW, { local: 2, session: 1 }),
    syncRuntimeStorage.recordTruncated(host, APP, { local: 4, session: 0 }),
  ]);
  assert.equal((await syncRuntimeStorage.getTruncatedMap())[host], 7);
  await syncRuntimeStorage.recordTruncated(host, WWW, { local: 0 });
  assert.equal((await syncRuntimeStorage.getTruncatedMap())[host], 5);
  await syncRuntimeStorage.recordTruncated(host, WWW, { local: 0, session: 0 });
  assert.equal((await syncRuntimeStorage.getTruncatedMap())[host], 4);
  await syncRuntimeStorage.recordTruncated(host, APP, { local: 0, session: 0 });
  assert.equal((await syncRuntimeStorage.getTruncatedMap())[host], undefined);
});

test('pageOrigin keeps only real http(s) origins', () => {
  assert.equal(pageOrigin('https://www.example.com/path?q=1'), WWW);
  assert.equal(pageOrigin('http://example.com:8080/'), 'http://example.com:8080');
  assert.equal(pageOrigin('chrome-extension://abc/options.html'), undefined);
  assert.equal(pageOrigin('about:blank'), undefined);
  assert.equal(pageOrigin(undefined), undefined);
  assert.equal(pageOrigin('not a url'), undefined);
});

test('site scope matches subdomains but never lookalike domains', () => {
  assert.equal(matchesSiteScope('115.com', 'app.115.com'), true);
  assert.equal(matchesSiteScope('www.115.com', '115.com'), true);
  assert.equal(matchesSiteScope('115.com', 'evil-115.com'), false);
  assert.equal(matchesSiteScope('example.com', 'example.com.evil.test'), false);
});

test('scopeStorageItems tags the origin, sorts keys and enforces the caps', () => {
  const scoped = scopeStorageItems(
    [
      { key: 'b', value: '2' },
      { key: 'a', value: '1' },
    ],
    WWW,
    1024,
  );
  assert.deepEqual(
    scoped.items.map(item => [item.key, item.origin]),
    [
      ['a', WWW],
      ['b', WWW],
    ],
  );
  assert.equal(scoped.truncated, 0);

  const overItems = scopeStorageItems(
    Array.from({ length: 5 }, (_, index) => ({ key: `k${index}`, value: 'v' })),
    WWW,
    1024,
    3,
  );
  assert.equal(overItems.items.length, 3);
  assert.equal(overItems.truncated, 2);
  assert.deepEqual(overItems.details, [
    { reason: 'item-count', bytes: 6, limit: 3 },
    { reason: 'item-count', bytes: 6, limit: 3 },
  ]);

  const overSize = scopeStorageItems(
    [{ key: 'big', value: 'x'.repeat(storageLimits.maxItemBytes) }],
    WWW,
    10 * 1024 * 1024,
  );
  assert.equal(overSize.items.length, 0);
  assert.equal(overSize.truncated, 1);
  assert.deepEqual(overSize.details, [{ reason: 'item-bytes', bytes: 262150, limit: 131072 }]);

  const overBytes = scopeStorageItems(
    [
      { key: 'a', value: 'x'.repeat(300) },
      { key: 'b', value: 'x'.repeat(300) },
    ],
    WWW,
    1000,
  );
  assert.equal(overBytes.items.length, 1);
  assert.equal(overBytes.truncated, 1);
  assert.deepEqual(overBytes.details, [{ reason: 'site-bytes', bytes: 602, limit: 2097152, remaining: 398 }]);

  const overOrigin = scopeStorageItems(
    Array.from({ length: 11 }, (_, index) => ({ key: String(index), value: 'x'.repeat(50 * 1024) })),
    APP,
    storageLimits.maxBytesPerDomain,
  );
  assert.equal(overOrigin.details[0].reason, 'origin-bytes');
  assert.equal(overOrigin.details[0].limit, storageLimits.maxBytesPerOrigin);
});

test('mergeScopedItems replaces one origin and keeps every other origin', () => {
  const stored = [
    { key: 'token', value: 'old-www', origin: WWW },
    { key: 'token', value: 'app-token', origin: APP },
    { key: 'legacy', value: 'untagged' },
  ];
  const merged = mergeScopedItems(stored, [{ key: 'token', value: 'new-www' }], WWW);
  assert.deepEqual(
    merged.map(item => [item.origin, item.key, item.value]),
    [
      [APP, 'token', 'app-token'],
      [WWW, 'token', 'new-www'],
    ],
  );
});

test('selectScopedItems hands a tab its own origin plus legacy entries only', () => {
  const items = [
    { key: 'a', value: '1', origin: WWW },
    { key: 'b', value: '2', origin: APP },
    { key: 'c', value: '3' },
  ];
  assert.deepEqual(
    selectScopedItems(items, WWW).map(item => item.key),
    ['a', 'c'],
  );
});

test('session storage is opt-in per site over a default that is off', () => {
  assert.equal(sessionStorageEnabled(undefined, undefined), false);
  assert.equal(sessionStorageEnabled(false, undefined), false);
  assert.equal(sessionStorageEnabled(true, undefined), true);
  assert.equal(sessionStorageEnabled(false, true), true);
  assert.equal(sessionStorageEnabled(true, false), false);
});

test('pickAutomaticStorage merges one origin without touching the others', () => {
  const cached = {
    localStorageItems: [
      { key: 'token', value: 'cached-www', origin: WWW },
      { key: 'token', value: 'cached-app', origin: APP },
    ],
    sessionStorageItems: [{ key: 'ss', value: 'cached-ss', origin: APP }],
  };
  const picked = pickAutomaticStorage(
    {
      origin: WWW,
      localStorageItems: [{ key: 'token', value: 'live-www' }],
      sessionStorageItems: [{ key: 'ss', value: 'live-ss' }],
      truncated: 3,
    },
    undefined,
    cached,
    true,
  );
  assert.deepEqual(
    picked.localStorageItems.map(item => [item.origin, item.value]),
    [
      [APP, 'cached-app'],
      [WWW, 'live-www'],
    ],
  );
  assert.deepEqual(
    picked.sessionStorageItems.map(item => [item.origin, item.value]),
    [
      [APP, 'cached-ss'],
      [WWW, 'live-ss'],
    ],
  );
  assert.equal(picked.truncated, 3);
});

test('pickAutomaticStorage keeps stored session state when the page did not report it', () => {
  const cached = { localStorageItems: [], sessionStorageItems: [{ key: 'ss', value: 'kept', origin: APP }] };
  const picked = pickAutomaticStorage(
    { origin: APP, localStorageItems: [{ key: 'token', value: 'live' }] },
    undefined,
    cached,
    true,
  );
  assert.deepEqual(
    picked.sessionStorageItems.map(item => item.value),
    ['kept'],
  );

  const disabled = pickAutomaticStorage(
    {
      origin: APP,
      localStorageItems: [{ key: 'token', value: 'live' }],
      sessionStorageItems: [{ key: 'ss', value: 'ignored' }],
    },
    undefined,
    cached,
    false,
  );
  assert.deepEqual(
    disabled.sessionStorageItems.map(item => item.value),
    ['kept'],
  );
});

test('pickAutomaticStorage falls back to the pending job when no tab is open', () => {
  const pending = { localStorageItems: [{ key: 'token', value: 'pending', origin: WWW }], sessionStorageItems: [] };
  const picked = pickAutomaticStorage(undefined, pending, {}, true);
  assert.equal(picked.localStorageItems[0].value, 'pending');
  assert.deepEqual(picked.sessionStorageItems, []);
});

test('fingerprints separate origins and include session storage', async () => {
  const www = [{ key: 'token', value: 'same', origin: WWW }];
  const app = [{ key: 'token', value: 'same', origin: APP }];
  assert.notEqual(await localStorageContentHash(www), await localStorageContentHash(app));
  assert.equal(await localStorageContentHash(www), await localStorageContentHash([...www].reverse()));

  const withSession = await domainContentHash({
    cookies: [],
    localStorageItems: www,
    sessionStorageItems: [{ key: 'ss', value: '1', origin: WWW }],
  });
  const withoutSession = await domainContentHash({ cookies: [], localStorageItems: www, sessionStorageItems: [] });
  assert.notEqual(withSession, withoutSession);
});

test('protobuf round trip carries origin, session storage and the schema marker', async () => {
  const map = {
    updateTime: 1,
    createTime: 2,
    domainCookieMap: {
      'example.com': {
        updateTime: 3,
        createTime: 4,
        cookies: [{ domain: '.example.com', name: 'sid', value: 'x', session: true, path: '/' }],
        localStorageItems: [{ key: 'token', value: 'v', origin: WWW }],
        sessionStorageItems: [{ key: 'ss', value: 's', origin: APP }],
        indexedDBRecords: [{ database: 'db', store: 'auth', key: '["s","k"]', value: '["s","v"]', origin: WWW }],
        schema: 3,
        userAgent: 'ua',
      },
    },
  };
  const decoded = await decodeCookiesMap(await encodeCookiesMap(map));
  const entry = decoded.domainCookieMap['example.com'];
  assert.equal(entry.localStorageItems[0].origin, WWW);
  assert.equal(entry.sessionStorageItems[0].origin, APP);
  assert.equal(entry.indexedDBRecords[0].database, 'db');
  assert.equal(entry.indexedDBRecords[0].origin, WWW);
  assert.equal(entry.schema, 3);
  assert.deepEqual(
    await domainContentHash(entry),
    await domainContentHash(map.domainCookieMap['example.com']),
    'decoding must preserve the semantic fingerprint',
  );
});

test('storageBytes counts both key and value', () => {
  assert.equal(storageBytes([{ key: 'ab', value: 'cd' }]), 8);
  assert.equal(storageBytes(undefined), 0);
});

test('indexeddb codec round trips structured-clone values without loss', async () => {
  const values = [
    null,
    undefined,
    true,
    42,
    'text',
    new Date(1700000000000),
    new Uint8Array([1, 2, 3]),
    new Map([['a', 1]]),
    new Set([1, 'b']),
    { nested: { list: [1, { deep: true }] } },
  ];
  for (const value of values) {
    const encoded = JSON.stringify(await encodeIndexedDbValue(value));
    assert.deepEqual(decodeIndexedDbValue(JSON.parse(encoded)), value);
  }
  assert.ok(Number.isNaN(decodeIndexedDbValue(JSON.parse(JSON.stringify(await encodeIndexedDbValue(NaN))))));
  const blob = new Blob(['hello'], { type: 'text/plain' });
  const decodedBlob = decodeIndexedDbValue(JSON.parse(JSON.stringify(await encodeIndexedDbValue(blob))));
  assert.equal(decodedBlob.type, 'text/plain');
  assert.equal(await decodedBlob.text(), 'hello');
  await assert.rejects(
    encodeIndexedDbValue(() => {}),
    /不受支持/,
  );
});

test('indexeddb capture keeps or drops whole stores and never half-captures', () => {
  const records = [
    { database: 'db', store: 'auth', key: '["s","k"]', value: '"v"', origin: WWW },
    {
      database: 'db',
      store: 'cache',
      key: '["s","k2"]',
      value: 'x'.repeat(indexedDbLimits.maxBytesPerStore),
      origin: WWW,
    },
  ];
  const fitted = fitIndexedDbRecords(records, indexedDbLimits.maxBytesPerOrigin);
  assert.equal(fitted.records.length, 1);
  assert.equal(fitted.records[0].store, 'auth');
  assert.deepEqual(fitted.skipped, ['db/cache']);
});

test('indexeddb records merge per origin and stay put when not reported', () => {
  const cached = {
    localStorageItems: [],
    indexedDBRecords: [
      { database: 'db', store: 'auth', key: '["s","a"]', value: '"app"', origin: APP },
      { database: 'db', store: 'auth', key: '["s","w"]', value: '"old"', origin: WWW },
    ],
  };
  const observed = {
    origin: WWW,
    localStorageItems: [],
    indexedDBRecords: [{ database: 'db', store: 'auth', key: '["s","w"]', value: '"new"', origin: WWW }],
    truncated: 0,
  };
  const merged = pickAutomaticStorage(observed, undefined, cached, false, true, true);
  assert.deepEqual(
    merged.indexedDBRecords.map(record => [record.origin, record.value]),
    [
      [APP, '"app"'],
      [WWW, '"new"'],
    ],
  );

  const silent = pickAutomaticStorage(
    { origin: WWW, localStorageItems: [], truncated: 0 },
    undefined,
    cached,
    false,
    true,
    true,
  );
  assert.deepEqual(
    silent.indexedDBRecords.map(record => record.origin),
    [APP, WWW],
  );

  const disabled = pickAutomaticStorage(observed, undefined, cached, false, true, false);
  assert.deepEqual(
    disabled.indexedDBRecords.map(record => record.value),
    ['"app"', '"old"'],
  );
});

// End-to-end restoration through the browser mock: each tab receives only its
// own origin, session storage is written before the reload, and untouched tabs
// stay untouched.
test('restore applies each origin to its own tab and refreshes once for session state', async () => {
  const { pullAndSetCookies } = require('../lib/cookie/withStorage.ts');
  const writes = [];
  let reloads = 0;
  const cookie = { name: 'sid', value: 'same', domain: '.example.com', session: true, path: '/' };
  chrome.runtime = {};
  chrome.cookies = {
    getAll: async () => [{ ...cookie, storeId: '0' }],
    set: (_details, callback) => callback({}),
  };
  const tabList = () => [
    { id: 1, url: `${WWW}/` },
    { id: 2, url: `${APP}/` },
  ];
  chrome.tabs = {
    query: async (_query, callback) => {
      const tabs = tabList();
      if (typeof callback === 'function') callback(tabs);
      return tabs;
    },
    sendMessage: async (id, message) => {
      if (message.type === 'GetPageStorage') {
        // Tab 1 already has the www value; tab 2 holds an older app value.
        return {
          isOk: true,
          result: {
            origin: message.payload.origin,
            localStorageItems: id === 1 ? [{ key: 'token', value: 'www' }] : [{ key: 'token', value: 'stale' }],
            sessionStorageItems: id === 1 ? [] : [{ key: 'ss', value: 'stale' }],
          },
        };
      }
      if (message.type === 'SetPageStorage') {
        writes.push({ id, payload: message.payload });
        return { isOk: true };
      }
      return { isOk: true, result: [] };
    },
    reload: () => {
      reloads++;
    },
  };
  const settingsStorage = require('@sync-your-cookie/storage/lib/settingsStorage').settingsStorage;
  const domainConfigStorage = require('@sync-your-cookie/storage/lib/domainConfigStorage').domainConfigStorage;
  await settingsStorage.update({ includeLocalStorage: true, includeSessionStorage: false });
  await domainConfigStorage.updateItem('example.com', { includeSessionStorage: true });

  await pullAndSetCookies(`${WWW}/`, 'example.com', true, {
    domainCookieMap: {
      'example.com': {
        cookies: [cookie],
        localStorageItems: [
          { key: 'token', value: 'www', origin: WWW },
          { key: 'token', value: 'app', origin: APP },
        ],
        sessionStorageItems: [{ key: 'ss', value: 'fresh', origin: APP }],
        updateTime: 999,
      },
    },
  });

  assert.deepEqual(
    writes.map(write => write.id),
    [2],
    'the unchanged www tab must not be written again',
  );
  assert.deepEqual(writes[0].payload.localStorageItems, [{ key: 'token', value: 'app', origin: APP }]);
  assert.deepEqual(writes[0].payload.sessionStorageItems, [{ key: 'ss', value: 'fresh', origin: APP }]);
  assert.equal(reloads, 1, 'session storage only takes effect after a reload');
});
