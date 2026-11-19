import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function storageArea() {
  const data = {};
  const listeners = [];
  return {
    data,
    get: async keys =>
      Object.fromEntries(
        (keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]]),
      ),
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
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'fixture' } });

const { settingsStorage } = require('@sync-your-cookie/storage/lib/settingsStorage');
const { webdavStorage } = require('@sync-your-cookie/storage/lib/webdavStorage');
const { sitePolicyStorage } = require('@sync-your-cookie/storage/lib/sitePolicyStorage');
const {
  syncWebdavConfig,
  webdavConfigPath,
  webdavConfigFileName,
} = require('../lib/webdav/configSync.ts');

let files = {};
let etags = {};
let writes = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const name = decodeURIComponent(url.pathname.split('/').pop());
  if (req.method === 'GET') {
    if (!files[name]) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { ETag: `"${etags[name]}"` }).end(files[name]);
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.headers['if-match'] && req.headers['if-match'] !== `"${etags[name] || 0}"`) {
    res.writeHead(412).end();
    return;
  }
  files[name] = body;
  etags[name] = (etags[name] || 0) + 1;
  writes++;
  res.writeHead(204).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const davConfig = {
  url: `http://127.0.0.1:${server.address().port}/dav/`,
  username: 'test',
  password: 'test',
  path: 'CookieSync/cookies.txt',
};

test('config path sits beside the cookie file', () => {
  assert.equal(webdavConfigPath('CookieSync/cookies.txt'), `CookieSync/${webdavConfigFileName}`);
  assert.equal(webdavConfigPath('cookies.txt'), webdavConfigFileName);
});

test('config sync is a no-op unless the webdav channel is selected', async () => {
  await settingsStorage.update({ configChannel: 'chrome-sync' });
  await webdavStorage.update(davConfig);
  await syncWebdavConfig();
  assert.equal(writes, 0);
  await settingsStorage.update({ configChannel: 'off' });
  await syncWebdavConfig();
  assert.equal(writes, 0);
});

test('webdav channel merges remote rules and preferences and writes back the union', async () => {
  files = {};
  etags = {};
  writes = 0;
  await settingsStorage.update({ configChannel: 'webdav' });
  // A local-only rule forces the union to differ from the remote snapshot.
  await sitePolicyStorage.setRule('local.example', true);
  files[webdavConfigFileName] = JSON.stringify({
    version: 1,
    rules: { 'remote.example': { enabled: true, updatedAt: 2, revision: 'remote' } },
    preferences: { syncIntervalMinutes: { value: 15, updatedAt: 2, revision: 'remote' } },
  });
  etags[webdavConfigFileName] = 1;
  await syncWebdavConfig();
  assert.equal(writes, 1, 'merged local rules must be written back');
  const merged = JSON.parse(files[webdavConfigFileName]);
  assert.equal(merged.version, 1);
  assert.ok(merged.rules['remote.example']?.enabled);
  assert.ok(merged.rules['local.example']?.enabled, 'local-only rules must survive the merge');
  assert.equal(merged.preferences.syncIntervalMinutes.value, 15);
  // Local rules gain the remote entry.
  const { readSiteRules } = require('@sync-your-cookie/storage/lib/sitePolicyStorage');
  assert.equal((await readSiteRules())['remote.example']?.enabled, true);
  // A second run with identical content is silent.
  await syncWebdavConfig();
  assert.equal(writes, 1);
});

test('malformed remote config is rejected without touching local settings', async () => {
  files[webdavConfigFileName] = '{"version":2}';
  etags[webdavConfigFileName] = 99;
  await assert.rejects(syncWebdavConfig(), /格式错误|过大/);
});

test('missing destination credentials keep the channel silent', async () => {
  await webdavStorage.update({ url: '', username: '', password: '', path: 'cookies.txt' });
  const previousWrites = writes;
  await syncWebdavConfig();
  assert.equal(writes, previousWrites);
  await webdavStorage.update(davConfig);
});

test('after suite', async () => {
  await new Promise(resolve => server.close(resolve));
});
