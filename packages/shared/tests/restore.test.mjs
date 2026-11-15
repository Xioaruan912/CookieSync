import { test } from 'node:test';
import assert from 'node:assert/strict';
const { cookieSetDetails, syncCookieDomain, matchesSyncDomain } = await import('../lib/cookie/restore.ts');

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
