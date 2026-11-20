import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function area() {
  const data = {};
  const listeners = [];
  return {
    data,
    get: async keys =>
      Object.fromEntries(
        (keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys])
          .filter(key => key in data)
          .map(key => [key, data[key]]),
      ),
    set: async values => {
      Object.assign(data, values);
      for (const listener of listeners)
        await listener(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])));
    },
    remove: async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    onChanged: { addListener: listener => listeners.push(listener) },
    setAccessLevel: async () => {},
  };
}
globalThis.chrome = { storage: { local: area(), sync: area(), session: area() } };

const { rotateWebdavBackups, restoreBackup, backupStatus, backupIfDue, backupPath } = require('../lib/webdav/backup.ts');
const { trimSnapshots } = require('@sync-your-cookie/storage/lib/snapshotStorage');
const { buildDiagnostics } = require('../dist/index.js');

const config = { url: 'https://dav.example.com/dav/', username: 'u', password: 'p', path: 'cookies.txt' };
const store = new Map();
const calls = [];

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  const method = init.method || 'GET';
  calls.push(`${method} ${path}`);
  if (method === 'GET')
    return store.has(path)
      ? new Response(store.get(path), { status: 200, headers: { ETag: '"etag-fixture"' } })
      : new Response('', { status: 404 });
  if (method === 'PUT') {
    store.set(path, init.body);
    return new Response(null, { status: 201 });
  }
  return new Response(null, { status: 204 });
};

test('backup paths live beside the cookie file', () => {
  assert.equal(backupPath('CookieSync/cookies.txt', 2), 'CookieSync/cookies.txt.bak.2');
});

test('rotation shifts slots and keeps the newest content in slot 1', async () => {
  store.clear();
  calls.length = 0;
  store.set('/dav/cookies.txt.bak.1', 'A');
  store.set('/dav/cookies.txt.bak.2', 'B');
  await rotateWebdavBackups(config, 'NEW');
  assert.equal(store.get('/dav/cookies.txt.bak.1'), 'NEW');
  assert.equal(store.get('/dav/cookies.txt.bak.2'), 'A');
  assert.equal(store.get('/dav/cookies.txt.bak.3'), 'B');
  assert.ok(calls.some(call => call.startsWith('PUT /dav/cookies.txt.bak.1')));
});

test('restoring a backup rotates the live file so the restore can be undone', async () => {
  store.clear();
  store.set('/dav/cookies.txt', 'LIVE');
  store.set('/dav/cookies.txt.bak.1', 'ONE');
  store.set('/dav/cookies.txt.bak.2', 'TWO');
  const result = await restoreBackup(config, 2);
  assert.deepEqual(result, { slot: 2, bytes: 3 });
  assert.equal(store.get('/dav/cookies.txt'), 'TWO');
  assert.equal(store.get('/dav/cookies.txt.bak.1'), 'LIVE');
  await assert.rejects(restoreBackup(config, 9), /槽位无效/);
  store.clear();
  store.set('/dav/cookies.txt', 'LIVE');
  await assert.rejects(restoreBackup(config, 2), /没有内容/);
});

test('backup status reports which slots exist', async () => {
  store.clear();
  store.set('/dav/cookies.txt.bak.1', '12345');
  const status = await backupStatus(config);
  assert.deepEqual(status, [
    { slot: 1, exists: true, bytes: 5 },
    { slot: 2, exists: false, bytes: 0 },
    { slot: 3, exists: false, bytes: 0 },
  ]);
});

test('the daily backup runs at most once per interval', async () => {
  store.clear();
  chrome.storage.local.data['cookiesync-last-backup-at'] = Date.now();
  calls.length = 0;
  assert.equal(await backupIfDue(config, 'NEW'), false);
  assert.equal(calls.length, 0);
  delete chrome.storage.local.data['cookiesync-last-backup-at'];
  assert.equal(await backupIfDue(config, 'NEW'), true);
  assert.equal(store.get('/dav/cookies.txt.bak.1'), 'NEW');
});

test('snapshots keep the newest four and skip oversized entries', () => {
  const snap = (at, size = 0) => ({
    id: String(at),
    at,
    kind: 'local',
    reason: 'pull-all',
    sites: { 'a.example': { domain: 'a.example', cookies: [], localStorageItems: [], pad: 'x'.repeat(size) } },
  });
  const trimmed = trimSnapshots([snap(1), snap(5), snap(3), snap(2), snap(4)]);
  assert.deepEqual(
    trimmed.map(entry => entry.at),
    [5, 4, 3, 2],
  );
  const oversized = trimSnapshots([snap(9, 4 * 1024 * 1024), snap(1)]);
  assert.deepEqual(
    oversized.map(entry => entry.at),
    [1],
    'an oversized snapshot is skipped instead of evicting everything',
  );
});

test('diagnostics redact values and credentials', () => {
  const result = buildDiagnostics({
    version: '9.9.9',
    now: 1700000000000,
    platform: 'fixture-agent',
    settings: { includeIndexedDB: true, encryptionEnabled: true, configChannel: 'webdav' },
    destination: { origin: 'https://dav.example.com', path: 'cookies.txt' },
    connected: true,
    sites: [
      {
        domain: 'a.example',
        listed: true,
        cookies: [
          { name: 'sid', value: 'SUPERSECRET', domain: '.a.example', path: '/', secure: true },
        ],
        localStorageItems: [{ key: 'token', value: 'ALSO-SECRET', origin: 'https://a.example' }],
        sessionStorageItems: [{ key: 'ss', value: 'SESSION-SECRET', origin: 'https://a.example' }],
        indexedDBRecords: [
          { database: 'db', store: 'auth', key: '"k"', value: '"v"', origin: 'https://a.example' },
          { database: 'db', store: 'auth', key: '"k2"', value: '"v2"', origin: 'https://a.example' },
          { database: 'db', store: 'cache', key: '"k"', value: '"c"', origin: 'https://a.example' },
        ],
        health: { state: 'invalid', message: '请先登录' },
        pending: { cookies: 1, localStorageItems: 0, sessionStorageItems: 0, indexedDBRecords: 0 },
      },
    ],
  });
  const text = JSON.stringify(result);
  assert.ok(!text.includes('SUPERSECRET'));
  assert.ok(!text.includes('ALSO-SECRET'));
  assert.ok(!text.includes('SESSION-SECRET'));
  assert.ok(!text.includes('dummy-app-password'));
  const site = result.sites[0];
  assert.deepEqual(site.cookies[0].value, { length: 11, prefix: 'SU' });
  assert.deepEqual(site.localStorage[0].value, { length: 11, prefix: 'AL' });
  assert.deepEqual(
    site.indexedDB.map(group => [group.store, group.records]),
    [
      ['auth', 2],
      ['cache', 1],
    ],
  );
  assert.equal(result.connection.destination.origin, 'https://dav.example.com');
});
