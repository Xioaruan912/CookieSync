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
    assert.ok(init.body.includes('CookieSync-preferences-v2.json'));
    if (rejectWrite) return reply('', 503);
    assert.ok(!init.body.includes('CookieSync-cookies-v1.txt'));
    remote = init.body.split('Content-Type: text/plain; charset=UTF-8\r\n\r\n')[1].split('\r\n--cookiesync_')[0];
    writes++;
    return reply({ id: 'sites' });
  }
  assert.notEqual(init.method, 'PATCH');
  if (url.includes('alt=media')) {
    if (onRead) {
      const action = onRead;
      onRead = undefined;
      await action();
    }
    return reply(remote);
  }
  assert.ok(decodeURIComponent(url).includes('CookieSync-sites-v1.json'));
  return reply({ files: remote ? [{ id: 'sites', name: 'CookieSync-preferences-v2.json' }] : [] });
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
  await assert.rejects(syncSitePolicy(), /网站名单与扩展设置.*503/);
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

test('simultaneous configuration appends without ETags converge across pages and retries', async () => {
  const { openDriveConfiguration } = require('../lib/drive/api.ts');
  const { editDrivePreference, mergePreferences } = require('../../storage/lib/drivePreferences.ts');
  const { themeStorage } = require('../../storage/lib/themeStorage.ts');
  const { settingsStorage } = require('../../storage/lib/settingsStorage.ts');
  await driveAccountStorage.set({ connected: true, userId: 'owner' });
  const files = [];
  const makeEntry = value => ({ value, updatedAt: 100, revision: 'a' });
  globalThis.fetch = async (url, init) => {
    if (url.includes('/about?')) return ownerResponse();
    if (init.method === 'POST') {
      const data = init.body.split('Content-Type: text/plain; charset=UTF-8\r\n\r\n')[1].split('\r\n--cookiesync_')[0];
      files.push(data);
      return reply({ id: String(files.length - 1) });
    }
    assert.equal(init.method, undefined);
    if (url.includes('alt=media')) return reply(files[Number(new URL(url).pathname.split('/').at(-1))]);
    const offset = Number(new URL(url).searchParams.get('pageToken') || 0);
    return reply({
      files: files
        .slice(offset, offset + 1)
        .map(() => ({ id: String(offset), name: 'CookieSync-preferences-v2.json', version: '1' })),
      nextPageToken: offset + 1 < files.length ? String(offset + 1) : undefined,
    });
  };
  function ownerResponse() {
    return reply({ user: { permissionId: 'owner' } });
  }
  const [a, b] = await Promise.all([openDriveConfiguration(), openDriveConfiguration()]);
  const prefsA = { theme: makeEntry('dark') };
  const prefsB = { contextMenu: makeEntry(true) };
  await Promise.all([
    a.append(
      JSON.stringify({
        version: 2,
        rules: { 'a.example': { enabled: false, updatedAt: 100, revision: 'a' } },
        preferences: prefsA,
      }),
    ),
    b.append(
      JSON.stringify({
        version: 2,
        rules: { 'b.example': { enabled: true, updatedAt: 100, revision: 'b' } },
        preferences: prefsB,
      }),
    ),
  ]);
  await editDrivePreference('syncIntervalMinutes', 7);
  await settingsStorage.update({ encryptionPassword: 'private-test-only' });
  await syncSitePolicy();
  const merged = JSON.parse(files.at(-1));
  assert.ok(merged.rules['a.example'] && merged.rules['b.example']);
  assert.equal(await themeStorage.get(), 'dark');
  assert.equal((await settingsStorage.get()).contextMenu, true);
  assert.equal(merged.preferences.syncIntervalMinutes.value, 7);
  assert.ok(files.every(file => !file.includes('private-test-only')));
  assert.equal(files.length, 3);
  await syncSitePolicy();
  assert.equal(files.length, 3);
  const concurrent = { theme: { ...makeEntry('light'), revision: 'b' } };
  assert.deepEqual(mergePreferences(prefsA, concurrent), mergePreferences(concurrent, prefsA));
  assert.equal(mergePreferences(prefsA, concurrent).theme.value, 'light');
});
