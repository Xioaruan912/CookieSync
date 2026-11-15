import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

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

const { accountStorage } = await import('@sync-your-cookie/storage/lib/accountStorage');
const { webdavStorage } = await import('@sync-your-cookie/storage/lib/webdavStorage');
const { settingsStorage } = await import('@sync-your-cookie/storage/lib/settingsStorage');
const sync = await import('../lib/cookie/withCloudflare.ts');
const { GithubApi } = await import('../lib/github/api.ts');
const { isBase64Encrypted } = await import('@sync-your-cookie/protobuf');

test('provider integration: domain merge, batch auto-push, encryption, malformed data, delete and backend routing', async () => {
  let content = '';
  let etag = 0;
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    if (req.url.includes('/client/v4/')) {
      if (req.method === 'GET') res.writeHead(200).end('{"domainCookieMap":{}}');
      else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"success":true,"errors":[]}');
      return;
    }
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

    // Existing GitHub branch remains reachable and does not call WebDAV.
    await settingsStorage.update({
      protobufEncoding: false,
      encryptionEnabled: false,
      storageKey: 'key',
      storageKeyGistId: 'gist',
      storageKeyList: [{ value: 'key', label: 'key', rawUrl: 'https://gist.test/raw' }],
    });
    let gistWrite;
    GithubApi.instance = {
      fetchRawContent: async () => '{"domainCookieMap":{}}',
      updateGist: async (...args) => {
        gistWrite = args;
        return { status: 200 };
      },
    };
    const before = calls;
    assert.deepEqual(await sync.readCookiesMap({ selectedProvider: 'github' }), { domainCookieMap: {} });
    await sync.writeCookiesMap({ selectedProvider: 'github' }, { domainCookieMap: {} });
    assert.equal(gistWrite[0], 'gist');
    assert.equal(calls, before);
    // Route Cloudflare requests to the same local server for real HTTP verification.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, options) =>
      realFetch(String(url).replace('https://api.cloudflare.com', config.url.replace('/dav/', '')), options);
    try {
      const cloudflare = { selectedProvider: 'cloudflare', accountId: 'id', namespaceId: 'ns', token: 'token' };
      assert.deepEqual(await sync.readCookiesMap(cloudflare), { domainCookieMap: {} });
      assert.equal((await sync.writeCookiesMap(cloudflare, {})).success, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('remote write suppression is scoped to one site and ends after restoration', async () => {
  const { pullAndSetCookies, isApplyingRemoteState } = await import('../lib/cookie/withStorage.ts');
  chrome.runtime = {};
  chrome.tabs = { query: async () => [] };
  chrome.cookies = { set: (details, callback) => setTimeout(() => callback(details), 50) };
  const restoring = pullAndSetCookies('https://www.douyin.com/', 'douyin.com', false, {
    domainCookieMap: {
      'douyin.com': { cookies: [{ name: 'session', value: 'dummy', domain: '.douyin.com', session: true, path: '/' }] },
    },
  });
  assert.ok(isApplyingRemoteState('douyin.com'));
  assert.ok(isApplyingRemoteState('www.douyin.com'));
  assert.ok(!isApplyingRemoteState('115.com'));
  await restoring;
  assert.ok(!isApplyingRemoteState('douyin.com'));
});
