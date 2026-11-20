import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The shared bundle wires storage listeners at import time.
function storageArea() {
  const data = {};
  const listeners = [];
  return {
    data,
    get: async keys =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, data[key]]),
      ),
    set: async values => {
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, { oldValue: data[key], newValue: value }]),
      );
      Object.assign(data, values);
      for (const listener of listeners) await listener(changes);
    },
    remove: async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    onChanged: { addListener: listener => listeners.push(listener) },
    setAccessLevel: async () => {},
  };
}
globalThis.chrome = { storage: { sync: storageArea(), local: storageArea(), session: storageArea() } };

const { buildOverviewRows } = require('../dist/index.js');

const base = {
  domainMap: {
    'a.example': { autoPush: true, autoPull: true, sourceUrl: 'https://a.example/login' },
    'b.example': { autoPush: false, autoPull: false },
    'c.example': { autoPush: true, autoPull: false },
    'gone.example': { autoPush: true, autoPull: true },
  },
  pending: {
    'a.example': { capturedAt: 111, cookies: [{}, {}], localStorageItems: [{}], sessionStorageItems: [] },
  },
  cached: {
    'a.example': { updateTime: 100, cookies: [{}, {}], localStorageItems: [{}], sessionStorageItems: [{}] },
    'c.example': { updateTime: 90, cookies: [{}], localStorageItems: [], sessionStorageItems: [] },
  },
  health: { 'a.example': { state: 'invalid', message: '请先登录,后操作！' } },
  activity: {
    'a.example': { lastPushAt: 500, lastPullAt: 400, lastPushOk: false, message: '云端未确认写入' },
    'c.example': { lastPushAt: 300, lastPullOk: true },
  },
  truncated: { 'c.example': 3 },
  isListed: domain => domain !== 'gone.example',
};

test('overview rows carry counts, switches and attention flags', () => {
  const rows = buildOverviewRows(base);
  const a = rows.find(row => row.domain === 'a.example');
  assert.equal(a.listed, true);
  assert.equal(a.paused, false);
  assert.deepEqual(a.pending, { capturedAt: 111, cookies: 2, localStorageItems: 1, sessionStorageItems: 0 });
  assert.deepEqual(a.cached, { updateTime: 100, cookies: 2, localStorageItems: 1, sessionStorageItems: 1 });
  assert.equal(a.health.state, 'invalid');
  assert.equal(a.error, '云端未确认写入');
  assert.equal(a.lastPushAt, 500);
  assert.deepEqual(a.attention.sort(), ['error', 'health', 'pending']);

  const b = rows.find(row => row.domain === 'b.example');
  assert.equal(b.paused, true);
  assert.deepEqual(b.attention, ['paused']);

  const c = rows.find(row => row.domain === 'c.example');
  assert.equal(c.paused, false);
  assert.equal(c.autoPush, true);
  assert.equal(c.autoPull, false);
  assert.equal(c.truncated, 3);
  assert.deepEqual(c.attention, ['truncated']);
});

test('unlisted sites keep their row and report the pause', () => {
  const rows = buildOverviewRows(base);
  const gone = rows.find(row => row.domain === 'gone.example');
  assert.ok(gone, 'a registered site that fell off the list must remain visible');
  assert.equal(gone.listed, false);
  assert.equal(gone.paused, true);
  assert.ok(gone.attention.includes('unlisted'));
  assert.ok(!gone.attention.includes('paused'), 'unlisted already explains the pause');
});

test('pending domains that are not registered are still shown', () => {
  const rows = buildOverviewRows({ ...base, pending: { 'legacy.example': { cookies: [{}] } } });
  const legacy = rows.find(row => row.domain === 'legacy.example');
  assert.ok(legacy);
  assert.equal(legacy.listed, true);
  assert.deepEqual(legacy.pending, {
    capturedAt: undefined,
    cookies: 1,
    localStorageItems: 0,
    sessionStorageItems: 0,
  });
});

test('attention order puts health issues, errors and pending work first', () => {
  const rows = buildOverviewRows(base);
  assert.equal(rows[0].domain, 'a.example', 'the site with health + error + pending leads');
  const goneIndex = rows.findIndex(row => row.domain === 'gone.example');
  const cIndex = rows.findIndex(row => row.domain === 'c.example');
  assert.ok(goneIndex < cIndex, 'paused/unlisted rows rank above quiet ones');
});

test('missing switches default to enabled and empty input stays empty', () => {
  const rows = buildOverviewRows({
    ...base,
    domainMap: { 'fresh.example': {} },
    pending: {},
    cached: {},
    health: {},
    activity: {},
    truncated: {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].autoPush, true);
  assert.equal(rows[0].autoPull, true);
  assert.equal(rows[0].paused, false);
  assert.equal(rows[0].pending, undefined);
  assert.deepEqual(rows[0].attention, []);
  assert.deepEqual(buildOverviewRows({ ...base, domainMap: {}, pending: {} }), []);
});
