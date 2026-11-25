import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' },
  });
}

function makeArea() {
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
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, newValue]) => [key, { oldValue: data[key], newValue }]),
      );
      Object.assign(data, values);
      for (const listener of listeners) await listener(changes);
    },
    onChanged: { addListener: fn => listeners.push(fn) },
    setAccessLevel: async () => {},
  };
}

const removedCookies = [];
const discardedTabIds = [];
const updatedTabs = [];
const mockTabs = [];
const mockCookies = [];

const makeEvent = () => {
  const listeners = [];
  return { listeners, addListener: fn => listeners.push(fn) };
};

globalThis.chrome = {
  storage: { local: makeArea(), sync: makeArea(), session: makeArea() },
  runtime: {
    id: 'test-ext',
    getURL: path => `chrome-extension://test-ext/${path}`,
    getManifest: () => ({ version: '1.21.0' }),
    onMessage: makeEvent(),
    onStartup: makeEvent(),
    onInstalled: makeEvent(),
  },
  cookies: {
    getAll: async ({ domain }) =>
      mockCookies.filter(c => {
        if (!domain) return true;
        const host = c.domain.replace(/^\./, '');
        return host === domain || host.endsWith('.' + domain);
      }),
    set: (details, cb) => {
      const domain = details.domain || new URL(details.url).hostname;
      const idx = mockCookies.findIndex(
        c => c.domain === domain && (c.path || '/') === (details.path || '/') && c.name === details.name,
      );
      const item = { ...details, domain, path: details.path || '/', session: !details.expirationDate };
      if (idx >= 0) mockCookies[idx] = item;
      else mockCookies.push(item);
      cb(item);
    },
    remove: (details, cb) => {
      removedCookies.push(details);
      const host = new URL(details.url).hostname;
      for (let i = mockCookies.length - 1; i >= 0; i--) {
        if (mockCookies[i].name === details.name && mockCookies[i].domain.replace(/^\./, '') === host) {
          mockCookies.splice(i, 1);
        }
      }
      cb?.(details);
    },
    onChanged: makeEvent(),
  },
  tabs: {
    query: async () => mockTabs,
    get: async id => mockTabs.find(t => t.id === id),
    update: async (id, patch) => {
      updatedTabs.push({ id, ...patch });
      const target = mockTabs.find(t => t.id === id);
      if (target && patch.active) {
        for (const t of mockTabs) if (t.windowId === target.windowId) t.active = t.id === id;
      }
      return target;
    },
    discard: async id => {
      discardedTabIds.push(id);
      const target = mockTabs.find(t => t.id === id);
      if (target) target.discarded = true;
      return target;
    },
    reload: () => {},
    sendMessage: async () => ({ isOk: false }),
  },
  alarms: { get: async () => undefined, create: async () => {}, onAlarm: makeEvent() },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
  },
};

const { createStorage, StorageType } = require('@sync-your-cookie/storage/lib/base');
const { domainConfigStorage } = require('@sync-your-cookie/storage/lib/domainConfigStorage');
const { domainStatusStorage } = require('@sync-your-cookie/storage/lib/domainStatusStorage');
const { accountStorage } = require('@sync-your-cookie/storage/lib/accountStorage');
const { webdavStorage } = require('@sync-your-cookie/storage/lib/webdavStorage');
const { settingsStorage } = require('@sync-your-cookie/storage/lib/settingsStorage');
const {
  evaluateLoginGuard,
  evaluateLeaseHandover,
  readWebdavLease,
  writeWebdavLease,
  pullAndSetCookies,
} = require('../dist/index.js');
const { computeBadgeDisplay } = require('../../../chrome-extension/lib/background/badgeController.ts');
const { registerExtensionHandler } = require('../../../chrome-extension/lib/background/router.ts');
const { pauseIdleSingleSessionTabs, restoreStandbySwitchedTabs } = require('../../../chrome-extension/lib/background/activeDevice/tabGuard.ts');
const { handleUserActivity, enterStandby, isDeviceStandby } = require('../../../chrome-extension/lib/background/activeDevice/leaseManager.ts');

test('storage base serializes concurrent writes, stores falsy values, and fixes removeItem', async () => {
  const flag = createStorage('test-falsy-flag', true, { storageType: StorageType.Local, liveUpdate: true });
  const start = Date.now();
  await Promise.all([flag.set(false), flag.set(prev => prev), flag.set(false)]);
  assert.equal(await flag.get(), false, 'falsy boolean must persist cleanly');
  assert.ok(Date.now() - start < 180, 'serialized writes must not incur the old 200ms sleep hack');

  await domainConfigStorage.updateItem('115.com', { autoPush: true, autoPull: true });
  await domainConfigStorage.removeItem('115.com');
  const cfg = await domainConfigStorage.get();
  assert.equal(cfg.domainMap['115.com'], undefined);
  assert.equal('domainCookieMap' in cfg, false, 'removeItem must not pollute storage with domainCookieMap');

  await domainStatusStorage.updateItem('115.com', { pushing: true });
  await domainStatusStorage.removeItem('115.com');
  const status = await domainStatusStorage.get();
  assert.equal(status.domainMap['115.com'], undefined);
  assert.equal('domainCookieMap' in status, false);
});

test('115 anti-downgrade login guard blocks incomplete local cookies from overwriting healthy cloud session', () => {
  const healthyCloud = ['UID', 'CID', 'SEID', 'KID', 'USERSESSIONID'].map(name => ({
    name,
    value: 'ok',
    domain: '.115.com',
  }));
  const brokenLocal = ['UID', 'CID', 'SEID', 'KID'].map(name => ({
    name,
    value: 'stale',
    domain: '.115.com',
  }));
  const verdict = evaluateLoginGuard('115.com', brokenLocal, healthyCloud);
  assert.equal(verdict.blocked, true);
  assert.deepEqual(verdict.missingKeys, ['USERSESSIONID']);

  const okVerdict = evaluateLoginGuard('115.com', healthyCloud, healthyCloud);
  assert.equal(okVerdict.blocked, false);
});

test('Clean-Before-Write removes stale conflicting 115 subdomain cookies before restoring cloud session', async () => {
  mockCookies.splice(0);
  removedCookies.splice(0);
  // Stale conflicting USERSESSIONID on www.115.com alongside old .115.com cookie
  mockCookies.push(
    { name: 'USERSESSIONID', value: 'old-host-cookie', domain: 'www.115.com', path: '/', hostOnly: true, secure: true },
    { name: 'UID', value: 'old-uid', domain: '.115.com', path: '/', hostOnly: false, secure: true },
  );

  const cloudMap = {
    domainCookieMap: {
      '115.com': {
        cookies: [
          { name: 'UID', value: 'new-uid', domain: '.115.com', path: '/', secure: true, session: true },
          { name: 'USERSESSIONID', value: 'new-session', domain: '.115.com', path: '/', secure: true, session: true },
        ],
        localStorageItems: [],
      },
    },
  };

  await pullAndSetCookies('https://www.115.com/', '115.com', false, cloudMap);
  assert.ok(
    removedCookies.some(item => item.name === 'USERSESSIONID' && item.url.includes('www.115.com')),
    'stale conflicting hostOnly USERSESSIONID must be removed before writing .115.com cookie',
  );
  assert.equal(mockCookies.filter(c => c.name === 'USERSESSIONID').length, 1);
  assert.equal(mockCookies.find(c => c.name === 'USERSESSIONID')?.value, 'new-session');
});

test('dual-PC active-device lease triggers automatic takeover and discards idle/locked 115 tabs cleanly', async () => {
  const files = new Map();
  const server = createServer(async (req, res) => {
    const key = req.url || '/';
    if (req.method === 'GET') {
      const entry = files.get(key);
      res.writeHead(entry ? 200 : 404, { ETag: `"${entry?.etag || 0}"` }).end(entry?.body || '');
      return;
    }
    const prev = files.get(key);
    if (req.headers['if-match'] && req.headers['if-match'] !== `"${prev?.etag || 0}"`) {
      res.writeHead(412).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    files.set(key, { body, etag: (prev?.etag || 0) + 1 });
    res.writeHead(204).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const config = {
      url: `http://127.0.0.1:${server.address().port}/dav/`,
      username: 'alice',
      password: 'secret',
      path: 'cookies.txt',
    };
    await webdavStorage.update(config);
    await accountStorage.update({ selectedProvider: 'webdav' });
    await settingsStorage.update({ activeDeviceSync: true, discardIdleSingleSessionTabs: true });

    // Seed lease owned by PC-A
    const leaseA = {
      version: 1,
      activeDeviceId: 'device-pc-a',
      activeDeviceName: 'Windows Chrome · PC-A',
      userAgentFamily: 'Chrome/Windows',
      leaseAt: Date.now() - 60000,
      dataRevision: 'rev-a-1',
      lastDataWriteAt: Date.now() - 60000,
    };
    await writeWebdavLease(config, leaseA, { content: '', exists: false });

    const decision = evaluateLeaseHandover('device-pc-b', undefined, leaseA);
    assert.equal(decision.action, 'takeover');

    // Simulate PC-B becoming active -> must run onTakeover before claiming lease
    let tookOverCount = 0;
    const outcome = await handleUserActivity('focus', {
      onTakeover: async remote => {
        tookOverCount++;
        assert.equal(remote.activeDeviceId, 'device-pc-a');
      },
    });
    assert.equal(tookOverCount, 1);
    assert.equal(outcome.tookOver, true);
    assert.equal(outcome.role, 'active');

    const latestLease = (await readWebdavLease(config)).lease;
    assert.notEqual(latestLease?.activeDeviceId, 'device-pc-a', 'PC-B must now own the cloud lease');

    // Simulate always-on PC with active 115 tab + sibling non-115 tab entering locked standby
    mockTabs.splice(
      0,
      mockTabs.length,
      { id: 101, windowId: 1, active: true, url: 'https://115.com/?cid=0', discarded: false },
      { id: 102, windowId: 1, active: false, url: 'https://github.com/', discarded: false },
      { id: 103, windowId: 1, active: false, url: 'https://my.115.com/', discarded: false },
    );
    discardedTabIds.splice(0);
    updatedTabs.splice(0);

    let flushedBeforeStandby = false;
    await enterStandby('locked', {
      flushBeforeStandby: async () => {
        flushedBeforeStandby = true;
      },
    });
    assert.equal(flushedBeforeStandby, true, 'active PC must flush last changes before entering standby');
    assert.equal(isDeviceStandby(), true);
    assert.ok(discardedTabIds.includes(101), 'active 115 tab must be shifted and discarded when OS locks');
    assert.ok(discardedTabIds.includes(103), 'background 115 tab must be discarded');
    assert.equal(mockTabs.find(t => t.id === 102)?.active, true, 'sibling tab holds focus gently without opening new tabs');

    // Returning to this PC restores the shifted 115 tab cleanly
    await restoreStandbySwitchedTabs();
    assert.equal(mockTabs.find(t => t.id === 101)?.active, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('badge state machine priority and unified router auth guard work reliably', async () => {
  assert.equal(computeBadgeDisplay({ error: '连接失败', pushing: true, pendingCount: 5 }).text, '!');
  assert.equal(computeBadgeDisplay({ phase: 'taking-over', pendingCount: 3 }).text, '⇄');
  assert.equal(computeBadgeDisplay({ pushing: true, pulling: true, pendingCount: 3 }).text, '⇅');
  assert.equal(computeBadgeDisplay({ pendingCount: 4 }).text, '4');
  assert.equal(computeBadgeDisplay({ deviceRole: 'standby', activeDeviceName: '家用机' }).text, '');

  registerExtensionHandler('TestProtectedCmd', async () => ({ isOk: true, msg: 'ok' }));
  const listener = chrome.runtime.onMessage.listeners[0];
  assert.ok(listener, 'single router listener must be mounted');

  // Unknown message must return false immediately (no channel leak)
  assert.equal(listener({ type: 'CompletelyUnknownMessage' }, { id: 'test-ext' }, () => {}), false);

  // Unauthorized sender must be rejected synchronously
  let unauthorizedReply;
  listener({ type: 'TestProtectedCmd' }, { id: 'evil-ext', url: 'https://evil.example/' }, res => {
    unauthorizedReply = res;
  });
  assert.equal(unauthorizedReply?.isOk, false);
});
