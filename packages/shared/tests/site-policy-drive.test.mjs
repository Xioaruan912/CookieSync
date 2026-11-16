import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function area() {
  const data = {},
    listeners = [];
  return {
    data,
    get: async keys =>
      Object.fromEntries(
        (keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]]),
      ),
    set: async values => {
      Object.assign(data, values);
      for (const fn of listeners)
        await fn(Object.fromEntries(Object.entries(values).map(([k, newValue]) => [k, { newValue }])));
    },
    onChanged: { addListener: fn => listeners.push(fn) },
  };
}
globalThis.chrome = {
  storage: { local: area(), sync: area(), session: area() },
  runtime: { getManifest: () => ({ oauth2: { client_id: 'fixture' } }) },
  identity: {
    getAuthToken: (details, done) => {
      assert.equal(details.interactive, false);
      done('synthetic-token');
    },
    removeCachedAuthToken: async () => {},
  },
};
const { driveAccountStorage } = require('../../storage/lib/driveStorage.ts');
const { sitePolicyStorage } = require('../../storage/lib/sitePolicyStorage.ts');
const { siteRulePrefix } = require('../../storage/lib/commonSites.ts');
const { syncSitePolicy } = require('../lib/drive/sitePolicy.ts');
let remote = '',
  writes = 0,
  rejectWrite = false,
  onRead;
const reply = (v, status = 200, headers = {}) =>
  new Response(typeof v === 'string' ? v : JSON.stringify(v), { status, headers });
globalThis.fetch = async (url, init) => {
  if (url.includes('/about?')) return reply({ user: { permissionId: 'owner' } });
  if (init.method === 'POST') {
    assert.ok(init.body.includes('CookieSync-sites-v1.json'));
    assert.ok(!init.body.includes('CookieSync-cookies-v1.txt'));
    remote = init.body.split('Content-Type: text/plain; charset=UTF-8\r\n\r\n')[1].split('\r\n--cookiesync_')[0];
    writes++;
    return reply({ id: 'sites' });
  }
  if (init.method === 'PATCH') {
    assert.equal(new Headers(init.headers).get('If-Match'), '"policy1"');
    if (rejectWrite) return reply('', 412);
    remote = init.body;
    writes++;
    return reply({ id: 'sites' });
  }
  if (url.includes('alt=media')) {
    if (onRead) {
      const action = onRead;
      onRead = undefined;
      await action();
    }
    return reply(remote, 200, { etag: '"policy1"' });
  }
  assert.ok(decodeURIComponent(url).includes('CookieSync-sites-v1.json'));
  return reply({ files: remote ? [{ id: 'sites' }] : [] });
};

test('Drive policy is separate, merges across devices, retains opt-outs, skips unchanged writes and preserves in-flight edits', async () => {
  await driveAccountStorage.set({ connected: true, userId: 'owner' });
  await sitePolicyStorage.setRule('nodeseek.com', false);
  await sitePolicyStorage.setRule('custom.example', true);
  await syncSitePolicy();
  assert.equal(writes, 1);
  assert.equal(JSON.parse(remote).rules['nodeseek.com'].enabled, false);
  await syncSitePolicy();
  assert.equal(writes, 1);
  // An independent browser has no local rules, but adopts Drive opt-outs before discovery.
  for (const key of Object.keys(chrome.storage.sync.data)) delete chrome.storage.sync.data[key];
  await syncSitePolicy();
  assert.equal((await sitePolicyStorage.get())['nodeseek.com'].enabled, false);
  assert.equal(writes, 1);
  // Two devices changed different domains; a third edit occurs while the network read is in flight.
  const cloud = JSON.parse(remote);
  cloud.rules['cloud-only.example'] = { enabled: true, updatedAt: 1, revision: 'cloud' };
  remote = JSON.stringify(cloud);
  await sitePolicyStorage.setRule('local-only.example', true);
  onRead = () => sitePolicyStorage.setRule('inflight.example', true);
  await syncSitePolicy();
  assert.deepEqual(Object.keys(JSON.parse(remote).rules).sort(), [
    'cloud-only.example',
    'custom.example',
    'inflight.example',
    'local-only.example',
    'nodeseek.com',
  ]);
  assert.equal(writes, 2);
  assert.ok(!remote.includes('synthetic-token'));
  rejectWrite = true;
  await sitePolicyStorage.setRule('retry.example', true);
  await assert.rejects(syncSitePolicy(), /冲突/);
  assert.equal((await sitePolicyStorage.get())['retry.example'].enabled, true);
  rejectWrite = false;
  await syncSitePolicy();
  assert.equal(JSON.parse(remote).rules['retry.example'].enabled, true);
});

test('malformed policy or account change does not overwrite local preferences', async () => {
  const before = JSON.stringify(await sitePolicyStorage.get());
  remote = '{"version":2,"rules":{}}';
  await assert.rejects(syncSitePolicy(), /格式/);
  assert.equal(JSON.stringify(await sitePolicyStorage.get()), before);
  remote = JSON.stringify({ version: 1, rules: { 'remote.example': { enabled: false, updatedAt: 1, revision: 'x' } } });
  onRead = () => driveAccountStorage.set({ connected: true, userId: 'other' });
  await assert.rejects(syncSitePolicy(), /账号已变化/);
  assert.equal(JSON.stringify(await sitePolicyStorage.get()), before);
  assert.ok(Object.keys(chrome.storage.sync.data).every(k => k.startsWith(siteRulePrefix)));
});
