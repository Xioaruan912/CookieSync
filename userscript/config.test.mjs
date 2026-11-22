import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./CookieSync-config.user.js', import.meta.url), 'utf8');
const connection = { url: 'https://dav.example.test/folder/', username: 'demo', password: 'app-password' };
const url = connection.url + 'CookieSync-config-v1.json';
const payload = (rules = {}, preferences = {}) => ({ version: 1, rules, preferences });
const rule = (enabled, updatedAt = 10, revision = 'a') => ({ enabled, updatedAt, revision });

function setup(remoteResponse, local = payload(), sharedData = new Map()) {
  const requests = [];
  const data = sharedData;
  const exports = {};
  const gm = {
    listValues: async () => [...data.keys()],
    getValues: async keys => Object.fromEntries(keys.filter(key => data.has(key)).map(key => [key, structuredClone(data.get(key))])),
    getValue: async (key, fallback) => structuredClone(data.get(key) ?? fallback),
    setValue: async (key, value) => data.set(key, structuredClone(value)),
    xmlHttpRequest: async options => {
      assert.equal(options.url, url);
      assert.equal(options.anonymous, true);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Basic ' + btoa('demo:app-password'));
      requests.push(options);
      return { finalUrl: url, ...(await remoteResponse(options, requests.length)) };
    },
    registerMenuCommand: () => {},
  };
  vm.runInNewContext(source.replace("  start();",
    'Object.assign(exports, { destination, syncConfig, dataKey, maybeSync });'), {
    exports, GM: gm, URL, TextEncoder, btoa, clearTimeout, setTimeout, crypto,
  });
  const key = exports.dataKey(connection);
  if (!data.has(key)) data.set(key, local);
  return { ...exports, data, key, requests };
}

test('creates only the config file with a conditional write and omits extra data', async () => {
  const local = payload({ 'nodeseek.com': { ...rule(true), password: 'private' } }, {
    theme: { value: 'dark', updatedAt: 10, revision: 'b' },
  });
  local.password = 'private';
  const app = setup(request => ({ status: request.method === 'GET' ? 404 : 201 }), local);
  await app.syncConfig(connection);
  assert.deepEqual(app.requests.map(request => request.method), ['GET', 'PUT']);
  assert.equal(app.requests[1].headers['If-None-Match'], '*');
  assert.deepEqual(JSON.parse(app.requests[1].data),
    payload({ 'nodeseek.com': rule(true) }, local.preferences));
  assert.throws(() => app.destination({ ...connection, url: 'http://example.test' }), /HTTPS/);
});

test('refetches after HTTP 412 and keeps independent changes and per-field revisions', async () => {
  const local = payload({ 'a.example': rule(true) }, { theme: {value:'dark',updatedAt:10,revision:'z'} });
  const app = setup((request, count) => {
    if (count === 1) return {status:404};
    if (count === 2) return {status:412};
    if (count === 3) return {status:200,responseHeaders:'etag: "new"\r\n',responseText:JSON.stringify(
      payload({'b.example':rule(false)}, {theme:{value:'light',updatedAt:10,revision:'a'},
        syncIntervalMinutes:{value:10,updatedAt:11,revision:'x'}}))};
    assert.equal(request.headers['If-Match'], '"new"');
    return {status:204};
  }, local);
  await app.syncConfig(connection);
  const saved = JSON.parse(app.requests[3].data);
  assert.deepEqual(Object.keys(saved.rules), ['a.example','b.example']);
  assert.equal(saved.rules['b.example'].enabled, false);
  assert.equal(saved.preferences.theme.value, 'dark');
  assert.equal(saved.preferences.syncIntervalMinutes.value, 10);
});

test('skips unchanged writes and preserves local state on invalid payloads or weak tags', async () => {
  const local = payload({'a.example':rule(true)});
  const equal = setup(() => ({ status:200,responseText:JSON.stringify(local) }), local);
  await equal.syncConfig(connection);
  assert.equal(equal.requests.length, 1);

  for (const response of [
    { status:200,responseText:'<html>' },
    { status:200,responseText:JSON.stringify(payload()),responseHeaders:'ETag: W/"tag"' },
    { status:200,responseText:JSON.stringify(payload()),finalUrl:'https://other.example/' },
  ]) {
    const app = setup(() => response, local);
    await assert.rejects(app.syncConfig(connection), /JSON|ETag|重定向/);
    assert.equal(app.requests.length, 1);
    assert.deepEqual(app.data.get(app.key), local);
  }
});

test('update URLs follow the userscript branch and grants omit cookie interfaces', () => {
  assert.match(source, /@version\s+\d+\.\d+\.\d+/);
  for (const field of ['updateURL','downloadURL']) {
    assert.match(source, new RegExp('@' + field + '\\s+https://raw\\.githubusercontent\\.com/Xioaruan912/CookieSync/tampermonkey/userscript/CookieSync-config\\.user\\.js'));
  }
  assert.doesNotMatch(source, /@grant[^\r\n]*(?:cookie|unsafeWindow)|document\.cookie|localStorage|indexedDB/i);
});

test('restored tabs share the 30-minute throttle, with an opt-out and failure status', async () => {
  const sharedData = new Map([['webdav-connection', connection]]);
  const primary = setup(() => ({ status: 200, responseText: JSON.stringify(payload()) }), payload(), sharedData);
  const other = setup(() => ({ status: 200, responseText: JSON.stringify(payload()) }), payload(), sharedData);
  await Promise.all([primary.maybeSync(), other.maybeSync()]);
  assert.equal(primary.requests.length + other.requests.length, 1);
  assert.match(sharedData.get(primary.key + ':status').message, /已同步/);
  await other.maybeSync();
  assert.equal(primary.requests.length + other.requests.length, 1);

  sharedData.set(primary.key + ':schedule', { at: Date.now() - 31 * 60000 });
  sharedData.set('webdav-connection', { ...connection, automatic: false });
  await primary.maybeSync();
  assert.equal(primary.requests.length + other.requests.length, 1);

  sharedData.set('webdav-connection', connection);
  const offline = setup(() => ({ status: 503 }), payload(), sharedData);
  await assert.rejects(offline.maybeSync(), /503/);
  assert.match(sharedData.get(primary.key + ':status').message, /503/);
  await offline.maybeSync();
  assert.equal(offline.requests.length, 1);
});

test('background sync stores downloaded data separately from a simultaneous local edit', async () => {
  const remote = payload({ 'cloud.example': rule(true) });
  const edit = payload({ 'edit.example': rule(false) });
  const app = setup((request, count) => {
    if (count === 1) {
      app.data.set(app.key, edit);
      return { status: 200, responseText: JSON.stringify(remote), responseHeaders: 'ETag: "fresh"' };
    }
    assert.equal(request.method, 'PUT');
    return { status: 204 };
  });
  await app.syncConfig(connection);
  assert.deepEqual(app.data.get(app.key), edit);
  assert.deepEqual(Object.keys(app.data.get(app.key + ':remote-cache').rules), ['cloud.example', 'edit.example']);
});

test('edits from separate sites merge with the existing journal', async () => {
  const app = setup((request) => {
    if (request.method === 'GET') return { status: 404 };
    const content = JSON.parse(request.data);
    assert.deepEqual(Object.keys(content.rules), ['new.example', 'old.example']);
    assert.equal(content.preferences.theme.value, 'dark');
    return { status: 201 };
  }, payload({ 'old.example': rule(true) }));
  app.data.set(app.key + ':edit:rules:new.example', rule(false));
  app.data.set(app.key + ':edit:preferences:theme', { value: 'dark', updatedAt: 20, revision: 'b' });
  await app.syncConfig(connection);
  assert.deepEqual(Object.keys(app.data.get(app.key).rules), ['old.example']);
});
