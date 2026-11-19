import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
// Keep mutable dependency singletons in one loader graph on Node 20 and newer.
const require = createRequire(import.meta.url);

function storageArea() {
  const data = {};
  const listeners = [];
  return {
    data,
    get: async keys => Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]])),
    set: async values => {
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]),
      );
      Object.assign(data, values);
      for (const listener of listeners) await listener(changes);
    },
    onChanged: { addListener: listener => listeners.push(listener) },
    setAccessLevel: async () => {},
  };
}
globalThis.chrome = { storage: { sync: storageArea(), local: storageArea(), session: storageArea() } };

const { accountStorage } = require('@sync-your-cookie/storage/lib/accountStorage');
const { webdavStorage } = require('@sync-your-cookie/storage/lib/webdavStorage');
const { settingsStorage } = require('@sync-your-cookie/storage/lib/settingsStorage');
const sync = require('../lib/cookie/withRemote.ts');
const { isBase64Encrypted } = require('@sync-your-cookie/protobuf');

test('webdav integration: domain merge, batch auto-push, encryption, malformed data, delete and newer-wins', async () => {
  let content = '';
  let etag = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(content ? 200 : 404, { ETag: `"${etag}"` }).end(content);
      return;
    }
    if (req.headers['if-match'] && req.headers['if-match'] !== `"${etag}"`) {
      res.writeHead(412).end();
      return;
    }
    content = '';
    for await (const chunk of req) content += chunk;
    etag++;
    res.writeHead(204).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    url: `http://127.0.0.1:${server.address().port}/dav/`,
    username: 'test',
    password: 'app-password',
    path: 'cookies.txt',
  };
  const account = { selectedProvider: 'webdav' };
  try {
    await webdavStorage.update(config);
    await accountStorage.update(account);
    assert.equal(chrome.storage.local.data['webdav-local-settings'].password, 'app-password');
    assert.ok(!('webdav-local-settings' in chrome.storage.sync.data));
    await settingsStorage.update({ protobufEncoding: false, encryptionEnabled: false });
    let old = await sync.readCookiesMap(account);
    await sync.mergeAndWriteCookies(
      account,
      'a.example',
      [{ name: 'session', value: 'A', domain: '.a.example', path: '/' }],
      [],
      '',
      old,
    );
    old = await sync.readCookiesMap(account);
    await sync.mergeAndWriteCookies(
      account,
      'b.example',
      [{ name: 'session', value: 'B', domain: '.b.example', path: '/' }],
      [{ key: 'token', value: 'B' }],
      '',
      old,
    );
    let data = await sync.readCookiesMap(account);
    assert.deepEqual(Object.keys(data.domainCookieMap).sort(), ['a.example', 'b.example']);
    assert.equal(data.domainCookieMap['a.example'].cookies[0].value, 'A');
    await sync.mergeAndWriteMultipleDomainCookies(
      account,
      [{ domain: 'a.example', cookies: [{ name: 'session', value: 'new A' }], localStorageItems: [] }],
      data,
    );
    data = await sync.readCookiesMap(account);
    assert.equal(data.domainCookieMap['a.example'].cookies[0].value, 'new A');
    assert.equal(data.domainCookieMap['b.example'].localStorageItems[0].value, 'B');
    await settingsStorage.update({
      protobufEncoding: true,
      encryptionEnabled: true,
      encryptionPassword: 'long test passphrase',
    });
    await sync.writeCookiesMap(account, data);
    assert.ok(isBase64Encrypted(content));
    assert.ok(!content.includes('new A'));
    assert.equal((await sync.readCookiesMap(account)).domainCookieMap['a.example'].cookies[0].value, 'new A');
    await settingsStorage.update({ encryptionPassword: 'wrong' });
    await assert.rejects(sync.readCookiesMap(account), error => error.code === 'DecryptFailed');
    await settingsStorage.update({ encryptionPassword: 'long test passphrase' });
    data = await sync.readCookiesMap(account);
    await sync.removeAndWriteCookies(account, 'a.example', data);
    assert.ok(!(await sync.readCookiesMap(account)).domainCookieMap['a.example']);
    // A second read must not replace the version token attached to an older map.
    const stale = await sync.readCookiesMap(account);
    const latest = await sync.readCookiesMap(account);
    await sync.mergeAndWriteCookies(account, 'remote.example', [{ name: 'other', value: 'remote' }], [], '', latest);
    await sync.readCookiesMap(account);
    await assert.rejects(sync.mergeAndWriteCookies(account, 'stale.example', [], [], '', stale), /冲突/);
    assert.ok((await sync.readCookiesMap(account)).domainCookieMap['remote.example']);
    const encrypted = content;
    await settingsStorage.update({ encryptionPassword: '' });
    await settingsStorage.update({ encryptionPassword: '' });
    await assert.rejects(sync.writeCookiesMap(account, {}), /拒绝明文上传/);
    assert.equal(content, encrypted);
    content = '<html>login required</html>';
    await assert.rejects(sync.readCookiesMap(account), error => error.code === 'DecodeFailed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('remote write suppression is scoped to one site and ends after restoration', async () => {
  const { pullAndSetCookies, isApplyingRemoteState } = require('../lib/cookie/withStorage.ts');
  chrome.runtime = {};
  chrome.tabs = { query: async () => [] };
  chrome.cookies = { getAll: async () => [], set: (details, callback) => setTimeout(() => callback(details), 50) };
  const restoring = pullAndSetCookies('https://www.douyin.com/', 'douyin.com', false, {
    domainCookieMap: {
      'douyin.com': { cookies: [{ name: 'session', value: 'dummy', domain: '.douyin.com', session: true, path: '/' }] },
    },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(isApplyingRemoteState('douyin.com'));
  assert.ok(isApplyingRemoteState('www.douyin.com'));
  assert.ok(!isApplyingRemoteState('115.com'));
  await restoring;
  assert.ok(!isApplyingRemoteState('douyin.com'));
});

test('manual push and background push serialize and retain both domains', async () => {
  const { pushCookies, pushMultipleDomainCookies } = require('../lib/cookie/withStorage.ts');
  const { domainStatusStorage } = require('@sync-your-cookie/storage/lib/domainStatusStorage');
  await domainStatusStorage.resetState();
  await settingsStorage.update({ protobufEncoding: false, encryptionEnabled: false });
  let data = { domainCookieMap: {} };
  let version = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { ETag: `"${version}"` }).end(JSON.stringify(data));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    await new Promise(resolve => setTimeout(resolve, 80));
    if (req.headers['if-match'] !== `"${version}"`) {
      res.writeHead(412).end();
      return;
    }
    data = JSON.parse(body);
    version++;
    res.writeHead(204).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await webdavStorage.update({
      url: `http://127.0.0.1:${server.address().port}/`,
      username: 'test',
      password: 'test',
      path: 'cookies.txt',
    });
    await accountStorage.update({ selectedProvider: 'webdav' });
    const results = await Promise.all([
      pushCookies('xiaohongshu.com', [{ name: 'session', value: 'A', domain: '.xiaohongshu.com', session: true }], []),
      pushMultipleDomainCookies([
        {
          domain: '115.com',
          cookies: [{ name: 'session', value: 'B', domain: '.115.com', session: true }],
          localStorageItems: [],
        },
      ]),
    ]);
    assert.ok(results.every(result => result.success));
    assert.deepEqual(Object.keys(data.domainCookieMap).sort(), ['115.com', 'xiaohongshu.com']);
    const before = version;
    await pushCookies(
      'xiaohongshu.com',
      [{ name: 'session', value: 'A', domain: '.xiaohongshu.com', session: true }],
      [],
    );
    assert.equal(version, before, 'same plaintext content must not PUT again');
    const { domainContentHash } = require('../lib/cookie/fingerprint.ts');
    const baseHash = await domainContentHash(data.domainCookieMap['xiaohongshu.com']);
    data.domainCookieMap['xiaohongshu.com'].cookies[0].value = 'REMOTE';
    version++;

    // A legacy pending job without capturedAt still requires manual confirmation.
    await assert.rejects(
      pushMultipleDomainCookies([
        {
          domain: 'xiaohongshu.com',
          cookies: [{ name: 'session', value: 'LOCAL', domain: '.xiaohongshu.com', session: true }],
          localStorageItems: [],
          baseHash,
        },
      ]),
      /两端数据均已变化/,
    );
    assert.equal(data.domainCookieMap['xiaohongshu.com'].cookies[0].value, 'REMOTE');

    // Newer wins: a remote write newer than the local capture keeps the cloud copy.
    data.domainCookieMap['xiaohongshu.com'].updateTime = Date.now() + 60000;
    version++;
    const cloudNewer = await pushMultipleDomainCookies([
      {
        domain: 'xiaohongshu.com',
        cookies: [{ name: 'session', value: 'LOCAL', domain: '.xiaohongshu.com', session: true }],
        localStorageItems: [],
        baseHash,
        capturedAt: Date.now(),
      },
    ]);
    assert.ok(cloudNewer.success);
    assert.deepEqual(cloudNewer.adopted.map(item => item.domain), ['xiaohongshu.com']);
    assert.equal(data.domainCookieMap['xiaohongshu.com'].cookies[0].value, 'REMOTE');

    // A local capture newer than the remote write overwrites the cloud copy.
    const localNewer = await pushMultipleDomainCookies([
      {
        domain: 'xiaohongshu.com',
        cookies: [{ name: 'session', value: 'LOCAL', domain: '.xiaohongshu.com', session: true }],
        localStorageItems: [],
        baseHash,
        capturedAt: Date.now() + 120000,
      },
    ]);
    assert.ok(localNewer.success);
    assert.deepEqual(localNewer.adopted, []);
    assert.equal(data.domainCookieMap['xiaohongshu.com'].cookies[0].value, 'LOCAL');

    let fresh = await sync.readCookiesMap({ selectedProvider: 'webdav' });
    const oldCookie = { ...fresh.domainCookieMap['xiaohongshu.com'].cookies[0] };
    await sync.editAndWriteCookies({ selectedProvider: 'webdav' }, 'xiaohongshu.com', fresh, oldCookie, {
      ...oldCookie,
      value: 'EDITED',
    });
    assert.equal(
      data.domainCookieMap['xiaohongshu.com'].cookies[0].value,
      'EDITED',
      'single-cookie edit must not become a false no-op',
    );
    fresh = await sync.readCookiesMap({ selectedProvider: 'webdav' });
    await sync.removeAndWriteCookies(
      { selectedProvider: 'webdav' },
      'xiaohongshu.com',
      fresh,
      '.xiaohongshu.com_session',
    );
    assert.equal(data.domainCookieMap['xiaohongshu.com'].cookies.length, 0);

    data = {};
    const { pullCookies } = require('../lib/cookie/withStorage.ts');
    const refreshed = await pullCookies();
    assert.equal(
      Object.keys(refreshed.domainCookieMap || {}).length,
      0,
      'an empty remote must replace stale manager entries',
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('unchanged restored content does not set cookies, write localStorage or reload tabs', async () => {
  const { pullAndSetCookies } = require('../lib/cookie/withStorage.ts');
  let writes = 0,
    reloads = 0;
  const cookie = { name: 'sid', value: 'same', domain: '.115.com', session: true, path: '/' };
  chrome.runtime = {};
  chrome.cookies = {
    getAll: async () => [{ ...cookie, storeId: '0' }],
    set: (_details, callback) => {
      writes++;
      callback({});
    },
  };
  chrome.tabs = {
    query: async () => [{ id: 7, url: 'https://www.115.com/' }],
    sendMessage: async (_id, message) => {
      if (message.type === 'GetLocalStorage') return { isOk: true, result: [{ key: 'token', value: 'same' }] };
      writes++;
      return { isOk: true };
    },
    reload: () => {
      reloads++;
    },
  };
  await settingsStorage.update({ includeLocalStorage: true });
  await pullAndSetCookies('https://www.115.com/', '115.com', true, {
    domainCookieMap: {
      '115.com': { cookies: [cookie], localStorageItems: [{ key: 'token', value: 'same' }], updateTime: 999 },
    },
  });
  assert.equal(writes, 0);
  assert.equal(reloads, 0);
});

test('site auto defaults are enabled and explicit user switches remain respected', async () => {
  const { domainConfigStorage } = require('@sync-your-cookie/storage/lib/domainConfigStorage');
  await domainConfigStorage.ensureDefaults();
  for (const host of ['xiaohongshu.com', 'douyin.com', '115.com']) {
    const item = (await domainConfigStorage.get()).domainMap[host];
    assert.equal(item.autoPush, true);
    assert.equal(item.autoPull, true);
  }
  await domainConfigStorage.toggleAutoPushState('115.com');
  assert.equal((await domainConfigStorage.get()).domainMap['115.com'].autoPush, false);
  await domainConfigStorage.ensureDefaults();
  assert.equal((await domainConfigStorage.get()).domainMap['115.com'].autoPush, false);
});

test('manual confirmation clears only the original pending revision and preserves later changes', async () => {
  const {
    syncDestinationKey,
    editSyncJobs,
    getPendingRevision,
    settleManualSync,
  } = require('../lib/cookie/syncIdentity.ts');
  const key = await syncDestinationKey();
  await editSyncJobs(key, () => ({ '115.com': { domain: '115.com', revision: 'old', baseHash: 'A' } }));
  const revision = await getPendingRevision('115.com');
  await editSyncJobs(key, () => ({ '115.com': { domain: '115.com', revision: 'new', baseHash: 'A' } }));
  await settleManualSync('115.com', revision, 'B');
  const retained = chrome.storage.local.data[key]['115.com'];
  assert.equal(retained.revision, 'new');
  assert.equal(retained.baseHash, 'B');
  await settleManualSync('115.com', 'new', 'C');
  assert.equal(await getPendingRevision('115.com'), undefined);
});
