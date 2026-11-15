import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function area() {
  const data = {};
  const listeners = [];
  return {
    data,
    get: async keys => Object.fromEntries(keys.map(k => [k, data[k]])),
    set: async values => {
      Object.assign(data, values);
      for (const listener of listeners)
        await listener(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])));
    },
    onChanged: { addListener: listener => listeners.push(listener) },
  };
}
let authCalls = [],
  removed = 0,
  sequence = [],
  configured = true;
globalThis.chrome = {
  storage: { local: area(), sync: area(), session: area() },
  runtime: {
    getManifest: () => ({ oauth2: configured ? { client_id: 'fixture.apps.googleusercontent.com' } : undefined }),
  },
  identity: {
    getAuthToken: (details, done) => {
      authCalls.push(details);
      done('fixture-token');
    },
    removeCachedAuthToken: async () => {
      removed++;
    },
    clearAllCachedAuthTokens: async () => {},
  },
};
const { driveAccountStorage } = require('@sync-your-cookie/storage/lib/driveStorage');
const { webdavStorage, webdavCloudStorage } = require('@sync-your-cookie/storage/lib/webdavStorage');
const drive = require('../lib/drive/api.ts');
function reply(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}
const owner = () => reply({ user: { permissionId: 'owner', emailAddress: 'fixture@example.test' } });
globalThis.fetch = async (url, init) => {
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-token');
  assert.ok(url.startsWith('https://www.googleapis.com/'));
  assert.ok(sequence.length, `Unexpected request ${url}`);
  return sequence.shift()(url, init);
};

test('Drive first connection is interactive; background reads, conditional writes and refresh stay silent', async () => {
  sequence = [owner];
  await drive.connectDrive();
  assert.equal(authCalls[0].interactive, true);
  sequence = [owner, () => reply({ files: [] })];
  const empty = await drive.readDrive();
  assert.equal(empty.content, '');
  sequence = [
    owner,
    () => reply({ files: [] }),
    (url, init) => {
      assert.equal(init.method, 'POST');
      assert.match(init.body, /appDataFolder/);
      assert.match(init.body, /encrypted-fixture/);
      return reply({ id: 'file' });
    },
    () => reply({ files: [{ id: 'file' }] }),
  ];
  assert.equal((await drive.writeDrive('encrypted-fixture', empty)).success, true);
  sequence = [owner, () => reply({ files: [{ id: 'file' }] }), () => reply('old', 200, { etag: '"v1"' })];
  const snapshot = await drive.readDrive();
  sequence = [
    owner,
    () => reply({ files: [{ id: 'file' }] }),
    (url, init) => {
      assert.equal(init.method, 'PATCH');
      assert.equal(new Headers(init.headers).get('If-Match'), '"v1"');
      return reply('', 412);
    },
  ];
  await assert.rejects(drive.writeDrive('new', snapshot), /冲突/);
  sequence = [() => reply('', 401), owner, owner, () => reply({ files: [] })];
  await drive.readDrive();
  assert.equal(removed, 1);
  assert.ok(authCalls.slice(1).every(x => x.interactive === false));
  assert.ok(authCalls.every(x => x.scopes.length === 1 && x.scopes[0] === drive.driveScope));
  assert.equal(JSON.stringify(chrome.storage.local.data).includes('fixture-token'), false);
  sequence = [owner, () => reply({ files: [{ id: 'file' }] })];
  await assert.rejects(drive.writeDrive('new', { ...snapshot, etag: undefined }), /ETag/);
  for (const connected of [true, false]) {
    await driveAccountStorage.set({ connected: true, userId: 'owner' });
    sequence = [
      owner,
      () => reply({ files: [] }),
      async () => {
        await driveAccountStorage.set({ connected, userId: connected ? 'another' : undefined });
        return reply('', 401);
      },
      () => reply({ user: { permissionId: connected ? 'another' : 'owner' } }),
    ];
    await assert.rejects(drive.writeDrive('old-account-payload', empty), /账号已变化/);
    assert.equal(sequence.length, 0, '401 upload must not be replayed after reconnect/disconnect');
  }
  await driveAccountStorage.set({ connected: true, userId: 'owner' });
  sequence = [() => reply({ user: { permissionId: 'another' } })];
  await assert.rejects(drive.writeDrive('new', snapshot), /账号已变化/);
  sequence = [owner, () => reply({ files: [{ id: 'a' }, { id: 'b' }] })];
  await assert.rejects(drive.readDrive(), /多个/);
  configured = false;
  await assert.rejects(drive.connectDrive(), /维护者/);
  configured = true;
  await drive.disconnectDrive();
  assert.equal((await driveAccountStorage.get()).connected, false);
});

test('Drive provider uses existing encryption, merge and unchanged-data skips', async () => {
  const { accountStorage } = require('@sync-your-cookie/storage/lib/accountStorage');
  const { settingsStorage } = require('@sync-your-cookie/storage/lib/settingsStorage');
  const sync = require('../lib/cookie/withCloudflare.ts');
  const { isBase64Encrypted } = require('@sync-your-cookie/protobuf');
  let payload = '',
    writes = 0;
  globalThis.fetch = async (url, init) => {
    assert.ok(url.startsWith('https://www.googleapis.com/'));
    if (url.includes('/about?')) return owner();
    if (init.method === 'POST') {
      payload = init.body.split('Content-Type: text/plain; charset=UTF-8\r\n\r\n')[1].split('\r\n--cookiesync_')[0];
      writes++;
      return reply({ id: 'file' });
    }
    if (init.method === 'PATCH') {
      payload = init.body;
      writes++;
      return reply({ id: 'file' });
    }
    if (url.includes('alt=media')) return reply(payload, 200, { etag: '"v1"' });
    return reply({ files: payload ? [{ id: 'file' }] : [] });
  };
  await drive.connectDrive();
  const account = { selectedProvider: 'google-drive' };
  await accountStorage.update(account);
  await settingsStorage.update({
    protobufEncoding: true,
    encryptionEnabled: true,
    encryptionPassword: 'fixture encryption password',
  });
  let map = await sync.readCookiesMap(account);
  await sync.mergeAndWriteCookies(
    account,
    '115.com',
    [{ name: 'sid', value: 'private-fixture', domain: '.115.com', path: '/', session: true }],
    [],
    '',
    map,
  );
  assert.ok(isBase64Encrypted(payload));
  assert.equal(payload.includes('private-fixture'), false);
  map = await sync.readCookiesMap(account);
  assert.equal(map.domainCookieMap['115.com'].cookies[0].value, 'private-fixture');
  await sync.writeCookiesMap(account, map, map);
  assert.equal(writes, 1, 'unchanged plaintext does not upload again');
  await sync.mergeAndWriteCookies(
    account,
    'douyin.com',
    [{ name: 'sid', value: 'second', domain: '.douyin.com', path: '/', session: true }],
    [],
    '',
    map,
  );
  map = await sync.readCookiesMap(account);
  assert.deepEqual(Object.keys(map.domainCookieMap).sort(), ['115.com', 'douyin.com']);
});

test('WebDAV credentials stay local by default; opt-in sync restores remote settings and opt-out removes cloud credentials', async () => {
  const config = { url: 'https://dav.example.test/', username: 'fixture', password: 'app-pass', path: 'cookies.txt' };
  await webdavStorage.update(config);
  assert.equal((await webdavCloudStorage.get()).enabled, false);
  assert.equal(JSON.stringify(chrome.storage.sync.data).includes('app-pass'), false);
  await webdavStorage.update(config, true);
  assert.equal((await webdavCloudStorage.get()).settings.password, 'app-pass');
  const remote = { ...config, path: 'other-device.txt' };
  await chrome.storage.sync.set({ 'webdav-cloud-settings-v1': { enabled: true, settings: remote } });
  assert.equal((await webdavStorage.get()).path, 'other-device.txt');
  await webdavStorage.update(remote, false);
  assert.equal((await webdavCloudStorage.get()).settings, undefined);
  assert.equal((await webdavStorage.get()).password, 'app-pass');
});
