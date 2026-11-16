import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (!globalThis.navigator)
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'synthetic-browser' } });
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const timer = originalTimeout(fn, ms, ...args);
  if (ms >= 60000) timer.unref();
  return timer;
};
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
      for (const listener of listeners)
        await listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])));
    },
    onChanged: { addListener: fn => listeners.push(fn) },
    setAccessLevel: async () => {},
  };
}
const events = () => {
  const listeners = [];
  return { listeners, addListener: fn => listeners.push(fn) };
};
const openTabs = [];
let pageLocalItems = [];
let payload = '',
  writes = 0,
  failRead = false,
  reads = 0;
const cookies = [{ name: 'sid', value: 'synthetic-login', domain: '.115.com', path: '/', session: true }];
globalThis.chrome = {
  storage: { local: area(), sync: area(), session: area() },
  runtime: {
    id: 'fixture',
    getURL: path => `chrome-extension://fixture/${path}`,
    getManifest: () => ({ oauth2: { client_id: 'fixture.apps.googleusercontent.com' } }),
    onStartup: events(),
    onMessage: events(),
  },
  identity: {
    getAuthToken: (details, callback) => {
      assert.equal(details.interactive, false);
      callback('fixture');
    },
    removeCachedAuthToken: async () => {},
  },
  cookies: {
    getAll: async ({ domain, url }) =>
      cookies.filter(c => {
        if (!domain && !url) return true;
        const host = c.domain.replace(/^\./, '');
        if (url) {
          const page = new URL(url);
          return (
            (page.hostname === host || (!c.hostOnly && page.hostname.endsWith('.' + host))) &&
            page.pathname.startsWith(c.path || '/')
          );
        }
        return host === domain || host.endsWith('.' + domain);
      }),
    set: (details, callback) => {
      const restored = {
        ...details,
        domain: details.domain || new URL(details.url).hostname,
        session: !details.expirationDate,
      };
      cookies.push(restored);
      callback(restored);
    },
    onChanged: events(),
  },
  tabs: { query: async () => openTabs, sendMessage: async () => ({ isOk: true, result: pageLocalItems }) },
  alarms: { get: async () => ({ periodInMinutes: 2 }), create: async () => {}, onAlarm: events() },
};
function reply(value, status = 200, headers = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers });
}
globalThis.fetch = async (url, init) => {
  if (url.includes('/about?')) reads++;
  if (failRead) return reply('', 503);
  if (url.includes('/about?')) return reply({ user: { permissionId: 'owner' } });
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
  if (url.includes('alt=media')) return reply(payload, 200, { etag: '"fixture"' });
  return reply({ files: payload ? [{ id: 'file' }] : [] });
};
const { accountStorage } = require('@sync-your-cookie/storage/lib/accountStorage');
const { driveAccountStorage } = require('@sync-your-cookie/storage/lib/driveStorage');
const { settingsStorage } = require('@sync-your-cookie/storage/lib/settingsStorage');
const { domainConfigStorage } = require('@sync-your-cookie/storage/lib/domainConfigStorage');
const { cookieStorage } = require('@sync-your-cookie/storage/lib/cookieStorage');
const { setSyncBaseline, domainContentHash } = require('../dist/index.js');
const automatic = require('../../../chrome-extension/lib/background/automaticSync.ts');

test('fresh Drive destination uploads existing cookies in its first automatic cycle and skips identical content', async () => {
  await accountStorage.update({ selectedProvider: 'google-drive' });
  await driveAccountStorage.set({ connected: true, userId: 'owner' });
  await settingsStorage.update({
    backgroundSync: true,
    startupPull: true,
    syncIntervalMinutes: 2,
    protobufEncoding: false,
    encryptionEnabled: false,
  });
  await domainConfigStorage.ensureDefaults();
  await automatic.restoreAtStartup(true);
  assert.equal(writes, 1, 'cloud-empty discovery must upload in the same cycle, not one interval later');
  assert.equal(JSON.parse(payload).domainCookieMap['115.com'].cookies[0].value, 'synthetic-login');
  await automatic.restoreAtStartup(true);
  assert.equal(writes, 1, 'same semantic hash must not upload');
});

test('push-only site bootstraps against an empty Drive without enabling auto pull', async () => {
  payload = '';
  writes = 0;
  for (const key of Object.keys(chrome.storage.local.data))
    if (key.startsWith('cookiesync-pending-')) delete chrome.storage.local.data[key];
  await domainConfigStorage.updateItem('115.com', { autoPush: true, autoPull: false });
  await automatic.restoreAtStartup(true);
  assert.equal(writes, 1, 'auto pull being disabled must not suppress first automatic push');
  assert.equal((await domainConfigStorage.get()).domainMap['115.com'].autoPull, false);
});

test('remote read errors become visible automatic status instead of silently disappearing', async () => {
  failRead = true;
  await automatic.restoreAtStartup(true);
  const status = chrome.storage.local.data['cookiesync-auto-status'];
  assert.match(status?.error || '', /503/);
  failRead = false;
});

test('session cookies missing at browser startup restore from cloud rather than uploading an empty logout', async () => {
  await domainConfigStorage.updateItem('115.com', { autoPush: true, autoPull: true });
  const previousPayload = payload,
    previousWrites = writes;
  cookies.splice(0);
  await automatic.restoreAtStartup(false);
  assert.equal(payload, previousPayload, 'passive empty discovery must not overwrite cloud sessions');
  assert.equal(writes, previousWrites);
  assert.ok(
    cookies.some(cookie => cookie.value === 'synthetic-login'),
    'startup must restore cloud session cookie',
  );
});

test('mixed persistent cookies and cached LocalStorage do not turn lost session cookies into a cloud logout', async () => {
  const session = { name: 'sid', value: 'synthetic-login', domain: '.115.com', path: '/', session: true };
  const persistent = {
    name: 'pref',
    value: 'kept',
    domain: '.115.com',
    path: '/',
    session: false,
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
  };
  const entry = { cookies: [session, persistent], localStorageItems: [{ key: 'fixture-token', value: 'cached' }] };
  const map = { domainCookieMap: { '115.com': entry } };
  payload = JSON.stringify(map);
  await cookieStorage.update(map, true);
  await setSyncBaseline('115.com', await domainContentHash(entry));
  const previousWrites = writes;
  for (const periodic of [false, true]) {
    cookies.splice(0);
    cookies.push(persistent);
    await automatic.restoreAtStartup(periodic);
    assert.equal(writes, previousWrites);
    assert.ok(
      cookies.some(cookie => cookie.name === 'sid'),
      'missing session must restore even if persistent cookie/LocalStorage remain',
    );
    assert.equal(JSON.parse(payload).domainCookieMap['115.com'].cookies.length, 2);
  }
});

test('an explicitly captured empty logout remains a durable job and can still sync', async () => {
  cookies.splice(0);
  await automatic.captureAutomaticSync('115.com', []);
  const previousWrites = writes;
  await automatic.restoreAtStartup(false);
  assert.equal(writes, previousWrites + 1);
  assert.deepEqual(JSON.parse(payload).domainCookieMap['115.com'].cookies, []);
  assert.deepEqual(JSON.parse(payload).domainCookieMap['115.com'].localStorageItems, []);
});

test('disabling background sync prevents startup from uploading an older pending job', async () => {
  cookies.push({ name: 'sid', value: 'queued-disabled', domain: '.115.com', path: '/', session: true });
  await automatic.captureAutomaticSync('115.com', []);
  await settingsStorage.update({ backgroundSync: false, startupPull: true });
  const previousWrites = writes;
  await automatic.restoreAtStartup(false);
  assert.equal(writes, previousWrites);
  assert.ok(
    Object.values(chrome.storage.local.data).some(value => value?.['115.com']?.revision),
    'disabled jobs must remain queued',
  );
  await settingsStorage.update({ backgroundSync: true });
});

test('explicit check waits for an in-flight cycle then performs its own fresh comparison', async () => {
  const previousReads = reads;
  await Promise.all([automatic.restoreAtStartup(true), automatic.restoreAtStartup(true, true)]);
  assert.ok(reads >= previousReads + 2, 'manual check must not just acknowledge an older running cycle');
});

test('connecting a backend starts discovery without restarting Chrome or waiting for an alarm', async () => {
  payload = '';
  writes = 0;
  for (const key of Object.keys(chrome.storage.local.data))
    if (key.startsWith('cookiesync-pending-')) delete chrome.storage.local.data[key];
  automatic.initAutomaticSync();
  await driveAccountStorage.set({ connected: true, userId: 'owner' });
  await accountStorage.update({ selectedProvider: 'google-drive' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && writes === 0) await new Promise(resolve => originalTimeout(resolve, 50));
  assert.equal(writes, 1, 'save/connect event must start initial upload');
});

async function pageReady(url, items = []) {
  return new Promise(resolve => {
    for (const listener of chrome.runtime.onMessage.listeners)
      listener(
        { type: 'CookieSyncPageReady', localStorageItems: items },
        { id: 'fixture', frameId: 0, tab: { id: 12, url } },
        resolve,
      );
  });
}
test('visiting NodeSeek auto-registers and uploads without ever clicking manual push', async () => {
  await settingsStorage.update({ autoDiscoverSites: true });
  cookies.push({
    name: 'nodeseek_sid',
    value: 'synthetic-nodeseek',
    domain: '.nodeseek.com',
    path: '/',
    session: true,
  });
  pageLocalItems = [{ key: 'fixture-login', value: 'local-state' }];
  openTabs.push({ id: 12, url: 'https://www.nodeseek.com/' });
  for (const key of Object.keys(chrome.storage.local.data))
    if (key.endsWith('-last-attempt')) chrome.storage.local.data[key] = 0;
  await pageReady('https://www.nodeseek.com/', pageLocalItems);
  const config = (await domainConfigStorage.get()).domainMap['nodeseek.com'];
  assert.ok(config, 'an arbitrary visited site must not require manual push registration');
  assert.equal(config.autoPush, true);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !JSON.parse(payload || '{}').domainCookieMap?.['nodeseek.com'])
    await new Promise(resolve => originalTimeout(resolve, 50));
  const entry = JSON.parse(payload).domainCookieMap['nodeseek.com'];
  assert.equal(entry.cookies[0].value, 'synthetic-nodeseek');
  assert.equal(entry.localStorageItems[0].value, 'local-state');
  openTabs.splice(0);
  pageLocalItems = [];
});

test('discovery respects opt-out and does not register cookie-less sites or unrelated domains', async () => {
  cookies.push({ name: 'sid', value: 'unvisited', domain: '.unvisited.example', path: '/', session: true });
  await pageReady('https://empty.example/');
  assert.equal((await domainConfigStorage.get()).domainMap['empty.example'], undefined);
  await settingsStorage.update({ autoDiscoverSites: false });
  await pageReady('https://unvisited.example/');
  assert.equal((await domainConfigStorage.get()).domainMap['unvisited.example'], undefined);
  await settingsStorage.update({ autoDiscoverSites: true });
  await domainConfigStorage.updateItem('blocked.example', { autoPush: false, autoPull: false });
  await pageReady('https://blocked.example/', [{ key: 'token', value: 'synthetic' }]);
  assert.equal((await domainConfigStorage.get()).domainMap['blocked.example'].autoPush, false);
  assert.equal((await domainConfigStorage.get()).domainMap['blocked.example'].autoPull, false);
});

test('normal-tab discovery never samples LocalStorage from a matching incognito tab', async () => {
  const original = chrome.tabs.sendMessage,
    sampled = [];
  openTabs.push(
    { id: 66, url: 'https://storage-only.example/', incognito: true },
    { id: 67, url: 'https://storage-only.example/', incognito: false },
  );
  chrome.tabs.sendMessage = async id => {
    sampled.push(id);
    return { isOk: true, result: [{ key: 'token', value: id === 66 ? 'private-incognito' : 'normal-fixture' }] };
  };
  for (const key of Object.keys(chrome.storage.local.data))
    if (key.endsWith('-last-attempt')) chrome.storage.local.data[key] = 0;
  try {
    await automatic.restoreAtStartup(true);
    const entry = JSON.parse(payload).domainCookieMap['storage-only.example'];
    assert.ok(entry, 'LocalStorage-only normal sites should be discovered');
    assert.equal(entry.localStorageItems[0].value, 'normal-fixture');
    assert.ok(!sampled.includes(66), 'incognito tab must never supply auto-sync LocalStorage');
  } finally {
    chrome.tabs.sendMessage = original;
    openTabs.splice(0);
  }
});

test('normal-profile restoration never writes LocalStorage into matching incognito tabs', async () => {
  const { applyLocalStorageToTabs } = require('../dist/index.js');
  const original = chrome.tabs.sendMessage,
    sampled = [];
  openTabs.push(
    { id: 66, url: 'https://restore-only.example/', incognito: true },
    { id: 67, url: 'https://restore-only.example/', incognito: false },
  );
  chrome.tabs.sendMessage = async (id, message) => {
    sampled.push(id);
    return { isOk: true, result: [] };
  };
  try {
    assert.equal(
      await applyLocalStorageToTabs('restore-only.example', [{ key: 'token', value: 'normal-fixture' }]),
      true,
    );
    assert.ok(sampled.includes(67));
    assert.ok(!sampled.includes(66));
  } finally {
    chrome.tabs.sendMessage = original;
    openTabs.splice(0);
  }
});
