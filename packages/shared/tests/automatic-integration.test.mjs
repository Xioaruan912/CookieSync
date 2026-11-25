import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
  reads = 0,
  failRead = false;
let etag = 0;
const cookies = [{ name: 'sid', value: 'synthetic-login', domain: '.115.com', path: '/', session: true }];
globalThis.chrome = {
  storage: { local: area(), sync: area(), session: area() },
  runtime: {
    id: 'fixture',
    getURL: path => `chrome-extension://fixture/${path}`,
    getManifest: () => ({ version: '1.0.0' }),
    onStartup: events(),
    onMessage: events(),
    onInstalled: events(),
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
const sideFiles = new Map();
const server = createServer(async (req, res) => {
  const url = req.url || '/dav/cookies.txt';
  if (!url.endsWith('/cookies.txt')) {
    if (req.method === 'GET') {
      const entry = sideFiles.get(url);
      res.writeHead(entry ? 200 : 404, { ETag: `"${entry?.etag || 0}"` }).end(entry?.body || '');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const prev = sideFiles.get(url);
    sideFiles.set(url, { body, etag: (prev?.etag || 0) + 1 });
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET') {
    reads++;
    if (failRead) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(payload ? 200 : 404, { ETag: `"${etag}"` }).end(payload);
    return;
  }
  if (req.headers['if-match'] && req.headers['if-match'] !== `"${etag}"`) {
    res.writeHead(412).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  payload = body;
  etag++;
  writes++;
  res.writeHead(204).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const davUrl = `http://127.0.0.1:${server.address().port}/dav/`;

const { accountStorage } = require('@sync-your-cookie/storage/lib/accountStorage');
const { webdavStorage } = require('@sync-your-cookie/storage/lib/webdavStorage');
const { settingsStorage } = require('@sync-your-cookie/storage/lib/settingsStorage');
const { domainConfigStorage } = require('@sync-your-cookie/storage/lib/domainConfigStorage');
const { cookieStorage } = require('@sync-your-cookie/storage/lib/cookieStorage');
const { sitePolicyStorage } = require('@sync-your-cookie/storage/lib/sitePolicyStorage');
const { setSyncBaseline, domainContentHash, syncDestinationKey, editSyncJobs } = require('../dist/index.js');
const automatic = require('../../../chrome-extension/lib/background/automaticSync.ts');

test('fresh WebDAV destination uploads existing cookies in its first automatic cycle and skips identical content', async () => {
  await webdavStorage.update({ url: davUrl, username: 'test', password: 'test', path: 'cookies.txt' });
  await accountStorage.update({ selectedProvider: 'webdav' });
  await settingsStorage.update({
    backgroundSync: true,
    startupPull: true,
    syncIntervalMinutes: 2,
    protobufEncoding: false,
    encryptionEnabled: false,
    configChannel: 'chrome-sync',
    rollingBackup: false,
  });
  await domainConfigStorage.ensureDefaults();
  await automatic.restoreAtStartup(true);
  assert.equal(writes, 1, 'cloud-empty discovery must upload in the same cycle, not one interval later');
  assert.equal(JSON.parse(payload).domainCookieMap['115.com'].cookies[0].value, 'synthetic-login');
  await automatic.restoreAtStartup(true);
  assert.equal(writes, 1, 'same semantic hash must not upload');
});

test('push-only site bootstraps against an empty destination without enabling auto pull', async () => {
  payload = '';
  etag++;
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
  etag++;
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

test('connecting a WebDAV destination starts discovery without restarting Chrome or waiting for an alarm', async () => {
  payload = '';
  etag++;
  writes = 0;
  for (const key of Object.keys(chrome.storage.local.data))
    if (key.startsWith('cookiesync-pending-')) delete chrome.storage.local.data[key];
  automatic.initAutomaticSync();
  // Saving a WebDAV destination (as the options page does) must start initial upload.
  await webdavStorage.update({ url: davUrl, username: 'test', password: 'test', path: 'cookies.txt' });
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
  await sitePolicyStorage.setRule('storage-only.example', true);
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
    await automatic.restoreAtStartup(true, true);
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

test('unlisted legacy sites stop automatic capture and upload without deleting their data', async () => {
  await domainConfigStorage.updateItem('legacy-unlisted.example', { autoPush: true, autoPull: true });
  await setSyncBaseline('legacy-unlisted.example', await domainContentHash());
  cookies.push({
    name: 'sid',
    value: 'legacy-preserved',
    domain: '.legacy-unlisted.example',
    path: '/',
    session: true,
  });
  const { syncDestinationKey } = require('../dist/index.js');
  const key = await syncDestinationKey();
  const legacyJob = {
    domain: 'legacy-unlisted.example',
    cookies: [],
    localStorageItems: [],
    revision: 'legacy-queued',
    baseHash: await domainContentHash(),
  };
  await chrome.storage.local.set({
    [key]: { ...chrome.storage.local.data[key], 'legacy-unlisted.example': legacyJob },
  });
  const oldWrites = writes;
  await automatic.captureAutomaticSync('legacy-unlisted.example', []);
  await automatic.flushAutomaticSync(true);
  assert.equal(writes, oldWrites, 'an old enabled entry outside the new allowlist must not upload');
  assert.ok(cookies.some(c => c.value === 'legacy-preserved'));
  assert.equal(chrome.storage.local.data[key]['legacy-unlisted.example'].revision, 'legacy-queued');
  assert.equal((await domainConfigStorage.get()).domainMap['legacy-unlisted.example'].autoPush, true);
});

test('newer-wins: a cloud write newer than the pending capture adopts the remote copy locally', async () => {
  // Both sides changed for newer-wins.example; the remote write is newer than the local capture.
  await domainConfigStorage.updateItem('newer-wins.example', { autoPush: true, autoPull: true });
  await sitePolicyStorage.setRule('newer-wins.example', true);
  const remoteEntry = {
    updateTime: Date.now() + 90000,
    cookies: [{ name: 'sid', value: 'cloud-newer', domain: '.newer-wins.example', path: '/', session: true }],
    localStorageItems: [],
  };
  const map = JSON.parse(payload || '{}');
  map.domainCookieMap ||= {};
  map.domainCookieMap['newer-wins.example'] = remoteEntry;
  payload = JSON.stringify(map);
  etag++;
  const key = await syncDestinationKey();
  // Simulate a pending local change captured before the remote write.
  await editSyncJobs(key, async jobs => ({
    ...jobs,
    'newer-wins.example': {
      domain: 'newer-wins.example',
      cookies: [{ name: 'sid', value: 'local-older', domain: '.newer-wins.example', path: '/', session: true }],
      localStorageItems: [],
      userAgent: 'synthetic-browser',
      revision: 'local-pending',
      capturedAt: Date.now(),
      baseHash: await domainContentHash({ cookies: [], localStorageItems: [] }),
    },
  }));
  cookies.push({ name: 'sid', value: 'local-older', domain: '.newer-wins.example', path: '/', session: true });
  await setSyncBaseline('newer-wins.example', await domainContentHash({ cookies: [], localStorageItems: [] }));
  await automatic.restoreAtStartup(true, true);
  const statusAfter = chrome.storage.local.data['cookiesync-auto-status'];
  assert.ok(
    (statusAfter?.note || '').includes('newer-wins.example'),
    'adoption must be reported to the user',
  );
  // The local pending job for the domain is gone: the cloud copy won.
  const jobs = chrome.storage.local.data[key];
  assert.equal(jobs?.['newer-wins.example'], undefined);
  assert.ok(cookies.some(c => c.value === 'cloud-newer'), 'remote cookie must be applied locally');
  const previousWrites = writes;
  await automatic.flushAutomaticSync(true);
  assert.equal(writes, previousWrites, 'adopted domain must not be re-uploaded');
});

test('denied child cookies never piggyback on an allowed parent during auto push or pull; existing backups remain', async () => {
  await settingsStorage.update({ backgroundSync: false });
  await sitePolicyStorage.setRule('parent.example', true);
  await sitePolicyStorage.setRule('private.parent.example', false);
  const rootCookie = { name: 'root_sid', value: 'root-remote', domain: '.parent.example', path: '/', session: true };
  const privateCookie = {
    name: 'private_sid',
    value: 'private-backup',
    domain: 'private.parent.example',
    path: '/',
    session: true,
    hostOnly: true,
  };
  const map = JSON.parse(payload);
  map.domainCookieMap['parent.example'] = { cookies: [rootCookie, privateCookie], localStorageItems: [] };
  payload = JSON.stringify(map);
  etag++;
  await cookieStorage.update(map, true);
  await domainConfigStorage.updateItem('parent.example', { autoPush: true, autoPull: true });
  await setSyncBaseline('parent.example', await domainContentHash(map.domainCookieMap['parent.example']));
  cookies.push({ ...rootCookie, value: 'root-new' }, { ...privateCookie, value: 'private-local-only' });
  await settingsStorage.update({ backgroundSync: true });
  await automatic.captureAutomaticSync('parent.example', []);
  await automatic.flushAutomaticSync(true);
  const saved = JSON.parse(payload).domainCookieMap['parent.example'].cookies;
  assert.ok(saved.some(c => c.value === 'root-new'));
  assert.ok(
    saved.some(c => c.value === 'private-backup'),
    'existing paused cloud data must remain',
  );
  assert.ok(
    !saved.some(c => c.value === 'private-local-only'),
    'denied child current Cookie must never upload via parent',
  );
  for (let i = cookies.length - 1; i >= 0; i--) if (cookies[i].name === 'root_sid') cookies.splice(i, 1);
  await automatic.restoreAtStartup(true, true);
  assert.ok(cookies.some(c => c.name === 'root_sid' && c.value === 'root-new'));
  assert.ok(
    !cookies.some(c => c.name === 'private_sid' && c.value === 'private-backup'),
    'automatic parent pull must not write denied child Cookie',
  );
  assert.ok(cookies.some(c => c.value === 'private-local-only'));
  const { pullAndSetCookies } = require('../dist/index.js');
  await pullAndSetCookies('https://parent.example/', 'parent.example', false, JSON.parse(payload));
  assert.ok(
    cookies.some(c => c.name === 'private_sid' && c.value === 'private-backup'),
    'explicit manual pull remains unrestricted',
  );
});

test('115 restore verifies login keys and reports an honest health status', async () => {
  const realFetch = globalThis.fetch;
  let healthCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('my.115.com')) {
      healthCalls++;
      return new Response(JSON.stringify({ state: true, data: { user_name: 'fixture-user' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, init);
  };
  try {
    const quintet = ['UID', 'CID', 'SEID', 'KID', 'USERSESSIONID'].map(name => ({
      name,
      value: `fixture-${name.toLowerCase()}`,
      domain: '.115.com',
      path: '/',
      session: true,
    }));
    const entry = { cookies: quintet, localStorageItems: [], updateTime: Date.now(), userAgent: navigator.userAgent };
    for (let i = cookies.length - 1; i >= 0; i--) if ((cookies[i].domain || '').endsWith('115.com')) cookies.splice(i, 1);
    cookies.push(...quintet);
    payload = JSON.stringify({ domainCookieMap: { '115.com': entry } });
    etag++;
    await cookieStorage.update({ domainCookieMap: { '115.com': entry } }, true);
    await setSyncBaseline('115.com', await domainContentHash(entry));
    for (const key of Object.keys(chrome.storage.local.data))
      if (key.startsWith('cookiesync-pending-')) delete chrome.storage.local.data[key];
    await automatic.restoreAtStartup(true, true);
    const deadline = Date.now() + 5000;
    let entry115;
    while (Date.now() < deadline) {
      entry115 = chrome.storage.local.data['cookiesync-site-health']?.['115.com'];
      if (entry115?.state) break;
      await new Promise(resolve => originalTimeout(resolve, 50));
    }
    assert.equal(entry115?.state, 'ok', 'a complete login snapshot must be verified live');
    assert.equal(entry115?.userName, 'fixture-user');
    assert.ok(healthCalls >= 1, 'the read-only nav endpoint must be the probe');
    assert.ok(entry115.checkedAt > 0, 'the check time must be recorded');
    const callsAfterOk = healthCalls;

    // Both sides lose USERSESSIONID: the restore must say why instead of
    // letting the user find a dead login on the page, without probing.
    const reduced = { ...entry, cookies: quintet.filter(cookie => cookie.name !== 'USERSESSIONID') };
    const uidIndex = cookies.findIndex(cookie => cookie.name === 'USERSESSIONID');
    if (uidIndex >= 0) cookies.splice(uidIndex, 1);
    payload = JSON.stringify({ domainCookieMap: { '115.com': reduced } });
    etag++;
    await cookieStorage.update({ domainCookieMap: { '115.com': reduced } }, true);
    await setSyncBaseline('115.com', await domainContentHash(reduced));
    for (const key of Object.keys(chrome.storage.local.data))
      if (key.startsWith('cookiesync-pending-')) delete chrome.storage.local.data[key];
    await automatic.restoreAtStartup(true, true);
    entry115 = chrome.storage.local.data['cookiesync-site-health']?.['115.com'];
    assert.equal(entry115?.state, 'invalid');
    assert.match(entry115?.message || '', /USERSESSIONID/);
    assert.equal(healthCalls, callsAfterOk, 'missing login keys must be diagnosed locally, not via extra probes');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('pull all applies every allowed remote domain, drops its pending job, and skips paused sites', async () => {
  const { editSyncJobs, syncDestinationKey } = require('../dist/index.js');
  await sitePolicyStorage.setRule('pull-all.example', true);
  await sitePolicyStorage.setRule('pull-all-blocked.example', false);
  await domainConfigStorage.updateItem('pull-all.example', { autoPush: true, autoPull: true });
  // These edits schedule a reconcile cycle ~1s later; let it finish so it cannot
  // capture the fixture we arrange below (the test cookie jar does not replace
  // same-name cookies the way a real browser does).
  await new Promise(resolve => originalTimeout(resolve, 1500));
  payload = JSON.stringify({
    domainCookieMap: {
      'pull-all.example': {
        updateTime: Date.now(),
        cookies: [{ name: 'sid', value: 'cloud-value', domain: '.pull-all.example', path: '/', session: true }],
        localStorageItems: [],
      },
      'pull-all-blocked.example': {
        updateTime: Date.now(),
        cookies: [{ name: 'sid', value: 'denied-value', domain: '.pull-all-blocked.example', path: '/', session: true }],
        localStorageItems: [],
      },
    },
  });
  etag++;
  const key = await syncDestinationKey();
  await editSyncJobs(key, jobs => ({
    ...jobs,
    'pull-all.example': {
      domain: 'pull-all.example',
      cookies: [{ name: 'sid', value: 'local-stale', domain: '.pull-all.example', path: '/' }],
      localStorageItems: [],
      userAgent: 'synthetic-browser',
      revision: 'stale-local',
      capturedAt: Date.now(),
    },
  }));
  cookies.push({ name: 'sid', value: 'local-stale', domain: '.pull-all.example', path: '/', session: true });
  const summary = await automatic.pullAllFromCloud();
  assert.equal(summary.domains, 1);
  assert.ok(summary.skipped >= 1, 'paused or unlisted sites are counted as skipped');
  assert.ok(
    cookies.some(cookie => cookie.name === 'sid' && cookie.value === 'cloud-value' && cookie.domain === '.pull-all.example'),
    'the cloud copy must be applied to this browser',
  );
  assert.ok(!cookies.some(cookie => cookie.value === 'denied-value'), 'paused sites must never be applied');
  assert.equal(
    chrome.storage.local.data[key]?.['pull-all.example'],
    undefined,
    'the pending job of a pulled site is dropped (cloud wins)',
  );
  assert.ok(summary.cookies >= 1);
});

test('push all uploads allowed local sites, respects pause rules, and clears pending jobs', async () => {
  const { editSyncJobs, syncDestinationKey } = require('../dist/index.js');
  await sitePolicyStorage.setRule('push-all.example', true);
  await sitePolicyStorage.setRule('push-all-paused.example', false);
  await domainConfigStorage.updateItem('push-all.example', { autoPush: true, autoPull: true });
  await domainConfigStorage.updateItem('push-all-paused.example', { autoPush: true, autoPull: true });
  // Let the reconcile cycle scheduled by these edits finish before arranging.
  await new Promise(resolve => originalTimeout(resolve, 1500));
  payload = JSON.stringify({ domainCookieMap: {} });
  etag++;
  cookies.push({ name: 'sid', value: 'local-push', domain: '.push-all.example', path: '/', session: true });
  cookies.push({ name: 'sid', value: 'paused-push', domain: '.push-all-paused.example', path: '/', session: true });
  const key = await syncDestinationKey();
  await editSyncJobs(key, jobs => ({
    ...jobs,
    'push-all.example': {
      domain: 'push-all.example',
      cookies: [{ name: 'sid', value: 'local-push', domain: '.push-all.example', path: '/' }],
      localStorageItems: [],
      userAgent: 'synthetic-browser',
      revision: 'pending-push',
      capturedAt: Date.now(),
    },
  }));
  const summary = await automatic.pushAllToCloud();
  assert.ok(summary.domains >= 1, 'allowed sites with local data are uploaded');
  const saved = JSON.parse(payload).domainCookieMap;
  assert.ok(
    saved['push-all.example']?.cookies.some(cookie => cookie.value === 'local-push'),
    'the local copy must reach the cloud',
  );
  assert.equal(saved['push-all-paused.example'], undefined, 'paused sites must never upload');
  assert.ok(!JSON.stringify(saved).includes('paused-push'));
  assert.equal(
    chrome.storage.local.data[key]?.['push-all.example'],
    undefined,
    'the pending job is cleared after the bulk push',
  );
});

test('after suite', async () => {
  await new Promise(resolve => server.close(resolve));
});
