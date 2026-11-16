import { test } from 'node:test';
import assert from 'node:assert/strict';
const { cookieSetDetails, syncCookieDomain, matchesSyncDomain } = await import('../lib/cookie/restore.ts');
const { collectSiteCookies, canonicalSiteHost, matchesSitePage } = await import('../lib/cookie/restore.ts');

test('arbitrary site discovery keeps www/ports stable and collects parent-path cookies without unrelated domains', async () => {
  assert.equal(canonicalSiteHost('WWW.NodeSeek.com'), 'nodeseek.com');
  assert.ok(matchesSitePage('nodeseek.com', 'www.nodeseek.com'));
  assert.ok(matchesSyncDomain('nodeseek.com', 'www.nodeseek.com'));
  assert.ok(matchesSyncDomain('www.nodeseek.com', '.nodeseek.com'));
  assert.ok(!matchesSyncDomain('nodeseek.com', 'evilnodeseek.com'));
  assert.ok(!matchesSitePage('nodeseek.com', 'evilnodeseek.com'));
  assert.ok(!matchesSitePage('localhost:80', 'localhost:81'));
  const fixtures = [
    { name: 'login', domain: '.example.com', path: '/account', value: 'fixture', hostOnly: false },
    { name: 'own', domain: 'sub.example.com', path: '/', value: 'own', hostOnly: true },
    { name: 'parent-only', domain: 'example.com', path: '/', value: 'not-applicable', hostOnly: true },
    { name: 'unrelated', domain: '.other.example', path: '/', value: 'exclude', hostOnly: false },
  ];
  const previous = globalThis.chrome;
  globalThis.chrome = {
    cookies: {
      getAll: async details =>
        fixtures.filter(cookie => {
          const domain = cookie.domain.replace(/^\./, '');
          if (details.domain) return domain === details.domain || domain.endsWith('.' + details.domain);
          if (details.url) {
            const page = new URL(details.url);
            return (
              (page.hostname === domain || (!cookie.hostOnly && page.hostname.endsWith('.' + domain))) &&
              page.pathname.startsWith(cookie.path)
            );
          }
          return true;
        }),
    },
  };
  try {
    for (const path of ['/account', '/'])
      assert.deepEqual((await collectSiteCookies('https://sub.example.com' + path)).map(c => c.name).sort(), [
        'login',
        'own',
      ]);
  } finally {
    globalThis.chrome = previous;
  }
});

test('collects supported site families with exact domain boundaries', () => {
  for (const root of ['xiaohongshu.com', 'douyin.com', '115.com']) {
    assert.equal(syncCookieDomain(`www.${root}`), root);
    assert.ok(matchesSyncDomain(`www.${root}`, `passport.${root}`));
    assert.ok(!matchesSyncDomain(`www.${root}`, `evil${root}`));
    assert.ok(!matchesSyncDomain(`evil${root}`, root));
  }
  assert.equal(syncCookieDomain('www.other.example'), 'www.other.example');
});

test('restores www host-only and family subdomain cookies; keeps session cookies alive after protobuf decoding', () => {
  const cookie = {
    name: 'session',
    value: 'dummy',
    domain: 'www.xiaohongshu.com',
    session: true,
    expirationDate: 0,
    storeId: '',
    path: '/',
    secure: true,
    sameSite: 'no_restriction',
  };
  const result = cookieSetDetails(cookie, 'https://www.xiaohongshu.com/explore');
  assert.equal(result.expirationDate, undefined);
  assert.equal(result.domain, undefined);
  assert.equal(result.storeId, undefined);
  assert.equal(result.secure, true);
  assert.equal(result.sameSite, 'no_restriction');
  const subdomain = cookieSetDetails(
    { ...cookie, domain: 'passport.xiaohongshu.com', path: '/login' },
    'https://www.xiaohongshu.com/',
  );
  assert.equal(subdomain.url, 'https://passport.xiaohongshu.com/login');
  assert.equal(
    cookieSetDetails({ ...cookie, domain: 'evilxiaohongshu.com' }, 'https://www.xiaohongshu.com/'),
    undefined,
  );
  assert.equal(
    cookieSetDetails({ ...cookie, session: false, expirationDate: 1 }, 'https://www.xiaohongshu.com/'),
    undefined,
  );
  const ordinary = cookieSetDetails({ ...cookie, domain: 'www.example.com' }, 'https://www.example.com/');
  assert.ok(ordinary);
  assert.equal(ordinary.expirationDate, undefined);
});
