import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  commonSites,
  isSiteAllowed,
  isAutomaticCookieAllowed,
  normalizeSiteDomain,
  mergeSiteRules,
  siteRulePrefix,
} = require('../../storage/lib/commonSites.ts');
const changeListeners = [];
let data = {};
globalThis.chrome = {
  storage: {
    sync: {
      get: async () => structuredClone(data),
      set: async changes => {
        Object.assign(data, structuredClone(changes));
        changeListeners.forEach(fn =>
          fn(Object.fromEntries(Object.entries(changes).map(([key, newValue]) => [key, { newValue }]))),
        );
      },
      onChanged: { addListener: fn => changeListeners.push(fn) },
    },
  },
};
const { sitePolicyStorage, storeSiteRules } = require('../../storage/lib/sitePolicyStorage.ts');

test('300 unique bundled sites allow known families, exclude lookalikes and normalize custom domains', () => {
  assert.equal(commonSites.length, 300);
  assert.equal(new Set(commonSites.map(s => s.domain)).size, 300);
  for (const site of commonSites) assert.equal(normalizeSiteDomain(site.domain), site.domain);
  for (const host of ['www.nodeseek.com', 'xiaohongshu.com', 'www.douyin.com', '115.com', 'passport.jd.com'])
    assert.equal(isSiteAllowed(host), true, host);
  for (const host of ['unlisted.example', 'evilnodeseek.com', 'nodeseek.com.evil.example'])
    assert.equal(isSiteAllowed(host), false, host);
  assert.equal(normalizeSiteDomain('https://www.Example.com/path?ignored=1'), 'example.com');
  for (const input of [
    '*.com',
    'com.cn',
    'localhost',
    '127.0.0.1',
    'https://user:pass@example.com',
    'example.com:8443',
  ])
    assert.throws(() => normalizeSiteDomain(input));
});

test('custom deny and allow rules match boundaries with the most specific rule winning', () => {
  const rule = enabled => ({ enabled, updatedAt: 1, revision: 'fixture' });
  const rules = { 'nodeseek.com': rule(false), 'custom.example': rule(true), 'private.custom.example': rule(false) };
  assert.equal(isSiteAllowed('www.nodeseek.com', rules), false);
  assert.equal(isSiteAllowed('sub.custom.example', rules), true);
  assert.equal(isSiteAllowed('private.custom.example', rules), false);
  assert.equal(isSiteAllowed('evilcustom.example', rules), false);
});

test('allowed subdomains retain applicable shared parent cookies unless the parent is explicitly denied', () => {
  const rule = enabled => ({ enabled, updatedAt: 1, revision: 'fixture' });
  assert.equal(isAutomaticCookieAllowed({ domain: '.google.com' }, 'mail.google.com', {}), true);
  assert.equal(isAutomaticCookieAllowed({ domain: '.live.com' }, 'outlook.live.com', {}), true);
  const rules = { 'sub.custom.example': rule(true) };
  assert.equal(isAutomaticCookieAllowed({ domain: '.custom.example' }, 'sub.custom.example', rules), true);
  assert.equal(
    isAutomaticCookieAllowed({ domain: 'custom.example', hostOnly: true }, 'sub.custom.example', rules),
    false,
  );
  assert.equal(isAutomaticCookieAllowed({ domain: 'private.custom.example' }, 'sub.custom.example', rules), false);
  assert.equal(
    isAutomaticCookieAllowed({ domain: '.custom.example' }, 'sub.custom.example', {
      'custom.example': rule(false),
      ...rules,
    }),
    false,
  );
});

test('per-domain merge keeps concurrent changes and opt-out tombstones, and rejects malformed cloud rules', () => {
  const older = { enabled: true, updatedAt: 1, revision: 'a' },
    newer = { enabled: false, updatedAt: 2, revision: 'b' };
  assert.deepEqual(mergeSiteRules({ 'nodeseek.com': newer }, { 'nodeseek.com': older, 'custom.example': older }), {
    'custom.example': older,
    'nodeseek.com': newer,
  });
  assert.equal(
    mergeSiteRules({ 'nodeseek.com': { ...newer, enabled: true } }, { 'nodeseek.com': newer })['nodeseek.com'].enabled,
    false,
  );
  assert.throws(() => mergeSiteRules({ 'not a domain': older }));
  assert.throws(() => mergeSiteRules({ 'example.com': { ...older, updatedAt: Infinity } }));
});

test('Chrome Sync stores only overrides, supports 300 disabled sites, and never uploads the bundled catalogue', async () => {
  await sitePolicyStorage.setRule('nodeseek.com', false);
  assert.equal(Object.keys(data).length, 1);
  assert.equal(data[siteRulePrefix + 'nodeseek.com'].enabled, false);
  const rules = Object.fromEntries(
    commonSites.map(s => [s.domain, { enabled: false, updatedAt: 1, revision: 'fixture' }]),
  );
  await storeSiteRules(rules);
  assert.equal(Object.keys(data).length, 300);
  assert.ok(Object.entries(data).every(([k, v]) => JSON.stringify({ [k]: v }).length < 8192));
  assert.ok(JSON.stringify(data).length < 90000);
  assert.equal((await sitePolicyStorage.get())['nodeseek.com'].enabled, false);
  assert.equal(JSON.stringify(data).includes('小红书'), false);
});

test('concurrent policy merges and out-of-order Chrome events cannot replace a newer deny with an older allow', async () => {
  const original = chrome.storage.sync.set;
  chrome.storage.sync.set = async values => {
    if (values[siteRulePrefix + 'race.example']?.enabled === true)
      await new Promise(resolve => setTimeout(resolve, 40));
    return original(values);
  };
  const allow = { enabled: true, updatedAt: 10, revision: 'old' };
  const deny = { enabled: false, updatedAt: 20, revision: 'new' };
  await Promise.all([storeSiteRules({ 'race.example': allow }), storeSiteRules({ 'race.example': deny })]);
  assert.equal((await sitePolicyStorage.get())['race.example'].enabled, false);
  // Simulate Chrome delivering a stale remote write after both local operations finished.
  await original({ [siteRulePrefix + 'race.example']: allow });
  const deadline = Date.now() + 1000;
  while ((await sitePolicyStorage.get())['race.example'].enabled && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await sitePolicyStorage.get())['race.example'].enabled, false);
  chrome.storage.sync.set = original;
});
